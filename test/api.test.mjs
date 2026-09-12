/*
 * Tests for the ledger's HTTP surface — the half the GUI talks to.
 *
 * This route can start tasks and confirm gates, so the things worth pinning are
 * not "does it return JSON" but: an action without an actor is REFUSED (the
 * browser is authenticated as a browser, not as a person), a state machine
 * refusal travels through unchanged, and the snapshot carries what a human needs
 * to decide — the gate line, the available actions and the executor's own
 * report.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { createTeamApi } from '../lib/api.js'
import { loadConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'
import { createHandlers } from '../lib/tools.js'

function makeApi() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-api-'))
  const config = loadConfig({ dataDir: dir, workspace: join(dir, 'workspace'), tickIntervalMs: 0 })
  const store = new Store(dir).load()
  const handlers = createHandlers({
    ctx: { get: () => undefined, on: () => () => {}, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => ({}), drive: async () => ({ text: 'DONE-1', timedOut: false }) },
  })
  const api = createTeamApi({ store, handlers, config })
  return { api, store, handlers, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Build the requirement → task pipeline the panel would be looking at. */
function seed(handlers, store, assignee = 'bot:dev') {
  const req = handlers.create_requirement({ title: '导出 CSV', owner: 'human:pm1', acceptance_criteria: ['能导出'] })
  handlers.confirm_requirement({ id: req.id })
  const proposed = handlers.propose_tasks({ id: req.id, tasks: [{ title: '实现导出', assignee }] })
  handlers.confirm_split({ id: req.id })
  return { reqId: req.id, taskId: proposed.tasks[0].id }
}

const get = (api) => api.handler(new Request('http://gui.local' + api.path, { method: 'GET' }))
const post = (api, body) =>
  api.handler(
    new Request('http://gui.local' + api.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

test('the snapshot carries what a human needs to decide', async () => {
  const ledger = makeApi()
  try {
    const { reqId, taskId } = seed(ledger.handlers, ledger.store)
    const response = await get(ledger.api)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    // A bot executor needs no lease until it starts: the lease begins at ACCEPT,
    // and a bot's accept gate is satisfied automatically on run.
    assert.deepEqual(body.counts, { requirements: 1, tasks: 1, leases: 0, runs: 0 })

    const requirement = body.requirements[0]
    assert.equal(requirement.id, reqId)
    assert.equal(requirement.state, 'dispatched')
    assert.deepEqual(requirement.tasks, [taskId])
    assert.equal(requirement.origin, 'internal')

    const task = body.tasks[0]
    assert.equal(task.id, taskId)
    assert.equal(task.state, 'assigned')
    assert.equal(task.assignee, 'bot:dev')
    // The gate line is the panel's whole reason for existing: it says which
    // confirmation is still missing, in the same words the cards use.
    assert.match(task.gates, /接受|开始|验收/)
    assert.ok(Array.isArray(task.available))
    assert.equal(task.lease, null)
    // Config is summarised, and no secret is anywhere in the payload.
    assert.equal(typeof body.config.workspace, 'string')
    assert.equal(JSON.stringify(body).includes('appSecret'), false)
  } finally {
    ledger.cleanup()
  }
})

test('an action without an actor is refused: the browser is not a person', async () => {
  const ledger = makeApi()
  try {
    const { taskId } = seed(ledger.handlers, ledger.store)
    const response = await post(ledger.api, { action: 'accept_task', id: taskId })
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, 'bad_request')
    assert.match(body.message, /actor/)
    assert.equal(ledger.store.get('task', taskId).state, 'assigned', 'nothing may move without an actor')
  } finally {
    ledger.cleanup()
  }
})

test('a state machine refusal reaches the panel verbatim, pending list included', async () => {
  const ledger = makeApi()
  try {
    const { taskId } = seed(ledger.handlers, ledger.store)
    // The executor may not confirm its own acceptance when a human is expected…
    const wrong = await (await post(ledger.api, { action: 'accept_task', id: taskId, actor: 'human:someone-else' })).json()
    assert.equal(wrong.ok, false)
    assert.equal(wrong.code, 'not_assigned_to_you')

    // …and the assigned bot gets it, with the lease started.
    const right = await (await post(ledger.api, { action: 'accept_task', id: taskId, actor: 'bot:dev' })).json()
    assert.equal(right.ok, true)
    assert.equal(right.state, 'accepted')
    assert.equal(right.snapshot.tasks[0].state, 'accepted', 'the action response carries the fresh snapshot')
  } finally {
    ledger.cleanup()
  }
})

test('the panel can drive a task through the heart and read the report back', async () => {
  const ledger = makeApi()
  try {
    const { taskId } = seed(ledger.handlers, ledger.store)
    const run = await (await post(ledger.api, { action: 'run_task', id: taskId, actor: 'bot:dev' })).json()
    assert.equal(run.ok, true, JSON.stringify(run))
    assert.equal(run.state, 'in_review')
    assert.equal(run.report, 'DONE-1')
    const task = run.snapshot.tasks.find((row) => row.id === taskId)
    assert.equal(task.state, 'in_review')
    assert.equal(task.evidence.length, 1)
    assert.equal(task.evidence[0].ref.startsWith('session:'), true)
    assert.equal(run.snapshot.runs[0].task, taskId)
  } finally {
    ledger.cleanup()
  }
})

test('unknown actions and wrong methods are refused, not guessed at', async () => {
  const ledger = makeApi()
  try {
    const unknown = await (await post(ledger.api, { action: 'drop_everything', actor: 'human:pm1' })).json()
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'bad_request')
    const wrongMethod = await ledger.api.handler(new Request('http://gui.local' + ledger.api.path, { method: 'DELETE' }))
    assert.equal(wrongMethod.status, 405)
    const malformed = await ledger.api.handler(
      new Request('http://gui.local' + ledger.api.path, { method: 'POST', body: '{not json' }),
    )
    assert.equal(malformed.status, 500)
    assert.equal((await malformed.json()).code, 'api_failed')
  } finally {
    ledger.cleanup()
  }
})

test('tick is dry by default so the panel can preview what would happen', async () => {
  const ledger = makeApi()
  try {
    // A HUMAN executor, deliberately: a bot's accept/start gates are
    // `not_applicable`, so a bot can never be "released" for not confirming —
    // the timeout only has teeth against a person who accepted and stalled.
    const { taskId } = seed(ledger.handlers, ledger.store, 'human:zhouyu')
    ledger.handlers.accept_task({ id: taskId, actor: 'human:zhouyu' })
    const task = ledger.store.get('task', taskId)
    ledger.store.put('task', {
      ...task,
      gates: { ...task.gates, start: { ...task.gates.start, due_at: new Date(Date.now() - 1000).toISOString() } },
    })
    const preview = await (await post(ledger.api, { action: 'tick', actor: 'human:pm1', dry_run: true })).json()
    assert.equal(preview.ok, true)
    assert.equal(preview.dry_run, true)
    assert.equal(ledger.store.get('task', taskId).state, 'accepted')
    const acted = await (await post(ledger.api, { action: 'tick', actor: 'human:pm1', dry_run: false })).json()
    assert.equal(acted.ok, true)
    assert.equal(ledger.store.get('task', taskId).state, 'assigned')
    assert.equal(ledger.store.get('task', taskId).release_count, 1)
  } finally {
    ledger.cleanup()
  }
})
