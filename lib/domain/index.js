/*
 * 来源：hub/src/domain/ 的领域层统一出口（hub 没有这个文件，是本次移植新增的汇总层）。
 *
 * 用法：
 *   import { transitionTask, createTask, buildGates } from './domain/index.js'
 *
 * 汇总了 7 个模块的全部对外名字：
 *   types.js     主体判定与时长格式化（asPrincipal / isHuman / isBot / formatDuration）
 *   schema.js    手写对象校验（parseTask / parseRequirement / parseLease / …）+ ObjectError
 *   objects.js   对象构造与门禁（createRequirement / createTask / buildGates / …）
 *   machine.js   两个状态机（transitionTask / transitionRequirement / availableActions / gateLine）
 *   lease.js     租约（openLease / renewLease / releaseLease / leaseVerdict / …）
 *   scheduler.js 到期扫描（scanDue / dueAction / upcoming / remainingMs）
 *   history.js   历史条目构造（historyEntry）
 *
 * **跳过没移植的源文件：hub/src/domain/registry.ts。**
 * 它不是纯逻辑：`domainsForTaskType()` 运行期 import 了 config 模块的
 * `effectiveTaskType()`，整个类以 `WorkflowConfig` 为输入，职责是把配置解析成
 * “谁负责哪个域 / 谁验收 / 租约策略”。要塞进这个零依赖的领域层，就得把配置层
 * 一起搬进来——那正是本次移植要避开的东西。缺它的影响是：调用方要自己算出
 * `TransitionContext` 的 `domainOwners / acceptors / pmOwners` 与
 * `buildGates` 的 `confirmers`（测试里用本地 fixture 复刻了示例配置的规则，
 * 见 test/domain.test.mjs 顶部）。`DEFAULT_LEASE_POLICY` 已经从 lease.js 导出，
 * 所以配置缺省租约策略的那一段不需要 registry 也能落地。
 *
 * 名字用**显式列表**而不是 `export *`：ObjectError 在 schema.js 与 objects.js
 * 都出现（与 hub 一样：hub 定义在 objects.ts），显式导出可以避免
 * “两个星号导出同名，结果谁都不导出”的坑。
 */

/* ---- types.js ---- */
export { asPrincipal, asPrincipalOrNull, isHuman, isBot, formatDuration } from './types.js'

/* ---- schema.js ---- */
export {
  ObjectError,
  parsePrincipal,
  parseVisibility,
  parseHistoryEntry,
  parseGate,
  parseEvidence,
  parseRequirement,
  parseTask,
  parseLease,
  parseDecision,
  parseConflict,
  parseInboundMessage,
  parseCallbackRecord,
  REQUIREMENT_STATES,
  TASK_STATES,
  GATE_NAMES,
  ORIGIN_SURFACES,
  PRIORITIES,
  ON_TIMEOUT_VALUES,
  EVIDENCE_KINDS,
  LEASE_STATES,
  RELEASE_REASONS,
  DECISION_STATUSES,
  DECISION_SOURCE_KINDS,
  CONFLICT_KINDS,
  AUTO_MERGE_VALUES,
  CONFLICT_STATES,
  CHAT_TYPES,
  CALLBACK_OUTCOMES,
  VISIBILITY_VALUES,
  PRINCIPAL_RE,
  REQUIREMENT_ID_RE,
  TASK_ID_RE,
  DECISION_ID_RE,
  CONFLICT_ID_RE,
  PROJECT_VISIBILITY_RE,
} from './schema.js'

/* ---- objects.js ---- */
export {
  createRequirement,
  createTask,
  buildGates,
  initializeGates,
  activateDue,
  hasDeadline,
  gateSatisfied,
  gateProgress,
  gatePending,
  requirementComplete,
  GATE_ACTIVE_IN,
} from './objects.js'

/* ---- machine.js ---- */
export {
  transitionTask,
  transitionRequirement,
  availableActions,
  gateLine,
  TASK_ALLOWED,
  REQ_ALLOWED,
} from './machine.js'

/* ---- lease.js ---- */
export {
  DEFAULT_LEASE_POLICY,
  leaseIdOf,
  openLease,
  renewLease,
  releaseLease,
  leaseVerdict,
  describeSpan,
} from './lease.js'

/* ---- scheduler.js ---- */
export {
  scanDue,
  dueAction,
  upcoming,
  remainingMs,
  DEFAULT_ON_TIMEOUT,
  AUTO_RELEASE_GATES,
} from './scheduler.js'

/* ---- history.js ---- */
export { historyEntry } from './history.js'

/* ------------------------------------------------------------------ *
 * 类型别名（仅给 JSDoc / 编辑器用，不是运行期导出）
 * ------------------------------------------------------------------ */

/**
 * @typedef {import('./types.js').Principal} Principal
 * @typedef {import('./types.js').Issue} Issue
 * @typedef {import('./types.js').DomainKey} DomainKey
 * @typedef {import('./types.js').BotRole} BotRole
 * @typedef {import('./types.js').GateKind} GateKind
 * @typedef {import('./types.js').DurationString} DurationString
 * @typedef {import('./schema.js').Requirement} Requirement
 * @typedef {import('./schema.js').Task} Task
 * @typedef {import('./schema.js').Gate} Gate
 * @typedef {import('./schema.js').Lease} Lease
 * @typedef {import('./schema.js').Decision} Decision
 * @typedef {import('./schema.js').Conflict} Conflict
 * @typedef {import('./schema.js').InboundMessage} InboundMessage
 * @typedef {import('./schema.js').CallbackRecord} CallbackRecord
 * @typedef {import('./schema.js').HistoryEntry} HistoryEntry
 * @typedef {import('./schema.js').Evidence} Evidence
 * @typedef {import('./machine.js').TaskAction} TaskAction
 * @typedef {import('./machine.js').RequirementAction} RequirementAction
 * @typedef {import('./machine.js').TransitionContext} TransitionContext
 * @typedef {import('./machine.js').TransitionOk} TransitionOk
 * @typedef {import('./machine.js').TransitionErr} TransitionErr
 * @typedef {import('./machine.js').TransitionResult} TransitionResult
 * @typedef {import('./lease.js').LeasePolicy} LeasePolicy
 * @typedef {import('./lease.js').LeaseVerdict} LeaseVerdict
 * @typedef {import('./lease.js').RenewResult} RenewResult
 * @typedef {import('./lease.js').ReleaseResult} ReleaseResult
 * @typedef {import('./scheduler.js').DueGate} DueGate
 * @typedef {import('./scheduler.js').DueLease} DueLease
 * @typedef {import('./scheduler.js').ScanInput} ScanInput
 * @typedef {import('./scheduler.js').ScanResult} ScanResult
 */
