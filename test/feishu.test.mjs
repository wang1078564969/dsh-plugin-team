/*
 * Tests for the Feishu surface that does not need Feishu.
 *
 * WHY THIS MATTERS MORE THAN USUAL RIGHT NOW. The bridge is deliberately
 * unmounted, so no group message can arrive for real. The parts that decide what
 * to DO with a message — credentials, the transport's failure semantics, the
 * dedup log, command parsing, and the refusal to act for an unmapped sender —
 * are therefore the only ground truth for the inbound path until the bridge is
 * mounted again. Each test below pins a behaviour that a real group would
 * otherwise discover the hard way.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { FeishuClient, resolveCredentials } from '../lib/feishu/client.js'
import { findDuplicate as realFindDuplicate } from '../lib/feishu/extract.js'
import { selectContextMessages as realSelectContextMessages } from '../lib/feishu/triage.js'
import { Inbox, createIngest, looksAddressed, parseCommand, resolveSender } from '../lib/feishu/ingest.js'
import { mentionsBot, normalizeMessage, parseContent, readableText } from '../lib/feishu/connection.js'

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/** A fetch stand-in that answers the auth endpoint and records every call. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    for (const [match, respond] of routes) {
      if (String(url).includes(match)) {
        const body = respond(init)
        return { json: async () => body }
      }
    }
    throw new Error('unexpected request: ' + url)
  }
  impl.calls = calls
  return impl
}

test('credentials come from this plugin\'s own config — never from the bridge\'s', () => {
  /*
   * The decoupling, pinned. A bridge config sitting on disk must NOT make this
   * plugin start as that plugin's app: that is how one package silently became
   * dependent on another's configuration. The two values belong to the team
   * config (or the two DSH_TEAM_FEISHU_* environment variables).
   */
  const dir = mkdtempSync(join(tmpdir(), 'team-cred-'))
  const previous = process.env.DSH_FEISHU_DATA
  const previousId = process.env.DSH_TEAM_FEISHU_APP_ID
  try {
    process.env.DSH_FEISHU_DATA = dir
    delete process.env.DSH_TEAM_FEISHU_APP_ID
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ appId: 'cli_bridge', appSecret: 's3cret' }), 'utf8')

    const ignored = resolveCredentials({ feishu: {} })
    assert.equal(ignored.ready, false, 'a bridge config on disk must not be adopted')
    assert.equal(ignored.source, 'none')

    const own = resolveCredentials({ feishu: { appId: 'cli_team', appSecret: 'other' } })
    assert.equal(own.appId, 'cli_team')
    assert.equal(own.source, 'team-config')

    process.env.DSH_TEAM_FEISHU_APP_ID = 'cli_env'
    process.env.DSH_TEAM_FEISHU_APP_SECRET = 'envsecret'
    const fromEnv = resolveCredentials({ feishu: { appId: 'cli_team', appSecret: 'other' } })
    assert.equal(fromEnv.appId, 'cli_env')
    assert.equal(fromEnv.source, 'env')
  } finally {
    if (previous === undefined) delete process.env.DSH_FEISHU_DATA
    else process.env.DSH_FEISHU_DATA = previous
    if (previousId === undefined) delete process.env.DSH_TEAM_FEISHU_APP_ID
    else process.env.DSH_TEAM_FEISHU_APP_ID = previousId
    delete process.env.DSH_TEAM_FEISHU_APP_SECRET
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tenant token is read from the TOP level and reused until it nears expiry', async () => {
  const fetchImpl = fakeFetch([
    ['tenant_access_token', () => ({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 })],
    ['im/v1/messages', () => ({ code: 0, msg: 'ok', data: { message_id: 'om_1' } })],
  ])
  let now = 1_000_000
  const client = new FeishuClient(
    { appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true },
    { fetch: fetchImpl, now: () => now },
  )
  const first = await client.send('oc_1', { msg_type: 'text', content: { text: 'hi' } })
  assert.equal(first.ok, true)
  const second = await client.send('oc_1', { msg_type: 'text', content: { text: 'again' } })
  assert.equal(second.ok, true)
  const authCalls = fetchImpl.calls.filter((call) => call.url.includes('tenant_access_token'))
  assert.equal(authCalls.length, 1, 'the token must be cached across calls')

  // Past expiry-minus-margin the client must authenticate again.
  now += 7200_000
  await client.send('oc_1', { msg_type: 'text', content: { text: 'later' } })
  assert.equal(fetchImpl.calls.filter((call) => call.url.includes('tenant_access_token')).length, 2)
})

test('concurrent sends share one auth request', async () => {
  let authCount = 0
  const fetchImpl = async (url) => {
    if (String(url).includes('tenant_access_token')) {
      authCount += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 }) }
    }
    return { json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om' } }) }
  }
  const client = new FeishuClient(
    { appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true },
    { fetch: fetchImpl },
  )
  await Promise.all([client.send('oc_1', { msg_type: 'text', content: {} }), client.send('oc_1', { msg_type: 'text', content: {} })])
  assert.equal(authCount, 1, 'concurrent callers must merge into one auth')
})

test('a non-zero code is a FAILURE, not an exception (this is how replies get lost)', async () => {
  const fetchImpl = fakeFetch([
    ['tenant_access_token', () => ({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 })],
    ['im/v1/messages', () => ({ code: 9499, msg: 'rate limited' })],
  ])
  const client = new FeishuClient(
    { appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true },
    { fetch: fetchImpl },
  )
  const result = await client.send('oc_1', { msg_type: 'text', content: { text: 'hi' } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 9499)
  assert.equal(result.msg, 'rate limited')
})

test('the degradation ladder stops at the first accepted rung and records every attempt', async () => {
  const rejected = new Set()
  const fetchImpl = async (url, init) => {
    if (String(url).includes('tenant_access_token')) {
      return { json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 }) }
    }
    const body = JSON.parse(init.body)
    // Reject the rich card, accept the plain text rung.
    if (body.msg_type === 'interactive') return { json: async () => ({ code: 10002, msg: 'card invalid' }) }
    rejected.add(body.msg_type)
    return { json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_ok' } }) }
  }
  const client = new FeishuClient(
    { appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true },
    { fetch: fetchImpl },
  )
  const ladder = [
    { level: 1, via: 'card', payload: { msg_type: 'interactive', card: { elements: [] } } },
    { level: 4, via: 'text', payload: { msg_type: 'text', content: { text: 'plain' } } },
  ]
  const delivered = await client.sendThrough('oc_1', ladder)
  assert.equal(delivered.ok, true)
  assert.equal(delivered.via, 'text')
  assert.equal(delivered.level, 4)
  assert.deepEqual(delivered.attempts, [
    { level: 1, via: 'card', code: 10002, ok: false },
    { level: 4, via: 'text', code: 0, ok: true },
  ])
  assert.equal(rejected.has('text'), true)
})

test('话题隔离：replyTo 走引用回复；引用失败自动退化为普通消息（不能吞掉答案）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    calls.push({ url: href, body: init?.body === undefined ? null : JSON.parse(init.body) })
    if (href.includes('tenant_access_token')) {
      return { json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 }) }
    }
    // 引用回复这条路被拒（消息撤回 / 权限不足）。
    if (href.includes('/reply')) return { json: async () => ({ code: 230002, msg: 'message not found' }) }
    return { json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_new' } }) }
  }
  const client = new FeishuClient(
    { appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true },
    { fetch: fetchImpl },
  )
  const ladder = [{ level: 1, via: 'card', payload: { msg_type: 'interactive', content: '{"x":1}', uuid: 'u1' } }]
  const delivered = await client.sendThrough('oc_1', ladder, { replyTo: 'om_original' })
  assert.equal(delivered.ok, true, '退化之后照样发出去')
  assert.equal(delivered.reply_to, null)
  assert.equal(delivered.messageId, 'om_new')
  // 先试引用、被拒之后退回普通消息：两次都留痕，人看得出发生了什么。
  assert.equal(calls.some((one) => one.url.includes('/im/v1/messages/om_original/reply')), true)
  assert.deepEqual(delivered.attempts, [
    { level: 1, via: 'card', code: 230002, ok: false, reply_to: 'om_original' },
    { level: 1, via: 'card', code: 0, ok: true, reply_to: null, fallback: true },
  ])
  // 引用成功时 `uuid` 不带过去：飞书不接受 reply 接口上的幂等键。
  const okImpl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body) })
    if (String(url).includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) }
    return { json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_reply' } }) }
  }
  const client2 = new FeishuClient({ appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true }, { fetch: okImpl })
  const replied = await client2.sendThrough('oc_1', ladder, { replyTo: 'om_original' })
  assert.equal(replied.ok, true)
  assert.equal(replied.reply_to, 'om_original')
  const replyCall = calls.find((one) => one.url.includes('/reply'))
  assert.equal(replyCall.body.uuid, undefined)
  assert.equal(replyCall.body.msg_type, 'interactive')
})

test('a top-level payload survives: /bot/v3/info answers code 0 with bot OUTSIDE data', async () => {
  /*
   * The same trap as the auth endpoint, in a second place: this response is
   * `{code, msg, bot}` — there is no `data` at all. A client that forwards only
   * `data` returns `ok: true` with nothing in it, and the caller concludes the
   * bot has no identity. Downstream that means no group message can ever count
   * as addressed, i.e. a bot that is silent in every group while every log line
   * says success.
   */
  const fetchImpl = fakeFetch([
    ['tenant_access_token', () => ({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 })],
    ['bot/v3/info', () => ({ code: 0, msg: 'success', bot: { open_id: 'ou_847e', app_name: '王梦凡的飞书 CLI' } })],
  ])
  const client = new FeishuClient(
    { appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true },
    { fetch: fetchImpl },
  )
  const info = await client.call('/open-apis/bot/v3/info')
  assert.equal(info.ok, true)
  assert.equal(info.data, null, 'this endpoint really has no data envelope')
  assert.equal(info.raw.bot.open_id, 'ou_847e', 'the payload is at the top level and must survive')
})

test('a client without credentials refuses to send instead of throwing', async () => {
  const client = new FeishuClient({ appId: '', appSecret: '', baseUrl: 'https://open.feishu.cn', ready: false })
  const result = await client.send('oc_1', { msg_type: 'text', content: { text: 'hi' } })
  assert.equal(result.ok, false)
  assert.match(result.msg, /credentials/)
  // And the description never leaks a secret.
  assert.equal(JSON.stringify(client.describe()).includes('s3cret'), false)
})

test('a real degradation rung survives the transport: content string kept, uuid passed through', async () => {
  /*
   * The ladder's rungs are `{msg_type, content, uuid}` where `content` is
   * ALREADY a JSON string — not the `{msg_type, card}` shape a hand-built card
   * has. Sending a rung through a client that only understood `card` would post
   * an empty body for every card level, i.e. lose the content at the exact
   * moment the design promised not to.
   */
  const { degradationLadder } = await import('../lib/feishu/cards.js')
  const { buildRequirementCard } = await import('../lib/feishu/broadcast.js')
  const spec = buildRequirementCard(
    {
      id: 'req-2026-014',
      title: '支付失败自动重试',
      state: 'draft',
      priority: 'P1',
      owner: 'human:pm1',
      requester: 'human:pm1',
      type: 'feature_delivery',
      origin: { surface: 'feishu', chat_id: 'oc_x', excerpts: [] },
      body: { problem: '没有重试入口', proposal: '' },
      acceptance_criteria: ['自动重试 3 次'],
      tasks: [],
      links: { repos: [], docs: [], branches: [], mirror: null },
      decisions: [],
      visibility: 'team',
      history: [],
    },
    [],
    {
      // The builder's context. `nonce` is not optional: button values carry it.
      nonce: () => 'n-test',
      now: () => new Date('2026-02-03T10:00:00.000Z'),
      buttons: false,
    },
  )
  const ladder = degradationLadder(spec)
  assert.ok(ladder.length >= 4, 'the ladder must offer several rungs')

  const bodies = []
  const fetchImpl = async (url, init) => {
    if (String(url).includes('tenant_access_token')) {
      return { json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 }) }
    }
    bodies.push(JSON.parse(init.body))
    return { json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_1' } }) }
  }
  const client = new FeishuClient(
    { appId: 'cli_x', appSecret: 's', baseUrl: 'https://open.feishu.cn', ready: true },
    { fetch: fetchImpl },
  )
  const first = ladder[0]
  const sent = await client.send('oc_x', first.payload)
  assert.equal(sent.ok, true)
  assert.equal(bodies[0].receive_id, 'oc_x')
  assert.equal(bodies[0].msg_type, first.payload.msg_type)
  assert.equal(typeof bodies[0].content, 'string')
  assert.ok(bodies[0].content.length > 2, 'the content string must not be emptied')
  assert.match(bodies[0].content, /req-2026-014/)
  assert.equal(bodies[0].uuid, first.payload.uuid, 'uuid is the idempotency key and must travel')
})

/* ------------------------------------------------------------------ *
 * The inbound seam
 * ------------------------------------------------------------------ */

test('one Feishu event becomes one inbound message, with the mention read structurally', () => {
  const event = {
    message: {
      chat_id: 'oc_req',
      chat_type: 'group',
      message_id: 'om_1',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 @_user_2 这块你来跟' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '团队机器人' },
        { key: '@_user_2', id: { open_id: 'ou_zhou' }, name: '周愉' },
      ],
      create_time: '1790000000000',
    },
    sender: { sender_id: { open_id: 'ou_wang' }, sender_type: 'user' },
  }
  const inbound = normalizeMessage(event, { botOpenId: 'ou_bot' })
  // The bot's own mention is ADDRESSING and disappears; someone else's is content
  // and stays, because "@周愉 这块你来跟" says something the bare sentence does not.
  assert.equal(inbound.text, '@周愉 这块你来跟')
  assert.equal(inbound.addressed, true)
  assert.equal(inbound.sender, 'ou_wang')
  assert.equal(inbound.chatType, 'group')
  assert.equal(inbound.from_bridge, false)

  // Nothing to answer, nothing to triage — but it is still an event we saw.
  const empty = normalizeMessage({ ...event, message: { ...event.message, content: JSON.stringify({ text: '@_user_1' }) } }, { botOpenId: 'ou_bot' })
  assert.equal(empty.text, '')
})

test('the bot never treats its own posts — or another app — as input', () => {
  const base = {
    message: { chat_id: 'oc_req', chat_type: 'group', message_id: 'om_self', message_type: 'text', content: JSON.stringify({ text: 'hi' }), mentions: [] },
    sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'user' },
  }
  assert.equal(normalizeMessage(base, { botOpenId: 'ou_bot' }), null, 'our own message would make the bot answer itself forever')
  const app = { ...base, sender: { sender_id: { open_id: 'ou_other_app' }, sender_type: 'app' } }
  assert.equal(normalizeMessage(app, { botOpenId: 'ou_bot' }), null)
  // A malformed event is skipped rather than thrown on: one bad frame must not
  // take down the connection.
  assert.equal(normalizeMessage({ message: { chat_id: 'oc_x' } }, { botOpenId: 'ou_bot' }), null)
  assert.equal(normalizeMessage(null, { botOpenId: 'ou_bot' }), null)
})

test('content parsing and mention detection survive the shapes Feishu actually sends', () => {
  assert.deepEqual(parseContent('{"text":"hi"}'), { text: 'hi' })
  assert.deepEqual(parseContent('not json'), {})
  assert.deepEqual(parseContent(undefined), {})
  assert.equal(readableText({ text: '没有提及' }, []), '没有提及')
  assert.equal(readableText({ text: '@_user_9 你好' }, [{ key: '@_user_9', id: { open_id: 'ou_x' }, name: '某人' }]), '@某人 你好')
  assert.equal(readableText({ text: '@_user_9 你好' }, [{ key: '@_user_9', id: { open_id: 'ou_bot' }, name: '机器人' }], 'ou_bot'), '你好')
  assert.equal(mentionsBot([{ id: { open_id: 'ou_bot' } }], 'ou_bot'), true)
  assert.equal(mentionsBot([{ id: { open_id: 'ou_other' } }], 'ou_bot'), false)
  assert.equal(mentionsBot([], 'ou_bot'), false)
  assert.equal(mentionsBot([{ id: { open_id: 'ou_bot' } }], ''), false, 'without knowing our own id, nothing is a mention')
})

/* ------------------------------------------------------------------ *
 * Commands and identity
 * ------------------------------------------------------------------ */

test('commands parse strictly, and prose never turns into a command', () => {
  assert.deepEqual(parseCommand('接受 task-1'), { action: 'accept_task', id: 'task-1', verb: '接受' })
  assert.deepEqual(parseCommand('  开始  task-12 '), { action: 'start_task', id: 'task-12', verb: '开始' })
  assert.deepEqual(parseCommand('@机器人 验收 task-3'), { action: 'verify_task', id: 'task-3', verb: '验收' })
  assert.deepEqual(parseCommand('状态'), { action: 'status', id: null, verb: '状态' })
  // No id: nothing to act on.
  assert.equal(parseCommand('接受'), null)
  // Prose that merely contains a verb is not a command.
  assert.equal(parseCommand('这个任务我接受了，明天开始做'), null)
  assert.equal(parseCommand(''), null)
})

test('an unmapped sender may read the board but may not change it', async () => {
  const { ingest, sent, handlers } = fakeIngest({ senders: { ou_known: 'human:known' } })
  await ingest.onMessage(inbound({ messageId: 'om_1', text: '状态' }))
  assert.equal(sent.length, 1, 'status is read-only and allowed')

  await ingest.onMessage(inbound({ messageId: 'om_2', text: '接受 task-1', sender: 'ou_stranger' }))
  assert.match(sent[1].text, /认不出你是谁/)
  assert.equal(handlers.calls.length, 0, 'no state change may happen for an unmapped sender')

  await ingest.onMessage(inbound({ messageId: 'om_3', text: '接受 task-1', sender: 'ou_known' }))
  assert.equal(handlers.calls.length, 1)
  assert.equal(handlers.calls[0].action, 'accept_task')
  assert.equal(handlers.calls[0].args.actor, 'human:known')
  assert.equal(resolveSender({ feishu: { senders: { ou_known: 'human:known' } } }, 'ou_known'), 'human:known')
  assert.equal(resolveSender({ feishu: {} }, 'ou_known'), null)
})

test('a chat may name its single operator, because the bridge does not carry the speaker', async () => {
  /*
   * A relayed message arrives with no sender identity at all, so `接受 task-1`
   * from a group is unattributable by construction. `feishu.chatActors` is the
   * opt-in answer for a one-operator working group; without it the command is
   * refused, which is the safe default.
   */
  const { ingest, sent, handlers } = fakeIngest({ chatActors: { oc_aaa: 'human:pm1' } })
  await ingest.onMessage(inbound({ messageId: 'om_chat_actor', text: '接受 task-1', sender: null }))
  assert.equal(handlers.calls.length, 1)
  assert.equal(handlers.calls[0].args.actor, 'human:pm1')
  assert.equal(handlers.calls[0].action, 'accept_task')
  assert.equal(resolveSender({ feishu: { chatActors: { oc_aaa: 'human:pm1' } } }, null, 'oc_aaa'), 'human:pm1')
  // The precise mapping still wins when both exist.
  assert.equal(
    resolveSender({ feishu: { senders: { ou_a: 'human:precise' }, chatActors: { oc_aaa: 'human:pm1' } } }, 'ou_a', 'oc_aaa'),
    'human:precise',
  )

  const other = fakeIngest({})
  await other.ingest.onMessage(inbound({ messageId: 'om_no_actor', text: '接受 task-1', sender: null }))
  assert.equal(other.handlers.calls.length, 0)
  assert.match(other.sent[0].text, /认不出你是谁/)
})

test('a redelivered message never becomes a second requirement', async () => {
  const { ingest, handlers } = fakeIngest({})
  const first = await ingest.onMessage(inbound({ messageId: 'om_dup', text: '@机器人 加一个导出功能，要能导出 CSV' }))
  assert.equal(first.kind, 'requirement')
  assert.equal(handlers.calls.filter((call) => call.action === 'create_requirement').length, 1)
  const again = await ingest.onMessage(inbound({ messageId: 'om_dup', text: '@机器人 加一个导出功能，要能导出 CSV' }))
  assert.equal(again.skipped, 'duplicate')
  assert.equal(handlers.calls.filter((call) => call.action === 'create_requirement').length, 1)
})

test('a non-requirement is recorded with its reason, never silently dropped', async () => {
  const { ingest, inbox } = fakeIngest({})
  const result = await ingest.onMessage(inbound({ messageId: 'om_chat', text: '哈哈哈' }))
  assert.equal(result.kind, 'smalltalk')
  const record = inbox.get('om_chat')
  assert.equal(record.ignored_reason, '寒暄或应答')
  /*
   * "漏单" means a message that produced nothing AND said nothing about why.
   * A recorded reason is precisely the difference between "we decided this is
   * chatter" and "we lost it", so it must NOT show up here — this is the same
   * predicate the Hub's `consumed_by = '[]' AND ignored_reason IS NULL` query had.
   */
  assert.deepEqual(inbox.unconsumed(), [])

  // A message that arrived and was never looked at is the one that counts.
  inbox.record({ message_id: 'om_lost', chat_id: 'oc_1', text: '?', consumed_by: [], ignored_reason: null })
  assert.deepEqual(inbox.unconsumed().map((doc) => doc.message_id), ['om_lost'])
})

test('the inbound log survives a restart and answers who consumed what', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-inbox-'))
  try {
    const first = new Inbox(dir).load()
    first.record({ message_id: 'om_1', chat_id: 'oc_1', text: 'hi', consumed_by: [], ignored_reason: null })
    first.consume('om_1', 'req-2026-001')
    const reloaded = new Inbox(dir).load()
    assert.equal(reloaded.seen('om_1'), true)
    assert.deepEqual(reloaded.get('om_1').consumed_by, ['req-2026-001'])
    assert.deepEqual(reloaded.unconsumed(), [])
    const lines = readFileSync(join(dir, 'inbox', 'messages.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, 'append-only: one line per observation, last one wins')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('looksAddressed only fires on a real mention', () => {
  assert.equal(looksAddressed('@机器人 看看这个'), true)
  assert.equal(looksAddressed('@_user_1 看看这个'), true)
  assert.equal(looksAddressed('发个邮件给 a@b.com'), false)
  assert.equal(looksAddressed('普通一句话'), false)
})

/* ------------------------------------------------------------------ *
 * A ledger wired the way lib/team.js wires it, with the protocol faked
 * ------------------------------------------------------------------ */

function fakeIngest(feishuOverrides) {
  const dir = mkdtempSync(join(tmpdir(), 'team-ingest-'))
  const sent = []
  const requirements = []
  const handlers = {
    calls: [],
    list: () => ({ ok: true, rows: [] }),
    create_requirement(args) {
      handlers.calls.push({ action: 'create_requirement', args })
      /*
       * 替身也要**真的把需求建出来**：否则"去重"永远看不到已有需求，
       * 用例会绿而行为不存在（第一版就是这样）。id 按建单次数递增，
       * 这样"第二条被并进第一条"才测得出是哪一条。
       */
      const id = 'req-2026-' + String(requirements.length + 1).padStart(3, '0')
      requirements.push({ id, title: args.title, state: 'draft', links: { repos: args.repos ?? [] } })
      return { ok: true, id, state: 'draft', title: args.title }
    },
    accept_task(args) {
      handlers.calls.push({ action: 'accept_task', args })
      return { ok: false, code: 'not_assigned_to_you', message: '只有被指派的执行者本人可以确认接受', pending: ['human:known'] }
    },
  }
  const inbox = new Inbox(dir).load()
  /*
   * 替身 store：`get` 给建单后读需求用；`all` 给**去重**用（要比对已有需求）。
   * 以前的替身只有 `get`，于是"去重"这条路径在这个测试里根本走不到 ——
   * 用例会绿，但测的是不存在的行为。
   */
  const store = {
    get: (kind, id) => (kind === 'requirement' ? requirements.find((one) => one.id === id) ?? null : null),
    put: (kind, doc) => {
      if (kind === 'requirement') {
        const at = requirements.findIndex((one) => one.id === doc.id)
        if (at >= 0) requirements[at] = doc
        else requirements.push(doc)
      }
      return doc
    },
    all: (kind) => (kind === 'requirement' ? [...requirements] : []),
    find: () => [],
  }
  const config = {
    dataDir: dir,
    defaultOwner: 'human:owner',
    feishu: { senders: {}, ...feishuOverrides },
  }
  const client = {
    ready: true,
    async send(chatId, payload) {
      sent.push({ chatId, text: payload.content?.text ?? '' })
      return { ok: true, code: 0 }
    },
    async sendThrough() {
      return { ok: false }
    },
  }
  // The real protocol modules are pure; a minimal stand-in keeps this test
  // about the INGEST wiring rather than about triage's own judgement.
  const triage = {
    // 窗口规则用真的那一份：这里测的是"流水线有没有用它"，规则本身在 triage.test.mjs 里测。
    selectContextMessages: realSelectContextMessages,
    DEFAULT_TRIAGE_CONFIG: { reaction: 'Get', require_intent: true, min_substance_chars: 4, intent_words: [], smalltalk_patterns: [], question_patterns: [] },
    triageMessage({ text }) {
      if (/哈哈|呵呵/.test(text)) return { kind: 'smalltalk', reason: '寒暄或应答', cleaned: text, has_intent: false, substantive: true, intent_hits: [] }
      /*
       * 有实质内容、但**没有诉求词**的一类（设计里叫 status）：它们不建单，
       * 只记原因 —— 而"批次窗口"要的正是这种前几句：它们留在收件箱里没被消费，
       * 成为后面那句被 @ 的消息的上下文。
       */
      if (/老是|现在|因为|已经/.test(text)) {
        return { kind: 'status', reason: '没有发现表达诉求的词', cleaned: text, has_intent: false, substantive: true, intent_hits: [] }
      }
      return { kind: 'requirement', reason: '有实质内容且表达诉求', cleaned: text, has_intent: true, substantive: true, intent_hits: ['加'] }
    },
  }
  const extract = {
    /*
     * 去重判据用**真的**那一份：这个文件测的是"流水线有没有调它、并入了没有"，
     * 判据本身的分数在 extract.test.mjs 里测。第一版这里连函数都没有，
     * 于是去重那条路径根本走不到 —— 用例会绿，行为不存在。
     */
    findDuplicate: realFindDuplicate,
    extractRequirement(messages) {
      /*
       * 用**这一批消息**填摘录：批次窗口是这条流水线的行为，替身如果把 messages
       * 丢掉，"一批消息合成一个需求"就没法断言了（第一版正是这样：
       * 用例写过、也绿过，但它测的东西不存在）。
       */
      const usable = Array.isArray(messages) ? messages.filter((one) => String(one.text ?? '') !== '') : []
      return {
        draft: { title: '导出功能', problem: '需要导出', proposal: '', acceptance_criteria: ['能导出 CSV'], priority: 'P2', repos: [], requester: null, excerpts: usable.map((one) => String(one.text)), source_message_ids: [] },
        reason: '规则判定为需求',
        missing: [],
        confidence: 0.8,
      }
    },
  }
  const ingest = createIngest({ config, handlers, client, inbox, store, triage, extract, cards: null, log: { error: () => {} } })
  return { ingest, sent, handlers, inbox, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function inbound(overrides) {
  return {
    chatId: 'oc_aaa',
    chatTitle: '需求群',
    chatType: 'group',
    sessionId: 'feishu-oc_aaa-g1',
    messageId: 'om_x',
    text: '',
    at: new Date().toISOString(),
    sender: null,
    ...overrides,
  }
}

test('a similar request is merged into the existing requirement instead of opening a second card', async () => {
  /*
   * 设计 02 §5.7：相似度识别 → 并入已有需求卡并播报。`findDuplicate` 一直躺在
   * extract.js 里没人调用，于是同一件事说三遍就是三个需求、三张卡问同样的问题。
   */
  const { ingest, handlers, sent, inbox } = fakeIngest({})
  const first = await ingest.onMessage(inbound({ messageId: 'om_1', text: '@机器人 加一个导出功能，要能导出 CSV' }))
  assert.equal(first.kind, 'requirement')

  // 换一条消息、换个说法说同一件事：不该再建一张卡。
  const second = await ingest.onMessage(inbound({ messageId: 'om_2', text: '@机器人 能不能加导出功能，导出 CSV 就行' }))
  assert.equal(second.kind, 'duplicate', JSON.stringify(second))
  assert.equal(typeof second.duplicate_of, 'string')
  assert.equal(handlers.calls.filter((call) => call.action === 'create_requirement').length, 1, '只建了一个需求')
  // 说的人要知道被收到了，而且知道记到哪去了
  const mergedReply = sent.map((one) => String(one.text ?? '')).find((text) => text.includes('同一条'))
  assert.notEqual(mergedReply, undefined, '群里回一句"并入哪一条"')
  assert.match(mergedReply, new RegExp(String(second.duplicate_of)))
  // 审计：这一条被谁收了、相似度多少
  const record = inbox.get('om_2')
  assert.equal(record.duplicate_of, second.duplicate_of)
  assert.equal(typeof record.duplicate_score, 'number')
  assert.deepEqual(record.consumed_by, [second.duplicate_of], '原始消息也算被这个需求消费了')
})

test('consecutive messages from one sender become ONE requirement, not three', async () => {
  /*
   * 设计 02 §2.2.3#2："回看窗口有上限、别人插话即话题边界"。以前只喂 `[message]`，
   * 于是连续三条说同一件事 = 三个需求 —— 需求的颗粒度变成了打字的颗粒度。
   */
  const { ingest, handlers } = fakeIngest({})
  await ingest.onMessage(inbound({ messageId: 'om_a1', text: '支付这块老是超时', sender: 'ou_wang' }))
  await ingest.onMessage(inbound({ messageId: 'om_a2', text: '因为现在失败一次就得人工补', sender: 'ou_wang' }))
  const triggered = await ingest.onMessage(
    inbound({ messageId: 'om_a3', text: '@机器人 能不能自动重试 3 次', sender: 'ou_wang' }),
  )
  assert.equal(triggered.kind, 'requirement', JSON.stringify(triggered))
  const created = handlers.calls.filter((call) => call.action === 'create_requirement')
  assert.equal(created.length, 1, '一批消息只建一个需求')
  const excerpts = created[0].args.excerpts ?? []
  assert.deepEqual(
    excerpts,
    ['支付这块老是超时', '因为现在失败一次就得人工补', '@机器人 能不能自动重试 3 次'],
    '三句话是同一批（前两句是上文，触发的是第三句）',
  )
})

test('the bot asks once for the missing piece, then goes passive in that chat', async () => {
  /*
   * 设计 02 §7.1#3："需求机器人主动追问，默认只追一次，之后转被动"。
   * `decideIngestAsk` 也是零调用点：于是"信息不全"只体现在卡上的一行字，
   * 没有人被问过。这里测的是**真的问出去**、而且**第二次不再问**。
   */
  const { ingest, sent, store } = fakeIngest({})
  // 没被 @、信息很不全的一类（低置信度）—— 移植过来的策略只在这一类上追问。
  const first = await ingest.onMessage(inbound({ messageId: 'om_q1', text: '导出？', sender: 'ou_wang' }))
  const asked = sent.map((one) => String(one.text ?? '')).find((text) => text.includes('怎样算做完') || text.includes('还需要补充'))
  if (first.created === null || asked === undefined) {
    // 这一条没被判成需求：那就不该追问（策略里写明了"还没判定成需求，不追问"）
    assert.equal(asked, undefined)
    return
  }
  assert.notEqual(store.get('chat', 'oc_a').ask, null, '问过一次要记在这个群上（重启后仍然记得）')
  const countAfterFirst = store.get('chat', 'oc_a').ask.count

  const second = await ingest.onMessage(inbound({ messageId: 'om_q2', text: '导出？', sender: 'ou_wang' }))
  assert.equal(second.created === null || second.asked === undefined, true, '第二次不再追问')
  assert.equal(store.get('chat', 'oc_a').ask.count, countAfterFirst, '计数不再增长')
})
