/*
 * Bot conversations: the bot × chat session key, the records behind it, and the
 * reply lease that keeps two bots from answering the same sentence.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { botSessionId, botSessionKey, botSessionsOf, createReplyLease, ensureBotSession, isBotSessionId, sessionRows } from '../lib/sessions.js'
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

test('the first bot to serve a chat takes over its single-assistant conversation', () => {
  const world = makeStore()
  try {
    // The chat was answered by the pre-roster assistant, from `team-feishu-…`.
    world.store.put('chat', { id: 'oc_a', chat_type: 'group', app_id: 'cli_x', session_id: 'team-feishu-oc_a', bot_id: null })
    const adopted = ensureBotSession(world.store, { botId: 'req', chatId: 'oc_a', chatType: 'group' })
    assert.equal(adopted.session_id, 'team-feishu-oc_a', 'the bot continues what the group already discussed')
    assert.equal(adopted.adopted_from, 'team-feishu-oc_a')

    // A SECOND bot in the same chat gets its own conversation: two bots sharing one
    // session is the confusion the pair key exists to remove.
    const second = ensureBotSession(world.store, { botId: 'dev', chatId: 'oc_a', chatType: 'group' })
    assert.equal(second.session_id, 'team-bot-dev-oc_a')
    assert.equal(second.adopted_from, null)

    // And a chat that never had one starts fresh, under the bot's own namespace.
    const fresh = ensureBotSession(world.store, { botId: 'req', chatId: 'oc_b' })
    assert.equal(fresh.session_id, 'team-bot-req-oc_b')
    assert.equal(fresh.adopted_from, null)
  } finally {
    world.cleanup()
  }
})
