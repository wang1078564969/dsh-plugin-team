/*
 * The browser half, executed instead of hoped for.
 *
 * There is no browser in this loop, so the risky part of a hand-written client
 * bundle is not "does it look right" but "does the loader contract hold": the
 * classic-script wrapper, the factory's exports, and the two slot registrations.
 * All three are checked here by running the real file against a stub loader and
 * a stub `react` — the same way DSH's own loader will call it, minus the DOM.
 *
 * It cannot prove the panel RENDERS. It proves the panel is reachable, which is
 * the failure that would otherwise only appear in a browser console.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

import { CARD_VIAS, FALLBACK_VIAS } from '../lib/feishu/cards.js'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')
const PACKAGE_NAME = 'dsh-plugin-team'

/** The smallest `react` that a bundle can be loaded against. */
function reactStub() {
  const passthrough = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement: passthrough,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    useReducer: (_reducer, initial) => [initial, () => {}],
  }
}

/** A DOM good enough for CSS injection and any module-scope probing. */
function documentStub() {
  const styles = []
  return {
    styles,
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
    head: { appendChild: (node) => styles.push(node) },
    body: { appendChild: (node) => styles.push(node) },
  }
}

/**
 * Load the bundle the way the platform does: a classic script that calls
 * `window.__ModuleLoader__.load({id, factory})`, whose factory receives the
 * platform module list as `require`.
 */
function loadClientHalf() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let definition = null
  const window = { __ModuleLoader__: { load: (def) => { definition = def } } }
  const document = documentStub()
  const require = (name) => {
    if (name === 'react') return reactStub()
    throw new Error('the bundle may only require react, but required: ' + name)
  }
  // A classic script: `var`/`function` at top level, no module syntax.
  const run = new Function('window', 'document', 'require', 'globalThis', source)
  run(window, document, require, { window, document })
  return { definition, document }
}

test('the bundle registers itself under the package name and exports the plugin contract', () => {
  const { definition } = loadClientHalf()
  assert.notEqual(definition, null, 'window.__ModuleLoader__.load was never called')
  assert.equal(definition.id, PACKAGE_NAME, 'the loader aliases `<id>/client`, so the id must be the package name')
  assert.equal(typeof definition.factory, 'function')

  const exports = definition.factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(typeof exports.apply, 'function', 'the loader calls apply() to mount the half')
  assert.deepEqual(exports.inject, ['slots'], 'the real dependency is the slots service')
})

test('apply() registers the sidebar entry and the panel, keyed to the same id', () => {
  const { definition } = loadClientHalf()
  const exports = definition.factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error('unexpected require: ' + name)
  })

  const registered = []
  const injected = []
  const ctx = {
    slots: {
      inject(slot, factory) {
        injected.push(slot)
        return factory()
      },
      register(registration, component) {
        registered.push({ registration, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])

  const entry = registered.find((item) => item.registration.name === 'sidebar.panellist')
  const panel = registered.find((item) => item.registration.name === 'main')
  assert.ok(entry !== undefined, 'the sidebar entry is what makes the panel reachable')
  assert.ok(panel !== undefined, 'the panel itself must be registered')
  assert.equal(typeof entry.component, 'function')
  assert.equal(typeof panel.component, 'function')
  // The owner dispatches `main` by the sidebar entry's id: if these two drift
  // apart, the panel becomes unreachable with no error anywhere.
  assert.equal(entry.registration.id, panel.registration.key)
  assert.equal(entry.registration.id, 'team')
  assert.equal(typeof entry.registration.label, 'string')
  assert.ok(entry.registration.label.length > 0, 'a sidebar entry with no label is an invisible button')
})

test('the bundle talks to exactly the routes the host mounts', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  /*
   * Comments are stripped first: this file EXPLAINS at length that a shipped
   * half has no `host.call` and why, and a scan that cannot tell prose from code
   * would fail on its own documentation.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const urls = [...code.matchAll(/['"`](\/[A-Za-z0-9._\-/]*)['"`]/g)].map((match) => match[1])
  const routes = [...new Set(urls.filter((url) => url.startsWith('/api/')))]
  // Exactly the routes the host mounts, and nothing else: the ledger the
  // panel shows, and the configuration it edits. Both sit behind the same
  // authenticated /api fence.
  assert.deepEqual(routes.sort(), ['/api/team/config', '/api/team/ledger', '/api/team/logs'])
  assert.equal(/host\.call/.test(code), false, 'a shipped half has no host.call — reaching for it fails at runtime')
})

/*
 * The console's five pages, checked as SOURCE TEXT.
 *
 * There is no browser here, so the render tests next door (opt-in, real react +
 * jsdom) are what prove a page actually draws. These assertions cover what they
 * cannot: that all five tabs exist at all, that the highlight rule is written as
 * an equality against the current tab (the old "is this the config page" rule
 * would light up two tabs at once), and — most importantly — that the two
 * structured writes the roster pages perform are present, since a page that can
 * only read is a page that cannot fix anything.
 */
test('the console offers five pages and highlights exactly the current one', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  for (const label of ['台账', '配置', '机器人', '成员', '会话', '日志']) {
    assert.ok(code.includes(`'${label}'`), `the tab strip must offer the ${label} page`)
  }
  /*
   * Six pages, two reads: the ledger keeps its own GET, the three roster pages
   * share the configuration read, and the log page has its OWN (rolling) read —
   * 把每 3 秒刷一次的东西塞进配置快照，等于每 3 秒重算一遍名册与自检。
   */
  assert.equal((code.match(/tabButton\('/g) ?? []).length, 6, 'one tab button per page')
  assert.ok(/var active = key === current\.tab/.test(code), 'the active tab is an equality, not a config-page special case')
  assert.equal(/=== \(current\.tab === 'config'\)/.test(code), false, 'the old two-tab rule must be gone')
})

test('the roster pages write exactly what the host can accept', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  // Turning a bot on/off submits the whole `bots` list; binding an openId
  // submits the whole `members` list. Both are group writes on purpose: a host
  // that replaces instead of deep-merging must not lose the sibling keys.
  assert.ok(/patch\.bots = /.test(code), 'the bot toggle builds a bots patch')
  assert.ok(/nextPatch = \{ bots: nextBots \}/.test(code), 'the bot editor submits the whole list too')
  /*
   * The credential travels in the same patch as the roster row, and it ALWAYS lands on
   * the app the bot names — there is no "default app" branch any more, so the secret
   * has exactly one home and the two cannot drift.
   */
  assert.ok(/nextPatch\.feishu = \{ apps: appsPatch \}/.test(code), 'the credential lands on the bot\'s own app')
  assert.equal(/nextPatch\.feishu = feishuPatch/.test(code), false, 'no separate "installation app" branch is left')
  assert.ok(/appsPatch\[targetApp\] = entry/.test(code), 'keyed by that app id')
  assert.ok(/saveRosterPatch\(\{ bots: nextBots \}/.test(code), 'the bot toggle submits the whole array')
  assert.ok(/saveRosterPatch\(\{ members: nextMembers \}/.test(code), 'the openId binding submits the whole array')
  // The human member domains moved to `domains`; the members list is an array of
  // member objects now, so the form must not keep building `members.<domain>`.
  assert.ok(/patch\.domains = /.test(code), 'the config form submits member domains')
  assert.equal(/patch\.members = nextMembers\b/.test(code), false, 'the domains group must not be written as `members`')
  assert.equal(/fields\['members\.'/.test(code), false, 'no field is still keyed `members.<domain>`')
  assert.ok(/fields\['domains\.'/.test(code), 'the domain fields are keyed `domains.<domain>`')

  /*
   * A secret is WRITE-ONLY, and the precise rule matters now that the panel can set
   * one (the bot editor has a password field): what must never happen is READING a
   * secret out of the payload. The only source of a submitted secret is what the
   * operator typed into the draft.
   */
  assert.ok(/appSecretSet/.test(code), 'it reads the "is a secret set" flag instead of the secret')
  /*
   * The only `x.appSecret` the bundle may READ is `fields.appSecret` — the draft the
   * operator is typing into. Anything else (`config…`, `appEntry…`, `payload…`) would
   * be the browser holding a stored secret, which is the thing this rule exists for.
   */
  // String literals are removed first: `'feishu.appSecret（默认应用）'` is a label the
  // operator reads, not a property access.
  const codeNoStrings = code.replace(/'[^'\n]*'/g, "''")
  const secretReads = [...codeNoStrings.matchAll(/([A-Za-z_$][\w$]*)\.appSecret\b(?!\s*=)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(secretReads)], ['fields'], 'the only readable secret is the draft being typed')
  assert.ok(/type: 'password'/.test(code), 'the credential field is a password input')
  assert.ok(/entry\.appSecret = secret/.test(code), 'the secret comes from the draft and lands on the app entry')
  assert.ok(/new-secret-value|secret !== ''/.test(code), 'an empty box is never submitted (leave it alone)')

  /*
   * `feishu.apps` is the one key whose read shape and write shape differ: the host
   * sends a read-only ARRAY (with `appSecretSet` where the secret would be) and
   * refuses it back, accepting only the `{appId: {...}}` MAP. A bundle that posted
   * the view would report success after replacing every credential with the word
   * "appSecretSet" — so the write path builds its own map from the editor, and the
   * read-only view is never an input to it.
   */
  assert.ok(/appsPatch\[targetApp\] = entry/.test(code), 'the apps patch is built as a per-app map')
  assert.equal(/feishuPatch\.apps = (appsView|parsedApps|appList)/.test(code), false, 'the read-only view is never written back')
  assert.ok(/\^cli_\[A-Za-z0-9\]\+\$/.test(code), 'only ids the host recognises are writable')
  // The credential names the app it belongs to, so there is no doubt which key is written.
  assert.ok(/应用密钥（' \+ \(targetApp/.test(code), 'the credential field names its app')
  assert.ok(/feishu\.apps\.' \+ targetApp \+ '\.appSecret/.test(code), 'and says which key a typed secret lands in')
})

test('the degradation tiers the page highlights are the ones the host actually uses', () => {
  /*
   * 页面是经典脚本，import 不到 `lib/feishu/cards.js` 的常量，所以降级层级必然是
   * 一份副本。副本的危险是**静默漂移**：引擎加了第六级、观测层跟着改了，
   * 页面上"降级率"却还在按旧的两级算 —— 一个看起来很正常、但其实是错的数字。
   * 这条断言逐字比对两边，改了一边忘了另一边会在测试里红。
   */
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const match = /const FALLBACK_VIAS = (\[[^\]]*\])/.exec(source)
  assert.notEqual(match, null, 'the page declares the fallback tiers it highlights')
  // 客户端写的是单引号字面量，所以求值而不是 JSON.parse。
  assert.deepEqual(new Function('return ' + match[1])(), FALLBACK_VIAS)
  assert.deepEqual(CARD_VIAS.concat(FALLBACK_VIAS).length, 5, '五级降级链：三级卡 + 两级降级')
})

test('the bundle stays a classic script with no module syntax', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  // No import/export/JSX anywhere: the platform loads this file as a classic
  // script and does not transform it, so any of these would be a syntax error in
  // the browser (and would not be caught by a node --check of an ES module).
  assert.equal(/^\s*(import|export)\s/m.test(source), false, 'no ESM syntax')
  assert.equal(/React\.createElement\('</.test(source), false, 'no JSX')
  assert.ok(/React\.createElement\(/.test(source), 'createElement is the whole vocabulary')
})


test('the panel cannot wipe the file\'s per-role preset map', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  /*
   * `sessions.presets` stopped being a form: the preset belongs to the BOT, and the
   * 配置 page now shows the host's resolution read-only. The danger is subtle and
   * one-directional — a role input that is no longer rendered reads back as an empty
   * string, and an empty string submitted as `null` would ERASE a mapping someone
   * hand-wrote in the file. So the save path must not mention it at all.
   */
  assert.equal(/nextPresets/.test(code), false, 'no per-role preset object is built')
  assert.equal(/nextSessions\.presets/.test(code), false, 'and none is submitted')
  assert.equal(/sessions\.presets\./.test(code), false, 'no field is keyed sessions.presets.<role>')
  assert.ok(/renderSessionRoles\(payload\)/.test(code), 'the section shows the host-computed resolution instead')
  // Read-only means read-only: the block reads `payload.sessionRoles`, never the form.
  assert.ok(/payload\.sessionRoles/.test(code), 'the block reads the host\'s sessionRoles view')
})
