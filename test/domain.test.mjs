/*
 * 领域层测试（node:test + node:assert/strict，零依赖）。
 *
 * 覆盖来源：
 *   - hub/test/machine.test.ts —— 22 例**全部移植**（标题保持原样，便于对照）
 *   - hub/test/store.test.ts —— 门禁时钟 / 门禁扫描 / 租约扫描 / 将来视图那 7 例
 *   - 本次移植新增 —— schema 每一个 .default()、三条硬闸、GATE_ACTIVE_IN 激活时序、
 *     accept 超时不释放 vs start 超时释放+escalate、租约 leaseVerdict 三档
 *     （含“首次发现过期必先播报”）、纯函数性（输入不可变）
 *
 * 关于 hub 的 DomainRegistry：registry.ts **没有移植**（它运行期 import config 模块的
 * effectiveTaskType，并以 WorkflowConfig 为输入）。因此下面用一份本地 fixture
 * 复刻 hub/examples/example-config/workflow.yaml 的解析规则——
 * domains / task_types / splitConfirmers / acceptors / 门禁规格，逐条对齐
 * hub/src/domain/registry.ts 与 hub/test/helpers.ts，只是数据写死在测试里。
 * 被复刻的规则都有注释标出来源行，改规则时两边一起改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ObjectError,
  activateDue,
  asPrincipal,
  availableActions,
  buildGates,
  createRequirement,
  createTask,
  describeSpan,
  dueAction,
  formatDuration,
  gateLine,
  gatePending,
  gateProgress,
  gateSatisfied,
  hasDeadline,
  initializeGates,
  isBot,
  isHuman,
  leaseIdOf,
  leaseVerdict,
  openLease,
  parseCallbackRecord,
  parseConflict,
  parseDecision,
  parseGate,
  parseInboundMessage,
  parseLease,
  parseRequirement,
  parseTask,
  releaseLease,
  remainingMs,
  renewLease,
  requirementComplete,
  scanDue,
  transitionRequirement,
  transitionTask,
  upcoming,
  DEFAULT_LEASE_POLICY,
  GATE_ACTIVE_IN,
} from '../lib/domain/index.js'

/* ------------------------------------------------------------------ *
 * 示例配置的本地 fixture（对应 hub/examples/example-config/workflow.yaml）
 * ------------------------------------------------------------------ */

/** workflow.yaml 的 domains.owner（示例配置里每个域都有真人 owner） */
const EXAMPLE_DOMAIN_OWNERS = {
  pm: 'human:zhang-pm',
  product: 'human:li-product',
  design: 'human:wang-design',
  requirement: 'human:chen-req',
  development: 'human:zhao-dev',
  testing: 'human:sun-qa',
  ops: 'human:zhou-ops',
  data: 'human:wu-data',
  security: 'human:zheng-sec',
  docs: 'human:xu-doc',
}

/** workflow.yaml 的 task_types */
const EXAMPLE_TASK_TYPES = {
  requirement_clarify: ['requirement'],
  code_change: ['development'],
  defect_fix: ['development'],
  feature_delivery: ['requirement', 'development'],
  release: ['development', 'ops'],
  incident: ['development', 'ops'],
  new_feature: ['product', 'design', 'requirement', 'development', 'testing', 'ops'],
  data_change: ['data', 'development'],
  doc_update: ['docs'],
}

/** workflow.yaml 的 gates（注意 start 有 max_release: 2，accept 没有） */
const EXAMPLE_GATE_SPECS = {
  confirm_split: { timeout: '8h', on_timeout: 'remind_then_escalate' },
  accept: { timeout: '4h', on_timeout: 'remind_then_escalate' },
  start: { timeout: '2h', on_timeout: 'auto_release', max_release: 2 },
  review: { timeout: '8h', on_timeout: 'remind_then_escalate' },
  acceptance: { timeout: '8h', on_timeout: 'escalate_to_owner' },
}

/** registry.domainsForTaskType：找不到类型必须抛错（配置错误不能静默放过） */
function domainsForTaskType(type) {
  const domains = EXAMPLE_TASK_TYPES[type]
  if (domains === undefined) {
    throw new Error(`未定义的任务类型: ${type}（请先在 workflow.yaml 的 task_types 里定义）`)
  }
  return domains
}

/** registry.resolve 的示例配置版本：只看显式 owner（示例里都有） */
function resolveDomain(domain) {
  return EXAMPLE_DOMAIN_OWNERS[domain] ?? null
}

/** registry.splitConfirmers：需求 owner → requirement 域 → pm 域 → 任务涉及的域 */
function splitConfirmers(domains, requirementOwner) {
  if (requirementOwner !== undefined && requirementOwner !== null) return [requirementOwner]
  for (const key of ['requirement', 'pm']) {
    const r = resolveDomain(key)
    if (r !== null) return [r]
  }
  for (const d of domains) {
    const r = resolveDomain(d)
    if (r !== null) return [r]
  }
  return []
}

/** registry.acceptors：域负责人里排除执行者本人，都排除光了回落到需求负责人 */
function acceptors(domains, assignee, fallbackOwner) {
  const out = []
  for (const d of domains) {
    const r = resolveDomain(d)
    if (r === null) continue
    if (assignee !== null && r === assignee) continue
    if (!out.includes(r)) out.push(r)
  }
  if (out.length === 0 && fallbackOwner !== null && fallbackOwner !== assignee) out.push(fallbackOwner)
  return out
}

/* ------------------------------------------------------------------ *
 * 公共 fixture
 * ------------------------------------------------------------------ */

const NOW = new Date('2026-02-03T10:00:00Z')
const REQ_OWNER = 'human:chen-req'
const DEV = 'human:zhao-dev'
const QA = 'human:sun-qa'
const PM = 'human:zhang-pm'

const requirement = createRequirement(
  {
    id: 'req-2026-014',
    title: '支付失败自动重试',
    type: 'feature_delivery',
    requester: 'human:li-product',
    owner: REQ_OWNER,
    priority: 'P1',
    acceptance_criteria: ['重试 3 次', '不重复扣款'],
  },
  { now: NOW },
)

/** 造一个处于任意状态的任务；门禁按角色域算出，可用 override 覆盖 */
function fixture(state, opts = {}) {
  const type = opts.type ?? 'feature_delivery'
  const domains = domainsForTaskType(type)
  const assignee = opts.assignee === undefined ? DEV : opts.assignee
  const gates = initializeGates(
    buildGates(
      {
        domains,
        assignee,
        confirmers: {
          confirm_split: splitConfirmers(domains, requirement.owner),
          accept: assignee === null ? [] : [assignee],
          start: assignee === null ? [] : [assignee],
          acceptance: acceptors(domains, assignee, requirement.owner),
        },
      },
      EXAMPLE_GATE_SPECS,
    ),
    state,
    NOW,
  )
  return createTask(
    {
      id: 'task-8891',
      req: requirement.id,
      title: '实现重试与退避',
      type,
      domains,
      assignee,
      owner: assignee,
      state,
      acceptance_criteria: ['退避序列可配置'],
      ...(opts.task ?? {}),
    },
    { now: NOW, gates: opts.gates ?? gates },
  )
}

function ctx(extra = {}) {
  return {
    requirement,
    domainOwners: [REQ_OWNER, DEV, QA, PM],
    acceptors: acceptors(['requirement', 'development'], DEV, REQ_OWNER),
    pmOwners: [PM],
    maxRelease: 2,
    now: NOW,
    ...extra,
  }
}

/** 断言跃迁被拒绝，并给出可读的失败信息 */
function expectErr(result, code) {
  assert.equal(result.ok, false, `期望被拒绝(${code})，实际通过了`)
  if (!result.ok) assert.equal(result.code, code, `期望 ${code}，实际 ${result.code}：${result.message}`)
}

const EVIDENCE = [{ kind: 'test', ref: 'pytest://retry/42', at: NOW.toISOString() }]

/** 递归冻结：把“状态机是纯函数”变成会炸的断言（模块是严格模式） */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/* ================================================================== *
 * 门禁计算
 * ================================================================== */

test('角色域决定确认者集合：只管开发的任务只需开发侧', () => {
  const domains = domainsForTaskType('code_change')
  assert.deepEqual(domains, ['development'])
  assert.deepEqual(splitConfirmers(domains), [REQ_OWNER])
  assert.throws(() => domainsForTaskType('nope'), /未定义的任务类型: nope/)
})

test('需求直接落地到开发：两个域都参与验收，且排除执行者本人', () => {
  const domains = domainsForTaskType('feature_delivery')
  const list = acceptors(domains, DEV, REQ_OWNER)
  assert.deepEqual(list, [REQ_OWNER], '开发的负责人就是执行者，必须被排除')
})

test('执行者不是域负责人时，两个域的负责人都可以验收', () => {
  const list = acceptors(['requirement', 'development'], QA, REQ_OWNER)
  assert.deepEqual(list.sort(), [REQ_OWNER, DEV].sort())
})

test('机器人承接：accept/start 门禁标为 not_applicable，但验收仍在', () => {
  const t = fixture('assigned', { assignee: 'bot:dev' })
  assert.equal(t.gates.accept?.not_applicable, true)
  assert.equal(t.gates.start?.not_applicable, true)
  assert.equal(t.gates.acceptance?.not_applicable, false)
  assert.ok(gateSatisfied(t.gates.accept))
})

test('门禁只写策略快照，不写截止时间（buildGates 的职责边界）', () => {
  const gates = buildGates(
    {
      domains: ['requirement', 'development'],
      assignee: DEV,
      confirmers: { confirm_split: [REQ_OWNER], accept: [DEV], start: [DEV], acceptance: [REQ_OWNER] },
    },
    EXAMPLE_GATE_SPECS,
  )
  for (const name of ['confirm_split', 'accept', 'start', 'acceptance']) {
    assert.equal(gates[name].due_at, null, `${name} 建门禁时不该有截止时间`)
  }
  assert.equal(gates.start.timeout_snapshot, '2h')
  assert.equal(gates.start.on_timeout, 'auto_release')
  assert.equal(gates.start.max_release, 2)
  assert.equal(gates.accept.timeout_snapshot, '4h')
  assert.equal(gates.accept.max_release, null, '接受门禁没有自动释放')
  assert.equal(gates.acceptance.on_timeout, 'escalate_to_owner')
  // 机器人执行者：required_by 清空 + not_applicable
  const botGates = buildGates(
    {
      domains: ['development'],
      assignee: 'bot:dev',
      confirmers: { confirm_split: [REQ_OWNER], accept: [], start: [], acceptance: [REQ_OWNER] },
    },
    EXAMPLE_GATE_SPECS,
  )
  assert.deepEqual(botGates.accept.required_by, [])
  assert.equal(botGates.accept.not_applicable, true)
  assert.equal(botGates.confirm_split.not_applicable, false, '确认拆解仍要人确认')
})

test('没有 specs 时快照全为 null（= 没有超时策略，而不是“用当前配置”）', () => {
  const gates = buildGates({
    domains: ['development'],
    assignee: DEV,
    confirmers: { confirm_split: [REQ_OWNER], accept: [DEV], start: [DEV], acceptance: [REQ_OWNER] },
  })
  for (const name of ['confirm_split', 'accept', 'start', 'acceptance']) {
    assert.equal(gates[name].timeout_snapshot, null)
    assert.equal(gates[name].on_timeout, null)
    assert.equal(gates[name].max_release, null)
  }
})

/* ================================================================== *
 * 门禁时钟：GATE_ACTIVE_IN 的激活时序
 * ================================================================== */

test('门禁的时钟只在对应阶段才开始走，避免“任务刚建就被升级”', () => {
  const proposed = fixture('proposed')
  assert.ok(proposed.gates.confirm_split?.due_at !== null, 'proposed 阶段只有确认拆解在计时')
  assert.equal(proposed.gates.accept?.due_at, null, '还没指派，接受不该计时')
  assert.equal(proposed.gates.start?.due_at, null)
  assert.equal(proposed.gates.acceptance?.due_at, null)

  const assigned = fixture('assigned')
  assert.equal(assigned.gates.accept?.due_at, '2026-02-03T14:00:00.000Z', '接受超时 4h')
  assert.equal(assigned.gates.start?.due_at, null, 'start 要等接受之后才开始计时')
  assert.equal(assigned.gates.acceptance?.due_at, null)

  const accepted = fixture('accepted')
  assert.equal(accepted.gates.start?.due_at, '2026-02-03T12:00:00.000Z', '开始超时 2h，从 accepted 起算')
  assert.equal(accepted.gates.acceptance?.due_at, null)

  const inReview = fixture('in_review')
  assert.equal(inReview.gates.acceptance?.due_at, '2026-02-03T18:00:00.000Z', '验收超时 8h')
})

test('GATE_ACTIVE_IN 与四个状态一一对应（表本身就是契约）', () => {
  assert.deepEqual(Object.keys(GATE_ACTIVE_IN).sort(), ['accept', 'acceptance', 'confirm_split', 'start'])
  assert.deepEqual([...GATE_ACTIVE_IN.confirm_split], ['proposed'])
  assert.deepEqual([...GATE_ACTIVE_IN.accept], ['assigned'])
  assert.deepEqual([...GATE_ACTIVE_IN.start], ['accepted'])
  assert.deepEqual([...GATE_ACTIVE_IN.acceptance], ['in_review'])
})

test('机器人承接的门禁不算截止时间（走租约，不等人工确认）', () => {
  const assigned = fixture('assigned', { assignee: 'bot:dev' })
  assert.equal(assigned.gates.accept?.due_at, null, 'required_by 为空 → activateDue 不动它')
  assert.equal(assigned.gates.start?.due_at, null)
  assert.equal(hasDeadline(assigned.gates.accept), false)
  // 但验收门禁照常计时：机器人也要被验收（只是它自己不需要点“接受/开始”）
  const inReview = fixture('in_review', { assignee: 'bot:dev' })
  assert.equal(hasDeadline(inReview.gates.acceptance), true)
  assert.equal(inReview.gates.acceptance?.due_at, '2026-02-03T18:00:00.000Z')
})

test('状态跃迁接力激活下一个门禁，而不是在建任务时一次算完', () => {
  let t = fixture('proposed')
  assert.equal(t.gates.accept?.due_at, null)

  const split = transitionTask(t, 'confirm_split', REQ_OWNER, ctx())
  assert.ok(split.ok)
  t = split.next
  assert.equal(t.gates.accept?.due_at, null, '确认拆解本身不激活 accept，指派才激活')

  const assigned = transitionTask(t, 'assign', REQ_OWNER, ctx({ suggestedAssignee: DEV }))
  assert.ok(assigned.ok)
  t = assigned.next
  assert.equal(t.gates.accept?.due_at, '2026-02-03T14:00:00.000Z', '指派那一刻 accept 开始计时')
  assert.equal(t.gates.start?.due_at, null)

  const accepted = transitionTask(t, 'accept', DEV, ctx())
  assert.ok(accepted.ok)
  t = accepted.next
  assert.equal(t.gates.start?.due_at, '2026-02-03T12:00:00.000Z', '接受之后 start 才开始计时')

  const started = transitionTask(t, 'start', DEV, ctx())
  assert.ok(started.ok)
  t = started.next
  const submitted = transitionTask({ ...t, evidence: EVIDENCE }, 'submit', DEV, ctx())
  assert.ok(submitted.ok)
  assert.equal(
    submitted.next.gates.acceptance?.due_at,
    '2026-02-03T18:00:00.000Z',
    '提交验收那一刻验收门禁开始计时',
  )
})

test('activateDue 只补一次截止时间：已有 due_at 就绝不重置时钟', () => {
  const gate = fixture('assigned').gates.accept
  const later = new Date('2026-02-03T12:00:00Z')
  const again = activateDue(gate, later)
  assert.equal(again.due_at, '2026-02-03T14:00:00.000Z', '12:00 再激活一次不该变成 16:00')
  assert.equal(again, gate, '不变时返回同一个对象（避免无意义的写入）')

  // 从“没有截止时间”的门禁出发，验证 timeout 快照的各种取值
  const fresh = { ...gate, due_at: null }
  assert.equal(activateDue({ ...fresh, timeout_snapshot: 'nonsense' }, NOW).due_at, null)
  assert.equal(activateDue({ ...fresh, timeout_snapshot: '0h' }, NOW).due_at, null)
  assert.equal(activateDue({ ...fresh, timeout_snapshot: null }, NOW).due_at, null)
  // 1.5d 这类小数也认（36 小时）
  assert.equal(activateDue({ ...fresh, timeout_snapshot: '1.5d' }, NOW).due_at, '2026-02-04T22:00:00.000Z')
  // required_by 为空 = 没人要确认，不需要计时
  assert.equal(activateDue({ ...fresh, required_by: [] }, NOW).due_at, null)
  assert.equal(activateDue({ ...fresh, not_applicable: true }, NOW).due_at, null)
})

/* ================================================================== *
 * 主流程：两道确认
 * ================================================================== */

test('完整闭环：proposed → done 需要两次人工确认 + 一次验收', () => {
  let t = fixture('proposed')

  // 门禁 0：确认拆解
  const split = transitionTask(t, 'confirm_split', REQ_OWNER, ctx())
  assert.ok(split.ok)
  t = split.next
  assert.equal(t.state, 'confirmed')

  // 指派（机器人只能建议，由人/域负责人落定）
  const assigned = transitionTask(t, 'assign', REQ_OWNER, ctx({ suggestedAssignee: DEV }))
  assert.ok(assigned.ok)
  t = assigned.next
  assert.equal(t.state, 'assigned')

  // 未经确认接受，不能开始
  expectErr(transitionTask(t, 'start', DEV, ctx()), 'invalid_state')

  // 门禁 1：接受
  const accepted = transitionTask(t, 'accept', DEV, ctx())
  assert.ok(accepted.ok)
  t = accepted.next
  assert.equal(t.state, 'accepted')
  assert.equal(t.gates.accept?.confirmed_by.length, 1, '确认必须写回对象（gates.*.confirmed_by）')
  assert.equal(t.gates.accept?.confirmed_by[0]?.by, DEV)

  // 门禁 2：开始
  const started = transitionTask(t, 'start', DEV, ctx())
  assert.ok(started.ok)
  t = started.next
  assert.equal(t.state, 'in_progress')

  // 没有证据不能提交验收
  expectErr(transitionTask(t, 'submit', DEV, ctx()), 'evidence_required')

  t = { ...t, evidence: [{ kind: 'test', ref: 'pytest://retry/42', at: NOW.toISOString() }] }
  const submitted = transitionTask(t, 'submit', DEV, ctx())
  assert.ok(submitted.ok)
  t = submitted.next
  assert.equal(t.state, 'in_review')

  // 执行者不能验收自己的产出
  expectErr(transitionTask(t, 'verify', DEV, ctx()), 'self_review')

  const verified = transitionTask(t, 'verify', REQ_OWNER, ctx())
  assert.ok(verified.ok)
  assert.equal(verified.next.state, 'done')
})

test('拒绝不需要理由，但任务必须回到需求负责人重派（不允许悬空）', () => {
  const t = fixture('assigned')
  const rejected = transitionTask(t, 'reject', DEV, ctx())
  assert.ok(rejected.ok)
  assert.equal(rejected.next.state, 'rejected')
  assert.equal(rejected.next.assignee, null)
  const last = rejected.next.history.at(-1)
  assert.equal(last?.to, 'rejected')
  assert.deepEqual(last?.detail, { reassignNeeded: true })
  assert.ok(rejected.next.history.length >= 2, '历史必须落进对象（否则查不到是谁推的）')
})

test('只有被指派的执行者本人能接受或拒绝', () => {
  const t = fixture('assigned')
  expectErr(transitionTask(t, 'accept', QA, ctx()), 'not_assigned_to_you')
  expectErr(transitionTask(t, 'reject', QA, ctx()), 'not_assigned_to_you')
  expectErr(transitionTask(t, 'start', QA, ctx()), 'invalid_state', '状态不对先拦下来')
})

test('转派后新执行者仍需确认接受', () => {
  const t = fixture('accepted')
  const moved = transitionTask(t, 'reassign', DEV, ctx({ suggestedAssignee: QA }))
  assert.ok(moved.ok)
  assert.equal(moved.next.state, 'assigned')
  assert.equal(moved.next.assignee, QA)
  assert.equal(moved.next.gates.accept?.confirmed_by.length, 0, '确认记录不能跟着转派带走')
})

test('执行者可以交回任务', () => {
  const t = fixture('accepted')
  const back = transitionTask(t, 'unassign', DEV, ctx())
  assert.ok(back.ok)
  assert.equal(back.next.state, 'assigned')
  assert.equal(back.next.assignee, null)
})

/* ================================================================== *
 * 超时与释放
 * ================================================================== */

test('确认开始超时 → 自动释放回待接受，并记一次释放', () => {
  const t = fixture('accepted')
  const released = transitionTask(t, 'timeout_start', 'system', ctx())
  assert.ok(released.ok)
  assert.equal(released.next.state, 'assigned')
  assert.equal(released.next.assignee, null)
  assert.equal(released.next.release_count, 1)
  assert.ok(released.effects.join('|').includes('第 1 次'))
  assert.deepEqual(released.history.detail, { releaseCount: 1 })
})

test('连续释放到上限 → 升级给人，不再轮回派发', () => {
  const t = { ...fixture('accepted'), release_count: 1 }
  expectErr(transitionTask(t, 'timeout_start', 'system', ctx({ maxRelease: 2 })), 'escalate')
})

test('确认接受超时 → 只催办升级，绝不自动释放', () => {
  const t = fixture('assigned')
  const result = transitionTask(t, 'timeout_accept', 'system', ctx())
  expectErr(result, 'escalate')
  assert.equal('next' in result, false, '不释放就不该有 next')
  assert.deepEqual(t, fixture('assigned'), '超时判定不能改动任务本身')
})

test('执行中租约过期 → 任务状态不变，交给人决定', () => {
  const t = fixture('in_progress')
  const result = transitionTask(t, 'lease_expired', 'system', ctx())
  expectErr(result, 'escalate')
  assert.equal('next' in result, false)
  assert.equal(t.state, 'in_progress')
})

test('租约宽限期满 → timeout_lease 收回为 assigned 并记一次释放', () => {
  const t = fixture('in_progress')
  const back = transitionTask(t, 'timeout_lease', 'system', ctx())
  assert.ok(back.ok)
  assert.equal(back.next.state, 'assigned')
  assert.equal(back.next.assignee, null)
  assert.equal(back.next.release_count, 1)
  assert.deepEqual(back.history.detail, { leaseTimedOut: true, releaseCount: 1 })
})

test('max_release 的优先级：门禁快照 → ctx.maxRelease → 默认 2', () => {
  // 快照说 1 次就升级，ctx 说 5 次 —— 快照赢（改配置不影响进行中的任务）
  const snapshotWins = { ...fixture('accepted'), gates: { ...fixture('accepted').gates } }
  snapshotWins.gates.start = { ...snapshotWins.gates.start, max_release: 1 }
  expectErr(transitionTask(snapshotWins, 'timeout_start', 'system', ctx({ maxRelease: 5 })), 'escalate')

  // 快照为空 → 用 ctx
  const noSnapshot = { ...fixture('accepted'), gates: { ...fixture('accepted').gates } }
  noSnapshot.gates.start = { ...noSnapshot.gates.start, max_release: null }
  expectErr(transitionTask(noSnapshot, 'timeout_start', 'system', ctx({ maxRelease: 1 })), 'escalate')

  // 都没有 → 默认 2：release_count 1 时再释放一次就到顶
  const defaults = { ...noSnapshot, release_count: 1 }
  const noCtx = ctx({ maxRelease: undefined })
  expectErr(transitionTask(defaults, 'timeout_start', 'system', noCtx), 'escalate')
  const firstRelease = { ...noSnapshot, release_count: 0 }
  const ok = transitionTask(firstRelease, 'timeout_start', 'system', noCtx)
  assert.ok(ok.ok, '第一次释放还不到默认上限 2')
  assert.equal(ok.next.release_count, 1)
})

test('accept 超时与 start 超时是两条不同的路：一个只催办，一个真释放', () => {
  const assigned = fixture('assigned')
  const accepted = fixture('accepted')
  assert.equal(dueAction({ task: assigned, gate: 'accept', due_at: 'x', on_timeout: null, max_release: null }), 'timeout_accept')
  assert.equal(dueAction({ task: accepted, gate: 'start', due_at: 'x', on_timeout: null, max_release: null }), 'timeout_start')
  // confirm_split / acceptance 超时只发通知，不动状态
  assert.equal(dueAction({ task: accepted, gate: 'confirm_split', due_at: 'x', on_timeout: null, max_release: null }), null)
  assert.equal(dueAction({ task: accepted, gate: 'acceptance', due_at: 'x', on_timeout: null, max_release: null }), null)

  const acceptResult = transitionTask(assigned, dueAction({ gate: 'accept' }), 'system', ctx())
  assert.equal(acceptResult.ok, false)
  assert.equal(acceptResult.code, 'escalate')
  const startResult = transitionTask(accepted, dueAction({ gate: 'start' }), 'system', ctx())
  assert.equal(startResult.ok, true)
  assert.equal(startResult.next.release_count, 1)
})

/* ================================================================== *
 * 三条硬闸
 * ================================================================== */

test('硬闸一 self_review：执行者本人不能验收，且先于“你是不是验收人”判定', () => {
  const t = { ...fixture('in_review'), evidence: EVIDENCE }
  expectErr(transitionTask(t, 'verify', DEV, ctx()), 'self_review')

  // 执行者同时是需求负责人（canGovern 为真）也一样拦——顺序不能反
  const ownerAssignee = { ...fixture('in_review', { assignee: REQ_OWNER }), evidence: EVIDENCE }
  expectErr(transitionTask(ownerAssignee, 'verify', REQ_OWNER, ctx()), 'self_review')
})

test('硬闸二 evidence_required：submit 与 verify 无证据直接拒', () => {
  const inProgress = fixture('in_progress')
  assert.equal(inProgress.evidence.length, 0)
  expectErr(transitionTask(inProgress, 'submit', DEV, ctx()), 'evidence_required')

  const inReview = fixture('in_review')
  expectErr(transitionTask(inReview, 'verify', REQ_OWNER, ctx()), 'evidence_required')

  // 有证据就能过闸
  const submitted = transitionTask({ ...inProgress, evidence: EVIDENCE }, 'submit', DEV, ctx())
  assert.ok(submitted.ok)
  const verified = transitionTask({ ...inReview, evidence: EVIDENCE }, 'verify', REQ_OWNER, ctx())
  assert.ok(verified.ok)
})

test('硬闸三 gate_incomplete：required_by 还有人没确认就不能完成', () => {
  const base = fixture('in_review', { assignee: QA })
  const acceptance = { ...base.gates.acceptance, required_by: [REQ_OWNER, DEV], confirmed_by: [] }
  const t = { ...base, evidence: EVIDENCE, gates: { ...base.gates, acceptance } }
  const acceptorsFor = ctx({ acceptors: [REQ_OWNER, DEV] })

  const first = transitionTask(t, 'verify', REQ_OWNER, acceptorsFor)
  expectErr(first, 'gate_incomplete')
  assert.deepEqual(first.pending, [DEV], '还差谁必须能直接拿去催办')

  // 注意：失败跃迁不会写回对象，所以第一次的确认没有落盘（hub 同样如此）。
  // 第二次由 DEV 点，仍然差 REQ_OWNER —— 这说明“半确认”不会被当成通过。
  const second = transitionTask(t, 'verify', DEV, acceptorsFor)
  expectErr(second, 'gate_incomplete')
  assert.deepEqual(second.pending, [REQ_OWNER])

  // 门禁上已有 DEV 的确认时，REQ_OWNER 一点就齐活
  const halfDone = {
    ...t,
    gates: {
      ...t.gates,
      acceptance: { ...acceptance, confirmed_by: [{ by: DEV, at: NOW.toISOString() }] },
    },
  }
  const both = transitionTask(halfDone, 'verify', REQ_OWNER, acceptorsFor)
  assert.ok(both.ok)
  assert.equal(both.next.state, 'done')
  assert.deepEqual(
    both.next.gates.acceptance?.confirmed_by.map((c) => c.by),
    [DEV, REQ_OWNER],
    '自己的那一条追加在已有确认后面',
  )
})

test('satisfyGate 第一步：门禁列了名单，名单外的人（哪怕是需求负责人）不能点头', () => {
  const base = fixture('in_review')
  const t = {
    ...base,
    evidence: EVIDENCE,
    gates: { ...base.gates, acceptance: { ...base.gates.acceptance, required_by: [DEV] } },
  }
  const result = transitionTask(t, 'verify', REQ_OWNER, ctx({ acceptors: [REQ_OWNER] }))
  expectErr(result, 'forbidden')
  assert.deepEqual(result.pending, [DEV])
  assert.equal(result.message, '你不是"acceptance"门禁的确认人')
})

test('satisfyGate 第二步：名单为空时只有需求负责人 / pm 能代确认', () => {
  const base = fixture('in_review')
  const t = {
    ...base,
    evidence: EVIDENCE,
    gates: { ...base.gates, acceptance: { ...base.gates.acceptance, required_by: [] } },
  }
  const outsider = transitionTask(t, 'verify', QA, ctx({ acceptors: [QA] }))
  expectErr(outsider, 'forbidden')
  assert.equal(outsider.message, '"acceptance"门禁没有指定确认人，只有需求负责人或项目经理可以代确认')
  assert.equal('pending' in outsider, false, '空名单没有“还差谁”')

  const pm = transitionTask(t, 'verify', PM, ctx())
  assert.ok(pm.ok, 'pm 可以代确认')
  assert.equal(pm.next.state, 'done')
  assert.deepEqual(pm.next.gates.acceptance?.confirmed_by.map((c) => c.by), [PM])
})

test('satisfyGate 第三步：同一个人确认两次不会写两条', () => {
  // required_by 里同一个人出现两次：一次确认即可满足，且 confirmed_by 只有一条
  const base = fixture('in_review')
  const t = {
    ...base,
    evidence: EVIDENCE,
    gates: { ...base.gates, acceptance: { ...base.gates.acceptance, required_by: [REQ_OWNER, REQ_OWNER] } },
  }
  const result = transitionTask(t, 'verify', REQ_OWNER, ctx())
  assert.ok(result.ok, '重复名单不该要求确认两次')
  assert.equal(result.next.gates.acceptance?.confirmed_by.length, 1)

  // 已确认过的人再走一次 satisfyGate 的分支（拆解门禁双确认人场景）
  const splitBase = fixture('proposed')
  const withOne = {
    ...splitBase,
    gates: {
      ...splitBase.gates,
      confirm_split: {
        ...splitBase.gates.confirm_split,
        required_by: [REQ_OWNER, DEV],
        confirmed_by: [{ by: REQ_OWNER, at: NOW.toISOString() }],
      },
    },
  }
  const partial = transitionTask(withOne, 'confirm_split', REQ_OWNER, ctx())
  expectErr(partial, 'gate_incomplete')
  assert.deepEqual(partial.pending, [DEV])
  const done = transitionTask(withOne, 'confirm_split', DEV, ctx())
  assert.ok(done.ok)
  assert.deepEqual(done.next.gates.confirm_split?.confirmed_by.map((c) => c.by), [REQ_OWNER, DEV])
})

test('confirm_split 的身份守卫：名单为空时退回治理权限', () => {
  const base = fixture('proposed')
  const noList = { ...base, gates: { ...base.gates, confirm_split: { ...base.gates.confirm_split, required_by: [] } } }
  expectErr(transitionTask(noList, 'confirm_split', DEV, ctx()), 'forbidden')
  const byOwner = transitionTask(noList, 'confirm_split', REQ_OWNER, ctx())
  assert.ok(byOwner.ok)
  assert.deepEqual(byOwner.next.gates.confirm_split?.confirmed_by.map((c) => c.by), [REQ_OWNER])
})

/* ================================================================== *
 * 机器人执行者
 * ================================================================== */

test('机器人执行者：accept/start 门禁不适用，但验收门禁照常卡人', () => {
  // 机器人任务的验收人只留需求负责人（accept/start 走租约，不需要人工确认）
  const botGates = initializeGates(
    buildGates(
      {
        domains: ['requirement', 'development'],
        assignee: 'bot:dev',
        confirmers: { confirm_split: [REQ_OWNER], accept: [], start: [], acceptance: [REQ_OWNER] },
      },
      EXAMPLE_GATE_SPECS,
    ),
    'in_progress',
    NOW,
  )
  const t = fixture('in_progress', { assignee: 'bot:dev', gates: botGates })
  assert.equal(gateSatisfied(t.gates.accept), true)
  assert.equal(gateSatisfied(t.gates.start), true)
  assert.equal(gateLine(t), '⏳ 待验收', '机器人门禁不出现在确认行里')

  const withEvidence = { ...t, evidence: EVIDENCE }
  const submitted = transitionTask(withEvidence, 'submit', 'bot:dev', ctx())
  assert.ok(submitted.ok)
  assert.equal(submitted.next.gates.acceptance?.due_at, '2026-02-03T18:00:00.000Z', '验收门禁仍要计时')
  // 机器人自己也不能验收自己的产出
  expectErr(transitionTask(submitted.next, 'verify', 'bot:dev', ctx()), 'self_review')
  const verified = transitionTask(submitted.next, 'verify', REQ_OWNER, ctx())
  assert.ok(verified.ok)
  assert.equal(verified.next.state, 'done')
})

/* ================================================================== *
 * CI 与阻塞
 * ================================================================== */

test('CI 失败回到执行者，不带证据也能回退', () => {
  const t = fixture('ci_running')
  const failed = transitionTask(t, 'ci_fail', 'system', ctx())
  assert.ok(failed.ok)
  assert.equal(failed.next.state, 'in_progress')
})

test('CI 通过进入待验收，并激活验收门禁', () => {
  const t = fixture('ci_running')
  const passed = transitionTask(t, 'ci_pass', 'system', ctx())
  assert.ok(passed.ok)
  assert.equal(passed.next.state, 'in_review')
  assert.equal(passed.next.gates.acceptance?.due_at, '2026-02-03T18:00:00.000Z')
})

test('阻塞与解除', () => {
  const t = fixture('in_progress')
  const blocked = transitionTask(t, 'block', DEV, ctx())
  assert.ok(blocked.ok)
  assert.equal(blocked.next.state, 'blocked')
  assert.equal(blocked.next.blocked_reason, '未填写原因')
  const unblocked = transitionTask(blocked.next, 'unblock', DEV, ctx())
  assert.ok(unblocked.ok)
  assert.equal(unblocked.next.state, 'in_progress')
  assert.equal(unblocked.next.blocked_reason, null)
})

test('已经阻塞的任务不能再提交验收前先解除（submit 允许从 blocked 走）', () => {
  const t = {
    ...fixture('blocked'),
    evidence: [{ kind: 'note', ref: 'note://1', at: NOW.toISOString() }],
  }
  const submitted = transitionTask(t, 'submit', DEV, ctx())
  assert.ok(submitted.ok)
  assert.equal(submitted.next.state, 'in_review')
})

test('阻塞的原因会被保留（blocked_reason 不被“未填写原因”覆盖）', () => {
  const t = { ...fixture('in_progress'), blocked_reason: '等下游接口' }
  const blocked = transitionTask(t, 'block', DEV, ctx())
  assert.ok(blocked.ok)
  assert.equal(blocked.next.blocked_reason, '等下游接口')
})

/* ================================================================== *
 * 权威动作
 * ================================================================== */

test('挂起与恢复只能由需求负责人或项目经理做', () => {
  const t = fixture('in_progress')
  const suspended = transitionTask(t, 'suspend', PM, ctx())
  assert.ok(suspended.ok)
  assert.equal(suspended.next.state, 'suspended')
  assert.deepEqual(suspended.history.detail, { frozenState: 'in_progress' })
  expectErr(transitionTask(t, 'suspend', DEV, ctx()), 'forbidden')

  const resumed = transitionTask(suspended.next, 'resume', REQ_OWNER, ctx())
  assert.ok(resumed.ok)
  assert.equal(resumed.next.state, 'assigned', '恢复回到待接受，重新走确认')
})

test('执行者不能废弃任务', () => {
  const t = fixture('in_progress')
  expectErr(transitionTask(t, 'drop', DEV, ctx()), 'forbidden')
  const dropped = transitionTask(t, 'drop', REQ_OWNER, ctx())
  assert.ok(dropped.ok)
  assert.equal(dropped.next.state, 'dropped')
})

test('归档只有 done 能做，且不需要额外权限', () => {
  const t = fixture('done')
  const archived = transitionTask(t, 'archive', DEV, ctx())
  assert.ok(archived.ok)
  assert.equal(archived.next.state, 'archived')
  expectErr(transitionTask(fixture('in_progress'), 'archive', REQ_OWNER, ctx()), 'invalid_state')
})

test('未实现的动作返回 unknown（而不是抛异常）', () => {
  const result = transitionTask(fixture('proposed'), 'explode', DEV, ctx())
  expectErr(result, 'unknown')
  const reqResult = transitionRequirement(requirement, 'explode', REQ_OWNER, ctx())
  expectErr(reqResult, 'unknown')
})

/* ================================================================== *
 * 需求状态机
 * ================================================================== */

test('需求状态机：变更必须走影响面计算，再回到 confirmed', () => {
  let r = requirement
  const confirmed = transitionRequirement(r, 'confirm', REQ_OWNER, ctx())
  assert.ok(confirmed.ok)
  r = confirmed.next

  const dispatched = transitionRequirement(r, 'confirm_split', REQ_OWNER, ctx())
  assert.ok(dispatched.ok)
  r = dispatched.next
  assert.equal(r.state, 'dispatched')

  const changed = transitionRequirement(r, 'change', REQ_OWNER, ctx())
  assert.ok(changed.ok)
  assert.equal(changed.next.state, 'changed')
  assert.ok(
    changed.effects.join('|').includes('影响面'),
    '变更必须产出影响面清单，否则“接需求三天后需求变了”无解',
  )

  // 不能从 changed 直接跳到 done 之类的状态
  expectErr(transitionRequirement(changed.next, 'archive', REQ_OWNER, ctx()), 'invalid_state')

  const reconfirmed = transitionRequirement(changed.next, 'reconfirm', REQ_OWNER, ctx())
  assert.ok(reconfirmed.ok)
  assert.equal(reconfirmed.next.state, 'confirmed')
})

test('需求状态机：非需求负责人不能推进', () => {
  expectErr(transitionRequirement(requirement, 'confirm', DEV, ctx()), 'forbidden')
})

test('需求状态机：治理类动作（挂起/废弃/归档）由 pm 兜底，confirm 不行', () => {
  const dispatched = { ...requirement, state: 'dispatched' }
  // confirm 只允许从 draft 走：状态守卫先于权限判定
  expectErr(transitionRequirement(dispatched, 'confirm', PM, ctx()), 'invalid_state')
  expectErr(transitionRequirement(requirement, 'confirm', PM, ctx()), 'forbidden')
  const suspended = transitionRequirement(dispatched, 'suspend', PM, ctx())
  assert.ok(suspended.ok)
  assert.deepEqual(suspended.history.detail, { frozenState: 'dispatched' })
  const dropped = transitionRequirement(dispatched, 'drop', PM, ctx())
  assert.ok(dropped.ok)
  const archived = transitionRequirement({ ...requirement, state: 'done' }, 'archive', PM, ctx())
  assert.ok(archived.ok)
})

test('需求状态机：历史一样要落进对象', () => {
  const confirmed = transitionRequirement(requirement, 'confirm', REQ_OWNER, ctx())
  assert.ok(confirmed.ok)
  const last = confirmed.next.history.at(-1)
  assert.equal(last?.from, 'draft')
  assert.equal(last?.to, 'confirmed')
  assert.equal(last?.by, REQ_OWNER)
  assert.equal(last?.at, NOW.toISOString())
  assert.equal(last?.effects?.length, 1)
})

/* ================================================================== *
 * 卡片渲染辅助
 * ================================================================== */

test('门禁进度与待确认人可用于卡片确认行', () => {
  const t = fixture('assigned')
  assert.equal(gateLine(t), '⏳ 待接受确认 · ⏳ 待开始确认 · ⏳ 待验收')
  assert.deepEqual(gatePending(t.gates.accept), [DEV])
  assert.deepEqual(gateProgress(t.gates.accept), { confirmed: 0, required: 1 })

  const accepted = transitionTask(t, 'accept', DEV, ctx())
  assert.ok(accepted.ok)
  assert.equal(gateLine(accepted.next), '✅ 接受已确认 · ⏳ 待开始确认 · ⏳ 待验收')
  assert.deepEqual(gatePending(accepted.next.gates.accept), [])
  assert.deepEqual(gateProgress(accepted.next.gates.accept), { confirmed: 1, required: 1 })
})

test('可用动作随状态变化（卡片按钮只显示当前可用的）', () => {
  assert.deepEqual(
    availableActions(fixture('assigned')).sort(),
    ['accept', 'reject', 'suspend', 'timeout_accept', 'drop'].sort(),
  )
  assert.ok(availableActions(fixture('in_review')).includes('verify'))
  assert.ok(!availableActions(fixture('in_review')).includes('accept'))
})

test('gatePending 与 gateProgress 对“没有这道门禁”和机器人门禁都给空', () => {
  assert.deepEqual(gatePending(undefined), [])
  assert.deepEqual(gateProgress(undefined), { confirmed: 0, required: 0 })
  const bot = fixture('assigned', { assignee: 'bot:dev' })
  assert.deepEqual(gatePending(bot.gates.accept), [])
  assert.deepEqual(gateProgress(bot.gates.accept), { confirmed: 0, required: 0 })
  assert.equal(gateLine(bot), '⏳ 待验收', '确认行只剩验收那一段：机器人不用点接受/开始')

  // 完全没建门禁的任务：确认行为空
  const bare = createTask(
    { id: 'task-1', req: 'req-2026-014', title: 't', type: 'code_change', domains: ['development'] },
    { now: NOW },
  )
  assert.equal(gateLine(bare), '')
})

/* ================================================================== *
 * 纯函数性
 * ================================================================== */

test('状态机是纯函数：冻结的输入对象也能跑完整闭环', () => {
  let t = deepFreeze(fixture('proposed'))
  const split = transitionTask(t, 'confirm_split', REQ_OWNER, ctx())
  assert.ok(split.ok)
  t = deepFreeze(split.next)
  const assigned = transitionTask(t, 'assign', REQ_OWNER, ctx({ suggestedAssignee: DEV }))
  assert.ok(assigned.ok)
  t = deepFreeze(assigned.next)
  const accepted = transitionTask(t, 'accept', DEV, ctx())
  assert.ok(accepted.ok)
  t = deepFreeze(accepted.next)
  assert.ok(transitionTask(t, 'start', DEV, ctx()).ok)
  assert.ok(transitionRequirement(deepFreeze(requirement), 'confirm', REQ_OWNER, ctx()).ok)
})

test('状态机不改动传入的任务：失败与成功都一样', () => {
  const t = fixture('assigned')
  const before = structuredClone(t)
  transitionTask(t, 'timeout_accept', 'system', ctx())
  transitionTask(t, 'accept', DEV, ctx())
  transitionTask(t, 'reject', QA, ctx())
  assert.deepEqual(t, before)
})

/* ================================================================== *
 * 对象构造与 schema 默认值
 * ================================================================== */

test('createRequirement：只给必填字段也能得到完整对象（每个 .default() 都补齐）', () => {
  const r = createRequirement(
    {
      id: 'req-2026-014',
      title: '支付失败自动重试',
      type: 'feature_delivery',
      requester: 'human:li-product',
      owner: REQ_OWNER,
      priority: 'P1',
    },
    { now: NOW },
  )
  assert.deepEqual(r, {
    id: 'req-2026-014',
    title: '支付失败自动重试',
    state: 'draft',
    type: 'feature_delivery',
    origin: { surface: 'manual', excerpts: [] },
    requester: 'human:li-product',
    owner: REQ_OWNER,
    priority: 'P1',
    body: { problem: '', proposal: '' },
    acceptance_criteria: [],
    tasks: [],
    links: { repos: [], docs: [], mirror: null, branches: [] },
    decisions: [],
    visibility: 'team',
    history: [{ from: null, to: 'draft', by: 'human:li-product', at: NOW.toISOString() }],
  })
})

test('createRequirement：nested 里的默认值也要补（origin.excerpts / links.mirror / body）', () => {
  const r = createRequirement(
    {
      id: 'req-2026-014',
      title: 't',
      type: 'x',
      requester: 'human:a',
      owner: 'human:b',
      priority: 'P2',
      origin: { surface: 'feishu', chat_id: 'oc_1' },
      body: { problem: 'p' },
      links: { repos: ['pay-service'] },
      visibility: 'project:pay-service',
    },
    { now: NOW },
  )
  assert.deepEqual(r.origin, { surface: 'feishu', chat_id: 'oc_1', excerpts: [] })
  assert.deepEqual(r.body, { problem: 'p', proposal: '' })
  assert.deepEqual(r.links, { repos: ['pay-service'], docs: [], mirror: null, branches: [] })
  assert.equal(r.visibility, 'project:pay-service')
})

test('createTask：只给必填字段也能得到完整对象（每个 .default() 都补齐）', () => {
  const t = createTask(
    { id: 'task-8891', req: 'req-2026-014', title: '实现重试与退避', type: 'feature_delivery', domains: ['development'] },
    { now: NOW },
  )
  assert.deepEqual(t, {
    id: 'task-8891',
    req: 'req-2026-014',
    title: '实现重试与退避',
    state: 'proposed',
    type: 'feature_delivery',
    domains: ['development'],
    assignee: null,
    collaborators: [],
    owner: null,
    acceptance_criteria: [],
    gates: {},
    repo: null,
    branch: null,
    mr: null,
    evidence: [],
    release_count: 0,
    blocked_reason: null,
    history: [{ from: null, to: 'proposed', by: 'system', at: NOW.toISOString() }],
  })
})

test('createTask：owner 缺省跟随 assignee；opts.gates 优先于 input.gates', () => {
  const gates = initializeGates(
    buildGates(
      {
        domains: ['development'],
        assignee: DEV,
        confirmers: { confirm_split: [REQ_OWNER], accept: [DEV], start: [DEV], acceptance: [REQ_OWNER] },
      },
      EXAMPLE_GATE_SPECS,
    ),
    'assigned',
    NOW,
  )
  const t = createTask(
    { id: 'task-1', req: 'req-2026-014', title: 't', type: 'code_change', domains: ['development'], assignee: DEV, gates: {} },
    { now: NOW, gates },
  )
  assert.equal(t.owner, DEV)
  assert.equal(t.gates.accept?.timeout_snapshot, '4h')
  const explicit = createTask(
    { id: 'task-2', req: 'req-2026-014', title: 't', type: 'code_change', domains: ['development'], gates: { start: gates.start } },
    { now: NOW },
  )
  assert.deepEqual(Object.keys(explicit.gates), ['start'])
})

test('parseTask 默认值：逐条对齐 schema.ts（含 gate 的六项默认）', () => {
  const t = parseTask({
    id: 'task-8891',
    req: 'req-2026-014',
    title: 't',
    state: 'proposed',
    type: 'code_change',
    domains: ['development'],
  })
  assert.equal(t.assignee, null)
  assert.deepEqual(t.collaborators, [])
  assert.equal(t.owner, null)
  assert.deepEqual(t.acceptance_criteria, [])
  assert.deepEqual(t.gates, {})
  assert.equal(t.repo, null)
  assert.equal(t.branch, null)
  assert.equal(t.mr, null)
  assert.deepEqual(t.evidence, [])
  assert.equal(t.release_count, 0)
  assert.equal(t.blocked_reason, null)
  assert.deepEqual(t.history, [])
})

test('parseGate / parseLease / parseDecision … 的默认值一条不落', () => {
  assert.deepEqual(parseGate({}), {
    required_by: [],
    confirmed_by: [],
    due_at: null,
    not_applicable: false,
    timeout_snapshot: null,
    on_timeout: null,
    max_release: null,
  })
  assert.deepEqual(
    parseLease({
      task: 'task-8891',
      holder: DEV,
      kind: 'human',
      started_at: NOW.toISOString(),
      expires_at: NOW.toISOString(),
      state: 'active',
    }),
    {
      task: 'task-8891',
      holder: DEV,
      kind: 'human',
      started_at: NOW.toISOString(),
      expires_at: NOW.toISOString(),
      renewals: 0,
      state: 'active',
      release_reason: null,
      expiry_notices: 0,
    },
  )
  assert.deepEqual(
    parseDecision({
      id: 'adr-2026-003',
      title: 't',
      status: 'accepted',
      owner: REQ_OWNER,
      date: '2026-02-03',
    }),
    {
      id: 'adr-2026-003',
      title: 't',
      status: 'accepted',
      owner: REQ_OWNER,
      date: '2026-02-03',
      supersedes: [],
      related: { requirements: [], tasks: [], repos: [] },
    },
  )
  const inbound = parseInboundMessage({
    message_id: 'om_1',
    dedupe_key: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'group',
    received_at: NOW.toISOString(),
  })
  assert.deepEqual(inbound, {
    message_id: 'om_1',
    dedupe_key: 'om_1',
    event_id: null,
    chat_id: 'oc_1',
    chat_type: 'group',
    message_type: 'text',
    thread_id: null,
    sender_open_id: null,
    sender_principal: null,
    mentions: [],
    text: '',
    raw_content: '',
    create_time: null,
    received_at: NOW.toISOString(),
    consumed_by: [],
    ignored_reason: null,
  })
  const callback = parseCallbackRecord({
    nonce: 'n1',
    action: 'task.accept',
    actor: DEV,
    at: NOW.toISOString(),
    outcome: 'applied',
  })
  assert.equal(callback.object_id, null)
  assert.equal(callback.detail, null)
  const conflict = parseConflict({
    id: 'cfl-1',
    kind: 'doc',
    scope: 'requirements/req-2026-014',
    objects: {
      a: { ref: 'r1', version: 'v1', by: 'human:a' },
      b: { ref: 'r2', version: 'v2', by: 'human:b' },
    },
    auto_merge: 'partial',
    owner: REQ_OWNER,
    state: 'open',
  })
  assert.equal(conflict.base, null)
  assert.equal(conflict.suggested_resolution, null)
  assert.equal(conflict.deadline, null)
})

test('parseRequirement：默认值一条不落（visibility / history / links …）', () => {
  const r = parseRequirement({
    id: 'req-2026-014',
    title: 't',
    state: 'draft',
    type: 'x',
    origin: { surface: 'manual' },
    requester: 'human:a',
    owner: 'human:b',
    priority: 'P3',
  })
  assert.deepEqual(r.origin, { surface: 'manual', excerpts: [] })
  assert.deepEqual(r.body, { problem: '', proposal: '' })
  assert.deepEqual(r.acceptance_criteria, [])
  assert.deepEqual(r.tasks, [])
  assert.deepEqual(r.links, { repos: [], docs: [], mirror: null, branches: [] })
  assert.deepEqual(r.decisions, [])
  assert.equal(r.visibility, 'team')
  assert.deepEqual(r.history, [])
})

/* ================================================================== *
 * schema 校验失败：ObjectError 与消息格式
 * ================================================================== */

test('校验失败抛 ObjectError，消息就是 `${path}: ${message}`', () => {
  const check = (fn, expected) => {
    assert.throws(fn, (error) => {
      assert.ok(error instanceof ObjectError, `期望 ObjectError，实际 ${error?.constructor?.name}`)
      assert.equal(error.name, 'ObjectError')
      assert.equal(error.message, expected)
      return true
    })
  }
  const base = { id: 'task-8891', req: 'req-2026-014', title: 't', state: 'proposed', type: 'x', domains: ['development'] }
  check(() => parseTask({ ...base, id: 'nope' }), 'task.id: 任务 ID 形如 task-8891')
  check(() => parseTask({ ...base, req: 'task-1' }), 'task.req: 任务必须归属一个需求')
  check(() => parseTask({ ...base, domains: [] }), 'task.domains: 任务至少要属于一个角色域')
  check(
    () => parseTask({ ...base, state: 'bogus' }),
    "task.state: Invalid enum value. Expected 'proposed' | 'confirmed' | 'assigned' | 'accepted' | 'in_progress' | 'ci_running' | 'blocked' | 'in_review' | 'rejected' | 'suspended' | 'dropped' | 'done' | 'archived', received 'bogus'",
  )
  check(() => parseTask({ ...base, title: '' }), 'task.title: String must contain at least 1 character(s)')
  check(() => parseTask({ ...base, mr: 0 }), 'task.mr: Number must be greater than 0')
  check(() => parseTask({ ...base, release_count: -1 }), 'task.release_count: Number must be greater than or equal to 0')
  check(() => parseTask({ ...base, gates: { bogus: {} } }), "task.gates.bogus: Invalid enum value. Expected 'confirm_split' | 'accept' | 'start' | 'acceptance', received 'bogus'")
  check(() => parseTask({ ...base, nope: 1 }), "task: Unrecognized key(s) in object: 'nope'")
  check(() => parseTask({ id: 'task-1' }), 'task.req: Required')
  check(() => parseRequirement({ id: 'req-26-14' }), 'requirement.id: 需求 ID 形如 req-2026-014')
  check(
    () => parseRequirement({ ...requirement, requester: 'chen-req' }),
    'requirement.requester: 主体应形如 human:xxx / bot:xxx / role:xxx，或 system',
  )
  check(() => parseRequirement({ ...requirement, visibility: 'nope' }), 'requirement.visibility: Invalid')
  check(() => parseRequirement({ ...requirement, visibility: 5 }), 'requirement.visibility: Invalid input')
  check(() => parseRequirement({ ...requirement, body: { problem: 3 } }), 'requirement.body.problem: Expected string, received number')
  check(
    () => parseRequirement({ ...requirement, history: [{ from: null, to: 'draft', by: 'system', at: '2026-02-03T10:00:00' }] }),
    'requirement.history.0.at: Invalid datetime',
  )
  check(() => parseLease({ ...openLease(fixture('accepted'), DEV, DEFAULT_LEASE_POLICY, NOW), task: 'nope' }), 'lease.task: Invalid')
})

test('校验是严格的：未声明的键不静默丢弃；缺省键交给内层报错（Required / 自定义文案）', () => {
  assert.throws(
    () => parseGate({ required_by: [], nope: true }),
    (e) => e.message === "gate: Unrecognized key(s) in object: 'nope'",
  )
  assert.throws(
    () => parseRequirement({ ...requirement, history: [{ from: 'draft', to: 'confirmed' }] }),
    (e) => e.message === 'requirement.history.0.by: 主体应形如 human:xxx / bot:xxx / role:xxx，或 system',
  )
  assert.throws(
    () => parseTask({ id: 'task-1', req: 'req-2026-014', title: 't', state: 'proposed', type: 'x' }),
    (e) => e.message === 'task.domains: Required',
  )
})

/* ================================================================== *
 * 门禁扫描与将来视图（对应 hub/test/store.test.ts 的调度部分）
 * ================================================================== */

test('扫描到期门禁：已满足的不再计时，机器人门禁不参与', () => {
  const task = fixture('assigned')

  // 1 小时后：accept 还差 3 小时，start 尚未计时
  const early = scanDue({ now: new Date('2026-02-03T11:00:00Z'), tasks: [task], leases: [] })
  assert.deepEqual(early.gates.map((g) => g.gate), [])

  // 4 小时后：accept 到期（它只催办，不释放）
  const acceptDue = scanDue({ now: new Date('2026-02-03T14:30:00Z'), tasks: [task], leases: [] })
  assert.deepEqual(acceptDue.gates.map((g) => g.gate), ['accept'])
  assert.equal(dueAction(acceptDue.gates[0]), 'timeout_accept')
  assert.equal(acceptDue.gates[0]?.max_release, null, '接受门禁没有自动释放')
  assert.equal(acceptDue.gates[0]?.on_timeout, 'remind_then_escalate', '策略用对象里的快照')
})

test('机器人承接的任务：accept/start 门禁不产生超时', () => {
  const task = fixture('in_progress', { assignee: 'bot:dev' })
  const due = scanDue({ now: new Date('2026-02-04T10:00:00Z'), tasks: [task], leases: [] })
  assert.deepEqual(due.gates, [])
})

test('确认满足后即使超时也不该再触发', () => {
  const task = fixture('assigned')
  const accepted = transitionTask(task, 'accept', DEV, {
    requirement: undefined,
    now: NOW,
    domainOwners: [DEV],
    acceptors: [REQ_OWNER],
    pmOwners: [],
  })
  assert.ok(accepted.ok)

  const due = scanDue({ now: new Date('2026-02-03T13:00:00Z'), tasks: [accepted.next], leases: [] })
  assert.deepEqual(
    due.gates.map((g) => g.gate),
    ['start'],
    'accept 已确认，只剩 start 到期',
  )
})

test('没有 due_at 的门禁（还没到那个阶段）不会被扫描到', () => {
  const proposed = fixture('proposed')
  const due = scanDue({ now: new Date('2026-02-03T18:00:00Z'), tasks: [proposed], leases: [] })
  assert.deepEqual(due.gates.map((g) => g.gate), ['confirm_split'])
  assert.equal(due.gates[0]?.on_timeout, 'remind_then_escalate')
})

test('到期项按时间升序，租约过期单独扫描（active 与 expired 都要收）', () => {
  const due = scanDue({
    now: new Date('2026-02-03T12:00:00Z'),
    tasks: [],
    leases: [
      { task: 'task-1', expires_at: '2026-02-03T11:00:00Z', state: 'active' },
      { task: 'task-2', expires_at: '2026-02-03T13:00:00Z', state: 'active' },
      { task: 'task-3', expires_at: '2026-02-03T11:00:00Z', state: 'released' },
      { task: 'task-4', expires_at: '2026-02-03T10:00:00Z', state: 'expired' },
      { task: 'task-5', expires_at: '2026-02-03T09:00:00Z', state: 'returned' },
    ],
  })
  assert.deepEqual(due.leases.map((l) => l.task_id), ['task-4', 'task-1'])
  assert.deepEqual(due.leases.map((l) => l.lease_id), ['task-4', 'task-1'], '租约 id 就是 task_id')
})

test('将来 24 小时视图：运维能看到接下来会发生什么', () => {
  const now = new Date('2026-02-03T11:00:00Z')
  const task = fixture('assigned')

  // 24 小时内：accept 于 14:00 到期
  const soon = upcoming([task], now, 24 * 3_600_000)
  assert.deepEqual(soon.map((g) => g.gate), ['accept'])
  assert.ok(remainingMs(soon[0].due_at, now) > 0)

  // 30 分钟内：什么都不到期
  assert.deepEqual(upcoming([task], now, 30 * 60_000), [])

  // 5 小时后：accept 已经超时（不再出现在“将来”里）
  assert.deepEqual(upcoming([task], new Date('2026-02-03T15:00:00Z'), 24 * 3_600_000), [])
})

test('remainingMs 对已超时的截止时间是负数', () => {
  const due = fixture('assigned').gates.accept.due_at
  assert.equal(remainingMs(due, new Date('2026-02-03T12:00:00Z')), 2 * 3_600_000)
  assert.ok(remainingMs(due, new Date('2026-02-03T16:00:00Z')) < 0)
})

/* ================================================================== *
 * 租约
 * ================================================================== */

test('openLease：人在接受那一刻起租 2 天，机器人 1 小时', () => {
  const task = fixture('accepted')
  const human = openLease(task, DEV, DEFAULT_LEASE_POLICY, NOW)
  assert.deepEqual(human, {
    task: 'task-8891',
    holder: DEV,
    kind: 'human',
    started_at: NOW.toISOString(),
    expires_at: '2026-02-05T10:00:00.000Z',
    renewals: 0,
    state: 'active',
    release_reason: null,
    expiry_notices: 0,
  })
  const bot = openLease(task, 'bot:dev', DEFAULT_LEASE_POLICY, NOW)
  assert.equal(bot.kind, 'bot')
  assert.equal(bot.expires_at, '2026-02-03T11:00:00.000Z')
  const role = openLease(task, 'role:qa', DEFAULT_LEASE_POLICY, NOW)
  assert.equal(role.kind, 'bot', 'role: 也算机器人侧')
  assert.deepEqual(DEFAULT_LEASE_POLICY, { lease_days: 2, lease_grace_days: 1, bot_lease_hours: 1 })
  assert.equal(leaseIdOf('task-8891'), 'task-8891')
})

test('renewLease：只有持有人本人能续；续约是一次“重新承诺”', () => {
  const lease = openLease(fixture('accepted'), DEV, DEFAULT_LEASE_POLICY, NOW)
  const later = new Date('2026-02-04T10:00:00Z')

  const denied = renewLease(lease, QA, DEFAULT_LEASE_POLICY, later)
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, '只有任务持有人本人（或需求负责人）可以续约')
  assert.equal(denied.lease, undefined)

  const renewed = renewLease(lease, DEV, DEFAULT_LEASE_POLICY, later)
  assert.equal(renewed.ok, true)
  assert.equal(renewed.lease.renewals, 1)
  assert.equal(renewed.lease.expires_at, '2026-02-06T10:00:00.000Z', '推一个完整时限，不是加一点')
  assert.equal(renewed.lease.expiry_notices, 0, '续约要把播报计数清零')
  assert.equal(renewed.lease.release_reason, null)

  // 需求负责人代续（由调用方声明 allowAnyone）
  const byOwner = renewLease(lease, REQ_OWNER, DEFAULT_LEASE_POLICY, later, { allowAnyone: true })
  assert.equal(byOwner.ok, true)

  // 过期态还能续（expired 是“等宽限期”的中间态）
  const expired = { ...lease, state: 'expired', expiry_notices: 1 }
  assert.equal(renewLease(expired, DEV, DEFAULT_LEASE_POLICY, later).ok, true)
  // 终态不能续
  for (const state of ['released', 'returned']) {
    const closed = renewLease({ ...lease, state }, DEV, DEFAULT_LEASE_POLICY, later)
    assert.equal(closed.ok, false)
    assert.equal(closed.reason, `租约当前是 ${state}，不能续约`)
  }
})

test('releaseLease：expired 原因落成 expired 态，其余落成 released；taskEffect 可声明', () => {
  const lease = openLease(fixture('accepted'), DEV, DEFAULT_LEASE_POLICY, NOW)
  assert.deepEqual(releaseLease(lease, 'expired'), {
    lease: { ...lease, state: 'expired', release_reason: 'expired' },
    taskEffect: 'none',
  })
  const startTimeout = releaseLease(lease, 'start_timeout', { taskEffect: 'back_to_assigned' })
  assert.equal(startTimeout.lease.state, 'released')
  assert.equal(startTimeout.lease.release_reason, 'start_timeout')
  assert.equal(startTimeout.taskEffect, 'back_to_assigned')
  assert.equal(releaseLease(lease, 'returned').lease.state, 'released')
})

test('leaseVerdict 三档之一 ok：没过期、终态、时间戳坏掉都算 ok', () => {
  const lease = openLease(fixture('accepted'), DEV, DEFAULT_LEASE_POLICY, NOW)
  assert.deepEqual(leaseVerdict(lease, DEFAULT_LEASE_POLICY, NOW), { kind: 'ok' })
  assert.deepEqual(
    leaseVerdict(lease, DEFAULT_LEASE_POLICY, new Date('2026-02-05T10:00:00Z')),
    { kind: 'ok' },
    '刚好到期（差 0）不算过期',
  )
  assert.deepEqual(leaseVerdict({ ...lease, state: 'released' }, DEFAULT_LEASE_POLICY, new Date('2026-03-01T00:00:00Z')), { kind: 'ok' })
  assert.deepEqual(leaseVerdict({ ...lease, state: 'returned' }, DEFAULT_LEASE_POLICY, new Date('2026-03-01T00:00:00Z')), { kind: 'ok' })
  assert.deepEqual(leaseVerdict({ ...lease, expires_at: 'not-a-date' }, DEFAULT_LEASE_POLICY, new Date('2026-03-01T00:00:00Z')), { kind: 'ok' })
})

test('leaseVerdict 三档之二 notify：首次发现过期，先播报', () => {
  const lease = openLease(fixture('accepted'), DEV, DEFAULT_LEASE_POLICY, NOW)
  const oneHourLate = new Date('2026-02-05T11:00:00Z')
  assert.deepEqual(leaseVerdict(lease, DEFAULT_LEASE_POLICY, oneHourLate), {
    kind: 'notify',
    overdueMs: 3_600_000,
    notices: 0,
  })

  /**
   * 关键：服务停了三个月才重启，一次 tick 同时跨过“已过期”和“宽限期已满”。
   * 这时**必须先播报**——直接 reclaim 等于“人根本没收到通知，任务就没了”。
   */
  const wayLate = new Date('2026-05-05T10:00:00Z')
  const verdict = leaseVerdict(lease, DEFAULT_LEASE_POLICY, wayLate)
  assert.equal(verdict.kind, 'notify', '第一次发现过期，无论过了多久都先播报')
  assert.ok(verdict.overdueMs > DEFAULT_LEASE_POLICY.lease_grace_days * 86_400_000)
})

test('leaseVerdict 三档之三 reclaim：播报过、且宽限期已满才收回', () => {
  const lease = openLease(fixture('accepted'), DEV, DEFAULT_LEASE_POLICY, NOW)
  const expired = { ...lease, state: 'expired', release_reason: 'expired', expiry_notices: 1 }
  const graceMs = DEFAULT_LEASE_POLICY.lease_grace_days * 86_400_000

  // 宽限期内：沉默等待（不能再刷屏）
  assert.deepEqual(leaseVerdict(expired, DEFAULT_LEASE_POLICY, new Date('2026-02-05T20:00:00Z')), { kind: 'ok' })
  // 宽限期刚满：收回
  assert.deepEqual(leaseVerdict(expired, DEFAULT_LEASE_POLICY, new Date(lease.expires_at).getTime() + graceMs > 0 ? new Date('2026-02-06T10:00:00Z') : NOW), {
    kind: 'reclaim',
    overdueMs: graceMs,
  })
  // 过期已久（服务停了很久之后第二次 tick）：收回
  const late = new Date('2026-05-05T10:00:00Z')
  const verdict = leaseVerdict(expired, DEFAULT_LEASE_POLICY, late)
  assert.equal(verdict.kind, 'reclaim')
})

test('租约过期的完整两步：先 notify 落成 expired，下一次 tick 才 reclaim', () => {
  const lease = openLease(fixture('accepted'), DEV, DEFAULT_LEASE_POLICY, NOW)
  const now = new Date('2026-02-06T12:00:00Z') // 过期一天半：既过期也过了宽限期

  // 第一步：pipeline 的写法（state → expired，expiry_notices+1），任务状态不动
  const first = leaseVerdict(lease, DEFAULT_LEASE_POLICY, now)
  assert.equal(first.kind, 'notify')
  const afterNotice = { ...lease, state: 'expired', release_reason: 'expired', expiry_notices: lease.expiry_notices + 1 }

  // 第二步：同一个 tick 之后再来一次，才收回
  const second = leaseVerdict(afterNotice, DEFAULT_LEASE_POLICY, now)
  assert.equal(second.kind, 'reclaim')
  const task = fixture('in_progress')
  const reclaimed = transitionTask(task, 'timeout_lease', 'system', ctx())
  assert.ok(reclaimed.ok)
  assert.equal(reclaimed.next.state, 'assigned')
})

test('describeSpan：卡片上的人话时长', () => {
  assert.equal(describeSpan(-1), '已过期')
  assert.equal(describeSpan(30_000), '1 分钟')
  assert.equal(describeSpan(90 * 60_000), '1 小时 30 分')
  assert.equal(describeSpan(2 * 3_600_000), '2 小时')
  assert.equal(describeSpan(26 * 3_600_000), '1 天 2 小时')
  assert.equal(describeSpan(48 * 3_600_000), '2 天')
})

/* ================================================================== *
 * 需求完整性
 * ================================================================== */

test('requirementComplete：其下任务全 done/archived 才算完成，空需求不算', () => {
  const done = fixture('done')
  const archived = { ...fixture('archived'), id: 'task-2' }
  assert.equal(requirementComplete(requirement, [done, archived]), true)
  assert.equal(requirementComplete(requirement, [{ ...done, state: 'in_review' }]), false)
  assert.equal(requirementComplete(requirement, []), false, '没有任务 = 什么都没交付')
  assert.equal(
    requirementComplete(requirement, [{ ...done, req: 'req-2026-099' }]),
    false,
    '别的需求的任务不算数',
  )
})

/* ================================================================== *
 * types.js
 * ================================================================== */

test('asPrincipal：裸 id 必须被拦下；isHuman/isBot 的分工', () => {
  assert.equal(asPrincipal('system'), 'system')
  assert.equal(asPrincipal('human:chen-req'), 'human:chen-req')
  assert.equal(asPrincipal('bot:dev'), 'bot:dev')
  assert.equal(asPrincipal('role:qa'), 'role:qa')
  assert.throws(() => asPrincipal('chen-req'), /不是合法主体: chen-req/)
  assert.throws(() => asPrincipal('human:'), /不是合法主体/)

  assert.equal(isHuman('human:a'), true)
  assert.equal(isHuman('bot:a'), false)
  assert.equal(isBot('bot:a'), true)
  assert.equal(isBot('role:a'), true, 'role: 是内置机器人的别名')
  assert.equal(isBot('human:a'), false)
  assert.equal(isBot('system'), false)
  assert.equal(isHuman('system'), false)
})

test('formatDuration：整日/整时/整分才降级', () => {
  assert.equal(formatDuration(48 * 3_600_000), '2d')
  assert.equal(formatDuration(8 * 3_600_000), '8h')
  assert.equal(formatDuration(90 * 60_000), '90m')
  assert.equal(formatDuration(90_000), '90s')
  assert.equal(formatDuration(0), '0d')
})

test('改派会重算门禁确认人：机器人拒绝后交给真人，门禁必须真的有人可确认', () => {
  /*
   * 这条是一个端到端用例逼出来的真 bug：`assign` 以前只改 `not_applicable`，
   * `required_by` 保持建任务时冻结的那份 —— 而机器人执行者那份是空的
   * （机器人走租约，两道门禁都不适用）。于是"机器人拒绝 → 改派给真人"得到的
   * accept 门禁**没有确认人**，而 `required_by.every(...)` 对空数组恒真：
   * 门禁立刻算满足，任务既不用本人接受、也永远不会超时催办 —— 静默地不设防。
   */
  // 真实路径：任务先派给机器人（门禁不适用、确认人为空），机器人拒绝后回到 rejected。
  const botGates = {
    ...fixture('assigned').gates,
    accept: { required_by: [], confirmed_by: [], due_at: null, not_applicable: true, timeout_snapshot: '4h', on_timeout: 'remind_then_escalate', max_release: null },
    start: { required_by: [], confirmed_by: [], due_at: null, not_applicable: true, timeout_snapshot: '2h', on_timeout: 'auto_release', max_release: 2 },
  }
  const task = { ...fixture('rejected'), assignee: null, gates: botGates }
  const result = transitionTask(task, 'assign', REQ_OWNER, ctx({ suggestedAssignee: 'human:zhouyu' }))
  assert.ok(result.ok, JSON.stringify(result))
  const accept = result.next.gates.accept
  assert.equal(accept.not_applicable, false)
  assert.deepEqual(accept.required_by, ['human:zhouyu'], '确认人就是新的执行者本人')
  assert.equal(typeof accept.due_at, 'string', '而且真的开始计时了')
  assert.deepEqual(result.next.gates.start.required_by, ['human:zhouyu'])

  /*
   * 转派（`accepted → assigned`）走同一个 helper，而且**必须**重置门禁：
   * 它自己的效果文案写着"新执行者仍需点接受"，如果门禁留着旧执行者的确认人，
   * 新来的人点接受时面对的是别人名下的门禁 —— 文案与行为对不上。
   */
  const accepted = {
    ...result.next,
    state: 'accepted',
    gates: {
      ...result.next.gates,
      accept: { ...result.next.gates.accept, confirmed_by: [{ by: 'human:zhouyu', at: NOW.toISOString() }] },
    },
  }
  const transferred = transitionTask(accepted, 'reassign', REQ_OWNER, ctx({ suggestedAssignee: 'human:qa' }))
  assert.ok(transferred.ok, JSON.stringify(transferred))
  assert.equal(transferred.next.assignee, 'human:qa')
  assert.deepEqual(transferred.next.gates.accept.required_by, ['human:qa'], '确认人是新执行者')
  assert.deepEqual(transferred.next.gates.accept.confirmed_by, [], '旧执行者的确认记录不能算数')

  // 转派给机器人：两道门禁又该变成"不适用"（走租约）。
  const toBot = transitionTask(accepted, 'reassign', REQ_OWNER, ctx({ suggestedAssignee: 'bot:qa' }))
  assert.ok(toBot.ok, JSON.stringify(toBot))
  assert.equal(toBot.next.gates.accept.not_applicable, true)
  assert.deepEqual(toBot.next.gates.accept.required_by, [])
  assert.equal(toBot.next.gates.accept.due_at, null, '机器人不需要人工确认，也就没有到期时间')
})
