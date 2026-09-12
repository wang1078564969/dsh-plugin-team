/*
 * 角色域与任务类型：**谁该管这件事**的配置层。
 *
 * WHY THIS FILE EXISTS. The design (03 §2.0/§2.4②, 02 §5.4) has two registries that the
 * plugin never had:
 *
 *   1. **10 个角色域** — `pm product design requirement development testing ops data
 *      security docs`。插件只有 6 个（少了 product/design/data/docs），于是"设计域
 *      的负责人"这种配置无处可写，跨域确认也就少了几方。
 *   2. **任务类型 → 所需域** — 9 个类型各对应哪些域参与、谁要确认。以前
 *      `domains` 完全由模型在 `propose_tasks` 里现给，于是"这个活算开发还是算测试"
 *      取决于模型当天怎么想，而它决定了**谁会被拉进确认**。
 *
 * WHY HERE AND NOT IN domain/. The hub's `registry.ts` did this and pulled the whole
 * config layer into the domain layer — that is exactly what this port avoids
 * (`lib/domain/index.js` 开头写着这个取舍)。所以：纯数据 + 纯解析放这里，
 * 领域层继续不认识配置。
 *
 * WHY DEFAULTS ARE SHIPPED. An installation that never writes a `taskTypes` block still
 * gets the design's nine types: the mapping is part of the protocol, not a local
 * preference. Operators override what they disagree with; a hand-written file may also
 * add its own types (a project-specific `bot_change`), and unknown types fall back to
 * the union of every domain they do not explicitly exclude — see `domainsOfTaskType`.
 */

/** 设计里的 10 个角色域（顺序就是面板与文档里的顺序）。 */
export const DEFAULT_DOMAINS = Object.freeze([
  'pm',
  'product',
  'design',
  'requirement',
  'development',
  'testing',
  'ops',
  'data',
  'security',
  'docs',
])

/**
 * 9 个任务类型（03 §2.0 逐字）与它们需要的域。
 *
 * `domains` 决定"这个任务跨越哪些域"——也就是**谁会进确认名单**（04 §3.5：
 * 跨域任务并行确认，缺一方不推进）。`touches` 是额外的提示（面板用它解释为什么
 * 拉进来这些域），不参与判定。
 */
export const DEFAULT_TASK_TYPES = Object.freeze({
  requirement_clarify: { label: '需求澄清', domains: ['requirement'], touches: '需求是否说清了、验收标准是否可判' },
  code_change: { label: '代码改动', domains: ['development'], touches: '实现与自测' },
  defect_fix: { label: '缺陷修复', domains: ['development', 'testing'], touches: '复现、修复、回归' },
  feature_delivery: { label: '功能交付', domains: ['development', 'testing'], touches: '实现、验收标准、回归' },
  release: { label: '发布', domains: ['development', 'ops'], touches: '上线与回滚路径' },
  incident: { label: '故障处理', domains: ['ops', 'development'], touches: '止血、定位、复盘' },
  new_feature: { label: '新功能', domains: ['product', 'design', 'development'], touches: '值不值得做、做成什么样、怎么做' },
  data_change: { label: '数据变更', domains: ['data', 'development'], touches: '影响面、可回滚、口径' },
  doc_update: { label: '文档更新', domains: ['docs'], touches: '文档与代码是否同步' },
})

/** 认不出任务类型时的兜底域（"开发"是最安全的默认：它总是要有人做）。 */
export const FALLBACK_DOMAINS = Object.freeze(['development'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((one) => String(one)).filter((one) => one !== '')
}

/**
 * 生效的任务类型表：内置 9 个 → 配置文件覆盖。
 *
 * 覆盖是**逐个类型**的（写 `code_change: { domains: [...] }` 只动这一个），
 * 而不是整表替换：整表替换意味着"我只想改一个小地方"要先把九个抄一遍，
 * 抄漏一个就静默少一个类型。
 */
export function resolveTaskTypes(raw) {
  const out = {}
  for (const [name, spec] of Object.entries(DEFAULT_TASK_TYPES)) {
    out[name] = { label: spec.label, domains: [...spec.domains], touches: spec.touches, source: 'default' }
  }
  if (!isPlainObject(raw)) return out
  for (const [name, spec] of Object.entries(raw)) {
    const previous = out[name]
    if (Array.isArray(spec)) {
      // 手写的简写：`code_change: ["development"]` 也能用。
      out[name] = { label: previous?.label ?? name, domains: stringList(spec), touches: previous?.touches ?? '', source: 'config' }
      continue
    }
    if (!isPlainObject(spec)) continue
    out[name] = {
      label: typeof spec.label === 'string' && spec.label !== '' ? spec.label : (previous?.label ?? name),
      domains: spec.domains === undefined ? (previous?.domains ?? [...FALLBACK_DOMAINS]) : stringList(spec.domains),
      touches: typeof spec.touches === 'string' ? spec.touches : (previous?.touches ?? ''),
      source: 'config',
    }
  }
  return out
}

/**
 * 这个任务类型需要哪些域。
 *
 * 未知类型**不丢给默认域了事，而是报出来**：`unknown: true` 让调用方能拒绝或至少
 * 记一笔 —— 一个拼错的任务类型静默变成"开发"，正是那种半年后没人说得清的事。
 * 但**仍然返回** `FALLBACK_DOMAINS`，因为"能跑但要说清楚"比"直接拒绝"更符合这个
 * 插件的性格：任务还是要能建出来。
 */
export function domainsOfTaskType(taskTypes, type) {
  const name = typeof type === 'string' && type !== '' ? type : 'feature_delivery'
  const spec = taskTypes === null || taskTypes === undefined ? undefined : taskTypes[name]
  if (spec === undefined) return { domains: [...FALLBACK_DOMAINS], label: name, unknown: true }
  const domains = spec.domains.length > 0 ? spec.domains : [...FALLBACK_DOMAINS]
  return { domains, label: spec.label ?? name, unknown: false }
}

/** 每个类型的域是否都在已知域里（配置检查用）。 */
export function taskTypeProblems(taskTypes, knownDomains) {
  const out = []
  const known = new Set(Array.isArray(knownDomains) ? knownDomains : DEFAULT_DOMAINS)
  for (const [name, spec] of Object.entries(taskTypes ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      out.push({ path: 'taskTypes.' + name, message: '任务类型名要形如 ^[a-z][a-z0-9_]*$' })
      continue
    }
    if (spec.domains.length === 0) {
      out.push({ path: 'taskTypes.' + name + '.domains', message: '至少要一个域：没有域就没有人会被拉进确认' })
      continue
    }
    for (const domain of spec.domains) {
      if (!known.has(domain)) {
        out.push({
          path: 'taskTypes.' + name + '.domains',
          message: '未知角色域 ' + domain + '（已知：' + [...known].join('/') + '）',
        })
      }
    }
  }
  return out
}
