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
