/*
 * 播报决策引擎测试（node:test + node:assert/strict，零依赖，零网络）。
 *
 * 覆盖来源：
 *   - hub/test/broadcast.test.ts —— 标题**逐个保留**，共 20 例
 *     （播报决策 5 + @人配额 2 + 任务卡 6 + 需求卡 4 + 其它卡片与工具 5）
 *   - 本次移植新增：
 *     · 播报三态 + 卡片的幂等形态（card_key → message_id 台账）
 *     · 2 秒节流合并与「关键跃迁不节流」
 *     · 同话题合并成一条卡（「3 个任务等你决策」而不是 3 条）
 *     · 按钮 value 的字段集合与有效期（hub 里没有 expires_at）
 *     · 决策引擎是唯一入口：suppress / digest 一律不产生发送目标
 *
 * 关于 hub 的 fixture：hub 的 broadcast.test.ts 用 createRequirement /
 * createTask / DomainRegistry 造对象（依赖 config 目录与 zod）。那部分已经由
 * domain.test.mjs 覆盖，这里直接用**与 schema 同形的普通对象**——
 * 卡片层只读字段，不校验对象；门禁判定走 lib/domain/objects.js 的
 * gateSatisfied / gatePending / gateProgress（与生产同一份实现）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../lib/store.js'

import {
  BroadcastChannel,
  BroadcastThrottle,
  BUTTON_TTL_MS,
  DigestAggregator,
  MentionQuota,
  THROTTLE_MS,
  buildDecisionCard,
  buildNoticeCard,
  buildReportCard,
  buildRequirementCard,
  buildTaskCard,
  buttonValue,
  cardKeyOf,
  decideBroadcast,
  decisionToTarget,
  describeLeaseSpan,
  footerOf,
  formatElapsed,
  formatTokens,
  isCritical,
  planDelivery,
  requirementStage,
  requirementStatusLine,
  shortName,
  summarizeGates,
  taskButtons,
  taskConfirmLine,
  taskStatusLine,
} from '../lib/feishu/broadcast.js'

const REQ_OWNER = 'human:chen-req'
const DEV = 'human:zhao-dev'
const NOW = new Date('2026-02-03T10:00:00Z')

let seq = 0
const ctx = { nonce: () => `n${++seq}` }
const ctxAt = (iso) => ({ nonce: () => `n${++seq}`, now: () => new Date(iso) })

/* ------------------------------------------------------------------ *
 * fixture：与 lib/domain/schema.js 的 Requirement / Task 同形
 * ------------------------------------------------------------------ */

function makeGate(requiredBy, confirmedBy = [], notApplicable = false) {
  return {
    required_by: notApplicable ? [] : requiredBy,
    confirmed_by: confirmedBy.map((by) => ({ by, at: NOW.toISOString() })),
    due_at: null,
    not_applicable: notApplicable,
    timeout_snapshot: null,
    on_timeout: null,
    max_release: null,
  }
}

/** 与 buildGates(input, {}) + initializeGates(gates, state, NOW) 同形的门禁集合 */
function makeGates(state, assignee) {
  const human = assignee === null || String(assignee).startsWith('human:')
  return {
    confirm_split: makeGate([REQ_OWNER]),
    accept: makeGate(human && assignee !== null ? [assignee] : [], [], !human),
    start: makeGate(human && assignee !== null ? [assignee] : [], [], !human),
    acceptance: makeGate([REQ_OWNER]),
  }
}

function makeReq(state = 'draft') {
  return {
    id: 'req-2026-014',
    title: '支付失败自动重试',
    state,
    type: 'feature_delivery',
    origin: { surface: 'manual', excerpts: [] },
    requester: 'human:li-product',
    owner: REQ_OWNER,
    priority: 'P1',
    body: { problem: '失败后没有重试入口', proposal: '三次指数退避' },
    acceptance_criteria: ['重试 3 次', '不重复扣款'],
    tasks: [],
    links: { repos: ['pay-service'], docs: [], mirror: null, branches: [] },
    decisions: [],
    visibility: 'team',
    history: [],
  }
}

function makeTask(state = 'assigned', assignee = DEV) {
  return {
    id: 'task-8891',
    req: 'req-2026-014',
    title: '实现重试与退避',
    state,
    type: 'feature_delivery',
    domains: ['backend'],
    assignee,
    collaborators: [],
    owner: assignee,
    acceptance_criteria: ['退避序列可配置'],
    gates: makeGates(state, assignee),
    repo: null,
    branch: null,
    mr: null,
    evidence: [],
    release_count: 0,
    blocked_reason: null,
    history: [],
  }
}

const leaseOf = (lease) => () => lease
const aLease = (over = {}) => ({
  task: 'task-8891',
  holder: DEV,
  kind: 'human',
  started_at: '2026-02-03T10:00:00Z',
  expires_at: '2026-02-04T10:00:00Z',
  renewals: 0,
  state: 'active',
  release_reason: null,
  expiry_notices: 0,
  ...over,
})

/* ------------------------------------------------------------------ *
 * footer note：耗时 / token / 步数（设计 04 §3.1）
 * ------------------------------------------------------------------ */

test('footer：没跑过的任务只有台账信息，跑过之后才多出耗时/步数/token', () => {
  const task = makeTask()
  assert.equal(footerOf(task), 'backend')
  // 有释放次数与分支时它们照样在，而且顺序稳定。
  assert.equal(footerOf({ ...task, release_count: 2, branch: 'feat/retry' }), 'backend · 已释放 2 次 · 分支 feat/retry')
  assert.equal(footerOf(task, null), 'backend', 'null 与 undefined 都不能变成 "null" 字样')

  const measured = footerOf(task, {
    elapsed_ms: 134_000,
    steps: 7,
    tokens: { value: 12_345, source: 'usage' },
  })
  assert.equal(measured, 'backend · ⏱ 2m14s · 🧠 12.3k tok · 🔄 7 步')
})

test('footer 带上 CI 状态：等待中显示等了多久，没有 CI 记录就整段不出现', () => {
  const task = makeTask()
  assert.equal(footerOf({ ...task, ci: { state: 'passed' } }), 'backend · 🧪 CI 通过')
  assert.equal(footerOf({ ...task, ci: { state: 'failed', summary: 'lint' } }), 'backend · 🧪 CI 失败')
  // 等待中：把开始时间放在 2 分钟前，footer 里要能看到"等了多久"。
  const started = new Date(Date.now() - 125_000).toISOString()
  assert.match(footerOf({ ...task, ci: { state: 'running', started_at: started } }), /^backend · 🧪 CI 等待中 2m\d\ds$/)
  // 没有 started_at 也不要编一个时长出来。
  assert.equal(footerOf({ ...task, ci: { state: 'running' } }), 'backend · 🧪 CI 等待中')
  assert.equal(footerOf({ ...task, ci: { state: 'unknown' } }), 'backend', '不认识的 CI 状态不硬翻译')
})

test('footer 不谎报 0：provider 没上报的字段整段不显示', () => {
  const task = makeTask()
  // 只有耗时：token 与步数都不出现（而不是 🧠 0 tok / 🔄 0 步）。
  assert.equal(footerOf(task, { elapsed_ms: 900 }), 'backend · ⏱ 900ms')
  // 估出来的用量带 ≈，与 provider 实报的数字区分开。
  assert.equal(footerOf(task, { elapsed_ms: 1000, tokens: { value: 940, source: 'estimated' } }), 'backend · ⏱ 1s · 🧠 ≈940 tok')
  // 超时是"它还在等"的信号，不能省。
  assert.equal(footerOf(task, { elapsed_ms: 60_000, timed_out: true }), 'backend · ⏱ 1m00s（超时）')
  // 结构不对的实测数据也不能把 footer 弄成乱码。
  assert.equal(footerOf(task, { elapsed_ms: 'abc', steps: -3, tokens: { value: -1 } }), 'backend')
  // 但"量到 0"要显示：与 `elapsed=0` 同一个语义（量不到才不显示）。
  assert.equal(footerOf(task, { elapsed_ms: 0, tokens: { value: 0, source: 'usage' } }), 'backend · ⏱ 0ms · 🧠 0 tok')
  assert.equal(footerOf(task, 'nonsense'), 'backend')
})

test('formatElapsed / formatTokens：短、可读、单位不丢', () => {
  assert.equal(formatElapsed(0), '0ms')
  assert.equal(formatElapsed(999), '999ms')
  assert.equal(formatElapsed(1000), '1s')
  assert.equal(formatElapsed(59_400), '59s')
  assert.equal(formatElapsed(60_000), '1m00s')
  assert.equal(formatElapsed(3_600_000), '1h00m')
  assert.equal(formatTokens(940), '940')
  assert.equal(formatTokens(12_345), '12.3k')
  assert.equal(formatTokens(2_000_000), '2M')
})

/* ------------------------------------------------------------------ *
 * 播报决策
 * ------------------------------------------------------------------ */

test('门禁需要人确认 → 立即播报并 @ 到具体人', () => {
  const d = decideBroadcast({
    kind: 'task',
    chat_id: 'oc_x',
    pending_gates: [{ name: 'accept', pending: [DEV] }],
  })
  assert.equal(d.mode, 'immediate')
  assert.equal(d.reason, 'gate_needs_human')
  assert.deepEqual(d.mention, [DEV])
})

test('人主动触发（被 @ 或点按钮）→ 立即播报', () => {
  const d = decideBroadcast({ kind: 'task', chat_id: 'oc_x', human_initiated: true })
  assert.equal(d.mode, 'immediate')
  assert.equal(d.reason, 'mention')
})

test('纯进度 → 进摘要，不进群（这是防刷屏的关键一条）', () => {
  const d = decideBroadcast({ kind: 'task', chat_id: 'oc_x', progress: true })
  assert.equal(d.mode, 'digest')
  assert.equal(d.digest_bucket, 'task')
  assert.equal(d.mention.length, 0)
})

test('重复事件 → 抑制，只记日志', () => {
  const d = decideBroadcast({ kind: 'task', duplicate: true })
  assert.equal(d.mode, 'suppress')
  assert.equal(d.reason, 'duplicate')
})

test('状态跃迁（无待办门禁）→ 立即播报但不 @ 人', () => {
  const d = decideBroadcast({ kind: 'task', chat_id: 'oc_x' })
  assert.equal(d.mode, 'immediate')
  assert.equal(d.reason, 'state_transition')
  assert.deepEqual(d.mention, [])
})

test('三态互斥且优先级固定：重复 > 门禁 > 人触发 > 进度 > 状态跃迁', () => {
  // 重复优先于一切
  assert.equal(
    decideBroadcast({ kind: 'task', duplicate: true, human_initiated: true, pending_gates: [{ name: 'a', pending: [DEV] }] })
      .mode,
    'suppress',
  )
  // 门禁优先于人触发
  assert.equal(
    decideBroadcast({ kind: 'task', human_initiated: true, pending_gates: [{ name: 'a', pending: [DEV] }] }).reason,
    'gate_needs_human',
  )
  // 只有 progress 是 digest，其余都是 immediate
  assert.equal(decideBroadcast({ kind: 'requirement', progress: true }).digest_bucket, 'requirement')
  assert.equal(decideBroadcast({ kind: 'callout', progress: true }).digest_bucket, 'callout')
})

/* ------------------------------------------------------------------ *
 * @人配额
 * ------------------------------------------------------------------ */

test('@同一个人每天有次数上限，超了改成静默待办', () => {
  const quota = new MentionQuota(2)
  const day = '2026-02-03'
  assert.equal(quota.tryConsume('coord', DEV, day), true)
  assert.equal(quota.tryConsume('coord', DEV, day), true)
  assert.equal(quota.tryConsume('coord', DEV, day), false, '第三次应被拒')
  assert.equal(quota.used('coord', DEV, day), 2)

  // 换一天恢复；换一个人也各自计数
  assert.equal(quota.tryConsume('coord', DEV, '2026-02-04'), true)
  assert.equal(quota.tryConsume('coord', REQ_OWNER, day), true)
})

test('超限后转静默：仍立即播报，但不再 @ 人（否则就是骚扰）', () => {
  const d = decideBroadcast({ kind: 'task', chat_id: 'oc_x', pending_gates: [{ name: 'accept', pending: [DEV] }] })
  const silent = MentionQuota.asSilent(d)
  assert.equal(silent.mode, 'immediate')
  assert.equal(silent.reason, 'quota_exceeded')
  assert.deepEqual(silent.mention, [])
  assert.ok(silent.note.includes('配额'))
})

test('配额按 (天, 机器人, 人) 三元组隔离：换机器人不共享额度', () => {
  const quota = new MentionQuota(1)
  assert.equal(quota.tryConsume('bot-a', DEV, '2026-02-03'), true)
  assert.equal(quota.tryConsume('bot-b', DEV, '2026-02-03'), true, '另一个机器人有自己的额度')
  assert.equal(quota.tryConsume('bot-a', DEV, '2026-02-03'), false)
  assert.equal(quota.limit, 1)
})

test('配额计数落盘：重启之后还算数，被静默的次数也留下来（R13.5）', () => {
  /*
   * 这条以前是内存 Map：进程一重启就当今天没 @ 过人 —— 于是"开发机上重启三次"
   * 就等于配额 ×3。而它防的正是"一个下午被 @ 二十次"。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-quota-'))
  try {
    const store = new Store(dir).load()
    const day = '2026-02-03'
    const first = new MentionQuota(2, { store, today: day })
    assert.equal(first.tryConsume('coord', DEV, day), true)
    assert.equal(first.tryConsume('coord', DEV, day), true)
    assert.equal(first.tryConsume('coord', DEV, day), false, '超限')
    assert.equal(first.silenced('coord', DEV, day), 1, '被静默的次数要记下来')

    // 换一个实例（= 重启），额度与静默次数都还在
    const second = new MentionQuota(2, { store, today: day })
    assert.equal(second.used('coord', DEV, day), 2, '重启之后今天已经用掉的额度不能清零')
    assert.equal(second.silenced('coord', DEV, day), 1)
    assert.equal(second.tryConsume('coord', DEV, day), false, '重启不会白送一次 @')

    // 记录长什么样（面板与观测读的就是它）
    const rows = store.all('quota')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].day, day)
    assert.equal(rows[0].bot, 'coord')
    assert.equal(rows[0].who, DEV)
    assert.equal(rows[0].used, 2)

    // 老记录会被清掉（配额只关心今天，留一周是为了"昨天是不是也超了"）
    store.put('quota', { id: 'old', day: '2026-01-01', bot: 'coord', who: DEV, used: 9, silenced: 0 })
    assert.deepEqual(second.prune(day), ['old'])
    assert.equal(store.get('quota', 'old'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不该 @ 人的决策转静默是空操作（不能把状态跃迁也改掉）', () => {
  const plain = decideBroadcast({ kind: 'task', chat_id: 'oc_x' })
  assert.deepEqual(MentionQuota.asSilent(plain), plain)
  const digest = decideBroadcast({ kind: 'task', progress: true })
  assert.deepEqual(MentionQuota.asSilent(digest), digest)
})

/* ------------------------------------------------------------------ *
 * 任务卡
 * ------------------------------------------------------------------ */

test('任务卡的按钮随状态变化：待接受是接受/拒绝，执行中是续约/阻塞/提交', () => {
  const assigned = taskButtons(makeTask('assigned'), ctx).map((b) => b.action)
  assert.deepEqual(assigned, ['task.accept', 'task.reject'])

  const running = taskButtons(makeTask('in_progress'), ctx).map((b) => b.action)
  assert.deepEqual(running, ['task.renew', 'task.block', 'task.submit'])

  const accepted = taskButtons(makeTask('accepted'), ctx).map((b) => b.action)
  assert.deepEqual(accepted, ['task.start', 'task.renew', 'task.unassign'])

  const reviewing = taskButtons(makeTask('in_review'), ctx).map((b) => b.action)
  assert.ok(reviewing.includes('task.verify'))
  assert.ok(!reviewing.includes('task.accept'), '待验收时不该还显示接受')
})

test('按钮 value 带 action 与 nonce（防重放），expect 只作提示', () => {
  const buttons = taskButtons(makeTask('assigned'), ctx)
  const accept = buttons[0]
  assert.equal(accept?.value.action, 'task.accept')
  assert.equal(accept?.value.object, 'task')
  assert.equal(accept?.value.id, 'task-8891')
  assert.ok(typeof accept?.value.nonce === 'string' && accept.value.nonce.length > 0)
  assert.equal(accept?.value.expect, DEV)
})

test('按钮 value 的字段集合是 action/object/id/actor/expect/nonce/expires_at', () => {
  const buttons = taskButtons(makeTask('assigned'), ctx)
  for (const button of buttons) {
    assert.deepEqual(
      Object.keys(button.value).sort(),
      ['action', 'actor', 'expect', 'expires_at', 'id', 'nonce', 'object'],
      `${button.action} 的 value 字段集不对`,
    )
    assert.equal(button.value.actor, DEV, 'actor 是 expect 的别名（缺省同值）')
  }
})

test('按钮有效期由 ctx.now() 决定，且可被 ctx.expiresAt 覆盖', () => {
  const fixed = taskButtons(makeTask('assigned'), ctxAt('2026-02-03T10:00:00Z'))
  const expected = new Date(Date.parse('2026-02-03T10:00:00Z') + BUTTON_TTL_MS).toISOString()
  assert.equal(fixed[0]?.value.expires_at, expected)

  const custom = taskButtons(makeTask('assigned'), {
    nonce: () => 'n-x',
    expiresAt: () => '2026-03-01T10:00:00.000Z',
  })
  assert.equal(custom[0]?.value.expires_at, '2026-03-01T10:00:00.000Z')
})

test('每次构造按钮都换一个 nonce（同一张卡重复渲染也不能复用）', () => {
  const task = makeTask('assigned')
  const first = taskButtons(task, ctx).map((b) => b.value.nonce)
  const second = taskButtons(task, ctx).map((b) => b.value.nonce)
  assert.equal(new Set([...first, ...second]).size, first.length + second.length)
})

test('actorOf 可以给出真实 open_id，但 value 里仍然带 expect（文案要显示人话）', () => {
  const buttons = taskButtons(makeTask('assigned'), {
    nonce: () => 'n-1',
    actorOf: () => 'ou_zhao_dev',
  })
  assert.equal(buttons[0]?.value.actor, 'ou_zhao_dev')
  assert.equal(buttons[0]?.value.expect, DEV, 'expect 是 Principal，供文案与日志用')
})

test('任务卡：状态行能一眼看出状态与负责人', () => {
  assert.ok(taskStatusLine(makeTask('assigned')).includes('待接受'))
  assert.ok(taskStatusLine(makeTask('assigned')).includes('@zhao-dev'))
  assert.ok(taskStatusLine(makeTask('in_progress')).includes('进行中'))
  assert.ok(taskStatusLine(makeTask('done')).includes('已完成'))
})

test('确认行显示各方进度与待确认人（跨域任务的关键信息）', () => {
  const line = taskConfirmLine(makeTask('assigned'))
  assert.ok(line?.includes('⏳ 待接受确认'), line ?? '')
  assert.ok(line?.includes('@zhao-dev'), '要写明等谁')
  assert.ok(line?.includes('待验收'))
})

test('门禁等待时长：慢和死要能分开（R7.7）', () => {
  const base = makeTask('assigned')
  const task = {
    ...base,
    history: [{ from: 'confirmed', to: 'assigned', by: REQ_OWNER, at: new Date(Date.now() - 3 * 3600_000).toISOString(), effects: [] }],
  }
  const line = taskConfirmLine(task, { now: new Date() })
  assert.ok(line?.includes('已等 3 小时'), line ?? '')

  /*
   * 没有历史（旧数据、或还没跃迁过）时**不编一个时长出来** —— 与 footer 里
   * "provider 不上报就不写 0"是同一条规矩：看不出快慢，好过看错快慢。
   */
  assert.ok(!String(taskConfirmLine(base) ?? '').includes('已等'), '没有起点就不写"已等"')
})

test('代确认要在卡上写明"代"：那个域没人时顶上的人不是域负责人（R5.6）', () => {
  /*
   * 域里一个人都没有时，验收门禁会把配置里的 `domainFallbacks[域]` 拉进来顶替。
   * 卡上不写那个"代"字，`@backup` 看上去就是那个域的负责人 ——
   * 而"谁替谁签的字"正是出事后第一个要回答的问题。
   */
  const withStandIn = makeGate([REQ_OWNER, 'human:backup'])
  withStandIn.stand_ins = ['human:backup']
  const task = { ...makeTask('assigned'), owner: REQ_OWNER, gates: { ...makeGates('assigned', 'human:zhao-dev'), acceptance: withStandIn } }
  const line = taskConfirmLine(task)
  assert.ok(line?.includes('@backup 代确认'), line ?? '')

  // 代确认者点过头之后，已确认那一行也要写出"代"
  const satisfied = {
    ...task,
    gates: {
      ...task.gates,
      acceptance: { ...withStandIn, confirmed_by: [{ by: REQ_OWNER, at: NOW.toISOString() }, { by: 'human:backup', at: NOW.toISOString() }] },
    },
  }
  assert.ok(taskConfirmLine(satisfied)?.includes('@backup 代'), taskConfirmLine(satisfied) ?? '')

  // 机器人承接（not_applicable）的门禁没有替身，不该冒出"代"字
  const botTask = { ...makeTask('assigned', 'bot:dev'), owner: REQ_OWNER, gates: makeGates('assigned', 'bot:dev') }
  assert.ok(!String(taskConfirmLine(botTask) ?? '').includes('代确认'), '机器人承接的门禁不写代确认')
})

test('有证据时任务卡列出证据，没有时不显示空段', () => {
  const withEvidence = { ...makeTask('in_review'), evidence: [{ kind: 'test', ref: 'pytest://x' }] }
  const card = buildTaskCard(withEvidence, ctx)
  const text = JSON.stringify(card.blocks)
  assert.ok(text.includes('pytest://x'))

  const without = buildTaskCard(makeTask('assigned'), ctx)
  assert.ok(!JSON.stringify(without.blocks).includes('证据'))
})

test('阻塞的任务卡把原因显示出来（别让人猜为什么卡住）', () => {
  const blocked = { ...makeTask('blocked'), blocked_reason: '等第三方接口联调' }
  const card = buildTaskCard(blocked, ctx)
  assert.ok(JSON.stringify(card.blocks).includes('等第三方接口联调'))
})

test('任务卡的锚点是「任务 id · 需求 id」，卡键是 task:<id>（幂等形态）', () => {
  const card = buildTaskCard(makeTask('assigned'), ctx)
  assert.equal(card.anchor, 'task-8891 · req-2026-014')
  assert.equal(cardKeyOf('task', 'task-8891'), 'task:task-8891')
})

/* ------------------------------------------------------------------ *
 * 需求卡
 * ------------------------------------------------------------------ */

test('需求卡：draft 显示"确认需求 + 废弃"，confirmed 显示"确认拆解 + 废弃"', () => {
  const draft = buildRequirementCard(makeReq('draft'), [], ctx)
  const draftButtons = draft.blocks.flatMap((b) => (b.kind === 'buttons' ? b.buttons.map((x) => x.action) : []))
  // 「废弃」是误判的出口：@ 了机器人但说的不是需求时，负责人要能一键丢掉
  assert.deepEqual(draftButtons, ['req.confirm', 'req.drop'])

  const confirmed = buildRequirementCard(makeReq('confirmed'), [], ctx)
  const confirmedButtons = confirmed.blocks.flatMap((b) =>
    b.kind === 'buttons' ? b.buttons.map((x) => x.action) : [],
  )
  assert.deepEqual(confirmedButtons, ['req.confirm_split', 'req.drop'])
})

test('需求卡要能看出卡在哪一步（这是设计文档 02 §3 的硬要求）', () => {
  const req = makeReq('dispatched')
  const tasks = [
    { ...makeTask('assigned'), id: 'task-1' },
    { ...makeTask('accepted'), id: 'task-2' },
  ]
  const stage = requirementStage(req, tasks)
  assert.ok(stage.includes('等待接受') || stage.includes('已接受未开始'), stage)
})

test('需求阶段：待确认拆解 / 等接受 / 等开始 三种中间态都能说出来', () => {
  const req = makeReq('dispatched')
  assert.ok(requirementStage(req, [{ ...makeTask('proposed'), id: 't1' }]).includes('待确认拆解'))
  assert.ok(requirementStage(req, [{ ...makeTask('assigned'), id: 't1' }]).includes('等待接受'))
  assert.ok(requirementStage(req, [{ ...makeTask('accepted'), id: 't1' }]).includes('已接受未开始'))
  assert.ok(requirementStage(req, [{ ...makeTask('in_progress'), id: 't1' }]).includes('执行中'))
  assert.equal(requirementStage(makeReq('done'), []), '🟢 全部任务已完成')
})

test('需求卡带任务表时用原生表格组件（飞书能渲染）', () => {
  const req = makeReq('dispatched')
  const card = buildRequirementCard(req, [makeTask('assigned')], ctx)
  const table = card.blocks.find((b) => b.kind === 'table')
  assert.ok(table !== undefined, '应有任务表格')
  if (table?.kind === 'table') {
    assert.deepEqual(table.table.headers, ['任务', '状态', '负责人'])
  }
})

test('需求卡只汇总自己的任务，别的需求的任务不进表', () => {
  const other = { ...makeTask('assigned'), id: 'task-2', req: 'req-2026-099', title: '另一个需求的任务' }
  const card = buildRequirementCard(makeReq('dispatched'), [makeTask('assigned'), other], ctx)
  const table = card.blocks.find((b) => b.kind === 'table')
  assert.equal(table.table.rows.length, 1)
  assert.ok(!JSON.stringify(card.blocks).includes('另一个需求的任务'))
})

/* ------------------------------------------------------------------ *
 * 其它卡片与工具
 * ------------------------------------------------------------------ */

test('决策卡必须带影响面——不能是只有同意/拒绝的黑盒', () => {
  const card = buildDecisionCard({
    title: '配置改动',
    body: '把 accept 超时从 4h 改成 2h',
    detail: '影响 7 个进行中的任务',
    options: [{ label: '批准', action: 'cfg.approve', value: {} }],
  })
  assert.ok(JSON.stringify(card.blocks).includes('影响 7 个进行中的任务'))
})

test('报告卡是一次性的，不带确认行', () => {
  const card = buildReportCard({ title: '每日对账', lines: ['- 3 个任务待接受'] })
  assert.equal(card.confirm_line, undefined)
  assert.equal(card.headerTemplate, 'grey')
})

test('通知卡也是一次性的：有状态行与 note，但没有确认行', () => {
  const card = buildNoticeCard({
    title: '⏰ 催办',
    status: '🔴 3 个任务已超时',
    lines: ['- task-8891 等待接受 3 小时'],
    note: '这条只提醒一次',
  })
  assert.equal(card.confirm_line, undefined)
  assert.equal(card.headerTemplate, 'grey')
  assert.ok(JSON.stringify(card.blocks).includes('3 个任务已超时'))
  assert.ok(JSON.stringify(card.blocks).includes('这条只提醒一次'))
  assert.equal(card.blocks.at(-1).kind, 'note')
})

test('卡片键遵循 kind:id，同一对象的更新落在同一张卡上', () => {
  assert.equal(cardKeyOf('task', 'task-8891'), 'task:task-8891')
  assert.equal(cardKeyOf('requirement', 'req-2026-014'), 'req:req-2026-014')
  assert.equal(cardKeyOf('decision', 'adr-2026-001'), 'decision:adr-2026-001')
})

test('主体显示名：human:chen-req → @chen-req，system → 系统', () => {
  assert.equal(shortName('human:chen-req'), '@chen-req')
  assert.equal(shortName('bot:dev'), '@dev')
  assert.equal(shortName('system'), '系统')
})

test('门禁摘要跳过机器人门禁（它们不需要人确认）', () => {
  const botTask = makeTask('in_progress', 'bot:dev')
  const summary = summarizeGates(botTask)
  assert.ok(!summary.some((g) => g.name === 'accept'), '机器人的 accept 门禁不该出现在待办里')
  assert.ok(summary.some((g) => g.name === 'acceptance'), '验收门禁仍然在')
})

test('任务卡显示租约剩余时间（看不见期限的承诺等于没有期限）', () => {
  const task = makeTask('in_progress')
  const lease = aLease({ renewals: 1 })
  const card = buildTaskCard(task, {
    nonce: () => 'n1',
    leaseOf: leaseOf(lease),
    now: () => new Date('2026-02-03T22:00:00Z'),
  })
  const text = JSON.stringify(card.blocks)
  assert.ok(text.includes('租约剩余 12 小时'), text)
  assert.ok(text.includes('已续约 1 次'))
  assert.ok(text.includes('@zhao-dev'))
})

test('租约过期时卡片改为醒目提示（而不是继续显示"剩余"）', () => {
  const task = makeTask('in_progress')
  const card = buildTaskCard(task, {
    nonce: () => 'n1',
    leaseOf: leaseOf(aLease({ expires_at: '2026-02-03T10:00:00Z', state: 'expired' })),
    now: () => new Date('2026-02-03T22:00:00Z'),
  })
  const text = JSON.stringify(card.blocks)
  assert.ok(text.includes('租约已过期'), text)
  assert.ok(text.includes('12 小时'), '要说过期多久了')
})

test('没有租约时不显示租约段（不占卡片空间）', () => {
  const task = makeTask('assigned')
  const card = buildTaskCard(task, { nonce: () => 'n1', leaseOf: () => null })
  assert.ok(!JSON.stringify(card.blocks).includes('租约'))
})

test('租约时长描述覆盖天/小时/分钟三档', () => {
  assert.equal(describeLeaseSpan(2 * 86_400_000), '2 天')
  assert.equal(describeLeaseSpan(3 * 3_600_000 + 30 * 60_000), '3 小时 30 分钟')
  assert.equal(describeLeaseSpan(90_000), '1 分钟', '不到一分钟也要说 1 分钟，不能说 0')
})

/* ------------------------------------------------------------------ *
 * 节流与合并（设计文档 §2.3）
 * ------------------------------------------------------------------ */

test('2 秒内的同一张卡只更新一次，不产生新消息', () => {
  const throttle = new BroadcastThrottle()
  const decision = { mode: 'immediate', reason: 'progress', card_key: 'task:task-8891' }
  assert.equal(throttle.admit(decision, 1000), true, '第一次放行')
  assert.equal(throttle.admit(decision, 1500), false, '1.5 秒内合并')
  assert.equal(throttle.admit(decision, 2999), false, '还在窗口里')
  assert.equal(throttle.admit(decision, 3000), true, '窗口结束，可以再更新一次')
  assert.equal(throttle.windowMs, THROTTLE_MS)
  assert.equal(THROTTLE_MS, 2_000)
})

test('关键状态跃迁不节流（人必须看到的那几条不能被合并掉）', () => {
  const throttle = new BroadcastThrottle()
  const progress = { mode: 'immediate', reason: 'progress', card_key: 'task:task-8891' }
  const transition = { mode: 'immediate', reason: 'state_transition', card_key: 'task:task-8891' }
  const gate = { mode: 'immediate', reason: 'gate_needs_human', card_key: 'task:task-8891' }

  assert.equal(throttle.admit(progress, 1000), true, '第一次放行')
  assert.equal(throttle.admit(progress, 1100), false, '窗口内合并')
  assert.equal(throttle.admit(transition, 1200), true, '状态跃迁直接放行')
  assert.equal(throttle.admit(gate, 1300), true, '门禁催办也直接放行')
  assert.equal(throttle.admit(progress, 1400), false, '关键跃迁只重置窗口，普通更新照旧被合并')
  assert.equal(isCritical(transition), true)
  assert.equal(isCritical(progress), false)
})

test('不同卡片各自节流，互不影响', () => {
  const throttle = new BroadcastThrottle()
  assert.equal(throttle.admit({ mode: 'immediate', reason: 'progress', card_key: 'task:a' }, 0), true)
  assert.equal(throttle.admit({ mode: 'immediate', reason: 'progress', card_key: 'task:b' }, 0), true)
  assert.equal(throttle.admit({ mode: 'immediate', reason: 'progress', card_key: 'task:a' }, 100), false)
  assert.deepEqual(throttle.pending(100).sort(), ['task:a', 'task:b'])
  assert.equal(throttle.dueIn('task:a', 100), 1_900)
  throttle.forget('task:a')
  assert.equal(throttle.dueIn('task:a', 100), 0)
})

test('非 immediate 的决策不参与节流（suppress/digest 本来就不过群）', () => {
  const throttle = new BroadcastThrottle()
  assert.equal(throttle.admit({ mode: 'digest', reason: 'progress', card_key: 'task:a' }, 0), false)
  assert.equal(throttle.admit({ mode: 'suppress', reason: 'duplicate', card_key: 'task:a' }, 0), false)
  assert.deepEqual(throttle.pending(0), [])
})

test('同一话题的多次播报合并成一条卡（「3 个任务等你决策」而不是 3 条）', () => {
  const aggregator = new DigestAggregator()
  const d = (note, topic) => ({ mode: 'digest', digest_bucket: 'task', note, topic })
  assert.equal(aggregator.add(d('task-1 进入执行中')), 'task')
  assert.equal(aggregator.add(d('task-2 提交验收')), 'task')
  assert.equal(aggregator.add(d('req-2026-014 拆解完成', 'req-2026-014')), 'req-2026-014')
  assert.deepEqual(aggregator.buckets.sort(), ['req-2026-014', 'task'])

  const merged = aggregator.merge('task')
  assert.equal(merged.merged, 2, '两条合并成一条')
  assert.equal(merged.lines.length, 2)
  assert.ok(merged.title.includes('2 条合并'), merged.title)
  assert.equal(aggregator.merge('task'), null, '取走后就空了')

  // 单条时标题不写「1 条合并」
  assert.ok(aggregator.merge('req-2026-014').title.includes('摘要'))
  assert.deepEqual(aggregator.drain(), [])
})

test('immediate / suppress 不进摘要桶（它们不是摘要的料）', () => {
  const aggregator = new DigestAggregator()
  assert.equal(aggregator.add({ mode: 'immediate', digest_bucket: null, note: 'x' }), null)
  assert.equal(aggregator.add({ mode: 'suppress', digest_bucket: null, note: 'x' }), null)
  assert.deepEqual(aggregator.buckets, [])
})

/* ------------------------------------------------------------------ *
 * 幂等落地：card_key → message_id
 * ------------------------------------------------------------------ */

test('同一个 card_key 只有一张卡：第一次 create，之后都是原地 update', () => {
  const channel = new BroadcastChannel()
  assert.deepEqual(channel.opFor('task:task-8891'), {
    card_key: 'task:task-8891',
    op: 'create',
    message_id: null,
    throttled: false,
  })
  channel.bind('task:task-8891', 'om_1')
  const second = channel.opFor('task:task-8891')
  assert.equal(second.op, 'update')
  assert.equal(second.message_id, 'om_1')
  assert.equal(channel.messageIdOf('task:task-8891'), 'om_1')
})

test('卡没了就重发一条新的（而不是永远 update 一张不存在的消息）', () => {
  const channel = new BroadcastChannel()
  channel.bind('task:task-8891', 'om_1')
  channel.markGone('task:task-8891')
  assert.equal(channel.opFor('task:task-8891').op, 'resent')
  channel.bind('task:task-8891', 'om_2')
  assert.equal(channel.opFor('task:task-8891').op, 'update')
  assert.equal(channel.messageIdOf('task:task-8891'), 'om_2')
})

test('没有 card_key 的通知卡每次都是一条新消息', () => {
  const channel = new BroadcastChannel()
  assert.deepEqual(channel.opFor(null), { card_key: null, op: 'create', message_id: null, throttled: false })
  channel.bind(null, 'om_1')
  assert.equal(channel.messageIdOf(null), null, '没有键的东西不该被记住')
})

/* ------------------------------------------------------------------ *
 * 决策引擎是唯一入口
 * ------------------------------------------------------------------ */

test('suppress / digest 一律不产生发送目标（播报必须过决策引擎）', () => {
  const duplicate = decideBroadcast({ kind: 'task', chat_id: 'oc_x', duplicate: true })
  assert.equal(decisionToTarget(duplicate), null)
  const progress = decideBroadcast({ kind: 'task', chat_id: 'oc_x', progress: true })
  assert.equal(decisionToTarget(progress), null)
})

test('没有 chat_id 的 immediate 决策也不发（宁可静默，不发错群）', () => {
  const d = decideBroadcast({ kind: 'task' })
  assert.equal(d.mode, 'immediate')
  assert.equal(decisionToTarget(d), null)
})

test('目标对象决定 card_key：同一个任务反复播报都落在同一张卡上', () => {
  const d = decideBroadcast({ kind: 'task', chat_id: 'oc_x' })
  const target = decisionToTarget(d, { kind: 'task', id: 'task-8891' })
  assert.equal(target.card_key, 'task:task-8891')
  assert.equal(target.chat_id, 'oc_x')
  assert.equal(target.reason, 'state_transition')

  const req = decisionToTarget(d, { kind: 'requirement', id: 'req-2026-014' })
  assert.equal(req.card_key, 'req:req-2026-014')

  // 决策自己带了 card_key 时以决策为准
  const explicit = decisionToTarget({ ...d, card_key: 'task:task-1' }, { kind: 'task', id: 'task-8891' })
  assert.equal(explicit.card_key, 'task:task-1')
})

test('planDelivery：suppress 跳过、digest 跳过、节流合并、首次 create、二次 update', () => {
  const throttle = new BroadcastThrottle()
  const channel = new BroadcastChannel()
  const target = { kind: 'task', id: 'task-8891' }

  const suppressed = planDelivery(
    decideBroadcast({ kind: 'task', chat_id: 'oc_x', duplicate: true }),
    throttle,
    channel,
    0,
    target,
  )
  assert.equal(suppressed.action, 'skip')

  const digested = planDelivery(
    decideBroadcast({ kind: 'task', chat_id: 'oc_x', progress: true }),
    throttle,
    channel,
    0,
    target,
  )
  assert.equal(digested.action, 'skip')

  const first = planDelivery(decideBroadcast({ kind: 'task', chat_id: 'oc_x' }), throttle, channel, 0, target)
  assert.equal(first.action, 'create')
  channel.bind(first.card_key, 'om_1')

  // 「被人 @」虽然是 immediate，但在窗口内仍然合并（节流只管状态跃迁之外的那些）
  const throttled = planDelivery(
    decideBroadcast({ kind: 'task', chat_id: 'oc_x', human_initiated: true }),
    throttle,
    channel,
    500,
    target,
  )
  assert.equal(throttled.action, 'throttled')
  assert.equal(throttled.card_key, 'task:task-8891')

  const second = planDelivery(decideBroadcast({ kind: 'task', chat_id: 'oc_x' }), throttle, channel, 500, target)
  assert.equal(second.action, 'update', '状态跃迁不节流，直接原地更新')
  assert.equal(second.message_id, 'om_1')
  assert.equal(second.card_key, 'task:task-8891')
})

/* ------------------------------------------------------------------ *
 * buttonValue：身份只作提示
 * ------------------------------------------------------------------ */

test('buttonValue 是按钮 value 的唯一构造点：字段齐全且顺序稳定', () => {
  const value = buttonValue('task.accept', 'task', 'task-8891', DEV, ctxAt('2026-02-03T10:00:00Z'))
  assert.deepEqual(Object.keys(value), ['action', 'object', 'id', 'expect', 'actor', 'nonce', 'expires_at'])
  assert.equal(value.action, 'task.accept')
  assert.equal(value.object, 'task')
  assert.equal(value.id, 'task-8891')
  assert.equal(value.actor, DEV, '没有 actorOf 时退化为 Principal')
  assert.equal(value.expires_at, new Date(Date.parse('2026-02-03T10:00:00Z') + BUTTON_TTL_MS).toISOString())
})

test('没有期望操作者时不写 actor/expect（不伪造身份）', () => {
  const value = buttonValue('req.drop', 'requirement', 'req-2026-014', undefined, ctx)
  assert.deepEqual(Object.keys(value), ['action', 'object', 'id', 'nonce', 'expires_at'])
  assert.equal('actor' in value, false)
  assert.equal('expect' in value, false)
})

test('需求责任人看得到需求卡的按钮（责任人不是操作者，只是文案）', () => {
  const card = buildRequirementCard(makeReq('draft'), [], ctx)
  const buttons = card.blocks.flatMap((b) => (b.kind === 'buttons' ? b.buttons : []))
  assert.equal(buttons[0]?.value.expect, REQ_OWNER)
  assert.equal(buttons[0]?.value.object, 'requirement')
  assert.equal(buttons[0]?.value.id, 'req-2026-014')
})

test('状态行与需求状态行的文案覆盖三档色块', () => {
  assert.ok(requirementStatusLine(makeReq('draft')).includes('待澄清'))
  assert.ok(requirementStatusLine(makeReq('done')).includes('已完成'))
  assert.ok(taskStatusLine(makeTask('blocked')).includes('阻塞'))
})

test('未指派的任务显示「未指派」而不是 @null', () => {
  const card = buildTaskCard(makeTask('proposed', null), ctx)
  assert.ok(card.status.includes('未指派'), card.status)
  assert.ok(!card.status.includes('@null'))
})
