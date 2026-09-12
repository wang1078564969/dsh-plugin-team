/*
 * 来源：hub/src/domain/scheduler.ts（128 行）
 *
 * 时间驱动：门禁超时与租约过期的扫描器。
 *
 * 设计文档：team-agent-architecture/02-bots-and-requirements.md §5.3
 *           team-agent-architecture/06-objects-and-state-machines.md §5
 *
 * 关键点：**策略用的是对象里的快照，不是当前配置**。
 * 所以 `due_at`、`on_timeout`、`max_release` 都在建任务时冻结（见 schema.js 的
 * gateSchema）。改配置只影响新任务——这是“改配置不误伤进行中的任务”的落地。
 *
 * 改了什么：
 *   - TS 接口（DueGate / DueLease / ScanInput / ScanResult）→ JSDoc @typedef。
 *     参数与返回结构逐字保持：`scanDue({now, tasks, leases})` → `{gates, leases}`。
 *   - 其余是逐行翻译，包括两处**刻意保留的细节**：
 *       · 已经满足的门禁不再计时（`satisfied()` 只看 required_by，不看
 *         not_applicable——not_applicable 的在那之前就被 continue 掉了）
 *       · 租约扫描收 `active` **和** `expired`：漏掉 expired，宽限期满的第二步
 *         永远不会触发（这个 bug 在 hub 里是被测试抓出来的）
 *
 * 没能保住的语义：
 *   - `ScanInput.leases` 在 TS 里是 `Iterable<{task, expires_at, state}>`；
 *     JS 侧照旧用 `for...of`，所以数组 / Set / 生成器都能传。
 *   - `DueGate.on_timeout` 的类型是“门禁快照里的那个枚举或 null”，
 *     运行期不校验（与 hub 相同：值来自已校验过的对象）。
 */

/**
 * 一个到期的门禁。带上 task 本身，调用方不用再查一次存储。
 *
 * @typedef {Object} DueGate
 * @property {import('./schema.js').Task} task
 * @property {'confirm_split'|'accept'|'start'|'acceptance'} gate
 * @property {string} due_at
 * @property {'remind_then_escalate'|'auto_release'|'escalate_to_owner'|'notify_submitter'|null} on_timeout
 * @property {number|null} max_release
 */

/**
 * 一个到期的租约。
 *
 * @typedef {Object} DueLease
 * @property {string} task_id
 * @property {string} lease_id
 * @property {string} expires_at
 */

/**
 * @typedef {Object} ScanInput
 * @property {Date} now
 * @property {import('./schema.js').Task[]} tasks
 * @property {Iterable<{task: string, expires_at: string, state: string}>} leases 租约按 task_id 索引
 */

/**
 * @typedef {Object} ScanResult
 * @property {DueGate[]} gates
 * @property {DueLease[]} leases
 */

/**
 * 门禁是否已经满足（只看 required_by 与 confirmed_by 的交集）。
 *
 * @param {import('./schema.js').Gate} gate
 * @returns {boolean}
 */
function satisfied(gate) {
  const done = new Set(gate.confirmed_by.map((c) => c.by))
  return gate.required_by.every((p) => done.has(p))
}

/**
 * 扫描所有到期项。
 *
 * 刻意做成纯函数：不碰存储、不发消息，只回答“现在有哪些事到期了”。
 * 这样它可以在测试里被穷举，也能被运维面板直接调用做“将来 24 小时会发生什么”。
 *
 * 返回的两组都已按时间升序排好（`localeCompare`，ISO 字符串）
 * ——**没有截断，也没有去重**：调用方看到的就是全部。
 *
 * @param {ScanInput} input
 * @returns {ScanResult}
 */
export function scanDue(input) {
  const nowMs = input.now.getTime()
  /** @type {DueGate[]} */
  const gates = []

  for (const task of input.tasks) {
    for (const [name, gate] of Object.entries(task.gates)) {
      if (gate === undefined) continue
      if (gate.not_applicable) continue
      if (gate.due_at === null) continue
      // 已经满足的门禁不再计时（人已经确认了，超时就不该发生）
      if (satisfied(gate)) continue
      if (Date.parse(gate.due_at) > nowMs) continue
      gates.push({
        task,
        gate: /** @type {'confirm_split'|'accept'|'start'|'acceptance'} */ (name),
        due_at: gate.due_at,
        on_timeout: gate.on_timeout,
        max_release: gate.max_release,
      })
    }
  }

  /** @type {DueLease[]} */
  const leases = []
  for (const lease of input.leases) {
    /**
     * **`expired` 也要继续收**。
     *
     * 租约过期分两步：先播报“等确认”（此时标成 `expired`），
     * 宽限期满才收回任务。如果这里只收 `active`，第二步就永远不会触发——
     * 任务会卡在一个不干活的人手里，而且看起来一切正常。这个 bug 是被测试抓出来的。
     */
    if (lease.state !== 'active' && lease.state !== 'expired') continue
    if (Date.parse(lease.expires_at) > nowMs) continue
    leases.push({ task_id: lease.task, lease_id: lease.task, expires_at: lease.expires_at })
  }

  gates.sort((a, b) => a.due_at.localeCompare(b.due_at))
  leases.sort((a, b) => a.expires_at.localeCompare(b.expires_at))
  return { gates, leases }
}

/**
 * 门禁到期后应该触发哪个状态机动作。
 *
 * **策略决定动不动状态，而不是门禁名。**
 *
 * 第一版只看门禁名：`start` 一律释放、`accept` 一律升级。后果是
 * `start.on_timeout = 'escalate_to_owner'`（"别自动放掉我的任务"）**照着释放**，
 * 而 `accept.on_timeout = 'auto_release'` 什么都不做 —— 一个显示在配置台上、
 * 写进快照、却和实际行为无关的旋钮，比没有这个旋钮更坏：人会以为自己改了行为。
 *
 * 现在的规则：
 *   · `auto_release` → 释放（只有 `start` 门禁有这条机器动作，`timeout_start`；
 *     别的门禁上配它由配置校验直接拒绝，而不是静默忽略）
 *   · `remind_then_escalate` / `escalate_to_owner` / `notify_submitter` → 只通知
 *     （`accept` 保持"升级不动状态"的机器语义，`timeout_accept` 就是 escalate）
 *   · 快照里没写策略 → 用该门禁的默认策略（与 `defaultGateSpecs()` 一致）
 *
 * @param {DueGate} due
 * @returns {'timeout_start'|'timeout_accept'|null}
 */
export function dueAction(due) {
  const gate = due === null || due === undefined ? undefined : due.gate
  const snapshot = due === null || due === undefined || typeof due.on_timeout !== 'string' ? '' : due.on_timeout
  const policy = snapshot !== '' ? snapshot : DEFAULT_ON_TIMEOUT[gate] ?? null
  if (gate === 'start') {
    // 释放是**状态变更**，只有策略明确要求时才做。
    return policy === 'auto_release' ? 'timeout_start' : null
  }
  if (gate === 'accept') {
    // 接受超时永远不释放（释放会让人莫名丢任务）；机器里的 timeout_accept 就是"升级"。
    return 'timeout_accept'
  }
  return null
}

/** 每个门禁的默认超时策略（与 `lib/config.js` 的 `defaultGateSpecs()` 一致）。 */
export const DEFAULT_ON_TIMEOUT = Object.freeze({
  confirm_split: 'remind_then_escalate',
  accept: 'remind_then_escalate',
  start: 'auto_release',
  acceptance: 'escalate_to_owner',
})

/** `auto_release` 只在 `start` 门禁上有对应的机器动作（配置校验用它拒绝别的组合）。 */
export const AUTO_RELEASE_GATES = Object.freeze(['start'])

/**
 * 运维视图：将来 24 小时内会到期的门禁（“接下来会发生什么”）。
 *
 * 已经超时的不在里面（`at <= now` 被排除）——那属于 `scanDue` 的“现在就到期”。
 *
 * @param {import('./schema.js').Task[]} tasks
 * @param {Date} now
 * @param {number} [withinMs]
 * @returns {DueGate[]}
 */
export function upcoming(tasks, now, withinMs = 86_400_000) {
  const until = now.getTime() + withinMs
  /** @type {DueGate[]} */
  const out = []
  for (const task of tasks) {
    for (const [name, gate] of Object.entries(task.gates)) {
      if (gate === undefined || gate.not_applicable || gate.due_at === null) continue
      if (satisfied(gate)) continue
      const at = Date.parse(gate.due_at)
      if (at <= now.getTime() || at > until) continue
      out.push({
        task,
        gate: /** @type {'confirm_split'|'accept'|'start'|'acceptance'} */ (name),
        due_at: gate.due_at,
        on_timeout: gate.on_timeout,
        max_release: gate.max_release,
      })
    }
  }
  return out.sort((a, b) => a.due_at.localeCompare(b.due_at))
}

/**
 * 测试与日报用：门禁当前还剩多久（负数表示已超时）。
 *
 * @param {string} due_at
 * @param {Date} now
 * @returns {number}
 */
export function remainingMs(due_at, now) {
  return Date.parse(due_at) - now.getTime()
}
