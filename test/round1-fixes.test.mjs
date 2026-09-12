/*
 * 第一轮审查（`docs/REVIEW-01.md`）里每一条 P0 的回归用例。
 *
 * 为什么单独一个文件：这些缺陷的共性是**"测试全绿、功能是坏的"** ——
 * 494 个用例里没有一条走过"任务全部验收 → 需求自动完成"，于是一个
 * `withHistory is not defined` 在运行期活了好几天。所以这里的每一条都
 * 从**真实入口**走一遍，而不是只测那个纯函数。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { DEFAULT_COMMANDS, parseCommand } from '../lib/feishu/ingest.js'
import { degradationLadder } from '../lib/feishu/cards.js'
import { availableActions, transitionRequirement, transitionTask } from '../lib/domain/index.js'
import { Store } from '../lib/store.js'
import { createHandlers } from '../lib/tools.js'

function makeWorld(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-round1-'))
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    bots: [{ id: 'dev', role: 'dev', enabled: true }],
    defaultOwner: 'human:pm',
    members: { requirement: ['human:pm'], development: ['human:pm'] },
    feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    ...overrides,
  })
  const store = new Store(dir).load()
  const notices = []
  const notify = {
    task: async () => ({ action: 'create' }),
    notice: async (opts) => { notices.push(opts); return { action: 'create' } },
    report: async () => ({ action: 'create' }),
  }
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => ({}), drive: async () => ({ text: '本轮汇报', timedOut: false, elapsedMs: 1200, steps: 2, tokens: null }) },
    notify,
  })
  /** 需求 → 任务 → 接受/开始（机器人自动两道门）→ 提交验收。 */
  async function seed(assignee = 'bot:dev') {
    const req = handlers.create_requirement({ title: '支付重试', problem: '老是超时', owner: 'human:pm' })
    handlers.confirm_requirement({ id: req.id, actor: 'human:pm' })
    const proposed = handlers.propose_tasks({ id: req.id, tasks: [{ title: '实现退避', assignee, domains: ['development'], acceptance_criteria: ['单测'] }] })
    handlers.confirm_split({ id: req.id, actor: 'human:pm' })
    const taskId = proposed.tasks[0].id
    await handlers.run_task({ id: taskId })
    return { reqId: req.id, taskId }
  }
  return { dir, config, store, handlers, notices, seed, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/* ------------------------------------------------------------------ *
 * P0-1：需求收口
 * ------------------------------------------------------------------ */

test('R1-P0-1 任务全部验收 → 需求自动 done（这条路径以前静默失效）', async () => {
  const world = makeWorld()
  try {
    const { reqId, taskId } = await world.seed()
    assert.equal(world.store.get('task', taskId).state, 'in_review')

    const verified = world.handlers.verify_task({ id: taskId, actor: 'human:pm' })
    assert.equal(verified.ok, true, JSON.stringify(verified))
    assert.equal(world.store.get('task', taskId).state, 'done')
    // 这是以前从来没有发生过的那一步。
    assert.equal(world.store.get('requirement', reqId).state, 'done', '需求跟着任务收口')
    assert.equal(verified.requirement?.state, 'done', '结果里也要带上它')
  } finally {
    world.cleanup()
  }
})

test('R1-P0-1 手动 finish_requirement 不再抛 ReferenceError', async () => {
  const world = makeWorld()
  try {
    const { reqId, taskId } = await world.seed()
    world.handlers.verify_task({ id: taskId, actor: 'human:pm' })
    // 先把它退回 dispatched：直接改对象，模拟"自动收口没能完成"的现场。
    const req = world.store.get('requirement', reqId)
    world.store.put('requirement', { ...req, state: 'dispatched' })
    const finished = world.handlers.finish_requirement({ id: reqId, actor: 'human:pm' })
    assert.equal(finished.ok, true, JSON.stringify(finished))
    assert.equal(finished.state, 'done')
  } finally {
    world.cleanup()
  }
})

test('R1-P0-1 状态机层面：finish 会写历史，且不传 allTasksDone 时如实拒绝', () => {
  const req = {
    id: 'req-2026-001', title: 't', state: 'dispatched', owner: 'human:pm', requester: 'human:pm',
    priority: 'P2', type: 'feature_delivery', acceptance_criteria: [], tasks: [],
    body: { problem: '', proposal: '' }, links: { repos: [], docs: [], branches: [], mirror: null },
    visibility: 'team', origin: { surface: 'internal', excerpts: [] }, decisions: [], history: [],
  }
  const ctx = { now: new Date(), requirement: req, pmOwners: ['human:pm'], domainOwners: [] }
  assert.equal(transitionRequirement(req, 'finish', 'human:pm', ctx).code, 'tasks_open')
  const done = transitionRequirement(req, 'finish', 'human:pm', { ...ctx, allTasksDone: true })
  assert.equal(done.ok, true)
  assert.equal(done.next.state, 'done')
  assert.equal(done.next.history.length, 1, '历史必须真的写回对象')
})

/* ------------------------------------------------------------------ *
 * P0-2：自动释放之后的任务
 * ------------------------------------------------------------------ */

test('R1-P0-2 被释放的任务（assigned + 无执行者）能重新指派，不再是死状态', () => {
  const task = {
    id: 'task-1', req: 'req-1', title: 't', state: 'assigned', type: 'feature_delivery', domains: ['development'],
    assignee: null, owner: 'human:pm', acceptance_criteria: [], gates: {}, repo: null, branch: null, mr: null,
    evidence: [], release_count: 1, blocked_reason: null, history: [], collaborators: [],
  }
  const ctx = { now: new Date(), requirement: { id: 'req-1', owner: 'human:pm', state: 'dispatched', gates: {} }, pmOwners: [], domainOwners: ['human:pm'], suggestedAssignee: 'bot:dev' }
  assert.equal(availableActions(task).includes('assign'), true, '界面要给出这个按钮')
  const again = transitionTask(task, 'assign', 'human:pm', ctx)
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(again.next.assignee, 'bot:dev')
  // 有执行者时不给"指派"这个假按钮，换人走 reassign。
  assert.equal(availableActions({ ...task, assignee: 'bot:dev' }).includes('assign'), false)
})

test('R1-P0-2 自动释放之后：门禁被作废，tick 不再每分钟重试同一个非法跃迁', () => {
  /*
   * 真实路径：**人**承接的任务（机器人承接时 start 门禁是 not_applicable），
   * start 门禁到期 → `auto_release` 把它放回待派发（`assigned` + `assignee: null`）。
   * 那一刻门禁仍然是"到期"的，于是下一轮 tick 会再试一次 `timeout_start`，
   * 而那个跃迁对 `assigned` 不成立 —— 以前它每分钟重试一次、只往 decided 里塞一行，
   * 日志刷屏而群里零动静。
   */
  const world = makeWorld({ members: [{ key: 'human:pm', name: 'PM', domains: ['requirement', 'development'] }, { key: 'human:dev', name: 'Dev', domains: ['development'] }] })
  try {
    const req = world.handlers.create_requirement({ title: 'x', owner: 'human:pm', actor: 'human:pm' })
    world.handlers.confirm_requirement({ id: req.id, actor: 'human:pm' })
    const proposed = world.handlers.propose_tasks({ id: req.id, tasks: [{ title: 'T', assignee: 'human:dev', domains: ['development'], acceptance_criteria: ['a'] }], actor: 'human:pm' })
    world.handlers.confirm_split({ id: req.id, actor: 'human:pm' })
    const taskId = proposed.tasks[0].id
    world.handlers.accept_task({ id: taskId, actor: 'human:dev' })
    const task = world.store.get('task', taskId)
    world.store.put('task', { ...task, gates: { ...task.gates, start: { ...task.gates.start, due_at: '2020-01-01T00:00:00.000Z' } } })

    const released = world.handlers.tick({ dry_run: false })
    assert.equal(released.decided[0].action, 'timeout_start')
    assert.equal(world.store.get('task', taskId).state, 'assigned')
    assert.equal(world.store.get('task', taskId).assignee, null, '回到待派发')

    const second = world.handlers.tick({ dry_run: false })
    const row = second.decided.find((one) => one.task === taskId && one.gate === 'start')
    assert.notEqual(row, undefined)
    assert.equal(row.gate_cancelled, true, '不适用的到期门禁要作废：' + JSON.stringify(second.decided))
    assert.equal(world.store.get('task', taskId).gates.start.due_at, null)
    // 第三轮彻底安静。
    assert.deepEqual(world.handlers.tick({ dry_run: false }).decided, [])
  } finally {
    world.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * P0-3：suspended 的出口
 * ------------------------------------------------------------------ */

test('R1-P0-3 需求变更冻结的任务能被解冻，也能被废弃', async () => {
  const world = makeWorld()
  try {
    const { reqId, taskId } = await world.seed()
    // 变更需求 → 在途任务全部 suspended（这是 change 的既有行为）。
    const changed = world.handlers.change_requirement({ id: reqId, note: '验收标准改了', actor: 'human:pm' })
    assert.equal(changed.ok, true, JSON.stringify(changed))
    assert.equal(world.store.get('task', taskId).state, 'suspended')

    const resumed = world.handlers.resume_task({ id: taskId, actor: 'human:pm' })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.notEqual(world.store.get('task', taskId).state, 'suspended')

    // 再冻一次，这次废弃它。
    world.store.put('task', { ...world.store.get('task', taskId), state: 'suspended' })
    const dropped = world.handlers.drop_task({ id: taskId, actor: 'human:pm' })
    assert.equal(dropped.ok, true, JSON.stringify(dropped))
    assert.equal(world.store.get('task', taskId).state, 'dropped')
    assert.equal(
      (world.store.get('requirement', reqId).tasks ?? []).includes(taskId),
      false,
      '废弃之后它不再占着需求的任务清单（否则需求永远收不了口）',
    )
  } finally {
    world.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * P0-4：按钮与文本指令
 * ------------------------------------------------------------------ */

test('R1-P0-4 buttons:false 时第一级卡片里没有按钮（默认配置下按钮是死的）', () => {
  const spec = { title: '任务', blocks: [{ kind: 'buttons', buttons: [{ label: '接受', action: 'task.accept', value: { id: 'task-1' } }] }] }
  const off = degradationLadder(spec, { buttons: false })
  assert.equal(JSON.parse(off[0].payload.content).elements.some((el) => el.tag === 'action'), false)
  const on = degradationLadder(spec, { buttons: true })
  assert.equal(JSON.parse(on[0].payload.content).elements.some((el) => el.tag === 'action'), true)
})

test('R1-P0-4 兜底文案里的每一句，群命令解析器都认', () => {
  const spec = {
    title: '任务',
    blocks: [
      {
        kind: 'buttons',
        buttons: [
          { label: '接受', action: 'task.accept', value: { id: 'task-1' } },
          { label: '提交验收', action: 'task.submit', value: { id: 'task-1' } },
          { label: '打回', action: 'task.reject_review', value: { id: 'task-1' } },
        ],
      },
    ],
  }
  const text = JSON.parse(degradationLadder(spec, { buttons: false })[2].payload.content).elements.map((el) => el.content).join('')
  assert.equal(text.includes('task.accept'), false, '不能教内部动作名')
  const hints = [...text.matchAll(/`([^`]+)`/g)].map((one) => one[1])
  assert.equal(hints.length, 3)
  for (const hint of hints) {
    const parsed = parseCommand(hint)
    assert.notEqual(parsed, null, '这句应当能被解析：' + hint)
    assert.equal(parsed.id, 'task-1')
  }
})

test('R1-P1-1 命令词表与 handler 对账：每个动词都有落点，且读得懂原因/对象', () => {
  // 动词表里出现的每个 action 都必须真的存在（以前 `阻塞/转派` 需要的参数给不出，
  // 而 `提交验收`/`确认拆解` 连词都没有 —— 只用飞书的人走不完闭环）。
  const actions = Object.keys(DEFAULT_COMMANDS)
  assert.equal(actions.includes('submit_task'), true)
  assert.equal(actions.includes('confirm_split'), true)
  assert.equal(actions.includes('unassign_task'), true)
  assert.equal(actions.includes('renew_lease'), true)
  assert.equal(actions.includes('resume_task'), true)

  const withReason = parseCommand('阻塞 task-1 等接口上线')
  assert.deepEqual({ action: withReason.action, id: withReason.id, rest: withReason.rest }, { action: 'block_task', id: 'task-1', rest: '等接口上线' })
  const withTarget = parseCommand('转派 task-1 bot:dev')
  assert.equal(withTarget.action, 'reassign_task')
  assert.equal(withTarget.rest, 'bot:dev')
  assert.equal(parseCommand('状态').action, 'status')
})

/* ------------------------------------------------------------------ *
 * P1：并发与成员闸
 * ------------------------------------------------------------------ */

test('R1-P1-7 同一个任务并发驱动只跑一轮（第二次被互斥挡住）', async () => {
  const world = makeWorld()
  try {
    const { taskId } = await world.seed()
    // 把任务退回 in_progress，制造"可以再跑一轮"的状态。
    world.store.put('task', { ...world.store.get('task', taskId), state: 'in_progress' })
    const [a, b] = await Promise.all([
      world.handlers.run_task({ id: taskId, actor: 'bot:dev' }),
      world.handlers.run_task({ id: taskId, actor: 'bot:dev' }),
    ])
    const codes = [a.code, b.code].filter((one) => one !== undefined)
    assert.deepEqual(codes, ['already_running'], '两次并发里恰好一次被挡住：' + JSON.stringify([a.code, b.code]))
    // 释放之后还能再跑（互斥不是永久的）。
    world.store.put('task', { ...world.store.get('task', taskId), state: 'in_progress' })
    const third = await world.handlers.run_task({ id: taskId, actor: 'bot:dev' })
    assert.notEqual(third.code, 'already_running')
  } finally {
    world.cleanup()
  }
})

test('R1-P1-2 成员闸覆盖到每个写动作：观察者连"拆分确认"都做不了', async () => {
  const world = makeWorld({
    members: [
      { key: 'human:pm', name: 'PM', domains: ['requirement', 'development'], role: 'owner' },
      { key: 'human:watcher', name: '看客', domains: ['development'], role: 'observer' },
    ],
  })
  try {
    /** 一个建好并拆出任务的需求（用 owner 身份走完前置动作）。 */
    const seedReq = (title) => {
      const req = world.handlers.create_requirement({ title, owner: 'human:pm', actor: 'human:pm' })
      world.handlers.confirm_requirement({ id: req.id, actor: 'human:pm' })
      world.handlers.propose_tasks({ id: req.id, tasks: [{ title: 'T', assignee: 'bot:dev', domains: ['development'] }], actor: 'human:pm' })
      return req
    }

    // 观察者：以前只有 accept/start/submit/verify 四个动作过闸，`confirm_split` 不在里面。
    const first = seedReq('一个人的需求')
    const split = world.handlers.confirm_split({ id: first.id, actor: 'human:watcher' })
    assert.equal(split.ok, false)
    assert.equal(split.code, 'member_readonly', JSON.stringify(split))
    // 名册之外的人：名册非空时它是一张白名单。
    assert.equal(world.handlers.confirm_split({ id: first.id, actor: 'human:stranger' }).code, 'not_a_member')
    // 另一个写动作（指派）同样被挡 —— 这就是"闸在统一入口"的意义。
    const task = world.store.all('task')[0]
    assert.equal(world.handlers.assign_task({ id: task.id, assignee: 'bot:dev', actor: 'human:watcher' }).code, 'member_readonly')

    // 机器人侧不受影响（成员表管人，不管机器人）：先让 owner 确认拆解，机器人就能接。
    assert.equal(world.handlers.confirm_split({ id: first.id, actor: 'human:pm' }).ok, true)
    assert.equal(world.handlers.accept_task({ id: task.id, actor: 'bot:dev' }).ok, true)
  } finally {
    world.cleanup()
  }
})

test('R1-P1-5 租约能续约（以前 renewLease 是零调用点）', async () => {
  const world = makeWorld()
  try {
    const { taskId } = await world.seed()
    const before = world.store.get('lease', taskId)
    assert.notEqual(before, null, 'accept 时已经起租')
    world.store.put('lease', { ...before, expires_at: '2020-01-01T00:00:00.000Z' })
    const renewed = world.handlers.renew_lease({ id: taskId, actor: 'bot:dev' })
    assert.equal(renewed.ok, true, JSON.stringify(renewed))
    assert.equal(renewed.renewals, 1)
    assert.equal(world.store.get('lease', taskId).expires_at > '2020-01-01T00:00:00.000Z', true)
  } finally {
    world.cleanup()
  }
})
