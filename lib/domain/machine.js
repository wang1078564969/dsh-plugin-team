/*
 * 来源：hub/src/domain/machine.ts（600 行）
 *
 * 状态机：**全部跃迁规则集中在这里，纯函数、无副作用**。
 *
 * 设计文档：team-agent-architecture/06-objects-and-state-machines.md §3.1 / §4.1
 *           team-agent-architecture/02-bots-and-requirements.md §5.2–5.6
 *
 * 为什么必须是纯函数：
 * - 卡片按钮、配置台、机器人、定时器都走同一个入口，规则不会各处一套
 * - 可穷举测试每一条跃迁（合法 + 非法）
 * - 将来做“重放历史”时不需要真跑一遍副作用
 *
 * 改了什么：
 *   - TS 类型（TaskAction / RequirementAction / TransitionContext /
 *     TransitionOk / TransitionErr / TransitionResult）→ JSDoc @typedef。
 *     返回结构与参数顺序**一个都没动**：
 *     成功 `{ok:true, next, history, effects}`，失败 `{ok:false, code, message, pending?}`。
 *   - `satisfyGate` 里“构造一条历史”的内联代码改为走 history.js 的
 *     `historyEntry()`（同样的键、同样的“detail 为 undefined 就不写这个键”）。
 *   - `TASK_ALLOWED` / `REQ_ALLOWED` 从模块私有改为导出（并冻结），
 *     卡片渲染与测试要能直接查这两张表。
 *
 * 没能保住的语义（显式列出，均为“非法输入”而非业务规则）：
 *   1. **未知动作**：TS 的 switch 是穷尽的，`TASK_ALLOWED[action]` 对表外动作
 *      会返回 undefined，hub 运行期会在 `undefined.includes` 上抛 TypeError。
 *      这里改成走 `default` 分支返回 `{ok:false, code:'unknown', message:'未实现的动作 X'}`——
 *      正是 hub 源码里那个（TS 下不可达的）`default` 分支的语义。
 *   2. **`ctx.now` 必须是 Date**：hub 由类型系统保证；这里缺了会抛一句
 *      TypeError（中文说明），而不是拖到 `ctx.now.toISOString()` 才炸。
 *      对合法调用完全无影响。
 *   3. `TransitionErr['code']` 的联合类型没了：任何字符串都能传进去，
 *      只能靠约定（错误码就是上面 9 个）。运行期行为与 hub 相同。
 *   4. 下列业务硬闸**逐条保留**，并各有测试盯着：
 *      · `self_review`（执行者不能验收自己的产出，先于验收人判定）
 *      · `evidence_required`（submit / verify 没有 evidence 直接拒）
 *      · `gate_incomplete`（required_by 还没全确认）
 *      · 机器人执行者：accept/start 门禁 `not_applicable`，**验收门禁仍生效**
 *      · `timeout_accept` / `lease_expired` 只 escalate，绝不自动释放
 *      · `timeout_start` 释放并 `release_count+1`，达上限（优先门禁快照，
 *        其次 ctx.maxRelease，默认 2）返回 `escalate`
 *      · `timeout_lease` 收回为 assigned 且 `release_count+1`
 *      · 状态跃迁必须**激活下一个门禁**并把确认写回对象（`gates.*.confirmed_by`）
 */

import { historyEntry } from './history.js'
import { activateDue, gatePending, gateSatisfied } from './objects.js'

/* ------------------------------------------------------------------ *
 * 动作 —— 用下划线而非点号，避免与配置里的门禁名对不上
 * ------------------------------------------------------------------ */

/**
 * @typedef {'confirm_split'|'assign'|'accept'|'reject'|'start'|'unassign'|'reassign'|'block'|'unblock'|'ci_start'|'ci_pass'|'ci_fail'|'submit'|'verify'|'reject_review'|'suspend'|'resume'|'drop'|'archive'|'timeout_start'|'timeout_accept'|'lease_expired'|'timeout_lease'} TaskAction
 */

/**
 * @typedef {'confirm'|'confirm_split'|'change'|'reconfirm'|'block'|'unblock'|'suspend'|'resume'|'drop'|'archive'} RequirementAction
 */

/**
 * @typedef {'invalid_state'|'forbidden'|'gate_incomplete'|'no_assignee'|'evidence_required'|'not_assigned_to_you'|'self_review'|'escalate'|'unknown'} TransitionCode
 */

/**
 * 跃迁上下文。除了 `now` 全部可选——`requirement` 缺省时“需求负责人”判定恒假。
 *
 * @typedef {Object} TransitionContext
 * @property {import('./schema.js').Requirement} [requirement] 需求（判断权限与回落时用）
 * @property {import('./types.js').Principal[]} [domainOwners] 该任务涉及的域，谁算“域负责人”
 * @property {import('./types.js').Principal[]} [acceptors] 谁有资格验收（已排除执行者本人）
 * @property {import('./types.js').Principal[]} [pmOwners] pm 域的负责人（治理类动作的判定依据，来自配置而非硬编码）
 * @property {number} [maxRelease] 门禁配置里 start 的 max_release（门禁快照缺省时的回退）
 * @property {Date} now 动作时间
 * @property {import('./types.js').Principal|null} [suggestedAssignee] 机器人建议的承接者（仅用于 error detail，不改变权限判定）
 */

/**
 * @template T
 * @typedef {Object} TransitionOk
 * @property {true} ok
 * @property {T} next 跃迁后的对象（**历史已经写进 next.history**）
 * @property {import('./schema.js').HistoryEntry} history 这次写进历史的那一条
 * @property {string[]} effects 这次跃迁声明要做的副作用
 */

/**
 * @typedef {Object} TransitionErr
 * @property {false} ok
 * @property {TransitionCode} code
 * @property {string} message
 * @property {import('./types.js').Principal[]} [pending] 还差谁确认——卡片与催办直接用这个
 */

/**
 * @template T
 * @typedef {TransitionOk<T>|TransitionErr} TransitionResult
 */

/**
 * @param {TransitionCode} code
 * @param {string} message
 * @param {import('./types.js').Principal[]} [pending]
 * @returns {TransitionErr}
 */
function err(code, message, pending) {
  return pending === undefined ? { ok: false, code, message } : { ok: false, code, message, pending }
}

/**
 * 取 `ctx.now` 的 ISO 字符串。
 *
 * hub 由类型系统保证 now 是 Date；JS 侧在这里显式拦一下，
 * 否则参数拼错要等到 `undefined.toISOString` 才报错。
 *
 * @param {TransitionContext} ctx
 * @returns {string}
 */
function nowIso(ctx) {
  if (!(ctx !== null && typeof ctx === 'object' && ctx.now instanceof Date)) {
    throw new TypeError('状态机需要 ctx.now 是一个 Date（原 TS 版本由类型系统保证）')
  }
  return ctx.now.toISOString()
}

/* ------------------------------------------------------------------ *
 * 权限判定
 * ------------------------------------------------------------------ */

function isReqOwner(ctx, actor) {
  return ctx.requirement?.owner === actor
}

function isPM(ctx, actor) {
  return (ctx.pmOwners ?? []).includes(actor)
}

function isDomainOwner(ctx, actor) {
  return (ctx.domainOwners ?? []).includes(actor)
}

function isAcceptor(ctx, actor) {
  return (ctx.acceptors ?? []).includes(actor)
}

function isAssignee(task, actor) {
  return task.assignee !== null && task.assignee === actor
}

/** 需求负责人或项目经理——治理类动作的门槛 */
function canGovern(ctx, actor) {
  return isReqOwner(ctx, actor) || isPM(ctx, actor)
}

/* ------------------------------------------------------------------ *
 * Task 状态机
 * ------------------------------------------------------------------ */

/**
 * 每个动作允许的**当前状态**。这是状态机唯一的“形状”来源，
 * `availableActions()` 也读它（所以卡片按钮不会和规则走偏）。
 *
 * @type {Readonly<Record<TaskAction, readonly string[]>>}
 */
export const TASK_ALLOWED = Object.freeze({
  confirm_split: Object.freeze(['proposed']),
  /*
   * `rejected` 也允许指派：设计 02 §5.3 明说"拒绝后回到待派发、换人重派，不允许悬空"。
   * 只给 `confirmed` 会让拒绝变成**死状态**（`availableActions` 为空，任务永久卡住），
   * 而这恰恰是多机器人团队最常见的动作：机器人不接、或者人被指错了活。
   */
  assign: Object.freeze(['confirmed', 'rejected']),
  accept: Object.freeze(['assigned']),
  reject: Object.freeze(['assigned']),
  start: Object.freeze(['accepted']),
  unassign: Object.freeze(['accepted']),
  reassign: Object.freeze(['accepted']),
  block: Object.freeze(['in_progress', 'ci_running', 'in_review']),
  unblock: Object.freeze(['blocked']),
  ci_start: Object.freeze(['in_progress']),
  ci_pass: Object.freeze(['ci_running']),
  ci_fail: Object.freeze(['ci_running']),
  submit: Object.freeze(['in_progress', 'ci_running', 'blocked']),
  verify: Object.freeze(['in_review']),
  /**
   * 验收打回：`in_review → in_progress`（设计 06 §4.1 表末行）。
   *
   * 卡片上一直有这个按钮（`lib/feishu/broadcast.js` 的 `task.reject_review`），
   * 但状态机里没有这个动作 —— 于是按下去只会得到"未实现的动作"，一条设计里写明的
   * 回路在实现里是断的。
   */
  reject_review: Object.freeze(['in_review']),
  suspend: Object.freeze([
    'proposed',
    'confirmed',
    'assigned',
    'accepted',
    'in_progress',
    'ci_running',
    'blocked',
    'in_review',
  ]),
  resume: Object.freeze(['suspended', 'blocked']),
  drop: Object.freeze([
    'proposed',
    'confirmed',
    'assigned',
    'accepted',
    'in_progress',
    'ci_running',
    'blocked',
    'in_review',
    'suspended',
  ]),
  archive: Object.freeze(['done']),
  timeout_start: Object.freeze(['accepted']),
  timeout_accept: Object.freeze(['assigned']),
  lease_expired: Object.freeze(['in_progress', 'accepted']),
  timeout_lease: Object.freeze(['in_progress']),
})

/**
 * 任务状态跃迁。
 *
 * 判定顺序（照 hub 的注释，别改）：状态守卫 → 身份守卫 → 门禁。
 *
 * @param {import('./schema.js').Task} task
 * @param {TaskAction} action
 * @param {import('./types.js').Principal} actor
 * @param {TransitionContext} ctx
 * @returns {TransitionResult<import('./schema.js').Task>}
 */
export function transitionTask(task, action, actor, ctx) {
  const allowed = TASK_ALLOWED[action]
  if (allowed === undefined) {
    // TS 下不可达（switch 穷尽）；JS 下这是“动作名拼错”的唯一出口
    return err('unknown', `未实现的动作 ${String(action)}`)
  }
  if (!allowed.includes(task.state)) {
    return err('invalid_state', `任务当前是 ${task.state}，不能执行 ${action}`)
  }

  const at = nowIso(ctx)
  const base = { ...task }
  /**
   * @param {import('./schema.js').Task} next
   * @param {string[]} effects
   * @param {Record<string, unknown>} [detail]
   * @param {string} [reason] 人给的理由（验收打回之类），与"这次跃迁承诺做什么"分开记：
   *   `effects` 是系统要做的事，`reason` 是**人为什么这么决定** —— 事后追责时后者才是答案。
   * @returns {TransitionOk<import('./schema.js').Task>}
   */
  const withHistory = (next, effects, detail, reason) => {
    const entry = historyEntry({
      from: task.state,
      to: next.state,
      by: actor,
      at,
      effects,
      ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
      detail,
    })
    // 历史必须真的写回对象。只返回 history 而不落进 next.history，
    // 会让“谁在什么时候推到这一步”永远查不到——这是设计文档 06 §1 通则 3 的硬要求。
    return {
      ok: true,
      next: { ...next, history: [...next.history, entry] },
      history: entry,
      effects,
    }
  }

  /**
   * 指派/转派共用的门禁重算：**确认人跟着新执行者走**。
   *
   * 为什么两处必须共用一份：`assign` 与 `reassign` 各写一遍的结果是——
   * `reassign` 只换了 `assignee`，门禁整份留着**旧执行者**的确认人与确认记录。
   * 而它自己的效果文案写着"新执行者仍需点接受"：文案与行为对不上，
   * 新来的人点接受时面对的是别人名下的门禁。
   *
   * 规则（设计 06 §4.1）：`assigned → accepted` 与 `accepted → in_progress`
   * 都只有被指派的执行者本人；机器人执行者走租约，两道门禁都不适用。
   */
  const gatesForAssignee = (base, who) => {
    const bot = !who.startsWith('human:')
    const confirmers = bot ? [] : [who]
    return {
      ...base.gates,
      accept: bot
        ? // 机器人走租约，accept 门禁不适用 —— 也就没有"到期"这回事。
          // 留一个 due_at 只会让面板显示一个永远不会触发的倒计时。
          { ...(base.gates.accept ?? emptyGate()), not_applicable: true, required_by: [], confirmed_by: [], due_at: null }
        : activateDue(
            { ...(base.gates.accept ?? emptyGate()), not_applicable: false, required_by: confirmers, confirmed_by: [] },
            ctx.now,
          ),
      start: {
        ...(base.gates.start ?? emptyGate()),
        not_applicable: bot,
        required_by: confirmers,
        confirmed_by: [],
      },
    }
  }

  switch (action) {
    case 'confirm_split': {
      // 顺序：状态守卫（函数开头已做）→ 身份守卫 → 门禁
      if (!gateSatisfied(task.gates.confirm_split) && !isSplitConfirmer(task, actor, ctx)) {
        return err('forbidden', '你不是确认拆解的负责人', gatePending(task.gates.confirm_split))
      }
      const sat = satisfyGate(task, 'confirm_split', actor, ctx)
      if (!sat.ok) return sat
      if (!gateSatisfied(sat.gate)) {
        return err('gate_incomplete', '确认拆解门禁未通过', gatePending(sat.gate))
      }
      return withHistory(
        { ...base, state: 'confirmed', gates: { ...base.gates, confirm_split: sat.gate } },
        ['播报：任务已确认拆解，等待指派执行者'],
      )
    }

    case 'assign': {
      if (!canGovern(ctx, actor) && !isDomainOwner(ctx, actor)) {
        return err('forbidden', '只有需求负责人、项目负责人或该任务所属域的负责人可以指派')
      }
      const who = ctx.suggestedAssignee ?? null
      if (who === null) {
        return err('no_assignee', '指派必须给出执行者（机器人只能建议，不能自行决定）')
      }
      const bot = !who.startsWith('human:')
      // 机器人承接：accept/start 两道门禁标为 not_applicable（走租约，不等人工确认）
      // 人承接：required_by 保持建任务时冻结的值，不因指派而重算
      // 指派把任务推进到 assigned：accept 门禁从这一刻开始计时
      /*
       * 确认人**必须跟着新的执行者重算**。
       *
       * 之前这里只改 `not_applicable`，`required_by` 保持建任务时冻结的那份 —— 而
       * 机器人执行者那份是**空的**（机器人走租约，两道门禁都不适用）。于是
       * "机器人拒绝 → 改派给真人"会得到一个**没有确认人的 accept 门禁**：
       * `required_by.every(...)` 对空数组恒真 → 门禁立刻算满足，
       * 任务既不需要本人接受、也永远不会超时催办。这条是被一个端到端用例逼出来的
       * （见 test/notify.test.mjs 的"tick 释放要让群里知道"）。
       *
       * 重算规则按设计 06 §4.1：`assigned → accepted` 与 `accepted → in_progress`
       * 都**只有被指派的执行者本人**，所以确认人就是新的执行者。
       */
      const gates = gatesForAssignee(base, who)
      return withHistory(
        { ...base, state: 'assigned', assignee: who, owner: who, gates },
        [
          bot
            ? `播报：已指派给机器人 ${who}（机器人走租约，不需要人工确认）`
            : `播报并 @${who}：等待确认接受（门禁 1）`,
        ],
        { assignee: who },
      )
    }

    case 'accept': {
      if (!isAssignee(task, actor)) {
        return err('not_assigned_to_you', '只有被指派的执行者本人可以确认接受')
      }
      const sat = satisfyGate(task, 'accept', actor, ctx)
      if (!sat.ok) return sat
      // 接受之后 start 门禁才开始计时（否则“接受慢”会白白吃掉“开始”的额度）
      return withHistory(
        {
          ...base,
          state: 'accepted',
          gates: {
            ...base.gates,
            accept: sat.gate,
            start: activateDue(base.gates.start ?? emptyGate(), ctx.now),
          },
        },
        ['播报：已接受，等待确认开始（门禁 2）'],
      )
    }

    case 'reject': {
      if (!isAssignee(task, actor)) {
        return err('not_assigned_to_you', '只有被指派的执行者本人可以拒绝')
      }
      const next = { ...base, state: 'rejected', assignee: null }
      return withHistory(next, ['播报：已拒绝（无需理由），回到需求负责人重派'], {
        reassignNeeded: true,
      })
    }

    case 'start': {
      if (!isAssignee(task, actor)) {
        return err('not_assigned_to_you', '只有已接受的执行者本人可以确认开始')
      }
      const sat = satisfyGate(task, 'start', actor, ctx)
      if (!sat.ok) return sat
      return withHistory(
        { ...base, state: 'in_progress', gates: { ...base.gates, start: sat.gate } },
        ['播报：已开始，进入执行'],
      )
    }

    case 'unassign': {
      if (!isAssignee(task, actor) && !canGovern(ctx, actor)) {
        return err('forbidden', '只有执行者本人或需求负责人可以交回任务')
      }
      return withHistory(
        { ...base, state: 'assigned', assignee: null },
        ['播报：已交回，回到需求负责人重派'],
      )
    }

    case 'reassign': {
      if (!isAssignee(task, actor) && !canGovern(ctx, actor)) {
        return err('forbidden', '只有执行者本人或需求负责人可以转派')
      }
      const who = ctx.suggestedAssignee ?? null
      if (who === null) return err('no_assignee', '转派必须给出新的执行者')
      if (who === task.assignee) return err('no_change', '转派要给一个不同的执行者')
      /*
       * 门禁必须跟着新执行者重置 —— 这正是"新执行者仍需点接受"的意思。
       * 转派时旧的确认记录（`confirmed_by`）也要清空：那是**别人的**确认。
       */
      return withHistory(
        { ...base, state: 'assigned', assignee: who, owner: who, gates: gatesForAssignee(base, who) },
        [`播报并 @${who}：转派等待确认接受（**新执行者仍需点接受**）`],
        { assignee: who, reassigned: true },
      )
    }

    case 'block': {
      if (!isAssignee(task, actor) && !canGovern(ctx, actor)) {
        return err('forbidden', '只有执行者本人或需求负责人可以标记阻塞')
      }
      return withHistory(
        { ...base, state: 'blocked', blocked_reason: task.blocked_reason ?? '未填写原因' },
        ['播报：任务阻塞，附原因'],
      )
    }

    case 'unblock':
      if (!isAssignee(task, actor) && !canGovern(ctx, actor)) {
        return err('forbidden', '只有执行者本人或需求负责人可以解除阻塞')
      }
      return withHistory({ ...base, state: 'in_progress', blocked_reason: null }, ['播报：阻塞解除，恢复执行'])

    case 'ci_start':
      return withHistory({ ...base, state: 'ci_running' }, ['卡片进入"等 CI"状态'])

    case 'ci_pass':
      return withHistory(
        {
          ...base,
          state: 'in_review',
          gates: { ...base.gates, acceptance: activateDue(base.gates.acceptance ?? emptyGate(), ctx.now) },
        },
        ['播报：CI 通过，进入待验收'],
      )

    case 'ci_fail':
      return withHistory({ ...base, state: 'in_progress' }, ['播报：CI 失败，附失败日志摘要，回到执行者'])

    case 'submit': {
      if (!isAssignee(task, actor) && !canGovern(ctx, actor)) {
        return err('forbidden', '只有执行者本人或需求负责人可以提交验收')
      }
      // 硬闸 2：没有证据的“完成”不成立
      if (task.evidence.length === 0) {
        return err('evidence_required', '没有证据的"完成"不成立：请先附测试结果 / diff / 产物链接')
      }
      // 提交验收：验收门禁从这一刻开始计时
      return withHistory(
        {
          ...base,
          state: 'in_review',
          gates: { ...base.gates, acceptance: activateDue(base.gates.acceptance ?? emptyGate(), ctx.now) },
        },
        ['播报：已提交验收，@验收人'],
      )
    }

    case 'verify': {
      // 硬闸 1：出题者不能当阅卷人——先于“谁是验收人”判定
      if (isAssignee(task, actor)) {
        return err('self_review', '出题者不能当阅卷人：执行者不能验收自己的产出')
      }
      if (!isAcceptor(ctx, actor) && !canGovern(ctx, actor)) {
        return err('forbidden', '只有该任务的验收人或需求负责人可以验收')
      }
      if (task.evidence.length === 0) {
        return err('evidence_required', '验收前必须有关联证据')
      }
      const sat = satisfyGate(task, 'acceptance', actor, ctx)
      if (!sat.ok) return sat
      // 硬闸 3：门禁还没全确认
      if (!gateSatisfied(sat.gate)) {
        return err('gate_incomplete', '还有其他人未验收', gatePending(sat.gate))
      }
      return withHistory(
        { ...base, state: 'done', gates: { ...base.gates, acceptance: sat.gate } },
        ['播报：验收通过，任务完成'],
      )
    }

    case 'suspend':
      if (!canGovern(ctx, actor)) return err('forbidden', '只有需求负责人或项目经理可以挂起任务')
      return withHistory(
        { ...base, state: 'suspended' },
        ['播报：任务已挂起（需求变更影响或主动挂起）'],
        { frozenState: task.state },
      )

    case 'resume': {
      if (!canGovern(ctx, actor)) return err('forbidden', '只有需求负责人或项目经理可以恢复任务')
      // 回到冻结前的状态；blocked 恢复就是 in_progress
      const back = task.state === 'blocked' ? 'in_progress' : 'assigned'
      return withHistory({ ...base, state: back, blocked_reason: null }, ['播报：任务已恢复'])
    }

    case 'drop':
      if (!canGovern(ctx, actor)) return err('forbidden', '只有需求负责人或项目经理可以废弃任务')
      return withHistory({ ...base, state: 'dropped' }, ['播报：任务废弃（需填原因），回收分支与 worktree'])

    case 'archive':
      return withHistory({ ...base, state: 'archived' }, ['归档：视图转为只读'])

    case 'reject_review': {
      /*
       * 谁能打回：与"谁能验收"同一批人（需求负责人 / 域负责人 / 独立验证者），
       * 且**不能是执行者本人** —— 和自己不能验收自己同理：自己把自己的活打回，
       * 只会制造一条没有信息量的历史。
       */
      if (isAssignee(task, actor)) {
        return err('self_review', '执行者不能打回自己的产出（和"自己不能验收自己"同理）')
      }
      // 与 verify 同一批人：验收人或需求负责人。域负责人已经通过 ctx.acceptors 进来，
      // 这里不再单独加一条 —— 两处各写一遍规则，迟早会不一致。
      if (!isAcceptor(ctx, actor) && !canGovern(ctx, actor)) {
        return err('forbidden', '只有该任务的验收人或需求负责人可以打回')
      }
      const reason = typeof ctx.reason === 'string' && ctx.reason !== '' ? ctx.reason : ''
      return withHistory(
        { ...base, state: 'in_progress' },
        ['播报：验收未通过，已打回继续做'],
        undefined,
        reason,
      )
    }

    case 'timeout_start': {
      // 优先用门禁里的快照（改配置不影响进行中的任务），其次才看上下文
      const max = task.gates.start?.max_release ?? ctx.maxRelease ?? 2
      if (task.release_count + 1 >= max) {
        // 不再轮回派发，升级给人
        return {
          ok: false,
          code: 'escalate',
          message: `已连续释放 ${task.release_count + 1} 次，升级给需求负责人决定（不再轮回派发）`,
        }
      }
      return withHistory(
        { ...base, state: 'assigned', assignee: null, release_count: task.release_count + 1 },
        [
          `播报：确认开始超时，已自动释放回待接受（第 ${task.release_count + 1} 次）`,
          '通知需求负责人',
        ],
        { releaseCount: task.release_count + 1 },
      )
    }

    case 'timeout_accept':
      // 确认接受超时**不自动释放**：接受代表“认可这活归我”，默认释放会让人莫名丢任务
      return err('escalate', '确认接受超时：只催办并升级给需求负责人，不自动释放任务')

    case 'lease_expired':
      // 执行中租约过期：任务状态不动，等需求负责人决定收回还是续约
      return err('escalate', '执行中租约已过期：播报"租约过期，等待确认"，由需求负责人决定收回或续约')

    case 'timeout_lease':
      // 过期后又过了宽限期还没人处理 → 收回，回到待接受重新走两道确认。
      // 注意**不是直接释放回池**：任务仍然挂在原执行者名下直到他点接受，
      // 这样“被收回”这件事是可见的，而不是任务悄悄消失。
      return withHistory(
        { ...base, state: 'assigned', assignee: null, release_count: task.release_count + 1 },
        [
          '播报：租约过期且宽限期内无人处理，任务已收回',
          '通知原执行者与需求负责人',
        ],
        { leaseTimedOut: true, releaseCount: task.release_count + 1 },
      )

    default:
      return err('unknown', `未实现的动作 ${String(action)}`)
  }
}

/**
 * 谁算“确认拆解”的负责人。
 *
 * 门禁没建（undefined）/ 机器人承接 / required_by 为空 → 退回治理权限（需求负责人或 pm）；
 * 否则只有名单内的人算。
 *
 * @param {import('./schema.js').Task} task
 * @param {import('./types.js').Principal} actor
 * @param {TransitionContext} ctx
 * @returns {boolean}
 */
function isSplitConfirmer(task, actor, ctx) {
  const gate = task.gates.confirm_split
  if (gate === undefined || gate.not_applicable || gate.required_by.length === 0) {
    return canGovern(ctx, actor)
  }
  return gate.required_by.includes(actor)
}

/**
 * 一张“什么都没有”的门禁。字段与 schema.ts 的默认值逐字一致。
 *
 * @returns {import('./schema.js').Gate}
 */
function emptyGate() {
  return {
    required_by: [],
    confirmed_by: [],
    due_at: null,
    not_applicable: false,
    timeout_snapshot: null,
    on_timeout: null,
    max_release: null,
  }
}

/**
 * 把一次人工确认记进某个门禁。
 *
 * 这是**门禁的落地动作**：卡片上点“接受”，等价于“satisfy 门禁 accept”。
 * 之前只改状态不记确认，导致 gateLine 永远显示“待确认”——那是个真 bug。
 *
 * 权限判定顺序（重要）：
 *   1. 如果门禁已经列了 required_by，只有名单内的人能确认（防止外人点头）
 *   2. 名单为空时，需求负责人/pm 可以代确认（fallback 场景）
 *   3. 都不满足 → forbidden，错误里带上还差谁
 *   4. 已经确认过的人再点一次 → 幂等（不重复写 confirmed_by）
 *
 * @param {import('./schema.js').Task} task
 * @param {'confirm_split'|'accept'|'start'|'acceptance'} name
 * @param {import('./types.js').Principal} actor
 * @param {TransitionContext} ctx
 * @returns {{ok: true, gate: import('./schema.js').Gate}|TransitionErr}
 */
function satisfyGate(task, name, actor, ctx) {
  const gate = task.gates[name] ?? emptyGate()
  const already = gate.confirmed_by.map((c) => c.by)

  // 机器人承接的门禁不需要确认，原样返回
  if (gate.not_applicable) return { ok: true, gate }

  const listed = gate.required_by.length > 0
  if (listed && !gate.required_by.includes(actor)) {
    return err('forbidden', `你不是"${name}"门禁的确认人`, gatePending(gate))
  }
  if (!listed && !canGovern(ctx, actor)) {
    return err('forbidden', `"${name}"门禁没有指定确认人，只有需求负责人或项目经理可以代确认`)
  }
  if (already.includes(actor)) return { ok: true, gate }

  return {
    ok: true,
    gate: { ...gate, confirmed_by: [...gate.confirmed_by, { by: actor, at: ctx.now.toISOString() }] },
  }
}

/* ------------------------------------------------------------------ *
 * Requirement 状态机
 * ------------------------------------------------------------------ */

/**
 * 需求侧动作允许的当前状态。
 *
 * @type {Readonly<Record<RequirementAction, readonly string[]>>}
 */
export const REQ_ALLOWED = Object.freeze({
  confirm: Object.freeze(['draft']),
  confirm_split: Object.freeze(['confirmed']),
  change: Object.freeze(['confirmed', 'dispatched']),
  reconfirm: Object.freeze(['changed']),
  block: Object.freeze(['confirmed', 'dispatched']),
  unblock: Object.freeze(['blocked']),
  suspend: Object.freeze(['confirmed', 'dispatched']),
  resume: Object.freeze(['suspended']),
  drop: Object.freeze(['draft', 'confirmed', 'dispatched', 'blocked', 'suspended']),
  archive: Object.freeze(['done']),
})

/**
 * 需求状态跃迁。
 *
 * 权限：需求侧动作一律要求需求负责人；治理类（挂起/恢复/废弃/阻塞/归档）
 * 额外允许 pm。
 *
 * @param {import('./schema.js').Requirement} req
 * @param {RequirementAction} action
 * @param {import('./types.js').Principal} actor
 * @param {TransitionContext} ctx
 * @returns {TransitionResult<import('./schema.js').Requirement>}
 */
export function transitionRequirement(req, action, actor, ctx) {
  const allowed = REQ_ALLOWED[action]
  if (allowed === undefined) {
    return err('unknown', `未实现的动作 ${String(action)}`)
  }
  if (!allowed.includes(req.state)) {
    return err('invalid_state', `需求当前是 ${req.state}，不能执行 ${action}`)
  }
  const at = nowIso(ctx)
  /**
   * @param {import('./schema.js').Requirement} next
   * @param {string[]} effects
   * @param {Record<string, unknown>} [detail]
   * @returns {TransitionOk<import('./schema.js').Requirement>}
   */
  const ok = (next, effects, detail) => {
    const entry = historyEntry({ from: req.state, to: next.state, by: actor, at, effects, detail })
    return { ok: true, next: { ...next, history: [...next.history, entry] }, history: entry, effects }
  }

  // 需求侧动作一律要求需求负责人；治理类（挂起/废弃）额外允许 pm
  const privileged =
    action === 'suspend' || action === 'resume' || action === 'drop' || action === 'block' || action === 'archive'
  if (!isReqOwner(ctx, actor) && !(privileged && isPM(ctx, actor))) {
    return err('forbidden', '只有需求负责人（治理类动作可由项目经理）可以推进需求状态')
  }

  switch (action) {
    case 'confirm':
      return ok({ ...req, state: 'confirmed' }, ['播报：需求与验收标准已确认'])
    case 'confirm_split':
      return ok({ ...req, state: 'dispatched' }, ['播报：拆解已确认，任务进入各自的确认流程'])
    case 'change':
      return ok({ ...req, state: 'changed' }, [
        '计算影响面清单（受影响任务 / 已写测试 / 已开分支）',
        '受影响任务置为 suspended',
        '播报影响面清单，等待确认后回到 confirmed',
      ])
    case 'reconfirm':
      return ok({ ...req, state: 'confirmed' }, ['播报：变更已确认，重走拆解'])
    case 'block':
      return ok({ ...req, state: 'blocked' }, ['播报：需求被外部依赖阻塞'])
    case 'unblock':
      return ok({ ...req, state: 'confirmed' }, ['播报：阻塞解除'])
    case 'suspend':
      return ok({ ...req, state: 'suspended' }, ['播报：需求挂起，其下任务冻结'], { frozenState: req.state })
    case 'resume':
      return ok({ ...req, state: 'confirmed' }, ['播报：需求恢复，任务各自回到冻结前状态'])
    case 'drop':
      return ok({ ...req, state: 'dropped' }, ['播报：需求废弃（需填原因），终止其下任务'])
    case 'archive':
      return ok({ ...req, state: 'archived' }, ['归档：需求视图转只读'])
    default:
      return err('unknown', `未实现的动作 ${String(action)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 便捷查询：卡片渲染与配置台用
 * ------------------------------------------------------------------ */

/**
 * 当前状态下允许的动作（卡片按钮直接用它决定显示哪些按钮）。
 *
 * 顺序 = TASK_ALLOWED 的声明顺序，hub 同样如此。
 *
 * @param {import('./schema.js').Task} task
 * @returns {TaskAction[]}
 */
export function availableActions(task) {
  return /** @type {TaskAction[]} */ (Object.keys(TASK_ALLOWED)).filter((a) =>
    TASK_ALLOWED[a].includes(task.state),
  )
}

/**
 * 门禁 1/2 在卡片上的文案（设计文档 04 §3.5 的确认行）。
 *
 * 机器人承接（not_applicable）的门禁**不出现**在确认行里；
 * 没有建 gates 的任务（`gates` 为空对象）只会显示验收那一段。
 *
 * @param {import('./schema.js').Task} task
 * @returns {string}
 */
export function gateLine(task) {
  /** @type {string[]} */
  const parts = []
  for (const name of ['accept', 'start']) {
    const g = task.gates[name]
    if (g === undefined || g.not_applicable) continue
    const label = name === 'accept' ? '接受' : '开始'
    parts.push(gateSatisfied(g) ? `✅ ${label}已确认` : `⏳ 待${label}确认`)
  }
  const accept = task.gates.acceptance
  if (accept !== undefined && !accept.not_applicable) {
    parts.push(gateSatisfied(accept) ? '✅ 已验收' : '⏳ 待验收')
  }
  return parts.join(' · ')
}
