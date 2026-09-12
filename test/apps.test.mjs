/*
 * Feishu apps: one long connection and one identity each, and which bot speaks
 * through which.
 *
 * The point of these tests is the PHYSICAL constraint: two bots on one app_id are
 * one face in the group. Everything here either enforces that or reports it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { appDescriptors, appIdOfBot, appsView, describeApp, unbootableBots } from '../lib/feishu/apps.js'
import { loadConfig } from '../lib/config.js'

/** A resolved config without touching the real config file. */
function makeConfig(row) {
  return loadConfig({ dataDir: '/tmp/dsh-team-apps-test-does-not-exist', ...row })
}

test('a single-app installation gets exactly one connection, with its roster on it', () => {
  const config = makeConfig({
    bots: [{ id: 'req', role: 'req', enabled: true }],
    feishu: { appId: 'cli_one', appSecret: 's1', botOpenId: 'ou_bot' },
  })
  const apps = appDescriptors(config)
  assert.equal(apps.length, 1)
  assert.deepEqual(apps[0].bots, ['req'])
  assert.equal(apps[0].ready, true)
  assert.equal(apps[0].source, 'default')
  assert.equal(apps[0].botOpenId, 'ou_bot', 'the identity of the default app is the one in the config')
})

test('a second app is dialled for the bot that names it, with its own secret', () => {
  const config = makeConfig({
    bots: [
      { id: 'req', role: 'req', enabled: true },
      { id: 'dev', role: 'dev', enabled: true, feishu: { appId: 'cli_two' } },
    ],
    feishu: { appId: 'cli_one', appSecret: 's1', apps: { cli_two: { appSecret: 's2', name: '开发应用' } } },
  })
  const apps = appDescriptors(config)
  assert.deepEqual(apps.map((one) => one.appId).sort(), ['cli_one', 'cli_two'])
  const second = apps.find((one) => one.appId === 'cli_two')
  assert.equal(second.appSecret, 's2')
  assert.equal(second.name, '开发应用')
  assert.equal(second.source, 'apps')
  assert.deepEqual(second.bots, ['dev'])
})

test('a bot naming an app with no secret is NOT silently moved to the default app', () => {
  const config = makeConfig({
    bots: [{ id: 'dev', role: 'dev', enabled: true, feishu: { appId: 'cli_two' } }],
    feishu: { appId: 'cli_one', appSecret: 's1' },
  })
  const apps = appDescriptors(config)
  const second = apps.find((one) => one.appId === 'cli_two')
  assert.equal(second.ready, false)
  assert.equal(second.reason, 'no-secret')
  // Answering as a different identity than the roster says is exactly the kind of
  // invisible wrong this plugin exists to prevent, so it is reported instead.
  const offline = unbootableBots(config)
  assert.deepEqual(offline.map((one) => one.botId), ['dev'])
  assert.match(offline[0].message, /appSecret/)
})

test('a disabled bot is not dialled for, and makes no app', () => {
  const config = makeConfig({
    bots: [{ id: 'dev', role: 'dev', enabled: false, feishu: { appId: 'cli_two' } }],
    feishu: { appId: 'cli_one', appSecret: 's1' },
  })
  assert.deepEqual(appDescriptors(config).map((one) => one.appId), ['cli_one'])
  assert.deepEqual(unbootableBots(config), [], 'a bot that is off is not a problem')
})

test('no app at all: the descriptor list is empty and the bot is unbootable with a reason', () => {
  const config = makeConfig({ bots: [{ id: 'req', role: 'req', enabled: true }], feishu: { mode: 'own' } })
  assert.deepEqual(appDescriptors(config), [])
  const offline = unbootableBots(config)
  assert.equal(offline[0].reason, 'no-app')
  assert.match(offline[0].message, /没有可用的飞书应用/)
})

test('appIdOfBot: the bot\'s own app wins, otherwise the default', () => {
  const config = makeConfig({ feishu: { appId: 'cli_one' } })
  assert.equal(appIdOfBot({ feishu: { appId: 'cli_two' } }, config), 'cli_two')
  assert.equal(appIdOfBot({ feishu: { appId: '' } }, config), 'cli_one')
  assert.equal(appIdOfBot(null, config), 'cli_one')
})

test('appsView never leaks a secret, and says whether one is set', () => {
  const config = makeConfig({
    bots: [{ id: 'req', role: 'req', enabled: true }],
    feishu: { appId: 'cli_one', appSecret: 'top-secret', apps: { cli_two: { appSecret: 'other-secret' } } },
  })
  const view = appsView(config)
  const text = JSON.stringify(view)
  assert.equal(text.includes('top-secret'), false)
  assert.equal(text.includes('other-secret'), false)
  assert.equal(view.find((one) => one.appId === 'cli_one').appSecretSet, true)
  assert.equal(view.find((one) => one.appId === 'cli_two').appSecretSet, true)
  // The fingerprint lets a human tell "same secret" from "retyped", and nothing else.
  assert.match(view[0].secretFingerprint, /^[0-9a-f]{6}$/)
  // An app nobody speaks through is SHOWN (with no bots on it) but not dialled: a
  // configured secret that no bot uses is a typo someone has to see.
  assert.deepEqual(view.find((one) => one.appId === 'cli_two').bots, [])
  assert.equal(appDescriptors(config).length, 1, 'the runtime dials only what the roster speaks through')
  const changed = appsView(makeConfig({ feishu: { appId: 'cli_one', appSecret: 'top-secret-2' } }))
  assert.notEqual(changed[0].secretFingerprint, view.find((one) => one.appId === 'cli_one').secretFingerprint)
})

test('describeApp names the bots that share the app — which is also how a shared face is visible', () => {
  const config = makeConfig({
    bots: [
      { id: 'req', role: 'req', enabled: true },
      { id: 'dev', role: 'dev', enabled: true },
    ],
    feishu: { appId: 'cli_one', appSecret: 's1' },
  })
  assert.match(describeApp(appDescriptors(config)[0]), /cli_one… → req、dev/, 'no app is labelled "default" any more')
})

test('the pool dials one connection per app, tags every event, and isolates failures', async () => {
  const { createConnectionPool } = await import('../lib/feishu/connection.js')
  const config = makeConfig({
    bots: [
      { id: 'req', role: 'req', enabled: true },
      { id: 'dev', role: 'dev', enabled: true, feishu: { appId: 'cli_two' } },
    ],
    feishu: { appId: 'cli_one', appSecret: 's1', apps: { cli_two: { appSecret: 's2' } } },
  })
  const dialled = []
  const events = []
  const pool = await createConnectionPool({
    config,
    descriptors: appDescriptors(config),
    clientFor: (appId) => ({ appId }),
    onEvent: (raw) => events.push(raw),
    log: { log: () => {}, error: () => {} },
    start: async (options) => {
      dialled.push(options.app)
      // The second app fails to start: the first must still come online.
      if (options.app.appId === 'cli_two') return { ready: false, reason: 'boom', dispose: () => {}, describe: () => ({}) }
      await options.onEvent({ message: { chat_id: 'oc_a' }, __appId: options.app.appId })
      return {
        ready: true,
        botOpenId: 'ou_' + options.app.appId,
        appId: options.app.appId,
        dispose: () => {},
        describe: () => ({ ready: true }),
      }
    },
  })
  assert.deepEqual(dialled.map((one) => one.appId).sort(), ['cli_one', 'cli_two'])
  assert.equal(pool.online(), 1, 'a failed app does not stop the others')
  assert.deepEqual(pool.reports().map((one) => one.ready), [true, false])
  assert.equal(pool.botOpenIdFor('cli_one'), 'ou_cli_one')
  // The event carries the app it arrived on: "was I mentioned?" is answered per app.
  assert.equal(events[0].__appId, 'cli_one')
  pool.dispose()
  assert.equal(pool.online(), 0)
})

test('an apps entry for the DEFAULT app must not shadow its own credential', () => {
  /*
   * The console renders one row per app — including the default one — and lets the
   * operator rename it or fill its botOpenId. Those edits land in
   * `feishu.apps[<defaultAppId>]`, i.e. a SECOND place that describes the same app.
   * If that entry's empty credential won, the app would go offline the moment someone
   * typed a display name: the secret would still be in the file and no longer read.
   */
  const config = makeConfig({
    feishu: {
      appId: 'cli_x',
      appSecret: 's1',
      botOpenId: 'ou_default',
      apps: { cli_x: { name: '需求线应用' } },
    },
  })
  const app = appDescriptors(config)[0]
  assert.equal(app.appSecret, 's1', 'the default app keeps its secret')
  assert.equal(app.botOpenId, 'ou_default')
  assert.equal(app.ready, true)
  assert.equal(app.name, '需求线应用', 'and the metadata edit still applies')
  assert.equal(appsView(config).length, 1, 'one app is one row, not two')
})
