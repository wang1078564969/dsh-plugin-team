/*
 * 运维观测：设计文档 04 §11 里那三个"团队版必须能回答的问题"的算法部分。
 *
 *   · 投递降级率 —— 走了 `text` / `text-with-file` 的比例。高就说明**卡片渲染有问题**，
 *     而不是"消息发不出去"：降级是设计好的兜底，但长期降级意味着群里看到的
 *     一直是纯文本，按钮与表格全丢了。
 *   · 每群机器人发言占比 —— > 25% 是"人会不会退群"的前置指标（设计 04 §2.3）。
 *     分子分母都必须是**落盘事实**：一个群里有多少条机器人发出的消息、
 *     有多少条人发进来的消息。所以分子来自卡台账（`store` 的 `card` 种类，
 *     一张卡 = 群里的一条消息，原地更新不算新消息），分母再加上收件箱里的入站消息。
 *     这样重启之后比率不会归零 —— 一个"重启就变好看"的告警指标没有意义。
 *   · 被静默的播报数 + @人次数 —— 静默（suppress / throttled / digested）与
 *     @配额拒绝都是**本进程**的计数（`notify.stats()`），因为它们是"决定了不说"
 *     的行为，不是落盘对象；这里只把它们按群摆出来。
 *
 * 这个模块只算数与写日志，**不改任何状态、不发消息**：观测不能有副作用。
 */
import { CARD_VIAS, FALLBACK_VIAS } from './feishu/cards.js'

/** 设计 04 §2.3 的 25%：超过就告警（"人会不会退群"的前置指标）。 */
export const DEFAULT_SHARE_ALERT = 0.25

/**
 * 告警的最小样本量。
 *
 * 一个只有 3 条消息的新群，机器人才说了一句就已经 33% —— 那不是刷屏，是群刚建。
 * 样本不足时仍然把比率画出来（人自己要能看），但不告警：假警报会让真警报被忽略。
 */
export const DEFAULT_MIN_SAMPLE = 8

/** 同一个群的告警冷却：指标是持续的，但日志不该每轮都说一遍同一件事。 */
export const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000

/** 每个群一行：分母是"人说的 + 机器人说的"，这就是"群消息总数"。 */
function shareOf(sent, received) {
  const total = sent + received
  return { total, share: total === 0 ? 0 : sent / total }
}

export function createMetrics(deps) {
  const { store } = deps
  const inbox = deps.inbox ?? null
  const logbus = deps.logbus ?? null
  const notify = deps.notify ?? null
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  const threshold = Number.isFinite(deps.shareAlert) ? deps.shareAlert : DEFAULT_SHARE_ALERT
  const minSample = Number.isFinite(deps.minSample) ? deps.minSample : DEFAULT_MIN_SAMPLE
  const cooldownMs = Number.isFinite(deps.alertCooldownMs) ? deps.alertCooldownMs : DEFAULT_ALERT_COOLDOWN_MS
  /** chatId → 上次告警时刻（毫秒）。只影响日志频率，不影响 `snapshot()` 的结论。 */
  const alertedAt = new Map()

  function notifyStats() {
    return typeof notify?.stats === 'function' ? notify.stats() : {}
  }

  /**
   * 降级率：成功投递里走了后两级（纯文本 / 文本 + 附件）的比例。
   *
   * 分母只数**成功**的投递（`byVia` 里的 `delivered` + `updated`）—— 失败的投递
   * 没有 `via`，把它们算进来会让降级率看起来"变好"，那正好掩盖了问题。
   */
  /**
   * 降级率。
   *
   * **口径有两个，必须分开看**（这是本文件里最容易骗人的一处）：
   *
   *   · `durable`：从**落盘的卡台账**数 —— 每一行台账是一次"第一进群"，
   *     `via` 是它**最后一次**投递用的层级。它跨重启成立，回答"群里的消息
   *     现在长什么样"（一张卡最后落到纯文本，就是那张卡降级了）；
   *   · `session`：`notify.stats()` 的逐次投递分桶 —— 精确到每一次投递，
   *     但**进程内存**，重启清零。
   *
   * `fallbackRate` 用 `durable` 算：一个"重启就变好看"的告警指标没有意义
   * （这条不变量写在设计文档里，而第一版实现只做到了占比那一半）。
   */
  function delivery() {
    const stats = notifyStats()
    const byVia = stats.byVia ?? {}
    let card = 0
    let fallback = 0
    let total = 0
    const tiers = []
    for (const key of Object.keys(byVia)) {
      const row = byVia[key] ?? {}
      const sent = (row.delivered ?? 0) + (row.updated ?? 0)
      total += sent
      if (FALLBACK_VIAS.includes(key)) fallback += sent
      else if (CARD_VIAS.includes(key)) card += sent
      tiers.push({ via: key, sent, delivered: row.delivered ?? 0, updated: row.updated ?? 0 })
    }
    /* 没见过的 `via`（引擎加了新层级）也要能被看见，所以 tiers 是从数据来的，
       而 card/fallback 只按已知的两组归类 —— 未知层级两个桶都不进，但仍在 tiers 里。 */
    tiers.sort((a, b) => b.sent - a.sent)

    // 落盘口径：每条卡台账记录 = 群里的**一条消息**，`via` 是它最后一次投递的层级。
    const ledger = { tiers: [], card: 0, fallback: 0, total: 0, fallbackRate: 0 }
    const counts = new Map()
    for (const record of store.all('card')) {
      const via = typeof record.via === 'string' && record.via !== '' ? record.via : '（没记录层级）'
      counts.set(via, (counts.get(via) ?? 0) + 1)
    }
    for (const [via, sent] of counts) {
      ledger.total += sent
      if (FALLBACK_VIAS.includes(via)) ledger.fallback += sent
      else if (CARD_VIAS.includes(via)) ledger.card += sent
      ledger.tiers.push({ via, sent })
    }
    ledger.tiers.sort((a, b) => b.sent - a.sent)
    ledger.fallbackRate = ledger.total === 0 ? 0 : ledger.fallback / ledger.total

    return {
      tiers,
      byVia,
      card,
      fallback,
      total,
      /** 逐次投递（本进程）的降级率 —— 精确，但重启清零。 */
      sessionFallbackRate: total === 0 ? 0 : fallback / total,
      /** 落盘口径：每条消息最终落在哪一级。面板与告警都用它。 */
      durable: ledger,
      fallbackRate: ledger.fallbackRate,
      mentions: stats.mentions ?? 0,
      quotaRefused: stats.quotaRefused ?? 0,
      suppressed: stats.suppressed ?? 0,
      throttled: stats.throttled ?? 0,
      digested: stats.digested ?? 0,
      skipped: stats.skipped ?? 0,
      failed: stats.failed ?? 0,
      delivered: stats.delivered ?? 0,
      updated: stats.updated ?? 0,
      byBot: stats.byBot ?? {},
    }
  }

  /**
   * 每个群一行：机器人发言占比、@人次数、被静默数。
   *
   * `sent` 从卡台账数（**一条消息一行台账**，原地更新不会多算一条）；
   * `received` 从收件箱数。两者都是落盘事实，所以这个表重启后不变。
   */
  function chats() {
    const stats = notifyStats()
    const byChat = stats.byChat ?? {}
    const rows = new Map()
    const rowOf = (chatId) => {
      const key = typeof chatId === 'string' && chatId !== '' ? chatId : ''
      const existing = rows.get(key)
      if (existing !== undefined) return existing
      const created = {
        chatId: key,
        sent: 0,
        received: 0,
        mentions: 0,
        silenced: 0,
        suppressed: 0,
        throttled: 0,
        digested: 0,
        failed: 0,
        byBot: {},
        first: null,
        last: null,
      }
      rows.set(key, created)
      return created
    }

    for (const record of store.all('card')) {
      const row = rowOf(record.chat_id)
      row.sent += 1
      row.mentions += Number.isFinite(record.mention_count) ? record.mention_count : 0
      const botId = typeof record.bot_id === 'string' && record.bot_id !== '' ? record.bot_id : 'team'
      row.byBot[botId] = (row.byBot[botId] ?? 0) + 1
      /* `first` 是"这个群第一次有机器人说话"，`last` 是"最近一次说话"——
         一张卡从建到被更新都算这个群的活动，所以 last 取 updated_at。 */
      const first = record.created_at ?? record.updated_at ?? null
      const last = record.updated_at ?? record.created_at ?? null
      if (typeof first === 'string' && (row.first === null || first < row.first)) row.first = first
      if (typeof last === 'string' && (row.last === null || last > row.last)) row.last = last
    }

    const inbound = typeof inbox?.all === 'function' ? inbox.all() : []
    for (const doc of inbound) {
      const row = rowOf(doc.chat_id)
      row.received += 1
      const at = doc.create_time ?? doc.received_at ?? null
      if (typeof at === 'string') {
        if (row.first === null || at < row.first) row.first = at
        if (row.last === null || at > row.last) row.last = at
      }
    }

    for (const chatId of Object.keys(byChat)) {
      const row = rowOf(chatId)
      const live = byChat[chatId] ?? {}
      row.suppressed = live.suppressed ?? 0
      row.throttled = live.throttled ?? 0
      row.digested = live.digested ?? 0
      row.failed = live.failed ?? 0
      row.silenced = row.suppressed + row.throttled + row.digested
    }

    const list = [...rows.values()].map((row) => {
      const { total, share } = shareOf(row.sent, row.received)
      return {
        ...row,
        total,
        share,
        /* 样本不足时照样画比率，但 `alert` 为 false（见 DEFAULT_MIN_SAMPLE）。 */
        enough: total >= minSample,
        alert: share > threshold && total >= minSample,
      }
    })
    list.sort((a, b) => b.share - a.share || b.total - a.total)
    return list
  }

  function snapshot() {
    return {
      generatedAt: now().toISOString(),
      threshold,
      minSample,
      delivery: delivery(),
      chats: chats(),
    }
  }

  /**
   * 每轮扫一次占比：超线的群留一行 `warn` 日志（按群冷却）。
   *
   * 观测与告警分开：`snapshot()` 是纯读（面板每 3 秒读一次，不能因此写日志），
   * 这一条由宿主的定时轮询调用。
   *
   * @returns {Array<{chatId: string, share: number, total: number}>} 这一轮真的告警了的群
   */
  function tick() {
    const at = now().getTime()
    const fired = []
    for (const row of chats()) {
      if (!row.alert) continue
      const previous = alertedAt.get(row.chatId)
      if (previous !== undefined && at - previous < cooldownMs) continue
      alertedAt.set(row.chatId, at)
      fired.push({ chatId: row.chatId, share: row.share, total: row.total })
      logbus?.warn?.(
        'metrics',
        '机器人在群 ' + (row.chatId === '' ? '（无群）' : row.chatId) + ' 的发言占比 ' +
          (row.share * 100).toFixed(1) + '% 超过 ' + (threshold * 100).toFixed(0) + '%（' +
          String(row.sent) + '/' + String(row.total) + ' 条）—— 设计 04 §2.3 的"人会退群"前置指标，' +
          '该收紧播报规则（digest / suppress）了',
        { chatId: row.chatId, sent: row.sent, total: row.total, share: row.share },
      )
    }
    return fired
  }

  return {
    delivery,
    chats,
    snapshot,
    tick,
    threshold,
    minSample,
    /** 测试与人工排查用：把冷却清掉，下一轮必然重算告警。 */
    resetAlerts: () => alertedAt.clear(),
  }
}
