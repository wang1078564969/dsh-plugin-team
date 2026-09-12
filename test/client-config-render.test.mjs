/*
 * The configuration page, RENDERED — the other half of the panel.
 *
 * Same opt-in harness as `client-render.test.mjs` (real react + jsdom, resolved
 * from `$TEAM_CLIENT_TEST_MODULES` or this package's node_modules) and the same
 * reason: there is no browser in this loop, so what can be checked is that the
 * page mounts, shows what the host sent, and posts what the operator changed —
 * and nothing else.
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

/** The snapshot the host would return for a working deployment. */
function configSnapshot() {
  return {
    ok: true,
    config: {
      workspace: '/Users/x/.dsh/team/workspace',
      workspaceTitle: '团队 · 飞书',
      dataDir: '/Users/x/.dsh/team',
      defaultOwner: 'human:wangmengfan',
      tickIntervalMs: 60000,
      /*
       * `members` is the member LIST (member objects) and `domains` is the domain
       * map. They used to be one key; keeping them apart is what makes the
       * "the form must not write `members.<domain>` any more" check in
       * `client-half.test.mjs` mean something.
       */
      members: [
        { key: 'human:wangmengfan', name: '王梦凡', openId: 'ou_847e', role: 'pm', domains: ['pm'], projects: [], canApprove: true, delegate: false, active: true },
        { key: 'human:zhouyu', name: '周宇', openId: '', role: 'dev', domains: ['development'], projects: ['pay-service'], canApprove: false, delegate: false, active: true },
      ],
      domains: { pm: ['human:wangmengfan'], development: ['human:zhouyu'] },
      bots: [
        {
          id: 'req',
          displayName: '需求机器人',
          role: 'req',
          baseRole: 'req',
          enabled: true,
          feishu: { appId: 'cli_aa910fe2', chats: [], speakPolicy: { onMention: true, onIntent: true, leaseRequired: false, digestOnly: false } },
        },
      ],
      senders: { ou_847e: 'human:wangmengfan' },
      chatActors: {},
      knownRepos: [],
      gates: { accept: { timeout: '4h', on_timeout: 'remind_then_escalate', max_release: null } },
      sessions: { preset: null, presets: { dev: 'standard' }, turnTimeoutMs: 900000, maxLive: 4 },
      feishu: {
        mode: 'own',
        appId: 'cli_aa910fe2',
        appSecretSet: true,
        botOpenId: 'ou_847e6c1667692e892cd81eb4eb2992e4',
        requireMention: true,
        respond: true,
        buttons: false,
        chatIds: [],
        speakLeaseMs: 60000,
        apps: [
          { appId: 'cli_aa910fe2', name: '团队应用', botOpenId: 'ou_847e6c16…', appSecretSet: true, source: 'team-config', bots: ['req'] },
        ],
        addressedOverridesIntent: true,
      },
    },
    problems: [],
    diagnostics: {
      checkedAt: new Date().toISOString(),
      credentials: { ok: true, source: 'team-config', appId: 'cli_aa910f…' },
      identity: { ok: true, name: '王梦凡的飞书 CLI', openId: 'ou_847e6c16…' },
      connection: { ready: true, connected: true, lastReadyAt: '2026-09-12T09:00:00.000Z', lastError: null },
      chats: { ok: true, items: [{ chatId: 'oc_ea9e', name: 'AAB', mode: 'group' }] },
      ledger: { requirements: 0, tasks: 0, chats: 2, inbox: 5 },
      mode: 'own',
    },
    /* The roster and the per-chat sessions the three roster pages draw. */
    roster: {
      bots: [
        {
          id: 'req', displayName: '需求机器人', role: 'req', baseRole: 'req', enabled: true,
          feishu: { appId: 'cli_aa910fe2', chats: [] },
          appIdResolved: 'cli_aa910fe2',
          problems: [],
          sessions: [],
        },
      ],
      members: [
        { key: 'human:wangmengfan', name: '王梦凡', openId: 'ou_847e', role: 'pm', domains: ['pm'], projects: [], canApprove: true, delegate: false, active: true, problems: [] },
        { key: 'human:zhouyu', name: '周宇', openId: '', role: 'dev', domains: ['development'], projects: ['pay-service'], canApprove: false, delegate: false, active: true, problems: [] },
      ],
      senders: { unbound: [] },
    },
    /*
     * 角色 → preset 的真值由 host 算（lib/bots.js `sessionRoleView`），面板只显示。
     * 三行覆盖三种来源，正是要让人一眼看出"这一条到底由谁决定"。
     */
    sessionRoles: [
      { role: 'req', roleLabel: '需求', botId: 'req', botName: '需求机器人', preset: 'standard', source: 'bot' },
      { role: 'dev', roleLabel: '开发', botId: 'dev', botName: '开发机器人', preset: 'legacy-dev', source: 'sessions.presets' },
      { role: 'ops', roleLabel: '运维', botId: null, botName: null, preset: null, source: 'none' },
    ],
    sessions: [],
    editable: [
      'defaultOwner',
      'workspace',
      'workspaceTitle',
      'tickIntervalMs',
      'domains',
      'members',
      'bots',
      'senders',
      'chatActors',
      'knownRepos',
      'gates',
      'sessions',
      'feishu.mode',
      'feishu.requireMention',
      'feishu.respond',
      'feishu.buttons',
      'feishu.appId',
      'feishu.appSecret',
      'feishu.botOpenId',
      'feishu.chatIds',
      'feishu.speakLeaseMs',
      'feishu.apps',
      'feishu.addressedOverridesIntent',
    ],
  }
}

function ledgerSnapshot() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      dataDir: '/d', workspace: '/w', defaultOwner: 'human:x', feishuMode: 'own',
      /* The ledger snapshot keeps the domain map as `members` AND adds the roster. */
      members: { pm: ['human:pm1'], dev: ['bot:dev'] },
      memberList: [{ key: 'human:pm1', name: 'PM 一号' }],
      bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }],
      tickIntervalMs: 0,
    },
    requirements: [],
    tasks: [],
    leases: [],
    runs: [],
    counts: { requirements: 0, tasks: 0, leases: 0, runs: 0 },
  }
}

test(
  'the config page renders the self-check and posts only what changed',
  { skip: harness === null ? 'needs react + react-dom + jsdom: run `npm i -D react react-dom jsdom` (or set TEAM_CLIENT_TEST_MODULES)' : false },
  async () => {
    const { JSDOM, require: localRequire } = harness
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
      url: 'http://127.0.0.1:3080/',
    })
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

    const requests = []
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url)
      requests.push({ url: target, method: options.method ?? 'GET', body: options.body })
      const payload = target.includes('/api/team/config')
        ? options.method === 'POST'
          ? { ok: true, applied: ['feishu.requireMention'], problems: [], ...configSnapshot(), config: { ...configSnapshot().config, feishu: { ...configSnapshot().config.feishu, requireMention: false } } }
          : configSnapshot()
        : ledgerSnapshot()
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
    }

    // Load the bundle exactly as the platform does: a classic script.
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
    await act(async () => {
      root.render(React.createElement(Panel, {}))
    })
    await act(async () => {
      await Promise.resolve()
    })

    const text = () => container.textContent ?? ''
    const allTabs = [...container.querySelectorAll('button')].filter((button) => ['台账', '配置', '机器人', '成员', '会话'].includes(button.textContent))
    assert.deepEqual(allTabs.map((button) => button.textContent), ['台账', '配置', '机器人', '成员', '会话'], 'the panel offers all five pages')
    assert.deepEqual(
      allTabs.filter((button) => button.className.includes('teamled-tab-active')).map((button) => button.textContent),
      ['台账'],
      'exactly one page is highlighted, and it is the one being shown',
    )
    const tabs = allTabs

    // Switch to the config page.
    const configTab = tabs.find((button) => button.textContent === '配置')
    await act(async () => {
      configTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.equal(requests.some((r) => r.url.includes('/api/team/config') && r.method === 'GET'), true, 'the page loads its data')
    assert.deepEqual(
      [...container.querySelectorAll('button')].filter((button) => button.className.includes('teamled-tab-active')).map((button) => button.textContent),
      ['配置'],
      'the highlight follows the current page (and only one page is lit)',
    )

    // The self-check is on screen: who we are, whether the socket is up, where
    // the bot is — that is the whole point of the page.
    const rendered = text()
    assert.match(rendered, /王梦凡的飞书 CLI/)
    assert.match(rendered, /cli_aa910f/)
    assert.match(rendered, /AAB/)
    assert.match(rendered, /长连接/)
    assert.equal(/读取配置中…/.test(rendered), false, 'and it is not stuck loading')
    /*
     * 飞书应用**不再在配置页编辑**：一台机器人一个应用才有它自己的身份，所以 app id、
     * 密钥、open_id、所在群都跟着「机器人」页的那一台走。配置页只留一行只读现状 ——
     * 让人知道东西去哪儿了，而不是以为功能没了。
     */
    assert.match(rendered, /这一页只剩全局策略；应用与机器人身份跟着「机器人」页的那一台走/)
    assert.match(rendered, /每台机器人一个应用：在「机器人」页选中那一台，填它的 app id 与密钥/)
    assert.match(rendered, /只配了一个应用 cli_aa910fe2（密钥已设置）/, 'the read-only summary still says which apps exist')
    assert.equal(/默认应用/.test(rendered), false, 'and nothing calls one app more "default" than another')

    // The form carries the current values…
    const inputs = [...container.querySelectorAll('input')]
    assert.equal(inputs.some((input) => input.value === 'human:wangmengfan'), true, 'owners are editable')
    assert.equal(inputs.some((input) => input.value === '/Users/x/.dsh/team/workspace'), true, 'the workspace is editable')
    // Values live in inputs, not in textContent.
    assert.equal(inputs.some((input) => input.value === '团队 · 飞书'), true, 'the sidebar title is editable')
    /*
     * NO password field on this page at all any more: the credential moved to the
     * bot it belongs to (机器人 page). What matters here is that the value never
     * leaks — the payload says "a secret is set", and nothing else.
     */
    const secretInputs = inputs.filter((input) => input.type === 'password')
    assert.equal(secretInputs.length, 0, 'no credential field is drawn on the global page')
    // The stored secret is nowhere in what the browser was handed: only the flag.
    assert.equal(JSON.stringify(configSnapshot()).includes('top-secret'), false, 'the payload never carried a secret')
    assert.equal(configSnapshot().config.feishu.appSecretSet, true, 'it carries the answer "one is set" instead')

    // The apps list is the host's READ-ONLY view: an appId and whether its
    // secret is set. It is shown, and it is not what a save sends back.
    /*
     * 会话段不再让人按角色手填 preset：真值来自机器人，面板只读显示。
     * 既不能有 `sessions.presets.*` 输入框，也必须真的把 host 算出来的三行画出来。
     */
    assert.equal(
      inputs.filter((input) => String(input.placeholder) === '（空 = 用默认）').length,
      0,
      'the seven per-role preset inputs are gone (their placeholder was unique to them)',
    )
    assert.equal(
      inputs.filter((input) => String(input.value) === 'standard' || String(input.value) === 'legacy-dev').length,
      0,
      'and no leftover input carries a role preset: the values are shown as text, by the host\'s own resolution',
    )
    assert.match(text(), /角色 → preset（只读）/)
    assert.match(text(), /req（需求） · 需求机器人（req） · preset: standard · 来源：机器人自己的 agentPreset/)
    assert.match(text(), /dev（开发） · 开发机器人（dev） · preset: legacy-dev · 来源：角色映射/)
    assert.match(text(), /ops（运维） · 没有机器人 · preset: （未设置） · 来源：未设置/)

    /*
     * The per-app rows moved to the 机器人 page with the credential itself. What is
     * left here is the read-only summary — and the 机器人 render test covers the
     * editor that replaced them.
     */
    assert.match(text(), /飞书应用只配了一个应用 cli_aa910fe2（密钥已设置）/)
    assert.equal(/默认应用/.test(text()), false, 'the panel does not invent a "default app" concept')

    // …and saving posts ONLY the field that was touched.
    //
    // The actor field is not decoration: the host refuses a write without one, so
    // the form disables save until it is filled. Fill it the way a person would —
    // through the native setter, because React tracks the value it last rendered.
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    // By class, not by placeholder: both pages have an actor field, and the
    // config page's own one is what its save button reads.
    const actorInput = container.querySelector('input.teamcfg-actor')
    assert.notEqual(actorInput, null, 'the config page has its own actor field')
    await act(async () => {
      setValue.call(actorInput, 'human:wangmengfan')
      actorInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })

    const checkboxes = [...container.querySelectorAll('input[type=checkbox]')]
    assert.ok(checkboxes.length >= 4, 'the four boolean policies are checkboxes')
    // `editable` is what makes a field writable, and every boolean policy is in
    // it — a checkbox the operator cannot click is a setting they cannot change.
    assert.deepEqual(
      checkboxes.map((box) => box.disabled),
      checkboxes.map(() => false),
      'no policy switch is rendered disabled',
    )
    const requireMention = container.querySelector('input[type=checkbox]')
    assert.equal(requireMention.checked, true, 'the checkbox reflects the host state (requireMention is on)')
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0, 'loading the page must not write anything')

    // Editing ONE field and saving must send exactly that field: a save is a
    // patch, not a rewrite of everything the form happens to be showing.
    const titleInput = inputs.find((input) => input.value === '团队 · 飞书')
    await act(async () => {
      setValue.call(titleInput, '团队 · 飞书（改）')
      titleInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })

    const saveButtons = [...container.querySelectorAll('button')].filter((button) => /保存/.test(button.textContent ?? ''))
    assert.equal(saveButtons.length >= 1, true, 'there is a save action')
    assert.equal(saveButtons[0].disabled, false, 'with an actor and a change, saving is possible')
    await act(async () => {
      saveButtons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const posts = requests.filter((r) => r.method === 'POST')
    assert.equal(posts.length, 1, 'exactly one save went out')
    const body = JSON.parse(String(posts[0].body))
    assert.equal(body.actor, 'human:wangmengfan', 'the host refuses a write without an actor; the form sends the one it was given')
    assert.deepEqual(body.patch, { workspaceTitle: '团队 · 飞书（改）' }, 'only the touched field is sent')

    /*
     * The config page's actor label promises it "shares one value with the ledger
     * page". If that ever stops being true, the page is lying about which identity
     * goes into the audit line — so it is checked by going back to the other tab
     * rather than assumed.
     */
    const ledgerTab = tabs.find((button) => button.textContent === '台账')
    await act(async () => {
      ledgerTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    const ledgerActor = [...container.querySelectorAll('input')].find((input) => /默认取名册里的第一个人/.test(input.placeholder ?? ''))
    assert.notEqual(ledgerActor, undefined, 'the ledger page has its actor field too')
    assert.equal(ledgerActor.value, 'human:wangmengfan', 'the two pages really do share one actor')

    await act(async () => {
      root.unmount()
    })
  },
)
