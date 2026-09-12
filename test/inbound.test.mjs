/*
 * The inbound promise, tested with the REAL protocol layer.
 *
 * `test/feishu.test.mjs` fakes triage and extraction on purpose: it tests the
 * wiring, not the judgement. This file does the opposite — a synthetic group
 * message is pushed through the same seam the bridge will feed, and the
 * judgement, the extraction, the ledger write and the card rendering are the
 * shipping implementations.
 *
 * It is the closest thing to "a message arrived in the group" that is available
 * while the bridge is deliberately unmounted, and it is honest about the one
 * thing it cannot cover: no Feishu connection is opened, so what is proven is
 * everything after the message is in hand.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'
import { createHandlers } from '../lib/tools.js'
import { Inbox, createIngest } from '../lib/feishu/ingest.js'
import { normalizeMessage } from '../lib/feishu/connection.js'

const triage = await import('../lib/feishu/triage.js')
const extract = await import('../lib/feishu/extract.js')
const cards = await import('../lib/feishu/cards.js')
const broadcast = await import('../lib/feishu/broadcast.js')

const BOT_OPEN_ID = 'ou_bot'
const CHAT_ID = 'oc_req'

/**
 * A real `im.message.receive_v1` event.
 *
 * The @-mention is STRUCTURAL here (a `mentions` entry plus an `@_user_1`
 * placeholder in the content), exactly as Feishu delivers it — which is the
 * whole point: "was the bot addressed?" is answered from the mention, never by
 * searching the text for an `@`.
 */
function feishuEvent(text, messageId = 'om_group_1', options = {}) {
  const addressed = options.addressed !== false
  const mentions = addressed ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: '机器人' }] : []
  const raw = addressed ? '@_user_1 ' + text : text
  return {
    message: {
      chat_id: options.chatId ?? CHAT_ID,
      chat_type: options.chatType ?? 'group',
      message_id: messageId,
      message_type: options.messageType ?? 'text',
      content: JSON.stringify(options.content ?? { text: raw }),
      mentions,
      create_time: '1790000000000',
    },
    sender: { sender_id: { open_id: options.sender ?? 'ou_wang' }, sender_type: 'user' },
  }
}

/** Normalise one event the way lib/team.js does for every inbound event. */
function inboundOf(event) {
  return normalizeMessage(event, { botOpenId: BOT_OPEN_ID })
}

function makeWorld(feishuOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-inbound-'))
  const config = loadConfig({
    workspace: join(dir, 'workspace'),
    tickIntervalMs: 0,
    defaultOwner: 'human:pm1',
    feishu: { senders: { ou_wang: 'human:pm1' }, ...feishuOverrides },
  })
  const store = new Store(dir).load()
  const handlers = createHandlers({
    ctx: { get: () => undefined, on: () => () => {}, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => ({}), drive: async () => ({ text: '', timedOut: false }) },
  })
  const sent = []
  const client = {
    ready: true,
    async send(chatId, payload) {
      sent.push({ chatId, payload })
      return { ok: true, code: 0, data: { message_id: 'om_out_' + sent.length } }
    },
    async sendThrough(chatId, ladder) {
      const rung = ladder[0]
      sent.push({ chatId, payload: rung.payload, via: rung.via })
      return { ok: true, via: rung.via, level: rung.level, attempts: [] }
    },
  }
  const inbox = new Inbox(dir).load()
  const ingest = createIngest({ config, handlers, client, inbox, store, triage, extract, cards, broadcast, log: { error: () => {} } })
  const chats = new Map([['feishu-oc_req-g1', { chatId: 'oc_req', title: '需求群', chatType: 'group' }]])
  return { dir, config, store, handlers, client, inbox, ingest, chats, sent, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a real group message becomes a requirement, and a card goes back to the group', async () => {
  const world = makeWorld()
  try {
    const text = '支付失败后没有重试入口，需要支持自动重试三次。验收标准：失败后自动重试 3 次，间隔 1s/3s/9s；不产生重复扣款。'
    const inbound = inboundOf(feishuEvent(text))
    assert.notEqual(inbound, null)

    const result = await world.ingest.onMessage(inbound)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.kind, 'requirement')

    const requirements = world.store.all('requirement')
    assert.equal(requirements.length, 1)
    const requirement = requirements[0]
    // Traceability: the object says which group it came from (design doc 06 §3).
    assert.equal(requirement.origin.surface, 'feishu')
    assert.equal(requirement.origin.chat_id, 'oc_req')
    assert.equal(requirement.state, 'draft')
    assert.equal(requirement.requester, 'human:pm1')
    assert.ok(requirement.acceptance_criteria.length >= 1, 'the acceptance criteria must survive extraction')

    // The message is marked consumed, so 漏单检测 can be a scan rather than a guess.
    const record = world.inbox.get('om_group_1')
    assert.deepEqual(record.consumed_by, [requirement.id])

    // Something was actually delivered back to the group — and it is the CARD,
    // not the text fallback: a card build that quietly threw would still leave a
    // message here, which is exactly the failure this assertion is for.
    assert.equal(world.sent.length, 1)
    assert.equal(world.sent[0].chatId, 'oc_req')
    const payload = world.sent[0].payload
    assert.equal(payload.msg_type, 'interactive', 'the real card layer must produce a card, not degrade silently')
    const rendered = JSON.stringify(payload)
    assert.ok(rendered.includes(requirement.id), 'the card must name the object it is about')
    assert.ok(Array.isArray(payload.content) === false, 'content is the wire form the Feishu API expects')
  } finally {
    world.cleanup()
  }
})

test('pure small talk in a group is recorded with a reason instead of becoming work', async () => {
  const world = makeWorld()
  try {
    // Triage's smalltalk patterns are anchored: a message that is NOTHING but
    // social filler is silent even when it mentions the bot.
    const inbound = inboundOf(feishuEvent('谢谢', 'om_group_2'))
    const result = await world.ingest.onMessage(inbound)
    assert.equal(result.ok, true)
    assert.notEqual(result.kind, 'requirement')
    assert.equal(world.store.all('requirement').length, 0)
    assert.equal(typeof world.inbox.get('om_group_2').ignored_reason, 'string')
    assert.equal(world.sent.length, 0, 'chatter must not produce a card')
  } finally {
    world.cleanup()
  }
})

test('chatter WITH substance that mentions the bot does become a draft — by design, and it is switchable', async () => {
  /*
   * The uncomfortable half of "being addressed outranks the word list": the
   * design explicitly accepts a false positive here ("判错一条的代价是多一张待确认
   * 的卡"), because the alternative failure — a person @-ing the bot and being
   * told their words contained no request — is worse. This test pins the trade
   * so it is a decision rather than a surprise, and `feishu.addressedOverridesIntent:
   * false` flips it back.
   */
  const world = makeWorld()
  try {
    const inbound = inboundOf(feishuEvent('哈哈哈 中午吃啥', 'om_chatter'))
    const result = await world.ingest.onMessage(inbound)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'requirement')
    const requirements = world.store.all('requirement')
    assert.equal(requirements.length, 1)
    assert.equal(requirements[0].state, 'draft', 'it lands as a draft a human can drop, not as work in flight')
  } finally {
    world.cleanup()
  }

  const strict = makeWorld({ addressedOverridesIntent: false })
  try {
    const result = await strict.ingest.onMessage(inboundOf(feishuEvent('哈哈哈 中午吃啥', 'om_chatter')))
    assert.notEqual(result.kind, 'requirement')
    assert.equal(strict.store.all('requirement').length, 0, 'the stricter rule keeps chatter out entirely')
    assert.equal(typeof strict.inbox.get('om_chatter').ignored_reason, 'string')
  } finally {
    strict.cleanup()
  }
})

test('an @-mention is not vetoed by the intent word list', async () => {
  /*
   * The design's own rule (docs 02 §3): the word list decides whether an
   * UN-addressed remark in a busy group is worth collecting. A message that
   * names the bot has already said what it wants. A pipeline that triages first
   * and stops at anything-but-`requirement` makes that rule unreachable, and the
   * human gets "没有发现表达诉求的词" for a message they typed at the bot on
   * purpose — a failure this project already shipped once.
   */
  const world = makeWorld()
  try {
    // No intent word from the list: triage alone calls this `status`.
    const inbound = inboundOf(feishuEvent('支付重试这块', 'om_mentions_1'))
    const result = await world.ingest.onMessage(inbound)
    assert.equal(result.ok, true)

    const record = world.inbox.get('om_mentions_1')
    assert.notEqual(record.ignored_reason, '有内容但没有表达诉求', 'the word list must not veto an addressed message')
    // Triage called it `status` — the record keeps that, so the override is
    // auditable rather than invisible.
    assert.equal(record.triage_kind, 'status')

    // The @ got it all the way to the ledger: a requirement now exists, and its
    // title is the sentence itself without the addressing prefix.
    const requirements = world.store.all('requirement')
    assert.equal(requirements.length, 1)
    assert.equal(requirements[0].title, '支付重试这块')
    assert.deepEqual(record.consumed_by, [requirements[0].id])
    assert.equal(requirements[0].origin.surface, 'feishu')

    // And the un-addressed version of the same sentence stays uncollected.
    const quiet = inboundOf(feishuEvent('支付重试这块', 'om_mentions_2', { addressed: false }))
    await world.ingest.onMessage(quiet)
    const quietRecord = world.inbox.get('om_mentions_2')
    assert.equal(typeof quietRecord.ignored_reason, 'string')
    assert.equal(world.store.all('requirement').length, 1, 'an un-addressed remark must not open a second requirement')
  } finally {
    world.cleanup()
  }
})

test('an @-mention of the bot is read from the mention, not from the text', async () => {
  /*
   * The real path, end to end, with the real protocol layer: a person @-mentions
   * the bot in a group and Feishu delivers a structural mention plus an
   * `@_user_1` placeholder. The team layer must treat that as aimed at the bot —
   * and it must NOT depend on finding an `@` in the text, which is exactly the
   * mistake that made an earlier version of this pipeline deaf.
   *
   * The sentence deliberately carries no intent word from the list, so triage
   * alone would file it as `status`; only the addressed override saves it.
   */
  const world = makeWorld()
  try {
    const event = feishuEvent('登录这块有点问题', 'om_mention_1')
    assert.match(event.message.content, /@_user_1/, 'the raw content carries the placeholder')
    const inbound = inboundOf(event)
    assert.notEqual(inbound, null)
    assert.equal(inbound.addressed, true, 'the mention says so')
    assert.equal(/@/.test(inbound.text), false, 'and the placeholder was replaced, so the text has no @ at all')
    assert.equal(inbound.text, '登录这块有点问题')
    assert.equal(inbound.sender, 'ou_wang', 'the sender arrives with the event — no guessing, no chat-level mapping')

    const result = await world.ingest.onMessage(inbound)
    assert.equal(result.ok, true, JSON.stringify(result))
    const requirements = world.store.all('requirement')
    assert.equal(requirements.length, 1, 'a mentioned group message must reach the ledger')
    assert.equal(requirements[0].origin.surface, 'feishu')
    assert.equal(requirements[0].origin.chat_id, 'oc_req')
    assert.equal(world.inbox.get('om_mention_1').addressed, true)
  } finally {
    world.cleanup()
  }
})

test('the bot never answers itself, and non-text events are not prompts', () => {
  const own = feishuEvent('我自己发的', 'om_self', { sender: BOT_OPEN_ID })
  assert.equal(inboundOf(own), null, 'our own posts come back as events; they must not become input')
  const fromApp = feishuEvent('应用发的', 'om_app')
  fromApp.sender.sender_type = 'app'
  assert.equal(inboundOf(fromApp), null)
  const image = feishuEvent('', 'om_img', { messageType: 'image', content: { image_key: 'img_x' } })
  assert.equal(inboundOf(image).text, '')
  assert.equal(inboundOf({ message: { chat_id: 'oc_x' } }), null, 'a malformed event is skipped, not thrown')
})

test('a group command moves a real task through a real gate', async () => {
  const world = makeWorld()
  try {
    // A task a person owns, so accepting it is a real, permitted transition.
    const req = world.handlers.create_requirement({ title: '导出 CSV', owner: 'human:pm1' })
    world.handlers.confirm_requirement({ id: req.id })
    const proposed = world.handlers.propose_tasks({ id: req.id, tasks: [{ title: '实现导出', assignee: 'human:pm1' }] })
    world.handlers.confirm_split({ id: req.id })
    const taskId = proposed.tasks[0].id
    assert.equal(world.store.get('task', taskId).state, 'assigned')

    const inbound = inboundOf(feishuEvent('接受 ' + taskId, 'om_group_3'))
    const result = await world.ingest.onMessage(inbound)
    assert.equal(result.command, 'accept_task')
    assert.equal(world.store.get('task', taskId).state, 'accepted')
    // The lease starts at accept — the state most worth watching.
    assert.equal(world.store.get('lease', taskId).holder, 'human:pm1')
    assert.match(world.sent.at(-1).payload.content?.text ?? JSON.stringify(world.sent.at(-1).payload), /✅|接受/)
  } finally {
    world.cleanup()
  }
})

test('a refusal from the state machine is what the group sees, word for word', async () => {
  const world = makeWorld()
  try {
    const req = world.handlers.create_requirement({ title: '别人的活', owner: 'human:pm1' })
    world.handlers.confirm_requirement({ id: req.id })
    const proposed = world.handlers.propose_tasks({ id: req.id, tasks: [{ title: '实现', assignee: 'human:someone-else' }] })
    world.handlers.confirm_split({ id: req.id })
    const taskId = proposed.tasks[0].id

    const inbound = inboundOf(feishuEvent('接受 ' + taskId, 'om_group_4'))
    await world.ingest.onMessage(inbound)
    assert.equal(world.store.get('task', taskId).state, 'assigned', 'the transition must not have happened')
    const said = JSON.stringify(world.sent.at(-1).payload)
    assert.match(said, /只有被指派的执行者本人/)
  } finally {
    world.cleanup()
  }
})
