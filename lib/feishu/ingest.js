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

  /**
   * 触发消息所在的一批：同群、同发件人、连续的几句（`selectContextMessages` 定规则）。
   *
   * 收件箱是**唯一**的消息来源，所以批次不需要另存一份队列；它读的是"这个群里
   * 还没被消费、也没被标成忽略"的那些。
   */
  function buildBatch(trigger, triage) {
    if (typeof triage?.selectContextMessages !== 'function') return [trigger]
    const window = Number(config.feishu?.triage?.context_window ?? 6)
    /*
     * 池子里的元素必须是**收件箱里的原始记录**：`selectContextMessages` 按
     * `message_id` 找触发消息、按 `sender_principal` 判断"别人插话即边界"。
     * 第一版把它投影成 `{text, sender_open_id, create_time}`，于是那个函数
     * 连触发消息都找不到，永远返回 `[trigger]` —— 批次窗口看着接上了，
     * 实际上每条消息还是各自成批（一个安静的空转）。
     *
     * 收件箱是追加写的，所以 `all()` 的顺序就是收件顺序；不需要再按时间排。
     *
     * 只排除**已经被别的需求消费掉**的：那些已经归了别处，再拉进来是重复计账。
     * 被判过"不构成需求"的消息**留在池子里** —— 它们正是最该当上下文的前几句
     * （"支付这块老是超时" + "现在失败一次就得人工补" + "@机器人 能不能自动重试"）。
     * 会不会把别人的闲聊吞进来，由 `selectContextMessages` 的"同一发件人、连续、
     * 有上限"三条规则挡住，而不是靠这里一刀切。
     */
    const pool = inbox
      .all()
      .filter((doc) => doc.chat_id === trigger.chat_id)
      .filter((doc) => doc.message_id !== trigger.message_id)
      .filter((doc) => (doc.consumed_by ?? []).length === 0)
    return triage.selectContextMessages([...pool, trigger], trigger, window)
  }

  /** 还没结束的需求（去重要跟这些比）：done/archived/dropped 的不算。 */
  function openRequirements() {
    if (deps.store === undefined || deps.store === null) return []
    if (typeof deps.store.all !== 'function') return []
    return deps.store
      .all('requirement')
      .filter((req) => !['done', 'archived', 'dropped'].includes(String(req.state)))
      .map((req) => ({ id: req.id, title: String(req.title ?? ''), repos: req.links?.repos ?? [] }))
  }

  /**
   * 追问一次具体的问题，并把"问过了"记在这个群上。
   *
   * 记在群记录（`chat.ask`）而不是内存里：重启之后仍然记得"这个群已经问过一次"，
   * 否则每次重启都会再问一遍同一件事。
   */
  async function maybeAsk(message, extracted, verdict) {
    if (typeof deps.extract?.decideIngestAsk !== 'function') return null
    const askConfig = config.feishu?.ask ?? {}
    const maxAsks = Number.isFinite(Number(askConfig.maxAsks)) ? Number(askConfig.maxAsks) : 1
    const ttlMs = Number.isFinite(Number(askConfig.ttlMs)) ? Number(askConfig.ttlMs) : 30 * 60 * 1000
    const chat = deps.store !== undefined ? deps.store.get('chat', message.chat_id) : null
    const askedAt = chat?.ask?.at ?? null
    const fresh = askedAt !== null && Date.now() - Date.parse(askedAt) < ttlMs
    const policy = {
      askedCount: fresh ? Number(chat?.ask?.count ?? 0) : 0,
      passive: fresh && Number(chat?.ask?.count ?? 0) >= maxAsks,
    }
    const decision = deps.extract.decideIngestAsk(extracted, policy, { directAddress: message.addressed === true })
    if (decision.shouldAsk !== true || decision.question === null) return null
    await reply(message.chat_id, decision.question)
    if (deps.store !== undefined && chat !== null) {
      deps.store.put('chat', {
        ...chat,
        ask: { count: Number(policy.askedCount) + 1, at: new Date().toISOString(), requirement_id: extracted.draft === null ? null : null },
      })
    }
    return { asked: true, reason: decision.reason }
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

    /*
     * 上下文窗口：把触发消息**和它前面同一发件人连着说的几句**当成一批。
     *
     * 设计 02 §2.2.3#2："别人插话即话题边界，回看窗口有上限"。以前这里只喂
     * `[message]`，于是"连续三条说同一件事"会变成三个独立需求 —— 需求的颗粒度
     * 变成了打字的颗粒度。批次从收件箱取（那里本来就有全部消息），
     * 谁能不能进批次由 `selectContextMessages` 决定，这里不重写一遍规则。
     */
    const batch = buildBatch(message, triage)
    const extracted = extract.extractRequirement(batch, {
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
     *
     * 归一化必须在**去重之前**做：库里存的是去掉前缀的标题，拿带 `@机器人` 的原文
     * 去比，两条说的是同一件事也永远对不上（第一版就是这样，去重形同虚设）。
     */
    const title = String(draft.title ?? '').replace(/^@\S+\s*/, '').trim() || String(draft.title ?? '').trim()

    /*
     * 去重（设计 02 §5.7）：相似度够高就**并入已有需求**，而不是再长一张卡。
     * `findDuplicate` 一直躺在 extract.js 里没人调用 —— 于是同一件事在群里说三遍
     * 就是三个需求，而人看到的是三张卡在问同样的问题。
     *
     * 并入的动作是"把这条消息记进那个需求的摘录 + 在群里指回去"：
     * 比"静默丢弃"好（说话的人知道被收到了），也比"再建一张"好（不等于重复派活）。
     */
    const existing = openRequirements()
    const duplicate =
      typeof extract.findDuplicate === 'function' && existing.length > 0
        ? extract.findDuplicate({ title, repos: draft.repos ?? [] }, existing)
        : null
    if (duplicate !== null) {
      /*
       * 判定为重复之后**绝不再建第二张卡**，即使我们读不回那条需求也一样 ——
       * 读不回来是存储层的问题，而"同一件事只该有一个需求"是这里要保证的事。
       * 第一版把"读得到目标"当成前提，读不到就悄悄往下建单：去重看着实现了，
       * 实际上在最该生效的时候失效。
       */
      const target = deps.store !== undefined && deps.store !== null ? deps.store.get('requirement', duplicate.id) : null
      if (target !== null) {
        const excerpts = Array.isArray(target.origin?.excerpts) ? target.origin.excerpts : []
        deps.store.put('requirement', {
          ...target,
          origin: { ...(target.origin ?? {}), excerpts: [...excerpts, title].slice(-20) },
        })
      }
      inbox.consume(message.message_id, duplicate.id)
      inbox.annotate(message.message_id, {
        duplicate_of: duplicate.id,
        duplicate_score: Number(duplicate.score.toFixed(2)),
        triage_kind: verdict.kind,
      })
      await reply(
        message.chat_id,
        '这看起来和已有的需求是同一条：**' + duplicate.id + '**（相似度 ' +
          String(Math.round(duplicate.score * 100)) + '%）\n' +
          (target === null ? '我已按重复处理，没有另开卡。' : '我已经把你这句话记到它的摘录里了，不再另开一张卡。'),
      )
      return { ok: true, kind: 'duplicate', reason: '并入 ' + duplicate.id, created: null, duplicate_of: duplicate.id }
    }

    /*
     * The extraction layer deliberately keeps `@某人` in the text (a mention can
     * BE the information: `@张三 这块你接手`). At the ingestion boundary the
     * leading mention is just addressing, and a requirement titled "@机器人
     * 支付重试这块" reads like a bug on every card it appears on. So the prefix
     * is stripped here — one place, at the edge, with the original text still in
     * `origin.excerpts` for anyone who needs to see what was actually said.
     */
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

    /*
     * 追问（设计 02 §7.1#3："需求机器人主动追问，默认只追一次，之后转被动"）。
     *
     * `decideAsk` / `decideIngestAsk` 也一直没人调用：于是"信息不全"这件事只体现在
     * 卡片上的一行"待澄清"，没有人被问过 —— 而设计要的是机器人**主动问一句**
     * 具体的问题（"怎样算做完？"），问过一次就闭嘴，别变成审讯。
     *
     * 追加发生在建单之后：卡已经有了，追问是补充，不是前置条件 ——
     * 这样"问了但没人理"也不会卡住建单。
     */
    const asked = await maybeAsk(message, extracted, verdict)
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
    return {
      ok: true,
      kind: 'requirement',
      reason: extracted.reason,
      created: created.id,
      confidence: extracted.confidence,
      ...(asked === null ? {} : { asked: asked.reason }),
      ...(extracted.missing.length === 0 ? {} : { missing: extracted.missing }),
    }
  }

  return {
    /**
     * @param {object} inbound `{chatId, chatTitle, chatType, sessionId, messageId, text, at, sender}`
     * @param {{recorded_by?: string|null}} [context]
     *   `recorded_by` 是这个群的**主机器人**（见 lib/bots.js `pickPrimaryBot`）：
     *   每条消息都挂在它名下，所以"这个群最近发生了什么"有主可查 —— 而不是
     *   散在一条谁也说不清归属的追加日志里。
     */
    async onMessage(inbound, context = {}) {
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
        /** 这条消息记在哪个机器人名下（主机器人），与"谁回答了它"无关。 */
        recorded_by: typeof context.recorded_by === 'string' ? context.recorded_by : null,
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
