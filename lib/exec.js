/*
 * The heart: driving a real DSH session for one task.
 *
 * WHY THIS FILE EXISTS. The external Hub this plugin replaces could move a task
 * through its state machine, render cards, and enforce gates — and never once
 * ran anything. Every "in_progress" was a human clicking a button. This is the
 * part that only the plugin form can do: the agent service is in-process, so a
 * task can be handed to a live session, driven for one turn, and its report
 * read back into the ledger as evidence.
 *
 * THREE DECISIONS WORTH KNOWING.
 *
 * 1. OWNERSHIP IS A CAPABILITY. `agents.create`/`resume` hand back an
 *    `AgentHandle` whose `dispose()` tears down exactly that agent. The pool
 *    owns every handle it creates through `ctx.effect`, so unloading the row
 *    (or exceeding `maxLive`) releases the sessions it started rather than
 *    leaking live agents into a harness that outlives this plugin.
 *
 * 2. A TURN IS OVER WHEN THE DRIVER SAYS SO. There is no exported
 *    `waitForWorkToSettle` — the driver's own contract is `agent.status` plus
 *    `whenIdle()`, and the session log's `turn/end` event is the durable echo
 *    of the same fact. So the wait is: poll the status until the agent has been
 *    seen running and is running no longer, then await `whenIdle()` so a turn
 *    that closes between two polls still cannot be missed. The timeout is real:
 *    a model that never answers must not pin a task forever.
 *
 * 3. THE REPORT IS READ FROM THE LOG, NOT FROM THE EVENT FIREHOSE. Events are
 *    a convenience; `session.snapshotEvents(fromSeq)` is the session's own
 *    record and works even for an agent whose events this plugin never saw.
 *    Everything the model said during the driven turn is there, in order.
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'

/**
 * Whether two path spellings name the same directory.
 *
 * Compared through `realpath` because on macOS `/tmp/x` and `/private/tmp/x` are
 * the same place written two ways, and a session header stores the canonical
 * spelling while a config may hold either. A plain string compare would declare
 * a mismatch for every /tmp workspace and quietly start a fresh session on every
 * single message.
 */
export function sameDirectory(a, b) {
  const canonical = (value) => {
    try {
      return realpathSync(value)
    } catch (error) {
      return String(value).replace(/\/+$/, '')
    }
  }
  return canonical(a) === canonical(b)
}

/** Sleep that cannot outlive its own cancellation. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** Message id for a plugin-authored user message; the id is opaque to the loop. */
function newMessageId() {
  return 'team-' + randomUUID()
}

/** Text of one message's content blocks, ignoring non-text blocks entirely. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Last assistant text inside a run of session events.
 *
 * The LAST one, not the concatenation: a turn may contain several assistant
 * messages (one per step, with tool calls between them), and the final message
 * is the one written as a report. Earlier steps are working notes.
 */
export function lastAssistantText(events) {
  let last = ''
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'assistant/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    if (data.interrupted === true) continue
    const message = data.message
    if (message === null || typeof message !== 'object') continue
    const text = textOf(message.content)
    if (text !== '') last = text
  }
  return last
}

/**
 * Owns the worker sessions this plugin starts.
 *
 * Sessions are reused per task: the same agent keeps the context of what it
 * already did, which is the difference between "an agent ran a task" and "an
 * agent was handed a task description with amnesia".
 */
export class SessionPool {
  /**
   * @param {object} ctx the Cordis context (for `ctx.get`/`ctx.effect`/`ctx.on`)
   * @param {object} config resolved team configuration
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<string, {agent: object, handle: object|null, lastUsed: number}>} */
    this.live = new Map()
    this.disposed = false
    /** Set when `agents.create`/`resume` fail, so the tool can report why once. */
    this.lastOpenError = null
  }

  #agents() {
    if (this.disposed) return null
    try {
      return this.ctx.get('agents') ?? null
    } catch (error) {
      return null
    }
  }

  /**
   * Agent preset for a session.
   *
   * Resolution order — the BOT first, then its role, then the global default:
   *
   *   1. `spec.preset`, which is the bot's own `agentPreset`. A bot is an agent
   *      with a role, so a roster entry that names a preset must WIN over the
   *      role mapping: otherwise "this bot runs as the code-reviewer preset" would
   *      be silently reduced to "this bot runs as every other dev bot".
   *   2. `sessions.presets[role]`, the per-role mapping.
   *   3. `sessions.preset`, the installation default.
   */
  presetFor(role, explicit) {
    if (typeof explicit === 'string' && explicit !== '') return explicit
    const sessions = this.config.sessions
    const byRole = sessions.presets !== null && typeof sessions.presets === 'object' ? sessions.presets : {}
    return byRole[role] ?? sessions.preset ?? undefined
  }

  /**
   * Fill any model field the configuration left open from the deployment's own
   * default selection.
   *
   * This is not a nicety: without a model, prompt assembly fails outright (see
   * the note in {@link open}). The service is read optionally — a profile that
   * has no `agentDefaultModel` simply keeps the configured values.
   */
  #fillModelDefaults(agentOptions) {
    if (agentOptions.provider !== undefined && agentOptions.model !== undefined) return
    let selection = null
    try {
      const service = typeof this.ctx.get === 'function' ? this.ctx.get('agentDefaultModel') : undefined
      if (service !== undefined && service !== null && typeof service.currentSelection === 'function') {
        selection = service.currentSelection()
      }
    } catch (error) {
      selection = null
    }
    if (selection === null || typeof selection !== 'object') return
    if (agentOptions.provider === undefined && typeof selection.provider === 'string') agentOptions.provider = selection.provider
    if (agentOptions.model === undefined && typeof selection.model === 'string') agentOptions.model = selection.model
    if (agentOptions.reasoningEffort === undefined && selection.reasoningEffort !== undefined) {
      agentOptions.reasoningEffort = selection.reasoningEffort
    }
  }

  /**
   * A live agent for one session id, creating or resuming it as needed.
   *
   * @param {object} spec `{ sessionId, role, cwd, preset?, model?, provider? }`
   * @returns {Promise<object>} the live agent
   */
  async open(spec) {
    const agents = this.#agents()
    if (agents === null) throw new Error('the agents service is unavailable in this profile')

    const existing = this.live.get(spec.sessionId)
    if (existing !== undefined) {
      existing.lastUsed = Date.now()
      return existing.agent
    }

    const live = agents.get(spec.sessionId)
    if (live !== undefined && live !== null) {
      this.live.set(spec.sessionId, { agent: live, handle: null, lastUsed: Date.now() })
      return live
    }

    const sessions = this.config.sessions
    const agentOptions = {}
    if (sessions.provider !== null) agentOptions.provider = sessions.provider
    if (sessions.model !== null) agentOptions.model = sessions.model
    if (sessions.reasoningEffort !== null) agentOptions.reasoningEffort = sessions.reasoningEffort
    /*
     * A bot's own model beats the installation default, for the same reason its
     * preset does: the roster says "this one runs on the fast model", and a role
     * mapping that overrode it would make the field a decoration. `provider` is
     * left alone here so `#fillModelDefaults` can still fill it — a bot naming only
     * a model must not lose its provider.
     */
    if (typeof spec.model === 'string' && spec.model !== '') agentOptions.model = spec.model
    if (typeof spec.provider === 'string' && spec.provider !== '') agentOptions.provider = spec.provider

    /*
     * A worker session MUST carry a resolved model.
     *
     * Learned the hard way, from a real run: the deployment's persona section
     * is assembled from `{{model}}`, and that variable reads
     * `agent.options.model` — so a session created with empty agent options
     * fails prompt assembly outright with
     *   prompt variable "{{model}}" has no value for this assembly
     * and its turn ends as `error` with nothing said. Interactive paths never
     * hit this because the app resolves the deployment default for them; a
     * plugin that calls `agents.create` has to do it itself.
     */
    this.#fillModelDefaults(agentOptions)

    this.lastOpenError = null
    let handle = null
    try {
      handle = await agents.resume({ resumeSessionId: spec.sessionId, agentOptions })
    } catch (error) {
      // A session that was never persisted (or a profile without session
      // persistence) is not an error worth surfacing: create a fresh one.
      this.lastOpenError = String(error && error.message ? error.message : error)
    }

    /*
     * A RESUMED SESSION MUST LIVE WHERE WE ASKED IT TO.
     *
     * A session's cwd is fixed when it is created, so resuming one from another
     * directory answers in the wrong project with the wrong history — silently,
     * because everything "works". This is not hypothetical: the team plugin's
     * first chat-session ids collided with the ones an earlier Feishu bridge had
     * used, so `resume` cheerfully loaded that bridge's conversation inside a
     * different project's workspace, and the chat never appeared under the team
     * workspace where it belonged.
     *
     * A mismatch therefore starts a fresh session under a generation-suffixed id
     * and says so. The caller reads the real id back from `agent.id`.
     */
    let sessionId = spec.sessionId
    if (handle !== null && typeof spec.cwd === 'string' && spec.cwd !== '') {
      const actual = handle.agent?.session?.header?.cwd
      if (typeof actual === 'string' && actual !== '' && !sameDirectory(actual, spec.cwd)) {
        console.error(
          '[team] session ' + spec.sessionId + ' belongs to ' + actual + ', not ' + spec.cwd + ' — starting a fresh one',
        )
        try {
          await handle.dispose()
        } catch (error) {
          /* it is about to be replaced anyway */
        }
        handle = null
        sessionId = spec.sessionId + '-g' + String(Date.now())
      }
    }

    if (handle === null) {
      const meta = { cwd: spec.cwd }
      const preset = this.presetFor(spec.role, spec.preset)
      // Only name a preset when one is configured: an explicit `undefined`
      // would override the deployment default with nothing.
      if (typeof preset === 'string' && preset !== '') meta.agentPreset = preset
      handle = await agents.create({
        sessionId,
        meta,
        agentOptions,
      })
    }

    /*
     * Ownership. The handle's disposer is registered on the plugin's fiber, so
     * unloading the row takes the worker sessions with it. `ctx.effect` may be
     * absent in a bare test context, hence the guard.
     */
    const dispose = () => {
      Promise.resolve()
        .then(() => handle.dispose())
        .catch(() => {})
    }
    if (this.ctx !== null && typeof this.ctx.effect === 'function') {
      this.ctx.effect(() => dispose)
    }

    this.live.set(spec.sessionId, { agent: handle.agent, handle, lastUsed: Date.now() })
    this.#enforceCap()
    return handle.agent
  }

  /** Dispose the least recently used worker sessions beyond the configured cap. */
  #enforceCap() {
    const cap = Number(this.config.sessions.maxLive)
    if (!Number.isFinite(cap) || cap <= 0) return
    while (this.live.size > cap) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, entry] of this.live) {
        if (entry.lastUsed < oldestAt) {
          oldestAt = entry.lastUsed
          oldestKey = key
        }
      }
      if (oldestKey === null) return
      this.#release(oldestKey)
    }
  }

  #release(sessionId) {
    const entry = this.live.get(sessionId)
    if (entry === undefined) return
    this.live.delete(sessionId)
    if (entry.handle !== null) {
      Promise.resolve()
        .then(() => entry.handle.dispose())
        .catch(() => {})
    }
  }

  /**
   * Send one message and wait for the turn it opens to close.
   *
   * @param {object} agent a live agent from {@link open}
   * @param {string} text the message body
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{text: string, timedOut: boolean, seq: number, elapsedMs: number,
   *   steps: number, toolCalls: number, tokens: {value: number, source: string}|null}>}
   *   `tokens` 是 `null`，而不是 0 —— 卡片 footer 对没上报的字段整段不显示，
   *   所以"没有数据"必须在类型上就能与"用了 0 个 token"区分开。
   */
  async drive(agent, text, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Number(options.timeoutMs)
      : Number(this.config.sessions.turnTimeoutMs)
    const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
    const startSeq = session !== undefined && typeof session.seq === 'number' ? Number(session.seq) : 0
    const startedAt = Date.now()

    /*
     * The event listener only accelerates the wait; correctness comes from the
     * status poll and `whenIdle()` below, so a profile that never delivers
     * events to this listener still drives turns correctly.
     */
    let turnEnded = false
    let off = null
    if (typeof this.ctx.on === 'function') {
      try {
        off = this.ctx.on('session/event', (seen, event) => {
          if (seen === undefined || seen === null || event === undefined || event === null) return
          if (session !== undefined && seen.id !== session.id) return
          if (event.type === 'turn/end' && Number(event.seq) >= startSeq) turnEnded = true
        })
      } catch (error) {
        off = null
      }
    }

    agent.followup({
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'team', form: 'relay' },
    })

    const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 900000)
    let sawRunning = false
    let timedOut = true
    while (Date.now() < deadline) {
      await sleep(100)
      const status = statusOf(agent)
      if (status === 'running') sawRunning = true
      if (turnEnded && status !== 'running') {
        timedOut = false
        break
      }
      if (sawRunning && status !== 'running') {
        timedOut = false
        break
      }
      // A very fast turn can start and finish without the poll ever seeing
      // `running`; the log growing past the turn boundary is the evidence.
      if (!sawRunning && session !== undefined && Number(session.seq) > startSeq && status !== 'running') {
        timedOut = false
        break
      }
    }

    /*
     * `whenIdle()` is the driver's own promise. It is awaited with a short
     * bound rather than trusted blindly: a hung driver must not hang the tool
     * call that is waiting on this task.
     */
    if (typeof agent.whenIdle === 'function') {
      await Promise.race([
        Promise.resolve().then(() => agent.whenIdle()).catch(() => {}),
        sleep(2000),
      ])
    }
    if (typeof off === 'function') {
      try {
        off()
      } catch (error) {
        /* the listener is already gone */
      }
    }

    let collected = ''
    let events = []
    if (session !== undefined && typeof session.snapshotEvents === 'function') {
      try {
        events = session.snapshotEvents(startSeq) ?? []
        collected = lastAssistantText(events)
      } catch (error) {
        events = []
        collected = ''
      }
    }
    /*
     * 这一轮的**事实**：多久、用了几步、花了多少 token。它们只进卡片 footer
     * （设计 04 §3.1 的"footer note：耗时、token、进度步数"），所以每一个都
     * 只在**真的有数据**时才上报 —— provider 不上报 token 时这里是 null，
     * 而不是 0：卡片上"🧠 0 tok"是谎报，删掉那一段才是诚实。
     */
    const toolCalls = events.filter((event) => event !== null && typeof event === 'object' && event.type === 'tool/call').length
    return {
      text: collected,
      timedOut,
      seq: startSeq,
      elapsedMs: Date.now() - startedAt,
      steps: toolCalls,
      toolCalls,
      tokens: this.#measureTokens(session),
    }
  }

  /**
   * 本轮用了多少 token。
   *
   * `tokenMeter` 是**可选**服务（它随 web bundle 一起来，headless 里可能没有），
   * 所以这里读不到就返回 null。`baseline.kind === 'usage'` 时那是 provider 真报的数；
   * `estimated` 是按固定密度估的 —— 两种都要如实标出来源，不能混成一个数。
   */
  #measureTokens(session) {
    if (session === undefined || session === null) return null
    let meter = null
    try {
      meter = typeof this.ctx?.get === 'function' ? this.ctx.get('tokenMeter') : null
    } catch (error) {
      meter = null
    }
    if (meter === null || meter === undefined || typeof meter.measure !== 'function') return null
    try {
      const measured = meter.measure(session)
      const kind = measured?.baseline?.kind
      const value = Number(measured?.totalTokens)
      if (!Number.isFinite(value) || value <= 0) return null
      if (kind === 'usage') return { value, source: 'usage' }
      if (kind === 'estimated') return { value, source: 'estimated' }
      return null
    } catch (error) {
      // 量不出来不影响这一轮的结果：只是卡片上少一段灰字。
      return null
    }
  }

  /** Stop every worker session this pool started. Idempotent. */
  dispose() {
    this.disposed = true
    for (const key of [...this.live.keys()]) this.#release(key)
  }
}

/** Agent status without assuming the driver exposes the getter. */
function statusOf(agent) {
  try {
    const status = agent.status
    return typeof status === 'string' ? status : 'idle'
  } catch (error) {
    return 'idle'
  }
}

/**
 * The prompt a worker session receives for one task.
 *
 * Kept deliberately plain: the task object already carries the acceptance
 * criteria and the requirement's problem statement, and the worker is an agent
 * with the same harness the operator uses. Over-scripting the prompt would just
 * be a worse version of the tool descriptions the model already reads.
 */
export function taskPrompt(task, requirement, extra = {}) {
  const lines = []
  lines.push('你是团队协作系统里的执行者。请完成下面这个任务，并在结束时用一段简短的中文汇报：做了什么、动了哪些文件、怎么验证的、还有什么没做完。')
  lines.push('')
  lines.push('任务 ' + task.id + '：' + task.title)
  if (requirement !== null && requirement !== undefined) {
    lines.push('所属需求 ' + requirement.id + '：' + requirement.title)
    if (requirement.body !== null && typeof requirement.body === 'object') {
      if (typeof requirement.body.problem === 'string' && requirement.body.problem !== '') {
        lines.push('背景（问题）：' + requirement.body.problem)
      }
      if (typeof requirement.body.proposal === 'string' && requirement.body.proposal !== '') {
        lines.push('建议方案：' + requirement.body.proposal)
      }
    }
  }
  const criteria = Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : []
  if (criteria.length > 0) {
    lines.push('验收标准：')
    for (const item of criteria) lines.push('  - ' + String(item))
  }
  if (typeof task.repo === 'string' && task.repo !== '') lines.push('代码库：' + task.repo)
  if (typeof extra.note === 'string' && extra.note !== '') {
    lines.push('')
    lines.push('补充说明：' + extra.note)
  }
  lines.push('')
  lines.push('工作目录就是团队工作区，直接在里面动手；不要修改团队台账（' + '_meta/' + '）里的对象文件。')
  return lines.join('\n')
}
