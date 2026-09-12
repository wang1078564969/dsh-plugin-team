/*
 * 把随包发布的那一行挂进一个**真的 Cordis 上下文**跑一遍 —— 全套用例里唯一一条
 * 能发现"测试全绿、宿主里整个插件起不来"的用例。
 *
 * WHY THIS FILE EXISTS (2026-09-12). `lib/team.js` 里曾有一行测试接缝
 * `ctx.teamFeishu = feishu`。用例的 ctx 是个普通对象，赋值当然成功；真宿主里
 * Cordis 的 ctx 是带守卫的代理，给未 `provide` 的属性赋值会抛
 * `cannot set property "teamFeishu" without provide`（而且**只在运行中的 fiber 里**
 * 抛：`new Context()` 这种裸上下文因为 `fiber.runtime` 为空反而放行，所以本地随手一试
 * 还试不出来）。后果是：`apply()` 在飞书长连接启动之前抛出 → 长连接没起、三条路由没挂，
 * 而浏览器半边是静态脚本、照常渲染 —— 使用者看到的是一个 404 的台账页，像路由写错了。
 *
 * 用假 ctx 的用例永远发现不了这一类错误，因为假 ctx 什么都不拒绝。所以这里走
 * `ctx.plugin()`（与 loader 同一条路径，`ctx.fiber.runtime` 是真的）。
 *
 * 三条用例各守一件事：
 *   1. 正常路径：entry 不抛、`team` 工具注册了、四条路由挂上了、**台账路由真的能应答 JSON**。
 *   2. 失败路径：实现整个死掉时，这一行**仍然活着**（boot-safe），并且
 *      `/api/team/boot` 把原因说了出来 —— 这正是面板 404 时唯一能问到的地方。
 *   3. 自述路由本身：只吐首行，不把堆栈撒给浏览器。
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

let Context = null
let cordisProblem = ''
try {
  ;({ Context } = await import('@deepseek-ai/cordis'))
} catch (error) {
  /*
   * 这个包是**宿主**提供的（peer 依赖），不是本插件的运行时依赖：测试里用它只是为了
   * 用真的 ctx 跑一遍。装了才跑，没装就说清为什么跳过 —— 一条静默跳过的守卫等于没有守卫。
   */
  cordisProblem = '@deepseek-ai/cordis 不可用（' + String(error && error.message ? error.message : error) + '）'
  console.error('[activation] 跳过两条真上下文用例：' + cordisProblem)
}

/** node:test 把**字符串**形式的 skip 一律当"跳过"，空串也一样 —— 所以这里必须是 false。 */
const skipWithoutCordis = cordisProblem === '' ? false : cordisProblem

/** cordis: `fiber.state` 2 = active，3 = failed，5 = disposed。 */
const FIBER_ACTIVE = 2

const ROOT = join(import.meta.dirname, '..')

/** 一份最小可用的 row 配置：不联网、不建群、不派活。 */
function rowConfig(dir) {
  return {
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }],
    feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
  }
}

/** 等一个条件成立（`ctx.inject` 的回调不在 `apply()` 里同步发生）。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate() === true) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate() === true
}

/** 起一个真 ctx，把宿主会提供的两个服务先放好，然后按 loader 的方式挂这一行。 */
async function mountRow(entry, dir) {
  const app = new Context()
  const tools = []
  const routes = []
  app.provide('tools', {
    register: (definition) => {
      tools.push(definition)
      return () => {}
    },
  })
  app.provide('connection', {
    fetch: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  })
  const fork = app.plugin(entry, rowConfig(dir))
  return { app, fork, tools, routes }
}

async function quietStop(app, fork) {
  try {
    if (fork !== undefined && fork !== null && typeof fork.dispose === 'function') fork.dispose()
    if (app !== undefined && app !== null && typeof app.stop === 'function') await app.stop()
  } catch (error) {
    /* 收尾失败不该让用例红：它不影响刚断言过的事实 */
  }
}

test('the shipped row comes up under a real cordis context and its routes answer', { skip: skipWithoutCordis }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-activation-'))
  const previous = process.env.DSH_TEAM_DATA
  process.env.DSH_TEAM_DATA = dir
  let app = null
  let fork = null
  try {
    const entry = await import('../lib/index.js')
    const mounted = await mountRow(entry, dir)
    app = mounted.app
    fork = mounted.fork

    /*
     * `await fork` 在 apply 抛出时会 reject。entry 的 boot-safe 是**自己**吞掉
     * load/activate 失败的，所以这里 reject 只可能是 entry 本身写坏了。
     */
    await fork
    assert.equal(fork.state, FIBER_ACTIVE, '这一行必须停在 active')
    assert.deepEqual(mounted.tools.map((definition) => definition.name), ['team'], '`team` 工具必须注册')

    assert.ok(await waitFor(() => mounted.routes.length >= 4), '四条路由都要挂上，实际：' + mounted.routes.length)
    assert.deepEqual(
      mounted.routes.map((route) => route.path).sort(),
      ['/api/team/boot', '/api/team/config', '/api/team/ledger', '/api/team/logs'],
    )

    /*
     * 这条断言是整份用例的重点：**面板要的就是这个**。前面几条只说明路由被登记了，
     * 这一条说明它真的能应答 JSON —— 当年"路由挂了但答 404"的组合就是这样才看得出来。
     */
    const ledger = mounted.routes.find((route) => route.path === '/api/team/ledger')
    const ledgerResponse = await ledger.fetch(new Request('http://127.0.0.1/api/team/ledger'))
    assert.equal(ledgerResponse.status, 200)
    const snapshot = await ledgerResponse.json()
    assert.equal(snapshot.ok, true, '台账路由必须回一份 JSON 快照')
    assert.ok(Array.isArray(snapshot.requirements) && Array.isArray(snapshot.tasks))

    const boot = mounted.routes.find((route) => route.path === '/api/team/boot')
    const bootPayload = await (await boot.fetch(new Request('http://127.0.0.1/api/team/boot'))).json()
    assert.equal(bootPayload.ok, true, '自述路由在正常激活后应该说 ok')

    assert.equal(
      existsSync(join(dir, 'load-report.txt')),
      false,
      'entry 不该写 load-report：出现了就说明这次激活其实失败了（内容：' +
        (existsSync(join(dir, 'load-report.txt')) ? readFileSync(join(dir, 'load-report.txt'), 'utf8') : '') + '）',
    )
  } finally {
    await quietStop(app, fork)
    if (previous === undefined) delete process.env.DSH_TEAM_DATA
    else process.env.DSH_TEAM_DATA = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dead implementation leaves the row alive and its boot route tells the truth', { skip: skipWithoutCordis }, async () => {
  /*
   * 这一条复现 2026-09-12 那次事故的**形状**，但不在生产代码里留任何钩子：把 entry
   * 复制到一个临时目录，旁边放一个"一激活就写 ctx 未声明属性"的 team.js —— 也就是
   * 那次真正写错的那一行。真 ctx 会拒绝它，于是实现整个死掉。
   *
   * 要守住的两件事：① 这一行**没有**把宿主带下去（boot-safe 的原始承诺，在真上下文里
   * 第一次被验证）；② 面板 404 时唯一还能问到的 `/api/team/boot` 在，并且说了真话。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-dead-impl-'))
  const previous = process.env.DSH_TEAM_DATA
  process.env.DSH_TEAM_DATA = dir
  let app = null
  let fork = null
  try {
    copyFileSync(join(ROOT, 'lib', 'index.js'), join(dir, 'index.js'))
    writeFileSync(
      join(dir, 'team.js'),
      [
        '/* 那个真的写错过的一行：给未 provide 的 ctx 属性赋值。 */',
        'export let api = null',
        'export let configApi = null',
        'export let logsApi = null',
        'export async function apply(ctx) {',
        '  ctx.teamFeishu = { seam: true }',
        '}',
        '',
      ].join('\n'),
    )

    const entry = await import(join(dir, 'index.js'))
    const mounted = await mountRow(entry, dir)
    app = mounted.app
    fork = mounted.fork

    // ① 实现抛了，但这一行活着：await 不该 reject，state 必须是 active。
    await fork
    assert.equal(fork.state, FIBER_ACTIVE, '实现死掉不该把这一行、更不该把宿主带下去')

    /*
     * ② 面板能问到原因。台账/配置/日志三条都不在（它们属于死掉的实现），
     *    自述路由必须在 —— 这就是它存在的唯一理由。
     */
    assert.ok(await waitFor(() => mounted.routes.length >= 1), '自述路由必须挂上')
    assert.deepEqual(mounted.routes.map((route) => route.path), ['/api/team/boot'])
    const response = await mounted.routes[0].fetch(new Request('http://127.0.0.1/api/team/boot'))
    assert.equal(response.status, 200, '请求本身是成功的，失败的是这次加载')
    const payload = await response.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.phase, 'activate')
    assert.match(payload.message, /without provide/, '首行就是那句真话：' + payload.message)
    assert.ok(payload.hint.includes('load-report.txt'), '并且指路到完整堆栈')

    // 失败也要留下可 tail 的痕迹：终端、load-report.txt、日志三处。
    const report = readFileSync(join(dir, 'load-report.txt'), 'utf8')
    assert.match(report, /ACTIVATE FAILED/)
    const log = readFileSync(join(dir, 'logs', 'team.jsonl'), 'utf8')
    assert.match(log, /"source":"boot"/)
  } finally {
    await quietStop(app, fork)
    if (previous === undefined) delete process.env.DSH_TEAM_DATA
    else process.env.DSH_TEAM_DATA = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the boot route reports the first line only and points at the full stack', async () => {
  /*
   * 这条路由是**浏览器可读**的，所以它说够用的话就停：堆栈留在磁盘上。
   * 状态码固定 200：请求成功了，失败的是这次加载；回 5xx 会让面板走另一条错误分支，
   * 把"宿主半边起不来"说成"接口坏了"。
   */
  const entry = await import('../lib/index.js')
  const route = entry.bootRoute({
    ok: false,
    phase: 'load',
    at: '2026-01-01T00:00:00.000Z',
    detail: 'SyntaxError: something broke\n    at Module.apply (file:///secret/path.js:1:1)\n    at more',
  })
  assert.equal(route.path, '/api/team/boot')
  assert.deepEqual(route.methods, ['GET'])
  const response = await route.handler(new Request('http://127.0.0.1/api/team/boot'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(Object.keys(payload).sort(), ['at', 'hint', 'message', 'ok', 'phase'])
  assert.equal(payload.message, 'SyntaxError: something broke')
  assert.equal(payload.message.includes('at Module.apply'), false, '堆栈不进浏览器')
  assert.ok(payload.hint.includes('load-report.txt'))
})
