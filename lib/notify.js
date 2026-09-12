/*
 * 出站通知：把"系统要说的话"送到群里，并且按设计文档 04 §2 的规则说。
 *
 * 为什么要有这个模块（而不是在各处直接 client.send）。播报层（`lib/feishu/broadcast.js`）
 * 从 hub 搬过来时是完整的、也有完整测试，但在插件里**零调用点** —— 于是群里除了
 * "已记为需求"那一张卡和命令的文本回复之外，接受 / 开始 / 阻塞 / 验收 / 门禁催办 /
 * 超时释放**全程无声**。设计文档 §2 的原话是"团队版是系统主动播报，一不留神就变成刷屏，
 * 所以要把'要不要说话'变成一条显式规则"，这个模块就是那条规则的落地处：
 *
 *   1. `decideBroadcast()` 决定**要不要说**（immediate / digest / suppress）；
 *   2. `planDelivery()` 决定**怎么说**（create / update / resent / throttled / skip），
 *      其中 update 是"同一个话题只有一张卡"的落地；
 *   3. `deliverCard()` 负责**送**，前三级带 `PATCH`（原地更新），失败逐级降级；
 *   4. 卡片的 `card_key → message_id` **落盘**（store 的 `card` 种类），所以重启之后
 *      仍然是同一张卡被更新，而不是群里多出一张新卡。
 *
 * 三条刻意的不变量：
 *   · **永远不抛**。播报失败不能反过来弄坏刚刚写好的台账对象，所以每一步都有兜底，
 *     最差情况是返回 `{action:'failed'}` 并留一行日志。
 *   · **没有 chat_id 就不发**。用 `team` 工具在 DSH 里建的需求没有群可回，
 *     这不是错误，是"这件事不需要在群里说"。
 *   · **不静默丢弃**：skip / throttled / suppressed 都带 reason 返回，调用方会记进
 *     日志与（之后的）观测页 —— "为什么群里没动静"必须能被回答。
 */
import { randomUUID } from 'node:crypto'

import {
  BroadcastChannel,
  BroadcastThrottle,
  DigestAggregator,
  MentionQuota,
  buildNoticeCard,
  buildReportCard,
  buildTaskCard,
  cardKeyOf,
  decideBroadcast,
  planDelivery,
} from './feishu/broadcast.js'
import { deliverCard } from './feishu/cards.js'

/**
 * `card_key` → 可当文件名的 id。
 *
 * `card_key` 形如 `task:task-1`，而 store 的 id 规则只允许 `[A-Za-z0-9._-]`
 * （`lib/store.js` 的 `safeId`，它拦的是路径穿越）。把不允许的字符换成 `.`：
 * 键里的 kind 是固定几个词、id 本身只含 `[A-Za-z0-9._-]`，所以这个映射是单射，
 * 而原始 key 一字不差地存在记录的 `card_key` 字段里（读的时候以它为准）。
 */
export function cardRecordId(cardKey) {
  return String(cardKey).replace(/[^A-Za-z0-9._-]/g, '.')
}

/** 今天（UTC 日期）作为 @人配额的分桶键——本模块自己不读时钟，日期由调用方给。 */
function dayKeyOf(now) {
  return now.toISOString().slice(0, 10)
}

/**
 * @param {{config: object, store: object, clientFor: (info: object) => object|null,
 *          log?: object, now?: () => Date, quotaLimit?: number}} deps
 *   `clientFor` 回答"这个群该由哪个应用/机器人发话"：一个机器人一个应用之后，
 *   发消息的客户端不再唯一（见 lib/feishu/apps.js）。
 */
export function createNotifier(deps) {
  const { config, store } = deps
  const log = deps.log ?? console
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()

  /** 播报台账：把落盘的 card_key → message_id 读回内存，重启后接着更新同一张卡。 */
  const channel = new BroadcastChannel()
  let bound = 0
  for (const record of store.all('card')) {
    if (typeof record.card_key === 'string' && typeof record.message_id === 'string' && record.message_id !== '') {
      channel.bind(record.card_key, record.message_id)
      bound += 1
    }
  }

  const throttle = new BroadcastThrottle()
  const digest = new DigestAggregator()
  /**
   * 被节流窗口并掉、等着补发的卡。
   *
   * `BroadcastThrottle.pending()` 报的是"窗口内刚更新过的卡"，不是"被并掉的卡" ——
   * 直接拿它当待补发清单，会把已经发出去的卡也再发一遍。所以这里自己记一份，
   * 只有真的返回过 `throttled` 的才在里面。
   */
  const throttled = new Map()

  /**
   * 同一个 `card_key` 的投递串行化。
   *
   * 不串行就会**建出两张卡**：`planDelivery` 判"create 还是 update"读的是卡台账，
   * 而台账要在 HTTP 回来之后才写进去。于是两个几乎同时发生的跃迁（机器人承接时
   * `accept` 和 `start` 是连着跑的）都会看到"还没有卡"，各发一条 —— 这正是设计要
   * 避免的刷屏，而且它只在高频路径上出现，手工点两下是看不出来的。
   */
  const inFlight = new Map()
  function withKey(key, work) {
    const previous = inFlight.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    inFlight.set(
      key,
      next.then(
        () => {},
        () => {},
      ),
    )
    return next
  }
  const quota = new MentionQuota(Number.isFinite(deps.quotaLimit) ? deps.quotaLimit : 3)
  const EMPTY_COUNTS = { delivered: 0, updated: 0, throttled: 0, suppressed: 0, digested: 0, skipped: 0, failed: 0 }
  const stats = { ...EMPTY_COUNTS }
  /*
   * 总数只能回答"说了多少句"。设计 04 §11 的第 4、5 条问的是另外两件事：
   * 「降级率」（走了 `text-fallback` 的比例 —— 高就说明卡片渲染有问题）与
   * 「每群发言占比」（> 25% 是"人会不会退群"的前置指标）。两个都是**分组**的比率，
   * 所以从第一次投递起就按 `via` / 群 / 机器人分桶，而不是事后从总数里猜。
   * 这些桶是**本进程**的（重启清零）；跨重启的那一半由 `lib/metrics.js` 从
   * 落盘的卡台账与收件箱里算（"发过几条消息"本来就是落盘事实）。
   */
  const byVia = {}
  const byChat = {}
  const byBot = {}
  let mentions = 0
  let quotaRefused = 0

  function bump(map, key, action, mention) {
    if (typeof key !== 'string' || key === '') return
    const row = map[key] ?? { ...EMPTY_COUNTS, mentions: 0 }
    row[action] += 1
    if (mention > 0) row.mentions += mention
    map[key] = row
  }

  /**
   * 一处记账：总数、按群、按机器人、按 `via`、@人数。
   *
   * 每个返回点都调它，是为了"加了新返回点但忘了计数"这种漏账不会发生：
   * 计数只在这一个函数里改。
   */
  function count(action, info = {}) {
    if (stats[action] === undefined) throw new Error('unknown notify counter: ' + String(action))
    stats[action] += 1
    const mention = Number.isFinite(info.mentions) ? info.mentions : 0
    if (mention > 0) mentions += mention
    bump(byVia, info.via, action, mention)
    bump(byChat, info.chatId, action, mention)
    /* 没有指定机器人 = 这个安装的默认助手（单机器人安装就是这样）：
       归到 `team` 这一桶，而不是让"按机器人"这条线整段消失。 */
    bump(byBot, botIdOf({ botId: info.botId }), action, mention)
  }

  /** 机器人自己的可读理由，用于 @配额计数与日志。 */
  function botIdOf(info) {
    return typeof info?.botId === 'string' && info.botId !== '' ? info.botId : 'team'
  }

  /**
   * 把一条决策送出去。
   *
   * @param {{decision: object, card: object|null, text?: string, target: {kind: string, id: string, chatId: string|null},
   *          botId?: string}} input
   * @returns {Promise<{action: string, reason: string, via?: string, message_id?: string|null, card_key: string|null}>}
   */
  async function deliver(input) {
    const { decision, card, target } = input
    const chatId = typeof target?.chatId === 'string' && target.chatId !== '' ? target.chatId : null

    // digest：进摘要桶，不进群（设计文档 §2.2）。不静默：累计起来供日报/看板用。
    if (decision.mode === 'digest') {
      const bucket = digest.add(decision, { line: input.line })
      count('digested', { chatId, botId: input.botId })
      return { action: 'digest', reason: decision.reason, card_key: null, bucket }
    }
    if (decision.mode === 'suppress') {
      count('suppressed', { chatId, botId: input.botId })
      return { action: 'skip', reason: decision.reason, card_key: null }
    }
    if (chatId === null) {
      count('skipped', { chatId, botId: input.botId })
      return { action: 'skip', reason: 'no-chat', card_key: null }
    }

    /*
     * 先算出这条通知挂在哪个 card_key 上（纯函数，不改状态），再按它串行 ——
     * 顺序不能反：`planDelivery` 要读台账来决定 create 还是 update。
     */
    const cardKey = BroadcastChannel.keyFor(decision, { kind: target.kind, id: target.id, chat_id: chatId })
    return withKey(cardKey ?? 'anon:' + String(now().getTime()) + ':' + String(Math.random()), () =>
      runDelivery({ decision, card, chatId, target, botId: input.botId }),
    )
  }

  /** 真正的一次投递（已经在 per-key 队列里）。 */
  async function runDelivery({ decision, card, chatId, target, botId }) {
    const mentionCount = Array.isArray(decision.mention) ? decision.mention.length : 0
    const plan = planDelivery(decision, throttle, channel, now().getTime(), {
      kind: target.kind,
      id: target.id,
      chat_id: chatId,
    })
    if (plan.action === 'skip') {
      count('skipped', { chatId, botId })
      return { action: 'skip', reason: plan.reason, card_key: plan.card_key }
    }
    if (plan.action === 'throttled') {
      // 窗口内并着，窗口结束由 flushThrottled() 补一次更新 —— 否则最后一次跃迁会丢，
      // 而人只关心最后那个状态。
      count('throttled', { chatId, botId })
      if (plan.card_key !== null) {
        throttled.set(plan.card_key, {
          at: now().getTime(),
          kind: target.kind,
          id: target.id,
          chatId,
          botId,
        })
      }
      return { action: 'throttled', reason: plan.reason, card_key: plan.card_key }
    }

    const client = deps.clientFor({ chatId, botId })
    if (client === null || client === undefined || client.ready !== true) {
      count('skipped', { chatId, botId })
      return { action: 'skip', reason: 'no-client', card_key: plan.card_key }
    }
    if (card === null || card === undefined) {
      count('skipped', { chatId, botId })
      return { action: 'skip', reason: 'no-card', card_key: plan.card_key }
    }

    try {
      // update：同一张卡原地改（前三级走 PATCH），这是"同一个话题只有一张卡"的落点。
      const result = await deliverCard(client, { chat_id: chatId }, card, {
        patchMessageId: plan.action === 'update' ? plan.message_id : null,
        opts: { buttons: config.feishu?.buttons === true },
      })
      if (result.ok !== true) {
        count('failed', { chatId, botId })
        log.error?.('[team] 播报失败（' + plan.action + '）：' + JSON.stringify(result.attempts ?? []))
        return { action: 'failed', reason: plan.reason, card_key: plan.card_key, attempts: result.attempts }
      }
      if (typeof result.message_id === 'string' && result.message_id !== '') {
        channel.bind(plan.card_key, result.message_id)
        /*
         * 落盘：重启之后还是同一张卡（否则每次重启都会在群里多出一张新卡）。
         * `created_at` 是"这条消息第一次进群"的时刻，往后原地更新都带着它 ——
         * 「每群机器人发言占比」的分子就是**一个群里有多少条这样的消息**，
         * 所以这个字段是那个比率的证据，不能每次更新都刷成当前时间。
         */
        const id = cardRecordId(plan.card_key)
        const previous = store.get('card', id)
        const at = now().toISOString()
        store.put('card', {
          id,
          card_key: plan.card_key,
          message_id: result.message_id,
          chat_id: chatId,
          bot_id: botId ?? null,
          kind: target.kind,
          object_id: target.id,
          via: result.via ?? null,
          mention_count: (previous?.mention_count ?? 0) + mentionCount,
          deliveries: (previous?.deliveries ?? 0) + 1,
          created_at: previous?.created_at ?? at,
          updated_at: at,
        })
      }
      count(plan.action === 'update' ? 'updated' : 'delivered', {
        chatId,
        botId,
        via: result.via,
        mentions: mentionCount,
      })
      return { action: plan.action, reason: plan.reason, via: result.via, message_id: result.message_id ?? null, card_key: plan.card_key }
    } catch (error) {
      count('failed', { chatId, botId })
      log.error?.('[team] 播报异常：' + String(error && error.message ? error.message : error))
      return { action: 'failed', reason: plan.reason, card_key: plan.card_key }
    }
  }

  /** 卡片构造的上下文（与 ingest 建需求卡时用的是同一套字段）。 */
  function cardCtx() {
    return {
      nonce: () => (typeof randomUUID === 'function' ? randomUUID() : String(Date.now()) + Math.random()),
      now,
      leaseOf: (taskId) => store.get('lease', String(taskId)),
      buttons: config.feishu?.buttons === true,
    }
  }

  return {
    /**
     * 一个任务对象有变化 → 决定要不要播报 → 送到它所属的那个群。
     *
     * @param {object} task
     * @param {{reason?: string, humanInitiated?: boolean, duplicate?: boolean,
     *          progress?: boolean, chatId?: string|null, botId?: string,
     *          pendingGates?: Array<{name: string, pending: string[]}>, line?: string}} [opts]
     */
    task(task, opts = {}) {
      const chatId =
        typeof opts.chatId === 'string' && opts.chatId !== ''
          ? opts.chatId
          : chatIdOfTask(store, task)
      let decision = decideBroadcast({
        kind: 'task',
        chat_id: chatId,
        ...(opts.humanInitiated === true ? { human_initiated: true } : {}),
        ...(opts.duplicate === true ? { duplicate: true } : {}),
        ...(opts.progress === true ? { progress: true } : {}),
        ...(Array.isArray(opts.pendingGates) ? { pending_gates: opts.pendingGates } : {}),
      })
      // @人配额：超了改成静默待办，而不是继续骚扰（设计文档 §2.3）。
      if (decision.mention.length > 0) {
        const day = dayKeyOf(now())
        const botId = botIdOf(opts)
        const allowed = decision.mention.filter((who) => quota.tryConsume(botId, who, day))
        if (allowed.length !== decision.mention.length) {
          quotaRefused += 1
          decision = MentionQuota.asSilent({ ...decision, mention: allowed })
        }
      }
      /*
       * 卡片构造失败不能变成"播报失败"，更不能反过来影响台账：卡片是锦上添花，
       * 对象写入不是。`buildTaskCard` 假定拿到的是一个完整的任务对象，
       * 而调用方（工具层/定时扫描）拿到的可能是刚写完的中间形态 —— 所以这里兜住。
       */
      let card = null
      try {
        card = buildTaskCard(task, cardCtx())
      } catch (error) {
        log.error?.('[team] 任务卡构造失败（不播报这一条）：' + String(error && error.message ? error.message : error))
        return { action: 'skip', reason: 'card-build-failed', card_key: cardKeyOf('task', task.id) }
      }
      return deliver({
        decision,
        card,
        target: { kind: 'task', id: task.id, chatId },
        botId: opts.botId,
        line: opts.line,
      })
    },

    /**
     * 一次性通知（催办、升级、异常）：不做原地更新，每次都是一条新消息。
     *
     * 超时催办与升级走这里：它们**不属于某张任务卡的演进**，而是"现在有人必须看一眼"。
     * `cardKey` 非空时仍然会带上幂等键（同一个 key 的重复通知会被 `suppress` 掉）。
     */
    notice(opts) {
      const chatId = typeof opts.chatId === 'string' && opts.chatId !== '' ? opts.chatId : null
      let decision = decideBroadcast({
        kind: 'callout',
        chat_id: chatId,
        ...(opts.duplicate === true ? { duplicate: true } : {}),
        ...(opts.humanInitiated === true ? { human_initiated: true } : {}),
        ...(Array.isArray(opts.pendingGates) ? { pending_gates: opts.pendingGates } : {}),
      })
      if (opts.cardKey !== undefined && opts.cardKey !== null) decision = { ...decision, card_key: opts.cardKey }
      if (opts.mention !== undefined && Array.isArray(opts.mention) && decision.mention.length === 0) {
        decision = { ...decision, mention: opts.mention }
      }
      let card = null
      try {
        card = buildNoticeCard({
        title: opts.title,
        ...(opts.status === undefined ? {} : { status: opts.status }),
        ...(Array.isArray(opts.lines) ? { lines: opts.lines } : {}),
        ...(opts.note === undefined ? {} : { note: opts.note }),
          ...(opts.headerTemplate === undefined ? {} : { headerTemplate: opts.headerTemplate }),
        })
      } catch (error) {
        log.error?.('[team] 通知卡构造失败：' + String(error && error.message ? error.message : error))
        return { action: 'skip', reason: 'card-build-failed', card_key: null }
      }
      return deliver({ decision, card, target: { kind: 'callout', id: opts.id ?? 'notice', chatId }, botId: opts.botId })
    },

    /** 报告卡（日报）：一次性，`lines` 已经聚合好。 */
    report(opts) {
      const chatId = typeof opts.chatId === 'string' && opts.chatId !== '' ? opts.chatId : null
      const decision = decideBroadcast({ kind: 'callout', chat_id: chatId, human_initiated: true })
      const card = buildReportCard({ title: opts.title, lines: opts.lines ?? [] })
      return deliver({ decision, card, target: { kind: 'callout', id: opts.id ?? 'report', chatId }, botId: opts.botId })
    },

    /** 摘要桶里的东西（日报还没做，先把"攒了什么"暴露出来，免得静默丢失）。 */
    digestBuckets() {
      return digest.buckets
    },
    digestLines(bucket) {
      return digest.peek(bucket)
    },
    /** 取走一个桶（一次 flush 一条消息）。 */
    takeDigest(bucket, opts) {
      return digest.merge(bucket, opts)
    },
    /** 还等着补发的卡（窗口已经过去的）。 */
    dueThrottled() {
      const at = now().getTime()
      return [...throttled.entries()].filter(([, value]) => at - value.at >= throttle.windowMs).map(([key]) => key)
    },
    /**
     * 补发被节流并掉的卡：窗口过去后，用**当前**对象状态重画一次并原地更新。
     *
     * @returns {Promise<Array<object>>} 每个补发的结果
     */
    async flushThrottled() {
      const due = this.dueThrottled()
      const out = []
      for (const key of due) {
        const item = throttled.get(key)
        // 先删再发：补发失败不能变成"每轮都重试"，那会把失败变成一个死循环。
        throttled.delete(key)
        if (item === undefined) continue
        if (item.kind === 'task') {
          const task = store.get('task', item.id)
          if (task === null) {
            out.push({ card_key: key, action: 'skip', reason: 'object-gone' })
            continue
          }
          // 直接走 deliver（不再过 throttle.admit 的时间判断：窗口已经过去了）。
          out.push({ card_key: key, ...(await this.task(task, { reason: 'state_transition', chatId: item.chatId, botId: item.botId })) })
          continue
        }
        out.push({ card_key: key, action: 'skip', reason: 'unsupported-kind' })
      }
      return out
    },
    cardKeyOf,
    messageIdOf: (cardKey) => channel.messageIdOf(cardKey),
    boundCards: () => bound,
    /**
     * 原始计数 + 分组计数（`lib/metrics.js` 把它们与落盘事实合起来算比率）。
     *
     * `byVia` 里 `card` / `card-plain-table` / `card-no-buttons` 是前三级，
     * `text` / `text-with-file` 是降级后的后两级 —— "降级率"就是后两级占成功投递的比例。
     */
    stats: () => ({
      ...stats,
      mentions,
      quotaRefused,
      byVia: { ...byVia },
      byChat: { ...byChat },
      byBot: { ...byBot },
    }),
  }
}

/**
 * 一个任务该在哪个群播报：它所属需求的来源群。
 *
 * 需求是用 `team` 工具在 DSH 里建的（`origin.surface: internal`）就没有群 ——
 * 那是对的，不是错误：这件事不需要在群里说。
 */
export function chatIdOfTask(store, task) {
  if (task === null || typeof task !== 'object') return null
  const reqId = typeof task.req === 'string' ? task.req : ''
  if (reqId === '') return null
  const requirement = store.get('requirement', reqId)
  const chatId = requirement === null ? null : requirement.origin?.chat_id
  return typeof chatId === 'string' && chatId !== '' ? chatId : null
}
