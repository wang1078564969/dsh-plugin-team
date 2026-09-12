/*
 * The row's entry point — deliberately tiny, for two load-bearing reasons
 * learned from the sibling Feishu bridge plugin.
 *
 * 1. BOOT SAFETY. A failed row is not a private matter: the harness's final
 *    boot audit rethrows a failed plugin's error, so a row that throws while
 *    loading takes the WHOLE harness down. A collaboration layer must never be
 *    able to do that, so a load failure is reported and swallowed here: the
 *    entry activates, contributes nothing, and says why in its own log.
 *
 * 2. LIVE EDITS. Cordis imports a module ONCE and Node caches it, so importing
 *    the implementation at module scope freezes it at the version on disk when
 *    the process started — editing it would change nothing until a full
 *    restart. So the implementation is imported HERE, inside apply(), with the
 *    file's mtime as a query string; saving an edit and re-activating the row
 *    picks it up, and `lib/team.js` stays an ordinary ES module anyone can
 *    read, import and test.
 *
 * `inject` must be declared HERE, on the module Cordis imports: the metadata of
 * a dynamically imported implementation is not read.
 *
 * WHY ONLY `tools`. Cordis parks a fiber whose declared inject is unavailable.
 * `tools` is required because `defineTool`/`registerTool` reach `ctx.tools` as
 * a PROPERTY, and the traceable service proxy refuses that unless the service
 * is declared. Everything else this plugin wants — `agents`, `timer`, the
 * Feather bridge — is read with `ctx.get()`, the optional-read form that needs
 * no declaration and simply yields nothing when absent. Declaring an optional
 * service would silently disable the whole row in a profile that lacks it.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMPLEMENTATION = join(HERE, 'team.js')

/** Where team data lives, resolved the same way lib/team.js resolves it. */
function dataDir() {
  if (process.env.DSH_TEAM_DATA !== undefined && process.env.DSH_TEAM_DATA !== '') {
    return process.env.DSH_TEAM_DATA
  }
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'team')
}

/**
 * 把"整个插件起不来"这件事**留在三个地方**：终端、`load-report.txt`、以及
 * `logs/team.jsonl`。
 *
 * 为什么第三条重要：boot-safe 的代价是**失败完全不可见** —— 面板不会出现、工具不会注册、
 * 三条路由都不存在，而使用者看到的只是"侧栏里没有「团队台账」"。日志文件是那时唯一
 * 还能被 `tail` / `grep` 到的地方，所以必须往里写一条（形状与 logbus 的行一致，
 * 将来插件能起来了，那一行会直接出现在日志页里）。
 */
function reportBootFailure(phase, detail) {
  const at = new Date().toISOString()
  const first = detail.split('\n').slice(0, 6).join(' | ')
  try {
    appendFileSync(join(dataDir(), 'load-report.txt'), at + ' ' + phase.toUpperCase() + ' FAILED: ' + first + '\n')
  } catch (nested) {
    /* 数据目录可能还不存在；上面那行 console 已经够了 */
  }
  try {
    mkdirSync(join(dataDir(), 'logs'), { recursive: true })
    appendFileSync(
      join(dataDir(), 'logs', 'team.jsonl'),
      JSON.stringify({ at, level: 'error', source: 'boot', message: '插件没能' + (phase === 'load' ? '加载' : '激活') + '：' + first, data: null }) + '\n',
    )
  } catch (nested) {
    /* 同上 */
  }
}

export const name = 'team'
export const inject = ['tools']

export async function apply(ctx, config) {
  const at = new Date().toISOString()
  let implementation = null
  try {
    const url = pathToFileURL(IMPLEMENTATION)
    try {
      url.searchParams.set('v', String((await stat(IMPLEMENTATION)).mtimeMs))
    } catch (error) {
      // No mtime means the file itself is gone; import the bare path so the
      // error below names the real problem instead of this one.
    }
    implementation = await import(url.href)
  } catch (error) {
    const detail = String(error && error.stack ? error.stack : error)
    console.error('[team] cannot load ' + IMPLEMENTATION + ': ' + detail)
    reportBootFailure('load', detail)
    mountRoutes(ctx, null, { ok: false, phase: 'load', at, detail })
    return
  }

  try {
    await implementation.apply(ctx, config)
  } catch (error) {
    const detail = String(error && error.stack ? error.stack : error)
    console.error('[team] activation failed: ' + detail)
    reportBootFailure('activate', detail)
    mountRoutes(ctx, null, { ok: false, phase: 'activate', at, detail })
    return
  }

  mountRoutes(ctx, implementation, { ok: true, phase: 'ok', at, detail: '' })
}

/**
 * 这次加载的结果，做成一条**不依赖实现的**路由。
 *
 * WHY THIS ROUTE EXISTS. Boot-safe has a price: when activation fails the plugin
 * contributes nothing — no long connection, no routes, no tool — and the browser
 * half is a static script that renders anyway. So the operator sees a panel that
 * looks mounted and one line of "读取失败：HTTP 404". On 2026-09-12 exactly that
 * happened (a test seam wrote an undeclared property onto Cordis's ctx), and the
 * only honest evidence lived in a log file nobody had been told to read.
 *
 * This route is registered by the ENTRY, so it survives the implementation being
 * entirely dead — which is precisely when it is needed. It answers 200 with
 * `{ok:false, phase, message}` and the panel renders the real reason.
 *
 * It returns the FIRST LINE of the failure only. The full stack stays in
 * `load-report.txt` and the log page: this route is readable by any authenticated
 * browser, so it says enough and no more.
 *
 * @param {{ok: boolean, phase: string, at: string, detail: string}} boot
 */
export function bootRoute(boot) {
  return {
    path: '/api/team/boot',
    methods: ['GET'],
    requestBody: 'buffered',
    handler: async () =>
      new Response(
        JSON.stringify({
          ok: boot.ok === true,
          phase: boot.phase,
          at: boot.at,
          message: boot.detail === '' ? '' : boot.detail.split('\n')[0],
          /*
           * 状态码永远是 200：请求本身成功了，失败的是这次加载。用 5xx 只会让面板
           * 走另一条错误分支，把"宿主半边起不来"说成"接口坏了"。
           */
          hint:
            boot.ok === true
              ? ''
              : '完整堆栈见 ' + join(dataDir(), 'load-report.txt') + '，以及日志页里的 boot 行',
        }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
      ),
  }
}

/**
 * Mount every Fetch route this row publishes, if this deployment can carry them:
 * the entry's own boot self-report, plus the ledger / config / log routes the
 * implementation published.
 *
 * `connection` is ACQUIRED, NOT PROBED — and that distinction cost a debugging
 * round, so it is written down here. `ctx.get('connection')` returned undefined
 * in the WEB profile, where the service demonstrably exists, because a one-shot
 * read samples the store at that instant and this service is provided later in
 * the boot than a last-layer row's `apply()`. The result was a mounted plugin, a
 * rendered panel, and a route that answered 404 — the most confusing possible
 * combination. DSH's own api gateway does it the right way:
 *
 *     ctx.inject(['connection'], (connectionCtx) => { connectionCtx.connection… })
 *
 * `inject` with a CALLBACK waits for the service instead of declaring it on the
 * row's own fiber — which matters, because declaring it in `inject` up top would
 * park the whole plugin in any profile without a browser (headless), losing the
 * ledger and the tool along with the panel.
 *
 * WHAT THE ROUTES ARE FOR. The shipped browser half (`lib/client.js`) is a classic
 * script in the page with no `host.call`, so these routes are how the panel reads
 * and acts. Registering them through the connection service (rather than directly
 * on `webServer`) is what puts authentication in front of an endpoint that can
 * start tasks and confirm gates: the connection service mounts ONE `/api` prefix
 * route behind its Host/Origin fence plus browser auth, and an exact Fetch route
 * registered here is dispatched from inside it.
 *
 * Failure to mount is reported, never thrown: a missing GUI costs a panel, a
 * thrown error here costs the whole harness (the boot audit rethrows a failed
 * row).
 */
function mountRoutes(ctx, implementation, boot) {
  /*
   * Every route to publish: first the entry's OWN boot self-report, then whatever
   * the implementation published (the ledger the panel reads, the configuration it
   * edits, the log page). They are registered one by one so a failure to mount one
   * costs only that one — a panel without its config page still shows the ledger.
   */
  const routes = [bootRoute(boot)]
  const published =
    implementation === null || implementation === undefined
      ? []
      : [implementation.api, implementation.configApi, implementation.logsApi]
  for (const route of published) {
    if (route !== null && route !== undefined && typeof route.handler === 'function') routes.push(route)
  }
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['connection'], (connectionCtx) => {
      let connection = null
      try {
        connection = Reflect.get(connectionCtx, 'connection') ?? connectionCtx.connection
      } catch (error) {
        connection = null
      }
      if (
        connection === null ||
        connection === undefined ||
        connection.fetch === undefined ||
        typeof connection.fetch.register !== 'function'
      ) {
        console.error('[team] the connection service has no Fetch registry — the panel will not load its data')
        return
      }
      for (const route of routes) {
        try {
          connectionCtx.effect(
            () =>
              connection.fetch.register({
                path: route.path,
                methods: route.methods,
                requestBody: route.requestBody,
                fetch: route.handler,
              }),
            'team: ' + route.path + ' Fetch route',
          )
          route.mounted = true
          console.log('[team] route mounted at ' + route.path + ' (behind the /api browser fence)')
        } catch (error) {
          console.error('[team] could not mount ' + String(route.path) + ': ' + String(error && error.message ? error.message : error))
        }
      }
    })
  } catch (error) {
    console.error('[team] could not subscribe to the connection service: ' + String(error && error.message ? error.message : error))
  }
}
