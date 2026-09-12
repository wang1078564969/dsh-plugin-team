/*
 * The shipped example config must actually WORK.
 *
 * A sample config is documentation that people copy, and a sample that fails
 * validation — or worse, validates but reads back different from what it says —
 * teaches the wrong shape to every installation that starts from it. So this file
 * loads `config.example.json`, strips the `//` comment keys a human reads, and puts
 * the rest through the same two functions the console uses: the validator and the
 * loader. Then it checks that what came back out says what the example claims.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../lib/config.js'
import { appDescriptors, appsView } from '../lib/feishu/apps.js'
import { validatePatch } from '../lib/settings.js'

const here = dirname(fileURLToPath(import.meta.url))
const examplePath = join(here, '..', 'config.example.json')

/** Drop the `//`-prefixed keys at every level: they are prose, not configuration. */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key.startsWith('//')) continue
    out[key] = stripComments(inner)
  }
  return out
}

test('config.example.json validates cleanly — every key it teaches is a writable key', () => {
  const doc = stripComments(JSON.parse(readFileSync(examplePath, 'utf8')))
  const problems = validatePatch(doc, {
    defaultAppId: doc.feishu.appId,
    knownPresets: [],
    appsWithSecret: [doc.feishu.appId],
  })
  assert.deepEqual(problems, [], 'the example must not teach a key the console refuses')
})

test('config.example.json reads back as what it says: a roster, a member table and the derived domain map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-example-'))
  try {
    const doc = stripComments(JSON.parse(readFileSync(examplePath, 'utf8')))
    // The example carries a placeholder dataDir; the loader must be pointed at a
    // temporary one so this test cannot read (or write) a real installation.
    doc.dataDir = dir
    writeFileSync(join(dir, 'config.json'), JSON.stringify(doc, null, 2), 'utf8')
    const config = loadConfig({ dataDir: dir })

    assert.equal(config.bots.length, 2)
    assert.deepEqual(config.bots.map((one) => one.id), ['req', 'dev'])
    assert.equal(config.bots[0].enabled, true)
    assert.equal(config.bots[1].enabled, false, 'the example enables one bot, not the whole roster')
    assert.deepEqual(config.bots[1].feishu.chats, ['oc_your_dev_group'])
    assert.equal(config.bots[1].agentPreset, 'standard')
    assert.equal(config.bots[1].budget.maxConcurrentTasks, 2)

    assert.equal(config.memberList.length, 2)
    assert.deepEqual(config.memberList[0].domains, ['pm', 'requirement'])
    assert.deepEqual(config.memberList[0].canApprove, ['merge', 'config'])
    assert.equal(config.memberList[1].openId, '')

    // The map the ledger reads is derived from the rows AND the explicit block; the
    // union is what makes the example honest about both shapes.
    assert.deepEqual(config.members.development, ['human:zhouyu'])
    assert.deepEqual(config.members.pm, ['human:wangmengfan'])

    // Two apps are described: the default one and the second identity.
    const apps = appsView(config)
    assert.deepEqual(apps.map((one) => one.appId).sort(), ['cli_example0000000000', 'cli_your_app_id'])
    assert.equal(apps.find((one) => one.appId === 'cli_your_app_id').appSecretSet, false, 'the example carries no secrets')
    // Only the default app is dialled: no enabled bot names the second one.
    assert.deepEqual(appDescriptors(config).map((one) => one.appId), ['cli_your_app_id'])
    assert.equal(config.feishu.speakLeaseMs, 90000)
    assert.equal(config.feishu.requireMention, true)
    assert.equal(config.feishu.buttons, false)
    // `chatIds` 已被删除（插件从来没读过它），所以样例里只剩一行说明，读出来是空数组。
    assert.deepEqual(config.feishu.chatIds, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
