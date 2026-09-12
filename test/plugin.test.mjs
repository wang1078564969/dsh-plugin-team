/*
 * Self-test for the plugin half that is NOT the ported domain: the store, the
 * config resolution, the worker-session driver, and the `team` tool's handlers.
 *
 * WHAT A FAKE `agents` SERVICE BUYS. The heart of this plugin is "a task is
 * handed to a live DSH session and its report comes back as evidence". That
 * claim is testable without a model: a fake agent that opens a turn, appends an
 * assistant message, and closes the turn exercises exactly the code path
 * `SessionPool.drive` runs in production — status polling, the `turn/end`
 * accelerator, `whenIdle()`, and reading the report out of
 * `session.snapshotEvents`. What it does NOT prove is that a real model answers
 * well; that is what the harness-level smoke run is for.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { SessionPool, lastAssistantText, taskPrompt } from '../lib/exec.js'
import { Store } from '../lib/store.js'
import { buildTeamTool, createHandlers, sessionSpecFor } from '../lib/tools.js'

/* ------------------------------------------------------------------ *
 * A fake session + agent, shaped like the real driver's contract
 * ------------------------------------------------------------------ */

class FakeSession {
  constructor(id) {
    this.id = id
    this.events = []
  }

  get seq() {
    return this.events.length
  }

  append(event) {
    this.events.push({ seq: this.events.length, time: Date.now(), ...event })
  }

  snapshotEvents(fromSeq = 0, toSeqExclusive = this.events.length) {
    return this.events.slice(fromSeq, toSeqExclusive)
  }
}

class FakeAgent {
  constructor(id, reply = 'DONE-42') {
    this.id = id
    this.session = new FakeSession(id)
    this.reply = reply
    this.turns = 0
    this.status = 'idle'
  }

  followup(message) {
    this.turns += 1
    const turn = this.turns
    this.status = 'running'
    this.session.append({ type: 'turn/start', data: { turn } })
    this.session.append({ type: 'user/message', data: { content: message.content } })
    // Finish asynchronously, the way a real step does.
    setTimeout(() => {
      this.session.append({
        type: 'assistant/message',
        data: { turn, step: 1, message: { content: [{ type: 'text', text: this.reply }] } },
      })
      this.session.append({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      this.status = 'idle'
    }, 120)
  }

  whenIdle() {
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (this.status === 'idle') {
          clearInterval(poll)
          resolve()
        }
      }, 20)
      if (typeof poll.unref === 'function') poll.unref()
    })
  }
}

function fakeCtx() {
  const created = []
  const agents = {
    get: () => undefined,
    async create(options) {
      const agent = new FakeAgent(options.sessionId)
      created.push({ options, agent })
      return { agent, dispose: async () => {} }
    },
    async resume() {
      throw new Error('no such session')
    },
  }
  const ctx = {
    created,
    get: (name) => (name === 'agents' ? agents : undefined),
    on: () => () => {},
    effect: (factory) => {
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return ctx
}

/* ------------------------------------------------------------------ *
 * One ledger in a temp directory, wired exactly like lib/team.js wires it
 * ------------------------------------------------------------------ */

function makeLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-test-'))
  const config = loadConfig({ workspace: join(dir, 'workspace'), tickIntervalMs: 0 })
  const store = new Store(dir).load()
  const ctx = fakeCtx()
  const pool = new SessionPool(ctx, config)
  const handlers = createHandlers({ ctx, config, store, pool })
  return {
    dir,
    config,
    store,
    ctx,
    pool,
    handlers,
    tool: buildTeamTool(handlers),
    cleanup: () => {
      pool.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/* ------------------------------------------------------------------ *
 * Exec: the driver contract
 * ------------------------------------------------------------------ */

test('lastAssistantText takes the LAST assistant message, skipping interrupted ones', () => {
  const events = [
    { type: 'turn/start' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'working…' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final report' }] } } },
    { type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: 'discarded' }] } } },
  ]
  assert.equal(lastAssistantText(events), 'final report')
  assert.equal(lastAssistantText([]), '')
})

test('SessionPool.drive collects the report of one driven turn', async () => {
  const ctx = fakeCtx()
  const config = loadConfig({ workspace: '/tmp' })
  const pool = new SessionPool(ctx, config)
  const agent = await pool.open({ sessionId: 'team-task-1', role: 'dev', cwd: '/tmp' })
  const driven = await pool.drive(agent, 'do the thing', { timeoutMs: 5000 })
  assert.equal(driven.timedOut, false)
  assert.equal(driven.text, 'DONE-42')
  assert.equal(agent.turns, 1)
})

test('taskPrompt carries the acceptance criteria and the requirement background', () => {
  const prompt = taskPrompt(
    { id: 'task-1', title: '实现重试', acceptance_criteria: ['退避序列可配置'], repo: 'pay-service' },
    { id: 'req-2026-001', title: '支付失败自动重试', body: { problem: '没有重试入口', proposal: '指数退避' } },
    { note: '只改 service 层' },
  )
  for (const fragment of ['task-1', 'req-2026-001', '退避序列可配置', '没有重试入口', 'pay-service', '只改 service 层']) {
    assert.ok(prompt.includes(fragment), 'prompt should mention ' + fragment)
  }
})

/* ------------------------------------------------------------------ *
 * The tool: the whole two-gate flow, driven by a bot executor
 * ------------------------------------------------------------------ */

test('the ledger runs requirement → tasks → two gates → a real driven turn → acceptance', async () => {
  const ledger = makeLedger()
  try {
    const created = ledger.handlers.create_requirement({
      title: '支付失败自动重试',
      owner: 'human:wangmengfan',
      problem: '没有重试入口',
      acceptance_criteria: ['自动重试 3 次'],
      repos: ['pay-service'],
    })
    assert.equal(created.ok, true)
    assert.match(created.id, /^req-\d{4}-\d{3}$/)
    assert.equal(created.state, 'draft')

    const confirmed = ledger.handlers.confirm_requirement({ id: created.id })
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.state, 'confirmed')

    const proposed = ledger.handlers.propose_tasks({
      id: created.id,
      tasks: [{ title: '实现退避', assignee: 'bot:dev', acceptance_criteria: ['单测覆盖'] }],
    })
    assert.equal(proposed.ok, true)
    assert.equal(proposed.tasks.length, 1)
    const taskId = proposed.tasks[0].id
    assert.equal(ledger.store.get('task', taskId).state, 'proposed')

    const split = ledger.handlers.confirm_split({ id: created.id })
    assert.equal(split.ok, true)
    assert.equal(ledger.store.get('requirement', created.id).state, 'dispatched')
    assert.equal(ledger.store.get('task', taskId).state, 'assigned')

    const run = await ledger.handlers.run_task({ id: taskId })
    assert.equal(run.ok, true, JSON.stringify(run))
    assert.equal(run.state, 'in_review')
    assert.equal(run.report, 'DONE-42')
    const ranTask = ledger.store.get('task', taskId)
    assert.equal(ranTask.evidence.length, 1)
    assert.equal(ranTask.evidence[0].ref, 'session:' + run.session_id)
    assert.equal(ledger.store.get('session', taskId).turns, 1)

    // The executor may not judge its own work — the engine's refusal travels
    // through the tool unchanged.
    const selfReview = ledger.handlers.verify_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(selfReview.ok, false)
    assert.equal(selfReview.code, 'self_review')

    const verified = ledger.handlers.verify_task({ id: taskId, actor: 'human:wangmengfan' })
    assert.equal(verified.ok, true)
    assert.equal(verified.state, 'done')

    const listed = ledger.handlers.list({ kind: 'task' })
    assert.equal(listed.rows.length, 1)
    assert.equal(listed.rows[0].state, 'done')
  } finally {
    ledger.cleanup()
  }
})

test('a human assignee cannot be driven before both gates, and a bot gets the auto-receipt', async () => {
  const ledger = makeLedger()
  try {
    const req = ledger.handlers.create_requirement({ title: '人承接的任务', owner: 'human:pm1' })
    ledger.handlers.confirm_requirement({ id: req.id })
    const proposed = ledger.handlers.propose_tasks({
      id: req.id,
      tasks: [{ title: '写文档', assignee: 'human:zhouyu' }],
    })
    ledger.handlers.confirm_split({ id: req.id })
    const taskId = proposed.tasks[0].id
    assert.equal(ledger.store.get('task', taskId).state, 'assigned')

    const tooEarly = await ledger.handlers.run_task({ id: taskId })
    assert.equal(tooEarly.ok, false)
    assert.equal(tooEarly.code, 'gate_incomplete')
    assert.deepEqual(tooEarly.pending, ['human:zhouyu'])

    const accepted = ledger.handlers.accept_task({ id: taskId, actor: 'human:zhouyu' })
    assert.equal(accepted.ok, true)
    assert.equal(accepted.state, 'accepted')
    // Accepting starts the lease — that is the state most worth watching.
    assert.equal(ledger.store.get('lease', taskId).holder, 'human:zhouyu')

    const stillEarly = await ledger.handlers.run_task({ id: taskId })
    assert.equal(stillEarly.ok, false)
    assert.equal(stillEarly.code, 'gate_incomplete')

    const started = ledger.handlers.start_task({ id: taskId, actor: 'human:zhouyu' })
    assert.equal(started.ok, true)
    assert.equal(started.state, 'in_progress')

    const run = await ledger.handlers.run_task({ id: taskId })
    assert.equal(run.ok, true)
    assert.equal(run.state, 'in_review')
  } finally {
    ledger.cleanup()
  }
})

test('submit without evidence is refused (a "done" with nothing behind it is not done)', () => {
  const ledger = makeLedger()
  try {
    const req = ledger.handlers.create_requirement({ title: '无证据提交', owner: 'human:pm1' })
    ledger.handlers.confirm_requirement({ id: req.id })
    const proposed = ledger.handlers.propose_tasks({ id: req.id, tasks: [{ title: '干活', assignee: 'bot:dev' }] })
    ledger.handlers.confirm_split({ id: req.id })
    const taskId = proposed.tasks[0].id
    ledger.handlers.accept_task({ id: taskId })
    ledger.handlers.start_task({ id: taskId })
    const submitted = ledger.handlers.submit_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(submitted.ok, false)
    assert.equal(submitted.code, 'evidence_required')
  } finally {
    ledger.cleanup()
  }
})

test('tick releases a task whose "start" was never confirmed, and only when asked to act', () => {
  const ledger = makeLedger()
  try {
    const req = ledger.handlers.create_requirement({ title: '超时释放', owner: 'human:pm1' })
    ledger.handlers.confirm_requirement({ id: req.id })
    const proposed = ledger.handlers.propose_tasks({ id: req.id, tasks: [{ title: '别磨蹭', assignee: 'human:zhouyu' }] })
    ledger.handlers.confirm_split({ id: req.id })
    const taskId = proposed.tasks[0].id
    ledger.handlers.accept_task({ id: taskId, actor: 'human:zhouyu' })

    // Force the gate clock into the past rather than waiting two hours.
    const task = ledger.store.get('task', taskId)
    ledger.store.put('task', {
      ...task,
      gates: { ...task.gates, start: { ...task.gates.start, due_at: new Date(Date.now() - 1000).toISOString() } },
    })

    const preview = ledger.handlers.tick({ dry_run: true })
    assert.equal(preview.dry_run, true)
    assert.equal(preview.gates, 1)
    assert.equal(ledger.store.get('task', taskId).state, 'accepted', 'a dry run must not move anything')

    const acted = ledger.handlers.tick({ dry_run: false })
    assert.equal(acted.decided.some((row) => row.action === 'timeout_start'), true)
    const after = ledger.store.get('task', taskId)
    assert.equal(after.state, 'assigned')
    assert.equal(after.release_count, 1)
  } finally {
    ledger.cleanup()
  }
})

test('the registered tool definition is well formed and refuses unknown actions', async () => {
  const ledger = makeLedger()
  try {
    assert.equal(ledger.tool.name, 'team')
    assert.equal(typeof ledger.tool.execute, 'function')
    assert.equal(ledger.tool.parameters.required.includes('action'), true)
    const refused = await ledger.tool.execute({ action: 'nonsense' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'bad_request')
    const rendered = ledger.tool.output.render({ action: 'list' }, refused)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /未知 action/)
  } finally {
    ledger.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * Worker sessions must be creatable: the model, the preset
 * ------------------------------------------------------------------ */

test('a worker session always carries a resolved model (the {{model}} prompt variable depends on it)', async () => {
  const created = []
  const agents = {
    get: () => undefined,
    async create(options) {
      created.push(options)
      return { agent: new FakeAgent(options.sessionId), dispose: async () => {} }
    },
    async resume() {
      throw new Error('no such session')
    },
  }
  const ctx = {
    get: (name) => {
      if (name === 'agents') return agents
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }) }
      }
      return undefined
    },
    on: () => () => {},
    effect: (factory) => factory(),
  }
  const config = loadConfig({ workspace: '/tmp' })
  const pool = new SessionPool(ctx, config)
  await pool.open({ sessionId: 'team-task-9', role: 'dev', cwd: '/tmp' })
  assert.equal(created.length, 1)
  // Without this the run fails with `prompt variable "{{model}}" has no value`
  // and the turn ends as `error` before the model says anything.
  assert.equal(typeof created[0].agentOptions.model, 'string')
  assert.ok(created[0].agentOptions.model.length > 0)
  assert.equal(typeof created[0].agentOptions.provider, 'string')
})

test('a configured role preset is named on the session; an unconfigured one is left to the deployment', async () => {
  const created = []
  const agents = {
    get: () => undefined,
    async create(options) {
      created.push(options)
      return { agent: new FakeAgent(options.sessionId), dispose: async () => {} }
    },
    async resume() {
      throw new Error('no such session')
    },
  }
  const ctx = {
    get: (name) => (name === 'agents' ? agents : undefined),
    on: () => () => {},
    effect: (factory) => factory(),
  }

  const withPreset = loadConfig({ workspace: '/tmp', sessions: { presets: { dev: 'custom-dev' } } })
  await new SessionPool(ctx, withPreset).open({ sessionId: 'team-task-a', role: 'dev', cwd: '/tmp' })
  assert.equal(created[0].meta.agentPreset, 'custom-dev')

  const withoutPreset = loadConfig({ workspace: '/tmp' })
  await new SessionPool(ctx, withoutPreset).open({ sessionId: 'team-task-b', role: 'dev', cwd: '/tmp' })
  assert.equal(Object.prototype.hasOwnProperty.call(created[1].meta, 'agentPreset'), false)
})

test('a worker session may not edit the ledger through the tool it is running under', async () => {
  const ledger = makeLedger()
  try {
    const workerId = 'team-task-77'
    ledger.pool.live.set(workerId, { agent: { id: workerId }, handle: null, lastUsed: Date.now() })
    const tool = buildTeamTool(ledger.handlers, { isWorker: (id) => ledger.pool.live.has(id) })
    const refused = await tool.execute({ action: 'create_requirement', title: '来自执行会话' }, { agent: { id: workerId } })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'worker_session')
    // A normal session (no agent, or an unowned one) is still served.
    const allowed = await tool.execute({ action: 'list' }, { agent: { id: 'session-someone-else' } })
    assert.equal(allowed.ok, true)
  } finally {
    ledger.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * The cross-directory resume guard
 * ------------------------------------------------------------------ */

test('a session that lives in ANOTHER directory is not resumed into this one', async () => {
  /*
   * A session's cwd is fixed when it is created, so resuming one from elsewhere
   * answers in the wrong project with the wrong history — and every log line
   * says success. This is not hypothetical: the team plugin's first chat-session
   * ids collided with an earlier Feishu bridge plugin's, so `resume` loaded the
   * BRIDGE's conversation (different project, 188KB of history) and the chat
   * never appeared under the team workspace it belonged to.
   */
  const created = []
  const disposed = []
  const foreign = { id: 'team-feishu-oc_a', session: { id: 'team-feishu-oc_a', header: { cwd: '/Users/someone/other-project' } } }
  const agents = {
    get: () => undefined,
    async resume() {
      return { agent: foreign, dispose: async () => disposed.push('foreign') }
    },
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId, session: { id: options.sessionId } }, dispose: async () => {} }
    },
  }
  const ctx = {
    get: (name) => (name === 'agents' ? agents : undefined),
    on: () => () => {},
    effect: (factory) => factory(),
  }
  const pool = new SessionPool(ctx, loadConfig({ workspace: '/tmp' }))
  const agent = await pool.open({ sessionId: 'team-feishu-oc_a', role: 'chat', cwd: '/Users/nitoo/.dsh/team/workspace' })

  assert.equal(disposed.length, 1, 'the foreign session is let go, not used')
  assert.equal(created.length, 1, 'a fresh session is created instead')
  assert.match(String(created[0].sessionId), /^team-feishu-oc_a-g\d+$/, 'and it gets its own id so the two never merge')
  assert.equal(created[0].meta.cwd, '/Users/nitoo/.dsh/team/workspace')
  assert.equal(agent.id, created[0].sessionId, 'the caller learns the id it really got')
})

test('a session that lives where we asked is resumed as usual', async () => {
  const created = []
  const mine = { id: 'team-feishu-oc_b', session: { id: 'team-feishu-oc_b', header: { cwd: '/tmp' } } }
  const agents = {
    get: () => undefined,
    async resume() {
      return { agent: mine, dispose: async () => {} }
    },
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId }, dispose: async () => {} }
    },
  }
  const ctx = {
    get: (name) => (name === 'agents' ? agents : undefined),
    on: () => () => {},
    effect: (factory) => factory(),
  }
  const pool = new SessionPool(ctx, loadConfig({ workspace: '/tmp' }))
  const agent = await pool.open({ sessionId: 'team-feishu-oc_b', role: 'chat', cwd: '/tmp' })
  assert.equal(created.length, 0, 'resuming is the point: the chat keeps its memory')
  assert.equal(agent.id, 'team-feishu-oc_b')
})

test('sameDirectory sees through the /tmp vs /private/tmp spelling', async () => {
  // macOS writes one and configs hold the other; a plain string compare would
  // start a fresh session on every single message.
  const { sameDirectory } = await import('../lib/exec.js')
  assert.equal(sameDirectory('/tmp', '/private/tmp'), true)
  assert.equal(sameDirectory('/tmp/', '/tmp'), true)
  assert.equal(sameDirectory('/tmp', '/Users'), false)
})

test('a task assigned to a roster bot runs as THAT bot: its preset, its model, its role', () => {
  /*
   * The bot is the identity, so `bot:<id>` is what decides how the executing session
   * is configured. Without this the roster would be display-only: "this bot runs on
   * the fast model" would mean nothing, and the per-role preset table (which the
   * console no longer asks anyone to fill in) would be the only thing that worked.
   */
  const config = loadConfig({
    workspace: '/tmp',
    bots: [
      { id: 'dev-pay', displayName: '支付开发', role: 'dev', enabled: true, agentPreset: 'coder', model: { primary: 'fast-model' } },
      { id: 'qa', displayName: '测试机器人', role: 'qa', enabled: true },
    ],
    sessions: { preset: 'global', presets: { dev: 'legacy-dev', qa: 'legacy-qa' } },
  })
  assert.deepEqual(sessionSpecFor(config, { assignee: 'bot:dev-pay' }), {
    role: 'dev',
    botId: 'dev-pay',
    preset: 'coder',
    model: 'fast-model',
  })
  // A bot with no preset of its own inherits the role mapping, which is the only
  // thing `sessions.presets` still does for a rostered bot.
  assert.deepEqual(sessionSpecFor(config, { assignee: 'bot:qa' }), { role: 'qa', botId: 'qa' })
  // A `bot:` id nobody declared (a ledger from before the roster) falls back to the
  // role map by role name — and to the domain for human-assigned work.
  assert.deepEqual(sessionSpecFor(config, { assignee: 'bot:dev' }), { role: 'dev', botId: null })
  assert.deepEqual(sessionSpecFor(config, { assignee: 'human:wangmengfan', domains: ['testing'] }), {
    role: 'testing',
    botId: null,
  })
})

test('run_task hands the bot\'s preset and model to the session it opens', async () => {
  const created = []
  const agents = {
    get: () => undefined,
    async create(options) {
      created.push(options)
      return { agent: new FakeAgent(options.sessionId), dispose: async () => {} }
    },
    async resume() {
      throw new Error('no such session')
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-botspec-'))
  const ctx = {
    get: (name) => (name === 'agents' ? agents : undefined),
    on: () => () => {},
    effect: (factory) => factory(),
  }
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    bots: [{ id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, agentPreset: 'coder', model: { primary: 'fast-model' } }],
  })
  const store = new Store(dir).load()
  const pool = new SessionPool(ctx, config)
  const handlers = createHandlers({ ctx, config, store, pool })
  try {
    const requirement = handlers.create_requirement({ title: '重试', problem: '没有重试' })
    handlers.confirm_requirement({ id: requirement.id })
    const proposed = handlers.propose_tasks({ id: requirement.id, tasks: [{ title: '实现', assignee: 'bot:dev' }] })
    handlers.confirm_split({ id: requirement.id })
    const run = await handlers.run_task({ id: proposed.tasks[0].id })
    assert.equal(run.ok, true, JSON.stringify(run))
    // The session was created on demand from the bot's own settings — nothing was
    // pre-declared per role anywhere.
    assert.equal(created[0].meta.agentPreset, 'coder')
    assert.equal(created[0].agentOptions.model, 'fast-model')
  } finally {
    pool.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the coordination loop has no dead ends: reject → reassign, block → unblock, review → 打回', async () => {
  /*
   * 这些动作在设计里都写着，但之前**没有入口**：`拒绝/阻塞` 两个动词印在群命令表里
   * （`DEFAULT_COMMANDS`），handler 却不存在 —— 人照着打过去只会收到"这个动作还没有接上"。
   * 状态机里 `rejected` 更是死状态（`availableActions` 为空），而设计 02 §5.3 明说
   * "拒绝后回到待派发、换人重派，不允许悬空"。
   */
  const ledger = makeLedger()
  try {
    const created = ledger.handlers.create_requirement({ title: '支付重试', owner: 'human:owner', problem: '没有重试' })
    ledger.handlers.confirm_requirement({ id: created.id, actor: 'human:owner' })
    ledger.handlers.assign_task({ id: 'task-1', assignee: 'human:dev', actor: 'human:owner' }).id ?? null
    const proposed = ledger.handlers.propose_tasks({ id: created.id, tasks: [{ title: '实现退避', assignee: 'human:dev' }] })
    const taskId = proposed.tasks[0].id
    ledger.handlers.confirm_split({ id: created.id, actor: 'human:owner' })

    // 拒绝 → 回到待派发（而不是卡死）
    const rejected = ledger.handlers.reject_task({ id: taskId, actor: 'human:dev' })
    assert.equal(rejected.ok, true, JSON.stringify(rejected))
    assert.equal(rejected.state, 'rejected')
    assert.equal(ledger.store.get('task', taskId).assignee, null, '拒绝后不再挂在拒绝者名下')

    /*
     * …而且能重新指派（这就是"不悬空"）。这里改派给机器人：机器人执行者走租约、
     * 两道门禁自动放行，所以这段测的是**回路**本身，而不是门禁的确认人配置。
     */
    const reassigned = ledger.handlers.assign_task({ id: taskId, assignee: 'bot:dev', actor: 'human:owner' })
    assert.equal(reassigned.ok, true, JSON.stringify(reassigned))
    assert.equal(reassigned.state, 'assigned')
    assert.equal(ledger.store.get('task', taskId).assignee, 'bot:dev')

    const accepted = ledger.handlers.accept_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(accepted.ok, true, JSON.stringify(accepted))
    const started = ledger.handlers.start_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.state, 'in_progress')

    // 阻塞必须给原因（否则后来的人不知道当时卡在哪），解除后回到进行中
    const noReason = ledger.handlers.block_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(noReason.ok, false)
    assert.equal(noReason.code, 'bad_request')
    const blocked = ledger.handlers.block_task({ id: taskId, note: '等支付网关联调', actor: 'bot:dev' })
    assert.equal(blocked.ok, true, JSON.stringify(blocked))
    assert.equal(ledger.store.get('task', taskId).blocked_reason, '等支付网关联调')
    const unblocked = ledger.handlers.unblock_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(unblocked.ok, true, JSON.stringify(unblocked))
    assert.equal(unblocked.state, 'in_progress')
    assert.equal(ledger.store.get('task', taskId).blocked_reason, null, '解除后原因不该继续挂着')

    // 验收打回：in_review → in_progress，且执行者不能打回自己的产出
    const ran = await ledger.handlers.run_task({ id: taskId })
    assert.equal(ran.ok, true, JSON.stringify(ran))
    assert.equal(ledger.store.get('task', taskId).state, 'in_review')
    const selfReject = ledger.handlers.reject_review({ id: taskId, actor: 'bot:dev' })
    assert.equal(selfReject.ok, false)
    assert.equal(selfReject.code, 'self_review')
    const sentBack = ledger.handlers.reject_review({ id: taskId, actor: 'human:owner', note: '缺单测' })
    assert.equal(sentBack.ok, true, JSON.stringify(sentBack))
    assert.equal(sentBack.state, 'in_progress')
    assert.equal(
      ledger.store.get('task', taskId).history.some((one) => String(one.reason ?? '').includes('缺单测')),
      true,
      '打回的理由要留在历史里（`reason` 是人为什么这么决定，和系统要做什么的 effects 分开）',
    )
  } finally {
    ledger.cleanup()
  }
})

test('a decision is a real object now: adr-<year>-<seq>, linked both ways', async () => {
  /*
   * 设计 06 §6 的第四个一等对象。它此前只有 schema：`parseDecision` 除测试没人调用，
   * 而且 store 生成 `dec-` 前缀、schema 却只认 `adr-` —— 真去造一条立刻校验失败。
   * 生成规则与校验规则是同一件事的两半，分开放就会互相打架。
   */
  const ledger = makeLedger()
  try {
    const created = ledger.handlers.create_requirement({ title: '重试', owner: 'human:owner', problem: '没有重试' })
    const decision = ledger.handlers.record_decision({
      title: '重试上限用 3 次',
      req: created.id,
      note: '无限重试会打爆下游',
      actor: 'human:owner',
    })
    assert.equal(decision.ok, true, JSON.stringify(decision))
    assert.match(decision.id, /^adr-\d{4}-\d{3}$/)
    // 双向可追：需求那一侧也记着这条决策（设计 06 §2）。
    assert.deepEqual(ledger.store.get('requirement', created.id).decisions, [decision.id])
    const listed = ledger.handlers.list({ kind: 'decision' })
    assert.equal(listed.rows.length, 1)
    assert.equal(listed.rows[0].title, '重试上限用 3 次')

    const untitled = ledger.handlers.record_decision({ actor: 'human:owner' })
    assert.equal(untitled.ok, false)
    assert.equal(untitled.code, 'bad_request')
  } finally {
    ledger.cleanup()
  }
})

test('转派会重置门禁并释放旧租约（"新执行者仍需点接受"不能只是文案）', async () => {
  const ledger = makeLedger()
  try {
    const created = ledger.handlers.create_requirement({ title: '转派', owner: 'human:owner', problem: 'p' })
    ledger.handlers.confirm_requirement({ id: created.id, actor: 'human:owner' })
    const proposed = ledger.handlers.propose_tasks({ id: created.id, tasks: [{ title: 'T', assignee: 'bot:dev' }] })
    const taskId = proposed.tasks[0].id
    ledger.handlers.confirm_split({ id: created.id, actor: 'human:owner' })

    // 机器人承接 → 起租约（`reassign` 只在 accepted 上可用：接手之后才谈得上转派）
    const took = ledger.handlers.accept_task({ id: taskId, actor: 'bot:dev' })
    assert.equal(took.ok, true, JSON.stringify(took))
    assert.equal(ledger.store.get('lease', taskId).state, 'active')

    // 同一个人不能"转派给自己"（先说清楚，再动真的）
    const same = ledger.handlers.reassign_task({ id: taskId, assignee: 'bot:dev', actor: 'human:owner' })
    assert.equal(same.ok, false)
    assert.equal(same.code, 'no_change')

    // 转派给真人：门禁重置、租约释放
    const moved = ledger.handlers.reassign_task({ id: taskId, assignee: 'human:zhouyu', actor: 'human:owner' })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    const task = ledger.store.get('task', taskId)
    assert.equal(task.assignee, 'human:zhouyu')
    assert.equal(task.state, 'assigned')
    assert.equal(task.gates.accept.not_applicable, false)
    assert.equal(task.gates.accept.required_by.includes('human:zhouyu'), true, '确认人换成了新执行者')
    assert.equal(task.gates.accept.due_at !== null, true, '而且重新开始计时')
    assert.equal(ledger.store.get('lease', taskId).state, 'released', '旧租约不再代表当前执行者')
  } finally {
    ledger.cleanup()
  }
})

test('需求负责人总能验收（哪怕他不是任何角色域的负责人）', async () => {
  /*
   * 设计 00 §5.1："多人协作由主 owner 确认"。可验收人名单以前只算"任务跨越的域负责人
   * + pm"，于是**需求负责人自己反而点不动**自己需求下的验收 —— 除非他碰巧还兼着某个域
   * 或 pm。一个人不能验收自己的需求，这不是设计要的。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-acceptor-'))
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    /*
     * 需求负责人 human:pm1 既不是 development 域的负责人，也不是 pm 域的成员。
     * `human:outsider` 是**在名册里、但跟这个任务无关**的人：用来验"成员闸放过了他、
     * 状态机仍然拒绝他"这条分工（两层闸各管各的）。
     */
    members: {
      pm: ['human:someone-else'],
      requirement: ['human:pm1'],
      development: ['human:dev'],
      docs: ['human:outsider'],
    },
  })
  const agents = {
    get: () => undefined,
    async create(options) {
      return { agent: new FakeAgent(options.sessionId), dispose: async () => {} }
    },
    async resume() {
      throw new Error('no such session')
    },
  }
  const ctx = { get: (name) => (name === 'agents' ? agents : undefined), effect: (factory) => factory() }
  const store = new Store(dir).load()
  const pool = new SessionPool(ctx, config)
  const handlers = createHandlers({ ctx, config, store, pool })
  try {
    const req = handlers.create_requirement({ title: '验收人', owner: 'human:pm1', problem: 'p' })
    handlers.confirm_requirement({ id: req.id, actor: 'human:pm1' })
    const proposed = handlers.propose_tasks({ id: req.id, tasks: [{ title: 'T', assignee: 'bot:dev', domains: ['development'] }] })
    handlers.confirm_split({ id: req.id, actor: 'human:pm1' })
    const taskId = proposed.tasks[0].id
    const ran = await handlers.run_task({ id: taskId })
    assert.equal(ran.ok, true, JSON.stringify(ran))

    /*
     * 两层闸各管各的：
     *   · 名册之外的人**第一层就挡住**（成员闸）—— 名册非空时它是白名单；
     *   · 名册之内、但跟这个任务无关的人，由状态机拒绝（`forbidden`）。
     */
    const notMember = handlers.verify_task({ id: taskId, actor: 'human:nobody' })
    assert.equal(notMember.ok, false)
    assert.equal(notMember.code, 'not_a_member')
    const outsider = handlers.verify_task({ id: taskId, actor: 'human:outsider' })
    assert.equal(outsider.ok, false)
    assert.equal(outsider.code, 'forbidden')

    const verified = handlers.verify_task({ id: taskId, actor: 'human:pm1' })
    assert.equal(verified.ok, true, JSON.stringify(verified))
    assert.equal(verified.state, 'done')
  } finally {
    pool.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('任务类型决定谁进确认名单（跨域任务是多个确认人）', async () => {
  /*
   * 设计 03 §2.4② / 02 §5.4：任务类型 → 所需域，而所需域决定**谁会进确认名单**。
   * 以前 `domains` 完全由模型现给，于是"这活算开发还是算测试"取决于模型当天怎么想。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-tasktype-'))
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    members: { requirement: ['human:pm1'], development: ['human:dev'], testing: ['human:qa'] },
  })
  const store = new Store(dir).load()
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => {}, drive: async () => ({}) },
  })
  try {
    const req = handlers.create_requirement({ title: '跨域', owner: 'human:pm1', problem: 'p' })
    handlers.confirm_requirement({ id: req.id, actor: 'human:pm1' })
    // 不给 domains：由类型推导（feature_delivery → development + testing）
    const proposed = handlers.propose_tasks({
      id: req.id,
      tasks: [{ title: '功能交付', type: 'feature_delivery', assignee: 'bot:dev' }],
    })
    assert.equal(proposed.ok, true, JSON.stringify(proposed))
    const task = store.get('task', proposed.tasks[0].id)
    assert.deepEqual(task.domains, ['development', 'testing'], '域由任务类型推导')
    assert.deepEqual(
      task.gates.acceptance.required_by,
      ['human:pm1', 'human:dev', 'human:qa'],
      '需求负责人 + 两个域的负责人都要确认（缺一方不推进）',
    )

    // 显式给 domains 时以调用方为准（模型知道得更细的情况）
    const explicit = handlers.propose_tasks({
      id: req.id,
      tasks: [{ title: '只改文档', type: 'doc_update', domains: ['docs'], assignee: 'bot:dev' }],
    })
    assert.equal(explicit.ok, true)
    assert.deepEqual(store.get('task', explicit.tasks[0].id).domains, ['docs'])

    // 认不出的类型：仍然建得出来，但**必须报出来**（静默按开发域走最坏）
    const typo = handlers.propose_tasks({ id: req.id, tasks: [{ title: '拼错的类型', type: 'code_chagne', assignee: 'bot:dev' }] })
    assert.equal(typo.ok, true)
    assert.deepEqual(typo.unknown_types, ['code_chagne'])
    assert.deepEqual(store.get('task', typo.tasks[0].id).domains, ['development'], '兜底域')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('域里没人时由 fallback 顶上，并且记成"代确认"（R5.6）', async () => {
  /*
   * "域里没人"不等于这道门禁可以悄悄过：配置里写了 `domainFallbacks[域]` 就由它顶上。
   * 但顶上的人和本域负责人不是一回事 —— 卡片要能写出"代"字（见 `taskConfirmLine`），
   * 所以建任务时就得把"谁是替身"冻结进门禁。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-standin-'))
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    members: { requirement: ['human:pm1'], development: ['human:dev'], testing: [] },
    domainFallbacks: { testing: 'human:qa-lead' },
  })
  const store = new Store(dir).load()
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => {}, drive: async () => ({}) },
  })
  try {
    const req = handlers.create_requirement({ title: '测试域没人', owner: 'human:pm1', problem: 'p' })
    handlers.confirm_requirement({ id: req.id, actor: 'human:pm1' })
    const proposed = handlers.propose_tasks({ id: req.id, tasks: [{ title: 'T', type: 'feature_delivery', assignee: 'bot:dev' }] })
    const task = store.get('task', proposed.tasks[0].id)
    assert.deepEqual(task.domains, ['development', 'testing'])
    assert.ok(task.gates.acceptance.required_by.includes('human:qa-lead'), '空域由 fallback 顶上')
    assert.deepEqual(task.gates.acceptance.stand_ins, ['human:qa-lead'], '替身要标出来，否则卡片分不清它是谁')
    assert.ok(!task.gates.acceptance.stand_ins.includes('human:dev'), '本域负责人不是替身')
    // 重新读一遍（走 schema 校验）也还在：它是门禁的一部分，不是内存里的临时标记
    assert.deepEqual(store.get('task', task.id).gates.acceptance.stand_ins, ['human:qa-lead'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('成员表真的拦人：观察者只读、停用的要走代理、canApprove 是白名单', async () => {
  /*
   * 设计 02 §2 + 05 §3.2 的三档权限。以前成员表的 `role` 与 `canApprove`
   * **零消费者** —— "观察者不能改台账"在代码里没有任何落点。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-roleguard-'))
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    members: [
      { key: 'human:pm1', name: 'PM', role: 'owner', domains: ['requirement'], canApprove: [] },
      { key: 'human:watcher', name: '旁观者', role: 'observer', domains: ['development'] },
      { key: 'human:away', name: '休假的人', role: 'member', domains: ['development'], active: false },
      { key: 'human:limited', name: '只管合并的人', role: 'member', domains: ['development'], canApprove: ['merge'] },
    ],
  })
  const store = new Store(dir).load()
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => {}, drive: async () => ({}) },
  })
  try {
    const req = handlers.create_requirement({ title: '权限', owner: 'human:pm1', problem: 'p' })
    handlers.confirm_requirement({ id: req.id, actor: 'human:pm1' })
    const proposed = handlers.propose_tasks({ id: req.id, tasks: [{ title: 'T', assignee: 'bot:dev', domains: ['development'] }] })
    const taskId = proposed.tasks[0].id
    handlers.confirm_split({ id: req.id, actor: 'human:pm1' })

    // 观察者：连"接活"都不行（只读）
    const watcher = handlers.accept_task({ id: taskId, actor: 'human:watcher' })
    assert.equal(watcher.ok, false)
    assert.equal(watcher.code, 'member_readonly')
    assert.match(watcher.message, /观察者/)

    // 停用且无代理：明确说"请他别的人来"，而不是默默通过
    const away = handlers.accept_task({ id: taskId, actor: 'human:away' })
    assert.equal(away.ok, false)
    assert.equal(away.code, 'member_readonly')
    assert.match(away.message, /已停用/)

    // canApprove 是白名单：只管合并的人不能验收
    const ran = await handlers.run_task({ id: taskId })
    assert.equal(ran.ok, true, JSON.stringify(ran))
    const limited = handlers.verify_task({ id: taskId, actor: 'human:limited' })
    assert.equal(limited.ok, false)
    assert.equal(limited.code, 'member_readonly')
    assert.match(limited.message, /canApprove/)

    // 有权限的人照常
    const ok = handlers.verify_task({ id: taskId, actor: 'human:pm1' })
    assert.equal(ok.ok, true, JSON.stringify(ok))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('机器人的能力与作用域真的拦住执行（"需求机器人不该有写代码的权限"）', async () => {
  /*
   * 设计 02 §1.1 那张"绝不能做什么"的表：`permissions.cannot` 与 `scope.repos`
   * 以前只是字段。这里测的是它们**真的会拒绝**，而且拒绝得说得清原因。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-botperm-'))
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    bots: [
      { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
      // 只该动 pay-service 的开发机器人
      { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, scope: { repos: ['pay-service'] } },
    ],
    members: { requirement: ['human:pm1'], development: ['human:dev'] },
  })
  const store = new Store(dir).load()
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => {}, drive: async () => ({ text: 'done', timedOut: false }) },
  })
  try {
    const mk = (label, assignee, repo) => {
      const req = handlers.create_requirement({ title: label, owner: 'human:pm1', problem: 'p', repos: repo === null ? [] : [repo] })
      handlers.confirm_requirement({ id: req.id, actor: 'human:pm1' })
      const proposed = handlers.propose_tasks({ id: req.id, tasks: [{ title: label, type: 'code_change', assignee, repo }] })
      handlers.confirm_split({ id: req.id, actor: 'human:pm1' })
      return proposed.tasks[0].id
    }

    // 需求机器人接代码任务：按角色默认表就该被拒
    const reqTask = mk('需求机器人跑代码', 'bot:req')
    const refused = await handlers.run_task({ id: reqTask })
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.code, 'bot_not_allowed')
    assert.match(refused.message, /不能 write_code|不能 run_task/)

    // 开发机器人碰 scope 之外的仓库：拒
    const outOfScope = mk('动别的仓库', 'bot:dev', 'other-service')
    const scopeRefused = await handlers.run_task({ id: outOfScope })
    assert.equal(scopeRefused.ok, false, JSON.stringify(scopeRefused))
    assert.equal(scopeRefused.code, 'bot_out_of_scope')
    assert.match(scopeRefused.message, /scope\.repos/)

    // 作用域内的仓库：放行
    const inScope = mk('动自己的仓库', 'bot:dev', 'pay-service')
    const ran = await handlers.run_task({ id: inScope })
    assert.equal(ran.ok, true, JSON.stringify(ran))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
