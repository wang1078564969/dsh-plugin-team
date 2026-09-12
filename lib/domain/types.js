/*
 * 来源：hub/src/types.ts（78 行）
 *
 * 改了什么：
 *   - TypeScript 的类型声明（Principal / DomainKey / BotRole / GateKind /
 *     DurationString / Issue）改写成 JSDoc @typedef；运行期只留下 5 个函数。
 *   - 5 个函数的实现逐字照搬：asPrincipal / asPrincipalOrNull / isHuman /
 *     isBot / formatDuration。
 *
 * 没能保住的语义（显式列出，不静默丢弃）：
 *   1. **类型层面的约束没了**。`Principal` 原来是模板字面量联合
 *      （`human:${string}` | `bot:${string}` | `role:${string}` | 'system'），
 *      'chen-req' 这种裸 id 会被 tsc 直接拦下；JSDoc 里只能写成
 *      “形如 human:xxx / bot:xxx / role:xxx 或 system 的字符串”。
 *      运行期的替代是 asPrincipal() 与 schema.js 的 asPrincipal 校验——
 *      凡是穿过 createRequirement / createTask / parseXxx 的数据仍然会被拦。
 *   2. `Principal` 的 'system' 分支在 JSDoc 里没有类型级区分，
 *      但 isHuman / isBot 的行为与 hub 完全一致（'system' 两者皆假）。
 */

/**
 * @typedef {string} Principal 主体：`human:xxx` | `bot:xxx` | `role:xxx` | `system`。
 *   少一个类型就少一类“传了个裸 id”的 bug，所以 JSDoc 里也请当成不透明字符串用，
 *   不要在这里拼字符串。
 */

/** @typedef {string} DomainKey 角色域标识。内置若干，但**不是封闭集合**——团队可在 workflow.yaml 里增删。 */

/** @typedef {'req'|'dev'|'qa'|'coord'|'lib'|'ops'|'custom'} BotRole 机器人角色（专项机器人用 custom） */

/** @typedef {'confirm_split'|'accept'|'start'|'review'|'acceptance'} GateKind 门禁名：前 5 个是流程门禁，approval 是配置台审批卡的有效期。 */

/** @typedef {string} DurationString 时长字符串：48h / 30m / 2d / 90d */

/**
 * 一个能定位到具体位置的问题。校验器只产出这个，不抛异常。
 *
 * @typedef {Object} Issue
 * @property {'error'|'warning'|'info'} level 错误阻断加载/发布；警告可继续但需确认；提示仅建议
 * @property {string} path 出问题的配置位置，例如 workflow.yaml:domains.pm.owner
 * @property {string} message
 * @property {string} [hint]
 */

/**
 * 从配置里读出来的字符串转主体（配置已由校验层正则校验过前缀）。
 *
 * @param {string} value
 * @returns {Principal}
 */
export function asPrincipal(value) {
  if (value === 'system') return 'system'
  if (/^(human|bot|role):.+$/.test(value)) return value
  throw new Error(`不是合法主体: ${value}`)
}

/**
 * @param {string|null|undefined} value
 * @returns {Principal|null}
 */
export function asPrincipalOrNull(value) {
  return value === null || value === undefined ? null : asPrincipal(value)
}

/**
 * @param {Principal} p
 * @returns {boolean}
 */
export function isHuman(p) {
  return p.startsWith('human:')
}

/**
 * 注意：`role:` 也算“机器人侧”——角色是内置机器人（req/dev/qa/coord/lib/ops）的别名。
 *
 * @param {Principal} p
 * @returns {boolean}
 */
export function isBot(p) {
  return p.startsWith('bot:') || p.startsWith('role:')
}

/**
 * 毫秒 → 人类可读时长。整日/整时/整分才降级，否则给秒。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}
