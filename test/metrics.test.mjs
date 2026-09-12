/*
 * 观测聚合：设计文档 04 §11 的第 4、5 条，以及 §2.3 的 25% 告警。
 *
 * 这两条以前是空的（audit-03-04 第 78/79 条：「不落库、不聚合」「无统计」）。
 * 用例钉住的是**口径**，因为观测页最容易出的错不是崩溃，而是算出一个好看但错的数：
 *
 *   1. 降级率的分母只数**成功**投递 —— 失败没有 `via`，混进来会让降级率假性变好；
 *   2. 发言占比的分子是**卡台账行数**（一张卡 = 群里的一条消息），原地更新不算新消息 ——
 *      用投递次数当分子的话，一张被更新十次的卡会变成"刷了十条"；
 *   3. 重启不改结论 —— 分子分母都来自落盘事实；
 *   4. 样本不足不告警，且同一个群有冷却 —— 假警报会让真警报被忽略。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { FALLBACK_VIAS, CARD_VIAS } from '../lib/feishu/cards.js'
import { Inbox } from '../lib/feishu/ingest.js'
import { createLogBus } from '../lib/logbus.js'
import { createMetrics, DEFAULT_MIN_SAMPLE, DEFAULT_SHARE_ALERT } from '../lib/metrics.js'
import { Store } from '../lib/store.js'

/** 一次投递的原始计数（`notify.stats()` 的形状），测试里直接摆出来。 */
function notifyStats(overrides = {}) {
  return {
    delivered: 0, updated: 0, throttled: 0, suppressed: 0, digested: 0, skipped: 0, failed: 0,
    mentions: 0, quotaRefused: 0,
    byVia: {}, byChat: {}, byBot: {},
    ...overrides,
  }
}

function makeWorld(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-metrics-'))
  const store = new Store(dir).load()
  const inbox = new Inbox(dir).load()
  const logbus = createLogBus({ dataDir: dir, echo: false })
  let clock = new Date('2026-09-12T10:00:00Z')
  const stats = overrides.stats ?? notifyStats()
  const metrics = createMetrics({
    store,
    inbox,
    logbus,
    notify: { stats: () => stats },
    now: () => clock,
    ...(overrides.options ?? {}),
  })
  return {
    dir, store, inbox, logbus, metrics, stats,
    /** 一张卡 = 群里的一条消息；`mention_count` 是这条消息里 @ 了几个人。 */
    card: (chatId, extra = {}) => store.put('card', {
      id: 'card-' + String(Math.random()).slice(2, 8),
      card_key: 'task:' + String(Math.random()).slice(2, 8),
      message_id: 'om_' + String(Math.random()).slice(2, 8),
      chat_id: chatId,
      kind: 'task',
      object_id: 'task-1',
      created_at: clock.toISOString(),
      updated_at: clock.toISOString(),
      ...extra,
    }),
    /** 一条入站消息（人说的）。 */
    inbound: (chatId, extra = {}) => inbox.record({
      message_id: 'om_in_' + String(Math.random()).slice(2, 8),
      chat_id: chatId,
      create_time: String(clock.getTime()),
      ...extra,
    }),
    advance: (ms) => { clock = new Date(clock.getTime() + ms) },
    alerts: () => logbus.query({ level: 'warn', source: 'metrics', includeFile: false }).rows,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('降级率只数成功投递，且失败不算进分母', () => {
  const world = makeWorld({
    stats: notifyStats({
      delivered: 10,
      failed: 90,
      byVia: {
        card: { delivered: 7, updated: 0 },
        'card-no-buttons': { delivered: 1, updated: 0 },
        // 后两级 = 降级：3 条里 2 条纯文本、1 条文本 + 附件
        text: { delivered: 2, updated: 0 },
        'text-with-file': { delivered: 1, updated: 0 },
      },
    }),
  })
  try {
    const delivery = world.metrics.delivery()
    assert.equal(delivery.total, 11, '分母 = 成功投递（delivered + updated），不含 90 次失败')
    assert.equal(delivery.card, 8)
    assert.equal(delivery.fallback, 3)
    assert.equal(delivery.fallbackRate, 3 / 11)
    assert.deepEqual(
      delivery.tiers.map((tier) => tier.via).sort(),
      ['card', 'card-no-buttons', 'text', 'text-with-file'].sort(),
    )
    // 未知层级（以后引擎加了第六级）也要能看见，但不能算进两个桶里的任何一个。
    const unknown = makeWorld({
      stats: notifyStats({ byVia: { card: { delivered: 1, updated: 0 }, 'card-huge': { delivered: 4, updated: 0 } } }),
    })
    try {
      const out = unknown.metrics.delivery()
      assert.equal(out.total, 5)
      assert.equal(out.card, 1, 'CARD_VIAS 之外的层级不冒充卡片')
      assert.equal(out.fallback, 0)
      assert.ok(out.tiers.some((tier) => tier.via === 'card-huge'), '未知层级仍然出现在 tiers 里')
    } finally {
      unknown.cleanup()
    }
  } finally {
    world.cleanup()
  }
})

test('没有成功投递时降级率是 0，不是 NaN', () => {
  const world = makeWorld()
  try {
    const delivery = world.metrics.delivery()
    assert.equal(delivery.total, 0)
    assert.equal(delivery.fallbackRate, 0)
    assert.deepEqual(delivery.tiers, [])
  } finally {
    world.cleanup()
  }
})

test('发言占比：分子是群里的消息条数（原地更新不重复计），分母加上人的发言', () => {
  const world = makeWorld({
    stats: notifyStats({
      delivered: 3, updated: 17,
      byChat: { oc_a: { delivered: 3, updated: 17, suppressed: 2, throttled: 1, digested: 4, failed: 0, mentions: 5 } },
    }),
  })
  try {
    // 三张卡：其中一张被更新了 17 次，但它仍然只是群里的一条消息。
    world.card('oc_a', { bot_id: 'req', mention_count: 2 })
    world.card('oc_a', { bot_id: 'dev', mention_count: 1, deliveries: 18 })
    world.card('oc_a', { bot_id: 'dev', mention_count: 0 })
    for (let i = 0; i < 5; i += 1) world.inbound('oc_a')

    const row = world.metrics.chats().find((item) => item.chatId === 'oc_a')
    assert.equal(row.sent, 3, '投递 20 次、群里只有 3 条消息')
    assert.equal(row.received, 5)
    assert.equal(row.total, 8)
    assert.equal(row.share, 3 / 8)
    assert.equal(row.mentions, 3)
    assert.deepEqual(row.byBot, { req: 1, dev: 2 })
    assert.equal(row.suppressed, 2)
    assert.equal(row.throttled, 1)
    assert.equal(row.digested, 4)
    assert.equal(row.silenced, 7, '被静默 = suppress + throttled + digest')
    // 3/8 = 37.5%，样本刚好够 8 条 → 超线就告警（这正是要盯的场景）。
    assert.equal(row.enough, true)
    assert.equal(row.alert, true)
  } finally {
    world.cleanup()
  }
})

test('占比超过 25% 且样本足够时告警；样本不足只显示比率', () => {
  const world = makeWorld()
  try {
    // 新群：机器人说了 1 句，人说了 2 句 —— 33%，但样本只有 3 条。
    world.card('oc_new')
    world.inbound('oc_new')
    world.inbound('oc_new')
    const fresh = world.metrics.chats().find((row) => row.chatId === 'oc_new')
    assert.equal(fresh.enough, false)
    assert.equal(fresh.alert, false, '新群的第一句话不是刷屏')
    assert.equal(world.metrics.tick().length, 0)

    // 老群：10 条机器人 + 10 条人 = 50%，样本 20 条。
    for (let i = 0; i < 10; i += 1) world.card('oc_busy')
    for (let i = 0; i < 10; i += 1) world.inbound('oc_busy')
    const busy = world.metrics.chats().find((row) => row.chatId === 'oc_busy')
    assert.equal(busy.total, 20)
    assert.equal(busy.share, 0.5)
    assert.equal(busy.alert, true)

    const fired = world.metrics.tick()
    assert.deepEqual(fired.map((item) => item.chatId), ['oc_busy'])
    const lines = world.alerts()
    assert.equal(lines.length, 1)
    assert.match(lines[0].message, /50\.0% 超过 25%/)
    assert.equal(lines[0].data.sent, 10)

    // 冷却：同一个群下一轮不再重复写日志（指标是持续的，日志不该每轮都说一遍）。
    assert.deepEqual(world.metrics.tick(), [])
    assert.equal(world.alerts().length, 1)
    world.advance(31 * 60 * 1000)
    assert.equal(world.metrics.tick().length, 1, '冷却过后还在超线 → 再说一次')
    // 人开始说话、占比掉回线内 → 不再告警，冷却也重置。
    for (let i = 0; i < 40; i += 1) world.inbound('oc_busy')
    world.advance(31 * 60 * 1000)
    assert.deepEqual(world.metrics.tick(), [])
    assert.equal(world.metrics.chats().find((row) => row.chatId === 'oc_busy').share, 10 / 60)
  } finally {
    world.cleanup()
  }
})

test('snapshot 是纯读：反复读不会写日志，也不改任何计数', () => {
  const world = makeWorld()
  try {
    for (let i = 0; i < 10; i += 1) world.card('oc_a')
    const first = world.metrics.snapshot()
    const second = world.metrics.snapshot()
    assert.deepEqual(second, first)
    assert.equal(world.alerts().length, 0, '面板每 3 秒读一次，读一次写一行日志就等于每 3 秒告警一次')
    assert.equal(first.threshold, DEFAULT_SHARE_ALERT)
    assert.equal(first.minSample, DEFAULT_MIN_SAMPLE)
    assert.equal(first.chats.length, 1)
  } finally {
    world.cleanup()
  }
})

test('卡台账更新不产生新消息：同一张卡反复落盘仍然只算一条', () => {
  const world = makeWorld()
  try {
    const chat = { chatId: 'oc_a' }
    world.store.put('card', {
      id: 'task.task-1', card_key: 'task:task-1', message_id: 'om_1', chat_id: 'oc_a',
      bot_id: 'req', created_at: '2026-09-12T10:00:00.000Z', updated_at: '2026-09-12T10:00:00.000Z',
      mention_count: 1, deliveries: 1,
    })
    // 原地更新：同一个 id 再写一次（这是 notify 的真实行为）。
    for (let i = 0; i < 5; i += 1) {
      const previous = world.store.get('card', 'task.task-1')
      world.store.put('card', {
        ...previous,
        mention_count: (previous?.mention_count ?? 0) + 1,
        deliveries: (previous?.deliveries ?? 0) + 1,
        updated_at: '2026-09-12T10:0' + String(i) + ':00.000Z',
      })
    }
    const row = world.metrics.chats()[0]
    assert.equal(row.sent, 1, '同一条消息更新 5 次不是 6 条消息')
    assert.equal(row.mentions, 6)
    assert.equal(row.first, '2026-09-12T10:00:00.000Z', '第一条消息的时间保留在 created_at 上')
    assert.equal(row.last, '2026-09-12T10:04:00.000Z')
    assert.equal(chat.chatId, 'oc_a')
  } finally {
    world.cleanup()
  }
})

test('重启之后结论不变：分子分母都来自落盘事实', () => {
  const world = makeWorld()
  try {
    for (let i = 0; i < 4; i += 1) world.card('oc_a')
    for (let i = 0; i < 6; i += 1) world.inbound('oc_a')
    const before = world.metrics.chats()[0]

    // 重启 = 新的 store / inbox / logbus，指向同一个 dataDir。本进程计数清零。
    const store = new Store(world.dir).load()
    const inbox = new Inbox(world.dir).load()
    const after = createMetrics({
      store,
      inbox,
      notify: { stats: () => notifyStats() },
      now: () => new Date('2026-09-12T11:00:00Z'),
    }).chats()[0]

    assert.equal(after.sent, before.sent)
    assert.equal(after.received, before.received)
    assert.equal(after.share, before.share)
    assert.equal(after.silenced, 0, '被静默是本进程计数 —— 重启清零，所以单独一列')
  } finally {
    world.cleanup()
  }
})

test('两级的名单是共享常量：观测层不自己再写一遍字符串', () => {
  assert.deepEqual(FALLBACK_VIAS, ['text', 'text-with-file'])
  assert.deepEqual(CARD_VIAS, ['card', 'card-plain-table', 'card-no-buttons'])
  // 五级 = 三级卡 + 两级降级，一级不多一级不少。
  assert.equal(CARD_VIAS.length + FALLBACK_VIAS.length, 5)
})
