/*
 * 来源：hub/src/objects/schema.ts（354 行，zod 3.25）
 *
 * 这是业务对象的**唯一权威**校验点：Requirement / Task / Gate / Lease /
 * Decision / ConflictItem / InboundMessage / CallbackRecord。
 *
 * 改了什么：
 *   1. **zod → 手写校验**。zod 的 `safeParse().error.issues[0]` 在这里变成
 *      “遇到第一个 issue 就抛 ObjectError”，issue 的 path/message 逐条对齐 zod 3.25
 *      的输出（含 `Required` / `Expected string, received number` /
 *      `Invalid enum value. Expected 'a' | 'b', received 'c'` /
 *      `Unrecognized key(s) in object: 'b'` / `String must contain at least 1
 *      character(s)` / `Number must be greater than 0` / `Invalid datetime`）。
 *      这些文案不是随便写的：hub 的 objectstore / 卡片会把它们直接显示给人。
 *   2. TS 类型（Requirement / Task / Gate / Lease / …）→ JSDoc @typedef。
 *   3. zod schema 对象 → `parseXxx()` 函数 + 冻结的取值表常量
 *      （REQUIREMENT_STATES / TASK_STATES / GATE_NAMES / LEASE_STATES / …）。
 *      对应关系：
 *        requirementSchema        → parseRequirement()
 *        taskSchema               → parseTask()
 *        leaseSchema              → parseLease()
 *        gateSchema               → parseGate()（也内嵌在 parseTask 里）
 *        evidenceSchema           → parseEvidence()
 *        historyEntrySchema       → parseHistoryEntry()
 *        decisionSchema           → parseDecision()
 *        conflictSchema           → parseConflict()
 *        inboundMessageSchema     → parseInboundMessage()
 *        callbackRecordSchema     → parseCallbackRecord()
 *        principalSchema          → parsePrincipal()（= 内部 asPrincipalValue）
 *        visibilitySchema         → parseVisibility()
 *   4. **每一个 `.default()` 都逐条复刻**（见下面每个 default() 的注释）。
 *      默认值是“输入可缺省、输出必填”的落地方式，漏一个就会让
 *      `createTask` / `createRequirement` 产出形状不同的对象。
 *   5. `.strict()` 全部保留：未声明的键直接报错，不静默丢弃。
 *
 * 没能保住的语义（显式列出）：
 *   - `requirementInputSchema` / `taskInputSchema`（`.partial().required({...})`）
 *     **没有移植**：它们只是“新建时的入参类型”糖，运行期一次都没被用过——
 *     `createRequirement` / `createTask` 是自己补默认值，然后拿**完整** schema
 *     校验草稿（见 objects.js 顶部注释）。缺的只是“少传一个字段”的静态类型提示。
 *   - zod 会一次性收集**全部** issue；这里只保留**第一条**（hub 的 parseOrThrow
 *     取的也是 `issues[0]`），并把它的 path 拼进 ObjectError.path。
 *     因此“一次报出所有错误”的能力没了，与 hub 的对外行为一致。
 *   - `z.record(z.string(), z.unknown())`（history.detail）在 JS 里无法表达
 *     “值是 unknown”，这里只校验“是普通对象”。
 */

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

/**
 * 对象校验失败。消息格式与 hub 逐字一致：
 *   `${path}: ${message}`，path 为 `task.id` / `requirement.body.problem`
 *   这类“对象名.字段路径”（未声明键的 path 只有对象名本身，因为 zod 的
 *   unrecognized_keys issue 的 path 是空数组）。
 *
 * hub 把 ObjectError 定义在 objects.ts；这里定义在 schema.js，因为
 * 校验函数本身要抛它（objects.js 再 re-export 一次保持同名可达）。
 */
export class ObjectError extends Error {
  /**
   * @param {string} path
   * @param {string} message
   */
  constructor(path, message) {
    super(`${path}: ${message}`)
    this.name = 'ObjectError'
    /** @type {string} */
    this.path = path
  }
}

/* ------------------------------------------------------------------ *
 * 取值表（zod enum 的落地）
 * ------------------------------------------------------------------ */

/** 需求状态 */
export const REQUIREMENT_STATES = Object.freeze([
  'draft',
  'confirmed',
  'dispatched',
  'done',
  'archived',
  'changed',
  'blocked',
  'suspended',
  'dropped',
])

/** 任务状态 */
export const TASK_STATES = Object.freeze([
  'proposed',
  'confirmed',
  'assigned',
  'accepted',
  'in_progress',
  'ci_running',
  'blocked',
  'in_review',
  'rejected',
  'suspended',
  'dropped',
  'done',
  'archived',
])

/** 流程门禁名（taskSchema.gates 的 record 键） */
export const GATE_NAMES = Object.freeze(['confirm_split', 'accept', 'start', 'acceptance'])

/** 需求来源面 */
export const ORIGIN_SURFACES = Object.freeze(['feishu', 'internal', 'manual', 'doc'])

/** 优先级 */
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3'])

/** 门禁超时后的策略 */
export const ON_TIMEOUT_VALUES = Object.freeze([
  'remind_then_escalate',
  'auto_release',
  'escalate_to_owner',
  'notify_submitter',
])

/** 证据类型 */
export const EVIDENCE_KINDS = Object.freeze(['test', 'diff', 'artifact', 'link', 'note'])

/** 租约状态 */
export const LEASE_STATES = Object.freeze(['active', 'released', 'expired', 'returned'])

/** 租约释放原因 */
export const RELEASE_REASONS = Object.freeze([
  'start_timeout',
  'accept_timeout',
  'expired',
  'returned',
  'reassigned',
  'dropped',
])

/** 决策状态 */
export const DECISION_STATUSES = Object.freeze(['proposed', 'accepted', 'superseded', 'rejected'])

/** 决策来源 */
export const DECISION_SOURCE_KINDS = Object.freeze(['feishu_chat', 'dsh_session', 'doc', 'git_mr', 'manual'])

/** 冲突类型 */
export const CONFLICT_KINDS = Object.freeze(['doc', 'offline', 'memory', 'semantic'])

/** 冲突自动合并结论 */
export const AUTO_MERGE_VALUES = Object.freeze(['ok', 'partial', 'impossible'])

/** 冲突状态 */
export const CONFLICT_STATES = Object.freeze(['open', 'resolved', 'deferred'])

/** 入站消息会话类型 */
export const CHAT_TYPES = Object.freeze(['p2p', 'group'])

/** 回调处理结果 */
export const CALLBACK_OUTCOMES = Object.freeze(['applied', 'denied', 'failed'])

/** 可见性枚举（另有 `project:xxx` 前缀的动态值，见 asVisibilityValue） */
export const VISIBILITY_VALUES = Object.freeze(['team', 'private'])

/* ------------------------------------------------------------------ *
 * 正则（逐字照搬 schema.ts）
 * ------------------------------------------------------------------ */

/** 主体：human:xxx / bot:xxx / role:xxx / system */
export const PRINCIPAL_RE = /^(system|(human|bot|role):.+)$/
/** 需求 ID：req-2026-014 */
export const REQUIREMENT_ID_RE = /^req-\d{4}-\d{3,}$/
/** 任务 ID：task-8891 */
export const TASK_ID_RE = /^task-\d+$/
/** 决策 ID：adr-2026-003 */
export const DECISION_ID_RE = /^adr-\d{4}-\d{3,}$/
/** 冲突 ID：cfl-1 */
export const CONFLICT_ID_RE = /^cfl-\d+$/
/** 项目可见性：project:pay-service（zod 侧是 `.regex(/^project:/)`，尾部不锚定） */
export const PROJECT_VISIBILITY_RE = /^project:/

/**
 * `z.string().datetime({ offset: true })` 的正则。
 *
 * 逐字抄自 zod 3.25 的 datetimeRegex（含闰年校验的 dateRegexSource 与
 * 秒可省略的 timeRegexSource，offset 允许 `+08:00` 与 `+0800`）。
 * 抄而不是自己写，是因为“哪天算合法 ISO”会直接影响落盘与解析。
 */
const DATE_RE_SOURCE =
  '((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))'
const TIME_RE_SOURCE = '([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?'
const ISO_DATETIME_RE = new RegExp(`^${DATE_RE_SOURCE}T${TIME_RE_SOURCE}(Z|([+-]\\d{2}:?\\d{2}))$`)

/* ------------------------------------------------------------------ *
 * JSDoc 形状（TS interface 的替代）
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} GateConfirmation
 * @property {import('./types.js').Principal} by
 * @property {string} at ISO datetime
 */

/**
 * 一个门禁的实例。
 *
 * `required_by` 是**创建时算好并冻结的**（配置改了不影响进行中的任务）；
 * `confirmed_by` 记录实际确认过的人；两者相等才算这道门禁通过。
 *
 * @typedef {Object} Gate
 * @property {import('./types.js').Principal[]} required_by 需要哪些主体确认；空数组 = 机器人承接，不需要人工确认
 * @property {GateConfirmation[]} confirmed_by 已确认的主体，含时间
 * @property {string|null} due_at 该门禁的截止时间（由门禁超时算出）
 * @property {boolean} not_applicable 机器人承接时标记，便于统计“有多少门禁被跳过”
 * @property {string|null} timeout_snapshot 门禁策略快照：超时值（建任务时从配置抄一份）
 * @property {'remind_then_escalate'|'auto_release'|'escalate_to_owner'|'notify_submitter'|null} on_timeout 门禁策略快照：超时策略
 * @property {number|null} max_release 门禁策略快照：最多自动释放几次
 */

/**
 * 状态跃迁历史的一条。
 *
 * @typedef {Object} HistoryEntry
 * @property {string|null} from
 * @property {string} to
 * @property {import('./types.js').Principal} by
 * @property {string} at ISO datetime
 * @property {string} [reason]
 * @property {Record<string, unknown>} [detail] 跃迁时附带的机器可读信息，例如“第 2 次自动释放”
 * @property {string[]} [effects] 这次跃迁声明要做的副作用；落进历史才能回答“当时承诺做什么”
 */

/**
 * @typedef {Object} RequirementOrigin
 * @property {'feishu'|'internal'|'manual'|'doc'} surface
 * @property {string} [chat_id]
 * @property {string} [thread]
 * @property {string[]} excerpts
 */

/**
 * @typedef {Object} RequirementBody
 * @property {string} problem
 * @property {string} proposal
 */

/**
 * @typedef {Object} RequirementLinks
 * @property {string[]} repos
 * @property {string[]} docs
 * @property {string|null} mirror
 * @property {string[]} branches
 */

/**
 * @typedef {Object} Requirement
 * @property {string} id 形如 req-2026-014
 * @property {string} title
 * @property {'draft'|'confirmed'|'dispatched'|'done'|'archived'|'changed'|'blocked'|'suspended'|'dropped'} state
 * @property {string} type 任务类型（对应 workflow.yaml 的 task_types 键）
 * @property {RequirementOrigin} origin
 * @property {import('./types.js').Principal} requester
 * @property {import('./types.js').Principal} owner
 * @property {'P0'|'P1'|'P2'|'P3'} priority
 * @property {RequirementBody} body
 * @property {string[]} acceptance_criteria
 * @property {string[]} tasks
 * @property {RequirementLinks} links
 * @property {string[]} decisions
 * @property {string} visibility 'team' | 'private' | 'project:xxx'
 * @property {HistoryEntry[]} history
 */

/**
 * @typedef {Object} Evidence
 * @property {'test'|'diff'|'artifact'|'link'|'note'} kind
 * @property {string} ref
 * @property {string} [note]
 * @property {string} [at] ISO datetime
 */

/**
 * @typedef {Object} Task
 * @property {string} id 形如 task-8891
 * @property {string} req 形如 req-2026-014
 * @property {string} title
 * @property {'proposed'|'confirmed'|'assigned'|'accepted'|'in_progress'|'ci_running'|'blocked'|'in_review'|'rejected'|'suspended'|'dropped'|'done'|'archived'} state
 * @property {string} type
 * @property {string[]} domains 至少一个角色域
 * @property {import('./types.js').Principal|null} assignee
 * @property {import('./types.js').Principal[]} collaborators
 * @property {import('./types.js').Principal|null} owner
 * @property {string[]} acceptance_criteria
 * @property {Partial<Record<'confirm_split'|'accept'|'start'|'acceptance', Gate>>} gates
 * @property {string|null} repo
 * @property {string|null} branch
 * @property {number|null} mr
 * @property {Evidence[]} evidence
 * @property {number} release_count 被自动释放的次数；≥ max_release 时升级给需求负责人
 * @property {string|null} blocked_reason
 * @property {HistoryEntry[]} history
 */

/**
 * @typedef {Object} Lease
 * @property {string} task 形如 task-8891（租约的身份就是 task_id）
 * @property {import('./types.js').Principal} holder
 * @property {'human'|'bot'} kind
 * @property {string} started_at ISO datetime
 * @property {string} expires_at ISO datetime
 * @property {number} renewals
 * @property {'active'|'released'|'expired'|'returned'} state
 * @property {'start_timeout'|'accept_timeout'|'expired'|'returned'|'reassigned'|'dropped'|null} release_reason
 * @property {number} expiry_notices 过期后已播报过几次（不记次数就会每次 tick 都喊一遍）
 */

/**
 * @typedef {Object} Decision
 * @property {string} id 形如 adr-2026-003
 * @property {string} title
 * @property {'proposed'|'accepted'|'superseded'|'rejected'} status
 * @property {import('./types.js').Principal} owner
 * @property {string} date
 * @property {string[]} supersedes
 * @property {{requirements: string[], tasks: string[], repos: string[]}} related
 * @property {{kind: 'feishu_chat'|'dsh_session'|'doc'|'git_mr'|'manual', ref: string}} [source]
 */

/**
 * @typedef {Object} Conflict
 * @property {string} id 形如 cfl-1
 * @property {'doc'|'offline'|'memory'|'semantic'} kind
 * @property {string} scope
 * @property {{a: {ref: string, version: string, by: import('./types.js').Principal}, b: {ref: string, version: string, by: import('./types.js').Principal}}} objects
 * @property {string|null} base
 * @property {'ok'|'partial'|'impossible'} auto_merge
 * @property {string|null} suggested_resolution
 * @property {import('./types.js').Principal} owner
 * @property {'open'|'resolved'|'deferred'} state
 * @property {string|null} deadline ISO datetime
 */

/**
 * 归一化后的入站消息。
 *
 * 为什么不是“来一条处理一条”：群聊的语义本来就是**一段对话**，
 * 一次 agent 唤醒消费的是截至某序号的一批消息。落库之后提取器可以按批次读，
 * 重投也不会丢上下文。
 *
 * @typedef {Object} InboundMessage
 * @property {string} message_id
 * @property {string} dedupe_key
 * @property {string|null} event_id
 * @property {string} chat_id
 * @property {'p2p'|'group'} chat_type
 * @property {string} message_type
 * @property {string|null} thread_id
 * @property {string|null} sender_open_id
 * @property {import('./types.js').Principal|null} sender_principal
 * @property {Array<{open_id: string|null, name: string|null}>} mentions
 * @property {string} text
 * @property {string} raw_content
 * @property {string|null} create_time
 * @property {string} received_at ISO datetime
 * @property {string[]} consumed_by 已消费该消息的需求（避免同一条消息反复建单）
 * @property {string|null} ignored_reason 明确判定为非需求时记原因，用于算漏单率
 */

/**
 * 已处理的动作回调。飞书的卡片回调会重投，而且**按钮可以点第二次**，
 * 所以落库而不是内存 nonce——重启也不失效。
 *
 * @typedef {Object} CallbackRecord
 * @property {string} nonce
 * @property {string} action
 * @property {string|null} object_id
 * @property {import('./types.js').Principal} actor
 * @property {string} at ISO datetime
 * @property {'applied'|'denied'|'failed'} outcome
 * @property {string|null} detail
 */

/* ------------------------------------------------------------------ *
 * 内部：校验原语（zod 每一条 check 的等价物）
 * ------------------------------------------------------------------ */

/**
 * 一次校验的上下文：只带“这是哪个对象”，用来拼 ObjectError 的 path 前缀。
 *
 * 校验遇到第一个 issue 立刻抛错（zod 会收集全部 issue；hub 的 parseOrThrow
 * 取 issues[0]，所以对外可见行为一致）。
 */
class Ctx {
  /** @param {string} what 对象名，例如 task / requirement / lease */
  constructor(what) {
    this.what = what
  }

  /**
   * @param {Array<string|number>} path
   * @param {string} message
   * @returns {never}
   */
  fail(path, message) {
    const loc = path.join('.')
    throw new ObjectError(loc === '' ? this.what : `${this.what}.${loc}`, message)
  }
}

/** zod 的 `ZodParsedType` 名字表（复刻 util.getParsedType，保证文案一致） */
function typeNameOf(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return Number.isNaN(value) ? 'nan' : 'number'
    case 'boolean':
      return 'boolean'
    case 'function':
      return 'function'
    case 'bigint':
      return 'bigint'
    case 'symbol':
      return 'symbol'
    default:
      return value instanceof Date ? 'date' : 'object'
  }
}

/** zod 的 util.joinValues：字符串加引号，其余原样，` | ` 连接 */
function joinValues(values) {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : v)).join(' | ')
}

/**
 * zod 的 invalid_type 文案：received 是 undefined 时，错误映射会把消息改成
 * `Required`（缺一个必填字段不该显示“Expected string, received undefined”）。
 * 凡是“类型不对”的报错都走这里，保证与 hub 逐字一致。
 *
 * @param {string} expected
 * @param {unknown} value
 * @returns {string}
 */
function typeMessage(expected, value) {
  return value === undefined ? 'Required' : `Expected ${expected}, received ${typeNameOf(value)}`
}

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {string} expected
 */
function expectType(c, path, value, expected) {
  if (typeof value !== expected) {
    c.fail(path, typeMessage(expected, value))
  }
}

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {string}
 */
function asString(c, path, value) {
  expectType(c, path, value, 'string')
  return /** @type {string} */ (value)
}

/**
 * `z.string().min(n)`。zod 的默认文案是
 * `String must contain at least n character(s)`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {number} min
 * @param {string} [message] 自定义文案（schema.ts 里 .min(1, '…') 的那种）
 * @returns {string}
 */
function asStringMin(c, path, value, min, message) {
  const str = asString(c, path, value)
  if (str.length < min) c.fail(path, message ?? `String must contain at least ${min} character(s)`)
  return str
}

/**
 * `z.string().regex(re, message)`。无自定义文案时 zod 的默认文案是 `Invalid`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {RegExp} re
 * @param {string} [message]
 * @returns {string}
 */
function asPattern(c, path, value, re, message) {
  const str = asString(c, path, value)
  if (!re.test(str)) c.fail(path, message ?? 'Invalid')
  return str
}

/**
 * `z.string().datetime({ offset: true })`：不合法时报 `Invalid datetime`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {string}
 */
function asIso(c, path, value) {
  const str = asString(c, path, value)
  if (!ISO_DATETIME_RE.test(str)) c.fail(path, 'Invalid datetime')
  return str
}

/**
 * zod 的 ZodEnum：非字符串 → invalid_type（expected 是 `'a' | 'b'`）；
 * 字符串但不在表里 → Invalid enum value。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {readonly string[]} values
 * @returns {string}
 */
function asEnum(c, path, value, values) {
  const expected = joinValues([...values])
  if (typeof value !== 'string') c.fail(path, typeMessage(expected, value))
  if (!values.includes(value)) {
    c.fail(path, `Invalid enum value. Expected ${expected}, received '${value}'`)
  }
  return value
}

/**
 * `principalSchema`（z.custom<Principal>）。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {import('./types.js').Principal}
 */
function asPrincipalValue(c, path, value) {
  if (typeof value !== 'string' || !PRINCIPAL_RE.test(value)) {
    c.fail(path, '主体应形如 human:xxx / bot:xxx / role:xxx，或 system')
  }
  return value
}

/**
 * `visibilitySchema = z.enum(['team','private']).or(z.string().regex(/^project:/))`。
 *
 * 复刻的是 zod **union 的取值过程**，所以文案分三种：
 *   - 非字符串：两个分支都 abort → `Invalid input`
 *   - 字符串但都没匹配上：第二个分支是 dirty（regex 的 `Invalid`），union 返回它
 *   - 'team' / 'private' / `project:xxx` → 通过
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {string}
 */
function asVisibilityValue(c, path, value) {
  if (typeof value !== 'string') c.fail(path, 'Invalid input')
  if (VISIBILITY_VALUES.includes(value) || PROJECT_VISIBILITY_RE.test(value)) return value
  c.fail(path, 'Invalid')
}

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {boolean}
 */
function asBoolean(c, path, value) {
  expectType(c, path, value, 'boolean')
  return /** @type {boolean} */ (value)
}

/**
 * `z.number()`（不含 int / min / max）。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {number}
 */
function asNumber(c, path, value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    c.fail(path, typeMessage('number', value))
  }
  return /** @type {number} */ (value)
}

/**
 * `z.number().int()`：非整数时报 `Expected integer, received float`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {number}
 */
function asInteger(c, path, value) {
  const num = asNumber(c, path, value)
  if (!Number.isInteger(num)) c.fail(path, 'Expected integer, received float')
  return num
}

/**
 * `z.number().int().positive()`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {number}
 */
function asPositiveInteger(c, path, value) {
  const num = asInteger(c, path, value)
  if (!(num > 0)) c.fail(path, 'Number must be greater than 0')
  return num
}

/**
 * `z.number().int().nonnegative()`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {number}
 */
function asNonNegativeInteger(c, path, value) {
  const num = asInteger(c, path, value)
  if (num < 0) c.fail(path, 'Number must be greater than or equal to 0')
  return num
}

/**
 * `z.array(item)`。元素下标进 path，与 zod 一致（`domains.0`）。
 *
 * @template T
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {(c: Ctx, path: Array<string|number>, value: unknown) => T} item
 * @returns {T[]}
 */
function asArray(c, path, value, item) {
  if (!Array.isArray(value)) c.fail(path, typeMessage('array', value))
  /** @type {T[]} */
  const out = []
  for (let i = 0; i < value.length; i += 1) out.push(item(c, [...path, i], value[i]))
  return out
}

/**
 * `z.array(x).min(n, message)`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {number} min
 * @param {string} message
 * @returns {number}
 */
function asArrayMin(c, path, value, min, message) {
  if (!Array.isArray(value)) c.fail(path, typeMessage('array', value))
  if (value.length < min) c.fail(path, message)
  return value.length
}

/**
 * `.nullable()`：null 直接通过，其余交给内层。
 *
 * @template T
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {(c: Ctx, path: Array<string|number>, value: unknown) => T} inner
 * @returns {T|null}
 */
function asNullable(c, path, value, inner) {
  return value === null ? null : inner(c, path, value)
}

/**
 * `z.record(keyEnum, valueSchema)`：先校验键（path 带上键名），再校验值。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {(c: Ctx, path: Array<string|number>, value: unknown) => unknown} valueOf
 * @returns {Record<string, unknown>}
 */
function asRecordOf(c, path, value, keys, valueOf) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    c.fail(path, typeMessage('object', value))
  }
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(value)) {
    asEnum(c, [...path, key], key, keys)
    out[key] = valueOf(c, [...path, key], value[key])
  }
  return out
}

/**
 * `z.record(z.string(), z.unknown())`：只校验“是普通对象”。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asUnknownRecord(c, path, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    c.fail(path, typeMessage('object', value))
  }
  return { ...value }
}

/**
 * @typedef {Object} Field
 * @property {string} name
 * @property {(raw: unknown, path: Array<string|number>) => unknown} parse
 * @property {() => unknown} [default] 缺省（undefined）时的默认值；每次调用现造一个，避免共享可变对象
 * @property {boolean} [optional] 缺省时从输出里省略（zod 的 .optional()）
 */

/**
 * `.strict()` 对象：按声明顺序逐字段校验，最后拒绝未声明的键。
 *
 * 顺序与 zod 一致：先 shape 的键（声明顺序），再 unrecognized keys；
 * 未声明键的 path 是**对象自身**（zod 的 unrecognized_keys issue path 为空数组）。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} value
 * @param {Field[]} fields
 * @returns {Record<string, unknown>}
 */
function asStrictObject(c, path, value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    c.fail(path, typeMessage('object', value))
  }
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const field of fields) {
    const raw = value[field.name]
    const childPath = [...path, field.name]
    if (raw === undefined) {
      if (field.default !== undefined) {
        out[field.name] = field.default()
        continue
      }
      if (field.optional === true) continue
      // 缺一个必填键时，zod 也是把 undefined 交给**内层 schema** 去报错，
      // 所以文案随内层而变：string/enum/array/object → `Required`，
      // z.custom（主体）→ 自定义文案，union（visibility）→ `Invalid input`。
      // 这里必须走同一个 parse，不能自己写死 "Required"。
      out[field.name] = field.parse(undefined, childPath)
      continue
    }
    out[field.name] = field.parse(raw, childPath)
  }
  const declared = new Set(fields.map((f) => f.name))
  const unknown = Object.keys(value).filter((k) => !declared.has(k))
  if (unknown.length > 0) {
    c.fail(path, `Unrecognized key(s) in object: ${unknown.map((k) => `'${k}'`).join(', ')}`)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 通用
 * ------------------------------------------------------------------ */

/**
 * `principalSchema` 的独立入口。
 *
 * @param {unknown} data
 * @returns {import('./types.js').Principal}
 */
export function parsePrincipal(data) {
  return asPrincipalValue(new Ctx('principal'), [], data)
}

/**
 * `visibilitySchema` 的独立入口。
 *
 * @param {unknown} data
 * @returns {string}
 */
export function parseVisibility(data) {
  return asVisibilityValue(new Ctx('visibility'), [], data)
}

/**
 * `historyEntrySchema`。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {HistoryEntry}
 */
function historyEntryValue(c, path, raw) {
  return /** @type {HistoryEntry} */ (
    asStrictObject(c, path, raw, [
      // from: z.string().nullable()（无默认：必须显式给 null）
      { name: 'from', parse: (v, p) => asNullable(c, p, v, asString) },
      { name: 'to', parse: (v, p) => asString(c, p, v) },
      { name: 'by', parse: (v, p) => asPrincipalValue(c, p, v) },
      { name: 'at', parse: (v, p) => asIso(c, p, v) },
      // reason / detail / effects 都无默认，缺省即省略
      { name: 'reason', parse: (v, p) => asString(c, p, v), optional: true },
      { name: 'detail', parse: (v, p) => asUnknownRecord(c, p, v), optional: true },
      { name: 'effects', parse: (v, p) => asArray(c, p, v, asString), optional: true },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {HistoryEntry}
 */
export function parseHistoryEntry(data) {
  return historyEntryValue(new Ctx('history_entry'), [], data)
}

/**
 * `gateSchema`。
 *
 * 注意 `timeout_snapshot` / `on_timeout` / `max_release` 三项是**策略快照**：
 * 必须在建任务时从配置里抄一份进来（设计文档 06 §4.2）。默认全是 null，
 * 表示“这道门禁没有超时策略”——不是“用当前配置”。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {Gate}
 */
function gateValue(c, path, raw) {
  return /** @type {Gate} */ (
    asStrictObject(c, path, raw, [
      // z.array(principalSchema).default([])
      { name: 'required_by', parse: (v, p) => asArray(c, p, v, asPrincipalValue), default: () => [] },
      // z.array(z.object({by, at}).strict()).default([])
      {
        name: 'confirmed_by',
        parse: (v, p) =>
          asArray(c, p, v, (cc, pp, item) =>
            asStrictObject(cc, pp, item, [
              { name: 'by', parse: (x, q) => asPrincipalValue(cc, q, x) },
              { name: 'at', parse: (x, q) => asIso(cc, q, x) },
            ]),
          ),
        default: () => [],
      },
      // iso.nullable().default(null)
      { name: 'due_at', parse: (v, p) => asNullable(c, p, v, asIso), default: () => null },
      // z.boolean().default(false)
      { name: 'not_applicable', parse: (v, p) => asBoolean(c, p, v), default: () => false },
      // z.string().nullable().default(null)
      { name: 'timeout_snapshot', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      // z.enum([...]).nullable().default(null)
      {
        name: 'on_timeout',
        parse: (v, p) => asNullable(c, p, v, (cc, pp, x) => asEnum(cc, pp, x, ON_TIMEOUT_VALUES)),
        default: () => null,
      },
      // z.number().int().positive().nullable().default(null)
      {
        name: 'max_release',
        parse: (v, p) => asNullable(c, p, v, asPositiveInteger),
        default: () => null,
      },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {Gate}
 */
export function parseGate(data) {
  return gateValue(new Ctx('gate'), [], data)
}

/**
 * `evidenceSchema`（无任何默认值：kind / ref 必填）。
 *
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {Evidence}
 */
function evidenceValue(c, path, raw) {
  return /** @type {Evidence} */ (
    asStrictObject(c, path, raw, [
      { name: 'kind', parse: (v, p) => asEnum(c, p, v, EVIDENCE_KINDS) },
      { name: 'ref', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'note', parse: (v, p) => asString(c, p, v), optional: true },
      { name: 'at', parse: (v, p) => asIso(c, p, v), optional: true },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {Evidence}
 */
export function parseEvidence(data) {
  return evidenceValue(new Ctx('evidence'), [], data)
}

/* ------------------------------------------------------------------ *
 * Requirement
 * ------------------------------------------------------------------ */

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {RequirementOrigin}
 */
function originValue(c, path, raw) {
  return /** @type {RequirementOrigin} */ (
    asStrictObject(c, path, raw, [
      { name: 'surface', parse: (v, p) => asEnum(c, p, v, ORIGIN_SURFACES) },
      { name: 'chat_id', parse: (v, p) => asString(c, p, v), optional: true },
      { name: 'thread', parse: (v, p) => asString(c, p, v), optional: true },
      // .default([])
      { name: 'excerpts', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
    ])
  )
}

/** `body`：problem / proposal 各有 .default('')，整体 `.strict().default({})` */
function bodyValue(c, path, raw) {
  return asStrictObject(c, path, raw, [
    { name: 'problem', parse: (v, p) => asString(c, p, v), default: () => '' },
    { name: 'proposal', parse: (v, p) => asString(c, p, v), default: () => '' },
  ])
}

/** `links`：repos/docs/branches 默认 []，mirror 默认 null，整体 `.strict().default({})` */
function linksValue(c, path, raw) {
  return asStrictObject(c, path, raw, [
    { name: 'repos', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
    { name: 'docs', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
    { name: 'mirror', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
    { name: 'branches', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
  ])
}

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {Requirement}
 */
function requirementValue(c, path, raw) {
  return /** @type {Requirement} */ (
    asStrictObject(c, path, raw, [
      { name: 'id', parse: (v, p) => asPattern(c, p, v, REQUIREMENT_ID_RE, '需求 ID 形如 req-2026-014') },
      { name: 'title', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'state', parse: (v, p) => asEnum(c, p, v, REQUIREMENT_STATES) },
      { name: 'type', parse: (v, p) => asStringMin(c, p, v, 1) },
      // origin 没有整体默认值：createRequirement 负责补齐 {surface:'manual'} 后再进这里
      { name: 'origin', parse: (v, p) => originValue(c, p, v) },
      { name: 'requester', parse: (v, p) => asPrincipalValue(c, p, v) },
      { name: 'owner', parse: (v, p) => asPrincipalValue(c, p, v) },
      { name: 'priority', parse: (v, p) => asEnum(c, p, v, PRIORITIES) },
      // z.object({problem, proposal}).strict().default({})
      { name: 'body', parse: (v, p) => bodyValue(c, p, v), default: () => bodyValue(c, [], {}) },
      { name: 'acceptance_criteria', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
      { name: 'tasks', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
      // z.object({repos, docs, mirror, branches}).strict().default({})
      { name: 'links', parse: (v, p) => linksValue(c, p, v), default: () => linksValue(c, [], {}) },
      { name: 'decisions', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
      // visibilitySchema.default('team')
      { name: 'visibility', parse: (v, p) => asVisibilityValue(c, p, v), default: () => 'team' },
      { name: 'history', parse: (v, p) => asArray(c, p, v, historyEntryValue), default: () => [] },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {Requirement}
 */
export function parseRequirement(data) {
  return requirementValue(new Ctx('requirement'), [], data)
}

/* ------------------------------------------------------------------ *
 * Task
 * ------------------------------------------------------------------ */

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {Task}
 */
function taskValue(c, path, raw) {
  return /** @type {Task} */ (
    asStrictObject(c, path, raw, [
      { name: 'id', parse: (v, p) => asPattern(c, p, v, TASK_ID_RE, '任务 ID 形如 task-8891') },
      { name: 'req', parse: (v, p) => asPattern(c, p, v, REQUIREMENT_ID_RE, '任务必须归属一个需求') },
      { name: 'title', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'state', parse: (v, p) => asEnum(c, p, v, TASK_STATES) },
      { name: 'type', parse: (v, p) => asStringMin(c, p, v, 1) },
      {
        name: 'domains',
        parse: (v, p) => {
          asArrayMin(c, p, v, 1, '任务至少要属于一个角色域')
          return asArray(c, p, v, (cc, pp, x) => asStringMin(cc, pp, x, 1))
        },
      },
      { name: 'assignee', parse: (v, p) => asNullable(c, p, v, asPrincipalValue), default: () => null },
      { name: 'collaborators', parse: (v, p) => asArray(c, p, v, asPrincipalValue), default: () => [] },
      { name: 'owner', parse: (v, p) => asNullable(c, p, v, asPrincipalValue), default: () => null },
      { name: 'acceptance_criteria', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
      // z.record(gateNameSchema, gateSchema).default({})
      {
        name: 'gates',
        parse: (v, p) => asRecordOf(c, p, v, GATE_NAMES, gateValue),
        default: () => ({}),
      },
      { name: 'repo', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'branch', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'mr', parse: (v, p) => asNullable(c, p, v, asPositiveInteger), default: () => null },
      { name: 'evidence', parse: (v, p) => asArray(c, p, v, evidenceValue), default: () => [] },
      // 被自动释放的次数；≥ max_release 时升级给需求负责人
      { name: 'release_count', parse: (v, p) => asNonNegativeInteger(c, p, v), default: () => 0 },
      { name: 'blocked_reason', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'history', parse: (v, p) => asArray(c, p, v, historyEntryValue), default: () => [] },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {Task}
 */
export function parseTask(data) {
  return taskValue(new Ctx('task'), [], data)
}

/* ------------------------------------------------------------------ *
 * Lease
 * ------------------------------------------------------------------ */

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {Lease}
 */
function leaseValue(c, path, raw) {
  return /** @type {Lease} */ (
    asStrictObject(c, path, raw, [
      { name: 'task', parse: (v, p) => asPattern(c, p, v, TASK_ID_RE) },
      { name: 'holder', parse: (v, p) => asPrincipalValue(c, p, v) },
      { name: 'kind', parse: (v, p) => asEnum(c, p, v, ['human', 'bot']) },
      { name: 'started_at', parse: (v, p) => asIso(c, p, v) },
      { name: 'expires_at', parse: (v, p) => asIso(c, p, v) },
      { name: 'renewals', parse: (v, p) => asNonNegativeInteger(c, p, v), default: () => 0 },
      { name: 'state', parse: (v, p) => asEnum(c, p, v, LEASE_STATES) },
      {
        name: 'release_reason',
        parse: (v, p) => asNullable(c, p, v, (cc, pp, x) => asEnum(cc, pp, x, RELEASE_REASONS)),
        default: () => null,
      },
      // 过期后已播报过几次（见 lease.js 的 leaseVerdict：不记次数就会刷屏）
      { name: 'expiry_notices', parse: (v, p) => asNonNegativeInteger(c, p, v), default: () => 0 },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {Lease}
 */
export function parseLease(data) {
  return leaseValue(new Ctx('lease'), [], data)
}

/* ------------------------------------------------------------------ *
 * Decision
 * ------------------------------------------------------------------ */

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {Decision}
 */
function decisionValue(c, path, raw) {
  return /** @type {Decision} */ (
    asStrictObject(c, path, raw, [
      { name: 'id', parse: (v, p) => asPattern(c, p, v, DECISION_ID_RE) },
      { name: 'title', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'status', parse: (v, p) => asEnum(c, p, v, DECISION_STATUSES) },
      { name: 'owner', parse: (v, p) => asPrincipalValue(c, p, v) },
      { name: 'date', parse: (v, p) => asString(c, p, v) },
      { name: 'supersedes', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
      {
        name: 'related',
        parse: (v, p) =>
          asStrictObject(c, p, v, [
            { name: 'requirements', parse: (x, q) => asArray(c, q, x, asString), default: () => [] },
            { name: 'tasks', parse: (x, q) => asArray(c, q, x, asString), default: () => [] },
            { name: 'repos', parse: (x, q) => asArray(c, q, x, asString), default: () => [] },
          ]),
        default: () => ({ requirements: [], tasks: [], repos: [] }),
      },
      {
        name: 'source',
        parse: (v, p) =>
          asStrictObject(c, p, v, [
            { name: 'kind', parse: (x, q) => asEnum(c, q, x, DECISION_SOURCE_KINDS) },
            { name: 'ref', parse: (x, q) => asString(c, q, x) },
          ]),
        optional: true,
      },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {Decision}
 */
export function parseDecision(data) {
  return decisionValue(new Ctx('decision'), [], data)
}

/* ------------------------------------------------------------------ *
 * ConflictItem（冲突收件箱）
 * ------------------------------------------------------------------ */

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {Conflict}
 */
function conflictValue(c, path, raw) {
  const side = (v, p) =>
    asStrictObject(c, p, v, [
      { name: 'ref', parse: (x, q) => asString(c, q, x) },
      { name: 'version', parse: (x, q) => asString(c, q, x) },
      { name: 'by', parse: (x, q) => asPrincipalValue(c, q, x) },
    ])
  return /** @type {Conflict} */ (
    asStrictObject(c, path, raw, [
      { name: 'id', parse: (v, p) => asPattern(c, p, v, CONFLICT_ID_RE) },
      { name: 'kind', parse: (v, p) => asEnum(c, p, v, CONFLICT_KINDS) },
      { name: 'scope', parse: (v, p) => asString(c, p, v) },
      {
        name: 'objects',
        parse: (v, p) =>
          asStrictObject(c, p, v, [
            { name: 'a', parse: side },
            { name: 'b', parse: side },
          ]),
      },
      { name: 'base', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'auto_merge', parse: (v, p) => asEnum(c, p, v, AUTO_MERGE_VALUES) },
      { name: 'suggested_resolution', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'owner', parse: (v, p) => asPrincipalValue(c, p, v) },
      { name: 'state', parse: (v, p) => asEnum(c, p, v, CONFLICT_STATES) },
      { name: 'deadline', parse: (v, p) => asNullable(c, p, v, asIso), default: () => null },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {Conflict}
 */
export function parseConflict(data) {
  return conflictValue(new Ctx('conflict'), [], data)
}

/* ------------------------------------------------------------------ *
 * InboundMessage
 * ------------------------------------------------------------------ */

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {InboundMessage}
 */
function inboundMessageValue(c, path, raw) {
  return /** @type {InboundMessage} */ (
    asStrictObject(c, path, raw, [
      { name: 'message_id', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'dedupe_key', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'event_id', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'chat_id', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'chat_type', parse: (v, p) => asEnum(c, p, v, CHAT_TYPES) },
      { name: 'message_type', parse: (v, p) => asString(c, p, v), default: () => 'text' },
      { name: 'thread_id', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'sender_open_id', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      {
        name: 'sender_principal',
        parse: (v, p) => asNullable(c, p, v, asPrincipalValue),
        default: () => null,
      },
      {
        name: 'mentions',
        parse: (v, p) =>
          asArray(c, p, v, (cc, pp, item) =>
            asStrictObject(cc, pp, item, [
              { name: 'open_id', parse: (x, q) => asNullable(cc, q, x, asString) },
              { name: 'name', parse: (x, q) => asNullable(cc, q, x, asString) },
            ]),
          ),
        default: () => [],
      },
      { name: 'text', parse: (v, p) => asString(c, p, v), default: () => '' },
      { name: 'raw_content', parse: (v, p) => asString(c, p, v), default: () => '' },
      { name: 'create_time', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'received_at', parse: (v, p) => asIso(c, p, v) },
      { name: 'consumed_by', parse: (v, p) => asArray(c, p, v, asString), default: () => [] },
      { name: 'ignored_reason', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {InboundMessage}
 */
export function parseInboundMessage(data) {
  return inboundMessageValue(new Ctx('inbound_message'), [], data)
}

/* ------------------------------------------------------------------ *
 * CallbackRecord
 * ------------------------------------------------------------------ */

/**
 * @param {Ctx} c
 * @param {Array<string|number>} path
 * @param {unknown} raw
 * @returns {CallbackRecord}
 */
function callbackRecordValue(c, path, raw) {
  return /** @type {CallbackRecord} */ (
    asStrictObject(c, path, raw, [
      { name: 'nonce', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'action', parse: (v, p) => asStringMin(c, p, v, 1) },
      { name: 'object_id', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
      { name: 'actor', parse: (v, p) => asPrincipalValue(c, p, v) },
      { name: 'at', parse: (v, p) => asIso(c, p, v) },
      { name: 'outcome', parse: (v, p) => asEnum(c, p, v, CALLBACK_OUTCOMES) },
      { name: 'detail', parse: (v, p) => asNullable(c, p, v, asString), default: () => null },
    ])
  )
}

/**
 * @param {unknown} data
 * @returns {CallbackRecord}
 */
export function parseCallbackRecord(data) {
  return callbackRecordValue(new Ctx('callback'), [], data)
}
