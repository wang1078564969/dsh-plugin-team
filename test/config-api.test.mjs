/*
 * The configuration route, end to end through its Fetch handler.
 *
 * The host half's rules are tested in settings.test.mjs; what is tested here is
 * the boundary the panel actually talks to: what a GET reveals, what a POST
 * refuses, and that a refused POST changes nothing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { createConfigApi } from '../lib/api.js'
import { loadConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'

function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-cfgapi-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify(
      {
        '//': '手写注释',
        defaultOwner: 'human:wangmengfan',
        workspace: join(dir, 'ws'),
        feishu: { mode: 'own', appId: 'cli_x', appSecret: 'top-secret', accessToken: 'ignored' },
      },
      null,
      2,
    ),
    'utf8',
  )
  const config = loadConfig({ dataDir: dir })
  const store = new Store(dir).load()
  let reloads = 0
  let restarts = 0
  /** What the roster computed for a bot, for the tests that need a live-ish view. */
  const appReports = []
  const api = createConfigApi({
    config,
    store,
    inbox: { all: () => [] },
    client: () => null, // no live client: diagnostics must still answer
    credentials: () => ({ ready: true, source: 'team-config', appId: 'cli_xxxxxxxx' }),
    connection: () => null,
    appReports: () => appReports,
    reload: () => {
      reloads += 1
      Object.assign(config, loadConfig({ dataDir: dir }))
      return config
    },
    // The console calls this after a credential/mode/roster change so "saved"
    // means "in effect"; the roster decides which apps are dialled at all.
    restartFeishu: async () => {
      restarts += 1
      return { mode: 'own', connected: false, apps: [] }
    },
  })
  return {
    dir,
    configFile,
    config,
    store,
    api,
    reloads: () => reloads,
    restarts: () => restarts,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const get = (api) => api.handler(new Request('http://gui.local' + api.path, { method: 'GET' }))
const post = (api, body) =>
  api.handler(
    new Request('http://gui.local' + api.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

test('GET returns the config, a clean bill of health, and a live self-check', async () => {
  const world = makeWorld()
  try {
    const body = await (await get(world.api)).json()
    assert.equal(body.ok, true)
    assert.equal(body.config.feishu.appSecretSet, true)
    assert.equal(JSON.stringify(body).includes('top-secret'), false, 'the secret is never readable')
    assert.deepEqual(body.problems, [], 'a healthy config reports no problems')

    // The self-check answers even with no client: "no client" IS the finding.
    assert.equal(body.diagnostics.credentials.ok, true)
    assert.deepEqual(body.diagnostics.identity.ok, false)
    assert.match(body.diagnostics.identity.message, /凭据|客户端/)
    assert.equal(body.diagnostics.connection.ready, false)
    assert.equal(body.diagnostics.mode, 'own')
    assert.ok(body.editable.includes('feishu.appSecret'))
    assert.ok(body.editable.includes('members'))
  } finally {
    world.cleanup()
  }
})

test('POST refuses without an actor, and a refusal changes nothing on disk', async () => {
  const world = makeWorld()
  try {
    const before = readFileSync(world.configFile, 'utf8')

    const noActor = await (await post(world.api, { patch: { tickIntervalMs: 0 } })).json()
    assert.equal(noActor.ok, false)
    assert.match(noActor.message, /actor/)

    const invalid = await (await post(world.api, { patch: { gates: { accept: { timeout: 'soon' } } }, actor: 'human:x' })).json()
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'invalid_config')
    assert.deepEqual(
      invalid.problems.map((p) => p.path),
      ['gates.accept.timeout'],
    )
    assert.equal(typeof invalid.config, 'object', 'the panel gets the untouched config back, so the form survives')

    assert.equal(readFileSync(world.configFile, 'utf8'), before, 'not one byte written')
    assert.equal(world.reloads(), 0)
  } finally {
    world.cleanup()
  }
})

test('POST applies a valid patch, reloads the live config, and reports what changed', async () => {
  const world = makeWorld()
  try {
    const response = await (
      await post(world.api, {
        patch: { domains: { development: ['human:zhouyu'] }, feishu: { requireMention: false } },
        actor: 'human:wangmengfan',
      })
    ).json()
    assert.equal(response.ok, true, JSON.stringify(response.problems ?? []))
    assert.deepEqual(response.applied, ['domains', 'feishu'])
    assert.equal(world.reloads(), 1, 'the running plugin re-read the file')
    assert.equal(response.config.domains.development[0], 'human:zhouyu')
    assert.equal(response.config.feishu.requireMention, false)

    const doc = JSON.parse(readFileSync(world.configFile, 'utf8'))
    assert.equal(doc['//'], '手写注释', 'the keys the console does not know survive')
    assert.equal(doc.feishu.appSecret, 'top-secret', 'an absent secret in the patch is not an erase')
    assert.equal(doc.feishu.accessToken, 'ignored', 'and neither is an unknown feishu key')
    assert.equal(typeof response.backup, 'string')
  } finally {
    world.cleanup()
  }
})

test('a missing patch and a wrong method are refusals, not crashes', async () => {
  const world = makeWorld()
  try {
    const noPatch = await (await post(world.api, { actor: 'human:x' })).json()
    assert.equal(noPatch.ok, false)
    assert.equal(noPatch.code, 'bad_request')
    const wrongMethod = await world.api.handler(new Request('http://gui.local' + world.api.path, { method: 'DELETE' }))
    assert.equal(wrongMethod.status, 405)
    const malformed = await world.api.handler(new Request('http://gui.local' + world.api.path, { method: 'POST', body: '{nope' }))
    assert.equal(malformed.status, 500)
    assert.equal((await malformed.json()).code, 'api_failed')
  } finally {
    world.cleanup()
  }
})

test('GET hands the console the roster, the member table and the bot conversations', async () => {
  const world = makeWorld()
  try {
    // A roster and a member row written by hand, the way a first installation looks.
    writeFileSync(
      world.configFile,
      JSON.stringify({
        defaultOwner: 'human:wangmengfan',
        workspace: world.dir,
        bots: [
          { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
          { id: 'ghost', displayName: '幽灵机器人', role: 'custom', enabled: true, feishu: { appId: 'cli_nope' } },
        ],
        members: [
          { key: 'human:wangmengfan', name: '王梦凡', domains: ['pm'] },
          { key: 'human:zhouyu', name: '周宇', domains: ['development'] },
        ],
        feishu: { mode: 'own', appId: 'cli_x', appSecret: 'top-secret', senders: { ou_known: 'human:wangmengfan', ou_stale: 'human:gone' } },
      }),
      'utf8',
    )
    Object.assign(world.config, loadConfig({ dataDir: world.dir }))
    world.store.put('botsession', { id: 'req.oc_a', bot_id: 'req', chat_id: 'oc_a', session_id: 'team-bot-req-oc_a', turns: 2 })
    world.store.put('chat', { id: 'oc_a', title: '需求群', chat_type: 'group' })

    const body = await (await get(world.api)).json()
    assert.equal(body.ok, true)
    assert.equal(JSON.stringify(body).includes('top-secret'), false, 'the roster view never carries a secret')

    // Per-row problems, so "which bot is misconfigured" does not mean counting paths.
    const ghost = body.roster.bots.find((one) => one.id === 'ghost')
    assert.equal(ghost.appIdResolved, 'cli_nope')
    assert.equal(ghost.problems.some((one) => one.field === 'feishu.appId' && one.level === 'error'), true)
    const req = body.roster.bots.find((one) => one.id === 'req')
    assert.deepEqual(req.problems, [], 'a bot on the configured default app is fine')
    assert.equal(req.appIdResolved, 'cli_x')
    assert.equal(req.sessions.length, 1)
    assert.equal(req.sessions[0].sessionId, 'team-bot-req-oc_a')
    assert.equal(req.sessions[0].title, '需求群')

    // The member table AND the derived domain map, under their own names.
    assert.equal(body.config.members.length, 2)
    assert.equal(body.config.members[0].role, 'member')
    assert.deepEqual(body.config.domains.pm, ['human:wangmengfan'])
    assert.deepEqual(body.config.domains.development, ['human:zhouyu'])
    /*
     * An open_id the config already maps in `feishu.senders` fills the row: the
     * operator typed that mapping once, and asking for it twice is how the two
     * copies drift apart.
     */
    assert.equal(body.config.members[0].openId, 'ou_known')
    assert.equal(body.roster.members[0].problems.some((one) => one.field === 'openId'), false)
    // The one with no mapping anywhere is told what that costs.
    assert.equal(body.roster.members[1].problems.some((one) => one.field === 'openId'), true)

    // A sender mapping whose principal is not a member is REPORTED, not pruned.
    assert.deepEqual(body.roster.senders.unbound.map((one) => one.openId), ['ou_stale'])

    // The app view: which app, whether a secret is set, who speaks through it.
    assert.equal(body.roster.apps.find((one) => one.appId === 'cli_x').appSecretSet, true)
    assert.equal(body.roster.apps.find((one) => one.appId === 'cli_x').bots.includes('req'), true)

    // One flat list for the 会话 page.
    assert.equal(body.sessions.length, 1)
    assert.equal(body.sessions[0].botId, 'req')

    for (const key of ['bots', 'domains', 'feishu.speakLeaseMs', 'feishu.apps']) {
      assert.ok(body.editable.includes(key), 'editable must offer ' + key)
    }
  } finally {
    world.cleanup()
  }
})

test('POST refuses a broken roster with the row that is wrong, and writes nothing', async () => {
  const world = makeWorld()
  try {
    const before = readFileSync(world.configFile, 'utf8')
    const response = await (
      await post(world.api, {
        patch: {
          bots: [
            { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
            { id: 'req', displayName: '重复的', role: 'dev', enabled: true },
          ],
        },
        actor: 'human:x',
      })
    ).json()
    assert.equal(response.ok, false)
    assert.equal(response.code, 'invalid_config')
    // Both rows are flagged: each one is a duplicate of the other, and an operator
    // looking at either row should be told.
    assert.ok(response.problems.some((one) => one.path === 'bots[1].id'))
    assert.ok(response.problems.every((one) => one.path.startsWith('bots[')))
    assert.equal(readFileSync(world.configFile, 'utf8'), before, 'not one byte written')
    assert.equal(world.reloads(), 0)
    assert.equal(world.restarts(), 0, 'and the connection was not touched')
  } finally {
    world.cleanup()
  }
})

test('POST of a good roster reloads, re-dials the apps, and returns the new snapshot', async () => {
  const world = makeWorld()
  try {
    const response = await (
      await post(world.api, {
        patch: { bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }] },
        actor: 'human:wangmengfan',
      })
    ).json()
    assert.equal(response.ok, true, JSON.stringify(response.problems ?? []))
    assert.equal(world.reloads(), 1)
    // The roster decides WHICH APPS get dialled, so a roster change must reach the
    // running connection: "saved" that means "next restart" is the console people
    // stop trusting.
    assert.equal(world.restarts(), 1)
    assert.equal(response.roster.bots.length, 1)
    assert.equal(response.roster.bots[0].id, 'req')
    assert.equal(response.config.bots[0].displayName, '需求机器人')
  } finally {
    world.cleanup()
  }
})

test('the member table and the domain map are both writable, and one save can carry both', async () => {
  const world = makeWorld()
  try {
    const response = await (
      await post(world.api, {
        patch: {
          members: [{ key: 'human:wangmengfan', name: '王梦凡', openId: 'ou_wang', domains: ['pm', 'requirement'] }],
          domains: { development: ['human:zhouyu'] },
        },
        actor: 'human:wangmengfan',
      })
    ).json()
    assert.equal(response.ok, true, JSON.stringify(response.problems ?? []))
    assert.equal(response.config.members.length, 1)
    assert.deepEqual(response.config.members[0].domains, ['pm', 'requirement'])
    assert.deepEqual(response.config.domains.development, ['human:zhouyu'])
    assert.deepEqual(response.config.domains.pm, ['human:wangmengfan'], 'the row contributes its own domains')
    // The open_id typed on the row became the mapping that attributes button presses.
    assert.equal(response.config.senders.ou_wang, 'human:wangmengfan')
    assert.deepEqual(response.derived.sendersAdded.map((one) => one.principal), ['human:wangmengfan'])
  } finally {
    world.cleanup()
  }
})

test('a roster patch does NOT re-dial when only the member table changed', async () => {
  const world = makeWorld()
  try {
    await (await post(world.api, { patch: { members: [{ key: 'human:a', name: '甲' }] }, actor: 'human:x' })).json()
    assert.equal(world.reloads(), 1)
    assert.equal(world.restarts(), 0, 'members do not decide which app is dialled')
  } finally {
    world.cleanup()
  }
})
