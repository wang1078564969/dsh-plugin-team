/*
 * Ingest: one group message in, one ledger object (or one recorded reason) out.
 *
 * THE RULE THAT SHAPES THIS FILE: nothing is ever silently dropped. A message
 * either becomes a requirement, or it becomes a row with an `ignored_reason`
 * saying why not. The Hub learned this the expensive way — un-@-ed chatter in a
 * group was neither consumed nor marked, so the next requirement swallowed
 * eleven messages of small talk as its body, and nothing in the data said so.
 *
 * TWO WAYS A GROUP TALKS TO THE LEDGER, and they are deliberately different:
 *
 *   commands  `接受 task-1` / `开始 task-1` / `验收 task-1` / `状态`
 *             A human deciding. Routed straight to the state machine, whose
 *             refusal (wrong person, wrong state) is reported back verbatim.
 *
 *   prose     everything else. Triage decides whether it is a requirement, and
 *             only then does extraction run.
 *
 * WHY TEXT COMMANDS AND NOT CARD BUTTONS. Buttons need Feishu to reach an HTTPS
 * callback, and this harness's web server listens on 127.0.0.1 — so a button
 * would be a promise the deployment cannot keep. The card design already has a
 * "buttons removed, replaced by a text instruction" rung for exactly this
 * reason; here that rung is the default, and the same verbs work either way.
 *
 * DEDUPLICATION IS PERSISTENT. Feishu redelivers events, and a redelivered
 * message must not become a second requirement. The key is the MESSAGE id (the
 * event id changes on redelivery in some paths), and the log is append-only
 * JSONL rather than one file per message: at 30 messages a day a year of
 * one-file-per-message is ten thousand files, which is precisely what made the
 * Hub move this data into SQLite.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The verbs a group may use, with the Chinese words an operator would type. */
export const DEFAULT_COMMANDS = {
  accept_task: ['接受', '接了', 'accept'],
  start_task: ['开始', 'start'],
  verify_task: ['验收', '通过', 'verify'],
  reject_review: ['打回', '返工', 'reject_review'],
  reject_task: ['拒绝', 'reject'],
  block_task: ['阻塞', 'block'],
  unblock_task: ['解除', '恢复', 'unblock'],
  reassign_task: ['转派', '改派', 'reassign'],
  status: ['状态', '台账', 'status'],
}

/**
 * Parse one group message as a command.
 *
 * Deliberately strict about the shape `<verb> <object-id>`: a loose parse would
 * turn ordinary prose into accidental state changes, and a wrong transition is
 * much worse than a message that simply does not parse.
 *
 * @returns {{action: string, id: string|null, verb: string}|null}
 */
export function parseCommand(text, commands = DEFAULT_COMMANDS) {
  const trimmed = String(text ?? '').trim().replace(/^@\S+\s*/, '')
  if (trimmed === '') return null
  const match = /^(\S+)\s*([A-Za-z][\w-]*)?\s*$/.exec(trimmed)
  if (match === null) return null
  const verb = match[1]
  const id = typeof match[2] === 'string' && match[2] !== '' ? match[2] : null
  for (const [action, words] of Object.entries(commands)) {
    if (!Array.isArray(words) || !words.includes(verb)) continue
    if (action === 'status') return { action, id: null, verb }
    // Every other verb acts on one object; without an id there is nothing to act on.
    if (id === null) return null
    return { action, id, verb }
  }
  return null
}

/** Whether a message addresses the bot directly (an @-mention survived the bridge). */
export function looksAddressed(text) {
  return /(^|\s)@\S/.test(String(text ?? ''))
}

/**
 * The append-only record of everything that arrived from a group.
 *
 * One line per observation or update; the last line for a message id wins. That
 * keeps appends O(1) and leaves a file a human can read with `tail`, which is
 * the same escape hatch the object store has.
 */
export class Inbox {
  constructor(root) {
    this.path = join(root, 'inbox', 'messages.jsonl')
    /** @type {Map<string, object>} */
    this.records = new Map()
    this.loaded = false
  }

  load() {
    if (!existsSync(this.path)) {
      this.loaded = true
      return this
    }
    try {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const doc = JSON.parse(line)
        if (doc !== null && typeof doc === 'object' && typeof doc.message_id === 'string') this.records.set(doc.message_id, doc)
      }
    } catch (error) {
      console.error('[team] the inbound log at ' + this.path + ' is damaged; continuing from what could be read: ' + String(error && error.message ? error.message : error))
    }
    this.loaded = true
    return this
  }

  #ensure() {
    if (!this.loaded) this.load()
  }

  seen(messageId) {
    this.#ensure()
    return this.records.has(String(messageId))
  }

  get(messageId) {
    this.#ensure()
    return this.records.get(String(messageId)) ?? null
  }

  record(message, patch = {}) {
    this.#ensure()
    const id = String(message.message_id)
    const previous = this.records.get(id) ?? {}
    const doc = { ...previous, ...message, ...patch, message_id: id }
    this.records.set(id, doc)
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(doc) + '\n', 'utf8')
    return doc
  }

  /** Mark a message as consumed by a requirement (so 漏单检测 can be a scan). */
  consume(messageId, requirementId) {
    const previous = this.get(messageId)
    if (previous === null) return null
    const consumed = Array.isArray(previous.consumed_by) ? [...previous.consumed_by] : []
    if (!consumed.includes(requirementId)) consumed.push(requirementId)
    return this.record(previous, { consumed_by: consumed })
  }

  /**
   * Merge a patch into an existing record WITHOUT re-supplying the message.
   *
   * `record(message, patch)` merges the message first, and a caller that still
   * holds the original message object would write its empty `consumed_by` back
   * over what `consume` just recorded. This is the method for "add a note to a
   * message I already logged".
   */
  annotate(messageId, patch) {
    this.#ensure()
    const previous = this.records.get(String(messageId))
    if (previous === null || previous === undefined) return null
    return this.record(previous, patch)
  }

  all() {
    this.#ensure()
    return [...this.records.values()]
  }

  /** Messages that produced nothing and were not marked — the "漏单" check. */
  unconsumed() {
    return this.all().filter((doc) => (doc.consumed_by ?? []).length === 0 && doc.ignored_reason === null)
  }
}

/** A short human-readable line for one state machine refusal. */
function refusalLine(result) {
  const pending = Array.isArray(result.pending) && result.pending.length > 0 ? '（还差 ' + result.pending.join('、') + '）' : ''
  return '✖ ' + String(result.message ?? result.code) + pending
}

/**
 * Who is speaking.
 *
 * Two mappings, in this order:
 *
 *   `feishu.senders`     open_id → human:<name>   (precise; needs the id)
 *   `feishu.chatActors`  chat_id → human:<name>   (a whole chat speaks as one)
 *
 * The second exists because of a REAL LIMITATION, and it is deliberately opt-in:
 * a message relayed by `dsh-plugin-feishu-bot` reaches this layer with the
 * mention stripped and NO sender identity at all, so a group command like
 * `接受 task-1` cannot be attributed to a person from what is available here.
 * Mapping a chat to one actor is honest for a one-operator working group and a
 * real weakening anywhere else — which is why an unattributed command is
 * REFUSED by default rather than attributed to some configured default.
 *
 * `null` is therefore a normal answer, not a failure: an unmapped sender may
 * read the board but may not change it (see `runCommand`).
 */
export function resolveSender(config, openId, chatId) {
  const senders = config?.feishu?.senders
  if (typeof openId === 'string' && openId !== '' && senders !== null && typeof senders === 'object') {
    const mapped = senders[openId]
    if (typeof mapped === 'string' && mapped !== '') return mapped
  }
  const chatActors = config?.feishu?.chatActors
  if (typeof chatId === 'string' && chatId !== '' && chatActors !== null && typeof chatActors === 'object') {
    const mapped = chatActors[chatId]
    if (typeof mapped === 'string' && mapped !== '') return mapped
  }
  return null
}

/**
 * Wire a group message into the ledger.
 *
 * @param {{config: object, handlers: object, client: object|null, inbox: Inbox, cards: object|null, log?: object}} deps
 */
export function createIngest(deps) {
  const { config, handlers, client, inbox } = deps
  const cards = deps.cards ?? null
  const broadcast = deps.broadcast ?? null
  const log = deps.log ?? console

  /** Tasks under one requirement, for the requirement card's task list. */
  const tasksOf = (reqId) =>
    deps.store !== undefined && deps.store !== null ? deps.store.find('task', (task) => task.req === reqId) : []

  /** Send one text line, or one card if the card layer can build it. */
  async function reply(chatId, text, cardSpec = null) {
    if (client === null || client.ready !== true) {
      log.error('[team] no feishu client: would have said "' + text + '"')
      return { ok: false, via: 'no-client' }
    }
    if (cardSpec !== null && cards !== null) {
      try {
        // Buttons are off unless a public callback endpoint exists; the card
        // says which text command to send instead.
        const ladder = cards.degradationLadder(cardSpec)
        const delivered = await client.sendThrough(chatId, ladder)
        if (delivered.ok) return delivered
      } catch (error) {
        log.error('[team] card delivery failed, falling back to text: ' + String(error && error.message ? error.message : error))
      }
    }
    const sent = await client.send(chatId, { msg_type: 'text', content: { text } })
    return { ok: sent.ok, via: 'text', code: sent.code, message: sent.msg }
  }

  /** One command: hand it to the state machine and report exactly what it said. */
  async function runCommand(command, message) {
    const actor = message.sender_principal
    // Reading the board is safe for anyone in a registered group; changing it
    // is not. An unmapped sender is refused rather than guessed at, because a
    // default actor would let anyone accept anyone else's task.
    if (command.action === 'status') {
      const tasks = handlers.list({ kind: 'task', limit: 20 })
      const lines = (tasks.rows ?? []).map((row) => [row.id, row.state, row.title, row.assignee ?? '', row.gates ?? ''].filter(Boolean).join(' | '))
      return reply(message.chat_id, lines.length === 0 ? '台账里还没有任务' : '台账：\n' + lines.join('\n'))
    }
    if (actor === null) {
      return reply(
        message.chat_id,
        '✖ 认不出你是谁：这台人的飞书 open_id 还没有映射到成员，先在团队配置的 feishu.senders 里登记（' +
          String(message.sender_open_id ?? 'unknown') +
          '），否则任何人都能用一句话替别人确认任务',
      )
    }
    const handler = handlers[command.action]
    if (typeof handler !== 'function') {
      return reply(message.chat_id, '✖ 这个动作还没有接上：' + command.action)
    }
    const result = await handler({ id: command.id, actor })
    if (result.ok === true) {
      const state = result.state !== undefined && result.state !== null ? '（' + String(result.state) + '）' : ''
      return reply(message.chat_id, '✅ ' + String(command.id) + ' ' + String(result.what ?? '已处理') + state)
    }
    return reply(message.chat_id, String(command.id) + ' ' + refusalLine(result))
  }

  /** One prose message: triage, maybe extract, maybe create a requirement. */
  async function runProse(message) {
    const triage = deps.triage
    const extract = deps.extract
    if (triage === null || extract === null) {
      inbox.record(message, { ignored_reason: '分诊/提取模块不可用（飞书协议层没加载起来）' })
      return { ok: false, kind: 'unavailable', reason: 'protocol layer unavailable', created: null }
    }
    /*
     * `addressed` comes from the seam when it KNOWS (the bridge only relays what
     * was aimed at the bot, and strips the mention before it lands here), and
     * falls back to looking at the text.
     */
    const addressed = message.addressed === true || looksAddressed(message.text)
    const verdict = triage.triageMessage({
      text: message.text,
      directAddress: addressed,
      /*
       * `resolveTriageConfig` fills the defaults rather than replacing them: an
       * operator who writes ONE line of `feishu.triage` must not silently lose
       * the intent word list, the smalltalk patterns and the substance floor.
       * (An empty-but-present object is exactly how that happens.) It also
       * normalises the fields triage actually reads, so a config with a typo
       * fails at load instead of inside a regex.
       */
      config:
        typeof triage.resolveTriageConfig === 'function'
          ? triage.resolveTriageConfig(config.feishu?.triage)
          : { ...triage.DEFAULT_TRIAGE_CONFIG, ...(config.feishu?.triage ?? {}) },
    })

    /*
     * BEING ADDRESSED OUTRANKS THE WORD LIST.
     *
     * The design is explicit (docs 02 §3, 04 §6): a message that @-mentions the
     * bot is the strongest possible signal of intent, and the word list exists
     * only to decide whether an UN-addressed remark in a busy group is worth
     * collecting. A pipeline that triages first and drops everything that is not
     * `requirement` makes that rule unreachable — the human @-s the bot, gets
     * told "没有发现表达诉求的词", and learns not to bother. That is a failure
     * the Hub already shipped once and the user complained about by name.
     *
     * So an addressed message that triage classified as mere status or a
     * question is still handed to extraction, which applies its own, much
     * looser judgement for direct address. The cost of being wrong is one draft
     * requirement awaiting a human's confirmation; the cost of being silent is a
     * bot nobody talks to.
     *
     * THE COST IS REAL AND SO IS THE KNOB. `@机器人 哈哈哈 中午吃啥` is addressed
     * and has substance, so it becomes a draft requirement — the trade the design
     * chose. Set `feishu.addressedOverridesIntent: false` to require an intent
     * word even when the bot is mentioned; you then get the older, quieter
     * behaviour where "我 @ 了它，它说没发现表达诉求的词" is possible again.
     */
    const addressedCandidate =
      addressed &&
      config.feishu?.addressedOverridesIntent !== false &&
      (verdict.kind === 'status' || verdict.kind === 'question')
    if (verdict.kind !== 'requirement' && !addressedCandidate) {
      // Recorded, never dropped: this is what makes "漏单" answerable later.
      inbox.record(message, { ignored_reason: verdict.reason, triage_kind: verdict.kind })
      return { ok: true, kind: verdict.kind, reason: verdict.reason, created: null }
    }

    const extracted = extract.extractRequirement([message], {
      knownRepos: Array.isArray(config.knownRepos) ? config.knownRepos : [],
      directAddress: addressed,
    })
    if (extracted.draft === null) {
      inbox.annotate(message.message_id, {
        ignored_reason: extracted.reason,
        triage_kind: verdict.kind,
        ...(addressedCandidate ? { triage_overridden: '被 @ 提及，词表不否决' } : {}),
      })
      return { ok: true, kind: verdict.kind, reason: extracted.reason, created: null }
    }

    const draft = extracted.draft
    /*
     * The extraction layer deliberately keeps `@某人` in the text (a mention can
     * BE the information: `@张三 这块你接手`). At the ingestion boundary the
     * leading mention is just addressing, and a requirement titled "@机器人
     * 支付重试这块" reads like a bug on every card it appears on. So the prefix
     * is stripped here — one place, at the edge, with the original text still in
     * `origin.excerpts` for anyone who needs to see what was actually said.
     */
    const title = String(draft.title ?? '').replace(/^@\S+\s*/, '').trim() || String(draft.title ?? '').trim()
    const created = handlers.create_requirement({
      title,
      owner: message.sender_principal ?? config.defaultOwner,
      requester: draft.requester ?? message.sender_principal ?? config.defaultOwner,
      problem: draft.problem,
      proposal: draft.proposal,
      acceptance_criteria: draft.acceptance_criteria,
      priority: draft.priority,
      repos: draft.repos,
      chat_id: message.chat_id,
      message_id: message.message_id,
      excerpts: draft.excerpts,
    })
    if (created.ok !== true) {
      inbox.record(message, { ignored_reason: '建单被拒：' + String(created.message) })
      return { ok: false, kind: verdict.kind, reason: String(created.message), created: null }
    }

    inbox.consume(message.message_id, created.id)
    // The triage verdict is kept on the SUCCESS path too: when a `status` message
    // became a requirement because it addressed the bot, the record should say
    // so, or the override looks like a leak the next time someone audits it.
    inbox.annotate(message.message_id, {
      triage_kind: verdict.kind,
      ...(addressedCandidate ? { triage_overridden: '被 @ 提及，词表不否决' } : {}),
    })
    const requirement = deps.store !== undefined ? deps.store.get('requirement', created.id) : null
    /*
     * The card is a nicety; the ledger write is not. Card construction is
     * wrapped because a rendering fault must never cost the requirement that was
     * just recorded — the same reason the delivery ladder exists at all.
     */
    let spec = null
    if (deps.broadcast !== null && deps.broadcast !== undefined && requirement !== null) {
      try {
        spec = deps.broadcast.buildRequirementCard(requirement, tasksOf(requirement.id), {
          // The builder's context: a nonce for button values, the clock for a
          // button's expiry, and the lease so a card can show its remaining time.
          nonce: () => (typeof randomUUID === 'function' ? randomUUID() : String(Date.now()) + Math.random()),
          now: () => new Date(),
          leaseOf: (taskId) => (deps.store !== undefined ? deps.store.get('lease', String(taskId)) : null),
          buttons: config.feishu?.buttons === true,
        })
      } catch (error) {
        log.error('[team] could not build the requirement card: ' + String(error && error.message ? error.message : error))
      }
    }
    await reply(
      message.chat_id,
      '已记为需求 ' + created.id + '：' + String(created.title ?? draft.title) + '（待确认）',
      spec,
    )
    return { ok: true, kind: 'requirement', reason: extracted.reason, created: created.id, confidence: extracted.confidence }
  }

  return {
    /** @param {object} inbound `{chatId, chatTitle, chatType, sessionId, messageId, text, at, sender}` */
    async onMessage(inbound) {
      const principal =
        typeof deps.resolveActor === 'function'
          ? deps.resolveActor(inbound)
          : resolveSender(config, inbound.sender, inbound.chatId)
      const message = {
        message_id: inbound.messageId,
        dedupe_key: inbound.messageId,
        event_id: null,
        chat_id: inbound.chatId,
        chat_type: inbound.chatType === 'p2p' ? 'p2p' : 'group',
        message_type: 'text',
        thread_id: null,
        sender_open_id: inbound.sender ?? null,
        sender_principal: principal,
        mentions: [],
        text: inbound.text,
        raw_content: '',
        create_time: inbound.at ?? null,
        received_at: new Date().toISOString(),
        consumed_by: [],
        ignored_reason: null,
        ...(inbound.from_bridge === true ? { via: 'bridge-relay' } : {}),
        ...(inbound.addressed === true ? { addressed: true } : {}),
      }
      if (inbox.seen(message.message_id)) return { ok: true, skipped: 'duplicate', message_id: message.message_id }
      inbox.record(message)
      const command = parseCommand(message.text, { ...DEFAULT_COMMANDS, ...(config.feishu?.commands ?? {}) })
      if (command !== null) {
        const result = await runCommand(command, message)
        inbox.record(message, { handled: 'command:' + command.action, delivered: result.ok === true })
        return { ...result, command: command.action, id: command.id }
      }
      return runProse(message)
    },
    reply,
  }
}
