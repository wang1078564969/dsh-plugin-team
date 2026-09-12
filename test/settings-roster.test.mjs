/*
 * The console's write path for the two new objects: the bot roster and the member
 * table.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM settings.test.mjs. These two are WHOLE-ARRAY
 * writes, which is a different failure mode from the scalar fields: a save that
 * drops a field nobody edited (a secret, a runtime flag, an app that no bot names)
 * looks exactly like a successful save. Every test here is about what must SURVIVE
 * a write.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { isRegisteredChat } from '../lib/bots.js'
import { appDescriptors, appsView } from '../lib/feishu/apps.js'
import { mergePatch, projectMemberSenders, readConfigDoc, redact, saveConfig, validatePatch } from '../lib/settings.js'

function makeWorld(doc = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-roster-cfg-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(configFile, JSON.stringify(doc, null, 2), 'utf8')
  return {
    dir,
    configFile,
    reloads: { count: 0 },
    save(patch, actor = 'human:wangmengfan') {
      // The same context the API builds: the default app, the known presets, and
      // which apps actually have a credential (see api.js `validationContext`).
      const loaded = loadConfig({ dataDir: dir })
      return saveConfig({
        configFile,
        dataDir: dir,
        patch,
        actor,
        context: {
          defaultAppId: loaded.feishu.appId,
          knownPresets: ['standard'],
          appsWithSecret: appsView(loaded)
            .filter((one) => one.appSecretSet === true)
            .map((one) => one.appId),
        },
        reload: () => {
          this.reloads.count += 1
        },
      })
    },
    doc: () => JSON.parse(readFileSync(configFile, 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('a valid roster is written, and only the documented fields reach the file', () => {
  const world = makeWorld({ feishu: { mode: 'own', appId: 'cli_x', appSecret: 's0' } })
  try {
    const saved = world.save({
      bots: [
        // The console posts back the row it RENDERED, which carries runtime state.
        {
          id: 'dev',
          display_name: '开发机器人',
          role: 'dev',
          base_role: 'dev',
          enabled: true,
          feishu: { appId: '', chats: ['oc_a'], speakPolicy: { onMention: true, onIntent: false, leaseRequired: true, digestOnly: false }, connected: true },
          problems: [{ field: 'x', message: 'y', level: 'warn' }],
          sessions: [{ botId: 'dev', chatId: 'oc_a' }],
          appIdResolved: 'cli_x',
        },
      ],
    })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    const bot = world.doc().bots[0]
    assert.equal(bot.id, 'dev')
    assert.equal(bot.displayName, '开发机器人')
    assert.equal(bot.enabled, true)
    assert.deepEqual(bot.feishu.chats, ['oc_a'])
    // Runtime state is NOT configuration: writing it back would make the next load
    // read a stale "connected: true" as if an operator had configured it.
    assert.equal('problems' in bot, false)
    assert.equal('sessions' in bot, false)
    assert.equal('appIdResolved' in bot, false)
    assert.equal('connected' in bot.feishu, false)
    // …and snake_case from a hand-written roster is normalized on the way through.
    assert.equal('display_name' in bot, false)
  } finally {
    world.cleanup()
  }
})

test('an empty roster is legal and meaningful: single-assistant mode', () => {
  const world = makeWorld({})
  try {
    const saved = world.save({ bots: [] })
    assert.equal(saved.ok, true)
    assert.deepEqual(world.doc().bots, [])
    // And loaded back it stays empty — the defaults must NOT come back, or the
    // switch would be impossible to keep.
    const config = loadConfig({ dataDir: world.dir })
    assert.deepEqual(config.bots, [])
  } finally {
    world.cleanup()
  }
})

test('roster mistakes are refused with the row and the field, and nothing is written', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 's' } })
  try {
    const before = readFileSync(world.configFile, 'utf8')
    const saved = world.save({
      bots: [
        { id: 'dev', role: 'dev', displayName: '开发', enabled: true },
        { id: 'dev', role: 'dev', displayName: '开发二', enabled: true },
        { id: 'qa', role: 'qa', displayName: '测试', enabled: true, feishu: { appId: 'cli_unknown' } },
      ],
    })
    assert.equal(saved.ok, false)
    const paths = saved.problems.map((one) => one.path)
    assert.ok(paths.includes('bots[1].id'), 'a duplicate id is refused: ' + JSON.stringify(paths))
    assert.ok(
      paths.includes('bots[2].feishu.appId'),
      'an app with no secret is refused rather than silently answered as the default app',
    )
    assert.equal(readFileSync(world.configFile, 'utf8'), before, 'not one byte written')
    assert.equal(world.reloads.count, 0)
  } finally {
    world.cleanup()
  }
})

test('a roster that is not an array is refused, with the meaning of [] spelled out', () => {
  const problems = validatePatch({ bots: { dev: {} } }, { defaultAppId: 'cli_x' })
  assert.equal(problems[0].path, 'bots')
  assert.match(problems[0].message, /\[\] = 不启用任何机器人/)
})

test('an enabled bot with no app anywhere is refused — with the default app it is not', () => {
  const noApp = validatePatch({ bots: [{ id: 'req', role: 'req', displayName: '需求', enabled: true }] }, {})
  assert.equal(noApp.some((one) => one.path === 'bots[0].feishu.appId'), true)
  const withDefault = validatePatch({ bots: [{ id: 'req', role: 'req', displayName: '需求', enabled: true }] }, { defaultAppId: 'cli_x' })
  assert.deepEqual(withDefault, [])
})

test('one save can carry the roster AND the member table, and both land', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 's0' } })
  try {
    const saved = world.save({
      bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }],
      members: [{ key: 'human:wangmengfan', name: '王梦凡', domains: ['pm'], role: 'owner' }],
    })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    assert.deepEqual(saved.applied, ['bots', 'members'])
    const config = loadConfig({ dataDir: world.dir })
    assert.equal(config.bots.length, 1)
    assert.equal(config.memberList.length, 1)
    assert.equal(config.memberList[0].name, '王梦凡')
    // The domain map the ledger reads is derived from the row.
    assert.deepEqual(config.members.pm, ['human:wangmengfan'])
  } finally {
    world.cleanup()
  }
})

test('a member row without a usable key is refused: the ledger writes gates against it', () => {
  const problems = validatePatch({ members: [{ name: '没有键' }, { key: 'wang' }] })
  assert.equal(problems[0].path, 'members[0].key')
  assert.equal(problems[1].path, 'members[1].key')
})

test('the legacy domain map is still writable, and is routed to `domains`', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x' } })
  try {
    // A stale browser tab still sends the old shape. It must not overwrite the
    // member table with a map.
    const saved = world.save({ members: { development: ['human:zhouyu'] } })
    assert.equal(saved.ok, true)
    const doc = world.doc()
    assert.deepEqual(doc.domains.development, ['human:zhouyu'])
    assert.equal('members' in doc, false)
    assert.deepEqual(loadConfig({ dataDir: world.dir }).members.development, ['human:zhouyu'])
  } finally {
    world.cleanup()
  }
})

test('the first table write MIGRATES the legacy map instead of dropping it', () => {
  const world = makeWorld({
    members: { pm: ['human:wangmengfan'], development: ['human:zhouyu'] },
    feishu: { appId: 'cli_x' },
  })
  try {
    const saved = world.save({ members: [{ key: 'human:wangmengfan', name: '王梦凡', domains: ['pm'] }] })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    const config = loadConfig({ dataDir: world.dir })
    // The new row is there…
    assert.equal(config.memberList.length, 1)
    // …and the person who only existed in the old map still owns development: a
    // migration that dropped them would silently take away their right to confirm
    // their own tasks.
    assert.deepEqual(config.members.development, ['human:zhouyu'])
    assert.deepEqual(config.members.pm, ['human:wangmengfan'])
  } finally {
    world.cleanup()
  }
})

test('an open_id typed on a member row becomes the sender mapping that attributes button presses', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x', senders: { ou_existing: 'human:other' } } })
  try {
    const saved = world.save({
      members: [
        { key: 'human:wangmengfan', name: '王梦凡', openId: 'ou_wang', domains: ['pm'] },
        { key: 'human:other', name: '别人', openId: 'ou_existing' },
      ],
    })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    assert.deepEqual(saved.derived.sendersAdded.map((one) => one.openId), ['ou_wang'])
    const doc = world.doc()
    assert.equal(doc.feishu.senders.ou_wang, 'human:wangmengfan')
    // An existing mapping is never overwritten: the operator's own line wins.
    assert.equal(doc.feishu.senders.ou_existing, 'human:other')
    // And the derived write is in the audit trail, so "who added this mapping" has
    // an answer that is not "nobody".
    const audit = readFileSync(join(world.dir, 'config-audit.jsonl'), 'utf8').trim().split('\n')
    assert.equal(JSON.parse(audit[audit.length - 1]).sendersAdded.includes('ou_wang'), true)
  } finally {
    world.cleanup()
  }
})

test('projectMemberSenders is add-only, and says what it added', () => {
  const projected = projectMemberSenders({
    members: [{ key: 'human:a', openId: 'ou_a' }, { key: 'human:b', openId: '' }, { key: '', openId: 'ou_c' }],
    feishu: { senders: { ou_a: 'human:someone-else' } },
  })
  assert.deepEqual(projected.added, [])
  assert.deepEqual(projected.doc.feishu.senders, { ou_a: 'human:someone-else' })
})

test('feishu.apps merges per app, so saving one secret never drops another', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 's0', apps: { cli_two: { appSecret: 's2', name: '第二个' } } } })
  try {
    const saved = world.save({ feishu: { apps: { cli_three: { appSecret: 's3' } } } })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    const apps = world.doc().feishu.apps
    assert.equal(apps.cli_two.appSecret, 's2', 'the app nobody edited keeps its credential')
    assert.equal(apps.cli_three.appSecret, 's3')
    /*
     * An empty secret means "leave the one you have alone" — that is what an
     * untouched password box means, and it is the only safe reading for a value the
     * panel can never read back. So the save is ACCEPTED and the stored credential is
     * untouched, rather than the whole save being refused over an empty box.
     */
    const cleared = world.save({ feishu: { apps: { cli_two: { appSecret: '' } } } })
    assert.equal(cleared.ok, true, JSON.stringify(cleared.problems ?? []))
    assert.equal(world.doc().feishu.apps.cli_two.appSecret, 's2')
    assert.equal(world.doc().feishu.apps.cli_two.name, '第二个')
  } finally {
    world.cleanup()
  }
})

test('the redacted app view is refused if it is posted back as if it were config', () => {
  // The read view is an ARRAY with `appSecretSet` instead of `appSecret`. Writing it
  // would replace every credential with a display flag, and the bots on those apps
  // would go silent — so the shape is refused, loudly.
  const view = redact({ dataDir: '/d', workspace: '/w', feishu: { appId: 'cli_x', appSecret: 's', apps: {} } }).feishu.apps
  const problems = validatePatch({ feishu: { apps: view } })
  assert.equal(problems[0].path, 'feishu.apps')
  assert.match(problems[0].message, /只读视图/)
})

test('feishu.apps refuses an unknown field per app and a malformed app id', () => {
  const problems = validatePatch({ feishu: { apps: { cli_ok: { appSecret: ' s ' }, nope: { appSecret: 's' }, cli_two: { appSecretSet: true } } } })
  const paths = problems.map((one) => one.path)
  assert.ok(paths.includes('feishu.apps.nope'))
  assert.ok(paths.includes('feishu.apps.cli_ok.appSecret'), 'a pasted secret with a trailing space is the classic mistake')
  assert.ok(paths.includes('feishu.apps.cli_two.appSecretSet'))
})

test('senders/chatActors live in ONE place after a save: the file\'s own layout', () => {
  /*
   * The loader reads `feishu.senders` first and a top-level `senders` second, so a
   * stale top-level copy silently OVERRIDES what a save just wrote — "saved" with
   * nothing changed, the failure this console exists to prevent. The legacy copy is
   * therefore migrated into `feishu`, not left to drift.
   */
  const world = makeWorld({ senders: { ou_old: 'human:a' }, feishu: { appId: 'cli_x', appSecret: 's0' } })
  try {
    const saved = world.save({ senders: { ou_new: 'human:b' } })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    const doc = world.doc()
    assert.deepEqual(doc.feishu.senders, { ou_new: 'human:b' })
    assert.equal('senders' in doc, false, 'the legacy top-level copy is gone, so there is nothing left to drift')
    // And it READS BACK as what was saved — the assertion that catches the override.
    assert.deepEqual(loadConfig({ dataDir: world.dir }).feishu.senders, { ou_new: 'human:b' })
  } finally {
    world.cleanup()
  }
})

test('a patch that speaks the file\'s own layout (feishu.senders) is accepted and lands there', () => {
  const world = makeWorld({ senders: { ou_old: 'human:a' }, feishu: { appId: 'cli_x', appSecret: 's0' } })
  try {
    const saved = world.save({ feishu: { senders: { ou_fromfile: 'human:c' } } })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    const doc = world.doc()
    assert.deepEqual(doc.feishu.senders, { ou_fromfile: 'human:c' })
    assert.equal('senders' in doc, false)
    assert.deepEqual(loadConfig({ dataDir: world.dir }).feishu.senders, { ou_fromfile: 'human:c' })
  } finally {
    world.cleanup()
  }
})

test('mergePatch keeps the keys it does not own, including a human\'s comment keys', () => {
  const doc = { '//': '手写注释', feishu: { appId: 'cli_x', accessToken: 'ignored' }, unknownTop: 1 }
  const next = mergePatch(doc, {
    bots: [{ id: 'req', role: 'req' }],
    members: [{ key: 'human:a', name: '甲' }],
    domains: { pm: ['human:a'] },
    senders: { ou_a: 'human:a' },
  })
  assert.equal(next['//'], '手写注释')
  assert.equal(next.unknownTop, 1)
  assert.equal(next.feishu.accessToken, 'ignored')
  assert.equal(next.feishu.senders.ou_a, 'human:a', 'the panel writes senders at the top level; the file keeps them under feishu')
  assert.equal(next.members.length, 1)
  assert.deepEqual(next.domains.pm, ['human:a'])
})

test('readConfigDoc tolerates a missing or broken file, so a first save is not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-roster-cfg-'))
  try {
    assert.deepEqual(readConfigDoc(join(dir, 'nope.json')), {})
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{nope', 'utf8')
    assert.deepEqual(readConfigDoc(broken), {})
    assert.equal(existsSync(broken), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a credential written onto the app replaces the installation-level key, not duplicates it', () => {
  /*
   * `feishu.appSecret` describes exactly one app (the one in `feishu.appId`). Once the
   * editor writes that app's secret onto the app itself, the old key would be a SECOND
   * home claiming to hold the same value — and only one of them is read. Two copies of
   * a credential is how "I rotated the secret and it still fails" happens.
   */
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 'old-secret', botOpenId: 'ou_old' } })
  try {
    const saved = world.save({ bots: [{ id: 'req', role: 'req', enabled: true }], feishu: { apps: { cli_x: { appSecret: 'new-secret' } } } })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    const doc = world.doc()
    assert.equal(doc.feishu.apps.cli_x.appSecret, 'new-secret')
    assert.equal('appSecret' in doc.feishu, false, 'the legacy key is gone: one credential, one home')
    // The botOpenId was NOT rewritten, so it stays where it was.
    assert.equal(doc.feishu.botOpenId, 'ou_old')

    // And the value the plugin reads is the app entry's.
    const config = loadConfig({ dataDir: world.dir })
    const app = appDescriptors(config).find((one) => one.appId === 'cli_x')
    assert.equal(app.appSecret, 'new-secret')
    assert.equal(app.botOpenId, 'ou_old', 'the identity still comes from wherever it lives')
  } finally {
    world.cleanup()
  }
})

test('an app entry WITHOUT a secret leaves the installation-level one alone', () => {
  // Deleting the fallback before the replacement exists would take the app offline.
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 'only-secret' } })
  try {
    const saved = world.save({ feishu: { apps: { cli_x: { name: '需求线' } } } })
    assert.equal(saved.ok, true, JSON.stringify(saved.problems ?? []))
    const doc = world.doc()
    assert.equal(doc.feishu.appSecret, 'only-secret', 'the only working credential is untouched')
    const app = appDescriptors(loadConfig({ dataDir: world.dir })).find((one) => one.appId === 'cli_x')
    assert.equal(app.ready, true)
    assert.equal(app.name, '需求线')
  } finally {
    world.cleanup()
  }
})

test('任务类型与域的兜底确认人在配置台是**可写且会被校验**的', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 's0' } })
  try {
    // 合法：覆盖一个类型 + 给一个域配兜底人
    const ok = world.save({
      taskTypes: { code_change: { domains: ['development', 'security'] } },
      domainFallbacks: { security: 'human:cso' },
    })
    assert.equal(ok.ok, true, JSON.stringify(ok.problems ?? []))
    const doc = world.doc()
    assert.deepEqual(doc.taskTypes.code_change.domains, ['development', 'security'])
    assert.equal(doc.domainFallbacks.security, 'human:cso')

    // 未知域：拒绝，并把已知域列出来（而不是让人对着"未知"猜）
    const badDomain = world.save({ taskTypes: { code_change: { domains: ['develpoment'] } } })
    assert.equal(badDomain.ok, false)
    assert.equal(badDomain.problems[0].path, 'taskTypes.code_change.domains')
    assert.match(badDomain.problems[0].message, /未知角色域/)

    // 一个域都没有：拒绝（没有域就没人会被拉进确认）
    const empty = world.save({ taskTypes: { code_change: { domains: [] } } })
    assert.equal(empty.ok, false)
    assert.match(empty.problems[0].message, /至少要一个域/)

    // 兜底人必须是主体形状
    const badWho = world.save({ domainFallbacks: { security: 'cso' } })
    assert.equal(badWho.ok, false)
    assert.equal(badWho.problems[0].path, 'domainFallbacks.security')
  } finally {
    world.cleanup()
  }
})

test('群准入的两个键可写、会被校验，并且是"登记过的群才处理"的开关', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 's0' } })
  try {
    const ok = world.save({ feishu: { requireRegisteredChat: true, chatAllowlist: ['oc_a'] } })
    assert.equal(ok.ok, true, JSON.stringify(ok.problems ?? []))
    const config = loadConfig({ dataDir: world.dir })
    assert.equal(config.feishu.requireRegisteredChat, true)
    assert.deepEqual(config.feishu.chatAllowlist, ['oc_a'])

    const bad = world.save({ feishu: { chatAllowlist: ['not-a-chat'] } })
    assert.equal(bad.ok, false)
    assert.equal(bad.problems[0].path, 'feishu.chatAllowlist[0]')
  } finally {
    world.cleanup()
  }
})

test('表态（reaction）默认开，可以在配置里关掉', () => {
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 's0' } })
  try {
    const config = loadConfig({ dataDir: world.dir })
    assert.equal(config.feishu.reaction, true, '默认开：@ 了机器人应该立刻有反馈')
    assert.equal(config.feishu.reactionEmoji, 'Get')
    // 关掉它：不是所有人都想要机器人给自己加表情
    writeFileSync(world.configFile, JSON.stringify({ feishu: { appId: 'cli_x', appSecret: 's0', reaction: false } }, null, 2), 'utf8')
    assert.equal(loadConfig({ dataDir: world.dir }).feishu.reaction, false)
  } finally {
    world.cleanup()
  }
})

test('表态的默认范围是"每一条收到的消息"，可以收回到只对 @ 的', () => {
  /*
   * 默认 `all`：`requireMention: true` 的群里机器人只在被 @ 时开口，如果连表态也只对 @ 的做，
   * 那么"它到底听见没有"就只能靠猜。吵的群用 `addressed` 收回去 —— 两个方向都是真实需求，
   * 所以这里把**默认值**和**切换**都钉住。
   */
  const world = makeWorld({ feishu: { appId: 'cli_x', appSecret: 's0' } })
  try {
    assert.equal(loadConfig({ dataDir: world.dir }).feishu.reactionScope, 'all', '默认每一条都表态')

    writeFileSync(
      world.configFile,
      JSON.stringify({ feishu: { appId: 'cli_x', appSecret: 's0', reactionScope: 'addressed', reactionEmoji: 'DONE' } }, null, 2),
      'utf8',
    )
    const tuned = loadConfig({ dataDir: world.dir }).feishu
    assert.equal(tuned.reactionScope, 'addressed')
    assert.equal(tuned.reactionEmoji, 'DONE')

    /*
     * 值不认识 → **退回默认语义**（all），不是"当作没写"也不是猜一个：
     * 手写文件的人拿到的是可预期的行为，而面板写入那条路由会被校验拦下并说清楚。
     */
    writeFileSync(
      world.configFile,
      JSON.stringify({ feishu: { appId: 'cli_x', appSecret: 's0', reactionScope: 'every-message' } }, null, 2),
      'utf8',
    )
    assert.equal(loadConfig({ dataDir: world.dir }).feishu.reactionScope, 'all')
  } finally {
    world.cleanup()
  }
})

test('配置台写入时会校验表态的三个键（形状与枚举）', () => {
  const problems = validatePatch({ feishu: { reaction: 'yes' } })
  assert.equal(problems.some((one) => one.path === 'feishu.reaction'), true, 'reaction 必须是布尔')

  const emoji = validatePatch({ feishu: { reactionEmoji: '   ' } })
  assert.equal(emoji.some((one) => one.path === 'feishu.reactionEmoji'), true, '空的表情名要拦住')

  const scope = validatePatch({ feishu: { reactionScope: 'always' } })
  assert.equal(scope.some((one) => one.path === 'feishu.reactionScope'), true, '范围只能是 all / addressed')

  /*
   * 反过来：合法的值一个都不能被拦。
   *
   * 表情名**故意不校验"是不是飞书认识的那一批"**：那份清单会变（现在是 185 个），
   * 写死一份副本只会在飞书加了新表情之后拒绝一个完全合法的值。写错的结果是接口报错，
   * 而那一行错误会出现在日志页的 `reaction` 行里 —— 比在这里猜要诚实。
   */
  assert.deepEqual(validatePatch({ feishu: { reaction: true } }), [])
  assert.deepEqual(validatePatch({ feishu: { reactionScope: 'addressed' } }), [])
  assert.deepEqual(validatePatch({ feishu: { reactionEmoji: 'SomeNewEmojiFromFeishu' } }), [])
})
