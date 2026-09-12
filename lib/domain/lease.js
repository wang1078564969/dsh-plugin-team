/*
 * 来源：hub/src/domain/lease.ts（190 行）
 *
 * 租约的创建、续约与判定。
 *
 * 设计文档：team-agent-architecture/06-objects-and-state-machines.md §5
 *
 * 一句话说清租约要解决什么：**“确认接受”代表这活归我了，那它就该有个期限。**
 * 没有期限的话，任务会安静地烂在一个已经忘了它的人手里——而“安静地烂掉”
 * 是团队协作里最难发现的一类故障。
 *
 * 三档时限，别混：
 *   - **门禁超时**（`accept` / `start`）：多久没点按钮
 *   - **租约**（本文件）：接了活之后多久该交付
 *   - **宽限期**：租约过期后给需求负责人多久决定收回还是续约
 *
 * 释放去向**因原因而异**（这是最容易写错的地方）：
 *   - `accept` 门禁超时 → 只催办升级，**租约还没起，不动**
 *   - `start` 门禁超时 → 任务回 `assigned`，租约作废
 *   - 执行中租约过期 → 任务**保持 `in_progress`**，只播报；宽限期满才收回
 *
 * 改了什么：
 *   - TS 类型（LeasePolicy / RenewResult / ReleaseResult / LeaseVerdict）
 *     → JSDoc @typedef。函数签名、参数顺序、返回结构一个都没动
 *     （`renewLease(lease, by, policy, now, opts = {})`、
 *      `releaseLease(lease, reason, opts = {})` 的可选参数照旧）。
 *   - `DEFAULT_LEASE_POLICY` 用 Object.freeze 冻结：它是默认值来源，
 *     被就地改掉会让“配置没写”和“配置写了”变得无法区分。
 *
 * 没能保住的语义：
 *   - `reason` 的联合类型没了：`releaseLease(lease, reason)` 现在接受任意字符串。
 *     运行期判定仍只看 `reason === 'expired'`（决定 state 是 expired 还是 released），
 *     其余原因照原样写进 release_reason，与 hub 相同。
 *   - `RenewResult.ok` 在 hub 里是用 `ok: boolean` 表达的判别式联合
 *     （ok 为 true 时 lease 必在）。JS 侧只保留了同样的形状：失败时给 `reason`，
 *     调用方仍需自己判 `ok`。这不是遗漏，是无法用运行时表达的类型承诺。
 */

/**
 * 租约策略。
 *
 * @typedef {Object} LeasePolicy
 * @property {number} lease_days 人接受后的预计完成时限（天）
 * @property {number} lease_grace_days 过期到收回之间的宽限期（天）
 * @property {number} bot_lease_hours 机器人租约的心跳周期（小时）
 */

/** 默认租约策略（workflow.yaml 的 gates.defaults 缺省时用它） */
export const DEFAULT_LEASE_POLICY = Object.freeze({
  lease_days: 2,
  lease_grace_days: 1,
  bot_lease_hours: 1,
})

const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * 租约的身份就是 task_id：一个任务同时只能有一个有效租约。
 *
 * @param {string} taskId
 * @returns {string}
 */
export function leaseIdOf(taskId) {
  return taskId
}

/**
 * 起租。
 *
 * 在**接受**那一刻起租，而不是开始那一刻——因为“接受了却不动手”
 * 恰恰是最需要被盯住的状态（设计文档 02 §5.3）。
 *
 * @param {import('./schema.js').Task} task
 * @param {import('./types.js').Principal} holder
 * @param {LeasePolicy} policy
 * @param {Date} now
 * @returns {import('./schema.js').Lease}
 */
export function openLease(task, holder, policy, now) {
  const bot = !holder.startsWith('human:')
  const span = bot ? policy.bot_lease_hours * HOUR : policy.lease_days * DAY
  return {
    task: task.id,
    holder,
    kind: bot ? 'bot' : 'human',
    started_at: now.toISOString(),
    expires_at: new Date(now.getTime() + span).toISOString(),
    renewals: 0,
    state: 'active',
    release_reason: null,
    expiry_notices: 0,
  }
}

/**
 * @typedef {Object} RenewResult
 * @property {boolean} ok
 * @property {import('./schema.js').Lease} [lease]
 * @property {string} [reason]
 */

/**
 * 续约。只有持有人本人、需求负责人或项目经理可以续
 * （后者靠调用方传 `opts.allowAnyone`——本函数不知道谁有治理权限）。
 *
 * 续约不是“点一下就永远续下去”——每次都推一个完整的时限，
 * 所以它同时也是一个**重新承诺**的动作。
 *
 * @param {import('./schema.js').Lease} lease
 * @param {import('./types.js').Principal} by
 * @param {LeasePolicy} policy
 * @param {Date} now
 * @param {{allowAnyone?: boolean}} [opts]
 * @returns {RenewResult}
 */
export function renewLease(lease, by, policy, now, opts = {}) {
  if (lease.state !== 'active' && lease.state !== 'expired') {
    return { ok: false, reason: `租约当前是 ${lease.state}，不能续约` }
  }
  if (!opts.allowAnyone && lease.holder !== by) {
    return { ok: false, reason: '只有任务持有人本人（或需求负责人）可以续约' }
  }
  const span = lease.kind === 'bot' ? policy.bot_lease_hours * HOUR : policy.lease_days * DAY
  return {
    ok: true,
    lease: {
      ...lease,
      state: 'active',
      renewals: lease.renewals + 1,
      expires_at: new Date(now.getTime() + span).toISOString(),
      release_reason: null,
      expiry_notices: 0,
    },
  }
}

/**
 * @typedef {Object} ReleaseResult
 * @property {import('./schema.js').Lease} lease
 * @property {'none'|'back_to_assigned'} taskEffect 这次释放要不要动任务状态，以及为什么
 */

/**
 * 释放租约（交回、转派、废弃、开始超时都走这里）。
 *
 * `taskEffect` 只是**声明**，本函数不动任务——状态机的动作才是执行者。
 *
 * @param {import('./schema.js').Lease} lease
 * @param {'start_timeout'|'accept_timeout'|'expired'|'returned'|'reassigned'|'dropped'} reason
 * @param {{taskEffect?: 'none'|'back_to_assigned'}} [opts]
 * @returns {ReleaseResult}
 */
export function releaseLease(lease, reason, opts = {}) {
  return {
    lease: { ...lease, state: reason === 'expired' ? 'expired' : 'released', release_reason: reason },
    taskEffect: opts.taskEffect ?? 'none',
  }
}

/* ------------------------------------------------------------------ *
 * 到期判定
 * ------------------------------------------------------------------ */

/**
 * @typedef {{kind: 'ok'}
 *   | {kind: 'notify', overdueMs: number, notices: number}
 *   | {kind: 'reclaim', overdueMs: number}} LeaseVerdict
 */

/**
 * 判定一个租约现在的处境。
 *
 * 刻意分成三档而不是布尔值：**“过期”和“该收回”是两件事**。
 * 一过期就收回的话，人周末没看消息，周一回来任务没了；
 * 而一直不收回，任务就永远卡在一个不干活的人手里。
 *
 * @param {import('./schema.js').Lease} lease
 * @param {LeasePolicy} policy
 * @param {Date} now
 * @returns {LeaseVerdict}
 */
export function leaseVerdict(lease, policy, now) {
  // `expired` 是“已播报、等宽限期”的中间态，还要继续参与判定；
  // 只把 released / returned 这类终态排除掉
  if (lease.state !== 'active' && lease.state !== 'expired') return { kind: 'ok' }
  const expires = Date.parse(lease.expires_at)
  if (Number.isNaN(expires)) return { kind: 'ok' }
  const overdueMs = now.getTime() - expires
  if (overdueMs <= 0) return { kind: 'ok' }

  /**
   * **第一次发现过期，无论已经过了多久，都先播报。**
   *
   * 这条是被测试逼出来的：如果 tick 恰好一次跨过整个宽限期
   * （比如服务停了三天才重启），“已过期”和“宽限期已满”会同时成立，
   * 于是直接收回——**人根本没收到过任何通知，任务就没了**。
   *
   * 收回必须是“通知过、并且给了人反应时间”之后的事，而不是时间算术的副产品。
   * 所以顺序反过来：先播报，下一次 tick 才可能收回。
   */
  if (lease.expiry_notices === 0) {
    return { kind: 'notify', overdueMs, notices: 0 }
  }

  /**
   * 播报过一次之后就**沉默等待**，直到宽限期结束。
   *
   * 不能在宽限期内每次 tick 都喊一遍——那正是“机器人刷屏”的另一种形态。
   * 也不能一过期就收回：人可能只是周末没看消息。
   * 所以合理的节奏是：**先说一次，然后在期限到来时动手**。
   */
  const graceMs = policy.lease_grace_days * DAY
  if (overdueMs >= graceMs) {
    return { kind: 'reclaim', overdueMs }
  }
  return { kind: 'ok' }
}

/**
 * 人看的时长描述，写进卡片。
 *
 * @param {number} ms
 * @returns {string}
 */
export function describeSpan(ms) {
  if (ms < 0) return '已过期'
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}`
  const minutes = Math.floor((ms % HOUR) / 60_000)
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ''}`
  return `${Math.max(1, minutes)} 分钟`
}
