/*
 * The chat responder in SINGLE-ASSISTANT mode: one session per chat, one turn per
 * message, one reply.
 *
 * This is the behaviour that used to belong to a separate bridge plugin. It is
 * tested here for the same reason it was written here: "the bot answers in the
 * chat" and "the ledger records the chat" must not be two plugins' promises to
 * each other. `bots: []` keeps this file about that behaviour alone — the roster
 * (several bots, one session per bot × chat) is test/bot-routing.test.mjs.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'
import { createResponder } from '../lib/feishu/responder.js'

/*
 * SINGLE-ASSISTANT MODE, on purpose: `bots: []` is the documented switch for "no
 * roster, one assistant, one session per chat", and it is the behaviour these
 * tests pin. The roster path has its own file (test/bot-routing.test.mjs), because
 * a fixture that mixes the two would test neither: with a roster the session id,
 * the speaking rules and the bookkeeping all change together.
 */
function makeWorld(feishuOverrides = {}, hooks = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-responder-'))
  const config = loadConfig({ workspace: join(dir, 'ws'), tickIntervalMs: 0, bots: [], feishu: { ...feishuOverrides } })
  const store = new Store(dir).load()
  const opened = []
  const driven = []
  const sent = []
  const pool = {
    async open(spec) {
      opened.push(spec)
      // A real agent carries its live session; the announcement needs it.
      return { id: spec.sessionId, status: 'idle', session: { id: spec.sessionId, seq: 0 } }
    },
    async drive(agent, text, options) {
      driven.push({ sessionId: agent.id, text, options })
      return { text: '收到：' + text, timedOut: false }
    },
  }
  const client = {
    ready: true,
    async send(chatId, payload) {
      sent.push({ chatId, text: payload.content?.text ?? '' })
      return { ok: true, code: 0 }
    },
  }
  const responder = createResponder({ config, store, pool, client, log: { error: () => {} }, ...hooks })
  return { dir, config, store, pool, client, responder, opened, driven, sent, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const message = (overrides = {}) => ({
  chatId: 'oc_req',
  chatType: 'group',
  messageId: 'om_1',
  messageType: 'text',
  text: '帮我看下重试这块',
  addressed: true,
  sender: 'ou_wang',
  at: new Date().toISOString(),
  ...overrides,
})

test('a group message that names the bot gets an answer, from the chat\'s own session', async () => {
  const world = makeWorld()
  try {
    const result = await world.responder.onMessage(message())
    assert.equal(result.ok, true, JSON.stringify(result))
    // `team-` prefixed on purpose: the `feishu-<id>` scheme belonged to another
    // plugin, and resuming ITS sessions is how a chat ends up in the wrong
    // workspace (see the namespacing note in the responder).
    assert.equal(result.sessionId, 'team-feishu-oc_req')
    assert.equal(world.driven.length, 1)
    assert.equal(world.driven[0].sessionId, 'team-feishu-oc_req')
    assert.equal(world.driven[0].text, '帮我看下重试这块')
    assert.equal(world.sent.length, 1)
    assert.equal(world.sent[0].chatId, 'oc_req')
    assert.equal(world.sent[0].text, '收到：帮我看下重试这块')

    // The chat's own book-keeping: same session next time, so the agent keeps
    // the memory of what this chat already discussed.
    await world.responder.onMessage(message({ messageId: 'om_2', text: '还有那个超时' }))
    assert.equal(world.driven.length, 2)
    assert.equal(world.driven[1].sessionId, 'team-feishu-oc_req')
    assert.equal(world.store.get('chat', 'oc_req').turns, 2)
  } finally {
    world.cleanup()
  }
})

test('an un-addressed group message is not answered — the group is not a speaker phone', async () => {
  const world = makeWorld()
  try {
    assert.equal(world.responder.shouldRespond(message({ addressed: false })), false)
    const result = await world.responder.onMessage(message({ addressed: false }))
    assert.equal(result.skipped, 'not-addressed')
    assert.equal(world.sent.length, 0)
    assert.equal(world.opened.length, 0, 'and it does not even start a turn')
  } finally {
    world.cleanup()
  }
})

test('a private chat always answers, and requireMention:false makes groups behave the same', async () => {
  const direct = makeWorld()
  try {
    await direct.responder.onMessage(message({ chatType: 'p2p', addressed: false }))
    assert.equal(direct.sent.length, 1)
    assert.equal(direct.store.get('chat', 'oc_req').chat_type, 'p2p')
  } finally {
    direct.cleanup()
  }

  const loose = makeWorld({ requireMention: false })
  try {
    await loose.responder.onMessage(message({ addressed: false }))
    assert.equal(loose.sent.length, 1)
  } finally {
    loose.cleanup()
  }
})

test('non-text messages, empty text and a silent model each get an honest outcome', async () => {
  const world = makeWorld()
  try {
    assert.equal(world.responder.shouldRespond(message({ messageType: 'image', text: '' })), false)
    await world.responder.onMessage(message({ messageType: 'image', text: '' }))
    assert.equal(world.sent.length, 0, 'there is nothing to read in a picture and nothing useful to say')

    // A turn that produced no text at all must not leave the chat hanging on a
    // reply that never comes.
    world.pool.drive = async () => ({ text: '', timedOut: true })
    const result = await world.responder.onMessage(message({ messageId: 'om_timeout' }))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'turn_timeout')
    assert.equal(world.sent.length, 1)
    assert.match(world.sent[0].text, /超时/)
  } finally {
    world.cleanup()
  }
})

test('a failed session shows up in the chat instead of vanishing', async () => {
  const world = makeWorld()
  try {
    world.pool.open = async () => {
      throw new Error('agents service unavailable')
    }
    const result = await world.responder.onMessage(message())
    assert.equal(result.ok, false)
    assert.equal(result.code, 'session_unavailable')
    assert.match(world.sent[0].text, /起不了会话/)
  } finally {
    world.cleanup()
  }
})

test('the chat session is announced to the host, with the chat name that labels it', async () => {
  /*
   * This is the wiring that makes a Feishu conversation appear in the host's own
   * session list: the responder says "here is a session, and here is the chat it
   * belongs to", and lib/workspace.js does the rest. If this hook is ever dropped
   * the bot still answers — it just becomes invisible, which is the failure the
   * user notices last.
   */
  const announced = []
  const world = makeWorld({}, {
    onSession: (info) => {
      announced.push(info)
    },
    fetchChatTitle: async () => '需求群',
  })
  try {
    await world.responder.onMessage(message())
    assert.equal(announced.length, 1)
    assert.equal(announced[0].sessionId, 'team-feishu-oc_req')
    assert.equal(announced[0].chatId, 'oc_req')
    assert.equal(announced[0].chatTitle, '需求群')
    assert.equal(announced[0].session.id, 'team-feishu-oc_req')
    // Remembered: the second message must not ask Feishu for the name again.
    assert.equal(world.store.get('chat', 'oc_req').title, '需求群')
    await world.responder.onMessage(message({ messageId: 'om_2' }))
    assert.equal(announced.length, 2)
    assert.equal(announced[1].chatTitle, '需求群', 'the remembered name is reused, not re-fetched')
  } finally {
    world.cleanup()
  }
})

test('a broken announcement never costs the answer', async () => {
  const world = makeWorld({}, {
    onSession: async () => {
      throw new Error('registry exploded')
    },
  })
  try {
    const result = await world.responder.onMessage(message())
    assert.equal(result.ok, true, 'the chat still gets its reply')
    assert.equal(world.sent.length, 1)
  } finally {
    world.cleanup()
  }
})
