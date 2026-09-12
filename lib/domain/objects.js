/*
 * 来源：hub/src/domain/objects.ts（256 行）
 *
 * 对象构造：把“输入”变成“合法对象”。
 *
 * 关键设计（设计文档 06 §4.2）：**门禁在创建时算好并冻结**。
 * 之后 workflow.yaml 怎么改都不影响进行中的任务——这是“改配置不影响
 * 进行中的任务”的落地方式。
 *
 * 改了什么：
 *   - zod → 手写校验：`parseOrThrow(requirementSchema|taskSchema, draft, '...')`
 *     改成 schema.js 的 `parseRequirement()` / `parseTask()`，二者抛出的
 *     ObjectError 文案与 hub 完全一致（`requirement.id: 需求 ID 形如 req-2026-014`）。
 *   - TS 类型（CreateRequirementOptions / GateDefaultsInput / CreateTaskOptions）
 *     → JSDoc @typedef。
 *   - `ObjectError` 定义搬到了 schema.js（校验函数要用它），这里按 hub 的名字
 *     再导出一次，`import { ObjectError } from './objects.js'` 仍然可用。
 *   - `GATE_ACTIVE_IN` 额外导出（hub 里是模块私有）：测试与运维面板要能直接问
 *     “这道门禁在哪个状态开始计时”，把它藏起来只会逼人重写一份。
 *
 * 没能保住的语义（显式列出）：
 *   1. **`GateSpec` 的类型约束没了**。`buildGates(input, specs)` 现在只按
 *      `spec.timeout / spec.on_timeout / spec.max_release` 取快照；配置层的
 *      校验（workflow.yaml 的 gateSpecSchema）本来就不在本模块，JS 侧同样不管。
 *   2. `input.assignee === undefined` 在 hub 里是类型错误（运行期会在
 *      `isHuman(undefined)` 上炸）；这里按 `null` 处理——语义与“还没有执行者”
 *      一致（需要人工确认），且不会把参数拼错变成一句 `undefined.startsWith`。
 *   3. `gateSatisfied / gateProgress / gatePending / hasDeadline` 额外接受
 *      `null`（等同 undefined）。hub 只用 undefined 表示“没有这道门禁”，
 *      但 JS 侧对象可能来自 JSON 里的显式 null，多这一层不会改变既有语义。
 *   4. `parseMs` / `deadlineFrom` 仍是模块私有（hub 也没导出）；
 *      非法或非正的 timeout 一律算“不设截止时间”（返回 null / 0），与 hub 相同。
 */

import { ObjectError, parseRequirement, parseTask } from './schema.js'
import { isHuman } from './types.js'

export { ObjectError }

/* ------------------------------------------------------------------ *
 * 需求
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} CreateRequirementOptions
 * @property {Date} now
 */

/**
 * 建需求。
 *
 * 输入里**没给的**字段在这里补默认值，然后整对象过 schema：
 * 缺省 history 会写一条 `null → draft` 的初始历史（by = requester）。
 * 注意 `state` 缺省是 'draft'，但历史条目里写死的也是 'draft'——
 * 与 hub 一致（显式传 state 的调用方要自己负责历史的第一条）。
 *
 * @param {Partial<import('./schema.js').Requirement> & {requester: import('./types.js').Principal, owner: import('./types.js').Principal}} input
 * @param {CreateRequirementOptions} opts
 * @returns {import('./schema.js').Requirement}
 */
export function createRequirement(input, opts) {
  const draft = {
    ...input,
    // requirementSchema 里 state / origin / body / … 的默认值逐条对齐 schema.js；
    // 这里先补一层是因为 origin.surface 没有默认值（必须显式给 'manual'）。
    state: input.state ?? 'draft',
    origin: input.origin ?? { surface: 'manual', excerpts: [] },
    body: input.body ?? {},
    acceptance_criteria: input.acceptance_criteria ?? [],
    tasks: input.tasks ?? [],
    links: input.links ?? {},
    decisions: input.decisions ?? [],
    visibility: input.visibility ?? 'team',
    history: input.history ?? [
      {
        from: null,
        to: 'draft',
        by: input.requester,
        at: opts.now.toISOString(),
      },
    ],
  }
  return parseRequirement(draft)
}

/* ------------------------------------------------------------------ *
 * 任务与门禁
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} GateDefaultsInput
 * @property {string[]} domains 仅是上下文（便于调试与日志），门禁计算只用下面四个确认者列表
 * @property {import('./types.js').Principal|null} assignee
 * @property {{confirm_split: import('./types.js').Principal[], accept: import('./types.js').Principal[], start: import('./types.js').Principal[], acceptance: import('./types.js').Principal[]}} confirmers 每道门禁找谁确认（由角色域解析算出）
 */

/**
 * 门禁策略快照的输入形状。
 *
 * @typedef {Object} GateSpecSnapshot
 * @property {string} [timeout] 例如 '2h'
 * @property {'remind_then_escalate'|'auto_release'|'escalate_to_owner'|'notify_submitter'} [on_timeout]
 * @property {number} [max_release]
 */

/**
 * 哪些门禁在某个状态下**可以开始计时**。
 *
 * 这是必须的：如果建任务时给所有门禁都算上截止时间，
 * `confirm_split` 还没确认、`acceptance` 的时钟就已经在走，
 * 结果是任务刚建好没多久就被“验收超时”升级——纯粹误报。
 *
 * @type {Readonly<Record<'confirm_split'|'accept'|'start'|'acceptance', readonly string[]>>}
 */
export const GATE_ACTIVE_IN = Object.freeze({
  confirm_split: Object.freeze(['proposed']),
  accept: Object.freeze(['assigned']),
  start: Object.freeze(['accepted']),
  acceptance: Object.freeze(['in_review']),
})

/**
 * 按当前信息生成门禁集合。
 *
 * 两条规则（设计文档 06 §4.2 / §4.3）：
 * 1. 机器人执行者不需要人工确认 accept/start，标 `not_applicable`
 * 2. `required_by` 一旦写入就不再随配置变化——重算必须显式调用本函数
 *
 * **只写策略快照（timeout / on_timeout / max_release），不写截止时间**——
 * 因为此刻还不知道任务会走到哪个状态。截止时间由 `initializeGates`
 * 与状态机的 `activateDue` 负责。
 *
 * @param {GateDefaultsInput} input
 * @param {Record<string, GateSpecSnapshot>} [specs]
 * @returns {Record<'confirm_split'|'accept'|'start'|'acceptance', import('./schema.js').Gate>}
 */
export function buildGates(input, specs = {}) {
  const assignee = input.assignee ?? null
  const human = assignee === null || isHuman(assignee)

  /**
   * @param {'confirm_split'|'accept'|'start'|'acceptance'} name
   * @param {import('./types.js').Principal[]} required
   * @param {boolean} [notApplicable]
   * @returns {import('./schema.js').Gate}
   */
  const gate = (name, required, notApplicable = false) => {
    const spec = specs[name]
    return {
      required_by: notApplicable ? [] : required,
      confirmed_by: [],
      due_at: null,
      not_applicable: notApplicable,
      timeout_snapshot: spec?.timeout ?? null,
      on_timeout: spec?.on_timeout ?? null,
      max_release: spec?.max_release ?? null,
    }
  }

  return {
    confirm_split: gate('confirm_split', input.confirmers.confirm_split),
    accept: gate('accept', input.confirmers.accept, !human),
    start: gate('start', input.confirmers.start, !human),
    acceptance: gate('acceptance', input.confirmers.acceptance),
  }
}

/**
 * 建任务后立刻算一遍“当前阶段该计时的门禁”的截止时间。
 *
 * 之后每次状态跃迁由状态机的 `activateDue` 接力。
 *
 * @param {Record<string, import('./schema.js').Gate>} gates
 * @param {string} state
 * @param {Date} now
 * @returns {Record<string, import('./schema.js').Gate>}
 */
export function initializeGates(gates, state, now) {
  /** @type {Record<string, import('./schema.js').Gate>} */
  const out = {}
  for (const [name, gate] of Object.entries(gates)) {
    const active = (GATE_ACTIVE_IN[name] ?? []).includes(state)
    out[name] = active ? activateDue(gate, now) : gate
  }
  return out
}

/**
 * 用门禁快照里的 timeout 重算截止时间。
 *
 * 状态跃迁把某个门禁“激活”时调用（例如 accept 通过后 start 门禁才开始计时）。
 * 用的是**快照值**而不是当前配置——这正是快照存在的意义。
 *
 * @param {import('./schema.js').Gate} gate
 * @param {Date} now
 * @returns {import('./schema.js').Gate}
 */
export function activateDue(gate, now) {
  if (gate.not_applicable || gate.required_by.length === 0) return gate
  if (gate.due_at !== null) return gate
  return { ...gate, due_at: deadlineFrom(now, gate.timeout_snapshot) }
}

/**
 * 门禁的截止时间是否已经设置过（运维面板与调试用）。
 *
 * @param {import('./schema.js').Gate|undefined|null} gate
 * @returns {boolean}
 */
export function hasDeadline(gate) {
  return gate !== undefined && gate !== null && gate.due_at !== null
}

/**
 * `48h` / `30m` / `2d` → 毫秒。认不出来的一律 0（= 不设计时）。
 *
 * @param {string} d
 * @returns {number}
 */
function parseMs(d) {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(d)
  if (m === null) return 0
  const n = Number(m[1])
  const unit = m[2]
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000)
}

/**
 * @param {Date} now
 * @param {string|null} timeout
 * @returns {string|null}
 */
function deadlineFrom(now, timeout) {
  if (timeout === null) return null
  const ms = parseMs(timeout)
  return ms > 0 ? new Date(now.getTime() + ms).toISOString() : null
}

/**
 * @typedef {Object} CreateTaskOptions
 * @property {Date} now
 * @property {Record<'confirm_split'|'accept'|'start'|'acceptance', import('./schema.js').Gate>} [gates]
 */

/**
 * 建任务。`opts.gates` 优先于 `input.gates`（先算门禁再建对象是常规用法）。
 *
 * @param {Partial<import('./schema.js').Task> & {id: string, req: string, title: string, type: string, domains: string[]}} input
 * @param {CreateTaskOptions} opts
 * @returns {import('./schema.js').Task}
 */
export function createTask(input, opts) {
  const draft = {
    ...input,
    // taskSchema 里其余默认值（repo / branch / mr / gates / blocked_reason …）
    // 由 schema.js 的 parseTask 补齐，逐条对齐 schema.ts。
    state: input.state ?? 'proposed',
    assignee: input.assignee ?? null,
    collaborators: input.collaborators ?? [],
    owner: input.owner ?? input.assignee ?? null,
    acceptance_criteria: input.acceptance_criteria ?? [],
    gates: opts.gates ?? input.gates ?? {},
    evidence: input.evidence ?? [],
    release_count: input.release_count ?? 0,
    history: input.history ?? [
      { from: null, to: 'proposed', by: 'system', at: opts.now.toISOString() },
    ],
  }
  return parseTask(draft)
}

/* ------------------------------------------------------------------ *
 * 门禁通过判定——状态机与卡片渲染共用同一份逻辑
 * ------------------------------------------------------------------ */

/**
 * 门禁是否已经通过。
 *
 * 三种“通过”：没有这道门禁 / 机器人承接（not_applicable）/ required_by 为空。
 * 否则要求 required_by 里每个人都出现在 confirmed_by。
 *
 * @param {import('./schema.js').Gate|undefined|null} gate
 * @returns {boolean}
 */
export function gateSatisfied(gate, opts = {}) {
  if (gate === undefined || gate === null) return true
  if (gate.not_applicable) return true
  if (gate.required_by.length === 0) return true
  const done = new Set(gate.confirmed_by.map((c) => c.by))
  /*
   * **主 owner 的确认可以关掉这道门**（设计 00 §5.1："多人协作由主 owner 确认"）。
   *
   * 与"缺一方不推进"（04 §3.5 跨域并行确认）并不矛盾，它们是同一件事的两半：
   * 各域的负责人各自点头才算齐；而需求负责人——那个对这件事最终负责的人——
   * 点头就代表"我认了，不用再等"。没有这一条，一个两域的任务会永远要求两个人，
   * 而设计明说主 owner 可以确认；只有这一条，跨域任务又变成了一个人说了算。
   *
   * `opts.mainOwner` 由调用方给（领域层不认识需求对象）：一般是 `requirement.owner`。
   */
  if (typeof opts.mainOwner === 'string' && opts.mainOwner !== '' && done.has(opts.mainOwner)) return true
  return gate.required_by.every((p) => done.has(p))
}

/**
 * @param {import('./schema.js').Gate|undefined|null} gate
 * @returns {{confirmed: number, required: number}}
 */
export function gateProgress(gate) {
  if (gate === undefined || gate === null || gate.not_applicable) return { confirmed: 0, required: 0 }
  return { confirmed: gate.confirmed_by.length, required: gate.required_by.length }
}

/**
 * 谁还没确认——用于卡片 @人与催办。
 *
 * @param {import('./schema.js').Gate|undefined|null} gate
 * @returns {import('./types.js').Principal[]}
 */
export function gatePending(gate) {
  if (gate === undefined || gate === null || gate.not_applicable) return []
  const done = new Set(gate.confirmed_by.map((c) => c.by))
  return gate.required_by.filter((p) => !done.has(p))
}

/**
 * 需求是否可归档：其下任务必须全部 done（设计文档 06 §7 完整性约束 2）。
 *
 * 注意“一个任务都没有”不算完成（`mine.length > 0` 是必要条件）——
 * 空需求归档=什么都没交付，不能算完。
 *
 * @param {import('./schema.js').Requirement} req
 * @param {import('./schema.js').Task[]} tasks
 * @returns {boolean}
 */
export function requirementComplete(req, tasks) {
  /*
   * `dropped` 的任务**不算未完成**，也不再从需求的清单里删掉：
   *   · 算它没完成 → 需求永远收不了口（一条被废弃的任务会把整个需求钉死）；
   *   · 从清单里删掉 → 卡上再也看不到"这条被废弃了"，而废弃本身是需要留痕的决定。
   * 所以：留着条目，收口时忽略它。
   */
  const mine = tasks.filter((t) => t.req === req.id && t.state !== 'dropped')
  return mine.length > 0 && mine.every((t) => t.state === 'done' || t.state === 'archived')
}
