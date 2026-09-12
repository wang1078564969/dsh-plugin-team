/*
 * Git / MR / CI 对接（设计 03 §1.3–§1.7）。
 *
 * 先记住这个形态**做不到**什么：公网 webhook 与卡片按钮都不存在（DSH Web 只监听
 * 127.0.0.1），所以真正开 MR、合并的是执行会话里的 `git` / `gh`。插件负责的是三件它
 * 能负责的事，用例就钉这三件：
 *
 *   1. **约定**：分支名与 `Req:`/`Task:` trailer —— 代码历史与需求对象靠这两行文本双向可追；
 *   2. **判定**：能不能合并由 `mergeDecision` 说话（审批 + CI + 角色），不靠提示词；
 *   3. **不静默**：CI 超时进 `ci_stuck` 并在群里播报 —— 长流水线看起来就是"卡住了"。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { createDocStore } from '../lib/docs.js'
import {
  branchName,
  ciPatch,
  ciState,
  commitProblems,
  commitTrailers,
  indexRepo,
  mergeDecision,
  overviewDoc,
  overviewDocId,
  parseTrailers,
  sensitiveFiles,
} from '../lib/repos.js'
import { Store } from '../lib/store.js'
import { createHandlers } from '../lib/tools.js'

/* ------------------------------------------------------------------ *
 * 约定
 * ------------------------------------------------------------------ */

test('分支名与 trailer：需求一条线，任务分支挂在它下面，提交信息能反查', () => {
  assert.equal(branchName({ requirementId: 'req-2026-014', slug: '支付重试' }), 'req/req-2026-014', '中文标题没有 slug 可用时就是需求分支')
  assert.equal(branchName({ requirementId: 'req-2026-014', slug: 'Pay Retry' }), 'req/req-2026-014-pay-retry')
  assert.equal(branchName({ requirementId: 'req-2026-014', taskId: 'task-8891' }), 'req/req-2026-014/task-8891')
  assert.equal(branchName({ requirementId: '' }), null, '没有需求就没有分支名')

  assert.deepEqual(commitTrailers({ requirementId: 'req-2026-014', taskId: 'task-8891' }), ['Req: req-2026-014', 'Task: task-8891'])
  const parsed = parseTrailers('feat: 退避序列可配置\n\n说明\n\nReq: req-2026-014\nTask: task-8891\n')
  assert.deepEqual(parsed, { req: 'req-2026-014', task: 'task-8891' })
  assert.deepEqual(parseTrailers('忘了写 trailer 的提交'), { req: null, task: null })

  // 不遵守约定不报错，但要说出来：不说，双向可追就静默断了。
  const problems = commitProblems('feat: 退避', { requirementId: 'req-2026-014', taskId: 'task-8891' })
  assert.equal(problems.length, 2)
  assert.match(problems[0].message, /Req: req-2026-014/)
  assert.deepEqual(commitProblems('x\n\nReq: req-2026-014\nTask: task-8891', { requirementId: 'req-2026-014', taskId: 'task-8891' }), [])
})

test('敏感文件：接口契约 / 迁移 / 配置模板 / CI 定义 / 权限', () => {
  const rows = sensitiveFiles([
    'src/api/users.ts',
    'db/migrations/0001_init.sql',
    'config/app.example.yaml',
    '.github/workflows/ci.yml',
    'internal/auth/policy.go',
    'src/utils/format.ts',
    './proto/pay.proto',
  ])
  assert.deepEqual(
    rows.map((one) => one.kind).sort(),
    ['ci', 'config_template', 'contract', 'contract', 'migration', 'permissions'],
  )
  assert.equal(rows.some((one) => one.path === 'src/utils/format.ts'), false, '普通文件不该被算成敏感')
  assert.equal(sensitiveFiles([]).length, 0)
})

/* ------------------------------------------------------------------ *
 * CI 状态机
 * ------------------------------------------------------------------ */

function ciTask(overrides = {}) {
  return {
    id: 'task-1',
    state: 'ci_running',
    ci: { state: 'running', started_at: '2026-09-12T10:00:00.000Z' },
    ...overrides,
  }
}

test('CI 状态：没开始 / 在跑 / 通过 / 卡住（超时但有结论就不算卡）', () => {
  const now = new Date('2026-09-12T10:10:00.000Z')
  assert.equal(ciState({ id: 'x', state: 'in_progress' }, { now }).state, 'idle')
  const running = ciState(ciTask(), { now, timeoutMs: 30 * 60 * 1000 })
  assert.equal(running.state, 'running')
  assert.equal(running.stuck, false, '10 分钟 < 30 分钟')
  assert.equal(running.elapsedMs, 10 * 60 * 1000)

  const stuck = ciState(ciTask(), { now: new Date('2026-09-12T11:00:00.000Z'), timeoutMs: 30 * 60 * 1000 })
  assert.equal(stuck.stuck, true)
  // 已经播报过就不再算"需要再喊一次"（每轮 tick 都喊等于没有告警）。
  const notified = ciState(
    ciTask({ ci: { state: 'running', started_at: '2026-09-12T10:00:00.000Z', stuck_notified_at: '2026-09-12T10:31:00.000Z' } }),
    { now: new Date('2026-09-12T11:00:00.000Z'), timeoutMs: 30 * 60 * 1000 },
  )
  assert.equal(notified.notified, true)
  // 慢 ≠ 失败：超时之后结论照样能进来。
  const passedLate = ciState(
    ciTask({ ci: { state: 'passed', started_at: '2026-09-12T10:00:00.000Z', finished_at: '2026-09-12T11:00:00.000Z' } }),
    { now: new Date('2026-09-12T11:05:00.000Z'), timeoutMs: 30 * 60 * 1000 },
  )
  assert.equal(passedLate.stuck, false)
  assert.equal(passedLate.elapsedMs, 0)
  // 状态不是 ci_running（已经失败退回执行者）也不该报"卡住"。
  assert.equal(ciState({ id: 'x', state: 'in_progress', ci: { state: 'running', started_at: '2026-09-12T10:00:00.000Z' } }, { now: new Date('2026-09-12T12:00:00.000Z') }).stuck, false)
})

test('ciPatch：start 记开始时间，pass/fail 记结束时间，重跑清掉"已播报"标记', () => {
  const now = new Date('2026-09-12T10:00:00.000Z')
  const started = ciPatch({ id: 't', ci: {} }, { state: 'running', url: 'https://ci/1' }, now)
  assert.equal(started.started_at, now.toISOString())
  assert.equal(started.url, 'https://ci/1')
  const failed = ciPatch({ id: 't', ci: started }, { state: 'failed', summary: 'lint 挂了' }, new Date('2026-09-12T10:20:00.000Z'))
  assert.equal(failed.finished_at, '2026-09-12T10:20:00.000Z')
  assert.equal(failed.summary, 'lint 挂了')
  const restarted = ciPatch({ id: 't', ci: { ...failed, stuck_notified_at: 'x' } }, { state: 'running' }, now)
  assert.equal(restarted.stuck_notified_at, null, '重跑时旧告警标记要清掉')
  assert.equal(restarted.started_at, now.toISOString())
})

/* ------------------------------------------------------------------ *
 * 合并判定
 * ------------------------------------------------------------------ */

test('合并三道门：至少一个审批 + CI 通过 + 执行者够格', () => {
  const base = { id: 'task-1', state: 'ci_running', mr: { url: 'https://git/mr/1', approvals: [] }, ci: { state: 'passed', started_at: '2026-09-12T10:00:00.000Z' } }
  // 角色够格（`actorIsOps`）由调用方判定：判定函数要的是"他够不够格"这个结论，
  // 而不是自己去猜角色表 —— 猜的话同一个问题会有两个答案。
  const none = mergeDecision(base, { actor: 'bot:ops', actorIsOps: true })
  assert.equal(none.ok, false)
  assert.deepEqual(none.blockers.map((one) => one.code), ['needs_approval'])

  const approved = { ...base, mr: { ...base.mr, approvals: [{ by: 'human:pm', approved: true }] } }
  const noOps = mergeDecision(approved, { actor: 'bot:dev' })
  assert.equal(noOps.ok, false)
  assert.deepEqual(noOps.blockers.map((one) => one.code), ['actor_not_ops'], 'dev 只能开 MR')

  const noCi = mergeDecision({ ...approved, ci: { state: 'running', started_at: '2026-09-12T10:00:00.000Z' } }, { actor: 'bot:ops', actorIsOps: true })
  assert.equal(noCi.ok, false)
  assert.deepEqual(noCi.blockers.map((one) => one.code), ['ci_not_passed'])

  const noMr = mergeDecision({ ...approved, mr: { url: '', approvals: approved.mr.approvals } }, { actor: 'bot:ops', actorIsOps: true })
  assert.equal(noMr.ok, false)
  assert.deepEqual(noMr.blockers.map((one) => one.code), ['no_mr'])

  const ok = mergeDecision(approved, { actor: 'bot:ops', actorIsOps: true })
  assert.equal(ok.ok, true, JSON.stringify(ok.blockers))
  assert.deepEqual(ok.approvals, ['human:pm'])
  // "至少一个人类审批"里的"人类"：驳回的审批不算数。
  const rejected = { ...base, mr: { ...base.mr, approvals: [{ by: 'human:pm', approved: false }] } }
  assert.equal(mergeDecision(rejected, { actor: 'bot:ops', actorIsOps: true }).ok, false)
  // 没有 actor 一律拒绝（与所有写操作同一条规矩）。
  assert.deepEqual(mergeDecision(approved, { actor: '' }).blockers.map((one) => one.code).includes('no_actor'), true)
})

/* ------------------------------------------------------------------ *
 * 仓库索引
 * ------------------------------------------------------------------ */

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-repo-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export {}\n', 'utf8')
  writeFileSync(join(root, 'test', 'a.test.mjs'), 'x\n', 'utf8')
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n', 'utf8')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pay', scripts: { test: 'node --test', lint: 'eslint .' } }), 'utf8')
  writeFileSync(join(root, 'README.md'), '# 支付服务\n\n负责支付与重试。\n', 'utf8')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('仓库索引：目录、命令、测试入口、CI 文件都扫出来，node_modules 不算', () => {
  const repo = makeRepo()
  try {
    const index = indexRepo(repo.root)
    assert.equal(index.ok, true)
    assert.deepEqual(index.dirs.sort(), ['.github', 'src', 'test'])
    assert.equal(index.dirs.includes('node_modules'), false)
    assert.deepEqual(index.testDirs, ['test'])
    assert.deepEqual(index.ciFiles, ['.github/workflows/ci.yml'])
    assert.deepEqual(Object.keys(index.scripts).sort(), ['lint', 'test'])
    assert.equal(index.modules.find((one) => one.name === 'src').hasEntry, true, 'src/index.ts = 有入口')
    assert.match(index.readme, /支付服务/)
    assert.equal(indexRepo(join(repo.root, 'nope')).ok, false)
  } finally {
    repo.cleanup()
  }
})

test('仓库概览文档：带 frontmatter，直接能给 docs.write；职责要人补', () => {
  const repo = makeRepo()
  try {
    const index = indexRepo(repo.root)
    const spec = overviewDoc('pay-service', index, { owner: 'human:lib', status: 'draft' })
    assert.equal(spec.id, 'spec-pay-service-overview')
    assert.equal(spec.type, 'spec')
    assert.deepEqual(spec.related.repos, ['pay-service'])
    assert.equal(spec.source.kind, 'repo_index')
    assert.match(spec.body, /职责（待补）/)
    assert.match(spec.body, /npm run test/)
    assert.match(spec.body, /\.github\/workflows\/ci\.yml/)
    assert.match(spec.body, /只写看到的事实，不猜语义/)
    // 扫不到内容时也要能写出一份（说明为什么是空的），而不是崩掉。
    const empty = overviewDoc('gone', indexRepo('/does/not/exist'), { owner: 'human:lib' })
    assert.match(empty.body, /这次没有扫到内容/)
    assert.equal(overviewDocId('Pay Service'), 'spec-pay-service-overview')
  } finally {
    repo.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 工具动作（端到端：任务 + CI + MR + 合并）
 * ------------------------------------------------------------------ */

function makeWorld(configOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-repo-actions-'))
  const workspace = join(root, 'ws')
  const config = loadConfig({
    dataDir: root,
    workspace,
    tickIntervalMs: 0,
    bots: [
      { id: 'dev', role: 'dev', enabled: true },
      { id: 'ops', role: 'ops', enabled: true },
    ],
    members: [{ key: 'human:pm', name: 'PM', domains: ['pm'], canApprove: ['development'] }],
    repos: { roots: {}, ciTimeoutMs: 30 * 60 * 1000, ...configOverrides },
    feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
  })
  const store = new Store(root).load()
  const docStore = createDocStore({ workspace })
  docStore.init()
  const deliveries = []
  const notify = {
    task: async (task, opts) => { deliveries.push({ kind: 'task', id: task.id, opts }); return { action: 'create' } },
    notice: async (opts) => { deliveries.push({ kind: 'notice', ...opts }); return { action: 'create' } },
  }
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => {}, drive: async () => ({}) },
    notify,
    docs: docStore,
  })
  store.put('requirement', { id: 'req-2026-014', title: 'pay retry', state: 'dispatched', owner: 'human:pm', origin: { surface: 'feishu', chat_id: 'oc_a' } })
  store.put('task', {
    id: 'task-8891', req: 'req-2026-014', title: '实现退避', state: 'in_progress', type: 'code_change',
    domains: ['development'], assignee: 'bot:dev', owner: 'bot:dev', repo: 'pay-service', branch: null, mr: null,
    acceptance_criteria: ['单测'], gates: [], evidence: [], history: [], release_count: 0,
  })
  return {
    root, workspace, config, store, docStore, handlers, deliveries,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('工具动作：ci 推进状态机并把记账写在任务上', () => {
  const world = makeWorld()
  try {
    const started = world.handlers.ci({ id: 'task-8891', op: 'start', actor: 'bot:dev', url: 'https://ci/1' })
    assert.equal(started.ok, true)
    assert.equal(started.state, 'ci_running')
    assert.equal(started.ci.state, 'running')
    assert.equal(world.store.get('task', 'task-8891').ci.url, 'https://ci/1')

    const failed = world.handlers.ci({ id: 'task-8891', op: 'fail', actor: 'bot:dev', summary: 'lint 挂了' })
    assert.equal(failed.ok, true)
    assert.equal(failed.state, 'in_progress', 'CI 失败回到执行者')
    assert.equal(world.store.get('task', 'task-8891').ci.summary, 'lint 挂了')

    world.handlers.ci({ id: 'task-8891', op: 'start', actor: 'bot:dev' })
    const passed = world.handlers.ci({ id: 'task-8891', op: 'pass', actor: 'bot:dev' })
    assert.equal(passed.state, 'in_review')
    assert.equal(world.handlers.ci({ id: 'task-8891', op: 'status' }).ci.state, 'passed')
    assert.equal(world.handlers.ci({ id: 'task-8891', op: 'nonsense' }).code, 'bad_request')
    // 状态机自己也拦：已经 in_review 了不能再 start。
    assert.equal(world.handlers.ci({ id: 'task-8891', op: 'start', actor: 'bot:dev' }).code !== undefined, true)
  } finally {
    world.cleanup()
  }
})

test('CI 卡住会播报一次，不重复喊（设计 03 §1.5 的 ci_stuck 分支）', async () => {
  const world = makeWorld({ ciTimeoutMs: 60 * 1000 })
  try {
    world.handlers.ci({ id: 'task-8891', op: 'start', actor: 'bot:dev' })
    const task = world.store.get('task', 'task-8891')
    // 把开始时间挪到 10 分钟前（超时线是 1 分钟）。
    world.store.put('task', { ...task, ci: { ...task.ci, started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() } })
    world.deliveries.length = 0

    const first = world.handlers.tick({ dry_run: false })
    const ciRows = first.decided.filter((one) => one.ci === 'ci_stuck')
    assert.equal(ciRows.length, 1)
    assert.equal(ciRows[0].notified, true)
    // 播报是 fire-and-forget（模型/定时器都不该等一张卡发出去），所以要等一拍。
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(world.deliveries.some((one) => one.kind === 'notice' && one.title.includes('CI 迟迟没有结论')), true)
    assert.notEqual(world.store.get('task', 'task-8891').ci.stuck_notified_at, undefined, '播报过要记下来')

    // 第二轮不再喊：每轮都喊等于没有告警。
    const second = world.handlers.tick({ dry_run: false })
    assert.equal(second.decided.filter((one) => one.ci === 'ci_stuck').length, 0)
    // 预演不写状态、也不播报。
    world.store.put('task', { ...world.store.get('task', 'task-8891'), ci: { ...world.store.get('task', 'task-8891').ci, stuck_notified_at: null } })
    world.deliveries.length = 0
    const dry = world.handlers.tick({ dry_run: true })
    assert.equal(dry.decided.filter((one) => one.ci === 'ci_stuck').length, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(world.deliveries.length, 0, '预演不发消息')
  } finally {
    world.cleanup()
  }
})

test('工具动作：repo 给分支/trailer、记 MR、审批、合并三道门', async () => {
  const world = makeWorld()
  try {
    // 分支与 trailer
    const branch = await world.handlers.repo({ op: 'branch', id: 'task-8891' })
    assert.equal(branch.branch, 'req/req-2026-014/task-8891')
    assert.deepEqual(branch.trailers, ['Req: req-2026-014', 'Task: task-8891'])
    assert.equal((await world.handlers.repo({ op: 'branch', id: 'task-8891', message: '忘了 trailer' })).problems.length, 2)

    // 没有检出路径时如实说清楚该配什么
    const noPath = await world.handlers.repo({ op: 'index', repo: 'pay-service' })
    assert.equal(noPath.code, 'no_repo_path')
    assert.match(noPath.message, /repos\.roots\.pay-service/)

    // 记 MR：动到接口契约 → 敏感文件 + 相关文档标 stale
    world.docStore.write({
      id: 'spec-pay-service-overview', type: 'spec', title: 'pay-service 仓库概览', owner: 'human:pm',
      status: 'active', body: '接口说明在这里', related: { repos: ['pay-service'] },
    })
    const linked = await world.handlers.repo({
      op: 'link_mr', id: 'task-8891', url: 'https://git/mr/1', actor: 'bot:dev',
      files: ['src/api/users.ts', 'src/util.ts'],
    })
    assert.equal(linked.ok, true)
    assert.deepEqual(linked.sensitive.map((one) => one.kind), ['contract'])
    assert.deepEqual(linked.stale_docs.map((one) => one.id), ['spec-pay-service-overview'])
    assert.equal(world.docStore.read('spec-pay-service-overview').status, 'stale', '动到接口契约 → 相关文档过期')
    assert.equal(linked.mr.branch, 'req/req-2026-014/task-8891', '记 MR 时顺手把分支写上')

    // 合并：先被审批挡住
    const blocked = await world.handlers.repo({ op: 'merge', id: 'task-8891', actor: 'bot:ops' })
    assert.equal(blocked.code, 'merge_blocked')
    assert.equal(blocked.blockers.some((one) => one.code === 'needs_approval'), true)

    // 非审批人批不了
    assert.equal((await world.handlers.repo({ op: 'approve', id: 'task-8891', actor: 'bot:dev' })).code, 'not_approver')
    const approved = await world.handlers.repo({ op: 'approve', id: 'task-8891', actor: 'human:pm' })
    assert.equal(approved.ok, true)
    assert.equal(approved.approvals, 1)
    // 同一人重复批不会变成两票
    await world.handlers.repo({ op: 'approve', id: 'task-8891', actor: 'human:pm' })
    assert.equal(world.store.get('task', 'task-8891').mr.approvals.length, 1)

    // CI 没过还是不能合并（审批不能替代必过检查）
    const ciBlocked = await world.handlers.repo({ op: 'merge', id: 'task-8891', actor: 'bot:ops' })
    assert.deepEqual(ciBlocked.blockers.map((one) => one.code), ['ci_not_passed'])

    world.handlers.ci({ id: 'task-8891', op: 'start', actor: 'bot:dev' })
    world.handlers.ci({ id: 'task-8891', op: 'pass', actor: 'bot:dev' })
    // dev 不能合并（设计 03 §1.6）
    world.handlers.ci({ id: 'task-8891', op: 'start', actor: 'bot:dev' })
    const notOps = await world.handlers.repo({ op: 'merge', id: 'task-8891', actor: 'bot:dev' })
    assert.deepEqual(notOps.blockers.map((one) => one.code), ['actor_not_ops'])

    const merged = await world.handlers.repo({ op: 'merge', id: 'task-8891', actor: 'bot:ops' })
    assert.equal(merged.ok, true)
    assert.equal(merged.state, 'in_review', '合并之后任务进入验收')
    const saved = world.store.get('task', 'task-8891')
    assert.equal(typeof saved.mr.merged_at, 'string')
    assert.equal(saved.mr.merged_by, 'bot:ops')
  } finally {
    world.cleanup()
  }
})

test('工具动作：repo overview 扫真仓库并写成文档', async () => {
  const repo = makeRepo()
  const world = makeWorld({ roots: { 'pay-service': repo.root } })
  try {
    const indexed = await world.handlers.repo({ op: 'index', repo: 'pay-service' })
    assert.equal(indexed.ok, true)
    assert.deepEqual(indexed.scripts.sort(), ['lint', 'test'])

    const overview = await world.handlers.repo({ op: 'overview', repo: 'pay-service', actor: 'human:pm' })
    assert.equal(overview.ok, true)
    assert.equal(overview.path, 'docs/specs/spec-pay-service-overview.md')
    const doc = world.docStore.read('spec-pay-service-overview')
    assert.equal(doc.frontmatter.owner, 'human:pm')
    assert.equal(doc.frontmatter.status, 'draft', '概览默认是草稿：职责要人补')
    assert.match(doc.body, /顶层结构/)
    // 索引是文档库的一部分：写完就能被 recall 搜到。
    assert.equal(world.docStore.search('仓库概览').length >= 1, true)
  } finally {
    world.cleanup()
    repo.cleanup()
  }
})

test('代码类任务的 prompt 带上分支与 trailer 约定，非代码任务不带', async () => {
  const { taskPrompt } = await import('../lib/exec.js')
  const req = { id: 'req-2026-014', title: 'Pay Retry' }
  const code = taskPrompt({ id: 'task-1', title: '实现退避', type: 'feature_delivery', req: 'req-2026-014' }, req)
  assert.match(code, /req\/req-2026-014\/task-1/)
  assert.match(code, /`Req: req-2026-014` 与 `Task: task-1`/)
  const doc = taskPrompt({ id: 'task-2', title: '写文档', type: 'doc_update', req: 'req-2026-014' }, req)
  assert.equal(doc.includes('团队约定'), false)
})
