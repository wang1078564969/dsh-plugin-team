/*
 * The three roster pages, RENDERED — 机器人 / 成员 / 会话.
 *
 * Same opt-in harness as `client-config-render.test.mjs` (real react + jsdom from
 * `$TEAM_CLIENT_TEST_MODULES` or this package's node_modules) and the same
 * reason: there is no browser in this loop, so what can be checked is that each
 * page mounts, shows what the host sent (verbatim, including the problems), and
 * posts exactly the group the host can accept — and nothing else.
 *
 * The three pages share one fetch (`GET /api/team/config`), so one mount is
 * enough to walk all of them: switching tabs must NOT re-read the endpoint.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')

function loadHarness() {
  const bases = []
  if (typeof process.env.TEAM_CLIENT_TEST_MODULES === 'string' && process.env.TEAM_CLIENT_TEST_MODULES !== '') {
    bases.push(process.env.TEAM_CLIENT_TEST_MODULES)
  }
  bases.push(join(here, '..'))
  for (const base of bases) {
    try {
      const localRequire = createRequire(join(base, 'noop.cjs'))
      const jsdom = localRequire('jsdom')
      localRequire.resolve('react')
      localRequire.resolve('react-dom/client')
      return { require: localRequire, JSDOM: jsdom.JSDOM }
    } catch (error) {
      /* next base */
    }
  }
  return null
}

const harness = loadHarness()
const skip = harness === null
  ? 'needs react + react-dom + jsdom: run `npm i -D react react-dom jsdom` (or set TEAM_CLIENT_TEST_MODULES)'
  : false

/* ------------------------------------------------------------------ *
 * Fixtures: two bots (one with an error + a warn), two members (one with no
 * openId yet), one app, one unbound sender, two sessions in two groups.
 * ------------------------------------------------------------------ */

function botsFixture() {
  return [
    {
      id: 'req', displayName: '需求机器人', role: 'req', baseRole: 'req', enabled: true,
      feishu: { appId: 'cli_app1', chats: [] },
    },
    {
      id: 'dev', displayName: '开发机器人', role: 'dev', baseRole: 'dev', enabled: false,
      feishu: { appId: 'cli_app2', chats: ['oc_a', 'oc_b'] },
    },
  ]
}

function membersFixture() {
  return [
    {
      key: 'human:wangmengfan', name: '王梦凡', openId: 'ou_847e', role: 'pm',
      domains: ['pm'], projects: ['pay-service'], canApprove: true, delegate: false, active: true,
    },
    {
      key: 'human:zhouyu', name: '周宇', openId: '', role: 'dev',
      domains: ['development'], projects: [], canApprove: false, delegate: false, active: true,
    },
  ]
}

function configSnapshot() {
  return {
    ok: true,
    config: {
      workspace: '/Users/x/.dsh/team/workspace',
      workspaceTitle: '团队 · 飞书',
      dataDir: '/Users/x/.dsh/team',
      defaultOwner: 'human:fallback',
      tickIntervalMs: 60000,
      members: membersFixture(),
      domains: { pm: ['human:wangmengfan'], development: ['human:zhouyu'] },
      bots: botsFixture(),
      senders: { ou_847e: 'human:wangmengfan' },
      chatActors: {},
      knownRepos: [],
      gates: {},
      sessions: { preset: null, presets: {}, turnTimeoutMs: 900000, maxLive: 4 },
      feishu: {
        mode: 'own', appId: 'cli_app1', appSecretSet: true, botOpenId: 'ou_bot',
        requireMention: true, respond: true, buttons: false, chatIds: [],
        speakLeaseMs: 60000,
        apps: [
          { appId: 'cli_app1', name: '团队应用', botOpenId: 'ou_bot', appSecretSet: true, source: 'team-config', bots: ['req'] },
          { appId: 'cli_app2', name: '开发应用', botOpenId: '', appSecretSet: false, source: 'bots', bots: ['dev'] },
        ],
        addressedOverridesIntent: true,
      },
    },
    problems: [],
    diagnostics: {
      checkedAt: '2026-09-12T09:00:00.000Z',
      credentials: { ok: true, source: 'team-config', appId: 'cli_app1' },
      identity: { ok: true, name: '王梦凡的飞书 CLI', openId: 'ou_bot' },
      connection: { ready: true, connected: true, lastReadyAt: '2026-09-12T09:00:00.000Z', lastError: null },
      chats: { ok: true, items: [] },
      ledger: { requirements: 1, tasks: 2, chats: 2, inbox: 3 },
      mode: 'own',
    },
    roster: {
      bots: [
        {
          id: 'req', displayName: '需求机器人', role: 'req', baseRole: 'req', enabled: true,
          /* `connected` is runtime state the host adds: "enabled, so why silent". */
          feishu: { appId: 'cli_app1', chats: [], connected: false }, appIdResolved: 'cli_app1', problems: [], sessions: [],
        },
        {
          id: 'dev', displayName: '开发机器人', role: 'dev', baseRole: 'dev', enabled: false,
          feishu: { appId: 'cli_app2', chats: ['oc_a', 'oc_b'] }, appIdResolved: 'cli_app2',
          problems: [
            { field: 'feishu.appId', message: '这个 appId 在 feishu.apps 里找不到', level: 'error' },
            { field: 'feishu.chats', message: '群 oc_b 里机器人不在', level: 'warn' },
          ],
          sessions: [],
        },
      ],
      members: [
        { ...membersFixture()[0], problems: [] },
        { ...membersFixture()[1], problems: [{ field: 'openId', message: '这个成员还没有绑定飞书 open_id', level: 'warn' }] },
      ],
      senders: { unbound: [{ openId: 'ou_zzz', principal: '', principalKnown: false }] },
      /* Enabled but unable to come online — reported with the host's own reason. */
      offline: [{ botId: 'req', reason: 'no-secret', message: '应用 cli_app1… 没有 appSecret：在「配置」里为它填一个密钥' }],
    },
    /*
     * 群列表：每个群的主机器人。一个是已经定了主的群，一个是刚加进来、
     * 还没有任何消息的群（主为 null）—— 这两种都要能画出来。
     */
    chats: [
      {
        id: 'oc_a', title: '需求群', chatType: 'group', appId: 'cli_app1',
        primaryBotId: 'req', primaryBotName: '需求机器人', primarySince: '2026-09-10T08:00:00.000Z',
        lastBotId: 'dev', messages: 12, turns: 3,
        lastSeen: '2026-09-12T09:00:00.000Z', lastReplyAt: '2026-09-12T09:01:00.000Z',
        lastInbound: '重试这块要不要加？',
      },
      {
        id: 'oc_new', title: '', chatType: 'group', appId: 'cli_app1',
        primaryBotId: null, primaryBotName: null, primarySince: null, lastBotId: null,
        messages: 0, turns: 0, lastSeen: null, lastReplyAt: null, lastInbound: null,
      },
    ],
    sessions: [
      {
        botId: 'req', chatId: 'oc_a', sessionId: 'team-feishu-oc_a', turns: 3,
        lastSeen: '2026-09-12T09:00:00.000Z', lastReplyAt: '2026-09-12T09:01:00.000Z',
        title: '需求群', workspace: '/Users/x/.dsh/team/workspace', chatType: 'group',
      },
      {
        botId: 'dev', chatId: 'oc_b', sessionId: 'team-feishu-oc_b', turns: 7,
        lastSeen: '2026-09-12T10:00:00.000Z', lastReplyAt: null,
        title: '开发群', workspace: '/Users/x/.dsh/team/workspace', chatType: 'p2p',
      },
    ],
    editable: [
      'defaultOwner', 'workspace', 'workspaceTitle', 'tickIntervalMs',
      'domains', 'members', 'bots', 'senders', 'chatActors', 'knownRepos', 'gates', 'sessions',
      'feishu.mode', 'feishu.requireMention', 'feishu.respond', 'feishu.buttons',
      'feishu.appId', 'feishu.appSecret', 'feishu.botOpenId', 'feishu.chatIds',
      'feishu.speakLeaseMs', 'feishu.apps', 'feishu.addressedOverridesIntent',
    ],
  }
}

function ledgerSnapshot() {
  return {
    ok: true,
    generatedAt: '2026-09-12T09:00:00.000Z',
    config: {
      dataDir: '/Users/x/.dsh/team', workspace: '/Users/x/.dsh/team/workspace',
      defaultOwner: 'human:fallback', feishuMode: 'own',
      /*
       * The three shapes of "who is first", on purpose out of order: the roster
       * wins, the domain map is second, and the legacy domain map under
       * `members` is only a fallback for old snapshots.
       */
      memberList: [{ key: 'human:fromRoster', name: '名册一号' }],
      domains: { pm: ['human:fromDomains'] },
      members: { pm: ['human:fromLegacyMembers'] },
      bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }],
      tickIntervalMs: 60000,
    },
    requirements: [],
    tasks: [],
    leases: [],
    runs: [],
    counts: { requirements: 0, tasks: 0, leases: 0, runs: 0 },
  }
}

/**
 * What the host does with a save: apply the patch to the configuration, let the
 * roster follow it, and report the derived sender mapping. Enough for the page
 * to refresh from the response the way it does in production.
 */
function postResult(body, state) {
  const patch = body.patch ?? {}
  const previous = state.config.config
  const config = { ...previous }
  if (patch.bots !== undefined) config.bots = patch.bots
  if (patch.members !== undefined) config.members = patch.members
  const enabledOf = (id) => {
    const bot = (config.bots ?? []).find((item) => item && item.id === id)
    return bot === undefined ? null : bot.enabled === true
  }
  const openIdOf = (key) => {
    const member = (config.members ?? []).find((item) => item && item.key === key)
    return member === undefined ? null : member.openId ?? ''
  }
  const roster = {
    ...state.config.roster,
    bots: (state.config.roster?.bots ?? []).map((bot) => {
      const enabled = enabledOf(bot.id)
      return enabled === null ? bot : { ...bot, enabled }
    }),
    members: (state.config.roster?.members ?? []).map((member) => {
      const openId = openIdOf(member.key)
      return openId === null ? member : { ...member, openId }
    }),
  }
  let sendersAdded = []
  if (patch.members !== undefined && patch.members[1] !== undefined) {
    sendersAdded = [{ openId: patch.members[1].openId, principal: patch.members[1].key }]
  }
  state.config = { ...state.config, config, roster }
  return {
    ok: true,
    applied: Object.keys(patch),
    backup: '/Users/x/.dsh/team/config.json.bak-1',
    config,
    problems: [],
    diagnostics: state.config.diagnostics,
    roster,
    sessions: state.config.sessions,
    derived: { sendersAdded },
  }
}

/** Mount the panel exactly the way the platform does, over a stubbed fetch. */
async function mountConsole(overrides = {}) {
  const { JSDOM, require: localRequire } = harness
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  /*
   * React reports missing keys, uncontrolled-to-controlled inputs and invalid
   * props on console.error — the class of bug that otherwise only shows up in a
   * browser console. Captured for the whole mount and asserted at the end of
   * each test; `unmount()` puts the real one back.
   */
  const warnings = []
  const realConsoleError = console.error
  console.error = function () {
    warnings.push(Array.prototype.map.call(arguments, String).join(' '))
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Element = dom.window.Element
  globalThis.Node = dom.window.Node
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const React = localRequire('react')
  const ReactDOMClient = localRequire('react-dom/client')
  const act = typeof React.act === 'function' ? React.act : localRequire('react-dom/test-utils').act

  const state = {
    /* `??` would treat an explicit `sessions: null` as "not given" — and that
       override is exactly the malformed-response case this harness has to be
       able to produce. */
    config: {
      ...configSnapshot(),
      sessions: Object.prototype.hasOwnProperty.call(overrides, 'sessions') ? overrides.sessions : configSnapshot().sessions,
    },
    ledger: { ...ledgerSnapshot(), config: { ...ledgerSnapshot().config, ...(overrides.ledgerConfig ?? {}) } },
  }
  if (overrides.roster !== undefined) state.config.roster = overrides.roster
  if (overrides.config !== undefined) state.config.config = { ...state.config.config, ...overrides.config }

  const requests = []
  /*
   * An instantly-resolving stub can never show a loading state: by the time the
   * click's `act()` returns, the data is already in. `holdConfig` parks the
   * configuration read until `releaseConfig()` so the page's own "reading…" line
   * can be observed — which is the only way to test that a page reaches it at all
   * rather than sitting there forever.
   */
  let releaseConfig = null
  const configGate = overrides.holdConfig === true
    ? new Promise((resolve) => { releaseConfig = resolve })
    : null
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const method = options.method ?? 'GET'
    requests.push({ url: target, method, body: options.body })
    if (configGate !== null && target.includes('/api/team/config') && method === 'GET') await configGate
    let payload
    if (target.includes('/api/team/config')) {
      payload = method === 'POST' ? postResult(JSON.parse(String(options.body)), state) : state.config
    } else if (target.includes('/api/team/ledger') && method === 'POST') {
      // 台账路由的动作：host 的成功应答里有 `what`（人话）与 `id`。
      const body = JSON.parse(String(options.body))
      payload = body.action === 'set_primary_bot'
        ? { ok: true, id: body.id, what: '这个群的主机器人已改成 开发机器人（dev）' }
        : { ok: true, ...state.ledger }
    } else {
      payload = state.ledger
    }
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
  }

  let definition = null
  const source = readFileSync(CLIENT, 'utf8')
  const loaderWindow = { __ModuleLoader__: { load: (def) => { definition = def } } }
  const run = new Function('window', 'document', 'require', 'globalThis', 'fetch', 'setTimeout', 'clearTimeout', source)
  run(loaderWindow, dom.window.document, (id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  }, { window: dom.window, document: dom.window.document }, globalThis.fetch, setTimeout, clearTimeout)
  assert.notEqual(definition, null)

  const exports = definition.factory((id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  })
  let Panel = null
  exports.apply({
    slots: {
      inject: (slot, factory) => factory(),
      register: (registration, component) => {
        if (registration.name === 'main') Panel = component
        return () => {}
      },
    },
  })
  assert.equal(typeof Panel, 'function')

  const container = dom.window.document.getElementById('root')
  const root = ReactDOMClient.createRoot(container)
  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  await act(async () => { root.render(React.createElement(Panel, {})) })
  await flush()

  const text = () => container.textContent ?? ''
  const buttons = () => [...container.querySelectorAll('button')]
  const tab = (label) => buttons().find((button) => button.textContent === label)
  const click = async (node) => {
    await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    await flush()
  }
  const openTab = async (label) => {
    const node = tab(label)
    assert.notEqual(node, undefined, 'the tab strip offers ' + label)
    await click(node)
  }
  const activeTabs = () => buttons().filter((button) => button.className.includes('teamled-tab-active')).map((button) => button.textContent)
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  /** 下拉框：`type()` 用的是 input 的 value setter，对 <select> 不适用。 */
  const pick = async (select, value) => {
    const setSelect = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    await act(async () => {
      setSelect.call(select, value)
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await flush()
  }
  const type = async (input, value) => {
    await act(async () => {
      setValue.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await flush()
  }

  const unmount = async () => {
    await act(async () => { root.unmount() })
    console.error = realConsoleError
  }
  const assertNoWarnings = () => {
    assert.deepEqual(warnings, [], 'React logged a warning while this page was mounted (keys / controlled inputs / props)')
  }

  return {
    dom, container, root, act, flush, text, buttons, tab, click, openTab, activeTabs, requests, type, pick,
    warnings, unmount, assertNoWarnings,
    releaseConfig: () => { if (releaseConfig !== null) releaseConfig() },
  }
}

test('the 机器人 page draws the roster, shows the host problems verbatim, and submits the whole bots list', { skip }, async () => {
  const app = await mountConsole()
  await app.openTab('机器人')
  assert.deepEqual(app.activeTabs(), ['机器人'], 'exactly one tab is lit')

  const gets = app.requests.filter((r) => r.url.includes('/api/team/config') && r.method === 'GET')
  assert.equal(gets.length, 1, 'the three roster pages share one read of /api/team/config')

  const rendered = app.text()
  assert.match(rendered, /机器人（2）/)
  // The columns the operator asked for, in order.
  assert.deepEqual(
    [...app.container.querySelectorAll('th')].map((th) => th.textContent),
    ['id', '显示名', '角色', '基准角色', '飞书应用', '所在群', '配置问题', '状态', '操作'],
  )
  assert.match(rendered, /需求机器人/)
  assert.match(rendered, /开发机器人/)
  // An empty `chats` means "every chat", which is not the same as "no chat".
  assert.match(rendered, /全部群/)
  assert.match(rendered, /oc_a、oc_b/)
  // Problems are the host's text, with their field names, at their own level.
  assert.match(rendered, /feishu\.appId：这个 appId 在 feishu\.apps 里找不到/)
  assert.match(rendered, /feishu\.chats：群 oc_b 里机器人不在/)
  assert.match(rendered, /已启用/)
  assert.match(rendered, /已停用/)
  // Enabled-but-offline is its own block, with the host's reason spelled out.
  assert.match(rendered, /1 个机器人启用了却上不了线/)
  assert.match(rendered, /req：应用 cli_app1… 没有 appSecret：在「配置」里为它填一个密钥/)
  // And the live connection state sits next to the switch state.
  assert.match(rendered, /未连接/)

  const toggles = app.buttons().filter((button) => ['启用', '停用'].includes(button.textContent))
  assert.equal(toggles.length, 2, 'one toggle per bot')
  assert.equal(toggles[1].disabled, false, 'with an actor and `bots` in editable, the switch is clickable')
  assert.equal(toggles[0].textContent, '停用', 'req is enabled, so its button offers the opposite')
  assert.equal(toggles[1].textContent, '启用', 'dev is disabled')

  assert.equal(app.requests.filter((r) => r.method === 'POST').length, 0, 'drawing a page must not write anything')
  await app.click(toggles[1])

  const posts = app.requests.filter((r) => r.method === 'POST')
  assert.equal(posts.length, 1, 'exactly one save went out')
  const body = JSON.parse(String(posts[0].body))
  // The actor defaults to the roster's first member — not the domain map's, not
  // the legacy `members.pm`, and not defaultOwner.
  assert.equal(body.actor, 'human:fromRoster', 'the actor comes from config.memberList[0].key')
  assert.deepEqual(
    Object.keys(body.patch),
    ['bots'],
    'the bot toggle writes `bots` and nothing else',
  )
  assert.equal(body.patch.bots.length, 2, 'the whole list is submitted, not just the changed bot')
  assert.equal(body.patch.bots[1].enabled, true, 'dev was switched on')
  assert.equal(body.patch.bots[0].enabled, true, 'the untouched bot keeps its value')
  assert.deepEqual(body.patch.bots[1].feishu.chats, ['oc_a', 'oc_b'], 'sibling keys survive a group write')

  // The response refreshes the page: the button now offers the other way round.
  assert.match(app.text(), /启用 dev：已保存/)
  assert.match(app.text(), /applied: bots/)
  assert.equal(
    app.buttons().filter((button) => ['启用', '停用'].includes(button.textContent))[1].textContent,
    '停用',
    'the page shows the state the host confirmed',
  )

  /* ---- 会话 page, same mount: no second read ---- */
  await app.openTab('会话')
  assert.deepEqual(app.activeTabs(), ['会话'])
  assert.equal(app.requests.filter((r) => r.url.includes('/api/team/config') && r.method === 'GET').length, 1, 'switching pages does not re-read')
  const sessions = app.text()
  assert.match(sessions, /机器人会话（2）/)
  // Grouped by bot, headed by the display name from the roster.
  assert.match(sessions, /需求机器人/)
  assert.match(sessions, /开发机器人/)
  assert.match(sessions, /需求群/)
  assert.match(sessions, /开发群/)
  assert.match(sessions, /轮次 3/)
  assert.match(sessions, /轮次 7/)
  assert.match(sessions, /team-feishu-oc_a/)
  assert.match(sessions, /workspace \/Users\/x\/\.dsh\/team\/workspace/)
  // A private chat and a group are told apart, because "which chat is this" is
  // the first thing a session id alone cannot answer.
  assert.match(sessions, /私聊/)
  assert.match(sessions, /群/)

  app.assertNoWarnings()
  await app.unmount()
})

test('the 成员 page binds an openId by submitting the whole members list', { skip }, async () => {
  const app = await mountConsole()
  await app.openTab('成员')
  assert.deepEqual(app.activeTabs(), ['成员'])

  const rendered = app.text()
  assert.match(rendered, /成员（2）/)
  assert.match(rendered, /human:wangmengfan/)
  assert.match(rendered, /human:zhouyu/)
  // The member's own problem is shown with its field, in the host's words.
  assert.match(rendered, /openId：这个成员还没有绑定飞书 open_id/)
  // The unbound senders note: existing mappings whose principal is no longer a
  // member. The host reports them instead of pruning them, and the note has to
  // say so — "we deleted it for you" and "you decide" are different promises.
  assert.match(rendered, /没归属的发送者映射（roster\.senders\.unbound，1）/)
  assert.match(rendered, /这些是 senders 里【已经存在】的映射，但它们指向的 principal 现在不在成员名册里/)
  assert.match(rendered, /host 只报告、不自动清理/)
  assert.match(rendered, /ou_zzz/)
  assert.match(rendered, /配置里没有这个身份/)

  const inputs = () => [...app.container.querySelectorAll('input.teamroster-openid')]
  assert.equal(inputs().length, 2, 'one openId field per member')
  assert.equal(inputs()[0].value, 'ou_847e', 'the bound openId is shown')
  assert.equal(inputs()[1].value, '', 'the unbound member shows an empty field')

  const saveButtons = () => app.buttons().filter((button) => button.textContent === '保存 openId')
  assert.equal(saveButtons().length, 2)
  assert.equal(saveButtons()[1].disabled, true, 'nothing changed yet, so there is nothing to save')

  await app.type(inputs()[1], 'ou_newid')
  assert.equal(saveButtons()[1].disabled, false, 'a changed openId can be saved')
  assert.equal(saveButtons()[0].disabled, true, 'the untouched member stays untouched')

  await app.click(saveButtons()[1])
  const posts = app.requests.filter((r) => r.method === 'POST')
  assert.equal(posts.length, 1)
  const body = JSON.parse(String(posts[0].body))
  assert.equal(body.actor, 'human:fromRoster')
  assert.deepEqual(Object.keys(body.patch), ['members'], 'the binding writes `members` and nothing else')
  assert.equal(body.patch.members.length, 2, 'the whole list is submitted')
  assert.equal(body.patch.members[1].openId, 'ou_newid')
  assert.equal(body.patch.members[0].openId, 'ou_847e', 'the other member is carried over unchanged')
  assert.equal(body.patch.members[1].name, '周宇', 'display fields the host owns are carried over, not dropped')

  // Success: the notice names the derived sender mapping, and the field shows
  // what the host now has (the draft is cleared, not left floating).
  const after = app.text()
  assert.match(after, /human:zhouyu 的 openId：已保存/)
  assert.match(after, /顺便派生了 senders：ou_newid → human:zhouyu/)
  assert.equal(inputs()[1].value, 'ou_newid', 'the field follows the host, not the draft')

  app.assertNoWarnings()
  await app.unmount()
})

test('an empty session list says so, and the ledger actor falls back in order', { skip }, async () => {
  const app = await mountConsole({ sessions: [], ledgerConfig: { memberList: undefined, domains: { pm: ['human:fromDomains'] } } })
  // `memberList` is gone here, so the domain map is next in line.
  const ledgerActor = app.container.querySelector('input.teamled-input')
  assert.equal(ledgerActor.value, 'human:fromDomains', 'memberList, then domains, then the legacy map, then defaultOwner')

  await app.openTab('会话')
  assert.match(app.text(), /还没有任何机器人会话：在群里 @ 一下机器人就会有第一条/)

  app.assertNoWarnings()
  await app.unmount()
})

test('opening a roster page first still loads the read it needs', { skip }, async () => {
  const app = await mountConsole({ holdConfig: true })
  assert.equal(app.requests.filter((r) => r.method === 'GET').length, 1, 'the mount reads the ledger and nothing else')

  /*
   * The 机器人 tab is reached WITHOUT visiting 配置 first. The read used to be
   * triggered by "the config page became active", which would leave every roster
   * page stuck on its loading line forever.
   */
  const node = app.tab('机器人')
  await app.act(async () => { node.dispatchEvent(new app.dom.window.MouseEvent('click', { bubbles: true })) })
  assert.match(app.text(), /读取配置中…/, 'while it is reading, it says so')
  assert.equal(app.text().includes('机器人（'), false, 'and it does not pretend the roster is empty')
  app.releaseConfig()
  await app.flush()
  assert.match(app.text(), /机器人（2）/)
  assert.equal(
    app.requests.filter((r) => r.url.includes('/api/team/config') && r.method === 'GET').length,
    1,
    'and it read the endpoint exactly once',
  )

  app.assertNoWarnings()
  await app.unmount()
})

test('a response that is missing a list says so instead of inventing a page', { skip }, async () => {
  /*
   * "not returned" and "empty" are different sentences. A page that renders an
   * empty table for a missing list is telling the operator there are no bots —
   * a conclusion the host never stated.
   */
  const app = await mountConsole({ roster: null })
  await app.openTab('机器人')
  const rendered = app.text()
  assert.match(rendered, /接口没有返回 roster\.bots/)
  assert.equal(rendered.includes('机器人（0）'), false, 'no roster means no count, not a count of zero')
  assert.equal(app.buttons().some((button) => ['启用', '停用'].includes(button.textContent)), false, 'and no switches to press')
  await app.openTab('成员')
  assert.match(app.text(), /接口没有返回 roster\.members/)
  app.assertNoWarnings()
  await app.unmount()

  const noSessions = await mountConsole({ sessions: null })
  await noSessions.openTab('会话')
  const sessionsText = noSessions.text()
  assert.match(sessionsText, /接口没有返回 sessions/)
  assert.equal(
    sessionsText.includes('还没有任何机器人会话：在群里 @ 一下机器人就会有第一条'),
    false,
    'the empty-state line is a claim about the ledger, not a fallback for a broken response',
  )
  noSessions.assertNoWarnings()
  await noSessions.unmount()
})

test('the 机器人 page edits a bot — including the Feishu app and its secret — and posts both in one patch', { skip }, async () => {
  /*
   * 一台机器人一个飞书应用：app id、密钥、机器人 open_id、所在群都是**这一台**
   * 的属性，所以它们在机器人页编辑，而不是在配置页当全局配置。密钥写进哪个键，
   * 取决于这台机器人用的是不是默认应用 —— 一个值只有一个家。
   */
  const app = await mountConsole()
  await app.openTab('机器人')

  const editButton = app.buttons().find((button) => button.textContent === '编辑')
  assert.notEqual(editButton, undefined, 'each row offers an editor')
  await app.click(editButton)

  const rendered = app.text()
  assert.match(rendered, /编辑 req/, 'the editor names the bot it is editing')
  assert.match(rendered, /飞书应用/)
  assert.match(rendered, /应用密钥（cli_app1）/, 'the credential field names the app it belongs to')
  assert.match(rendered, /写进 feishu\.apps\.cli_app1\.appSecret/, 'and says which key a typed secret lands in')
  assert.equal(/默认应用/.test(rendered), false, 'no app is presented as "the default" one: a bot names its app')
  assert.match(rendered, /机器人 open_id（cli_app1）/)
  assert.match(rendered, /所在群/)
  assert.match(rendered, /发言策略/)
  // A brand-new bot's id is editable; an existing one's is not (the row is the identity).
  const idInputs = [...app.container.querySelectorAll('input')].filter((input) => input.value === 'req')
  assert.equal(idInputs.length > 0, true, 'the editor shows the id')
  assert.equal(idInputs[0].readOnly, true, 'and an existing bot cannot be renamed by editing its id')

  const countBefore = app.requests.filter((r) => r.method === 'POST').length
  // 显示名 + 这个默认应用的密钥，一次提交。
  const nameInput = [...app.container.querySelectorAll('input')].find((input) => input.value === '需求机器人')
  assert.notEqual(nameInput, undefined)
  await app.type(nameInput, '需求机器人（改）')
  const secretInput = [...app.container.querySelectorAll('input')].find((input) => input.type === 'password')
  assert.notEqual(secretInput, undefined, 'the credential is a password field')
  assert.equal(secretInput.value, '', 'and it never carries the stored secret')
  assert.match(String(secretInput.placeholder), /已设置|未设置/, 'it says whether one is already set instead')
  await app.type(secretInput, 'new-secret-value')

  const saveButton = app.buttons().find((button) => button.textContent === '保存这台机器人')
  assert.notEqual(saveButton, undefined)
  await app.click(saveButton)

  const posts = app.requests.filter((r) => r.method === 'POST')
  assert.equal(posts.length, countBefore + 1, 'exactly one save went out for the whole edit')
  const body = JSON.parse(String(posts[posts.length - 1].body))
  assert.deepEqual(Object.keys(body.patch).sort(), ['bots', 'feishu'], 'the bot row and its app credential travel together')
  assert.equal(body.patch.bots.length, 2, 'the whole bots list is submitted')
  const edited = body.patch.bots.find((bot) => bot.id === 'req')
  assert.equal(edited.displayName, '需求机器人（改）')
  assert.equal(edited.feishu.chats.length, 0, 'sibling keys survive the group write')
  /*
   * The editor materialises the speak policy on save, and the defaults it writes are
   * exactly the host's own (`onMention` on, `onIntent` off, lease on, digest off):
   * a bot that never had an explicit policy must not be given a different one by
   * merely being edited.
   */
  assert.deepEqual(edited.feishu.speakPolicy, {
    onMention: true, onIntent: false, leaseRequired: true, digestOnly: false,
  })
  /*
   * The secret lands on the app the bot names — ALWAYS, with no "is this the
   * installation app?" branch. One credential, one home: the app entry.
   */
  assert.deepEqual(
    body.patch.feishu,
    { apps: { cli_app1: { appSecret: 'new-secret-value' } } },
    'the secret goes to the app the bot speaks through',
  )

  app.assertNoWarnings()
  await app.unmount()
})

test('the 会话 page shows each group\'s primary bot, and 改主 submits a ledger action', { skip }, async () => {
  /*
   * 用户的要求：**每个群有一个主的机器人，而且主机器人负责这个群所有消息的记录**。
   * 所以这一页要回答"这个群归谁、它记了多少条、什么时候定的主"，并且人能显式改主
   * —— 改主是运行态动作（走台账路由），不是配置写入。
   */
  const app = await mountConsole()
  await app.openTab('会话')

  const rendered = app.text()
  assert.match(rendered, /群与主机器人（2）/)
  // 群 → 主（名字 + id + 定于）
  assert.match(rendered, /需求群/)
  assert.match(rendered, /需求机器人/)
  assert.match(rendered, /req · 定于/)
  // 消息数与轮次分开显示：主机器人记的条数本来就多于它回答过的轮次。
  assert.match(rendered, /12 \/ 3/)
  // 还没有消息的群没有主，并且说清楚为什么（而不是画一个空下拉让人猜）。
  assert.match(rendered, /（还没有主：群里还没有消息）/)

  const tables = [...app.container.querySelectorAll('table')]
  const chatTable = tables.find((table) => String(table.textContent).includes('主机器人'))
  assert.notEqual(chatTable, undefined, '群表在会话页上')
  assert.deepEqual(
    [...chatTable.querySelectorAll('th')].map((th) => th.textContent),
    ['群', '主机器人', '消息 / 轮次', '上次活动', '改主'],
  )

  // 选一个新的主 → 改主按钮才可用 → 点它 → 发一条台账动作
  const selects = [...chatTable.querySelectorAll('select')]
  assert.equal(selects.length, 2, '每个群一个下拉')
  const changeButtons = [...chatTable.querySelectorAll('button')].filter((b) => b.textContent === '改主')
  assert.equal(changeButtons[0].disabled, true, '没选新主时按钮是禁用的')
  await app.pick(selects[0], 'dev')
  assert.equal(changeButtons[0].disabled, false, '选了不同的主之后就能点')
  await app.click(changeButtons[0])

  const posts = app.requests.filter((r) => r.method === 'POST' && r.url.includes('/api/team/ledger'))
  assert.equal(posts.length, 1, '改主走台账路由，不是配置写入')
  const body = JSON.parse(String(posts[0].body))
  assert.equal(body.action, 'set_primary_bot')
  assert.equal(body.id, 'oc_a')
  assert.equal(body.assignee, 'bot:dev')
  assert.equal(body.actor, 'human:fromRoster', 'host 拒绝没有 actor 的写操作，面板把它的 actor 带上')
  // 成功提示用 host 的原话。
  assert.match(app.text(), /这个群的主机器人已改成 开发机器人（dev）/)

  app.assertNoWarnings()
  await app.unmount()
})
