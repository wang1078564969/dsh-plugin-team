/*
 * 「日志」页，RENDERED —— 设计 04 §11 那六个"必须能回答的问题"的落点。
 *
 * Same opt-in harness as the other render tests (real react + jsdom from
 * `$TEAM_CLIENT_TEST_MODULES` or this package's node_modules). The three things
 * this page exists for, and what is checked here:
 *
 *   1. **漏单**（第 3 条）与**分诊结论** —— 每条入站消息为什么没建单，在这一屏能读到；
 *   2. **降级率**（第 4 条）—— 是个数字，也要看得到是哪一级在发；
 *   3. **每群发言占比**（第 5 条 / §2.3 的 25% 告警）—— 超线的群红，样本不足的群说明原因。
 *
 * 它比别的页多一条自己的读取路径（每 3 秒刷），所以这里也验那条路径的参数与生命周期：
 * 切走要停表，筛选要带进查询串，而不是把滚动数据塞进配置快照。
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

/** 台账落盘事实：卡台账是发言占比的分子（一张卡 = 群里的一条消息）。 */
function logsFixture(overrides = {}) {
  return {
    ok: true,
    generatedAt: '2026-09-12T10:00:00.000Z',
    log: {
      rows: [
        { at: '2026-09-12T09:59:00.000Z', level: 'info', source: 'inbound', message: '收到消息（oc_a · 主：req）：重试这块要不要加？' },
        { at: '2026-09-12T09:59:30.000Z', level: 'warn', source: 'feishu', message: '忽略了未登记群的消息：oc_x' },
        { at: '2026-09-12T09:59:40.000Z', level: 'error', source: 'notify', message: '播报失败（create）：[{"level":1,"via":"card","code":9499}]' },
        { at: '2026-09-12T09:59:50.000Z', level: 'debug', source: 'tick', message: '没有到期的门禁' },
      ],
      fromFile: 12,
      counts: { debug: 1, info: 1, warn: 1, error: 1, buffered: 4 },
      sources: ['inbound', 'feishu', 'notify', 'tick'],
      level: 'info',
      file: '/Users/x/.dsh/team/logs/team.jsonl',
    },
    messages: {
      total: 3,
      unconsumed: 1,
      rows: [
        {
          messageId: 'om_1', at: '2026-09-12T09:50:00.000Z', chatId: 'oc_a', sender: 'human:wangmengfan',
          triageKind: 'requirement_created', ignoredReason: null, handled: true,
          recordedBy: 'req', duplicateOf: null, consumedBy: ['req-2026-001'], preview: '重试这块要不要加？',
        },
        {
          messageId: 'om_2', at: '2026-09-12T09:51:00.000Z', chatId: 'oc_a', sender: 'human:zhouyu',
          triageKind: 'duplicate', ignoredReason: '和 req-2026-001 是同一条', handled: false,
          recordedBy: 'req', duplicateOf: 'om_1', consumedBy: [], preview: '重试这块要不要加？',
        },
        {
          messageId: 'om_3', at: '2026-09-12T09:52:00.000Z', chatId: 'oc_b', sender: 'human:zhouyu',
          triageKind: null, ignoredReason: null, handled: false,
          recordedBy: 'dev', duplicateOf: null, consumedBy: [], preview: '在吗',
        },
      ],
    },
    delivery: {
      tiers: [
        { via: 'card', sent: 7, delivered: 6, updated: 1 },
        { via: 'text', sent: 2, delivered: 2, updated: 0 },
        { via: 'text-with-file', sent: 1, delivered: 1, updated: 0 },
      ],
      byVia: {},
      card: 7,
      fallback: 3,
      total: 10,
      fallbackRate: 0.3,
      mentions: 5,
      quotaRefused: 2,
      suppressed: 4,
      throttled: 3,
      digested: 1,
      skipped: 2,
      failed: 1,
      delivered: 9,
      updated: 1,
      byBot: { req: { delivered: 6, updated: 1, mentions: 4, suppressed: 3, throttled: 2, digested: 1 }, dev: { delivered: 3, updated: 0, mentions: 1, suppressed: 1, throttled: 1, digested: 0 } },
    },
    share: {
      generatedAt: '2026-09-12T10:00:00.000Z',
      threshold: 0.25,
      minSample: 8,
      delivery: {},
      chats: [
        {
          chatId: 'oc_busy', sent: 10, received: 10, total: 20, share: 0.5,
          mentions: 6, silenced: 5, suppressed: 4, throttled: 1, digested: 0, failed: 0,
          byBot: { req: 10 }, first: '2026-09-01T00:00:00.000Z', last: '2026-09-12T09:59:00.000Z',
          enough: true, alert: true,
        },
        {
          chatId: 'oc_new', sent: 1, received: 2, total: 3, share: 1 / 3,
          mentions: 0, silenced: 0, suppressed: 0, throttled: 0, digested: 0, failed: 0,
          byBot: { dev: 1 }, first: '2026-09-12T00:00:00.000Z', last: '2026-09-12T09:00:00.000Z',
          enough: false, alert: false,
        },
      ],
    },
    knowledge: {
      docs: {
        root: '/Users/x/.dsh/team/ws/docs', exists: true, count: 3,
        byType: { spec: 2, decision: 1 }, withProblems: 0, stale: 1, latest: '2026-09-10',
      },
      stale: [
        {
          id: 'spec-pay-retry', owner: 'human:u123', status: 'active', updated: '2026-02-03',
          path: 'docs/specs/spec-pay-retry.md',
          reasons: [{ kind: 'superseded_reference', target: 'spec-v1', message: '它引用的 spec-v1 已经是 superseded' }],
        },
      ],
    },
    counts: { requirements: 1, tasks: 1, leases: 0 },
    ...overrides,
  }
}

function ledgerFixture() {
  return {
    ok: true,
    generatedAt: '2026-09-12T10:00:00.000Z',
    config: {
      dataDir: '/Users/x/.dsh/team', workspace: '/Users/x/.dsh/team/workspace',
      defaultOwner: 'human:wangmengfan', feishuMode: 'own',
      memberList: [{ key: 'human:wangmengfan', name: '王梦凡' }], domains: {}, members: {},
      bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }], tickIntervalMs: 60000,
    },
    requirements: [], tasks: [], leases: [], runs: [],
    counts: { requirements: 0, tasks: 0, leases: 0, runs: 0 },
  }
}

/** Mount the panel exactly the way the platform does, over a stubbed fetch. */
async function mountConsole(overrides = {}) {
  const { JSDOM, require: localRequire } = harness
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
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

  const requests = []
  /** 每次 `GET /api/team/logs` 返回的东西，按次序取；用完了就重复最后一个。 */
  const pages = overrides.pages ?? [logsFixture()]
  let pageIndex = 0
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const method = options.method ?? 'GET'
    requests.push({ url: target, method, body: options.body })
    let payload
    if (target.includes('/api/team/logs')) {
      const next = pages[Math.min(pageIndex, pages.length - 1)]
      pageIndex += 1
      payload = typeof next === 'function' ? next() : next
    } else if (target.includes('/api/team/ledger')) {
      payload = ledgerFixture()
    } else {
      payload = { ok: true, config: {}, editable: [], problems: [], diagnostics: [] }
    }
    const status = payload !== null && typeof payload === 'object' && payload.__status !== undefined ? payload.__status : 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }

  /* 定时器：日志页会自动刷，所以要能"到点"而不真的等 3 秒。 */
  const intervals = []
  const cleared = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (callback, ms) => {
    intervals.push({ callback, ms })
    return intervals.length
  }
  globalThis.clearInterval = (id) => { cleared.push(id) }

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
  /*
   * 精确匹配：`startsWith` 会撞上别的页的按钮 —— 台账页有一颗
   * 「刷新扫超时（预演）」，它排在前面，`button('刷新')` 点到的是它。
   */
  const button = (label) => buttons().find((node) => node.textContent === label)
  /** 日志页那颗「刷新」：页面上不止一颗，所以按 title 认。 */
  const reloadButton = () => buttons().find((node) => (node.getAttribute('title') ?? '').startsWith('重新读取日志'))
  const pick = async (select, value) => {
    const setSelect = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    await act(async () => {
      setSelect.call(select, value)
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await flush()
  }
  /** 让自动刷新的定时器"到点"。 */
  const fireInterval = async (index = 0) => {
    assert.notEqual(intervals[index], undefined, 'the page armed a timer')
    await act(async () => { intervals[index].callback() })
    await flush()
  }
  const rows = () => [...container.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((cell) => cell.textContent))
  const unmount = async () => {
    await act(async () => { root.unmount() })
    console.error = realConsoleError
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
  const assertNoWarnings = () => {
    assert.deepEqual(warnings, [], 'React logged a warning while this page was mounted (keys / controlled inputs / props)')
  }

  return {
    dom, container, root, act, flush, text, buttons, tab, button, reloadButton, click, openTab, requests, pick,
    intervals, cleared, fireInterval, rows, warnings, unmount, assertNoWarnings,
  }
}

test('the 日志 page shows the rows, the missed messages and every triage verdict', { skip }, async () => {
  const app = await mountConsole()
  await app.openTab('日志')

  const gets = app.requests.filter((r) => r.url.includes('/api/team/logs'))
  assert.equal(gets.length, 1, '切到日志页读一次')
  assert.match(gets[0].url, /level=info/, '默认从 info 起（debug 太吵）')
  assert.match(gets[0].url, /limit=200/)
  assert.match(gets[0].url, /file=true/, '连重启前文件里的也读')

  const rendered = app.text()
  // 四行日志，级别、来源、正文都在。
  assert.match(rendered, /日志（4）/)
  assert.match(rendered, /收到消息（oc_a · 主：req）/)
  assert.match(rendered, /忽略了未登记群的消息/)
  assert.match(rendered, /播报失败（create）/)
  // 级别计数在按钮上，人一眼能看到"有没有 error"。
  assert.match(rendered, /debug（1）/)
  assert.match(rendered, /error（1）/)
  // 文件里的旧日志：条数要说出来（重启之后第一眼看的就是这个）。
  assert.match(rendered, /12 条重启前的/)
  assert.match(rendered, /\/Users\/x\/\.dsh\/team\/logs\/team\.jsonl/)
  // 脱敏是对人的承诺，所以页面上明说。
  assert.match(rendered, /先脱敏再落盘/)

  // 收件箱：漏单数 + 每条的分诊结论 / 为什么没建 / 并入了谁 / 记在谁名下。
  assert.match(rendered, /收件箱（3）/)
  assert.match(rendered, /漏单 1/)
  assert.match(rendered, /requirement_created/)
  assert.match(rendered, /duplicate · 和 req-2026-001 是同一条 · 并入 om_1 · 记在 req/)
  assert.match(rendered, /（没有分诊结论）/, '没有结论的消息直说没有结论，而不是假装正常')
  assert.match(rendered, /记在 dev/)

  // 来源下拉框：全部 + 接口给的四个来源。
  const select = app.container.querySelector('select')
  assert.deepEqual([...select.querySelectorAll('option')].map((option) => option.value), ['', 'inbound', 'feishu', 'notify', 'tick'])

  app.assertNoWarnings()
  await app.unmount()
})

test('the filters and the refresh button re-read the log route with the query they claim', { skip }, async () => {
  const app = await mountConsole()
  await app.openTab('日志')
  assert.equal(app.requests.filter((r) => r.url.includes('/api/team/logs')).length, 1)

  // 只看 warn 及以上：查询串要带上，而不是在客户端过滤（服务端才有文件里那些行）。
  const warn = app.buttons().find((node) => node.textContent === 'warn（1）')
  assert.notEqual(warn, undefined, 'the level buttons carry their counts')
  await app.click(warn)
  let logs = app.requests.filter((r) => r.url.includes('/api/team/logs'))
  assert.equal(logs.length, 2)
  assert.match(logs[1].url, /level=warn/)

  // 来源筛选。
  await app.pick(app.container.querySelector('select'), 'feishu')
  logs = app.requests.filter((r) => r.url.includes('/api/team/logs'))
  assert.equal(logs.length, 3)
  assert.match(logs[2].url, /level=warn/)
  assert.match(logs[2].url, /source=feishu/)

  // 手动刷新：同一个查询再读一次。
  const reload = app.reloadButton()
  assert.notEqual(reload, undefined, 'the log page offers its own refresh')
  await app.click(reload)
  logs = app.requests.filter((r) => r.url.includes('/api/team/logs'))
  assert.equal(logs.length, 4)
  assert.match(logs[3].url, /source=feishu/)

  /*
   * 自动刷新：3 秒一次，用的是**当前**筛选条件。
   *
   * 每次改筛选都会重装表（effect 的依赖里有 level/source），但**旧的那张必须先停**——
   * 泄漏的定时器会在后台每 3 秒打一次接口，而且是带着旧条件。
   */
  assert.equal(app.intervals.length, 3, '初装 + 改级别 + 改来源各装一次')
  assert.equal(app.cleared.length, 2, '每次重装都把上一张停掉')
  for (const timer of app.intervals) assert.equal(timer.ms, 3000)
  await app.fireInterval(2)
  logs = app.requests.filter((r) => r.url.includes('/api/team/logs'))
  assert.equal(logs.length, 5, '到点自动再读一次')
  assert.match(logs[4].url, /level=warn/)
  assert.match(logs[4].url, /source=feishu/)

  // 关掉自动刷新：表要停（不然切走之后还在后台每 3 秒打飞书一次）。
  await app.click(app.container.querySelector('input[type="checkbox"]'))
  assert.equal(app.cleared.length, 3, 'the interval was cleared when the switch went off')
  await app.click(app.button('台账'))
  assert.equal(app.intervals.length, 3, '切到别的页不再重新装表')

  app.assertNoWarnings()
  await app.unmount()
})

test('降级率是个数字，也要看得到是哪一级在发', { skip }, async () => {
  const app = await mountConsole()
  await app.openTab('日志')

  const rendered = app.text()
  assert.match(rendered, /投递统计/)
  assert.match(rendered, /降级率 30\.0%/, '3/10 走了后两级 —— 高就说明卡片渲染有问题')
  assert.match(rendered, /投递层级（via）/)
  assert.match(rendered, /card-plain-table|text-with-file/)

  const table = app.rows().filter((cells) => cells[0] === 'card')
  assert.deepEqual(table, [['card', '7', '70.0%', '卡']], '第一级：发出去 7 条，占 70%')
  const degraded = app.rows().find((cells) => cells[0] === 'text')
  assert.deepEqual(degraded, ['text', '2', '20.0%', '降级'], '后两级被标成降级，不是"另一种卡"')
  const file = app.rows().find((cells) => cells[0] === 'text-with-file')
  assert.deepEqual(file, ['text-with-file', '1', '10.0%', '降级'])

  // @人次数与"决定了不说"的四种原因，都是有数字的。
  assert.match(rendered, /@人 5 次（配额拒绝后转静默 2 次）/)
  assert.match(rendered, /@配额\/静默\/节流\/聚合 = 4 \/ 3 \/ 1/)
  assert.match(rendered, /跳过 2 · 失败 1/)
  // 按机器人分开数。
  assert.deepEqual(app.rows().find((cells) => cells[0] === 'req'), ['req', '7', '4', '6'])
  // 口径要写清楚：这一组是本进程的（重启清零），而占比是落盘的。
  assert.match(rendered, /本进程/)

  app.assertNoWarnings()
  await app.unmount()
})

test('每群发言占比：超线的群红，样本不足的群说明为什么不算告警', { skip }, async () => {
  const app = await mountConsole()
  await app.openTab('日志')

  const rendered = app.text()
  assert.match(rendered, /每群机器人发言占比/)
  assert.match(rendered, /告警线 25%/)

  const head = app.rows().find((cells) => cells[0] === '群')
  assert.deepEqual(head, ['群', '机器人发言', '人发言', '群消息总数', '占比', '@人次数', '被静默', '判定'])

  // 按占比降序：超线的那个群在最上面。
  const busy = app.rows().find((cells) => cells[0] === 'oc_busy')
  assert.deepEqual(busy, ['oc_busy', '10', '10', '20', '50.0%', '6', '5', '超线告警'])
  const fresh = app.rows().find((cells) => cells[0] === 'oc_new')
  assert.deepEqual(fresh, ['oc_new', '1', '2', '3', '33.3%', '0', '0', '样本不足（3/8）'])

  // 分子分母的口径必须写在页面上：一句话说不清的数，人不会信。
  assert.match(rendered, /分子 = 这个群里的卡台账行数/)
  assert.match(rendered, /重启不会让比率变好看/)
  assert.match(rendered, /样本不足 8 条时不告警/)

  app.assertNoWarnings()
  await app.unmount()
})

test('团队文档：条数、类型分布、过期的那几行都画出来', { skip }, async () => {
  const app = await mountConsole()
  await app.openTab('日志')

  const rendered = app.text()
  assert.match(rendered, /团队文档（3）/)
  assert.match(rendered, /spec 2 · decision 1/)
  assert.match(rendered, /过期\/被取代 1/)
  assert.match(rendered, /spec-pay-retry/)
  assert.match(rendered, /human:u123/)
  assert.match(rendered, /它引用的 spec-v1 已经是 superseded/, '为什么该看一眼是原文，不是编号')
  assert.match(rendered, /index\.md 与 _meta\/docs\.json 都是\*\*派生物\*\*/)
  assert.match(rendered, /没有 owner 的写不进去/)

  app.assertNoWarnings()
  await app.unmount()
})

test('工作区还没有文档库时，页面说的是"怎么建"，不是一个空表', { skip }, async () => {
  const app = await mountConsole({
    pages: [logsFixture({ knowledge: { docs: { exists: false, count: 0 }, stale: [] } })],
  })
  await app.openTab('日志')
  assert.match(app.text(), /工作区里还没有文档库/)
  assert.match(app.text(), /op=init/)
  app.assertNoWarnings()
  await app.unmount()
})

test('a failing log route shows the failure and the URL, and does not take the page down', { skip }, async () => {
  const app = await mountConsole({
    pages: [
      logsFixture({ ok: false, __status: 500 }),
      logsFixture(),
    ],
  })
  await app.openTab('日志')
  const rendered = app.text()
  assert.match(rendered, /读取日志失败/)
  assert.match(rendered, /接口：\/api\/team\/logs（GET）/)
  assert.match(rendered, /不会因为一次失败就停在加载态/)
  /* 失败之后点刷新要能恢复：观测页自己不能成为那个"一直在读取中"的页面。 */
  const retry = app.reloadButton()
  assert.notEqual(retry, undefined, 'the failure screen still offers a refresh')
  await app.click(retry)
  assert.match(app.text(), /日志（4）/)
  assert.equal(/读取日志失败/.test(app.text()), false, 'recovery clears the error line')

  app.assertNoWarnings()
  await app.unmount()
})
