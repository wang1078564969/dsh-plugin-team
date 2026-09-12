/*
 * The bots' conversations must be findable in the host's own client.
 *
 * Three things have to be true for that (see lib/workspace.js), and each of them
 * can be absent in a given deployment: no workspace registry, a session whose log
 * is not durable yet, a Feishu app without chat-info permission. So the property
 * this file pins is not "it works" but "it never costs the bot": every failure
 * mode here leaves the answer path intact.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkspaceLink, fetchChatTitle } from '../lib/workspace.js'

function fakeCtx(services) {
  const calls = { renamed: [], flushed: [] }
  const ctx = {
    calls,
    get(name) {
      if (name === 'workspaceRegistry') return services.registry
      if (name === 'sessionTitle') {
        return {
          rename(session, title) {
            calls.renamed.push({ session, title })
            return { title }
          },
        }
      }
      if (name === 'sessions') {
        return {
          async flush(session) {
            calls.flushed.push(session)
            return true
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

function fakeRegistry(overrides = {}) {
  const calls = { created: [], attached: [] }
  const workspace = {
    id: 'ws-1',
    path: '/tmp/team-ws',
    title: '团队 · 飞书',
    async attachSession(sessionId) {
      calls.attached.push(sessionId)
    },
    ...overrides,
  }
  return {
    calls,
    workspace,
    async create(path, title) {
      calls.created.push({ path, title })
      return workspace
    },
  }
}

function makeLink(services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-ws-'))
  const config = { workspace: dir, workspaceTitle: '团队 · 飞书' }
  const ctx = fakeCtx(services)
  const link = createWorkspaceLink({ ctx, config, log: { log: () => {}, error: () => {} } })
  return { link, ctx, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the first chat session registers the workspace, attaches the session, names it and flushes it', async () => {
  const registry = fakeRegistry()
  const world = makeLink({ registry })
  try {
    const session = { id: 'feishu-oc_a' }
    await world.link.onSession({ sessionId: 'feishu-oc_a', session, chatTitle: '需求群' })

    assert.equal(registry.calls.created.length, 1)
    assert.equal(registry.calls.created[0].title, '团队 · 飞书')
    assert.deepEqual(registry.calls.attached, ['feishu-oc_a'])
    assert.equal(world.ctx.calls.renamed.length, 1)
    assert.equal(world.ctx.calls.renamed[0].title, '飞书 · 需求群', 'the sidebar label is the chat a human knows')
    assert.equal(world.ctx.calls.flushed.length, 1, 'a session that is not durable yet cannot be listed')

    // The registry is asked ONCE, not once per message.
    await world.link.onSession({ sessionId: 'feishu-oc_b', session: { id: 'feishu-oc_b' }, chatTitle: '开发群' })
    assert.equal(registry.calls.created.length, 1)
    assert.deepEqual(registry.calls.attached, ['feishu-oc_a', 'feishu-oc_b'])
    assert.equal(world.ctx.calls.renamed[1].title, '飞书 · 开发群')
  } finally {
    world.cleanup()
  }
})

test('a profile without a workspace registry still answers — the session is just unlisted', async () => {
  const world = makeLink({})
  try {
    await world.link.onSession({ sessionId: 'feishu-oc_a', session: { id: 'feishu-oc_a' }, chatTitle: '需求群' })
    assert.equal(world.link.workspace, null)
    // The other two duties are independent of the registry and still happen.
    assert.equal(world.ctx.calls.flushed.length, 1)
    assert.equal(world.ctx.calls.renamed.length, 1)
  } finally {
    world.cleanup()
  }
})

test('a broken registry, a broken attach or a missing title never throw', async () => {
  const exploding = makeLink({
    registry: {
      async create() {
        throw new Error('registry unavailable')
      },
    },
  })
  try {
    await exploding.link.onSession({ sessionId: 'feishu-oc_a', session: { id: 'feishu-oc_a' }, chatTitle: 'x' })
    assert.equal(exploding.link.workspace, null, 'a failed registration is remembered as "no workspace", not retried per message')
  } finally {
    exploding.cleanup()
  }

  const badAttach = makeLink({
    registry: fakeRegistry({
      async attachSession() {
        throw new Error('not attachable')
      },
    }),
  })
  try {
    await badAttach.link.onSession({ sessionId: 'feishu-oc_a', session: { id: 'feishu-oc_a' }, chatTitle: '需求群' })
    assert.equal(badAttach.ctx.calls.renamed.length, 1, 'a failed attach must not stop the naming')
  } finally {
    badAttach.cleanup()
  }

  // No session object at all (a caller that only knows the id) is fine.
  const noSession = makeLink({ registry: fakeRegistry() })
  try {
    await noSession.link.onSession({ sessionId: 'feishu-oc_a' })
    assert.equal(noSession.ctx.calls.flushed.length, 0)
  } finally {
    noSession.cleanup()
  }
})

test('the chat name is a best-effort label, never a precondition', async () => {
  const ok = {
    ready: true,
    async call(path) {
      assert.match(path, /\/open-apis\/im\/v1\/chats\/oc_a/)
      return { ok: true, data: { name: 'AAB' } }
    },
  }
  assert.equal(await fetchChatTitle(ok, 'oc_a'), 'AAB')

  const denied = { ready: true, async call() { return { ok: false, code: 99991672, msg: 'no permission' } } }
  assert.equal(await fetchChatTitle(denied, 'oc_a'), null)
  const nameless = { ready: true, async call() { return { ok: true, data: {} } } }
  assert.equal(await fetchChatTitle(nameless, 'oc_a'), null)
  const offline = { ready: false, async call() { throw new Error('should not be called') } }
  assert.equal(await fetchChatTitle(offline, 'oc_a'), null)
  assert.equal(await fetchChatTitle(null, 'oc_a'), null)
})

test('a workspace registry that arrives LATE is still used', async () => {
  /*
   * The registry waits for session persistence and builds its header index
   * before it becomes active, so it does not exist yet when a last-layer row's
   * apply() runs. A one-shot `ctx.get` therefore returns undefined, the plugin
   * concludes "no workspaces here", and the sidebar entry never shows up — with
   * no error anywhere. This test is that failure, pinned.
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-ws-late-'))
  const calls = { created: [], attached: [] }
  const workspace = {
    async attachSession(sessionId) {
      calls.attached.push(sessionId)
    },
  }
  const registry = {
    async create(path, title) {
      calls.created.push({ path, title })
      return workspace
    },
  }
  let release = () => {}
  const ctx = {
    // Not available the direct way — exactly like the real boot.
    get: (name) => (name === 'workspaceRegistry' ? undefined : undefined),
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('workspaceRegistry')) {
        // The service shows up a moment later, as it does in reality.
        const timer = setTimeout(() => callback({ workspaceRegistry: registry }), 80)
        if (typeof timer.unref === 'function') timer.unref()
        release = () => {}
      }
      return () => {}
    },
  }
  const link = createWorkspaceLink({ ctx, config: { workspace: dir, workspaceTitle: '团队 · 飞书' }, log: { log: () => {}, error: () => {} } })
  try {
    const ws = await link.ensureWorkspace()
    assert.notEqual(ws, null, 'the waiting acquisition must find it')
    assert.equal(calls.created.length, 1)
    assert.equal(calls.created[0].path, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a profile where the registry never arrives gives up instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-ws-none-'))
  const ctx = { get: () => undefined, inject: () => () => {} }
  const link = createWorkspaceLink({ ctx, config: { workspace: dir }, log: { log: () => {}, error: () => {} } })
  try {
    const started = Date.now()
    const ws = await link.ensureWorkspace()
    assert.equal(ws, null)
    assert.ok(Date.now() - started >= 1900, 'it waits for the service, then gives up')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
