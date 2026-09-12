/*
 * The configuration console's host half.
 *
 * Two failures drive every test here, and both are the kind a console exists to
 * prevent:
 *
 *   - a value that SAVES but is never read (the panel's `senders` sitting at the
 *     top level while the loader looks under `feishu` — the save reports success
 *     and nothing changes);
 *   - a value that is WRONG but accepted (a typo'd `on_timeout` that never fires,
 *     a principal that will never match a gate).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { KNOWN_DOMAINS, mergePatch, readConfigDoc, redact, saveConfig, validatePatch } from '../lib/settings.js'

function makeWorld(doc = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-settings-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(configFile, JSON.stringify(doc, null, 2), 'utf8')
  return {
    dir,
    configFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('the validator names the exact path of every mistake it can catch', () => {
  const problems = validatePatch({
    defaultOwner: 'wanger',
    workspace: 'relative/path',
    tickIntervalMs: -1,
    members: { development: ['human:zhouyu', 'zhouyu'] },
    senders: { ou_a: 'human:ok', ou_b: 'nope' },
    gates: { accept: { timeout: '4 hours', on_timeout: 'auto_release_now' }, nonsense: {} },
    sessions: { turnTimeoutMs: 0, presets: { dev: 7 } },
    feishu: { mode: 'bridge', appSecret: ' has-space ', chatIds: ['oc_x'], typo: true },
    bogus: 1,
  })
  const paths = problems.map((problem) => problem.path)
  for (const expected of [
    'defaultOwner',
    'workspace',
    'tickIntervalMs',
    'members.development[1]',
    'senders.ou_b',
    'gates.accept.timeout',
    'gates.accept.on_timeout',
    'gates.nonsense',
    'sessions.turnTimeoutMs',
    'sessions.presets.dev',
    'feishu.mode',
    'feishu.appSecret',
    'feishu.chatIds',
    'feishu.typo',
    'bogus',
  ]) {
    assert.ok(paths.includes(expected), 'expected a problem at ' + expected + ', got ' + JSON.stringify(paths))
  }
  // A secret pasted with a trailing space is the single most common paste error,
  // and it fails as "invalid app credentials" three screens away.
  assert.match(problems.find((p) => p.path === 'feishu.appSecret').message, /空白/)
})

test('a valid patch passes, including an empty members list (that has meaning)', () => {
  assert.deepEqual(validatePatch({ members: { testing: [], pm: ['human:wangmengfan', 'bot:coord'] } }), [])
  assert.deepEqual(validatePatch({ gates: { start: { timeout: '2h', on_timeout: 'auto_release', max_release: 2 } } }), [])
  assert.deepEqual(validatePatch({ feishu: { mode: 'off', requireMention: false } }), [])
  assert.deepEqual(validatePatch({ workspace: '/tmp/x', workspaceTitle: '团队 · 飞书' }), [])
})

test('saving merges into the file, keeps a human\'s comments, and reloads live', () => {
  const world = makeWorld({
    '//': '手写的注释：保留我',
    defaultOwner: 'human:old',
    feishu: { mode: 'own', appId: 'cli_old', appSecret: 'old-secret' },
  })
  try {
    let reloaded = 0
    const saved = saveConfig({
      configFile: world.configFile,
      dataDir: world.dir,
      actor: 'human:wangmengfan',
      patch: { defaultOwner: 'human:wangmengfan', feishu: { requireMention: false } },
      reload: () => {
        reloaded += 1
      },
    })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.deepEqual(saved.applied, ['defaultOwner', 'feishu'])
    assert.equal(reloaded, 1, 'the running plugin must re-read the file, or "saved" means "restart to see"')

    const doc = readConfigDoc(world.configFile)
    assert.equal(doc['//'], '手写的注释：保留我', 'the console edits a file, it does not own it')
    assert.equal(doc.defaultOwner, 'human:wangmengfan')
    assert.equal(doc.feishu.requireMention, false)
    assert.equal(doc.feishu.appId, 'cli_old', 'untouched keys stay untouched')
    assert.equal(doc.feishu.appSecret, 'old-secret', 'an absent secret in the patch must not erase the stored one')

    // And the loader actually sees the change — read from THIS directory, not
    // from the developer's real config.
    const reloadedConfig = loadConfig({ dataDir: world.dir })
    assert.equal(reloadedConfig.defaultOwner, 'human:wangmengfan')
    assert.equal(reloadedConfig.feishu.requireMention, false)

    const audit = readFileSync(join(world.dir, 'config-audit.jsonl'), 'utf8').trim()
    assert.match(audit, /human:wangmengfan/)
    assert.ok(readFileSync(saved.backup, 'utf8').length > 0, 'the previous file is kept')
  } finally {
    world.cleanup()
  }
})

test('the panel\'s shape lands where the loader reads it', () => {
  /*
   * The panel treats `senders` / `chatActors` as peers of `members`; the file
   * keeps them under `feishu`. A merge that wrote them top level would report
   * success and change nothing — the failure mode this test exists for.
   */
  const merged = mergePatch({ feishu: { mode: 'own' } }, { senders: { ou_a: 'human:a' }, chatActors: { oc_x: 'human:b' } })
  assert.deepEqual(merged.feishu.senders, { ou_a: 'human:a' })
  assert.deepEqual(merged.feishu.chatActors, { oc_x: 'human:b' })
  assert.equal(merged.senders, undefined, 'not at the top level, where nothing reads it')

  // An empty secret means "leave it alone": the panel cannot read it back, so a
  // blank box must not wipe it.
  assert.equal(mergePatch({ feishu: { appSecret: 'kept' } }, { feishu: { appSecret: '' } }).feishu.appSecret, 'kept')
  assert.equal(mergePatch({ feishu: { appSecret: 'old' } }, { feishu: { appSecret: 'new' } }).feishu.appSecret, 'new')
})

test('a rejected save writes NOTHING and returns the problems plus the old config', () => {
  const world = makeWorld({ defaultOwner: 'human:old', feishu: { appSecret: 'secret' } })
  try {
    const before = readFileSync(world.configFile, 'utf8')
    let reloaded = 0
    const saved = saveConfig({
      configFile: world.configFile,
      dataDir: world.dir,
      actor: 'human:x',
      patch: { defaultOwner: 'not-a-principal', gates: { accept: { timeout: 'soon' } } },
      reload: () => {
        reloaded += 1
      },
    })
    assert.equal(saved.ok, false)
    assert.deepEqual(
      saved.problems.map((p) => p.path),
      ['defaultOwner', 'gates.accept.timeout'],
    )
    assert.equal(readFileSync(world.configFile, 'utf8'), before, 'a refused save leaves the file byte-identical')
    assert.equal(reloaded, 0, 'and nothing is reloaded')
  } finally {
    world.cleanup()
  }
})

test('the secret is write-only and the panel gets a flag instead', () => {
  const shape = redact({
    dataDir: '/d',
    workspace: '/w',
    defaultOwner: 'human:a',
    members: { pm: ['human:a'] },
    feishu: { mode: 'own', appId: 'cli_x', appSecret: 'super-secret', senders: { ou_a: 'human:a' }, chatActors: {} },
  })
  const text = JSON.stringify(shape)
  assert.equal(text.includes('super-secret'), false, 'a console that can display a secret leaks one into a screenshot')
  assert.equal(shape.feishu.appSecretSet, true)
  assert.deepEqual(shape.senders, { ou_a: 'human:a' }, 'surfaced at the top level for the form')
  // `members` is the member TABLE now; the domain map it used to be is `domains`,
  // which is what the ledger's consumers read (see members.js).
  assert.deepEqual(shape.members, [])
  assert.deepEqual(Object.keys(shape.domains), ['pm'])
  assert.ok(KNOWN_DOMAINS.includes('development'))
})

test('saving a workspace that cannot be created is refused, not half-applied', () => {
  const world = makeWorld({})
  try {
    const saved = saveConfig({
      configFile: world.configFile,
      dataDir: world.dir,
      actor: 'human:x',
      // A path under a file, not a directory: mkdir must fail.
      patch: { workspace: join(world.configFile, 'nested') },
      reload: () => {},
    })
    assert.equal(saved.ok, false)
    assert.equal(saved.problems[0].path, 'workspace')
  } finally {
    world.cleanup()
  }
})

test('a healthy config validates clean — a console that always warns is a console nobody reads', () => {
  /*
   * The first version fed the redacted object (which carries the display flag
   * `appSecretSet`) into the validator, so every load reported one bogus problem.
   * The list must be EMPTY for a good config, or the real problems stop being read.
   */
  const world = makeWorld({})
  try {
    const healthy = {
      defaultOwner: 'human:wangmengfan',
      workspace: world.dir,
      workspaceTitle: '团队 · 飞书',
      tickIntervalMs: 60000,
      members: { pm: ['human:wangmengfan'], development: ['human:zhouyu'] },
      senders: { ou_847e: 'human:wangmengfan' },
      chatActors: {},
      knownRepos: [],
      gates: { accept: { timeout: '4h', on_timeout: 'remind_then_escalate', max_release: null } },
      sessions: { preset: null, presets: { dev: 'standard' }, turnTimeoutMs: 900000, maxLive: 4 },
      feishu: { mode: 'own', appId: 'cli_x', botOpenId: '', requireMention: true, respond: true, buttons: false, addressedOverridesIntent: true },
    }
    assert.deepEqual(validatePatch(healthy), [], 'nothing here is wrong')
    // And the display flag is exactly the kind of thing that must never be writable.
    assert.equal(
      validatePatch({ feishu: { appSecretSet: true } })[0].path,
      'feishu.appSecretSet',
      'the panel is not allowed to write answers to its own questions',
    )
  } finally {
    world.cleanup()
  }
})

test('a knob nothing reads is refused, not quietly accepted: feishu.chatIds', () => {
  /*
   * `feishu.chatIds` was written by the console and read by nobody: a file saying
   * "only these groups" processed every group. Accepting a key that does nothing
   * teaches the operator a rule the system does not have, so it is an ERROR naming
   * the replacement — and an empty array counts too (the console used to submit
   * one on every save).
   */
  const problems = validatePatch({ feishu: { chatIds: [] } })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].path, 'feishu.chatIds')
  assert.match(problems[0].message, /不生效/)
  assert.match(problems[0].message, /bots\[\]\.feishu\.chats/, 'the message says where group binding actually lives')
})
