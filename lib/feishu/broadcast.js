/*
 * 来源：hub/src/runtime/broadcast.ts（570 行，TypeScript）
 *      + hub/test/broadcast.test.ts 的 20 例标题
 *
 * 设计文档：team-agent-architecture/04-feishu-message-design.md §1–§3.5
 *
 * 播报决策引擎 + 卡片构建 + 幂等落地形态。一句话概括这一层存在的理由：
 * 单机插件是「人问 → 机器人答」，团队版是「系统主动播报」，
 * 一不留神就变成刷屏。所以「要不要说话」必须是**一条显式规则**，
 * 而不是散落在代码各处的 if。
 *
 * 改了什么：
 *   1. **TS → 纯 ESM JavaScript**，类型改写成 JSDoc @typedef
 *      （BroadcastMode / BroadcastReason / BroadcastDecision / BroadcastInput /
 *      ButtonValue / CardBuildContext / TaskButton）。
 *   2. **卡片渲染全部来自 `./cards.js`**：hub 的 broadcast.ts 只 import
 *      CardSpec/CardBlock 两个类型，运行时靠 messages.ts 渲染；这里同样是
 *      「构建 spec，渲染归卡片层」，但卡片层的入口是 `degradationLadder()` /
 *      `toFeishuCard()`。
 *   3. **门禁判定改为 import `../domain/objects.js`**。hub 从
 *      `domain/objects.ts` 取 `gateSatisfied / gatePending / gateProgress`；
 *      本插件的对应物已经移植在同一包里（lib/domain/objects.js），
 *      是纯函数、无网络无 fs，属于同包依赖而非外部依赖。
 *      这样「任务卡上写的门禁进度」与「状态机判的门禁」永远是同一份实现——
 *      抄一份进来就会在改规则时两边不一致。
 *   4. **改名/形状差异只有一处，且是故意的**：`cardKeyOf('requirement', id)`
 *      返回 `req:<id>`（hub 是 `requirement:<id>`），依据是设计文档 §3.4
 *      写明的 `card_key = req:<id>`；`cardKeyOf` 另外支持 `'decision'`。
 *      其余同名导出的参数顺序与返回结构逐字保持。
 *   4. **新增加固的三件事**（设计文档 §2.3 / §3.3 / §3.4，hub 里只有注释）：
 *      · `BroadcastThrottle` —— 同一个 `card_key` 2 秒内只更新一次
 *        （「2 秒窗口合并且不产生新消息」），`force` 关键跃迁不节流；
 *      · `DigestAggregator` —— digest 模式按话题/桶累积，`merge()` 合并成
 *        **一条**卡（「3 个任务等你决策」而不是 3 条）；
 *      · `BroadcastChannel` —— `card_key → message_id` 的台账，
 *        `opFor()` 决定这次是 create 还是原地 update。
 *        这三样是 hub 里被注释描述、但由更上层的 pipeline/bots 各自拼起来的行为；
 *        在这里它们是**可单独测试的纯逻辑**（时钟由 `now()` 注入）。
 *   5. **按钮 value 补齐设计文档 §3.3 的字段集**：
 *      `action / object / id / actor / expect / nonce / expires_at`。
 *      hub 的 ButtonValue 只有 `action / object / id / nonce / expect`，
 *      设计文档写的是 `action / task_id / actor / nonce / expires_at`。
 *      两边都要满足，所以：`expect` 沿用 hub 的名字，`actor` 是同一个值的
 *      别名（缺省等于 expect，`ctx.actorOf` 可给出 open_id），
 *      `expires_at` 由 `ctx.now()` + `BUTTON_TTL_MS` 算出（`ctx.expiresAt` 可覆盖）。
 *      **操作者一律以服务端真实 sender 为准，按钮里的 actor/expect 只是文案**
 *      ——见文件末尾的注释与 cards.js 的按钮渲染，这条没有改动。
 *   6. **`cardKeyOf` 支持 decision**：hub 只覆盖 task/requirement，设计文档 §3.4
 *      还要求 `decision:<id>`，而 `buildDecisionCard()` 本来就在本模块里。
 *
 * 没能保住的语义（显式列出）：
 *   1. **`Lease` 类型来自 schema**：hub 的 `CardBuildContext.leaseOf` 返回
 *      `import('../objects/schema.ts').Lease`。这里不 import 类型（JS 无类型），
 *      只按用到的字段读：`state / expires_at / holder / renewals`。
 *      副作用是**传进来的租约不校验**，字段缺失会静默少显示一行。
 *   2. **`decideBroadcast` 的 `chat_id` 只是透传**：hub 一样，这里没加任何
 *      「该不该发到这个群」的判断（那是 access/visibility 的职责）。
 *   3. **@人配额的「谁在 @」粒度是 (dayKey, botId, who)**，与 hub 逐字一致；
 *      但**跨进程不共享**（纯内存 Map，重启即清零）。hub 也是内存实现，
 *      所以这是保住的语义，而不是丢失的——只是在这里点名，
 *      免得被当成持久配额用。
 *   4. **节流/合并的时钟**：本模块不读 `Date.now()`，一律由调用方注入
 *      （`now()` 选项或方法参数）。hub 没有这两个类，所以「与 hub 一致」
 *      在这里不适用——依据是设计文档 §2.3 的 2 秒窗口，不是代码。
 *   5. **没有 `buildNoticeCard` 的 hub 原型**：hub 里「通知卡」只是设计文档
 *      §2.1 表格里的一行（提醒/催办/异常，一次性），没有对应构造函数。
 *      这里按约定名新写，并明确它就是「一次性的、不原地更新的卡」，
 *      与 `buildReportCard()` 同一形态（内部即委托给它），不假装是从 hub 搬来的。
 *   6. `BroadcastReason` 的取值表与 hub 一致，但**没有任何地方强校验**它
 *      （TS 的联合类型在 JS 里没有运行期对应物），错拼只会在日志里看出来。
 */

import { gatePending, gateProgress, gateSatisfied } from '../domain/objects.js'

/* ------------------------------------------------------------------ *
 * 决策
 * ------------------------------------------------------------------ */

/**
 * @typedef {'immediate'|'digest'|'suppress'} BroadcastMode
 * @typedef {'state_transition'|'gate_needs_human'|'mention'|'progress'|'log'
 *   |'duplicate'|'noise'|'quota_exceeded'} BroadcastReason
 *
 * @typedef {object} BroadcastDecision
 * @property {BroadcastMode} mode
 * @property {BroadcastReason} reason
 * @property {string|null} card_key 卡片标识：同一个 card_key 的更新不产生新消息（幂等落地形态）
 * @property {string|null} chat_id
 * @property {string[]} mention 需要 @ 的人（Principal）
 * @property {string|null} digest_bucket digest 模式下进哪个摘要桶
 * @property {string} note 机器人自己的可读理由，用于日志与调试
 *
 * @typedef {object} BroadcastInput
 * @property {'task'|'requirement'|'callout'} kind
 * @property {boolean} [human_initiated] 是否由人类直接触发（被 @、点了按钮）——一律立即播报
 * @property {boolean} [duplicate] 是否重复事件（相同 card_key 的重复触发）
 * @property {boolean} [progress] 是否纯进度（中间步骤、日志）
 * @property {string|null} [chat_id]
 * @property {Array<{name:string, pending:string[]}>} [pending_gates] 需要人做的门禁
 */

/**
 * 决定一条播报该怎么走。
 *
 * 三种模式（设计文档 04 §2.2）：
 *   immediate —— 状态跃迁、需要人决策、被人 @：立刻播报
 *   digest    —— 进度、中间产物、日志：进摘要与看板，**不进群**
 *   suppress  —— 重复与噪声：只记事件日志
 *
 * @param {BroadcastInput} input
 * @returns {BroadcastDecision}
 */
export function decideBroadcast(input) {
  const base = {
    card_key: null,
    chat_id: input.chat_id ?? null,
    mention: [],
    digest_bucket: null,
  }

  if (input.duplicate === true) {
    return { ...base, mode: 'suppress', reason: 'duplicate', note: '重复事件，只记日志' }
  }

  if (input.pending_gates !== undefined && input.pending_gates.length > 0) {
    const pending = input.pending_gates.flatMap((g) => g.pending)
    return {
      ...base,
      mode: 'immediate',
      reason: 'gate_needs_human',
      mention: pending,
      note: `门禁 ${input.pending_gates.map((g) => g.name).join('/')} 需要人确认`,
    }
  }

  if (input.human_initiated === true) {
    return { ...base, mode: 'immediate', reason: 'mention', note: '人类直接触发（被 @ 或点了按钮）' }
  }

  if (input.progress === true) {
    return {
      ...base,
      mode: 'digest',
      reason: 'progress',
      digest_bucket: input.kind,
      note: '进度类，进摘要不进群',
    }
  }

  return { ...base, mode: 'immediate', reason: 'state_transition', note: '状态跃迁' }
}

/* ------------------------------------------------------------------ *
 * @人配额
 * ------------------------------------------------------------------ */

/**
 * @人配额。
 *
 * 每个机器人每天主动 @ 同一个人不超过 N 次，超了改成静默待办——
 * 否则「催办」会变成骚扰，人会直接屏蔽机器人。
 */
export class MentionQuota {
  #limit
  #used = new Map()

  constructor(limitPerDay = 3) {
    this.#limit = limitPerDay
  }

  /**
   * @param {string} botId
   * @param {string} who Principal
   * @param {string} dayKey 形如 2026-02-03（由调用方给出，本模块不读时钟）
   * @returns {boolean} 是否允许这次 @（超限时调用方应改为静默待办）
   */
  tryConsume(botId, who, dayKey) {
    const key = `${dayKey}|${botId}|${who}`
    const used = this.#used.get(key) ?? 0
    if (used >= this.#limit) return false
    this.#used.set(key, used + 1)
    return true
  }

  used(botId, who, dayKey) {
    return this.#used.get(`${dayKey}|${botId}|${who}`) ?? 0
  }

  /** 当日上限（运维面板与测试用；hub 里是私有的 #limit） */
  get limit() {
    return this.#limit
  }

  /** 超限后应改为静默待办——由调用方落到看板 */
  static asSilent(decision) {
    if (decision.mode !== 'immediate' || decision.mention.length === 0) return decision
    return {
      ...decision,
      reason: 'quota_exceeded',
      mention: [],
      note: `${decision.note}（@人配额已用尽，改为静默待办）`,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 节流与合并（设计文档 §2.3）
 * ------------------------------------------------------------------ */

/** 同一个 card_key 的更新节流窗口：2 秒 */
export const THROTTLE_MS = 2_000

/**
 * 不节流的理由（设计文档 §2.3「关键状态跃迁不节流」）。
 *
 * 状态跃迁与门禁催办是人必须看到的；把它们也合并掉，就等于
 * 「任务卡在 2 秒窗口里没更新」，而人只会看到一张停在旧状态的卡。
 */
export const CRITICAL_REASONS = Object.freeze(['state_transition', 'gate_needs_human'])

/** 这条决策是否关键（关键的一条永远不过节流） */
export function isCritical(decision) {
  return CRITICAL_REASONS.includes(decision.reason)
}

/**
 * 卡片更新节流：同一个 `card_key` 在窗口内**只更新一次**，不产生新消息。
 *
 * 「关键状态跃迁不节流」落在 `admit()` 自己身上（`CRITICAL_REASONS`），
 * 调用方不需要记得传 `force`——记不住的开关一定会被漏掉。
 * `{ force: true }` 仍然保留，用于状态机之外确实需要强推的场景。
 *
 * 时钟一律由调用方给出，本类不读 `Date.now()`：节流是时间相关的逻辑，
 * 藏一个真实时钟进去就没法确定性地测。
 */
export class BroadcastThrottle {
  #windowMs
  #lastAt = new Map()

  constructor(windowMs = THROTTLE_MS) {
    this.#windowMs = windowMs
  }

  get windowMs() {
    return this.#windowMs
  }

  /**
   * @param {{card_key:string|null, mode:BroadcastMode, reason?:BroadcastReason}} decision
   * @param {number} nowMs
   * @param {{force?:boolean}} [opts]
   * @returns {boolean} true = 现在就发（或更新）；false = 窗口内，先并着
   */
  admit(decision, nowMs, opts = {}) {
    if (decision.mode !== 'immediate') return false
    const key = decision.card_key
    if (key === null || key === undefined || key === '') return true
    if (opts.force === true || isCritical(decision)) {
      this.#lastAt.set(key, nowMs)
      return true
    }
    const last = this.#lastAt.get(key)
    if (last !== undefined && nowMs - last < this.#windowMs) return false
    this.#lastAt.set(key, nowMs)
    return true
  }

  /** 窗口内已合并且还没到点重发的卡片（调用方用它在窗口结束时补一次更新） */
  pending(nowMs) {
    const out = []
    for (const [key, last] of this.#lastAt) {
      if (nowMs - last < this.#windowMs) out.push(key)
    }
    return out
  }

  /** 距离允许下一次更新还有多少毫秒（0 = 现在就可以） */
  dueIn(cardKey, nowMs) {
    const last = this.#lastAt.get(cardKey)
    if (last === undefined) return 0
    return Math.max(0, this.#windowMs - (nowMs - last))
  }

  forget(cardKey) {
    this.#lastAt.delete(cardKey)
  }
}

/**
 * 摘要合并：`digest` 模式**不进群**，同话题攒着，到点合并成**一条**卡。
 *
 * 设计文档 §2.3：「同一话题的多次播报合并：例如『3 个任务等你决策』一条卡，
 * 而不是 3 条」。桶键优先取 `digest_bucket`（= 事件 kind），
 * `merge(decision, opts.topic)` 可指定更细的话题（例如同一个需求）。
 */
export class DigestAggregator {
  #buckets = new Map()

  /** 收下一条 digest；返回它落在哪个桶（immediate/suppress 一律返回 null） */
  add(decision, opts = {}) {
    if (decision.mode !== 'digest') return null
    const explicit = opts.topic ?? decision.topic
    const bucket = explicit ?? decision.digest_bucket ?? 'misc'
    const lines = this.#buckets.get(bucket) ?? []
    lines.push(opts.line ?? decision.note)
    this.#buckets.set(bucket, lines)
    return bucket
  }

  /** 当前桶内容（不消费） */
  peek(bucket) {
    return [...(this.#buckets.get(bucket) ?? [])]
  }

  get buckets() {
    return [...this.#buckets.keys()]
  }

  /** 取走并清空一条合并后的卡（一次 flush 只对应一条消息） */
  merge(bucket, opts = {}) {
    const lines = this.#buckets.get(bucket)
    if (lines === undefined || lines.length === 0) return null
    this.#buckets.delete(bucket)
    if (lines.length === 1) {
      return { title: opts.title ?? digestTitle(bucket, 1), lines: [...lines], merged: 1 }
    }
    return {
      title: opts.title ?? digestTitle(bucket, lines.length),
      lines: [...lines],
      merged: lines.length,
    }
  }

  /** 把所有桶都取走（日报用） */
  drain() {
    const out = []
    for (const bucket of [...this.#buckets.keys()]) {
      const merged = this.merge(bucket)
      if (merged !== null) out.push({ bucket, ...merged })
    }
    return out
  }
}

function digestTitle(bucket, count) {
  return count > 1 ? `${bucket} 摘要（${count} 条合并）` : `${bucket} 摘要`
}

/* ------------------------------------------------------------------ *
 * 幂等落地：card_key → message_id
 * ------------------------------------------------------------------ */

/**
 * 卡片键：同一对象的更新都落在同一张卡上（设计文档 §3.4）。
 *
 * 与 hub 的区别：hub 只覆盖 task/requirement，这里补上 `decision`；
 * 需求的键用设计文档写明的 `req:<id>`（hub 用 `requirement:<id>`，
 * 两者都能用，但既然设计文档点名了 `req:`，就按文档的来）。
 *
 * @param {'task'|'requirement'|'decision'} kind
 * @param {string} id
 */
export function cardKeyOf(kind, id) {
  if (kind === 'task') return `task:${id}`
  if (kind === 'requirement') return `req:${id}`
  if (kind === 'decision') return `decision:${id}`
  return `${kind}:${id}`
}

/**
 * 播报台账：谁已经有一张卡了。
 *
 * 这就是 `card_key` 幂等形态的落地——同一张卡只创建一次，之后都是原地更新；
 * 卡被删了就重发一条新的（`gone`），而不是永远 update 一张不存在的消息。
 */
export class BroadcastChannel {
  #cards = new Map()
  #archived = new Set()

  /**
   * 这次该 create 还是原地更新？
   *
   * @param {string|null} cardKey
   * @param {{force?:boolean}} [opts] force = 关键跃迁，允许打破节流
   * @returns {{card_key:string|null, op:'create'|'update'|'resent', message_id:string|null, throttled:boolean}}
   */
  opFor(cardKey, opts = {}) {
    if (cardKey === null || cardKey === undefined || cardKey === '') {
      return { card_key: null, op: 'create', message_id: null, throttled: false }
    }
    if (this.#archived.has(cardKey)) {
      return { card_key: cardKey, op: 'resent', message_id: null, throttled: false }
    }
    const messageId = this.#cards.get(cardKey)
    if (messageId === undefined) return { card_key: cardKey, op: 'create', message_id: null, throttled: false }
    return { card_key: cardKey, op: 'update', message_id: messageId, throttled: opts.force !== true }
  }

  /** 记下「这张卡现在在哪条消息上」 */
  bind(cardKey, messageId) {
    if (cardKey === null || cardKey === undefined || cardKey === '') return
    if (messageId === null || messageId === undefined || messageId === '') return
    this.#archived.delete(cardKey)
    this.#cards.set(cardKey, messageId)
  }

  /** 卡没了（被撤回/被清理）：下一次重新创建 */
  markGone(cardKey) {
    if (cardKey === null || cardKey === undefined || cardKey === '') return
    this.#cards.delete(cardKey)
    this.#archived.add(cardKey)
  }

  messageIdOf(cardKey) {
    return this.#cards.get(cardKey) ?? null
  }

  /** 落在同一张卡上的通知应该合并成一条，而不是每条一个 key */
  static keyFor(decision, target) {
    if (decision.card_key !== null && decision.card_key !== undefined && decision.card_key !== '') {
      return decision.card_key
    }
    return target === undefined || target === null ? null : cardKeyOf(target.kind, target.id)
  }
}

/**
 * 决策 + 目标对象 → 发送目标（chat_id + 幂等键）。
 *
 * 返回 null 表示**这条决策不该产生消息**（suppress / digest / 没有 chat_id），
 * 调用方必须尊重它——「播报必须过决策引擎」的落点就是这里。
 *
 * ⚠️ `target` 是**调用方必须给的那一半信息**：`decideBroadcast()` 只按事件类型
 * 决策，它不知道这是哪个任务/需求/决策，所以 `decision.card_key` 一般是 null。
 * 幂等键由「决策自己带的 card_key」或「target 的 kind:id」二者之一决定；
 * `kind: 'callout'`（无主通知）没有领域对象可依附，只能靠调用方显式给
 * `decision.card_key`，否则每次都是一条新消息——这正是通知卡该有的行为。
 */
export function decisionToTarget(decision, target) {
  if (decision.mode !== 'immediate') return null
  if (decision.chat_id === null || decision.chat_id === undefined || decision.chat_id === '') return null
  const key = BroadcastChannel.keyFor(decision, target)
  return {
    chat_id: decision.chat_id,
    card_key: key,
    reply_to: target?.reply_to ?? null,
    mention: [...decision.mention],
    reason: decision.reason,
  }
}

/**
 * 决策 + 节流 + 台账 → 这一轮到底做什么。
 *
 * 这是发送层唯一该看的入口：`suppress`/`digest` 在这里就被吃掉了，
 * 不存在「某个调用点忘了过决策引擎就直发」的路径。
 *
 * @param {BroadcastDecision} decision
 * @param {BroadcastThrottle} throttle
 * @param {BroadcastChannel} channel
 * @param {number} nowMs
 * @param {{kind:'task'|'requirement'|'decision', id:string, reply_to?:string|null}} [target]
 */
export function planDelivery(decision, throttle, channel, nowMs, target) {
  const send = decisionToTarget(decision, target)
  if (send === null) {
    return { action: 'skip', mode: decision.mode, reason: decision.reason, card_key: null, message_id: null }
  }
  // 关键跃迁不节流：状态跃迁与门禁催办是人必须看到的
  const force = isCritical(decision)
  // 节流按**实际要更新的那张卡**记账：决策自己的 card_key 往往是 null
  // （那是 decideBroadcast 的事，它不知道领域对象），目标对象才给出真正的键。
  // 拿 decision.card_key 去节流等于没节流——这是测试抓出来的第二处。
  if (!throttle.admit({ ...decision, card_key: send.card_key }, nowMs, { force })) {
    return { action: 'throttled', mode: decision.mode, reason: decision.reason, card_key: send.card_key, message_id: null }
  }
  const op = channel.opFor(send.card_key, { force })
  return {
    action: op.op,
    mode: decision.mode,
    reason: decision.reason,
    card_key: send.card_key,
    message_id: op.message_id,
    chat_id: send.chat_id,
    mention: send.mention,
  }
}

/* ------------------------------------------------------------------ *
 * 卡片构建
 * ------------------------------------------------------------------ */

/** 状态 → emoji 色块（⚪待接受 / 🔵已接受 / 🟡进行中 / 🔴阻塞 / 🟠等待中 / 🟢完成） */
export const TASK_STATUS_EMOJI = Object.freeze({
  proposed: '⚪ 提案待确认',
  confirmed: '⚪ 已确认拆解',
  assigned: '⚪ 待接受',
  accepted: '🔵 已接受',
  in_progress: '🟡 进行中',
  ci_running: '🟠 等 CI',
  blocked: '🔴 阻塞',
  in_review: '🟠 待验收',
  rejected: '⚫ 已拒绝',
  suspended: '⚫ 已挂起',
  dropped: '⚫ 已废弃',
  done: '🟢 已完成',
  archived: '⚪ 已归档',
})

export const REQ_STATUS_EMOJI = Object.freeze({
  draft: '⚪ 待澄清',
  confirmed: '🔵 已确认',
  dispatched: '🟡 已拆解',
  done: '🟢 已完成',
  archived: '⚪ 已归档',
  changed: '🟠 变更中',
  blocked: '🔴 阻塞',
  suspended: '⚫ 已挂起',
  dropped: '⚫ 已废弃',
})

/**
 * 按钮 value 的有效期（默认 1 小时）。
 *
 * 设计文档 §3.3 的 value 里带 `expires_at`：卡片会一直躺在聊天记录里，
 * 没有有效期的话，一周前的卡点下去仍然会命中状态机。
 */
export const BUTTON_TTL_MS = 3_600_000

/** 主体显示名：human:chen-req → @chen-req */
export function shortName(p) {
  if (p === 'system') return '系统'
  const idx = p.indexOf(':')
  return idx < 0 ? p : `@${p.slice(idx + 1)}`
}

export function taskStatusLine(task) {
  const who = task.assignee === null || task.assignee === undefined ? '未指派' : shortName(task.assignee)
  return `${TASK_STATUS_EMOJI[task.state]} · 负责人 ${who}`
}

export function requirementStatusLine(req) {
  return `${REQ_STATUS_EMOJI[req.state]} · 责任人 ${shortName(req.owner)}`
}

/**
 * @typedef {object} CardBuildContext
 * @property {() => string} nonce nonce 生成器（测试里注入固定值）
 * @property {(taskId:string) => object|null} [leaseOf] 该任务的租约（有就显示剩余时间）
 * @property {() => Date} [now] 现在几点（算租约剩余时间与按钮有效期）；默认取真实时间
 * @property {() => string} [expiresAt] 按钮有效期（缺省 now()+BUTTON_TTL_MS）
 * @property {(p:string) => string} [actorOf] 期望操作者的真实身份（open_id）；缺省用 Principal
 *
 * 按钮 value 的约定见 `buttonValue()`：本模块只写「期望操作者」用于文案，
 * **真正的权限判定必须在服务端拿真实 sender 做**。
 */

function nowOf(ctx) {
  return ctx.now?.() ?? new Date()
}

function expiresAtOf(ctx) {
  if (ctx.expiresAt !== undefined) return ctx.expiresAt()
  return new Date(nowOf(ctx).getTime() + BUTTON_TTL_MS).toISOString()
}

/**
 * 按钮 value 的唯一构造点。
 *
 * 字段集（设计文档 §3.3 + hub 的 ButtonValue）：
 *   action      动作名，服务端白名单校验
 *   object      领域对象类型
 *   id          领域对象 id
 *   actor       期望操作者（仅文案提示）
 *   expect      与 actor 同值，hub 的名字（回调解析读的就是它）
 *   nonce       一次性，用后作废（落库，重启不失效）
 *   expires_at  有效期，过期按钮一律拒绝
 *
 * ⚠️ **操作者一律以服务端收到的真实 sender 为准，绝不信按钮里携带的身份。**
 * 这里的 actor/expect 只是「这按钮本来是给谁看的」的提示，
 * 用来渲染与日志，不能作为任何权限判断的输入。
 */
export function buttonValue(action, object, id, expect, ctx) {
  const value = { action, object, id }
  if (expect !== undefined && expect !== null) {
    value.expect = expect
    value.actor = ctx?.actorOf !== undefined ? ctx.actorOf(expect) : expect
  }
  value.nonce = ctx.nonce()
  value.expires_at = expiresAtOf(ctx)
  return value
}

/**
 * 任务卡。
 *
 * `card_key = task:<id>`：从提案到完成**只有一张卡**，事件重复触发时
 * 结果是「更新同一张卡」而不是「再发一条」——这就是幂等的落地形态。
 *
 * 按钮**随状态动态变化**：一件事在任一时刻只显示当前可用的按钮，
 * 否则人会对着旧卡点出无效操作。
 *
 * @param {object} task
 * @param {CardBuildContext} ctx
 */
export function buildTaskCard(task, ctx) {
  const blocks = []
  if (task.acceptance_criteria.length > 0) {
    blocks.push({
      kind: 'markdown',
      content: '**验收标准**\n' + task.acceptance_criteria.map((c) => `- ${c}`).join('\n'),
    })
  }
  if (task.blocked_reason !== null && task.blocked_reason !== undefined) {
    blocks.push({ kind: 'markdown', content: `**阻塞原因**：${task.blocked_reason}` })
  }
  if (task.evidence.length > 0) {
    blocks.push({
      kind: 'markdown',
      content:
        '**证据**\n' +
        task.evidence
          .map((e) => `- \`${e.kind}\` ${e.ref}${e.note === undefined ? '' : ` — ${e.note}`}`)
          .join('\n'),
    })
  }
  // 租约：让人看得见「我还有多久」。看不见期限的承诺等于没有期限。
  const lease = ctx.leaseOf?.(task.id) ?? null
  if (lease !== null && (lease.state === 'active' || lease.state === 'expired')) {
    const now = nowOf(ctx)
    const left = Date.parse(lease.expires_at) - now.getTime()
    const overdue = left <= 0
    blocks.push({
      kind: 'markdown',
      content: overdue
        ? `**⏰ 租约已过期**（${describeLeaseSpan(-left)}）· 持有人 ${shortName(lease.holder)}`
        : `**⏰ 租约剩余 ${describeLeaseSpan(left)}** · 持有人 ${shortName(lease.holder)}` +
          (lease.renewals > 0 ? ` · 已续约 ${lease.renewals} 次` : ''),
    })
  }

  const buttons = taskButtons(task, ctx)
  if (buttons.length > 0) blocks.push({ kind: 'buttons', buttons })

  const confirmLine = taskConfirmLine(task)
  return {
    title: '📋 任务',
    anchor: `${task.id} · ${task.req}`,
    status: `${taskStatusLine(task)}\n${task.title}`,
    ...(confirmLine === null ? {} : { confirm_line: confirmLine }),
    blocks,
    footer: footerOf(task, ctx.runOf?.(task.id) ?? null),
    headerTemplate: headerTemplateOf(task.state),
  }
}

/**
 * 当前状态该显示哪些按钮。
 *
 * 这份映射是设计文档 04 §3.3 按钮表的代码化，也是**权限的第一道暗示**：
 * 被指派人看到「接受/拒绝」，需求负责人看到「验收」。
 *
 * @returns {Array<{label:string, action:string, value:Record<string,unknown>, type?:string}>}
 */
export function taskButtons(task, ctx) {
  const v = (action, expect) => buttonValue(action, 'task', task.id, expect, ctx)
  const out = []

  switch (task.state) {
    case 'proposed':
      if (task.gates.confirm_split !== undefined && !gateSatisfied(task.gates.confirm_split)) {
        const who = task.gates.confirm_split.required_by[0]
        out.push({
          label: '确认拆解',
          action: 'task.confirm_split',
          value: v('task.confirm_split', who),
          type: 'primary',
        })
      }
      break
    case 'assigned':
      out.push({
        label: '接受',
        action: 'task.accept',
        value: v('task.accept', task.assignee ?? undefined),
        type: 'primary',
      })
      out.push({
        label: '拒绝',
        action: 'task.reject',
        value: v('task.reject', task.assignee ?? undefined),
        type: 'danger',
      })
      break
    case 'accepted':
      out.push({
        label: '开始',
        action: 'task.start',
        value: v('task.start', task.assignee ?? undefined),
        type: 'primary',
      })
      out.push({ label: '续约', action: 'task.renew', value: v('task.renew', task.assignee ?? undefined) })
      out.push({ label: '交回', action: 'task.unassign', value: v('task.unassign', task.assignee ?? undefined) })
      break
    case 'in_progress':
      out.push({ label: '续约', action: 'task.renew', value: v('task.renew', task.assignee ?? undefined) })
      out.push({ label: '阻塞', action: 'task.block', value: v('task.block', task.assignee ?? undefined) })
      out.push({
        label: '提交验收',
        action: 'task.submit',
        value: v('task.submit', task.assignee ?? undefined),
        type: 'primary',
      })
      break
    case 'blocked':
      out.push({
        label: '解除阻塞',
        action: 'task.unblock',
        value: v('task.unblock', task.assignee ?? undefined),
        type: 'primary',
      })
      break
    case 'in_review': {
      const acceptor = task.gates.acceptance?.required_by[0]
      out.push({
        label: '验收通过',
        action: 'task.verify',
        value: v('task.verify', acceptor),
        type: 'primary',
      })
      out.push({
        label: '打回',
        action: 'task.reject_review',
        value: v('task.reject_review', acceptor),
        type: 'danger',
      })
      break
    }
    default:
      break
  }
  return out
}

/**
 * 任务进入**当前状态**的时间（最后一条 `to === task.state` 的历史）。
 *
 * 门禁没有自己的"激活时间"字段，也不需要：一道门禁开始等，就是从任务进入
 * 它所在的那个状态开始的（`assigned` → 等接受，`accepted` → 等开始…）。
 * 历史每次跃迁都写 `at`，所以这是现成的、还不用改 schema。
 */
function stateSinceOf(task) {
  const history = Array.isArray(task?.history) ? task.history : []
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry !== null && typeof entry === 'object' && entry.to === task.state && typeof entry.at === 'string') return entry.at
  }
  return null
}

/**
 * 确认行：跨域任务才显示各方进度（设计文档 04 §3.5）。
 *
 * 这一行要回答两个"看不出来就会出事"的问题（R5.6 / R7.7）：
 *
 *   1. **等了多久** —— "慢"和"死"在卡片上一模一样，这是这类卡最要命的地方。
 *      没过的门禁都带 `已等 X`（起点 = 任务进入当前状态的那一刻，见 `stateSinceOf`）。
 *   2. **谁在代确认** —— 门禁名单为空（那个域一个人都没有）时，需求负责人可以代确认。
 *      卡上只写"0/0"会让人以为没有出路，所以要把"由谁代"写明。
 */
export function taskConfirmLine(task, opts = {}) {
  const now =
    opts.now instanceof Date ? opts.now : typeof opts.now === 'string' && opts.now !== '' ? new Date(opts.now) : new Date()
  const since = stateSinceOf(task)
  const waitedAt = since === null ? null : `${describeLeaseSpan(Math.max(0, now.getTime() - Date.parse(since)))}`
  const parts = []
  for (const name of ['confirm_split', 'accept', 'start', 'acceptance']) {
    const gate = task.gates[name]
    if (gate === undefined || gate.not_applicable) continue
    const label = { confirm_split: '拆解', accept: '接受', start: '开始', acceptance: '验收' }[name]
    if (gateSatisfied(gate)) {
      /*
       * 已经确认的门禁里，如果有**代确认者**（那个域没人、由 fallback 顶上），
       * 也要说出来：否则"验收已确认"看上去像那个域点过头了（R5.6）。
       */
      const standIns = Array.isArray(gate.stand_ins) ? gate.stand_ins : []
      const by = gate.confirmed_by.map((c) => c.by).filter((who) => standIns.includes(who))
      parts.push(`✅ ${label}已确认${by.length === 0 ? '' : `（${by.map(shortName).join(' ')} 代）`}`)
    } else {
      const { confirmed, required } = gateProgress(gate)
      const standIns = Array.isArray(gate.stand_ins) ? gate.stand_ins : []
      const who = gatePending(gate)
        .map((one) => (standIns.includes(one) ? `${shortName(one)} 代确认` : shortName(one)))
        .join(' ')
      /*
       * 名单为空 = 没人被指派，只有需求负责人/项目经理能点头。这不是"0/0 无解"，
       * 是**代确认**，所以要把代的人是谁写出来。
       */
      const standing =
        gate.required_by.length === 0 && task.owner !== null && task.owner !== undefined ? `由 ${shortName(task.owner)} 代确认` : ''
      const detail = [who, standing, waitedAt === null ? '' : `已等 ${waitedAt}`].filter((one) => one !== '').join(' · ')
      parts.push(`⏳ 待${label}确认（${confirmed}/${required}${detail === '' ? '' : ` · ${detail}`}）`)
    }
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

function headerTemplateOf(state) {
  if (state === 'done') return 'green'
  if (state === 'blocked' || state === 'rejected' || state === 'dropped') return 'red'
  if (state === 'in_review' || state === 'ci_running') return 'orange'
  return 'blue'
}

/**
 * footer note：域 / 释放次数 / 分支 + **上一轮的耗时、token、步数**。
 *
 * 设计 04 §3.1 对这一段的要求只有一句，但很硬：**"provider 不上报的字段整段不显示，
 * 不谎报 0"**。所以这里每一段都是"有才写"：
 *
 *   · `tokens` 为 null（tokenMeter 没挂、或 provider 没报用量）→ 整段不出现，
 *     而不是写"🧠 0 tok"；估算出来的用量带 `≈`，与 provider 实报的数字区分开；
 *   · 没有跑过（没有 `last_run`）→ 耗时/步数也不出现，任务卡就回到纯台账信息。
 *
 * @param {object} task
 * @param {{elapsed_ms?: number, steps?: number, tokens?: {value: number, source: string}|null}|null} [run]
 */
export function footerOf(task, run = null) {
  const bits = [`${task.domains.join('/')}`]
  if (task.release_count > 0) bits.push(`已释放 ${task.release_count} 次`)
  if (task.branch !== null && task.branch !== undefined) bits.push(`分支 ${task.branch}`)
  /*
   * CI 状态（设计 03 §1.5）：长流水线最容易变成"看起来卡住了"，所以卡片上要能
   * 一眼看到"在等 CI / 等了多久"。**没有 CI 记录就整段不出现**（与 token 同一条规矩）。
   */
  const ci = task.ci !== null && typeof task.ci === 'object' ? task.ci : null
  if (ci !== null && typeof ci.state === 'string') {
    if (ci.state === 'running') {
      const started = typeof ci.started_at === 'string' ? Date.parse(ci.started_at) : NaN
      const waited = Number.isFinite(started) ? Math.max(0, Date.now() - started) : null
      bits.push(waited === null ? '🧪 CI 等待中' : '🧪 CI 等待中 ' + formatElapsed(waited))
    } else if (ci.state === 'passed') bits.push('🧪 CI 通过')
    else if (ci.state === 'failed') bits.push('🧪 CI 失败')
  }
  const measured = run !== null && typeof run === 'object' ? run : null
  if (measured !== null) {
    const elapsed = Number(measured.elapsed_ms)
    // "跑了 0 秒"和"这一轮超时了"都要能被看见：0 是有意义的（瞬时完成），
    // 而超时是"它还在等"的信号，不能省。
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      bits.push('⏱ ' + formatElapsed(elapsed) + (measured.timed_out === true ? '（超时）' : ''))
    }
    const tokens = measured.tokens
    const value = Number(tokens?.value)
    /*
     * `tokens` 为 null = **没量到**（tokenMeter 没挂 / provider 没报），整段不显示；
     * 量到 0 就是 0，照显 —— 与上一行的耗时同一个语义（`elapsed=0` 也照显）。
     * 同一行灰字里两种"0"含义相反，读的人只会以为其中一个坏了。
     */
    if (tokens !== null && tokens !== undefined && Number.isFinite(value) && value >= 0) {
      bits.push('🧠 ' + (tokens.source === 'usage' ? '' : '≈') + formatTokens(value) + ' tok')
    }
    const steps = Number(measured.steps)
    if (Number.isFinite(steps) && steps > 0) bits.push('🔄 ' + String(steps) + ' 步')
  }
  return bits.join(' · ')
}

/** `2m14s` / `840ms` / `1h02m` —— 卡片上的灰字要短，但单位不能丢。 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  if (total < 1000) return String(total) + 'ms'
  const seconds = Math.round(total / 1000)
  if (seconds < 60) return String(seconds) + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return String(minutes) + 'm' + String(seconds % 60).padStart(2, '0') + 's'
  const hours = Math.floor(minutes / 60)
  return String(hours) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
}

/** `12.3k` / `940` —— 与设计示例的写法一致。 */
export function formatTokens(value) {
  const total = Math.max(0, Math.round(Number(value) || 0))
  if (total < 1000) return String(total)
  if (total < 1_000_000) return (total / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (total / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

/**
 * 需求卡。
 *
 * `card_key = req:<id>`。需求卡要能一眼看出卡在**哪一步**：
 * 待确认拆解 / 等某人接受 / 等某人开始——这是设计文档 02 §3 的硬要求。
 *
 * @param {object} req
 * @param {object[]} tasks 全部任务（本函数自己筛出属于该需求的）
 * @param {CardBuildContext} ctx
 */
export function buildRequirementCard(req, tasks, ctx) {
  const mine = tasks.filter((t) => t.req === req.id)
  const blocks = []

  if (req.body.problem !== '' || req.body.proposal !== '') {
    blocks.push({
      kind: 'markdown',
      content: [
        req.body.problem === '' ? '' : `**问题**：${req.body.problem}`,
        req.body.proposal === '' ? '' : `**方案**：${req.body.proposal}`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    })
  }
  if (req.acceptance_criteria.length > 0) {
    blocks.push({
      kind: 'markdown',
      content: '**验收标准**\n' + req.acceptance_criteria.map((c) => `- ${c}`).join('\n'),
    })
  }
  if (mine.length > 0) {
    blocks.push({
      kind: 'table',
      table: {
        headers: ['任务', '状态', '负责人'],
        rows: mine.map((t) => [t.title, TASK_STATUS_EMOJI[t.state], shortName(t.assignee ?? 'system')]),
      },
    })
  }

  const buttons = []
  const reqButton = (label, action, type) => ({
    label,
    action,
    value: buttonValue(action, 'requirement', req.id, req.owner, ctx),
    ...(type === undefined ? {} : { type }),
  })
  /** 误判的出口：不是需求就一键丢掉，而不是让它躺在待办里 */
  const dropButton = () => reqButton('废弃', 'req.drop', 'danger')

  if (req.state === 'draft') {
    buttons.push(reqButton('确认需求', 'req.confirm', 'primary'))
    // 人 @ 了机器人但说的其实不是需求时，负责人要能一键丢掉。
    // 没有这个按钮，「判错一条」就从「多一张待确认的卡」变成「永久噪音」。
    buttons.push(dropButton())
  }
  if (req.state === 'confirmed') {
    buttons.push(reqButton('确认拆解', 'req.confirm_split', 'primary'))
  }
  if (req.state === 'changed') {
    buttons.push(reqButton('确认变更', 'req.reconfirm', 'primary'))
  }
  if (req.state === 'confirmed') {
    buttons.push(dropButton())
  }
  if (buttons.length > 0) blocks.push({ kind: 'buttons', buttons })

  return {
    title: '📌 需求',
    anchor: req.id,
    status: `${requirementStatusLine(req)}\n${req.title}`,
    confirm_line: requirementStage(req, mine),
    blocks,
    footer: `优先级 ${req.priority} · 提出 ${shortName(req.requester)}${
      req.links.repos.length === 0 ? '' : ` · ${req.links.repos.join('/')}`
    }`,
    headerTemplate: req.state === 'done' ? 'green' : req.state === 'changed' ? 'orange' : 'blue',
  }
}

/**
 * 需求当下卡在哪一步。
 *
 * 「待确认拆解 / 等某人接受 / 等某人开始」三种中间态必须能看出来，
 * 否则需求负责人不知道卡在哪（设计文档 02 §3 的注意点）。
 */
export function requirementStage(req, tasks) {
  if (req.state === 'draft') return '⏳ 待澄清（缺验收标准或归属）'
  if (req.state === 'changed') return '⚠️ 需求变更中，等待确认影响面'
  if (req.state === 'done') return '🟢 全部任务已完成'
  if (req.state !== 'dispatched') return ''

  const pending = tasks.filter((t) => t.state === 'proposed' || t.state === 'confirmed')
  if (pending.length > 0) return `⏳ 待确认拆解（${pending.length} 个任务提案）`

  const waitingAccept = tasks.filter((t) => t.state === 'assigned')
  if (waitingAccept.length > 0) {
    return `⏳ 等待接受：${waitingAccept.map((t) => shortName(t.assignee ?? 'system')).join(' ')}`
  }
  const waitingStart = tasks.filter((t) => t.state === 'accepted')
  if (waitingStart.length > 0) {
    return `⏳ 已接受未开始：${waitingStart.map((t) => shortName(t.assignee ?? 'system')).join(' ')}`
  }
  const running = tasks.filter((t) => ['in_progress', 'ci_running', 'in_review', 'blocked'].includes(t.state))
  if (running.length > 0) return `🟡 执行中（${running.length} 个任务）`
  return ''
}

/**
 * 报告卡（日报/周报）：一次性，不原地更新。
 *
 * `card_key` 为 null——它没有领域对象可依附，每次都是一条新消息。
 */
export function buildReportCard(opts) {
  return {
    title: opts.title,
    blocks: [{ kind: 'markdown', content: opts.lines.join('\n') }],
    ...(opts.footer === undefined ? {} : { footer: opts.footer }),
    headerTemplate: 'grey',
  }
}

/**
 * 通知卡（提醒、催办、异常）：一次性，不原地更新。
 *
 * 设计文档 §2.1 的第五种形态。**hub 里没有这个构造函数**（上表只是一行设计），
 * 所以这不是「搬运」而是「按约定名补写」：形态与报告卡一致（一次性，
 * 因此没有 confirm_line、也没有 card_key），只是多了状态行与 note 段，
 * 内部直接委托给 `buildReportCard()`，保证「一次性卡」只有一种实现。
 *
 * @param {{title:string, status?:string, lines?:string[], note?:string,
 *          blocks?:object[], footer?:string,
 *          headerTemplate?:'blue'|'green'|'red'|'orange'|'grey'}} opts
 */
export function buildNoticeCard(opts) {
  const blocks = []
  if (opts.status !== undefined && opts.status !== '') {
    blocks.push({ kind: 'markdown', content: `**${opts.status}**` })
  }
  if (opts.blocks !== undefined) {
    blocks.push(...opts.blocks)
  } else {
    const lines = opts.lines ?? []
    if (lines.length > 0) blocks.push({ kind: 'markdown', content: lines.join('\n') })
  }
  if (opts.note !== undefined && opts.note !== '') {
    blocks.push({ kind: 'note', content: opts.note })
  }

  const card = buildReportCard({
    title: opts.title,
    lines: opts.lines ?? [],
    ...(opts.footer === undefined ? {} : { footer: opts.footer }),
  })
  return { ...card, blocks, ...(opts.headerTemplate === undefined ? {} : { headerTemplate: opts.headerTemplate }) }
}

/**
 * 决策卡（需要人做选择/批准）。
 *
 * 与任务卡的区别：它不属于任何任务对象，是配置审批与权限放行用的。
 * `card_key = decision:<id>`（设计文档 §3.4）——同一个决策只有一张卡，
 * 决策完了原地更新成「已决」，而不是再发一条结果。
 */
export function buildDecisionCard(opts) {
  const blocks = [{ kind: 'markdown', content: opts.body }]
  if (opts.detail !== undefined && opts.detail !== '') {
    blocks.push({ kind: 'markdown', content: `**影响面**\n${opts.detail}` })
  }
  blocks.push({ kind: 'buttons', buttons: opts.options })
  return {
    title: opts.title,
    ...(opts.id === undefined ? {} : { anchor: opts.id }),
    blocks,
    ...(opts.footer === undefined ? {} : { footer: opts.footer }),
    headerTemplate: 'orange',
  }
}

/** 时长描述（租约用；domain/lease.ts 里那版面向小时以上，这版面向卡片） */
export function describeLeaseSpan(ms) {
  const abs = Math.abs(ms)
  const days = Math.floor(abs / 86_400_000)
  const hours = Math.floor((abs % 86_400_000) / 3_600_000)
  const minutes = Math.floor((abs % 3_600_000) / 60_000)
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}`
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ''}`
  return `${Math.max(1, minutes)} 分钟`
}

/** 门禁摘要（日报与运维面板用） */
export function summarizeGates(task) {
  const out = []
  for (const [name, gate] of Object.entries(task.gates)) {
    if (gate.not_applicable) continue
    out.push({ name, satisfied: gateSatisfied(gate), pending: gatePending(gate) })
  }
  return out
}
