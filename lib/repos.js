/*
 * 代码仓库这一侧的对接（设计 03 §1.3–§1.7）。
 *
 * **先说清楚做不到的那一半**：飞书的卡片按钮与 Git 平台的 webhook 都需要**公网入站
 * HTTPS**，而 DSH Web 只监听 `127.0.0.1`。所以"点一下按钮就合并"这种链路不可能有；
 * 设计 03 的替代方案是：**agent 在工作目录里用 `git` / `gh` 自己完成检出、提交、开 MR**，
 * 插件负责三件它能负责的事：
 *
 *   1. **约定**（§1.3）：分支名 `req/<req-id>/<task-id>`、提交信息带 `Req:` / `Task:`
 *      trailer —— 代码历史与需求对象双向可追，靠的不是平台功能，而是这两行文本；
 *   2. **记账与门禁判定**（§1.4/§1.5）：MR 链接、审批、CI 状态记在任务上，
 *      "能不能合并"由这里判定（而不是靠提示词），CI 超时进 `ci_stuck` 并**播报** ——
 *      长流水线看起来就像"卡住了"，不播报人就会以为机器人在偷懒；
 *   3. **仓库知识索引**（§1.7）：一次性轻量扫仓库 → `docs/specs/<repo>-overview.md`，
 *      机器人改代码前先读它，避免"不知道这个模块干什么就乱改"。
 *
 * 这个模块只做纯函数与文件读取，**不执行任何 git 命令**（那是执行会话的活）：
 * 插件不替 agent 干活，只提供约定、判定与记录。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 分支名（设计 03 §1.3）：一个需求一条线，任务分支挂在它下面。 */
export function branchName({ requirementId, taskId, slug }) {
  const req = String(requirementId ?? '').trim()
  if (req === '') return null
  const clean = String(slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (taskId !== undefined && taskId !== null && String(taskId) !== '') return 'req/' + req + '/' + String(taskId)
  return 'req/' + req + (clean === '' ? '' : '-' + clean)
}

/** 提交信息末尾的 trailer（设计 03 §1.3）。机器可读，人也能看懂。 */
export function commitTrailers({ requirementId, taskId }) {
  const lines = []
  if (requirementId !== undefined && requirementId !== null && String(requirementId) !== '') lines.push('Req: ' + String(requirementId))
  if (taskId !== undefined && taskId !== null && String(taskId) !== '') lines.push('Task: ' + String(taskId))
  return lines
}

/** 反过来：从一段提交信息里读回它属于哪个需求/任务（`git log` 是证据链的一半）。 */
export function parseTrailers(message) {
  const text = typeof message === 'string' ? message : ''
  const out = { req: null, task: null }
  for (const line of text.split('\n')) {
    const req = /^Req:\s*(\S+)\s*$/.exec(line.trim())
    if (req !== null) out.req = req[1]
    const task = /^Task:\s*(\S+)\s*$/.exec(line.trim())
    if (task !== null) out.task = task[1]
  }
  return out
}

/** 提交信息是否遵守约定（不遵守不报错，但要说出来 —— 不然双向可追就断了）。 */
export function commitProblems(message, expected = {}) {
  const parsed = parseTrailers(message)
  const problems = []
  if (expected.requirementId !== undefined && parsed.req !== String(expected.requirementId)) {
    problems.push({ path: 'Req', message: '提交信息缺少或写错了 `Req: ' + String(expected.requirementId) + '`（设计 03 §1.3）' })
  }
  if (expected.taskId !== undefined && parsed.task !== String(expected.taskId)) {
    problems.push({ path: 'Task', message: '提交信息缺少或写错了 `Task: ' + String(expected.taskId) + '`' })
  }
  return problems
}

/**
 * 敏感文件（设计 03 §1.4）：改到这些地方要**对应 owner 审批**，并顺手把相关文档标记陈旧。
 *
 * 判据是路径形态而不是内容 —— 它要在 diff 之前就能判，否则"自动要求审批"这句话就是空的。
 */
export const SENSITIVE_PATTERNS = [
  { kind: 'contract', pattern: /(^|\/)(api|apis|proto|protos|schema|schemas|openapi|swagger)(\/|\.|$)/i, why: '接口契约' },
  { kind: 'migration', pattern: /(^|\/)(migrations?|migrate|db\/migrate)(\/|\.|$)/i, why: '数据迁移' },
  { kind: 'config_template', pattern: /(^|\/)(config|conf|env)(\/|\.|$)|\.example\.|\.template\./i, why: '配置模板' },
  { kind: 'ci', pattern: /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)Jenkinsfile$/i, why: 'CI 定义' },
  { kind: 'permissions', pattern: /(^|\/)(auth|permission|permissions|acl|rbac)(\/|\.|$)/i, why: '权限' },
]

export function sensitiveFiles(files) {
  const out = []
  for (const file of Array.isArray(files) ? files : []) {
    const path = String(file ?? '').replace(/^\.\//, '')
    if (path === '') continue
    for (const rule of SENSITIVE_PATTERNS) {
      if (rule.pattern.test(path)) {
        out.push({ path, kind: rule.kind, why: rule.why })
        break
      }
    }
  }
  return out
}

/**
 * CI 状态机（设计 03 §1.5）。
 *
 * ```
 * in_progress → ci_running → ├─ ci_passed → in_review
 *                            ├─ ci_failed → 回到执行者
 *                            └─ ci_stuck  → 超时告警 + 群里播报
 * ```
 *
 * `ci_stuck` **不是**一个状态，而是一次判定：状态还是 `ci_running`，但超过时限没结论。
 * 这样"卡住"不会吞掉后面真的到来的结果（CI 慢不等于失败）。
 */
export function ciState(task, options = {}) {
  const ci = task !== null && typeof task === 'object' && task.ci !== null && typeof task.ci === 'object' ? task.ci : null
  if (ci === null) return { state: 'idle', startedAt: null, stuck: false }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 30 * 60 * 1000
  const startedAt = typeof ci.started_at === 'string' ? Date.parse(ci.started_at) : NaN
  const now = options.now instanceof Date ? options.now.getTime() : Date.now()
  const terminal = ci.state === 'passed' || ci.state === 'failed'
  const elapsed = Number.isFinite(startedAt) ? now - startedAt : 0
  return {
    state: typeof ci.state === 'string' ? ci.state : 'running',
    startedAt: typeof ci.started_at === 'string' ? ci.started_at : null,
    finishedAt: typeof ci.finished_at === 'string' ? ci.finished_at : null,
    elapsedMs: terminal ? 0 : Math.max(0, elapsed),
    stuck: task?.state === 'ci_running' && terminal !== true && Number.isFinite(startedAt) && elapsed >= timeoutMs,
    /* 已经播报过"卡住"就不再重复 —— 每轮 tick 都喊一次等于没有告警。 */
    notified: ci.stuck_notified_at !== undefined && ci.stuck_notified_at !== null,
    summary: typeof ci.summary === 'string' ? ci.summary : null,
    url: typeof ci.url === 'string' ? ci.url : null,
  }
}

/** 写回 `task.ci` 的那一份（纯数据，便于测试与序列化）。 */
export function ciPatch(task, patch, now = new Date()) {
  const previous = task !== null && typeof task === 'object' && task.ci !== null && typeof task.ci === 'object' ? task.ci : {}
  const at = now.toISOString()
  return {
    ...previous,
    ...patch,
    ...(patch.state === 'running' ? { started_at: previous.started_at ?? at, stuck_notified_at: null } : {}),
    ...(patch.state === 'passed' || patch.state === 'failed' ? { finished_at: at } : {}),
  }
}

/**
 * 能不能合并（设计 03 §1.4/§1.6）。
 *
 * 三道一起判，缺一条都不行：
 *   1. **至少一个人批过**（`approvals` 里的人要 `canApprove` —— 这是成员表里那个字段
 *      第一次真的挡在合并前面）；
 *   2. **CI 有结论且是通过**（`ci_running` 里直接合并 = 绕过必过检查）；
 *   3. **执行者够格**：`ops` 角色或明确 `canApprove` 的人；`dev` 机器人只能开 MR。
 *
 * `allowAutoMerge` 默认关（设计原话："默认关闭，按需开启"）。
 */
export function mergeDecision(task, input = {}) {
  const approvals = Array.isArray(task?.mr?.approvals) ? task.mr.approvals : []
  const approvers = approvals.filter((one) => one !== null && typeof one === 'object' && one.approved === true)
  const required = Number.isFinite(input.requiredApprovals) ? Number(input.requiredApprovals) : 1
  const ci = ciState(task, { timeoutMs: input.ciTimeoutMs, now: input.now })
  const blockers = []
  if (task?.mr?.url === undefined || task?.mr?.url === null || task.mr.url === '') {
    blockers.push({ code: 'no_mr', message: '还没有 MR 链接：先开 MR 再谈合并（`repo op=link_mr`）' })
  }
  if (approvers.length < required) {
    blockers.push({
      code: 'needs_approval',
      message: '还差 ' + String(required - approvers.length) + ' 个审批（设计 03 §1.4：至少一个人类审批）',
    })
  }
  if (ci.state !== 'passed') {
    blockers.push({ code: 'ci_not_passed', message: 'CI 还没有通过（当前 ' + ci.state + '）：合并等于绕过必过检查' })
  }
  const actor = String(input.actor ?? '')
  const actorAllowed =
    input.actorIsOps === true || (Array.isArray(input.actorCanApprove) && input.actorCanApprove.length > 0)
  if (actor === '') {
    blockers.push({ code: 'no_actor', message: '合并必须说明是谁在做（没有 actor 的写操作一律拒绝）' })
  } else if (actorAllowed !== true) {
    blockers.push({
      code: 'actor_not_ops',
      message: '合并不是这个角色能做的事：设计 03 §1.6 里只有 ops（或明确 canApprove 的人）能合并，dev 只能开 MR',
    })
  }
  return {
    ok: blockers.length === 0,
    blockers,
    approvals: approvers.map((one) => one.by),
    ci,
    allowAutoMerge: input.allowAutoMerge === true,
  }
}

/* ------------------------------------------------------------------ *
 * 仓库知识索引（§1.7）
 * ------------------------------------------------------------------ */

/** 一个仓库里值得一次性记住的东西：目录、入口、测试、命令、约定文件。 */
export function indexRepo(root, options = {}) {
  const base = String(root ?? '')
  if (base === '' || !existsSync(base)) return { ok: false, code: 'not_found', message: '这个路径不存在：' + base }
  const maxEntries = Number.isFinite(options.maxEntries) ? Number(options.maxEntries) : 40
  const dirs = []
  const files = []
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
      if (entry.isDirectory()) dirs.push(entry.name)
      else files.push(entry.name)
    }
  } catch (error) {
    return { ok: false, code: 'unreadable', message: String(error && error.message ? error.message : error) }
  }

  /** `package.json` 的 scripts：这就是"常用命令"最可靠的来源。 */
  const scripts = {}
  const manifests = []
  const pkgFile = join(base, 'package.json')
  if (existsSync(pkgFile)) {
    manifests.push('package.json')
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) scripts[name] = String(command)
    } catch (error) {
      /* 读不动就算了：索引不该因为一个坏文件整体失败 */
    }
  }
  for (const name of ['pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Makefile']) {
    if (existsSync(join(base, name))) manifests.push(name)
  }
  const testDirs = dirs.filter((one) => ['test', 'tests', 'spec', '__tests__', 'e2e'].includes(one))
  const ciFiles = []
  const workflowDir = join(base, '.github', 'workflows')
  if (existsSync(workflowDir)) {
    try {
      for (const name of readdirSync(workflowDir)) ciFiles.push('.github/workflows/' + name)
    } catch (error) {
      /* 同上 */
    }
  }
  for (const name of ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml']) {
    if (existsSync(join(base, name))) ciFiles.push(name)
  }
  let readme = ''
  for (const name of ['README.md', 'README.zh.md', 'readme.md']) {
    const file = join(base, name)
    if (!existsSync(file)) continue
    try {
      readme = readFileSync(file, 'utf8').split('\n').slice(0, 20).join('\n').trim()
      break
    } catch (error) {
      /* 同上 */
    }
  }

  /** 顶层目录的"大致职责"：只看它里面有多少文件、有没有 index/main —— 不猜语义。 */
  const modules = []
  for (const dir of dirs.slice(0, maxEntries)) {
    const full = join(base, dir)
    let count = 0
    let hasEntry = false
    try {
      const children = readdirSync(full, { withFileTypes: true })
      count = children.length
      hasEntry = children.some((one) => /^(index|main|mod|app|server|__init__)\./.test(one.name))
    } catch (error) {
      /* 读不动就当空目录 */
    }
    modules.push({ name: dir, entries: count, hasEntry })
  }

  return {
    ok: true,
    root: base,
    dirs,
    files,
    manifests,
    scripts,
    testDirs,
    ciFiles,
    readme,
    modules,
    scannedAt: new Date().toISOString(),
  }
}

/** 仓库知识索引的落点（设计 01 §1.7）：`docs/specs/<repo>-overview.md`。 */
export function overviewDocId(repo) {
  const name = String(repo ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return 'spec-' + (name === '' ? 'repo' : name) + '-overview'
}

/**
 * 把一次索引渲染成一份**带 frontmatter 的文档**（直接能给 `docs.write`）。
 *
 * 刻意只写"看到的事实"（目录、命令、测试入口、CI 文件），不写"这个模块大概负责什么"
 * 之类的判断 —— 判断要由 `lib` 机器人与人补，索引的职责是给它们一个起点。
 */
export function overviewDoc(repo, index, options = {}) {
  const name = String(repo ?? '').trim()
  const lines = [
    '## 这是什么',
    '',
    '`' + name + '` 的仓库索引。这份文档由插件**扫目录**生成（设计 03 §1.7）：',
    '机器人在改代码之前先读它，避免"不知道这个模块干什么就乱改"。',
    '「职责」那一栏要人补 —— 索引只写看到的事实，不猜语义。',
    '',
  ]
  if (index !== null && typeof index === 'object' && index.ok === true) {
    lines.push('## 顶层结构')
    lines.push('')
    lines.push('| 目录 | 条目数 | 有入口文件 | 职责（待补） |')
    lines.push('|---|---|---|---|')
    for (const module of index.modules ?? []) {
      lines.push('| `' + module.name + '/` | ' + String(module.entries) + ' | ' + (module.hasEntry ? '是' : '—') + ' |  |')
    }
    lines.push('')
    const testLine = (index.testDirs ?? []).length > 0 ? (index.testDirs ?? []).join('、') : '（没有明显的测试目录）'
    lines.push('## 测试与常用命令')
    lines.push('')
    lines.push('- 测试目录：' + testLine)
    const scripts = Object.entries(index.scripts ?? {})
    if (scripts.length > 0) {
      lines.push('- 常用命令（来自 package.json）：')
      for (const [key, command] of scripts.slice(0, 20)) lines.push('  - `npm run ' + key + '` — `' + command + '`')
    } else {
      lines.push('- 常用命令：（没有 package.json scripts，命令要人补）')
    }
    lines.push('- 清单文件：' + ((index.manifests ?? []).length > 0 ? (index.manifests ?? []).join('、') : '（没有认出清单文件）'))
    lines.push('')
    lines.push('## CI')
    lines.push('')
    lines.push((index.ciFiles ?? []).length > 0 ? (index.ciFiles ?? []).map((one) => '- `' + one + '`').join('\n') : '（没有认出 CI 定义）')
    lines.push('')
    if (typeof index.readme === 'string' && index.readme !== '') {
      lines.push('## README 开头（原文）')
      lines.push('')
      lines.push('```')
      lines.push(index.readme)
      lines.push('```')
      lines.push('')
    }
  } else {
    lines.push('（这次没有扫到内容：' + String(index?.message ?? '路径不存在') + '）')
    lines.push('')
  }
  return {
    id: overviewDocId(name),
    type: 'spec',
    title: name + ' 仓库概览',
    owner: String(options.owner ?? 'human:unknown'),
    status: String(options.status ?? 'draft'),
    related: { repos: [name] },
    source: { kind: 'repo_index', ref: String(index?.root ?? name) },
    body: lines.join('\n'),
  }
}
