/*
 * The wiring in lib/team.js, exercised for real: `apply()` is called and what it
 * published is inspected.
 *
 * WHY THIS IS WORTH A TEST. `team.js` is the one file a typo takes the whole
 * feature down with — and it is loaded through the entry's dynamic import, so a
 * mistake there shows up as a log line at activation, not as a failing import in
 * CI. Everything else in this suite tests a module in isolation; this one asks the
 * assembled thing to come up, with `feishu.mode: 'off'` so it touches no network
 * (no credentials, no long connection, no group).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

/** A context with just enough surface: tools, effects, and the optional services. */
function fakeCtx() {
  const tools = []
  const effects = []
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on: () => () => {},
    // No `agents`, no `timer`, no `connection`: every optional service is absent,
    // which is the state a headless profile is in — and activation must survive it.
    get: () => undefined,
    tools2: tools,
    registered: tools,
    effects,
  }
  return ctx
}

test('apply() comes up with no optional service present, and publishes both routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-wiring-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [
        { id: 'req', displayName: '需求机器人', role: 'req', enabled: true, feishu: { speakPolicy: { onIntent: true } } },
        { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, agentPreset: 'standard', feishu: { chats: ['oc_dev'] } },
      ],
      members: [{ key: 'human:wangmengfan', name: '王梦凡', domains: ['pm', 'requirement'], role: 'owner' }],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's', speakLeaseMs: 45000 },
    })

    // The two routes the browser half needs, published for the entry to mount.
    assert.equal(team.api.path, '/api/team/ledger')
    assert.equal(team.configApi.path, '/api/team/config')
    // The model-facing tool, registered through ctx.effect so unloading takes it.
    assert.equal(ctx.registered.length, 1)
    assert.equal(typeof ctx.registered[0].name === 'string' || typeof ctx.registered[0].tool?.name === 'string', true)

    const snapshot = await team.configApi.snapshot()
    assert.equal(snapshot.ok, true)
    assert.deepEqual(
      snapshot.roster.bots.map((one) => one.id),
      ['req', 'dev'],
    )
    assert.equal(snapshot.roster.bots[0].enabled, true)
    // The default app carries the secret, so both bots resolve to it and neither
    // has a problem it should not have.
    assert.equal(snapshot.roster.bots[0].appIdResolved, 'cli_x')
    /*
     * Two enabled bots on ONE app is the honest state of a single-app installation:
     * they are the same face in Feishu, and the console says so per row. What must
     * NOT appear is an error — a warning is advice, an error blocks a save.
     */
    assert.deepEqual(snapshot.roster.bots[0].problems.map((one) => one.level), ['warn'])
    assert.match(snapshot.roster.bots[0].problems[0].message, /同一张脸/)
    assert.equal(snapshot.problems.every((one) => one.message !== ''), true)
    assert.deepEqual(snapshot.problems, [], 'warnings do not block a save, so the 配置 page shows a clean list')
    assert.equal(snapshot.config.feishu.speakLeaseMs, 45000)
    // Owners come from the member table, through the derived domain map.
    assert.deepEqual(snapshot.config.domains.pm, ['human:wangmengfan'])
    assert.equal(snapshot.roster.members.length, 1)
    // No bot conversations yet, and that is a state the console must render.
    assert.deepEqual(snapshot.sessions, [])

    // Feishu is off, so no connection was attempted and the mode says so.
    assert.equal(snapshot.diagnostics.mode, 'off')
  } finally {
    for (const disposer of ctx.effects) {
      if (typeof disposer === 'function') disposer()
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply() with a broken roster still comes up: the ledger must outlive a bad row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-wiring-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      // Two rows with the same id, one with a role nobody defined: the config is
      // wrong, and the plugin still has to load — a collaboration layer that refuses
      // to start over a typo is worse than one that starts and says what is wrong.
      bots: [
        { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
        { id: 'req', displayName: '另一个', role: 'nonsense', enabled: true },
      ],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    const snapshot = await team.configApi.snapshot()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.roster.bots.length, 2)
    // The problems are per row, which is what the 机器人 page renders.
    assert.equal(snapshot.roster.bots[0].problems.some((one) => one.field === 'id'), true)
    assert.equal(snapshot.roster.bots[1].problems.some((one) => one.field === 'role'), true)
    assert.equal(snapshot.problems.length > 0, true, 'and the flat list the 配置 page shows agrees')
  } finally {
    for (const disposer of ctx.effects) {
      if (typeof disposer === 'function') disposer()
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every message in a group is recorded under that group\'s primary bot', async () => {
  /*
   * 用户的要求：**每个群有一个主的机器人，主机器人负责这个群所有消息的记录**。
   *
   * 只有在真实入站路径上验过才算数，所以这里喂伪造的飞书事件，走
   * `handleInbound` → 群记录 → 定主 → 记消息。故意用**没人回答**的闲聊：
   * 记录照样发生，而 `turns` 不动 —— "记录"与"回答"必须分得开。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-primary-wiring-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [
        { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
        { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true },
      ],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    const controller = ctx.teamFeishu
    assert.notEqual(controller, undefined, 'the controller is reachable for testing')
    const store = controller.store

    let seq = 0
    const event = (text) => {
      seq += 1
      return {
        __appId: 'cli_x',
        sender: { sender_id: { open_id: 'ou_someone' }, sender_type: 'user' },
        message: {
          chat_id: 'oc_a',
          chat_type: 'group',
          message_id: 'om_' + String(seq),
          message_type: 'text',
          content: JSON.stringify({ text }),
          create_time: String(Date.now()),
        },
      }
    }

    // 第一条：闲聊、没人回答 —— 群记录照样发生，主按角色优先级定下来。
    await controller.handleInbound(event('今天天气不错'))
    const chat = store.get('chat', 'oc_a')
    assert.equal(chat.primary_bot_id, 'req', '首次接触就定主（不是"谁回答谁是"）')
    assert.equal(chat.messages, 1)
    assert.equal(typeof chat.primary_since, 'string')
    assert.equal(store.get('botsession', 'req.oc_a').seen, 1, '记在主机器人名下')
    assert.equal(store.get('botsession', 'req.oc_a').turns, 0, '它没有回答，轮次是 0')

    // 第二条：仍然没人回答，仍然记在同一个主名下。
    await controller.handleInbound(event('那明天呢'))
    assert.equal(store.get('chat', 'oc_a').messages, 2)
    assert.equal(store.get('botsession', 'req.oc_a').seen, 2)
    assert.equal(store.get('botsession', 'req.oc_a').turns, 0)

    // 显式换主之后，新的消息记在新主名下；旧的那段记录不被改写。
    store.put('chat', { ...store.get('chat', 'oc_a'), primary_bot_id: 'dev', primary_since: new Date().toISOString() })
    await controller.handleInbound(event('开发看一下'))
    assert.equal(store.get('chat', 'oc_a').primary_bot_id, 'dev')
    assert.equal(store.get('chat', 'oc_a').messages, 3)
    assert.equal(store.get('botsession', 'dev.oc_a').seen, 1, '新主从这个群的下一条开始记')
    assert.equal(store.get('botsession', 'req.oc_a').seen, 2, '旧主的那段记录还在')
  } finally {
    for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    rmSync(dir, { recursive: true, force: true })
  }
})
