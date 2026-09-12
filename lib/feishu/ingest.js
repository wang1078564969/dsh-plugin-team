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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveMembers } from '../members.js'

/** The verbs a group may use, with the Chinese words an operator would type. */
export const DEFAULT_COMMANDS = {
  /*
   * 这张表的**每一行都必须对得上一个真实存在的 handler**，而且它的词要与
   * 卡片按钮的 `label` 对得上 —— 按钮点不动的时候，人只能照着卡上的字回复，
   * 而卡片（`buildCardJson` 去按钮那一级）写的就是 `label + 对象 id`。
   * 以前它只覆盖 9 个动作：`提交验收`、`确认拆解`、`续约`、`交回`、`解冻` 都没有词，
   * 于是"只用飞书的人走不完闭环"（`in_progress` 推不到 `in_review`）。
   * `test/commands.test.mjs` 会拿它和 handlers / 按钮表逐条对账。
   */
  accept_task: ['接受', '接了', 'accept'],
  start_task: ['开始', '动手', 'start'],
  submit_task: ['提交', '提交验收', '做完了', 'submit'],
  verify_task: ['验收', '通过', '验收通过', 'verify'],
  reject_review: ['打回', '返工', 'reject_review'],
  reject_task: ['拒绝', 'reject'],
  reassign_task: ['转派', '改派', 'reassign'],
  unassign_task: ['交回', 'unassign'],
  block_task: ['阻塞', 'block'],
  unblock_task: ['解除', '解除阻塞', '恢复', 'unblock'],
  resume_task: ['解冻', '继续', 'resume'],
  drop_task: ['废弃', '不用做了', 'drop'],
  renew_lease: ['续约', 'renew'],
  confirm_split: ['确认拆解', '拆解', 'confirm_split'],
  /*
   * 需求级的词。需求卡上也有一排按钮（`req.confirm` / `req.confirm_split` /
   * `req.reconfirm` / `req.drop`），按钮关掉时人只能照着卡上的字回复 ——
   * 而那些字以前**没有对应的动词**：`废弃` 落到 `drop_task`（按 task id 找不到对象），
   * `确认需求` 全链路只有工具动作。卡上写着能做、群里做不了，是最坏的一种不一致。
   * 需求与任务的重名词（确认拆解）共用一条：两者的 id 前缀不同，由状态机判定归属。
   */
  confirm_requirement: ['确认需求', 'confirm_requirement'],
  reconfirm_requirement: ['确认变更', 'reconfirm_requirement'],
  finish_requirement: ['完成需求', 'finish_requirement'],
  archive_requirement: ['归档需求', 'archive_requirement'],
  drop_requirement: ['废弃需求', 'drop_requirement'],
  suspend_requirement: ['挂起需求', 'suspend_requirement'],
  resume_requirement: ['恢复需求', 'resume_requirement'],
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
  /*
   * `<动词> <对象 id> [原因/对象]` —— 尾巴是**可选的补充**，不是垃圾。
   *
   * 以前这里只认 `<动词> <id>` 两段，于是「阻塞 task-1 等接口」整条**解析失败**
   * （返回 null），落进 prose 走分诊 —— 一句本意是"给任务加个阻塞原因"的话，
   * 有可能被当成需求建单。而 `阻塞`/`转派` 这两个动作恰恰需要那个补充：
   * 一个要原因、一个要人。所以第三段开始原样收下来，交给 handler 自己用。
   */
  const match = /^(\S+)\s*([A-Za-z][\w-]*)?\s*(.*)$/.exec(trimmed)
  if (match === null) return null
  const verb = match[1]
  const id = typeof match[2] === 'string' && match[2] !== '' ? match[2] : null
  const rest = typeof match[3] === 'string' ? match[3].trim() : ''
  for (const [action, words] of Object.entries(commands)) {
    if (!Array.isArray(words) || !words.includes(verb)) continue
    if (action === 'status') return { action, id: null, verb }
    /*
     * `转派` 的补充是**一个人**（`转派 task-1 bot:dev` 或 `转派 task-1 张三`），
     * 其余动作的补充是一句原因。两者都从同一个位置来，所以统一放在 `rest` 里，
     * 由 runCommand 按动作决定怎么用 —— 解析层不认识业务。
     */
    if (rest !== '') return { action, id, verb, rest }
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
    /**
     * `event_id` → `message_id`。
     *
     * 去重键是 **event_id**，不是 message_id（设计 04 §4.1）：飞书重投时
     * `message_id` 可能变，`event_id` 不变。用 message_id 当键的话，重投会被
     * 当成一条新消息再跑一遍 agent —— 对"读文件"无害，对"建任务/发通知/改文档"
     * 就是重复副作用。索引与 `records` 同时维护，读的时候不用扫全表。
     * @type {Map<string, string>}
     */
    this.events = new Map()
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
        if (doc === null || typeof doc !== 'object' || typeof doc.message_id !== 'string') continue
        this.records.set(doc.message_id, doc)
        if (typeof doc.event_id === 'string' && doc.event_id !== '') this.events.set(doc.event_id, doc.message_id)
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

  /**
   * 这个事件是不是已经处理过（权威去重键）。
   *
   * 两条都要查：`event_id` 是权威，但**旧记录里没有它**（在加这一列之前收的消息），
   * 所以 message_id 仍然要兜一层。返回命中的那条 message_id，调用方能说清
   * "重投的是哪一条"。
   */
  seenEvent(eventId) {
    this.#ensure()
    const key = String(eventId ?? '')
    if (key === '') return null
    const messageId = this.events.get(key)
    return messageId === undefined ? null : messageId
  }

  /** 按 `event_id` 找回一条记录（"这条重投的是哪一条"）。 */
  byEventId(eventId) {
    const messageId = this.seenEvent(eventId)
    return messageId === null ? null : this.get(messageId)
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
    if (typeof doc.event_id === 'string' && doc.event_id !== '') this.events.set(doc.event_id, id)
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(doc) + '\n', 'utf8')
    return doc
  }

  /**
   * 占位认领：**在任何 await 之前**把这条消息写进去重表。
   *
   * 为什么必须有它：`team.js` 的去重检查发生在资产下载之前，但**记录**要等下载完
   * 才写（`ingest.onMessage`）。多机器人 = 多应用 = 多条长连接时，同一条群消息会在
   * 每条连接上各到一次，两次投递正好落在那个 await 的两侧 —— 两边都判"没收到"，
   * 于是资产下载两次、`chat.messages` 计两次、回执卡被 PATCH 两次。
   * 先 claim 再干活，窗口就不存在了：认领是同步的，第二个到达者立刻看到记录。
   *
   * 认领写的是一条**最小**记录（只有身份与时间），流水线随后 `record()` 合并补齐；
   * 字段与最终形状一致，所以观测页看到的仍然是一条完整消息。
   *
   * @returns {{ok: true, doc: object} | {ok: false, duplicate_of: string|null, dedupe_key: string}}
   */
  claim(message) {
    this.#ensure()
    const id = String(message.message_id)
    const eventId = typeof message.event_id === 'string' && message.event_id !== '' ? message.event_id : null
    const byEvent = this.seenEvent(eventId)
    if (byEvent !== null && byEvent !== id) return { ok: false, duplicate_of: byEvent, dedupe_key: 'event_id' }
    if (this.records.has(id)) return { ok: false, duplicate_of: id, dedupe_key: 'message_id' }
    const doc = this.record({
      ...message,
      consumed_by: Array.isArray(message.consumed_by) ? message.consumed_by : [],
      ignored_reason: null,
      claimed_at: new Date().toISOString(),
    })
    return { ok: true, doc }
  }

  /**
   * 保留窗口：把窗口之外的消息从**索引**里去掉（设计 04 §4.1 的"保留窗口按策略"）。
   *
   * 为什么必须有：去重表是**持久**的，不清理就会一直长 —— 一天 30 条、一年一万条，
   * 每次启动都要读一个越来越大的文件。窗口按天算，默认 30 天（`feishu.dedupeRetentionDays`）。
   *
   * 注意它同时决定了"漏单/观测"能回看多久：清掉的行不再出现在面板上，
   * 所以窗口是观测口径的一部分，不是纯技术参数。`retentionDays <= 0` = 不清理。
   *
   * @param {{retentionDays?: number, now?: Date}} [options]
   * @returns {{removed: number, kept: number, cutoff: string|null, rewrote: boolean}}
   */
  prune(options = {}) {
    this.#ensure()
    const days = Number(options.retentionDays)
    if (!Number.isFinite(days) || days <= 0) return { removed: 0, kept: this.records.size, cutoff: null, rewrote: false }
    const reference = options.now instanceof Date ? options.now : new Date()
    const cutoff = reference.getTime() - days * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [id, doc] of [...this.records.entries()]) {
      const at = Date.parse(String(doc.create_time ?? doc.received_at ?? ''))
      // 时间读不出来的**不删**：宁可留一条读不懂的旧记录，也不要因为格式问题
      // 把一条刚收到的消息清掉（那会让去重失效）。
      if (!Number.isFinite(at) || at >= cutoff) continue
      this.records.delete(id)
      if (typeof doc.event_id === 'string' && doc.event_id !== '') this.events.delete(doc.event_id)
      removed += 1
    }
    let rewrote = false
    if (removed > 0) {
      try {
        const tmp = this.path + '.tmp'
        mkdirSync(dirname(this.path), { recursive: true })
        writeFileSync(tmp, [...this.records.values()].map((doc) => JSON.stringify(doc)).join('\n') + '\n', 'utf8')
        renameSync(tmp, this.path)
        rewrote = true
      } catch (error) {
        // 重写失败不算错：内存里已经清干净，下次启动会再试一遍。
        removed = 0
      }
    }
    return { removed, kept: this.records.size, cutoff: new Date(cutoff).toISOString(), rewrote }
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

  /**
   * Messages that produced nothing and were not marked — the "漏单" check.
   *
   * `handled` 也算"有着落"：一条群命令（`接受 task-1`）会被执行并标记
   * `handled: 'command:accept_task'`，它既不需要 `consumed_by`（没有建单）
   * 也不会写 `ignored_reason`（它不是被忽略的）。不认这个字段的话，
   * **每一条成功执行的命令都会出现在漏单里**，而漏单是给人排障用的。
   */
  unconsumed() {
    return this.all().filter(
      (doc) => (doc.consumed_by ?? []).length === 0 && doc.ignored_reason === null && doc.handled === undefined,
    )
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
  /**
   * 回一句话（可选一张卡）。
   *
   * `options.replyTo` 是**话题隔离**（设计 04 §5）：回复引用触发它的那条消息，
   * 多机器人在同群时不会各说各话串成瀑布流。引用失败自动退化为普通消息。
   */
  async function reply(chatId, text, cardSpec = null, options = {}) {
    if (client === null || client.ready !== true) {
      log.error('[team] no feishu client: would have said "' + text + '"')
      return { ok: false, via: 'no-client' }
    }
    const replyTo = typeof options.replyTo === 'string' && options.replyTo !== '' ? options.replyTo : null
    if (cardSpec !== null && cards !== null) {
      try {
        /*
         * Buttons are off unless a public callback endpoint exists; the card
         * says which text command to send instead.
         *
         * ⚠️ `opts.buttons` **必须传**：阶梯只在收到 `buttons: false` 时才会降成
         * "去按钮 + 文本指令"。漏传的话第一级仍然是带真按钮的卡 —— 而按钮需要公网
         * HTTPS 回调，点下去不会有任何反应（默认配置正是 `buttons: false`）。
         */
        const ladder = cards.degradationLadder(cardSpec, { buttons: config.feishu?.buttons === true })
        const delivered = await client.sendThrough(chatId, ladder, { replyTo })
        if (delivered.ok) return delivered
      } catch (error) {
        log.error('[team] card delivery failed, falling back to text: ' + String(error && error.message ? error.message : error))
      }
    }
    if (replyTo !== null && typeof client.call === 'function') {
      const replied = await client.call('/open-apis/im/v1/messages/' + encodeURIComponent(replyTo) + '/reply', {
        method: 'POST',
        body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
      })
      if (replied.ok === true) return { ok: true, via: 'text', reply_to: replyTo, code: 0, messageId: replied.data?.message_id ?? null }
      // 引用失败（消息被撤回 / 权限不足）不是错误：退回普通消息，答案不能丢。
      log.warn?.('[team] 引用回复失败，改为普通消息：' + String(replied.code) + ' ' + String(replied.msg))
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
    await reply(message.chat_id, decision.question, null, { replyTo: message.message_id })
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
    /*
     * 命令尾巴（`阻塞 task-1 等接口上线` 里的"等接口上线"）按动作分派：
     *   · `转派` 要的是**人**（`转派 task-1 bot:dev` / `转派 task-1 张三`）；
     *   · 其余动作要的是**一句原因**（阻塞/打回/废弃…）。
     * 解析层不认识业务，所以两种可能都在这里决定。人名允许写 `bot:dev` 或 `zhang-san`，
     * 后者按成员表的 key 找一次（找不到就原样交给状态机，由它给出可读的拒绝）。
     */
    const extra = {}
    const tail = typeof command.rest === 'string' ? command.rest.trim() : ''
    if (tail !== '') {
      if (command.action === 'reassign_task') extra.assignee = resolvePerson(tail)
      else extra.note = tail
    }
    const result = await handler({ id: command.id, actor, ...extra })
    if (result.ok === true) {
      const state = result.state !== undefined && result.state !== null ? '（' + String(result.state) + '）' : ''
      return reply(message.chat_id, '✅ ' + String(command.id) + ' ' + String(result.what ?? '已处理') + state)
    }
    return reply(message.chat_id, String(command.id) + ' ' + refusalLine(result))
  }

  /**
 * 群里写的"人" → 主体。
 *
 * 接受三种写法：`bot:dev` / `human:zhang-san`（已经是主体）、`dev`（某个机器人的 id）、
 * 以及成员表里的名字或 key 的尾段（`张三` → `human:<key>`）。找不到就原样返回 ——
 * 状态机会给出"这个人不在场上"这类可读的拒绝，比这里瞎猜一个主体好。
 */
function resolvePerson(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return raw
  if (/^(human|bot|role|system):/.test(raw)) return raw
  const members = resolveMembers({ members: deps.config?.memberList, domains: deps.config?.members, senders: deps.config?.feishu?.senders })
  const byName = (members.list ?? []).find((one) => one.key === raw || one.name === raw || String(one.key).endsWith(':' + raw))
  if (byName !== undefined) return byName.key
  const bot = (deps.config?.bots ?? []).find((one) => one !== null && typeof one === 'object' && one.id === raw)
  if (bot !== undefined) return 'bot:' + bot.id
  return raw
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
        null,
        { replyTo: message.message_id },
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
    /*
     * **先把这条消息记成"已消费"，再追问。**
     *
     * `maybeAsk` 会真的发一条飞书消息，它会抛（网络、权限、限流）。
     * 以前 consume 在它后面，于是"需求已经建好了、只是追问没发出去"这种情况，
     * 观测页会把它算成**漏单** —— 排障时指向完全错误的方向。
     */
    inbox.consume(message.message_id, created.id)
    const asked = await maybeAsk(message, extracted, verdict)
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
      { replyTo: message.message_id },
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
      const assets = Array.isArray(context.assets) ? context.assets : []
      const message = {
        message_id: inbound.messageId,
        /* 去重键：**event_id 优先**（设计 04 §4.1），没有就退回 message_id。 */
        dedupe_key: typeof inbound.eventId === 'string' && inbound.eventId !== '' ? inbound.eventId : inbound.messageId,
        event_id: typeof inbound.eventId === 'string' && inbound.eventId !== '' ? inbound.eventId : null,
        chat_id: inbound.chatId,
        chat_type: inbound.chatType === 'p2p' ? 'p2p' : 'group',
        message_type: typeof inbound.messageType === 'string' && inbound.messageType !== '' ? inbound.messageType : 'text',
        thread_id: null,
        sender_open_id: inbound.sender ?? null,
        sender_principal: principal,
        mentions: [],
        text: inbound.text,
        raw_content: '',
        /* 落库后的资产引用（图片/文件）。空数组合法：这条消息就是没有附件。 */
        ...(assets.length === 0 ? {} : { assets }),
        create_time: inbound.at ?? null,
        received_at: new Date().toISOString(),
        consumed_by: [],
        ignored_reason: null,
        /** 这条消息记在哪个机器人名下（主机器人），与"谁回答了它"无关。 */
        recorded_by: typeof context.recorded_by === 'string' ? context.recorded_by : null,
        ...(inbound.from_bridge === true ? { via: 'bridge-relay' } : {}),
        ...(inbound.addressed === true ? { addressed: true } : {}),
      }
      /*
       * 去重（设计 04 §4.1）：**event_id 是权威**，message_id 是兜底 ——
       * 重投时前者不变、后者可能变，而"再跑一遍 agent"的代价是重复副作用。
       * 命中的那条 message_id 一并回报，人才答得出"这是哪一条的重投"。
       */
      /*
       * `context.claimed === true` 表示**调用方已经用 `inbox.claim()` 占过位了**：
       * 那条占位记录就是这条消息自己，不能当成重投。去重的权威判断在 claim 里
       * （它发生在任何 await 之前），这里的检查是给"其它入口直接调 onMessage"用的
       * 第二道 —— 两道判断的语义必须分开，否则第一条消息会被自己挡掉。
       */
      if (context.claimed !== true) {
        const replayed = inbox.seenEvent(message.event_id)
        if (replayed !== null && replayed !== message.message_id) {
          return { ok: true, skipped: 'duplicate', message_id: message.message_id, duplicate_of: replayed, dedupe_key: 'event_id' }
        }
        if (inbox.seen(message.message_id)) {
          return { ok: true, skipped: 'duplicate', message_id: message.message_id, dedupe_key: 'message_id' }
        }
      }
      inbox.record(message)
      /*
       * 非文本消息（图片 / 文件 / 语音）：**没有正文可读，但也不是"没收到"**。
       * 内容已经落在 `assets/` 里，这里记一条"为什么没建单"，并把它交给调用方回执
       * （设计 04 §9："群里回一句『已收到图片』"）。不进分诊：没有文字可判。
       */
      if (String(message.text ?? '').trim() === '' && assets.length > 0) {
        inbox.record(message, {
          triage_kind: 'asset',
          ignored_reason: '非文本消息：内容已落库为资产，没有可读的正文',
        })
        return { ok: true, kind: 'asset', assets, message_id: message.message_id, triage_kind: 'asset' }
      }
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
