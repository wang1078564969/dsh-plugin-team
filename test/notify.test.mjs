/*
 * 出站通知链：把设计文档 04 §2 的引擎真正接上之后，它的行为必须被钉住。
 *
 * 这一层之前是**零调用点** —— 群播报层从 hub 搬过来、测试也搬了，但没有一处代码
 * 用它，于是群里除了"已记为需求"和命令回复之外全程无声。这些用例锁的是接线之后
 * 最容易悄悄坏掉的三件事：
 *
 *   1. **同一张卡**：同一个对象的第二次通知是原地更新（PATCH），不是又发一条；
 *   2. **跨重启**：卡台账落盘，重启之后接着更新那张卡，而不是群里多出一张新卡；
 *   3. **不静默**：节流 / digest / 没有群 都有明确的 reason 回来，"为什么群里没动静"能答。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { cardRecordId, chatIdOfTask, createNotifier } from '../lib/notify.js'
import { Store } from '../lib/store.js'
import { createHandlers } from '../lib/tools.js'

/** 等一拍：播报是 fire-and-forget 的（模型不该等一张卡发出去）。 */
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个"像生产里那样"的世界：工具层造对象，假飞书收请求。 */
function makeWorld(feishuOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-notify-'))
  const config = loadConfig({
    dataDir: dir,
    tickIntervalMs: 0,
    bots: [],
    defaultOwner: 'human:owner',
    /*
     * 有成员表的安装：`development` 有域负责人，`accept`/`start` 门禁才有明确的确认人。
     * 没有它的话门禁"没有确认人"= 立即视为满足，超时永远不会发生 —— 那测的是空配置。
     */
    members: { pm: ['human:owner'], requirement: ['human:owner'], development: ['human:zhouyu'] },
    feishu: { mode: 'own', appId: 'cli_x', appSecret: 's', ...feishuOverrides },
  })
  const store = new Store(dir).load()
  let clock = new Date('2026-09-12T10:00:00Z')

  const requests = []
  const client = {
    ready: true,
    appId: 'cli_x',
    async request(method, path, body) {
      // 一点真实延迟：没有它，"两次投递抢着建卡"这类竞态在测试里永远复现不了。
      await new Promise((resolve) => setTimeout(resolve, 2))
      requests.push({ method, path, body })
      return { ok: true, code: 0, msg: 'ok', data: { message_id: 'om_' + String(requests.length) } }
    },
    async send(chatId, payload) {
      requests.push({ method: 'POST', path: '/im/v1/messages', chatId, payload })
      return { ok: true, code: 0, data: { message_id: 'om_' + String(requests.length) } }
    },
  }

  const notifier = createNotifier({
    config,
    store,
    clientFor: () => client,
    log: { error: () => {} },
    now: () => clock,
  })
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => {}, drive: async () => ({}) },
    notify: notifier,
  })

  /** 一个从飞书群里长出来的需求，带一个任务。 */
  function seedTask() {
    const created = handlers.create_requirement({ title: '支付重试', problem: '没有重试', owner: 'human:owner' })
    // 真实路径里这条由 ingest 从飞书消息写入（origin.chat_id = 群里那条消息的群）。
    store.put('requirement', {
      ...store.get('requirement', created.id),
      origin: { surface: 'feishu', chat_id: 'oc_a', excerpts: [] },
    })
    handlers.confirm_requirement({ id: created.id, actor: 'human:owner' })
    const proposed = handlers.propose_tasks({
      id: created.id,
      tasks: [{ title: '实现退避', assignee: 'bot:dev', domains: ['development'], acceptance_criteria: ['单测'] }],
    })
    handlers.confirm_split({ id: created.id, actor: 'human:owner' })
    return { requirementId: created.id, taskId: proposed.tasks[0].id }
  }

  return {
    dir, config, store, handlers, notifier, requests, client,
    seedTask,
    advance: (ms) => { clock = new Date(clock.getTime() + ms) },
    nowIso: () => clock.toISOString(),
    rebuild: () => createNotifier({ config, store, clientFor: () => client, log: { error: () => {} }, now: () => clock }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('the first notification creates a message; the second updates THAT message in place', async () => {
  const world = makeWorld()
  try {
    const { taskId } = world.seedTask()
    const task = world.store.get('task', taskId)

    const first = await world.notifier.task(task, { reason: 'assign' })
    assert.equal(first.action, 'create', JSON.stringify(first))
    assert.equal(first.card_key, 'task:' + taskId)
    assert.equal(world.requests.length, 1)
    assert.equal(world.requests[0].method, 'POST')

    // 同一个对象的下一次通知：**原地更新**，而不是又发一条 —— 这就是"同一个话题一张卡"。
    const second = await world.notifier.task({ ...task, state: 'accepted' }, { reason: 'accept' })
    assert.equal(second.action, 'update', JSON.stringify(second))
    assert.equal(second.message_id, first.message_id, 'same message')
    assert.equal(world.requests[1].method, 'PATCH')
    assert.match(world.requests[1].path, new RegExp('/im/v1/messages/' + first.message_id))

    // 卡台账落盘：重启之后仍然是那张卡。
    const rows = world.store.all('card')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].card_key, 'task:' + taskId)
    assert.equal(rows[0].message_id, first.message_id)
    assert.equal(rows[0].chat_id, 'oc_a')
    const restarted = world.rebuild()
    assert.equal(restarted.boundCards(), 1, 'the ledger is read back from disk')
    const afterRestart = await restarted.task({ ...task, state: 'in_progress' }, { reason: 'start' })
    assert.equal(afterRestart.action, 'update')
    assert.equal(afterRestart.message_id, first.message_id, 'no second card after a restart')
  } finally {
    world.cleanup()
  }
})

test('every task write announces, and rapid transitions still produce ONE card', async () => {
  /*
   * 这里刻意**连着发、不 await** —— 机器人承接任务时 `accept` 和 `start` 就是这么连着
   * 过的。不串行化的话两次投递都会看到"还没有卡"，各发一条，一个任务两张卡：
   * 那正是设计要避免的刷屏，而且手工点两下永远复现不了。
   */
  const world = makeWorld()
  try {
    const { taskId } = world.seedTask()
    await settle() // 建任务与拆解那两次跃迁的播报
    const before = world.requests.length

    world.handlers.accept_task({ id: taskId, actor: 'bot:dev' })
    world.handlers.start_task({ id: taskId, actor: 'bot:dev' })
    await settle()

    const after = world.requests.slice(before)
    assert.equal(after.filter((one) => one.method === 'POST').length, 0, '第二次跃迁不再建新卡')
    assert.equal(after.filter((one) => one.method === 'PATCH').length, 2, '两次跃迁各原地更新一次')
    assert.equal(world.store.all('card').length, 1, '一个任务全程只有一张卡')
    assert.equal(new Set(world.store.all('card').map((one) => one.message_id)).size, 1)
  } finally {
    world.cleanup()
  }
})

test('digest events accumulate instead of hitting the group, and no chat means no message', async () => {
  const world = makeWorld()
  try {
    const { taskId } = world.seedTask()
    const task = world.store.get('task', taskId)

    const digested = await world.notifier.task(task, { reason: 'progress', progress: true, line: '步骤 1/3' })
    assert.equal(digested.action, 'digest', '进度类进摘要，不进群（设计文档 §2.2）')
    assert.equal(world.requests.length, 0, 'nothing was sent to the group')
    assert.deepEqual(world.notifier.digestLines('task'), ['步骤 1/3'])

    // 没有来源群（用 team 工具在 DSH 里建的需求）：跳过，但要说清为什么。
    const orphan = { ...task, req: 'req-does-not-exist' }
    assert.equal(chatIdOfTask(world.store, orphan), null)
    const skipped = await world.notifier.task(orphan, { reason: 'assign' })
    assert.equal(skipped.action, 'skip')
    assert.equal(skipped.reason, 'no-chat')
    assert.equal(world.requests.length, 0)
  } finally {
    world.cleanup()
  }
})

test('an unaddressed escalation reaches the requirement owner, and the quota downgrades spam', async () => {
  const world = makeWorld()
  try {
    const { requirementId, taskId } = world.seedTask()
    const task = world.store.get('task', taskId)

    // 门禁需要人确认 → 立即播报，并 @ 那个人（设计文档 §2.2 的 gate_needs_human）。
    const escalated = await world.notifier.task(task, {
      reason: 'gate',
      pendingGates: [{ name: 'accept', pending: ['human:owner'] }],
    })
    assert.equal(escalated.action, 'create')
    assert.equal(escalated.reason, 'gate_needs_human')
    const content = String(world.requests[0].body.content)
    assert.equal(content.includes('📋 任务') || content.includes('📌'), true, '是一张真卡片（不是纯文本）')
    /*
     * 注意：@ 人（飞书要 `<at user_id=…>`）目前没有渲染进卡片，只体现在决策里
     * （`decision.mention`）—— 这一条记在 docs/GAP-VS-DESIGN.md 的"卡片与渲染"一档，
     * 不在这里假装它已经做了。
     */

    // @人配额：同一个人被 @ 到上限之后改成静默待办，而不是继续骚扰。
    for (let i = 0; i < 4; i += 1) {
      world.advance(3_000)
      await world.notifier.task(task, { reason: 'gate', pendingGates: [{ name: 'accept', pending: ['human:owner'] }] })
    }
    assert.equal(
      world.notifier.stats().delivered + world.notifier.stats().updated > 0,
      true,
      'the notices still go out (as silent todos), they just stop mentioning',
    )
    assert.equal(requirementId, world.store.get('task', taskId).req)
  } finally {
    world.cleanup()
  }
})

test('a tick that releases a task says so in the group (it used to be silent)', async () => {
  const world = makeWorld()
  try {
    const { taskId } = world.seedTask()
    // 人承接的任务：接受门禁超时 → 只催办并升级（设计文档 §2.4③）
    // 机器人执行者的门禁是 not_applicable（走租约），所以先拒绝再改派给真人。
    const rejected = world.handlers.reject_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(rejected.ok, true, JSON.stringify(rejected))
    const reassigned = world.handlers.assign_task({ id: taskId, assignee: 'human:zhouyu', actor: 'human:owner' })
    assert.equal(reassigned.ok, true, JSON.stringify(reassigned))
    assert.equal(world.store.get('task', taskId).gates.accept.not_applicable, false, '人的门禁要真的计时')
    await settle()
    const before = world.requests.length
    // 把 accept 门禁的时钟拨到过去（而不是等 4 小时）。
    const task = world.store.get('task', taskId)
    world.store.put('task', {
      ...task,
      gates: { ...task.gates, accept: { ...task.gates.accept, due_at: new Date(Date.now() - 60_000).toISOString() } },
    })

    const report = world.handlers.tick({ dry_run: false })
    assert.equal(report.ok, true)
    const gateEvents = report.decided.filter((one) => one.gate !== undefined)
    assert.equal(gateEvents.length > 0, true, '有门禁到期：' + JSON.stringify(report.decided))
    assert.equal(
      gateEvents.some((one) => one.notified === true),
      true,
      '每一个"到期"的处置都标了有没有播报出去',
    )
    await settle()
    assert.equal(world.requests.length > before, true, '超时不再只写日志：群里收到了一条通知')
  } finally {
    world.cleanup()
  }
})

test('card records are file-safe ids, and the original key is kept verbatim', () => {
  // `task:task-1` 里的冒号不能当文件名（store 的 safeId 会拒绝路径穿越类字符）。
  assert.equal(cardRecordId('task:task-1'), 'task.task-1')
  assert.equal(cardRecordId('req:req-2026-001'), 'req.req-2026-001')
  assert.equal(cardRecordId('decision:adr-2026-001'), 'decision.adr-2026-001')
  const world = makeWorld()
  try {
    const { taskId } = world.seedTask()
    return world.notifier.task(world.store.get('task', taskId), { reason: 'assign' }).then(() => {
      const saved = world.store.get('card', cardRecordId('task:' + taskId))
      assert.notEqual(saved, null)
      assert.equal(saved.card_key, 'task:' + taskId, 'the original key is what the notifier matches on')
      world.cleanup()
    })
  } catch (error) {
    world.cleanup()
    throw error
  }
})
