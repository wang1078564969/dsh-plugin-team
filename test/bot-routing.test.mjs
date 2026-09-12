/*
 * Routing with a ROSTER: several bots, each 1:1 with an agent, each with its OWN
 * session in each chat.
 *
 * This is the behaviour the workbench's model requires and the first version of
 * this plugin did not have: bots are first-class objects with roles, and "a
 * conversation" belongs to a bot in a chat — not to the chat. Everything here
 * fails against a chat-keyed session, which is the point: these tests are the
 * regression guard for the mistake, not decoration.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { createResponder } from '../lib/feishu/responder.js'
import { Store } from '../lib/store.js'

const ROSTER = [
  { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
  { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, feishu: { speakPolicy: { onIntent: true } } },
]

function makeWorld(row = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-botroute-'))
  const config = loadConfig({
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    bots: ROSTER,
    feishu: { appId: 'cli_one', speakLeaseMs: 60_000, ...(row.feishu ?? {}) },
    ...row,
  })
  // `row.feishu` was already merged above; keep the merged value authoritative.
  config.feishu = { ...config.feishu, ...(row.feishu ?? {}) }
  const store = new Store(dir).load()
  const opened = []
  const driven = []
  const sent = []
  const pool = {
    async open(spec) {
      opened.push(spec)
      return { id: spec.sessionId, status: 'idle', session: { id: spec.sessionId, seq: 0 } }
    },
    async drive(agent, text) {
      driven.push({ sessionId: agent.id, text })
      return { text: '收到：' + text, timedOut: false }
    },
  }
  const mkClient = (appId) => ({
    ready: true,
    appId,
    async send(chatId, payload) {
      sent.push({ appId, chatId, msgType: payload.msg_type, text: payload.content?.text ?? '', header: payload.card?.header?.title?.content ?? null })
      return { ok: true, code: 0 }
    },
  })
  const clients = { cli_one: mkClient('cli_one'), cli_two: mkClient('cli_two') }
  const leases = []
  const responder = createResponder({
    config,
    store,
    pool,
    client: clients.cli_one,
    clientFor: (bot) => (bot === null ? clients.cli_one : clients[bot.feishu.appId !== '' ? bot.feishu.appId : 'cli_one']),
    matchIntent: (text) => /需求|要|加个|支持/.test(String(text)),
    log: { error: () => {} },
    ...(row.hooks ?? {}),
  })
  return {
    dir,
    config,
    store,
    pool,
    clients,
    responder,
    opened,
    driven,
    sent,
    leases,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const message = (overrides = {}) => ({
  chatId: 'oc_a',
  chatType: 'group',
  appId: 'cli_one',
  messageId: 'om_1',
  messageType: 'text',
  text: '帮我看下重试这块',
  addressed: true,
  sender: 'ou_wang',
  at: new Date().toISOString(),
  ...overrides,
})

test('the session belongs to the bot: team-bot-<bot>-<chat>, one per bot per chat', async () => {
  const world = makeWorld()
  try {
    const result = await world.responder.onMessage(message())
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.botId, 'req', 'intake outranks development in the priority order')
    assert.equal(result.sessionId, 'team-bot-req-oc_a')
    assert.equal(world.driven[0].sessionId, 'team-bot-req-oc_a')

    /*
     * 一个群的归属与"最后谁回答"是两件事：`primary_bot_id` 是**主机器人**
     * （这个群的消息都记在它名下），`last_bot_id` 只是"最后谁回答的"。
     * 主在这里由路由规则在首次接触时定下。
     */
    const chat = world.store.get('chat', 'oc_a')
    assert.equal(chat.primary_bot_id, 'req')
    assert.equal(chat.last_bot_id, 'req')
    const record = world.store.get('botsession', 'req.oc_a')
    assert.equal(record.turns, 1)
    assert.equal(record.session_id, 'team-bot-req-oc_a')

    // The SAME bot in ANOTHER group is another conversation.
    await world.responder.onMessage(message({ chatId: 'oc_b', messageId: 'om_2' }))
    assert.equal(world.driven[1].sessionId, 'team-bot-req-oc_b')
    assert.equal(world.store.get('botsession', 'req.oc_b').turns, 1)

    /*
     * 同一个群里点名另一个机器人 → 用**它自己的会话**回答，但**主不变**：
     * 记录归属是群级的，回答是消息级的。这正是"主机器人负责记录所有消息"的落点。
     */
    await world.responder.onMessage(message({ messageId: 'om_3', text: '@开发机器人 重试这块你看下' }))
    assert.equal(world.driven[2].sessionId, 'team-bot-dev-oc_a')
    assert.equal(world.store.get('botsession', 'dev.oc_a').turns, 1)
    const afterNamed = world.store.get('chat', 'oc_a')
    assert.equal(afterNamed.primary_bot_id, 'req', '点名只是让 dev 回答，不改这个群的主')
    assert.equal(afterNamed.last_bot_id, 'dev', '但"最后谁回答的"要跟着变')
    assert.equal(
      world.store.get('chat', 'oc_a').last_bot_id,
      'dev',
      'the "who answered last" marker follows the answering bot',
    )
  } finally {
    world.cleanup()
  }
})

test('a chat keeps the bot it has been talking to, even after the roster grows', async () => {
  const world = makeWorld()
  try {
    // The group has been served by the dev bot…
    world.store.put('chat', { id: 'oc_a', chat_type: 'group', app_id: 'cli_one', bot_id: 'dev' })
    const result = await world.responder.onMessage(message())
    // …so a higher-priority bot added later does not take the conversation over.
    assert.equal(result.botId, 'dev')
    assert.equal(result.sessionId, 'team-bot-dev-oc_a')
  } finally {
    world.cleanup()
  }
})

test('a bot\'s own preset and model reach the session it opens', async () => {
  const world = makeWorld({
    bots: [
      { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, agentPreset: 'coder', model: { primary: 'fast-model' } },
    ],
    sessions: { preset: 'default-preset' },
  })
  try {
    await world.responder.onMessage(message())
    assert.equal(world.opened[0].preset, 'coder', 'the bot names its own agent preset')
    assert.equal(world.opened[0].model, 'fast-model')
    assert.equal(world.opened[0].role, 'dev')
  } finally {
    world.cleanup()
  }
})

test('an un-addressed group message is not answered, and the reason is recorded on the chat', async () => {
  const world = makeWorld({ bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }] })
  try {
    const result = await world.responder.onMessage(message({ addressed: false, text: '今天天气不错' }))
    assert.equal(result.skipped, 'no-intent')
    assert.equal(world.sent.length, 0)
    assert.equal(world.opened.length, 0, 'and it does not even start a turn')
    const chat = world.store.get('chat', 'oc_a')
    assert.equal(chat.last_skip, 'no-intent', '"why did it ignore me" must have an answer that outlives the process')
  } finally {
    world.cleanup()
  }
})

test('onIntent lets the bot configured for that kind of message answer', async () => {
  /*
   * `req` has onIntent off, `dev` has it on. Asking only the highest-priority
   * candidate would mean the bot that WAS configured to answer this kind of message
   * never gets the chance in any chat a quieter bot also serves — so the policy
   * removes candidates, it does not reorder them.
   */
  const world = makeWorld()
  try {
    const result = await world.responder.onMessage(message({ addressed: false, text: '能不能加个重试' }))
    assert.equal(result.skipped, undefined)
    assert.equal(result.botId, 'dev')
    assert.equal(world.sent.length, 1)
  } finally {
    world.cleanup()
  }
})

test('one group message, two apps: the lease keeps it to ONE answer', async () => {
  /*
   * THE SCENARIO THE LEASE EXISTS FOR. Several bots with their own identity means
   * several Feishu apps, and every app's long connection receives the SAME group
   * message — so the router is asked twice, once per app, and each time it sees a
   * different (and perfectly valid) single candidate. Without a shared claim on the
   * chat, both bots answer the same sentence.
   */
  const world = makeWorld({
    bots: [
      { id: 'req', displayName: '需求机器人', role: 'req', enabled: true, feishu: { speakPolicy: { onIntent: true } } },
      { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, feishu: { appId: 'cli_two', speakPolicy: { onIntent: true } } },
    ],
    feishu: { appId: 'cli_one', apps: { cli_two: { appSecret: 's2' } } },
  })
  try {
    const text = '能不能加个重试'
    const onFirstApp = await world.responder.onMessage(message({ appId: 'cli_one', addressed: false, text }))
    assert.equal(onFirstApp.botId, 'req')
    assert.equal(world.responder.leases()[0].botId, 'req')

    // The same message, delivered by the OTHER app's connection.
    const onSecondApp = await world.responder.onMessage(message({ appId: 'cli_two', messageId: 'om_2', addressed: false, text }))
    assert.equal(onSecondApp.skipped, 'lease-held-by-req')
    assert.equal(world.sent.length, 1, 'the group got one answer, from one bot')
  } finally {
    world.cleanup()
  }
})

test('naming a bot still takes the lease, so the other app\'s delivery stays quiet', async () => {
  /*
   * The nastiest combination: several apps (so the same message arrives twice), and
   * a NAMED bot. The named bot answers — an explicit address outranks a claim — but
   * its answer must take the claim, or the second delivery's candidate (which is a
   * different bot, because the named one is not on that app) answers as well and the
   * group hears two replies to one question.
   */
  const world = makeWorld({
    bots: [
      { id: 'req', displayName: '需求机器人', role: 'req', enabled: true, feishu: { speakPolicy: { onIntent: true } } },
      { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, feishu: { appId: 'cli_two', speakPolicy: { onIntent: true } } },
    ],
    feishu: { appId: 'cli_one', apps: { cli_two: { appSecret: 's2' } } },
  })
  try {
    const text = '@需求机器人 这个需求看下'
    const first = await world.responder.onMessage(message({ appId: 'cli_one', addressed: false, text }))
    assert.equal(first.botId, 'req')
    assert.equal(world.responder.leases()[0].botId, 'req')

    const second = await world.responder.onMessage(message({ appId: 'cli_two', messageId: 'om_2', addressed: false, text }))
    assert.equal(second.skipped, 'lease-held-by-req')
    assert.equal(world.sent.length, 1)
  } finally {
    world.cleanup()
  }
})

test('the lease is per chat: a different group is answered immediately', async () => {
  const world = makeWorld({ bots: ROSTER.map((one) => ({ ...one, feishu: { ...(one.feishu ?? {}), speakPolicy: { onIntent: true } } })) })
  try {
    await world.responder.onMessage(message({ addressed: false, text: '能不能加个重试' }))
    const other = await world.responder.onMessage(message({ chatId: 'oc_b', messageId: 'om_9', addressed: false, text: '再加个超时' }))
    assert.equal(other.skipped, undefined)
    assert.equal(world.sent.length, 2)
  } finally {
    world.cleanup()
  }
})

test('addressing a bot always outranks the lease: a person asking it directly gets an answer', async () => {
  const world = makeWorld({ bots: ROSTER.map((one) => ({ ...one, feishu: { ...(one.feishu ?? {}), speakPolicy: { onIntent: true } } })) })
  try {
    await world.responder.onMessage(message({ addressed: false, text: '能不能加个重试' }))
    assert.equal(world.sent.length, 1)
    // The lease is held by whoever answered, and an explicitly addressed question
    // must still be answered by the bot that was addressed.
    const held = world.responder.leases()[0].botId
    const other = held === 'req' ? '开发机器人' : '需求机器人'
    const result = await world.responder.onMessage(message({ messageId: 'om_2', text: '@' + other + ' 这个你看下' }))
    assert.equal(result.skipped, undefined)
    assert.notEqual(result.botId, held)
    assert.equal(world.sent.length, 2)
  } finally {
    world.cleanup()
  }
})

test('the answer goes out through the app the BOT speaks on, not the default one', async () => {
  const world = makeWorld({
    bots: [
      { id: 'req', displayName: '需求机器人', role: 'req', enabled: true, feishu: { appId: 'cli_two' } },
    ],
  })
  try {
    const result = await world.responder.onMessage(message({ appId: 'cli_two' }))
    assert.equal(result.botId, 'req')
    assert.equal(world.sent[0].appId, 'cli_two', 'a reply from an app that is not in the chat is rejected by Feishu')
  } finally {
    world.cleanup()
  }
})

test('正文里写了另一台机器人的名字，不足以把它拉进来', async () => {
  /*
   * 这条规矩是有意的：`@开发机器人` 出现在**正文**里，但它不是一次结构化的 @
   * （事件里没有 `mentions`，也就没有 open_id）。只凭正文里的字面名字就让另一台机器人
   * 抢答，等于"机器人自己猜你叫的是它"—— 与"机器人打断人"没法区分。
   *
   * 真正被 @ 到的那种情况单独有用例（下面两条）：那时事件里有 open_id，
   * 由 `mentionedAppIds` 带上来，结论是确定的。
   */
  const world = makeWorld({
    bots: [
      { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
      { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, feishu: { appId: 'cli_two' } },
    ],
  })
  try {
    const result = await world.responder.onMessage(message({ appId: 'cli_one' }))
    assert.equal(result.botId, 'req')
    const named = await world.responder.onMessage(message({ messageId: 'om_2', appId: 'cli_one', text: '@开发机器人 在吗' }))
    assert.equal(named.botId, 'req', '正文里的名字不算身份证据')
  } finally {
    world.cleanup()
  }
})

test('被真正 @ 到的那台机器人，即使事件是从另一个应用的连接来的，也由它回答', async () => {
  /*
   * 用户 2026-09-12 的场景：一个群里两台机器人（各自一个应用）。同一个群消息会在
   * **两条连接上各到一次**，去重只放先到的那一条过去 —— 于是"事件从哪个应用来"是竞态，
   * 而"@ 到了谁"是事实（`mentions[].id.open_id`）。
   *
   * 以前只按"事件从哪来"过滤候选，于是 @ 了开发机器人、而需求机器人的连接先到，
   * 候选里根本没有开发机器人 → **没人回答**，而且时灵时不灵。现在按身份先把被点名的那台
   * 排进候选并排在第一位。
   */
  const world = makeWorld({
    bots: [
      { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
      { id: 'dev', displayName: '个人网银前端', role: 'dev', enabled: true, feishu: { appId: 'cli_two' } },
    ],
  })
  try {
    /*
     * 事件落在 `cli_one`（需求机器人的应用）上，但 `mentions` 里是开发机器人的 open_id ——
     * 这正是 `lib/team.js` 的 `mentionedAppsOf` 会算出 `['cli_two']` 的情形。
     */
    const mentioned = message({
      appId: 'cli_one',
      text: '测试会话',
      addressed: false,
      mentionedAppIds: ['cli_two'],
    })
    const plan = world.responder.plan(mentioned)
    assert.equal(plan.bot === null ? null : plan.bot.id, 'dev', '被点名的那台才是候选第一名')
    assert.equal(plan.speak, true, 'requireMention 打开的群里，被点名就是该它回答')
    assert.equal(plan.reason, 'named')

    const result = await world.responder.onMessage(mentioned)
    assert.equal(result.botId, 'dev')
    assert.equal(result.sessionId, 'team-bot-dev-oc_a', '它用自己的会话')
    assert.equal(world.sent[0].appId, 'cli_two', '并从**它自己**的应用发出去（另一个应用发的会被飞书拒）')
    assert.equal(world.store.get('chat', 'oc_a').primary_bot_id, 'dev', '首次接触：点名定归属')
  } finally {
    world.cleanup()
  }
})

test('点名定归属，但不改一个已经有主的群', async () => {
  const world = makeWorld({
    bots: [
      { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
      { id: 'dev', displayName: '个人网银前端', role: 'dev', enabled: true, feishu: { appId: 'cli_two' } },
    ],
  })
  try {
    await world.responder.onMessage(message({ appId: 'cli_one' }))
    assert.equal(world.store.get('chat', 'oc_a').primary_bot_id, 'req')
    const named = await world.responder.onMessage(
      message({ messageId: 'om_2', appId: 'cli_one', text: '看下这个', addressed: false, mentionedAppIds: ['cli_two'] }),
    )
    assert.equal(named.botId, 'dev', '被点名的人回答')
    assert.equal(world.store.get('chat', 'oc_a').primary_bot_id, 'req', '但"这个群归谁记"不变')
  } finally {
    world.cleanup()
  }
})

test('a digestOnly bot broadcasts: no card, and the answer is capped', async () => {
  const long = '## 结论\n\n- 一\n- 二\n- 三'
  const world = makeWorld({
    bots: [
      { id: 'coord', displayName: '调度机器人', role: 'coord', enabled: true, feishu: { speakPolicy: { digestOnly: true } } },
    ],
    hooks: {},
  })
  try {
    world.pool.drive = async () => ({ text: long, timedOut: false })
    await world.responder.onMessage(message())
    assert.equal(world.sent[0].msgType, 'text', 'a digest is not a document')

    // The same body from a bot that is not digest-only DOES go as a card, with the
    // bot's name in the header — the only place a person can see which role spoke
    // when several bots share one Feishu app.
    const cardWorld = makeWorld({ bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }] })
    try {
      cardWorld.pool.drive = async () => ({ text: long, timedOut: false })
      await cardWorld.responder.onMessage(message())
      assert.equal(cardWorld.sent[0].msgType, 'interactive')
      assert.equal(cardWorld.sent[0].header, '需求机器人')
    } finally {
      cardWorld.cleanup()
    }
  } finally {
    world.cleanup()
  }
})

test('a failed turn releases the lease, so the next bot may answer', async () => {
  const world = makeWorld()
  try {
    world.pool.drive = async () => {
      throw new Error('model exploded')
    }
    const result = await world.responder.onMessage(message({ addressed: false, text: '能不能加个重试' }))
    assert.equal(result.code, 'drive_failed')
    assert.deepEqual(world.responder.leases(), [], 'nothing was said, so nothing is held')
  } finally {
    world.cleanup()
  }
})

test('with no roster the plugin is a single assistant again, session id included', async () => {
  const world = makeWorld({ bots: [] })
  try {
    const result = await world.responder.onMessage(message())
    assert.equal(result.botId, null)
    assert.equal(result.sessionId, 'team-feishu-oc_a')
    assert.equal(world.store.all('botsession').length, 0, 'no bot, no bot conversation')
  } finally {
    world.cleanup()
  }
})

test('the announcement carries the bot, so the sidebar can name the session', async () => {
  const announced = []
  const world = makeWorld({ hooks: { onSession: (info) => announced.push(info), fetchChatTitle: async () => '需求群' } })
  try {
    await world.responder.onMessage(message())
    assert.equal(announced.length, 1)
    assert.equal(announced[0].botId, 'req')
    assert.equal(announced[0].botName, '需求机器人')
    assert.equal(announced[0].chatTitle, '需求群')
    assert.equal(announced[0].sessionId, 'team-bot-req-oc_a')
  } finally {
    world.cleanup()
  }
})
