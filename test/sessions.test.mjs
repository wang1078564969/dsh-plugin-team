/*
 * Bot conversations: the bot × chat session key, the records behind it, and the
 * reply lease that keeps two bots from answering the same sentence.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  botSessionId,
  botSessionKey,
  botSessionsOf,
  createReplyLease,
  ensureBotSession,
  isBotSessionId,
  migrateLegacySessions,
  sessionRows,
} from '../lib/sessions.js'
import { Store } from '../lib/store.js'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-sessions-'))
  const store = new Store(dir).load()
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the session belongs to a PAIR: the same bot in two groups keeps two contexts', () => {
  assert.equal(botSessionKey('dev', 'oc_a'), 'dev.oc_a')
  assert.equal(botSessionId('dev', 'oc_a'), 'team-bot-dev-oc_a')
  // Same bot, other group → other session. Two bots, one group → other session.
  assert.notEqual(botSessionId('dev', 'oc_a'), botSessionId('dev', 'oc_b'))
  assert.notEqual(botSessionId('dev', 'oc_a'), botSessionId('req', 'oc_a'))
  assert.equal(isBotSessionId('team-bot-dev-oc_a'), true)
  assert.equal(isBotSessionId('team-feishu-oc_a'), false, 'the single-assistant scheme is not a bot session')
})

test('a conversation record is created once and then reused, so the bot keeps its memory', () => {
  const world = makeStore()
  try {
    const first = ensureBotSession(world.store, { botId: 'dev', chatId: 'oc_a', chatType: 'group', workspace: '/w' })
    assert.equal(first.id, 'dev.oc_a')
    assert.equal(first.session_id, 'team-bot-dev-oc_a')
    assert.equal(first.turns, 0)
    world.store.put('botsession', { ...first, turns: 3 })
    const again = ensureBotSession(world.store, { botId: 'dev', chatId: 'oc_a' })
    assert.equal(again.turns, 3, 'the second call must not reset the counters')
    assert.equal(again.session_id, 'team-bot-dev-oc_a')
  } finally {
    world.cleanup()
  }
})

test('sessionRows joins the chat\'s human name, which belongs to the chat and not to the bot', () => {
  const world = makeStore()
  try {
    ensureBotSession(world.store, { botId: 'req', chatId: 'oc_a', chatType: 'group', workspace: '/w' })
    ensureBotSession(world.store, { botId: 'dev', chatId: 'oc_a', chatType: 'group', workspace: '/w' })
    world.store.put('chat', { id: 'oc_a', title: '需求群', chat_type: 'group' })
    const rows = sessionRows(world.store)
    assert.equal(rows.length, 2, 'one row per bot, even in the same chat')
    assert.deepEqual(rows.map((one) => one.botId), ['dev', 'req'])
    assert.equal(rows[0].title, '需求群')
    assert.equal(rows[0].sessionId, 'team-bot-dev-oc_a')
    assert.equal(botSessionsOf(world.store, 'req').length, 1)
  } finally {
    world.cleanup()
  }
})

test('the reply lease: the first bot holds the chat, the others stay quiet', () => {
  let clock = 1000
  const lease = createReplyLease({ ttlMs: 1000, now: () => clock })

  assert.deepEqual(lease.claim('oc_a', 'req'), { ok: true, renewed: false })
  const refused = lease.claim('oc_a', 'dev')
  assert.equal(refused.ok, false)
  assert.equal(refused.holder, 'req')
  assert.equal(lease.holderOf('oc_a'), 'req')

  // The holder renewing is not a conflict.
  assert.deepEqual(lease.claim('oc_a', 'req'), { ok: true, renewed: true })

  // A DIFFERENT chat is untouched: the lease is per chat, not global.
  assert.equal(lease.claim('oc_b', 'dev').ok, true)

  // After the TTL the claim is stale and the next bot may take it.
  clock += 1500
  assert.equal(lease.holderOf('oc_a'), null)
  assert.deepEqual(lease.claim('oc_a', 'dev'), { ok: true, renewed: false })
})

test('releasing a lease lets the next bot answer — a failed turn spoke nothing', () => {
  const lease = createReplyLease({ ttlMs: 1000, now: () => 0 })
  lease.claim('oc_a', 'req')
  lease.release('oc_a', 'dev')
  assert.equal(lease.holderOf('oc_a'), 'req', 'only the holder may release')
  lease.release('oc_a', 'req')
  assert.equal(lease.holderOf('oc_a'), null)
  assert.equal(lease.claim('oc_a', 'dev').ok, true)
})

test('the lease snapshot is what 接入自检 shows', () => {
  const lease = createReplyLease({ ttlMs: 5000, now: () => 100 })
  lease.claim('oc_a', 'req')
  assert.deepEqual(lease.snapshot(), [{ chatId: 'oc_a', botId: 'req', ageMs: 0 }])
  lease.clear()
  assert.deepEqual(lease.snapshot(), [])
})

test('每个机器人每个群一条自己的会话：单助手时代那条不再被继承', () => {
  /*
   * 用户 2026-09-12 的要求：**一个群里每台机器人都是单独的会话，不是一个群共用一个**。
   *
   * 以前这里有一条"第一个服务这个群的机器人继承 `team-feishu-<群>`"的规则，出发点是
   * "别让名册把群聊过什么弄丢"。但它的画面恰好是用户反对的那一个：会话 id 还是群的名字，
   * 看起来这个群只有一条会话。现在一律 `team-bot-<机器人>-<群>`，历史那条由
   * `migrateLegacySessions()` 一次性改名。
   */
  const world = makeStore()
  try {
    // 这个群以前被单助手时代的会话回答过（`team-feishu-…`）。
    world.store.put('chat', { id: 'oc_a', chat_type: 'group', app_id: 'cli_x', session_id: 'team-feishu-oc_a', bot_id: null })

    const first = ensureBotSession(world.store, { botId: 'req', chatId: 'oc_a', chatType: 'group' })
    assert.equal(first.session_id, 'team-bot-req-oc_a', '不继承：会话 id 说清是谁的')

    const second = ensureBotSession(world.store, { botId: 'dev', chatId: 'oc_a', chatType: 'group' })
    assert.equal(second.session_id, 'team-bot-dev-oc_a', '同一个群里第二台机器人是另一条会话')

    // 同一个机器人在两个群也是两条。
    assert.equal(ensureBotSession(world.store, { botId: 'req', chatId: 'oc_b' }).session_id, 'team-bot-req-oc_b')
  } finally {
    world.cleanup()
  }
})

test('历史会话改名：只动单助手时代的 id，记下从哪来，且幂等', () => {
  const world = makeStore()
  try {
    world.store.put('botsession', { id: 'req.oc_a', bot_id: 'req', chat_id: 'oc_a', session_id: 'team-feishu-oc_a', turns: 4, seen: 3 })
    world.store.put('botsession', { id: 'dev.oc_b', bot_id: 'dev', chat_id: 'oc_b', session_id: 'team-bot-dev-oc_b' })

    const migrated = migrateLegacySessions(world.store)
    assert.equal(migrated.length, 1, '只有那一条老的会被动')
    assert.equal(migrated[0].from, 'team-feishu-oc_a')
    assert.equal(migrated[0].to, 'team-bot-req-oc_a')

    const after = world.store.get('botsession', 'req.oc_a')
    assert.equal(after.session_id, 'team-bot-req-oc_a')
    assert.equal(after.migrated_from, 'team-feishu-oc_a', '从哪来要留着：换 id 等于换了 DSH 会话')
    assert.equal(after.turns, 4, '计数器一个都不动')
    assert.equal(world.store.get('botsession', 'dev.oc_b').session_id, 'team-bot-dev-oc_b', '已经是新 id 的不碰')

    assert.deepEqual(migrateLegacySessions(world.store), [], '再跑一次什么都不做')
  } finally {
    world.cleanup()
  }
})
