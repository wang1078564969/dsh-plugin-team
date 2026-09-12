/*
 * 来源：hub/src/domain/history.ts（28 行）
 *
 * 状态跃迁历史。每个跃迁都写一条，用来回答“谁在什么时候把它推到这一步”——
 * 这是设计文档 06 §1 通则 3 的落地。
 *
 * 改了什么：
 *   - history.ts **只有类型、没有运行期代码**（HistoryEntryInput / HistoryEntry
 *     两个 interface，外加 `export type { GateName }` 的重导出）。TS 的
 *     interface 在 JS 里不存在，所以这里：
 *       · 用 JSDoc @typedef 保留字段形状（含“effects 必须落进历史”的说明）；
 *       · 把 machine.js 里那段“构造一条历史”的代码搬成一个真正的运行期函数
 *         `historyEntry()`——它不是新语义，而是原来内联在 `withHistory` /
 *         `ok()` 里的三行（detail 为 undefined 时不写这个键）。
 *   - `GateName` 的重导出改为从 schema.js 导出 `GATE_NAMES`（取值表）。
 *
 * 没保住的语义：
 *   - **类型别名 `HistoryEntryInput` / `HistoryEntry` 本身没了**。
 *     校验由 schema.js 的 `parseHistoryEntry()` 承担（对象落盘/读回时走它，
 *     与 hub 一致：hub 也只在整对象过 schema 时校验历史条目，跃迁当场不校验）。
 *   - 因此 `historyEntry()` **故意不做校验**：hub 的跃迁路径同样不校验，
 *     在这里加校验会让“传了个裸 id 的 actor”从静默记录变成抛错——那是行为变化，
 *     不是移植。
 */

/**
 * @typedef {import('./schema.js').HistoryEntry} HistoryEntry
 */

/**
 * 构造一条历史条目。
 *
 * 字段顺序与 hub 的 `withHistory` 内联构造逐字一致：
 * `{ from, to, by, at, effects }`，`detail` 只在**显式给出**时才写入键。
 * （hub 的写法是 `if (detail !== undefined) entry.detail = detail`；
 * 这一点有测试盯着：`assert.deepEqual(last.detail, { reassignNeeded: true })`。）
 *
 * @param {Object} input
 * @param {string|null} input.from 跃迁前的状态（首次写入用 null）
 * @param {string} input.to 跃迁后的状态
 * @param {import('./types.js').Principal} input.by 谁触发的
 * @param {string} input.at ISO datetime
 * @param {string[]} input.effects 这次跃迁声明要做的副作用；**必须落进历史**，
 *   否则重启之后回头看只知道状态变了、不知道当时承诺过要做什么
 * @param {string} [input.reason]
 * @param {Record<string, unknown>} [input.detail]
 * @returns {HistoryEntry}
 */
export function historyEntry(input) {
  /** @type {HistoryEntry} */
  const entry = {
    from: input.from,
    to: input.to,
    by: input.by,
    at: input.at,
    effects: input.effects,
  }
  if (input.reason !== undefined) entry.reason = input.reason
  if (input.detail !== undefined) entry.detail = input.detail
  return entry
}
