/*
 * The entry point's wiring, including the bug that made the GUI panel 404.
 *
 * WHAT WENT WRONG, BECAUSE THE TEST IS SHAPED AROUND IT. `mountLedgerApi` used
 * to read the connection service with `ctx.get('connection')` and give up when
 * it came back undefined. In the WEB profile — where the service demonstrably
 * exists — that one-shot read still returned undefined, because the service is
 * provided later in the boot than a last-layer row's `apply()`. The result was
 * the worst combination available: the row mounted, the tool registered, the
 * panel rendered, and its route answered 404.
 *
 * The fix is acquisition, not probing: `ctx.inject(['connection'], cb)` waits
 * for the service and runs the callback with a context that can reach it — which
 * is exactly how DSH's own api gateway does it.
 *
 * So the fake context here is deliberately hostile in one specific way:
 * `get('connection')` returns UNDEFINED while `inject(['connection'], …)` works.
 * If someone reintroduces the probe, this test fails.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** A context whose connection service is reachable ONLY through inject. */
function fakeCtx() {
  const registered = { tools: [], routes: [] }
  const effects = []
  const connection = {
    fetch: {
      register(route) {
        registered.routes.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    registered,
    effects,
    /*
     * `tools` arrives as a PROPERTY, not through `get`: the row declares it in
     * `inject`, and Cordis materializes it on the context. That is exactly why
     * the plugin's entry declares `inject = ['tools']` and nothing else.
     */
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    get(name) {
      // The point of the test: connection is never available this way.
      return undefined
    },
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('connection')) {
        // Hand back a context on which the property DOES resolve.
        callback({ effect: (factory) => effects.push(factory()), connection })
      }
      return () => {}
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on() {
      return () => {}
    },
  }
  return ctx
}

test('the ledger route is mounted even though ctx.get("connection") yields nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-route-'))
  try {
    const ctx = fakeCtx()
    await apply(ctx, { dataDir: dir, workspace: join(dir, 'ws'), tickIntervalMs: 0 })

    // The tool half must be up regardless of the route.
    assert.equal(ctx.registered.tools.length, 1)
    assert.equal(ctx.registered.tools[0].name, 'team')

    /*
     * And all FOUR routes must be up — through inject, not through the probe:
     * the entry's own boot self-report, the ledger the panel shows, the
     * configuration it edits, and the logs it tails（静态的走配置、滚动的走日志：
     * 配置快照每 3 秒重算一遍名册与自检是浪费，自检还会真调飞书）。
     */
    const paths = ctx.registered.routes.map((route) => route.path).sort()
    assert.deepEqual(paths, ['/api/team/boot', '/api/team/config', '/api/team/ledger', '/api/team/logs'])
    for (const route of ctx.registered.routes) {
      // 自述路由只有 GET（它不改任何东西），其余三条读写都要。
      assert.deepEqual(route.methods, route.path === '/api/team/boot' ? ['GET'] : ['GET', 'POST'], route.path)
      assert.equal(route.requestBody, 'buffered', route.path)
      assert.equal(typeof route.fetch, 'function', route.path)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the mounted route serves a snapshot and refuses an unattributed write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-route-'))
  try {
    const ctx = fakeCtx()
    await apply(ctx, { dataDir: dir, workspace: join(dir, 'ws'), tickIntervalMs: 0 })
    const route = ctx.registered.routes.find((r) => r.path === '/api/team/ledger')

    const snapshot = await route.fetch(new Request('http://gui.local/api/team/ledger', { method: 'GET' }))
    assert.equal(snapshot.status, 200)
    const body = await snapshot.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.counts, { requirements: 0, tasks: 0, leases: 0, runs: 0 })

    const refused = await route.fetch(
      new Request('http://gui.local/api/team/ledger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create_requirement', title: '没有 actor' }),
      }),
    )
    const refusedBody = await refused.json()
    assert.equal(refusedBody.ok, false)
    assert.match(refusedBody.message, /actor/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
