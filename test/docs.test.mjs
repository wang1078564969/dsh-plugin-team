/*
 * 文档载体与回忆（设计 01 §4、07 §0.2/§0.3）。
 *
 * 这一层的失败方式很安静：文档写进去了、索引没跟上、或者一份被推翻的决策继续被
 * 当成答案引用 —— 三种都不会报错，只会在三个月后表现为"团队记忆是一堆没人找得到
 * 或者已经过期的 md"。所以用例钉的是四件事：
 *
 *   1. **frontmatter 是硬要求**：缺 owner / 缺日期 / type 不认识 → 一个字节都不写；
 *   2. **索引是派生物**：`docs/index.md` 与 `_meta/docs.json` 能从 frontmatter 重建；
 *   3. **陈旧检测**：引用了已被取代的文档 → 出现在报告里，并说清为什么；
 *   4. **回忆的三个来源**：工作区文档、DSH 会话历史、台账 —— 查不到的那一半要**说出来**，
 *      而不是拿一个空数组装作"历史上什么都没有"。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDocStore,
  DOC_STATUSES,
  DOC_TYPES,
  docPath,
  docsRoot,
  parseDoc,
  renderIndex,
  REQUIRED_FIELDS,
  serializeFrontmatter,
  validateFrontmatter,
} from '../lib/docs.js'
import { createRecall } from '../lib/recall.js'
import { createHandlers } from '../lib/tools.js'
import { loadConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'

const ACTIVE = {
  id: 'spec-pay-retry',
  type: 'spec',
  title: '支付重试策略',
  owner: 'human:u123',
  status: 'active',
  created: '2026-01-10',
  updated: '2026-02-03',
}

function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-docs-'))
  const workspace = join(root, 'ws')
  const store = createDocStore({ workspace })
  store.init()
  return { root, workspace, store, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/* ------------------------------------------------------------------ *
 * frontmatter
 * ------------------------------------------------------------------ */

test('frontmatter 解析与序列化：数组、内联对象、日期，且拒绝认不出来的行', () => {
  const text = [
    '---',
    'id: spec-pay-retry',
    'type: spec',
    'title: 支付重试策略',
    'owner: human:u123',
    'status: active',
    'created: 2026-01-10',
    'updated: 2026-02-03',
    'supersedes: [spec-pay-retry-v1]',
    'related: { requirements: [req-2026-014], repos: [pay-service] }',
    '---',
    '',
    '## 结论',
    '',
    '指数退避。',
  ].join('\n')
  const parsed = parseDoc(text)
  assert.deepEqual(parsed.problems, [])
  assert.equal(parsed.frontmatter.id, 'spec-pay-retry')
  assert.deepEqual(parsed.frontmatter.supersedes, ['spec-pay-retry-v1'])
  assert.deepEqual(parsed.frontmatter.related, { requirements: ['req-2026-014'], repos: ['pay-service'] })
  assert.match(parsed.body, /^## 结论/)

  // 往回序列化之后再解析，结果一样（索引与陈旧检测都指望这条往返）。
  const round = parseDoc(serializeFrontmatter(parsed.frontmatter) + '\n\n' + parsed.body)
  assert.deepEqual(round.frontmatter, parsed.frontmatter)

  // 认不出来的行**不猜**：报问题，让人改。
  const broken = parseDoc('---\nid: x\n这行没有冒号\n---\n\nbody\n')
  assert.equal(broken.problems.length, 1)
  assert.match(broken.problems[0], /认不出的行/)
  // 没有头 / 没收尾都要说清楚。
  assert.match(parseDoc('没有头').problems[0], /没有 frontmatter/)
  assert.match(parseDoc('---\nid: x\n').problems[0], /没有收尾/)
})

test('校验：必填字段、id 形状、type/status 取值、日期格式', () => {
  assert.equal(validateFrontmatter(ACTIVE).ok, true)
  const missing = validateFrontmatter({ id: 'x', type: 'spec' })
  assert.deepEqual(missing.problems.map((one) => one.path).sort(), ['created', 'owner', 'status', 'title', 'updated'])
  assert.equal(validateFrontmatter(null).problems[0].path, 'frontmatter')
  assert.match(validateFrontmatter({ ...ACTIVE, id: 'Bad Id' }).problems[0].message, /小写字母/)
  assert.match(validateFrontmatter({ ...ACTIVE, type: 'essay' }).problems[0].message, /type 必须是/)
  assert.match(validateFrontmatter({ ...ACTIVE, status: 'done' }).problems[0].message, /status 必须是/)
  assert.match(validateFrontmatter({ ...ACTIVE, updated: '2026/02/03' }).problems[0].message, /yyyy-mm-dd/)
  assert.equal(validateFrontmatter({ ...ACTIVE, visibility: 'project:pay' }).ok, true, 'project:<名字> 是合法 visibility')
  // 必填清单与目录规范是**对外承诺**，改动要在测试里显式发生。
  assert.deepEqual(REQUIRED_FIELDS, ['id', 'type', 'title', 'owner', 'status', 'created', 'updated'])
  assert.equal(DOC_TYPES.includes('requirement_view'), true)
  assert.deepEqual(DOC_STATUSES, ['draft', 'active', 'stale', 'superseded', 'archived'])
})

/* ------------------------------------------------------------------ *
 * 写入与索引
 * ------------------------------------------------------------------ */

test('写入：按类型落目录、缺字段一个字节都不写、更新不改 created', () => {
  const world = makeWorld()
  try {
    const first = world.store.write({ ...ACTIVE, body: '第一版' })
    assert.equal(first.ok, true)
    assert.equal(first.path, 'docs/specs/spec-pay-retry.md')
    assert.equal(first.created, true)
    assert.equal(world.store.read('spec-pay-retry').body.trim(), '第一版')

    // 缺 owner：拒绝，而且文件**没有**被写出来。
    const rejected = world.store.write({ id: 'spec-x', type: 'spec', title: 'x', body: 'body' })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'invalid_frontmatter')
    assert.equal(world.store.read('spec-x'), null)
    assert.equal(world.store.list().length, 1, '被拒的写入不留痕')

    // 更新：created 保持第一次的日期，updated 变成今天。
    const updated = world.store.write({ ...ACTIVE, body: '第二版' })
    assert.equal(updated.created, false)
    assert.equal(updated.frontmatter.created, first.frontmatter.created)
    assert.equal(world.store.read('spec-pay-retry').body.trim(), '第二版')

    // 目录规范：decision 落 decisions、runbook 落 runbooks。
    world.store.write({ id: 'adr-1', type: 'decision', title: '用 DSH 会话历史当记忆', owner: 'human:a', status: 'active', body: 'x' })
    world.store.write({ id: 'rb-1', type: 'runbook', title: '发布流程', owner: 'human:a', status: 'active', body: 'x' })
    assert.equal(world.store.read('adr-1').path, 'docs/decisions/adr-1.md')
    assert.equal(world.store.read('rb-1').path, 'docs/runbooks/rb-1.md')
    assert.equal(docPath(world.workspace, 'rb-1', 'runbook'), join(docsRoot(world.workspace), 'runbooks', 'rb-1.md'))
  } finally {
    world.cleanup()
  }
})

test('草稿要人点头才转正：必须有确认人、只从 draft 出发、正文不动（R10.4）', () => {
  /*
   * 机器人沉淀的知识默认落 `draft`（"幻觉不该直接进主副本"）。但一份永远转不了正的
   * 草稿等于没有沉淀 —— 这条钉住那个动作的三条边界：谁点头、从哪出发、动什么。
   */
  const world = makeWorld()
  try {
    const written = world.store.write({ id: 'note-retry', type: 'note', title: '重试策略的结论', owner: 'bot:req', body: '三次指数退避，上限 30s' })
    assert.equal(written.ok, true)
    assert.equal(world.store.read('note-retry').status, 'draft')

    // 没有确认人：拒绝，而且是"一个字节都不写"的那一档
    const noOne = world.store.confirm('note-retry', {})
    assert.equal(noOne.ok, false)
    assert.equal(noOne.code, 'bad_request')
    assert.equal(world.store.read('note-retry').status, 'draft')

    const done = world.store.confirm('note-retry', { by: 'human:pm1' })
    assert.equal(done.ok, true, JSON.stringify(done))
    const doc = world.store.read('note-retry')
    assert.equal(doc.status, 'active')
    assert.equal(doc.frontmatter.confirmed_by, 'human:pm1', '谁点头的要写下来')
    assert.equal(doc.frontmatter.confirmed_at, doc.frontmatter.updated)
    assert.equal(doc.body.trim(), '三次指数退避，上限 30s', '确认是元数据动作，正文一个字都不动')

    // 已经转正的再来一次：说清"现在是什么状态"，而不是悄悄再写一遍
    const again = world.store.confirm('note-retry', { by: 'human:pm1' })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'invalid_state')
    assert.match(again.message, /active/)

    // 不存在的文档
    assert.equal(world.store.confirm('note-nope', { by: 'human:pm1' }).code, 'not_found')

    // 索引能跟上（status 变了，index.md 里那份也变）
    world.store.rebuildIndex()
    assert.match(readFileSync(join(world.workspace, 'docs', 'index.md'), 'utf8'), /note-retry/)
  } finally {
    world.cleanup()
  }
})

test('索引可重建：index.md 与 _meta/docs.json 都从 frontmatter 现算', () => {
  const world = makeWorld()
  try {
    world.store.write({ ...ACTIVE, body: 'x' })
    world.store.write({ id: 'adr-2026-001', type: 'decision', title: '记忆不建库', owner: 'human:a', status: 'active', body: 'y' })
    const result = world.store.rebuildIndex()
    assert.equal(result.ok, true)
    assert.equal(result.count, 2)

    const index = readFileSync(join(docsRoot(world.workspace), 'index.md'), 'utf8')
    assert.match(index, /^# 团队文档/)
    assert.match(index, /## decision（1）/)
    assert.match(index, /\[`adr-2026-001`\]\(docs\/decisions\/adr-2026-001\.md\) — 记忆不建库/)
    assert.match(index, /手改会被下一次重建覆盖/, '要写清楚它是派生物')

    const meta = JSON.parse(readFileSync(join(world.workspace, '_meta', 'docs.json'), 'utf8'))
    assert.equal(meta.count, 2)
    assert.deepEqual(meta.docs.map((one) => one.id).sort(), ['adr-2026-001', 'spec-pay-retry'])

    // 派生物就是派生物：手改 index 之后重建会覆盖回去（"不允许只在索引里存在的内容"）。
    writeFileSync(join(docsRoot(world.workspace), 'index.md'), '# 我手写的目录\n', 'utf8')
    world.store.rebuildIndex()
    assert.match(readFileSync(join(docsRoot(world.workspace), 'index.md'), 'utf8'), /spec-pay-retry/)
    // 反过来：一份**没有 frontmatter** 的 md 会在 list 里带着问题出现，而不是被静默忽略。
    writeFileSync(join(docsRoot(world.workspace), 'notes', 'draft-idea.md'), '想法，没有 frontmatter\n', 'utf8')
    const listed = world.store.list().find((doc) => doc.id === 'draft-idea')
    assert.equal(listed.problems.length > 0, true)
    assert.match(listed.problems[0], /没有 frontmatter/)
    assert.match(world.store.rebuildIndex().problems.map((one) => one.id).join(','), /draft-idea/)
  } finally {
    world.cleanup()
  }
})

test('renderIndex 是纯函数：空库也要给出"下一步做什么"', () => {
  const text = renderIndex([])
  assert.match(text, /共 0 份/)
  assert.match(text, /还没有文档/)
})

/* ------------------------------------------------------------------ *
 * 陈旧检测
 * ------------------------------------------------------------------ */

test('陈旧检测：引用了被取代的文档、太久没更新，都要能被指出来', () => {
  const world = makeWorld()
  try {
    world.store.write({ id: 'spec-v1', type: 'spec', title: '旧方案', owner: 'human:a', status: 'superseded', body: '旧' })
    world.store.write({
      ...ACTIVE,
      body: '新',
      related: { docs: ['spec-v1'], requirements: ['req-2026-014'] },
    })
    world.store.write({ id: 'old-note', type: 'note', title: '很久没动', owner: 'human:b', status: 'active', body: 'x' })
    // 手动把 updated 改老（模拟"半年没碰过"）。
    const file = join(docsRoot(world.workspace), 'notes', 'old-note.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/updated: \d{4}-\d{2}-\d{2}/, 'updated: 2025-01-01'), 'utf8')

    const report = world.store.staleReport({ staleAfterDays: 180 })
    const byId = new Map(report.rows.map((row) => [row.id, row]))
    assert.equal(byId.has('spec-pay-retry'), true, '引用了 superseded 的文档要进报告')
    assert.equal(byId.get('spec-pay-retry').reasons[0].kind, 'superseded_reference')
    assert.match(byId.get('spec-pay-retry').reasons[0].message, /spec-v1/)
    assert.equal(byId.has('old-note'), true, '太久没更新的 active 文档要进报告')
    assert.equal(byId.get('old-note').reasons[0].kind, 'stale_by_age')
    assert.equal(byId.has('spec-v1'), false, '已经被取代的文档自己不需要"待更新"提醒')

    // 引用图两个方向都要有：谁取代了谁、谁引用了谁。
    assert.deepEqual(report.referencing.get('spec-v1'), ['spec-pay-retry'])
    const stats = world.store.stats()
    assert.equal(stats.count, 3)
    assert.equal(stats.stale, 1)
    assert.deepEqual(Object.keys(stats.byType).sort(), ['note', 'spec'])
  } finally {
    world.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 检索与回忆
 * ------------------------------------------------------------------ */

test('检索：标题命中优先，stale 的照样返回但带标记', () => {
  const world = makeWorld()
  try {
    world.store.write({ ...ACTIVE, body: '正文里也提到退避' })
    world.store.write({ id: 'note-other', type: 'note', title: '别的', owner: 'human:b', status: 'stale', body: '退避这个词也在这里' })
    const rows = world.store.search('退避')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].id, 'spec-pay-retry', '标题命中排在正文命中前面')
    assert.equal(rows[0].stale, false)
    const staleRow = rows.find((row) => row.id === 'note-other')
    assert.equal(staleRow.stale, true, '过期的照样返回，但必须标出来')
    assert.match(staleRow.excerpt, /退避/)
    assert.equal(world.store.search('退避', { types: ['spec'] }).length, 1, '类型过滤')
    assert.equal(world.store.search('不存在的东西').length, 0)
  } finally {
    world.cleanup()
  }
})

test('回忆：三个来源合一，查不到的那一半要说出原因', async () => {
  const world = makeWorld()
  try {
    world.store.write({ ...ACTIVE, body: '指数退避与抖动' })
    const store = new Store(world.root).load()
    store.put('requirement', { id: 'req-2026-014', title: '支付重试与退避', state: 'dispatched' })

    const sessions = {
      searchSessions: async ({ query, limit }) => ({
        items: [
          { header: { id: 'team-bot-dev-oc_a', createdAt: Date.parse('2026-09-10T00:00:00Z'), cwd: '/tmp/ws' }, live: false, persisted: true, bestMatch: { snippet: '…' + query + ' 那次我们决定用指数退避…' } },
        ].slice(0, limit),
      }),
    }
    const recall = createRecall({ docs: world.store, store, sessionQuery: () => sessions })
    const result = await recall.recall('退避')
    assert.equal(result.ok, true)
    assert.equal(result.docs[0].id, 'spec-pay-retry')
    assert.equal(result.sessions[0].id, 'team-bot-dev-oc_a')
    assert.equal(result.sessions[0].persisted, true)
    assert.match(result.sessions[0].snippet, /指数退避/)
    assert.deepEqual(result.ledger.map((one) => one.id), ['req-2026-014'])
    assert.match(result.notes.join(' '), /台账里有 1 个/)

    // 没有 sessionQuery：如实说"这一半没查"，而不是空数组假装什么都没有。
    const blind = createRecall({ docs: world.store, store, sessionQuery: () => null })
    const blindResult = await blind.recall('退避')
    assert.equal(blindResult.sessions, null)
    assert.match(blindResult.notes.join(' '), /会话历史检索不可用/)

    // 会话检索抛异常也不能把文档与台账的结果弄丢。
    const broken = createRecall({
      docs: world.store,
      store,
      sessionQuery: () => ({ searchSessions: async () => { throw new Error('索引坏了') } }),
    })
    const brokenResult = await broken.recall('退避')
    assert.equal(brokenResult.docs.length, 1)
    assert.equal(brokenResult.sessions, null)
    assert.match(brokenResult.notes.join(' '), /索引坏了/)

    // 命中 stale 文档时要在 notes 里提醒（"知道过期的"比"不知道"安全）。
    world.store.write({ id: 'note-old', type: 'note', title: '退避旧记', owner: 'human:b', status: 'stale', body: 'x' })
    const staleResult = await recall.recall('退避')
    assert.match(staleResult.notes.join(' '), /stale\/superseded/)
  } finally {
    world.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 工具动作
 * ------------------------------------------------------------------ */

function makeHandlers(world) {
  const config = loadConfig({ dataDir: world.root, tickIntervalMs: 0, bots: [], workspace: world.workspace, feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' } })
  const store = new Store(world.root).load()
  const recorded = []
  const recall = { recall: async (query, options) => { recorded.push({ query, options }); return { ok: true, query, docs: [], sessions: null, ledger: [], notes: [] } } }
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store,
    pool: { open: async () => {}, drive: async () => ({}) },
    notify: null,
    docs: world.store,
    recall,
  })
  return { handlers, recorded }
}

test('工具动作：docs 写/读/索引/陈旧，remember 默认落 draft，recall 转发', async () => {
  const world = makeWorld()
  try {
    const { handlers, recorded } = makeHandlers(world)

    // 缺 owner 直接拒绝 —— 没有责任人的文档三个月后一定腐烂。
    const refused = handlers.docs({ op: 'write', id: 'note-x', type: 'note', title: 'x', body: 'y' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'invalid_frontmatter')
    assert.equal(refused.problems.some((one) => one.path === 'owner'), true)

    const written = handlers.docs({ op: 'write', id: 'adr-2026-009', type: 'decision', title: '记忆不建库', owner: 'human:a', body: '复用 DSH 会话检索。' })
    assert.equal(written.ok, true)
    assert.equal(written.index, true, '写完顺手重建索引')

    const listed = handlers.docs({ op: 'list' })
    assert.equal(listed.count, 1)
    assert.equal(listed.stats.count, 1)
    const read = handlers.docs({ op: 'read', id: 'adr-2026-009' })
    assert.equal(read.frontmatter.status, 'draft')
    assert.match(read.body, /复用 DSH/)
    assert.equal(handlers.docs({ op: 'read', id: 'nope' }).code, 'not_found')
    assert.equal(handlers.docs({ op: 'index' }).ok, true)
    assert.equal(handlers.docs({ op: 'stale' }).rows.length, 0)
    assert.equal(handlers.docs({ op: 'nonsense' }).code, 'bad_request')

    /*
     * 草稿转正（R10.4）也走工具：谁点头必须写清（actor），
     * 因为它是**写动作**，不跟读动作共用"谁都能调"那一档。
     */
    assert.equal(handlers.docs({ op: 'confirm', id: 'adr-2026-009' }).code, 'bad_request')
    const confirmed = handlers.docs({ op: 'confirm', id: 'adr-2026-009', actor: 'human:a' })
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(handlers.docs({ op: 'read', id: 'adr-2026-009' }).frontmatter.status, 'active')
    assert.equal(handlers.docs({ op: 'confirm', id: 'adr-2026-009', actor: 'human:a' }).code, 'invalid_state')

    // remember：中文标题没有 slug 时也要生成合法 id，且默认 draft（人点头才算数）。
    const remembered = handlers.remember({ title: '发布流程要先跑单测', body: '约定：合并前必须绿。', owner: 'human:a', type: 'convention' })
    assert.equal(remembered.ok, true)
    assert.equal(remembered.status, 'draft')
    assert.match(remembered.id, /^note-[a-z0-9]+$/)
    assert.match(remembered.what, /draft 需要人确认/)
    assert.equal(handlers.remember({ title: '', body: 'x' }).code, 'bad_request')

    const recalled = await handlers.recall({ query: '退避', limit: 3 })
    assert.equal(recalled.ok, true)
    assert.deepEqual(recorded, [{ query: '退避', options: { limit: 3 } }])
    assert.equal((await handlers.recall({ query: '' })).code, 'bad_request')
  } finally {
    world.cleanup()
  }
})

test('工具没有接文档库时，动作如实拒绝而不是崩', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-team-docs-off-'))
  try {
    const config = loadConfig({ dataDir: root, tickIntervalMs: 0, bots: [], feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' } })
    const handlers = createHandlers({
      ctx: { get: () => undefined, effect: (factory) => factory() },
      config,
      store: new Store(root).load(),
      pool: {},
      notify: null,
    })
    assert.equal(handlers.docs({ op: 'list' }).code, 'docs_unavailable')
    assert.equal(handlers.remember({ title: 'x', body: 'y' }).code, 'docs_unavailable')
    // `recall` 是异步的（要查会话历史），所以这里必须 await：不 await 拿到的是 Promise。
    assert.equal((await handlers.recall({ query: 'x' })).code, 'recall_unavailable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
