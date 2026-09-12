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
import { appendFileSync } from 'node:fs'
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

export const name = 'team'
export const inject = ['tools']

export async function apply(ctx, config) {
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
    try {
      appendFileSync(
        join(dataDir(), 'load-report.txt'),
        new Date().toISOString() + ' LOAD FAILED: ' + detail.split('\n').slice(0, 6).join(' | ') + '\n',
      )
    } catch (nested) {
      // The data directory may not exist yet; the console line above is enough.
    }
    return
  }

  try {
    await implementation.apply(ctx, config)
  } catch (error) {
    console.error('[team] activation failed: ' + String(error && error.stack ? error.stack : error))
    return
  }

  mountLedgerApi(ctx, implementation)
}

/**
 * Mount the ledger's Fetch route, if this deployment can carry it.
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
 * WHAT THE ROUTE IS FOR. The shipped browser half (`lib/client.js`) is a classic
 * script in the page with no `host.call`, so this route is how the ledger panel
 * reads and acts. Registering it through the connection service (rather than
 * directly on `webServer`) is what puts authentication in front of an endpoint
 * that can start tasks and confirm gates: the connection service mounts ONE
 * `/api` prefix route behind its Host/Origin fence plus browser auth, and an
 * exact Fetch route registered here is dispatched from inside it.
 *
 * Failure to mount is reported, never thrown: a missing GUI costs a panel, a
 * thrown error here costs the whole harness (the boot audit rethrows a failed
 * row).
 */
function mountLedgerApi(ctx, implementation) {
  /*
   * Every route the implementation published: the ledger the panel reads, and the
   * configuration it edits. They are registered one by one so a failure to mount
   * one costs only that one — a panel without its config page still shows the
   * ledger.
   */
  const routes = [implementation.api, implementation.configApi].filter(
    (route) => route !== null && route !== undefined && typeof route.handler === 'function',
  )
  if (routes.length === 0) return
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
