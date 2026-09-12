/*
 * The bot roster: normalization, routing and the problems a human must fix.
 *
 * WHY THIS FILE IS LONGER THAN THE CODE IT TESTS. The roster is the object that
 * decides who answers a person in a real group, and every default in it is a
 * decision someone will disagree with. Pinning them here is how "the bot ignored
 * me" gets an answer that does not depend on reading the source.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addressesBot,
  BOT_ROLES,
  findBot,
  sessionRoleView,
  botProblems,
  defaultBots,
  describeBot,
  normalizeBot,
  orderedBots,
  resolveBots,
  routeBots,
} from '../lib/bots.js'

test('a raw bot is folded into the canonical shape, with every field defaulted', () => {
  const bot = normalizeBot({ id: 'dev-pay', displayName: '支付开发', role: 'dev' })
  assert.equal(bot.id, 'dev-pay')
  assert.equal(bot.displayName, '支付开发')
  assert.equal(bot.role, 'dev')
  // A bot with no base role inherits its own: "dev" that is not based on dev is a
  // contradiction nobody types on purpose.
  assert.equal(bot.baseRole, 'dev')
  assert.equal(bot.agentPreset, null)
  assert.deepEqual(bot.feishu.chats, [])
  assert.equal(bot.feishu.appId, '')
  assert.deepEqual(bot.feishu.speakPolicy, { onMention: true, onIntent: false, leaseRequired: true, digestOnly: false })
  assert.deepEqual(bot.scope, { projects: [], repos: [], docs: [], memoryScopes: [] })
  assert.equal(bot.budget.maxConcurrentTasks, 1)
  assert.equal(bot.budget.onExceed, 'pause')
  assert.equal(bot.knowledgePack, null)
  // DISABLED BY DEFAULT: a roster that forgets `enabled` must not start answering
  // in a real group.
  assert.equal(bot.enabled, false)
})

test('the design\'s snake_case bot.yaml fields land on the same fields', () => {
  const bot = normalizeBot({
    id: 'qa',
    display_name: '测试机器人',
    base_role: 'qa',
    agent_preset: 'reviewer',
    knowledge_pack: 'pay-kb',
    feishu: { app_id: 'cli_other', chat_ids: ['oc_a', 'oc_b'], speak_policy: { on_mention: false, on_intent: true, lease_required: false, digest_only: true } },
  })
  assert.equal(bot.displayName, '测试机器人')
  assert.equal(bot.baseRole, 'qa')
  assert.equal(bot.agentPreset, 'reviewer')
  assert.equal(bot.knowledgePack, 'pay-kb')
  assert.equal(bot.feishu.appId, 'cli_other')
  assert.deepEqual(bot.feishu.chats, ['oc_a', 'oc_b'])
  assert.deepEqual(bot.feishu.speakPolicy, { onMention: false, onIntent: true, leaseRequired: false, digestOnly: true })
})

test('a malformed bot never throws: it becomes a row with an empty id that reports itself', () => {
  const bot = normalizeBot(null)
  assert.equal(bot.id, '')
  assert.equal(bot.displayName, '')
  const problems = botProblems(bot, { bots: [bot] })
  assert.equal(problems.some((one) => one.field === 'id' && one.level === 'error'), true)
})

test('the shipped roster is the six standing roles, and only intake is on', () => {
  const bots = defaultBots()
  assert.deepEqual(bots.map((one) => one.id), ['req', 'dev', 'qa', 'coord', 'lib', 'ops'])
  assert.deepEqual(bots.filter((one) => one.enabled).map((one) => one.id), ['req'])
  // Intake watches the intent word list: it is the one role whose job is to notice
  // a request that was not aimed at it.
  assert.equal(bots[0].feishu.speakPolicy.onIntent, true)
})

test('resolveBots: an empty array means NO roster, an absent one means the defaults', () => {
  assert.deepEqual(resolveBots([]), [], 'bots: [] is the documented switch for single-assistant mode')
  assert.equal(resolveBots(undefined).length, 6, 'not configured yet → the standing roles')
  // A map keyed by id is a shape a human writes by hand.
  const mapped = resolveBots({ dev: { displayName: '开发', role: 'dev' } })
  assert.deepEqual(mapped.map((one) => one.id), ['dev'])
  assert.equal(mapped[0].displayName, '开发')
})

test('orderedBots: coord first, then intake, and custom never wins a tie', () => {
  const bots = resolveBots([
    { id: 'zz', role: 'custom', enabled: true },
    { id: 'dev', role: 'dev', enabled: true },
    { id: 'req', role: 'req', enabled: true },
    { id: 'coord', role: 'coord', enabled: true },
  ])
  assert.deepEqual(orderedBots(bots).map((one) => one.id), ['coord', 'req', 'dev', 'zz'])
})

test('routeBots: a chat keeps the bot it has been talking to', () => {
  const bots = resolveBots([
    { id: 'req', role: 'req', displayName: '需求机器人', enabled: true },
    { id: 'dev', role: 'dev', displayName: '开发机器人', enabled: true },
  ])
  // Without a binding the priority decides: intake outranks development.
  assert.deepEqual(routeBots({ bots, chatId: 'oc_a' }).map((one) => one.id), ['req', 'dev'])
  // With one, the group keeps the personality people have been talking to.
  assert.deepEqual(routeBots({ bots, chatId: 'oc_a', boundBotId: 'dev' }).map((one) => one.id), ['dev', 'req'])
  // …unless someone names the other one: an explicit address outranks the binding,
  // or a group served by several bots could never reach the second one.
  assert.deepEqual(
    routeBots({ bots, chatId: 'oc_a', boundBotId: 'dev', text: '@需求机器人 这个需求看下' }).map((one) => one.id),
    ['req', 'dev'],
  )
  // A disabled bot is not a candidate at all, and its binding is ignored.
  const off = resolveBots([{ id: 'dev', role: 'dev', displayName: '开发机器人', enabled: false }])
  assert.deepEqual(routeBots({ bots: off, chatId: 'oc_a', boundBotId: 'dev' }), [])
})

test('routeBots: naming a bot outranks the default, and the app is a real filter', () => {
  const bots = resolveBots([
    { id: 'req', role: 'req', displayName: '需求机器人', enabled: true },
    { id: 'dev', role: 'dev', displayName: '开发机器人', enabled: true, feishu: { appId: 'cli_second' } },
  ])
  const named = routeBots({ bots, chatId: 'oc_a', text: '@开发机器人 看下这个' })
  assert.equal(named[0].id, 'dev', 'an explicit address outranks the priority order')

  // The second app is a different identity: an event that arrived on the default
  // app cannot be its, and the app-less bot belongs to the DEFAULT app (not to
  // whichever app the event happened to arrive on).
  const onDefault = routeBots({ bots, chatId: 'oc_a', appId: 'cli_default', defaultAppId: 'cli_default' })
  assert.deepEqual(onDefault.map((one) => one.id), ['req'])
  const onSecond = routeBots({ bots, chatId: 'oc_a', appId: 'cli_second', defaultAppId: 'cli_default' })
  assert.deepEqual(onSecond.map((one) => one.id), ['dev'])
})

test('routeBots: an empty chats list means every chat, a list means exactly those', () => {
  const bots = resolveBots([
    { id: 'dev', role: 'dev', displayName: '开发机器人', enabled: true, feishu: { chats: ['oc_pay'] } },
  ])
  assert.deepEqual(routeBots({ bots, chatId: 'oc_pay' }).map((one) => one.id), ['dev'])
  assert.deepEqual(routeBots({ bots, chatId: 'oc_other' }), [], 'a bound bot does not serve other groups')
})

test('addressesBot is literal: the display name or the id, never a guess', () => {
  const bot = normalizeBot({ id: 'dev', displayName: '开发机器人', role: 'dev' })
  assert.equal(addressesBot('@开发机器人 帮我看看', bot), true)
  assert.equal(addressesBot('dev 在吗', bot), true)
  assert.equal(addressesBot('开发在吗', bot), false, 'no fuzzy matching: "it decided you meant it" is how a bot interrupts')
})

test('botProblems names the mistakes an operator actually makes', () => {
  const bots = resolveBots([
    { id: 'req', role: 'req', displayName: '需求机器人', enabled: true },
    { id: 'req', role: 'require', displayName: '   ', enabled: true },
  ])
  const problems = botProblems(bots[1], { bots, defaultAppId: '' })
  const fields = problems.map((one) => one.field)
  assert.ok(fields.includes('id'), 'a duplicate id is an error: two rows cannot share one identity')
  assert.ok(fields.includes('role'), 'and so is a role nobody defined (' + BOT_ROLES.join('/') + ')')
  assert.ok(fields.includes('displayName'), 'a whitespace-only name cannot be @-mentioned')
  assert.ok(fields.includes('feishu.appId'), 'enabled with no app anywhere is an error, not a warning')
  // And the other half of that rule: a roster entry that names no display name at
  // all is fine — it falls back to the id, which IS mentionable.
  const named = normalizeBot({ id: 'dev', role: 'dev' })
  assert.equal(named.displayName, 'dev')
  assert.equal(botProblems(named, { bots: [named], defaultAppId: 'cli_x' }).some((one) => one.field === 'displayName'), false)
})

test('botProblems: two enabled bots on one app with no mention rule is the likely misconfiguration', () => {
  const bots = resolveBots([
    { id: 'req', role: 'req', displayName: '需求机器人', enabled: true, feishu: { speakPolicy: { onMention: false } } },
    { id: 'dev', role: 'dev', displayName: '开发机器人', enabled: true, feishu: { speakPolicy: { onMention: false } } },
  ])
  const problems = botProblems(bots[1], { bots, defaultAppId: 'cli_only' })
  assert.equal(
    problems.some((one) => one.level === 'warn' && /各答一遍/.test(one.message)),
    true,
  )
})

test('botProblems: using the default app is fine, and only called out as shared identity', () => {
  const alone = resolveBots([{ id: 'req', role: 'req', displayName: '需求机器人', enabled: true }])
  assert.deepEqual(botProblems(alone[0], { bots: alone, defaultAppId: 'cli_only' }), [])

  const pair = resolveBots([
    { id: 'req', role: 'req', displayName: '需求机器人', enabled: true },
    { id: 'dev', role: 'dev', displayName: '开发机器人', enabled: true, feishu: { chats: ['oc_a'] } },
  ])
  const warned = botProblems(pair[0], { bots: pair, defaultAppId: 'cli_only' })
  assert.equal(warned.some((one) => /同一张脸/.test(one.message)), true)
})

test('describeBot says which app and which chats, for the log and the list', () => {
  const bot = normalizeBot({ id: 'dev', displayName: '开发机器人', role: 'dev', feishu: { appId: 'cli_2', chats: ['oc_a'] } })
  const line = describeBot(bot)
  assert.match(line, /开发机器人（dev · 开发 · cli_2 · 1 个群）/)
})

test('findBot resolves a `bot:<id>` principal to the roster row', () => {
  const bots = resolveBots([
    { id: 'dev-pay', displayName: '支付开发', role: 'dev', agentPreset: 'coder' },
    { id: 'dev', displayName: '开发机器人', role: 'dev' },
  ])
  assert.equal(findBot(bots, 'bot:dev-pay').displayName, '支付开发')
  assert.equal(findBot(bots, 'dev').id, 'dev', 'the bare id works too')
  assert.equal(findBot(bots, 'bot:ghost'), null, 'an id nobody declared is not an error, it is a fallback')
  assert.equal(findBot([], 'bot:dev'), null)
})

test('sessionRoleView says WHO supplies each role\'s preset, and where it came from', () => {
  const config = {
    bots: resolveBots([
      { id: 'req', displayName: '需求机器人', role: 'req', agentPreset: 'intake' },
      { id: 'dev', displayName: '开发机器人', role: 'dev' },
      { id: 'dev2', displayName: '开发二号', role: 'dev', agentPreset: 'coder-2' },
    ]),
    sessions: { preset: 'global-default', presets: { dev: 'legacy-dev', ops: 'legacy-ops' } },
  }
  const view = sessionRoleView(config)
  const byRole = new Map(view.map((one) => [one.role, one]))

  // The bot wins, and the source says so.
  assert.deepEqual(
    { preset: byRole.get('req').preset, source: byRole.get('req').source, bot: byRole.get('req').botId },
    { preset: 'intake', source: 'bot', bot: 'req' },
  )
  // ONE row per role, and it is the bot that routing would pick first.
  assert.equal(view.filter((one) => one.role === 'dev').length, 1)
  assert.equal(byRole.get('dev').preset, 'legacy-dev', 'a bot with no preset of its own falls back to the role map')
  assert.equal(byRole.get('dev').source, 'sessions.presets')
  assert.equal(byRole.get('dev').botId, 'dev', 'the first dev bot by roster order owns the role row')
  // A role that exists ONLY as a mapping is shown, not hidden: it is a stale knob.
  assert.equal(byRole.get('ops').botId, null)
  assert.equal(byRole.get('ops').preset, 'legacy-ops')
  assert.equal(byRole.get('ops').source, 'sessions.presets')
  // A role with neither bot nor mapping still gets a row, saying so.
  assert.equal(byRole.get('qa'), undefined, 'no bot and no mapping means no row to draw')

  // With nothing configured the resolution is honest about it.
  const bare = sessionRoleView({ bots: resolveBots([{ id: 'qa', role: 'qa' }]), sessions: {} })
  assert.deepEqual(bare.map((one) => [one.role, one.preset, one.source]), [['qa', null, 'none']])
})
