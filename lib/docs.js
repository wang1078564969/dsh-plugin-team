/*
 * 文档载体：工作区里的 markdown 就是团队文档的**主副本**（设计 01 §1/§3/§4）。
 *
 * 为什么是文件而不是文档系统：文档、代码、记忆、台账在同一棵树里，agent 检索就是
 * 本地文件操作（毫秒级、无 API、无限流），权限与备份都只有一套。代价（没有实时协同）
 * 用 git 与乐观锁接受掉。
 *
 * 这个模块只做设计 01 §4 里"不做就会在三个月内退化成没人找得到的 md 文件"的那几件：
 *
 *   §4.1 **Frontmatter 是硬要求** —— 没有元数据头的文档不写（`write()` 直接拒绝），
 *        因为索引、检索、陈旧检测全靠它；
 *   §4.2/§4.3 **单一导航入口 + 索引可重建** —— `docs/index.md` 从 frontmatter 现算，
 *        `_meta/docs.json` 是机器读的那一份；两者都是派生物，坏了重建即可
 *        （"任何情况下都不允许只在索引里存在的内容"）；
 *   §4.6 **陈旧检测** —— `supersedes` / `related.docs` 组成引用图；一份文档被取代或
 *        归档时，引用它的文档被标成 `stale`，并出现在 `staleReport()` 里等人更新。
 *
 * 刻意**不做**的两件：不发明 YAML 解析器（只认这个 frontmatter 用得到的子集，
 * 认不出来就报错而不是猜），不建全文索引（设计 §4.3 的新结论：优先用 DSH 自己的
 * 检索能力；这里的 `search()` 是给兜底用的朴素实现）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** 文档类型 → 目录（设计 01 §3 的 `workspace/docs/` 规范）。 */
export const DOC_DIRS = {
  spec: 'specs',
  decision: 'decisions',
  runbook: 'runbooks',
  meeting: 'meetings',
  note: 'notes',
  glossary: '.',
  convention: '.',
  faq: '.',
  requirement_view: 'requirements',
}

export const DOC_TYPES = Object.keys(DOC_DIRS)
export const DOC_STATUSES = ['draft', 'active', 'stale', 'superseded', 'archived']
export const DOC_VISIBILITIES = ['team', 'project', 'private']

/**
 * 必填字段（设计 01 §4.1）。
 *
 * `owner` 也在里面，理由就是设计里那句话："有唯一责任人，否则文档会腐烂"。
 * `created`/`updated` 是日期，陈旧检测与排序都要用。
 */
export const REQUIRED_FIELDS = ['id', 'type', 'title', 'owner', 'status', 'created', 'updated']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/** 文档库的根：`<workspace>/docs`。 */
export function docsRoot(workspace) {
  return join(String(workspace), 'docs')
}

/** 一份文档该落在哪个文件。 */
export function docPath(workspace, id, type) {
  const dir = DOC_DIRS[type] ?? 'notes'
  return join(docsRoot(workspace), dir, String(id) + '.md')
}

/* ------------------------------------------------------------------ *
 * Frontmatter：只认这个子集，认不出来就报错
 * ------------------------------------------------------------------ */

/** 去掉一层引号。 */
function unquote(value) {
  const text = String(value).trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

/** `[a, b]` → `['a','b']`；空数组写 `[]`。 */
function parseInlineArray(text) {
  const inner = String(text).trim().slice(1, -1).trim()
  if (inner === '') return []
  return inner
    .split(',')
    .map((one) => unquote(one.trim()))
    .filter((one) => one !== '')
}

/** `{ requirements: [req-1], repos: [pay] }` —— 只支持一层，值可以是标量或数组。 */
function parseInlineMap(text) {
  const inner = String(text).trim().slice(1, -1).trim()
  const out = {}
  if (inner === '') return out
  for (const pair of inner.split(',')) {
    const at = pair.indexOf(':')
    if (at < 0) throw new Error('frontmatter 里的对象写法只支持 `key: value` 或 `key: [a, b]`：' + pair.trim())
    const key = unquote(pair.slice(0, at).trim())
    const raw = pair.slice(at + 1).trim()
    out[key] = raw.startsWith('[') ? parseInlineArray(raw) : unquote(raw)
  }
  return out
}

function parseScalar(raw) {
  const text = String(raw).trim()
  if (text === '') return ''
  if (text.startsWith('[')) return parseInlineArray(text)
  if (text.startsWith('{')) return parseInlineMap(text)
  return unquote(text)
}

/**
 * 拆一份 markdown 的 frontmatter 与正文。
 *
 * 认不出来（没有 `---` 头、key 里有奇怪的东西）时**不猜**：把问题放在 `problems`
 * 里，让调用方决定是拒绝写入还是只提示。
 *
 * @param {string} text
 * @returns {{frontmatter: object|null, body: string, problems: string[], raw: string|null}}
 */
export function parseDoc(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source.startsWith('---\n') && source.trimStart().startsWith('---') === false) {
    return { frontmatter: null, body: source, problems: ['没有 frontmatter（文件必须以 `---` 开头）'], raw: null }
  }
  const start = source.indexOf('---')
  const end = source.indexOf('\n---', start + 3)
  if (end < 0) {
    return { frontmatter: null, body: source, problems: ['frontmatter 没有收尾的 `---`'], raw: null }
  }
  const raw = source.slice(start + 3, end).replace(/^\n/, '')
  // 收尾的 `---` 之后可能有一个空行，也可能有好几个：全去掉，正文从第一行内容开始。
  const body = source.slice(end + 4).replace(/^\n+/, '')
  const frontmatter = {}
  const problems = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const at = line.indexOf(':')
    if (at <= 0) {
      problems.push('frontmatter 里有认不出的行（只支持 `key: value`）：' + line.trim())
      continue
    }
    const key = line.slice(0, at).trim()
    try {
      frontmatter[key] = parseScalar(line.slice(at + 1))
    } catch (error) {
      problems.push(String(error && error.message ? error.message : error))
    }
  }
  return { frontmatter, body, problems, raw }
}

/** 把对象写成 frontmatter 文本（值里的换行会被拒绝：那是 YAML 的活，不是这里的）。 */
export function serializeFrontmatter(frontmatter) {
  const lines = ['---']
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(key + ': [' + value.map((one) => String(one)).join(', ') + ']')
      continue
    }
    if (typeof value === 'object') {
      const parts = []
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined || v === null || v === '') continue
        parts.push(k + ': ' + (Array.isArray(v) ? '[' + v.map(String).join(', ') + ']' : String(v)))
      }
      if (parts.length === 0) continue
      lines.push(key + ': {' + parts.join(', ') + '}')
      continue
    }
    const text = String(value)
    if (text.includes('\n')) throw new Error('frontmatter 的 `' + key + '` 不能有换行')
    lines.push(key + ': ' + text)
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * 校验 frontmatter（设计 01 §4.1）。
 *
 * @returns {{ok: boolean, problems: Array<{path: string, message: string}>}}
 */
export function validateFrontmatter(frontmatter, options = {}) {
  const problems = []
  const fm = frontmatter !== null && typeof frontmatter === 'object' ? frontmatter : null
  if (fm === null) {
    return { ok: false, problems: [{ path: 'frontmatter', message: '没有元数据头：索引、检索、陈旧检测全靠它' }] }
  }
  for (const field of REQUIRED_FIELDS) {
    const value = fm[field]
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      problems.push({ path: field, message: '必填字段缺失（设计 01 §4.1：没有它这份文档会被索引漏掉）' })
    }
  }
  if (typeof fm.id === 'string' && fm.id !== '' && !ID_RE.test(fm.id)) {
    problems.push({ path: 'id', message: 'id 只能用小写字母/数字/.-_，且以字母数字开头：' + fm.id })
  }
  if (typeof fm.type === 'string' && fm.type !== '' && !DOC_TYPES.includes(fm.type)) {
    problems.push({ path: 'type', message: 'type 必须是 ' + DOC_TYPES.join(' | ') + ' 之一' })
  }
  if (typeof fm.status === 'string' && fm.status !== '' && !DOC_STATUSES.includes(fm.status)) {
    problems.push({ path: 'status', message: 'status 必须是 ' + DOC_STATUSES.join(' | ') + ' 之一' })
  }
  for (const field of ['created', 'updated']) {
    const value = fm[field]
    if (typeof value === 'string' && value !== '' && !DATE_RE.test(value)) {
      problems.push({ path: field, message: '日期写成 yyyy-mm-dd' })
    }
  }
  if (fm.visibility !== undefined && fm.visibility !== '' && !DOC_VISIBILITIES.includes(String(fm.visibility))) {
    // `project:<p>` 也是合法的 visibility。
    if (!String(fm.visibility).startsWith('project:')) {
      problems.push({ path: 'visibility', message: 'visibility 是 team | project:<名字> | private' })
    }
  }
  /*
   * `requirement_view` 是需求对象的**只读视图**（设计 01 §4.1）：它不带 owner 的编辑权，
   * 改它不会改对象。所以在这里明确地说出来，避免有人把它当主副本改。
   */
  if (fm.type === 'requirement_view' && options.allowView !== true) {
    const source = fm.source !== null && typeof fm.source === 'object' ? fm.source : {}
    if (source.kind !== 'requirement' && typeof fm.requirement !== 'string') {
      problems.push({ path: 'source', message: 'requirement_view 必须写明它是哪个需求对象的视图（source.kind=requirement 或 requirement: <id>）' })
    }
  }
  return { ok: problems.length === 0, problems }
}

/** 今天的日期（yyyy-mm-dd）。 */
function today(now) {
  return now().toISOString().slice(0, 10)
}

/**
 * @param {{workspace: string, log?: object, now?: () => Date}} deps
 */
export function createDocStore(deps) {
  const workspace = String(deps.workspace ?? '')
  const log = deps.log ?? console
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  const root = docsRoot(workspace)
  const metaDir = join(workspace, '_meta')

  /** 目录约定（设计 01 §3）：只建文档库需要的那些，不碰 `repos/` 与 `runtime/`。 */
  const DIRS = [
    'specs',
    'decisions',
    'runbooks',
    'meetings/<yyyy-mm>',
    'notes',
    'requirements',
    '_assets',
    '_drafts',
  ]

  function init() {
    const created = []
    for (const dir of DIRS) {
      const target = join(root, dir.replace('<yyyy-mm>', today(now).slice(0, 7)))
      if (!existsSync(target)) {
        mkdirSync(target, { recursive: true })
        created.push(relative(workspace, target))
      }
    }
    if (!existsSync(metaDir)) {
      mkdirSync(metaDir, { recursive: true })
      created.push('_meta')
    }
    const indexFile = join(root, 'index.md')
    if (!existsSync(indexFile)) {
      writeFileSync(indexFile, renderIndex([]), 'utf8')
      created.push('docs/index.md')
    }
    return { ok: true, root, created }
  }

  /** 走一遍文档库，读回每份文档的 frontmatter 与正文。 */
  function list() {
    const out = []
    if (!existsSync(root)) return out
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '_assets') continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.md') || entry.name === 'index.md') continue
        let text = ''
        try {
          text = readFileSync(full, 'utf8')
        } catch (error) {
          log.error?.('[team] 读不了这份文档：' + full + ' —— ' + String(error && error.message ? error.message : error))
          continue
        }
        const parsed = parseDoc(text)
        const fm = parsed.frontmatter ?? {}
        out.push({
          path: relative(workspace, full),
          file: full,
          id: typeof fm.id === 'string' && fm.id !== '' ? fm.id : entry.name.replace(/\.md$/, ''),
          type: typeof fm.type === 'string' && fm.type !== '' ? fm.type : null,
          title: typeof fm.title === 'string' ? fm.title : '',
          owner: typeof fm.owner === 'string' ? fm.owner : '',
          status: typeof fm.status === 'string' ? fm.status : null,
          updated: typeof fm.updated === 'string' ? fm.updated : null,
          supersedes: Array.isArray(fm.supersedes) ? fm.supersedes : [],
          related: fm.related !== null && typeof fm.related === 'object' ? fm.related : {},
          problems: [...parsed.problems, ...validateFrontmatter(parsed.frontmatter, { allowView: true }).problems.map((one) => one.path + '：' + one.message)],
          body: parsed.body,
        })
      }
    }
    walk(root)
    out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    return out
  }

  /**
   * 写一份文档。
   *
   * 拒绝的情况都不写入任何字节：缺必填字段、id 不合法、type 不认识、日期格式不对。
   * 这是"Frontmatter 是硬要求"的落点 —— 允许缺字段的写入，等于允许索引漏掉它。
   */
  function write(input) {
    const spec = input !== null && typeof input === 'object' ? input : {}
    const id = String(spec.id ?? '')
    const body = typeof spec.body === 'string' ? spec.body : ''
    const existing = id === '' ? null : read(id)
    const created = existing?.frontmatter?.created ?? today(now)
    const frontmatter = {
      id,
      type: String(spec.type ?? existing?.frontmatter?.type ?? 'note'),
      title: String(spec.title ?? existing?.frontmatter?.title ?? ''),
      owner: String(spec.owner ?? existing?.frontmatter?.owner ?? ''),
      status: String(spec.status ?? existing?.frontmatter?.status ?? 'draft'),
      created,
      updated: today(now),
      ...(spec.supersedes === undefined ? (existing?.frontmatter?.supersedes === undefined ? {} : { supersedes: existing.frontmatter.supersedes }) : { supersedes: spec.supersedes }),
      ...(spec.related === undefined ? (existing?.frontmatter?.related === undefined ? {} : { related: existing.frontmatter.related }) : { related: spec.related }),
      ...(spec.visibility === undefined ? {} : { visibility: spec.visibility }),
      ...(spec.mirror === undefined ? {} : { mirror: spec.mirror }),
      ...(spec.source === undefined ? (existing?.frontmatter?.source === undefined ? {} : { source: existing.frontmatter.source }) : { source: spec.source }),
    }
    /*
     * **写入走严格校验**（不豁免 `requirement_view` 那条规则）。
     * `allowView: true` 是给"读一份已经在盘上的文件"用的 —— 那里宁可报问题也不要拒绝，
     * 但在写入路径上豁免它，等于那条规则永远不会触发（它以前就是这样：两个调用方都传了 true）。
     */
    const checked = validateFrontmatter(frontmatter)
    if (checked.ok !== true) {
      return { ok: false, code: 'invalid_frontmatter', problems: checked.problems }
    }
    const file = docPath(workspace, id, frontmatter.type)
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, serializeFrontmatter(frontmatter) + '\n\n' + body.replace(/\s+$/, '') + '\n', 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      return { ok: false, code: 'write_failed', message: String(error && error.message ? error.message : error) }
    }
    return { ok: true, id, path: relative(workspace, file), file, frontmatter, created: existing === null }
  }

  function read(id) {
    for (const doc of list()) {
      if (doc.id !== String(id)) continue
      const parsed = parseDoc(readFileSync(doc.file, 'utf8'))
      return { ...doc, frontmatter: parsed.frontmatter, body: parsed.body }
    }
    return null
  }

  /**
   * 朴素检索：frontmatter 与正文都算，标题命中比正文命中靠前。
   *
   * 不建索引是**刻意的**（设计 01 §4.3 的新结论：优先用 DSH 自己的检索能力）。
   * 这个函数是兜底：文件数量是几十份的量级，走一遍目录比维护一个索引器便宜。
   * `stale` 的文档**照样返回**，但带 `stale: true` —— "不知道"比"知道过期的"更糟。
   */
  function search(query, options = {}) {
    const needle = String(query ?? '').trim().toLowerCase()
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 20
    const wanted = Array.isArray(options.types) ? options.types : null
    const rows = []
    for (const doc of list()) {
      if (wanted !== null && !wanted.includes(doc.type)) continue
      if (options.status !== undefined && doc.status !== options.status) continue
      let score = 0
      const title = doc.title.toLowerCase()
      if (needle === '') score = 1
      else if (doc.id.toLowerCase() === needle || title === needle) score = 100
      else {
        if (title.includes(needle)) score += 40
        if (doc.id.toLowerCase().includes(needle)) score += 20
        if (doc.body.toLowerCase().includes(needle)) score += 10
        for (const tag of Array.isArray(doc.related?.requirements) ? doc.related.requirements : []) {
          if (String(tag).toLowerCase().includes(needle)) score += 15
        }
      }
      if (score === 0) continue
      if (doc.status === 'stale' || doc.status === 'superseded') score -= 5
      rows.push({
        id: doc.id,
        title: doc.title,
        type: doc.type,
        status: doc.status,
        owner: doc.owner,
        updated: doc.updated,
        path: doc.path,
        score,
        stale: doc.status === 'stale' || doc.status === 'superseded',
        excerpt: excerptOf(doc.body, needle),
      })
    }
    rows.sort((a, b) => b.score - a.score || String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
    return rows.slice(0, limit)
  }

  function excerptOf(body, needle) {
    const flat = String(body ?? '').replace(/\s+/g, ' ').trim()
    if (flat === '') return ''
    const at = needle === '' ? -1 : flat.toLowerCase().indexOf(needle)
    if (at < 0) return flat.slice(0, 120)
    const start = Math.max(0, at - 40)
    return (start > 0 ? '…' : '') + flat.slice(start, start + 140)
  }

  /**
   * 引用图：谁引用了谁（`supersedes` + `related.docs`）。
   *
   * 两个方向都要，因为它们的用途不同：`supersedes` 回答"这份文档取代了谁"（被取代的要转
   * `superseded`），`related.docs` 回答"谁会被我的变化影响"（那些要转 `stale`）。
   */
  function references() {
    const docs = list()
    const byId = new Map(docs.map((doc) => [doc.id, doc]))
    const referencing = new Map()
    for (const doc of docs) {
      const targets = [...doc.supersedes, ...(Array.isArray(doc.related?.docs) ? doc.related.docs : [])]
      for (const target of targets) {
        const list = referencing.get(String(target)) ?? []
        list.push(doc.id)
        referencing.set(String(target), list)
      }
    }
    return { docs, byId, referencing }
  }

  /**
   * 陈旧检测（设计 01 §4.6）。
   *
   * 判据有两条，都是**可算的**，不靠人记得：
   *   1. 我引用的文档被标成 `superseded`/`archived` → 我该更新了（`reason: superseded`）；
   *   2. `status: active` 但 `updated` 超过 `staleAfterDays`（默认 180 天）没动过 →
   *      标成"可能过期"（**不自动改状态**：改文件内容要人点头，这里只报告）。
   *
   * @param {{staleAfterDays?: number}} [options]
   */
  function staleReport(options = {}) {
    const days = Number.isFinite(options.staleAfterDays) ? Number(options.staleAfterDays) : 180
    const { docs, byId, referencing } = references()
    const cutoff = now().getTime() - days * 24 * 60 * 60 * 1000
    const rows = []
    for (const doc of docs) {
      const reasons = []
      for (const target of [...doc.supersedes, ...(Array.isArray(doc.related?.docs) ? doc.related.docs : [])]) {
        const other = byId.get(String(target))
        if (other !== undefined && (other.status === 'superseded' || other.status === 'archived')) {
          reasons.push({ kind: 'superseded_reference', target: other.id, message: '它引用的 ' + other.id + ' 已经是 ' + other.status })
        }
      }
      const updatedAt = doc.updated === null ? NaN : Date.parse(doc.updated)
      if ((doc.status === 'active' || doc.status === 'draft') && Number.isFinite(updatedAt) && updatedAt < cutoff) {
        const ageDays = Math.round((now().getTime() - updatedAt) / (24 * 60 * 60 * 1000))
        reasons.push({ kind: 'stale_by_age', target: doc.id, message: '已经 ' + String(ageDays) + ' 天没有更新（阈值 ' + String(days) + ' 天）' })
      }
      if (doc.status === 'stale') reasons.push({ kind: 'marked_stale', target: doc.id, message: '状态是 stale' })
      if (reasons.length === 0) continue
      rows.push({ id: doc.id, owner: doc.owner, status: doc.status, updated: doc.updated, path: doc.path, reasons })
    }
    rows.sort((a, b) => String(a.updated ?? '').localeCompare(String(b.updated ?? '')))
    return { generatedAt: now().toISOString(), staleAfterDays: days, rows, referencing }
  }

  /**
   * 索引可重建（设计 01 §4.2/§4.3）：`docs/index.md`（人的入口）与
   * `_meta/docs.json`（机器读的那份）都是从 frontmatter 现算的派生物。
   */
  function rebuildIndex() {
    const docs = list()
    const indexFile = join(root, 'index.md')
    try {
      mkdirSync(root, { recursive: true })
      const tmp = indexFile + '.tmp'
      writeFileSync(tmp, renderIndex(docs), 'utf8')
      renameSync(tmp, indexFile)
      mkdirSync(metaDir, { recursive: true })
      const metaFile = join(metaDir, 'docs.json')
      const metaTmp = metaFile + '.tmp'
      writeFileSync(
        metaTmp,
        JSON.stringify(
          {
            generatedAt: now().toISOString(),
            count: docs.length,
            docs: docs.map((doc) => ({
              id: doc.id,
              type: doc.type,
              title: doc.title,
              owner: doc.owner,
              status: doc.status,
              updated: doc.updated,
              path: doc.path,
              problems: doc.problems,
            })),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      )
      renameSync(metaTmp, metaFile)
    } catch (error) {
      return { ok: false, code: 'index_write_failed', message: String(error && error.message ? error.message : error) }
    }
    return { ok: true, count: docs.length, index: relative(workspace, indexFile), problems: docs.filter((doc) => doc.problems.length > 0).map((doc) => ({ id: doc.id, problems: doc.problems })) }
  }

  /** 文档库自身的体检：条数、缺字段的、过期的。 */
  function stats() {
    const docs = list()
    const stale = docs.filter((doc) => doc.status === 'stale' || doc.status === 'superseded')
    return {
      root,
      exists: existsSync(root),
      count: docs.length,
      byType: docs.reduce((acc, doc) => {
        const key = doc.type ?? '（没有 type）'
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
      withProblems: docs.filter((doc) => doc.problems.length > 0).length,
      stale: stale.length,
      latest: docs.map((doc) => doc.updated).filter((one) => typeof one === 'string').sort().slice(-1)[0] ?? null,
    }
  }

  return { workspace, root, init, list, read, write, search, references, staleReport, rebuildIndex, stats }
}

/** `docs/index.md`：按类型分组，每条一句说明（设计 01 §4.2 的"单一导航入口"）。 */
export function renderIndex(docs) {
  const groups = new Map()
  for (const doc of docs) {
    const key = doc.type ?? '（没有 type）'
    const list = groups.get(key) ?? []
    list.push(doc)
    groups.set(key, list)
  }
  const lines = [
    '# 团队文档',
    '',
    '> 这个文件由插件**从每份文档的 frontmatter 现算**（`docs index` / `rebuildIndex()`）。',
    '> 手改会被下一次重建覆盖 —— 要改内容请改对应的文档本身。',
    '> 新人和新 agent 的第一跳就是这里：先看目录，再进文件。',
    '',
    '共 ' + String(docs.length) + ' 份。',
    '',
  ]
  for (const [type, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('## ' + type + '（' + String(list.length) + '）')
    lines.push('')
    for (const doc of list.sort((a, b) => a.id.localeCompare(b.id))) {
      const flags = []
      if (doc.status !== null && doc.status !== 'active') flags.push(doc.status)
      if (doc.owner !== '') flags.push(doc.owner)
      if (doc.updated !== null) flags.push(doc.updated)
      lines.push('- [`' + doc.id + '`](' + doc.path + ') — ' + (doc.title === '' ? '（没有标题）' : doc.title) +
        (flags.length === 0 ? '' : ' · ' + flags.join(' · ')))
    }
    lines.push('')
  }
  if (docs.length === 0) {
    lines.push('（还没有文档。用 `team` 工具的 `docs` 动作写第一份：type/title/owner 都要有。）')
    lines.push('')
  }
  return lines.join('\n')
}


