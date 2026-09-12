/*
 * The browser half, RENDERED — not just loaded.
 *
 * `test/client-half.test.mjs` proves the loader contract; this file proves the
 * panel actually works: real `react` + `react-dom` + a real DOM (jsdom), the
 * bundle loaded as the classic script it is, effects run, buttons clicked, and
 * the request bodies checked one by one — including what a refusal looks like on
 * screen and whether unmounting leaves listeners behind.
 *
 * OPT-IN ON PURPOSE. This package ships with zero runtime dependencies, and that
 * is a property worth keeping: a test-only need must not turn into an install
 * requirement. So the harness resolves `react`, `react-dom` and `jsdom` from,
 * in order:
 *
 *   1. $TEAM_CLIENT_TEST_MODULES  (any directory with a node_modules beside it)
 *   2. this package's own node_modules — `npm i -D react react-dom jsdom`
 *
 * and SKIPS with that instruction when none is found. `node --test` reports the
 * skip; it never reports a false green.
 *
 * The checks were written against react 18.3.1, the version DSH itself ships.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')

/** Resolve the render harness, or report why it is unavailable. */
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
      return { require: localRequire, JSDOM: jsdom.JSDOM, base }
    } catch (error) {
      /* try the next base */
    }
  }
  return null
}

const harness = loadHarness()

test(
  'the panel renders, reacts, and posts the bodies the host expects',
  { skip: harness === null ? 'needs react + react-dom + jsdom: run `npm i -D react react-dom jsdom` (or set TEAM_CLIENT_TEST_MODULES)' : false },
  async () => {
    const { failures, checks } = await runChecks(harness)
    assert.ok(checks >= 50, 'the harness must actually run its checks, not silently do nothing')
    assert.equal(failures, 0, failures + ' of ' + checks + ' panel checks failed — the list is printed above')
  },
)

/**
 * The harness itself. Kept as one function so a skipped run touches neither the
 * DOM globals nor `react-dom`, which reads `window` at import time.
 */
async function runChecks({ JSDOM, require }) {
  /*
   * `require` is a PARAMETER here, not the module-scope CommonJS one: an ES
   * module has none, and the harness needs the platform's module list anyway
   * (the bundle is loaded with a `require` that only knows `react`).
   */
  /* react-dom 会读全局 window/document，所以先把 jsdom 装到全局上再 require 它 */
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

  const React = require('react')
  const ReactDOMClient = require('react-dom/client')
  const act = typeof React.act === 'function' ? React.act : require('react-dom/test-utils').act

  let failures = 0
  let checks = 0
  function ok(condition, label, extra) {
    checks += 1
    if (condition === true) {
      console.log('  ✓ ' + label)
    } else {
      failures += 1
      console.log('  ✗ ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
    }
  }
  function section(title) {
    console.log('\n### ' + title)
  }

  /* ---------------- 假环境 ---------------- */

  const { document } = dom.window

  const requests = []
  let queue = []
  let releaseDeferred = null
  function fakeFetch(url, options) {
    requests.push({ url, options })
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected fetch: ' + options.method + ' ' + url)
    if (next.networkError === true) return Promise.reject(new Error(next.message))
    if (next.deferred === true) {
      return new Promise((resolve) => { releaseDeferred = resolve })
    }
    return Promise.resolve({
      status: next.status === undefined ? 200 : next.status,
      json: () => (next.notJson === true
        ? Promise.reject(new Error('not json'))
        : Promise.resolve(next.payload)),
    })
  }

  const source = readFileSync(CLIENT, 'utf8')
  let captured = null
  const windowStub = { __ModuleLoader__: { load: (definition) => { captured = definition } } }

  function loadClassicScript(overrides) {
    const setTimer = overrides !== undefined && typeof overrides.setTimeout === 'function' ? overrides.setTimeout : setTimeout
    const run = new Function(
      'window', 'document', 'require', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      source,
    )
    run(
      windowStub,
      document,
      (id) => {
        if (id === 'react') return React
        throw new Error('the module required something other than react: ' + id)
      },
      fakeFetch,
      setTimer,
      clearTimeout,
      setInterval,
      clearInterval,
    )
    return captured
  }

  /* ---------------- 1. 包装约定 ---------------- */

  section('1. __ModuleLoader__ 包装（经典脚本）')
  ok(source.indexOf('\nimport ') < 0 && !/^export /m.test(source) && !/\bexport (default|const|function)/.test(source), '源码里没有顶层 import / export')
  const definition = loadClassicScript()
  ok(definition !== null && definition.id === 'dsh-plugin-team', 'id 是包名 dsh-plugin-team', definition && definition.id)
  ok(typeof definition.factory === 'function', 'factory 是函数')
  const mod = definition.factory((id) => { if (id === 'react') return React; throw new Error('require ' + id) })
  ok(mod !== null && typeof mod === 'object', 'factory 返回 module.exports')
  ok(typeof mod.apply === 'function', 'module.exports.apply 存在')
  ok(Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'slots', 'module.exports.inject === ["slots"]', JSON.stringify(mod.inject))
  ok(mod.__esModule === undefined && mod.default === undefined, '没有设置 __esModule（不会解包成 undefined）')
  const styles = document.querySelectorAll('style[data-plugin-css="dsh-plugin-team/client.css"]')
  ok(styles.length === 1, 'CSS 注入了一个 data-plugin-css 标签', styles.length)
  ok(styles.length === 1 && styles[0].textContent.indexOf('--dsw-alias-label-primary') >= 0, 'CSS 用的是主题变量')
  ok(styles.length === 1 && !/#[0-9a-fA-F]{3,6}\b/.test(styles[0].textContent), 'CSS 里没有写死的 #rrggbb 颜色', (styles[0].textContent.match(/#[0-9a-fA-F]{3,6}\b/) || [])[0])
  /* 第二次加载同一个 factory 不能重复注入 */
  loadClassicScript()
  ok(document.querySelectorAll('style[data-plugin-css="dsh-plugin-team/client.css"]').length === 1, '第二次执行 factory 不会重复注入 CSS')

  /* ---------------- 2. 两个槽的注册参数 ---------------- */

  section('2. 槽注册（sidebar.panellist / main）')
  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, factory) => { injections.push({ name, factory }); return () => {} },
      register: (options, Component) => { registrations.push({ options, Component }); return { dispose: () => {} } },
    },
  }
  mod.apply(ctx)
  ok(injections.length === 2, 'inject 了两次', injections.length)
  ok(injections[0] && injections[0].name === 'sidebar.panellist', '第一个是 sidebar.panellist', injections[0] && injections[0].name)
  ok(injections[1] && injections[1].name === 'main', '第二个是 main', injections[1] && injections[1].name)
  const disposers = injections.map((item) => item.factory())
  ok(disposers.length === 2 && disposers.every((d) => d !== undefined && typeof d.dispose === 'function'), '两个 inject 回调都返回了注册句柄')
  ok(registrations.length === 2, 'register 了两次', registrations.length)
  const sidebarOptions = registrations[0].options
  const mainOptions = registrations[1].options
  ok(sidebarOptions.name === 'sidebar.panellist' && sidebarOptions.id === 'team' && sidebarOptions.order === 40 && sidebarOptions.label === '团队台账',
    'sidebar.panellist = {name, id:"team", order:40, label:"团队台账"}', JSON.stringify(sidebarOptions))
  ok(Object.keys(sidebarOptions).length === 4, 'sidebar.panellist 只带 4 个键（没有 icon 字段）', Object.keys(sidebarOptions).join(','))
  ok(mainOptions.name === 'main' && mainOptions.key === 'team' && Object.keys(mainOptions).length === 2,
    'main = {name:"main", key:"team"}', JSON.stringify(mainOptions))
  ok(typeof registrations[0].Component === 'function' && typeof registrations[1].Component === 'function', '两个槽都注册了组件')

  /* 侧栏图标组件：只读 props.size，不写死颜色 */
  const glyph = registrations[0].Component
  const glyphTree = glyph({ size: 16, active: true })
  const glyphHtml = renderToHtml(glyphTree)
  ok(glyphTree.type === 'svg' && glyphTree.props.width === 16 && glyphTree.props.height === 16, '侧栏图标按 props.size 出 16×16 的 svg')
  ok(glyphHtml.indexOf('currentColor') >= 0, '侧栏图标用 currentColor（跟随主题）')
  ok(glyph({}) !== null, '侧栏图标没有 props 也不炸')

  function renderToHtml(element) {
    /* 只需要把 createElement 出来的普通元素串成字符串，够断言用 */
    if (element === null || element === undefined || element === false) return ''
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map(renderToHtml).join('')
    if (typeof element.type === 'function') return renderToHtml(element.type(element.props))
    const { type, props } = element
    const attrs = Object.keys(props)
      .filter((key) => key !== 'children' && key !== 'key')
      .map((key) => ' ' + key + '="' + String(props[key]) + '"')
      .join('')
    const children = props.children === undefined ? [] : (Array.isArray(props.children) ? props.children : [props.children])
    return '<' + type + attrs + '>' + children.map(renderToHtml).join('') + '</' + type + '>'
  }

  /* ---------------- 3. 数据契约：正常快照 → 渲染 ---------------- */

  section('3. 正常快照渲染')

  function snapshot(overrides) {
    const base = {
      ok: true,
      generatedAt: '2026-01-02T03:04:05.000Z',
      config: {
        dataDir: '/tmp/team-data',
        workspace: '/Users/nitoo/Desktop/DSH 飞书插件',
        defaultOwner: 'human:fallback',
        feishuMode: 'bridge',
        members: { pm: ['human:pm1'], dev: ['bot:dev'] },
        tickIntervalMs: 60000,
      },
      requirements: [{
        id: 'req-2026-001',
        title: '导出 CSV',
        state: 'dispatched',
        owner: 'human:pm1',
        requester: 'human:boss',
        priority: 'P1',
        type: 'feature_delivery',
        origin: 'feishu',
        chat_id: 'oc_abc',
        acceptance_criteria: ['能导出', '字段齐全'],
        tasks: ['task-1'],
        body: { problem: '现在只能截图', proposal: '加一个导出按钮' },
        // 状态机允许什么，面板就画什么（host 的 `available`）
        available: ['confirm_split', 'suspend', 'drop', 'change'],
        history: [{ from: 'draft', to: 'confirmed', by: 'human:pm1', at: '2026-01-01T10:00:00.000Z', effects: [] }],
      }],
      tasks: [{
        id: 'task-1',
        req: 'req-2026-001',
        title: '实现导出',
        state: 'assigned',
        type: 'feature_delivery',
        domains: ['development'],
        assignee: 'bot:dev',
        owner: 'human:pm1',
        acceptance_criteria: ['能导出'],
        repo: null,
        branch: null,
        release_count: 2,
        blocked_reason: null,
        gates: '✅ 接受已确认 · ⏳ 待开始确认 · ⏳ 待验收',
        gate_detail: {
          accept: { required_by: ['bot:dev'], confirmed_by: [{ by: 'bot:dev', at: '2026-01-02T02:00:00.000Z' }], due_at: null, not_applicable: true, timeout_snapshot: 'PT30M', on_timeout: 'release', max_release: 2 },
          start: { required_by: ['bot:dev'], confirmed_by: [], due_at: '2026-01-02T04:00:00.000Z', not_applicable: false, timeout_snapshot: 'PT30M', on_timeout: 'release', max_release: 2 },
          acceptance: { required_by: ['human:pm1'], confirmed_by: [], due_at: null, not_applicable: false, timeout_snapshot: null, on_timeout: null, max_release: null },
        },
        evidence: [{ kind: 'note', ref: 'session:team-task-1', note: '已完成一半，剩下的在下一条消息里说明', at: '2026-01-02T02:30:00.000Z' }],
        available: ['accept', 'start', 'block'],
        lease: { holder: 'bot:dev', state: 'active', expires_at: '2026-01-02T05:00:00.000Z', renewals: 1 },
        history: [],
      }],
      leases: [{ task: 'task-1', holder: 'bot:dev', kind: 'bot', state: 'active', expires_at: '2026-01-02T05:00:00.000Z' }],
      runs: [{ task: 'task-1', session_id: 'team-task-1', turns: 3, role: 'dev', last_used: '2026-01-02T02:30:00.000Z' }],
      counts: { requirements: 1, tasks: 1, leases: 1, runs: 1 },
    }
    if (overrides !== undefined) Object.assign(base, overrides)
    return base
  }

  const Panel = registrations[1].Component
  const container = document.getElementById('root')
  const root = ReactDOMClient.createRoot(container)

  function text() {
    return container.textContent || ''
  }
  function button(label) {
    return Array.from(container.querySelectorAll('button')).filter((node) => (node.textContent || '').trim() === label)[0] || null
  }
  function click(node) {
    if (node === null) throw new Error('button not found')
    node.click()
  }

  queue = [{ deferred: true }]
  await act(async () => { root.render(React.createElement(Panel)) })
  ok(text().indexOf('读取台账中…') >= 0, '加载中有明确文案「读取台账中…」（后端挂住时也不停在这句话上，见超时）')
  ok(text().indexOf('团队台账') >= 0, '加载中标题已经在了')

  await act(async () => {
    releaseDeferred({ status: 200, json: () => Promise.resolve(snapshot()) })
  })
  await act(async () => { await Promise.resolve() })
  ok(requests[0].url === '/api/team/ledger' && requests[0].options.method === 'GET', 'GET /api/team/ledger（同源 cookie）', requests[0].url)
  ok(requests[0].options.credentials === 'same-origin', 'GET 带 credentials: same-origin')
  ok(text().indexOf('团队台账') >= 0, '标题「团队台账」')
  ok(text().indexOf('req-2026-001') >= 0 && text().indexOf('导出 CSV') >= 0, '需求 id 与标题')
  ok(text().indexOf('dispatched · 已派发') >= 0, '需求状态标签（原文 + 中文注解）')
  ok(text().indexOf('P1') >= 0, '优先级')
  ok(text().indexOf('负责人 human:pm1') >= 0, '需求 owner')
  ok(text().indexOf('task-1') >= 0 && text().indexOf('实现导出') >= 0, '任务 id 与标题')
  ok(text().indexOf('assigned · 待接受') >= 0, '任务状态标签')
  ok(text().indexOf('执行者 bot:dev') >= 0, 'assignee')
  ok(text().indexOf('✅ 接受已确认 · ⏳ 待开始确认 · ⏳ 待验收') >= 0, 'gates 那一行原样显示')
  ok(text().indexOf('退回 ×2') >= 0, 'release_count > 0 高亮显示')
  ok(text().indexOf('开始：待 bot:dev 确认') >= 0, '门禁明细：还差谁确认')
  ok(text().indexOf('超时 release') >= 0, '门禁明细：超时策略')
  ok(text().indexOf('租约：bot:dev（active）') >= 0 && text().indexOf('已续 1 次') >= 0, '租约 holder + 到期 + 续租次数')
  ok(text().indexOf('证据 1 条') >= 0 && text().indexOf('已完成一半') >= 0, '证据条数 + 最后一条 note 摘要')
  ok(text().indexOf('执行会话 team-task-1') >= 0 && text().indexOf('已 3 轮') >= 0, '执行会话 / 轮次')
  ok(text().indexOf('需求 1') >= 0 && text().indexOf('任务 1') >= 0 && text().indexOf('租约 1') >= 0 && text().indexOf('会话 1') >= 0, 'counts 统计')
  ok(text().indexOf('工作区 /Users/nitoo/Desktop/DSH 飞书插件') >= 0 && text().indexOf('飞书 bridge') >= 0 && text().indexOf('数据目录 /tmp/team-data') >= 0, '配置摘要 workspace / feishuMode / dataDir')
  ok(container.querySelector('.teamled-input').value === 'human:pm1', 'actor 默认取 config.members.pm[0]', container.querySelector('.teamled-input').value)
  ok(button('接受（门禁 1）') !== null, 'available 里的 accept 渲染成按钮')
  ok(button('确认开始（门禁 2）') !== null, 'available 里的 start 渲染成按钮')
  ok(button('提交验收') === null && button('验收通过') === null, 'available 里没有的 submit / verify 不渲染按钮')
  ok(text().indexOf('状态机还允许：block') >= 0, 'available 里本面板没接的动作如实列出')
  ok(button('▶ 执行一轮') !== null, '「执行一轮」常驻且显眼')
  ok(button('扫超时（预演）') !== null, '顶部有「扫超时（预演）」')
  ok(button('刷新') !== null, '顶部有刷新')

  /* 展开需求 */
  await act(async () => { click(container.querySelector('.teamled-reqhead')) })
  ok(text().indexOf('现在只能截图') >= 0 && text().indexOf('加一个导出按钮') >= 0, '展开需求看到 body.problem / body.proposal')
  ok(text().indexOf('能导出') >= 0 && text().indexOf('字段齐全') >= 0, '展开需求看到验收标准')
  ok(text().indexOf('最近历史') >= 0 && text().indexOf('draft → confirmed') >= 0, '展开需求看到历史')

  /* ---------------- 4. 动作：body 与成功渲染 ---------------- */

  section('4. 动作按钮 → POST body')

  async function fire(label, response) {
    const before = requests.length
    queue = [response]
    await act(async () => { click(button(label)) })
    await act(async () => { await Promise.resolve() })
    const request = requests[before]
    let body = null
    try { body = JSON.parse(request.options.body) } catch (error) { body = null }
    return { request, body }
  }

  const run1 = await fire('接受（门禁 1）', { payload: Object.assign({ ok: true, what: '已接受（门禁 1 通过），租约已起', id: 'task-1', state: 'accepted', lease: { holder: 'bot:dev', expires_at: '2026-01-02T05:00:00.000Z' } }, { snapshot: snapshot() }) })
  ok(run1.body !== null && run1.body.action === 'accept_task' && run1.body.id === 'task-1' && run1.body.actor === 'human:pm1',
    'accept → {action:"accept_task", id, actor}', JSON.stringify(run1.body))
  ok(run1.request.options.method === 'POST' && run1.request.options.headers['content-type'] === 'application/json', 'POST + content-type')
  ok(text().indexOf('已接受（门禁 1 通过），租约已起') >= 0, '成功回执里的 what 被显示')
  ok(text().indexOf('租约：bot:dev') >= 0, '成功回执里的租约被显示')

  const run2 = await fire('▶ 执行一轮', { payload: Object.assign({ ok: true, what: '机器人执行完毕并提交验收（in_review）', id: 'task-1', state: 'in_review', session_id: 'team-task-1', report: 'REPORT-原文：改好了 3 个文件', gates: '✅ 接受已确认 · ✅ 开始已确认 · ⏳ 待验收' }, { snapshot: snapshot() }) })
  ok(run2.body !== null && run2.body.action === 'run_task' && run2.body.id === 'task-1' && run2.body.actor === 'human:pm1',
    'run → {action:"run_task", id, actor}', JSON.stringify(run2.body))
  ok(text().indexOf('REPORT-原文：改好了 3 个文件') >= 0, 'run_task 的 report 原文被显示')
  ok(text().indexOf('会话：team-task-1') >= 0, 'run_task 的 session_id 被显示')

  const run3 = await fire('接受（门禁 1）', { payload: Object.assign({ ok: true, what: '已接受', id: 'task-1' }, { snapshot: snapshot() }) })
  ok(run3.request.options.body.length > 0, '（第 3 次调用仍然带 body）')

  /*
   * 需求动作：按钮来自 host 的 `available`（状态机允许什么就画什么），
   * 面板不再自己维护一份状态表。以前需求卡片是只读的 —— confirm/confirm_split/
   * archive/suspend 在状态机里都有，面板一个按钮都没有。
   */
  queue = []
  const reqButtons = () => [...document.querySelectorAll('button')].filter((b) => b.textContent === '确认拆解' || b.textContent === '挂起')
  ok(reqButtons().length === 2, 'dispatched 的需求画出 confirm_split 与 suspend', reqButtons().map((b) => b.textContent).join(','))
  const reqRun = await fire('确认拆解', { payload: Object.assign({ ok: true, what: '需求已派发', id: 'req-2026-001', state: 'dispatched' }, { snapshot: snapshot() }) })
  ok(reqRun.body !== null && reqRun.body.action === 'confirm_split' && reqRun.body.id === 'req-2026-001' && reqRun.body.actor === 'human:pm1',
    '需求按钮 → {action:"confirm_split", id, actor}', JSON.stringify(reqRun.body))
  ok(text().indexOf('「变更」与「废弃」要写原因') >= 0, '不画那两个按钮，但说明去哪儿做（静默丢掉理由更坏）')

  /* tick（预演）：故意【不带】snapshot，用来验证“否则重新 GET”那条回退路径 */
  const afterTick = snapshot()
  afterTick.tasks[0].available = ['submit']
  const tickButton = button('扫超时（预演）')
  const beforeTick = requests.length
  queue = [
    { payload: { ok: true, dry_run: true, gates: 1, leases: 1, decided: [
      { task: 'task-1', gate: 'start', action: 'timeout_start', dry_run: true },
      { task: 'task-1', lease: 'notify', ok: true, what: '租约过期，已播报（宽限期内不动任务）' },
      { task: 'task-1', gate: 'start', action: 'timeout_start', ok: false, code: 'escalate', message: '退回次数已达上限，升级给人' },
    ] } },
    { payload: afterTick },
  ]
  await act(async () => { click(tickButton) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  const tickBody = JSON.parse(requests[beforeTick].options.body)
  ok(tickBody.action === 'tick' && tickBody.dry_run === true && tickBody.actor === 'human:pm1', 'tick → {action:"tick", dry_run:true, actor}', JSON.stringify(tickBody))
  ok(requests[beforeTick + 1] !== undefined && requests[beforeTick + 1].options.method === 'GET', 'ok 响应没有 snapshot 时会自动补一次 GET')
  ok(text().indexOf('预演，未改动任何对象') >= 0, 'tick 结果标注预演')
  ok(text().indexOf('扫到 1 个到期门禁 / 1 个到期租约') >= 0, 'tick 的 gates / leases 计数')
  ok(text().indexOf('门禁 start') >= 0 && text().indexOf('动作 timeout_start') >= 0, 'decided 列表逐条展示')
  ok(text().indexOf('租约过期，已播报') >= 0, 'decided 里的 what')
  ok(text().indexOf('退回次数已达上限，升级给人') >= 0 && text().indexOf('code=escalate') >= 0, 'decided 里的拒绝原因也原文展示')

  /* submit 的 evidence：提交后的快照把 verify 打开，好接着测验收 */
  const afterSubmit = snapshot()
  afterSubmit.tasks[0].available = ['verify']
  queue = [{ payload: Object.assign({ ok: true, what: '已提交验收' }, { snapshot: afterSubmit }) }]
  const beforeSubmit = requests.length
  await act(async () => { click(button('提交验收')) })
  await act(async () => { await Promise.resolve() })
  const submitBody = JSON.parse(requests[beforeSubmit].options.body)
  ok(submitBody.action === 'submit_task' && submitBody.id === 'task-1', 'submit → {action:"submit_task", id}', JSON.stringify(submitBody))
  /*
   * 面板的"提交验收"要如实说明它**没有**证据（这一页没有证据输入框，而状态机要求
   * 有证据）。写一句"由 GUI 提交"会让人以为有一份可核对的东西。
   */
  ok(submitBody.evidence !== null && submitBody.evidence.kind === 'note' && /^gui:\d+$/.test(submitBody.evidence.ref)
    && String(submitBody.evidence.note).includes('没有附证据'),
    'submit 带 {kind:"note", ref:"gui:<ts>", note:"…没有附证据…"}', JSON.stringify(submitBody.evidence))

  /* verify */
  queue = [{ payload: Object.assign({ ok: true, what: '验收通过，任务完成' }, { snapshot: afterSubmit }) }]
  const beforeVerify = requests.length
  await act(async () => { click(button('验收通过')) })
  await act(async () => { await Promise.resolve() })
  const verifyBody = JSON.parse(requests[beforeVerify].options.body)
  ok(verifyBody.action === 'verify_task' && verifyBody.id === 'task-1' && verifyBody.actor === 'human:pm1', 'verify → {action:"verify_task", id, actor}', JSON.stringify(verifyBody))

  /* ---------------- 5. ok:false 必须被看见 ---------------- */

  section('5. 状态机拒绝：message / pending / code 原样显示')
  const refusal = '人承接的任务要先在接受者本人那里过两道门禁：accept_task → start_task（机器人不用）'
  queue = [{ payload: { ok: false, code: 'gate_incomplete', message: refusal, pending: ['human:lee', 'human:pm1'] } }]
  await act(async () => { click(button('▶ 执行一轮')) })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf(refusal) >= 0, 'message 原文逐字出现')
  ok(text().indexOf('还差谁确认：human:lee、human:pm1') >= 0, 'pending 数组被展示成「还差谁确认」')
  ok(text().indexOf('code: gate_incomplete') >= 0, 'code 出现')
  ok(text().indexOf('被拒') >= 0, '标题说明这是被拒，不是「操作失败」')

  /* 没有 pending 的拒绝 */
  queue = [{ payload: { ok: false, code: 'invalid_state', message: '任务当前是 done，不能执行' } }]
  await act(async () => { click(button('▶ 执行一轮')) })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf('任务当前是 done，不能执行') >= 0, '没有 pending 时 message 照样出现')
  ok(text().indexOf('还差谁确认') < 0, '没有 pending 时不显示空的「还差谁确认」')

  /* ---------------- 6. actor 为空 ---------------- */

  section('6. actor 输入框')
  /* 先刷新回基线快照，让 accept 按钮重新出现 */
  queue = [{ payload: snapshot() }]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  ok(button('接受（门禁 1）') !== null, '刷新后 accept 按钮重新出现')
  const actorInput = container.querySelector('.teamled-input')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(actorInput, 'human:newbie')
    actorInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  ok(container.querySelector('.teamled-input').value === 'human:newbie', 'actor 可以手改')
  queue = [{ payload: Object.assign({ ok: true, what: '已接受' }, { snapshot: snapshot() }) }]
  const beforeActor = requests.length
  await act(async () => { click(button('接受（门禁 1）')) })
  await act(async () => { await Promise.resolve() })
  ok(JSON.parse(requests[beforeActor].options.body).actor === 'human:newbie', '改过之后 POST 用的是新 actor')
  ok(container.querySelector('.teamled-input').value === 'human:newbie', '刷新快照不会覆盖用户改过的 actor')

  await act(async () => {
    setter.call(actorInput, '   ')
    actorInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  ok(container.querySelector('.teamled-input').value === '   ', 'actor 可以清空')
  ok(button('接受（门禁 1）').disabled === true, 'actor 为空时写操作按钮被禁用')
  ok(text().indexOf('actor 为空，写操作按钮已禁用') >= 0, 'actor 为空有明确文案')

  /* ---------------- 7. 出错与畸形数据 ---------------- */

  section('7. 读取失败 / 畸形数据不炸')
  queue = [{ networkError: true, message: 'Failed to fetch' }]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf('Failed to fetch') >= 0, '网络错误原文出现在界面上')
  ok(text().indexOf('读取中…') < 0 || text().indexOf('读取台账中…') < 0, '不会永远停在「读取中」')

  /* 畸形快照：字段全丢、类型全错 */
  const malformed = {
    ok: true,
    generatedAt: 42,
    config: 'not-an-object',
    requirements: ['not-an-object', null, { id: 7, state: {}, tasks: 'nope', acceptance_criteria: 3 }],
    tasks: [null, 'x', { id: 'task-9', available: 'accept', evidence: 'nope', lease: 5, gate_detail: { start: 'no' }, release_count: 'NaN' }],
    leases: null,
    runs: [{ task: 1 }],
    counts: [],
  }
  queue = [{ payload: malformed }]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf('团队台账') >= 0, '畸形快照下仍然渲染出面板（没白屏）')
  ok(text().indexOf('task-9') >= 0, '畸形任务行仍然显示 id')
  ok(button('▶ 执行一轮') !== null, '畸形数据下「执行一轮」仍在')

  /* GET 返回非 JSON */
  queue = [{ status: 500, notJson: true }]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf('HTTP 500 的响应不是 JSON') >= 0, '非 JSON 响应有具体错误文案')

  /* ok:false 的 GET */
  queue = [{ status: 200, payload: { ok: false, code: 'handler_failed', message: '快照失败：store 读不出来' } }]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf('快照失败：store 读不出来') >= 0, 'GET ok:false 的 message 被展示')

  /*
   * 404：**看不见的那一半可能压根没起来**。
   *
   * 这是 2026-09-12 那次事故的画面：插件行挂着、面板渲染得好好的，宿主半边却在激活时
   * 抛了 —— 一个接口都不在。屏幕上原本只剩「读取失败：HTTP 404」，像路由写错了。
   * 现在面板会去问入口自己的 `/api/team/boot`，并把真话写在页面上。
   */
  queue = [
    { status: 404, notJson: true },
    {
      status: 200,
      payload: {
        ok: false,
        phase: 'activate',
        at: '2026-09-12T12:29:24.565Z',
        message: 'cannot set property "teamFeishu" without provide',
        hint: '完整堆栈见 /Users/x/.dsh/team/load-report.txt',
      },
    },
  ]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  ok(requests[requests.length - 1].url.indexOf('/api/team/boot') >= 0, '404 之后去探入口的自述路由')
  ok(text().indexOf('宿主半边没能起来') >= 0, '页面上说清是宿主半边没起来，而不是只报 404')
  ok(text().indexOf('without provide') >= 0, '真原因原文出现在页面上')
  ok(text().indexOf('load-report.txt') >= 0, '并且指路到完整堆栈')

  /* 自述路由自己也 404（旧版本插件）：**不编原因**，保留原来那句保守说明 */
  queue = [{ status: 404, notJson: true }, { status: 404, notJson: true }]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf('宿主半边没能起来') < 0, '探不到就不编原因')
  ok(text().indexOf('404') >= 0, '仍然如实报 404')

  /* ---------------- 8. 长动作进行中 ---------------- */

  section('8. run_task 进行中：按钮禁用 + 明确的「已 N 秒」')
  /* 上一节把 actor 清空了（那正是写操作被拦住的原因），先填回一个真身份并复位快照 */
  const actorField = container.querySelector('.teamled-input')
  await act(async () => {
    setter.call(actorField, 'human:pm1')
    actorField.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  queue = [{ payload: snapshot() }]
  await act(async () => { click(button('刷新')) })
  await act(async () => { await Promise.resolve() })
  ok(button('▶ 执行一轮') !== null, '复位后「执行一轮」可用')
  queue = [{ deferred: true }]
  await act(async () => { click(button('▶ 执行一轮')) })
  const running = Array.from(container.querySelectorAll('button')).filter((node) => /执行中…（已 \d+ 秒）/.test(node.textContent || ''))[0]
  ok(running !== undefined, '「执行一轮」在跑的时候变成「执行中…（已 N 秒）」', (running || {}).textContent)
  ok(running !== undefined && running.disabled === true, '执行中的按钮自己禁用')
  ok(button('刷新').disabled === true, '进行中刷新禁用（避免并发取数/写）')
  ok(button('扫超时（预演）').disabled === true, '进行中扫超时禁用')
  ok(text().indexOf('执行一轮 进行中…') >= 0, '忙碌面板写明在做什么（+ 已 N 秒）')
  await act(async () => {
    releaseDeferred({ status: 200, json: () => Promise.resolve(Object.assign({ ok: true, what: '机器人执行完毕并提交验收（in_review）', report: 'DONE-汇报正文' }, { snapshot: snapshot() })) })
  })
  await act(async () => { await Promise.resolve() })
  ok(text().indexOf('进行中…') < 0, '结束后忙碌面板消失')
  ok(text().indexOf('DONE-汇报正文') >= 0, '结束后的汇报原文显示出来')

  /* ---------------- 9. GET 挂住：超时而不是永远读取中 ---------------- */

  section('9. GET 挂住 → 报超时（20 秒上限），不会永远停在「读取台账中…」')
  const definition2 = loadClassicScript({ setTimeout: (fn) => setTimeout(fn, 0) })
  const mod2 = definition2.factory((id) => { if (id === 'react') return React; throw new Error('require ' + id) })
  const injections2 = []
  const registrations2 = []
  mod2.apply({ slots: {
    inject: (name, factory) => { injections2.push({ name, factory }); return () => {} },
    register: (options, Component) => { registrations2.push(Component); return { dispose: () => {} } },
  } })
  injections2.forEach((item) => item.factory())
  const Panel2 = registrations2[1]
  const container2 = document.createElement('div')
  document.body.appendChild(container2)
  const root2 = ReactDOMClient.createRoot(container2)
  queue = [{ deferred: true }]
  await act(async () => { root2.render(React.createElement(Panel2)) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  const text2 = container2.textContent || ''
  ok(text2.indexOf('读取超时') >= 0, '挂住的 GET 变成明确的超时错误', text2.slice(0, 120))
  ok(text2.indexOf('读取台账中…') < 0, '超时后不再是「读取台账中…」')
  ok(text2.indexOf('重试') >= 0, '超时后有重试按钮')
  await act(async () => { root2.unmount() })

  /* ---------------- 9. 副作用可回收 ---------------- */

  section('10. 副作用可回收（visibilitychange 监听）')
  /* jsdom 的 document.visibilityState 是 'prerender'（它自己的怪癖），真实浏览器是 visible/hidden */
  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'visible', configurable: true })
  queue = [{ payload: snapshot() }]
  const beforeVis = requests.length
  await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')) })
  await act(async () => { await Promise.resolve() })
  ok(requests.length === beforeVis + 1, '回到页面（visibilitychange → visible）会静默补一次 GET', requests.length - beforeVis)

  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true })
  const beforeHidden = requests.length
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  await act(async () => { await Promise.resolve() })
  ok(requests.length === beforeHidden, '页面隐藏时不刷新', requests.length - beforeHidden)

  await act(async () => { root.unmount() })
  const afterUnmount = requests.length
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  await act(async () => { await Promise.resolve() })
  ok(requests.length === afterUnmount, '面板卸载后没有残留的监听（副作用跟着 fiber 走）', requests.length - afterUnmount)
  return { failures, checks }
}

