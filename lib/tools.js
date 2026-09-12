/*
 * The `team` tool: the one surface through which an agent touches the ledger.
 *
 * WHY ONE TOOL WITH AN `action` FIELD, AND NOT ONE TOOL PER VERB. Every tool
 * schema is prompt surface for every session in the deployment, and the ledger
 * has thirteen verbs. One tool with an enumerated `action` keeps that cost to a
 * single description while still letting the model express exactly one verb per
 * call — which is also the shape that keeps `list`/`show` cheap and read-only.
 *
 * THE HANDLERS ARE THE STATE MACHINE'S ONLY CALLER. Nothing here decides what a
 * transition means: `transitionTask`/`transitionRequirement` do, and a refusal
 * comes back as `{ok:false, code, message, pending}` which this file passes
 * through verbatim. A tool that "helped" by forcing a transition would erase the
 * two gates the whole design rests on.
 */
import { mkdirSync } from 'node:fs'
import {
  DEFAULT_LEASE_POLICY,
  requirementComplete,
  asPrincipal,
  availableActions,
  buildGates,
  createRequirement,
  createTask,
  dueAction,
  gateLine,
  isBot,
  leaseVerdict,
  openLease,
  scanDue,
  transitionRequirement,
  DECISION_SOURCE_KINDS,
  DECISION_STATUSES,
  parseDecision,
  transitionTask,
} from './domain/index.js'
import { botCan, botCanTouchRepo, findBot } from './bots.js'
import { memberCanWrite, resolveMembers } from './members.js'
import {
  branchName,
  ciPatch,
  ciState,
  commitProblems,
  commitTrailers,
  indexRepo,
  mergeDecision,
  overviewDoc,
  sensitiveFiles,
} from './repos.js'
import { domainsOfTaskType } from './tasktypes.js'
import { noteMessage } from './sessions.js'
import { chatIdOfTask } from './notify.js'
import { taskPrompt } from './exec.js'

/** Task actions a bot may take on its own behalf, with no human in between. */
const BOT_AUTO = ['accept', 'start']

function nowDate() {
  return new Date()
}

/**
 * Resolve the acting principal for one call.
 *
 * Explicit `actor` wins; otherwise the object's own owner/assignee is the
 * answer, because the state machine's refusals are all about *who* acts and a
 * wrong default would make every refusal look like a bug.
 */
function actorFor(args, fallback) {
  const raw = args !== null && typeof args === 'object' ? args.actor : undefined
  const chosen = typeof raw === 'string' && raw !== '' ? raw : fallback
  return asPrincipal(typeof chosen === 'string' && chosen !== '' ? chosen : 'human:owner')
}

/** Domain owners from config: who may confirm a gate, and who may accept work. */
function domainOwners(config, domains) {
  const members = config.members !== null && typeof config.members === 'object' ? config.members : {}
  const out = []
  for (const domain of Array.isArray(domains) ? domains : []) {
    const list = members[domain]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const principal = asPrincipal(String(entry))
      if (!out.includes(principal)) out.push(principal)
    }
  }
  return out
}

function pmOwners(config) {
  const members = config.members !== null && typeof config.members === 'object' ? config.members : {}
  return Array.isArray(members.pm) ? members.pm.map((entry) => asPrincipal(String(entry))) : []
}

export function createHandlers({ ctx, config, store, pool, notify, docs, recall }) {
  const tasksOf = (reqId) => store.find('task', (task) => task.req === reqId)
  /** 成员索引（角色/可批准/代理）——成员表第一次真的参与判定，见 `gateWrite`。 */
  const members = resolveMembers({ members: config.memberList, domains: config.members, senders: config.feishu?.senders })

  /**
   * 写操作前的成员闸：观察者只读、停用的人要走代理、canApprove 是白名单。
   *
   * 放在这里而不是状态机里：状态机判的是"这个主体配不配做这个动作"（领域规则），
   * 成员表判的是"这个人现在是不是能动手"（组织事实）。混在一起会让领域层
   * 依赖组织配置，而那正是这次移植刻意避开的东西。
   */
  function gateWrite(actor, needsApproval) {
    return memberCanWrite(members, { actor, action: needsApproval ?? '', needsApproval })
  }

  /**
   * Transition context: everything the state machine needs to judge permission.
   *
   * `extra` carries per-action inputs the machine reads from the CONTEXT rather
   * than from the object — `suggestedAssignee` is the one that matters here:
   * `assign` takes the executor from the context ("a bot may only suggest, it
   * never decides by itself"), so patching the task and calling `assign` would
   * silently fail with `no_assignee`.
   */
  function transitionCtx(task, requirement, extra = {}) {
    const assignee = task !== null && typeof task === 'object' ? task.assignee : null
    const owners = task === null ? [] : domainOwners(config, task.domains)
    /*
     * 谁可以验收：任务跨越的那些域负责人 + pm + **需求负责人**。
     *
     * 最后一项是必需的，而且以前漏了：设计 00 §5.1 明说"多人协作由主 owner 确认"，
     * 可 `acceptance` 门禁列的也一直是需求负责人 —— 但他只有在"同时是某个域的负责人
     * 或 pm"时才能点得动，否则验收会被 `forbidden` 拦住。一个人不能验收自己需求下的
     * 任务，这显然不是设计要的。
     */
    const requirementOwner =
      requirement !== null && typeof requirement?.owner === 'string' && requirement.owner !== '' ? requirement.owner : null
    const acceptors = [
      ...new Set([...owners, ...pmOwners(config), ...(requirementOwner === null ? [] : [requirementOwner])]),
    ].filter((p) => p !== assignee)
    return {
      requirement: requirement ?? undefined,
      domainOwners: owners,
      acceptors,
      pmOwners: pmOwners(config),
      maxRelease: task !== null && typeof task === 'object' ? task.gates?.start?.max_release ?? undefined : undefined,
      now: nowDate(),
      ...extra,
    }
  }

  /** Apply a transition result: persist on success, pass the refusal through. */
  /**
   * 写回一个对象，并**顺手播报**。
   *
   * 播报放在这里而不是散在各个动作里：这是"每一次状态跃迁都会有一张跟得上状态的卡"
   * 唯一可能不走漏的落点。之前整个播报层零调用点，于是群里只有建单那一次有声 ——
   * 接受/开始/阻塞/验收全都没人知道。
   *
   * 播报是**尽力而为**：它失败、被节流、没有群可发，都不影响这次写入的返回值。
   * 但每一种"没发"都带 reason 回来（`delivered` 字段），"为什么群里没动静"要能答。
   */
  function commit(kind, result, describe) {
    if (result.ok !== true) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        pending: Array.isArray(result.pending) ? result.pending : [],
      }
    }
    const saved = kind === 'task' ? writeTask(result.next) : store.put(kind, result.next)
    const out = {
      ok: true,
      id: saved.id,
      state: saved.state ?? saved.status ?? null,
      what: describe,
      effects: Array.isArray(result.effects) ? result.effects : [],
      /*
       * `pending` 必须透出去：**部分完成**也是完成（"这一票记下了，还差谁"）。
       * 以前一律写 `[]`，于是"还差谁确认"这句设计里最重要的话在工具返回值里看不到。
       */
      pending: Array.isArray(result.pending) ? result.pending.map((one) => String(one)) : [],
    }
    if (result.partial === true) out.partial = true
    if (kind === 'task') out.delivered = { queued: announced.has(saved.id), reason: 'state_transition' }
    return out
  }

  /**
   * 这次跃迁要不要在群里说。同步返回一个"待发"描述，真正的发送是异步的，
   * 不阻塞工具调用（模型不该等一张卡发出去）。
   */
  function announce(kind, saved, result) {
    if (notify === null || notify === undefined) return null
    const pending = result.pending ?? []
    const spec =
      kind === 'task'
        ? { task: saved, pendingGates: pendingGateInputs(saved, pending) }
        : null
    if (spec === null) return null
    // fire-and-forget：失败只记日志（notify 内部已经兜住），绝不冒泡到工具调用者。
    Promise.resolve()
      .then(() => notify.task(spec.task, { pendingGates: spec.pendingGates }))
      .then((delivery) => {
        if (typeof console !== 'undefined' && delivery !== null && delivery.action === 'failed') {
          console.error?.('[team] 播报失败：' + JSON.stringify(delivery))
        }
      })
      .catch(() => {})
    return { queued: true, reason: 'state_transition' }
  }

  /** 最近一次排上播报的任务 id（返回值的 `delivered` 只作说明，不阻塞）。 */
  const announced = new Set()

  /**
   * 写任务对象的**唯一入口**：状态真的变了才播报。
   *
   * 为什么不能把播报挂在 `commit()` 上：不是每个动作都走 `commit`（`accept_task`
   * 自己要返回租约、自己写对象）。挂在"写对象"这一层才是唯一走得掉的落点 ——
   * 第一版挂在 `commit` 上，实测里"接受"这一步群里还是没消息。
   *
   * 判据是**状态是否变化**，不是"有没有调用 announce"：`blocked_reason` 这类
   * 元数据写入不该在群里多刷一条消息。
   */
  function writeTask(next) {
    const before = store.get('task', next.id)
    const saved = store.put('task', next)
    if (before === null || before.state !== saved.state) announceTask(saved)
    else announceProgress(before, saved)
    return saved
  }

  /**
   * 状态没变、但**多了一条证据** → 进摘要桶（设计 04 §2.2 的 digest）。
   *
   * 判据是"有没有新证据"，不是"有没有写对象"：`blocked_reason` 这类元数据写入
   * 不该进摘要，而 agent 汇报了一条进展（一次执行、一条备注）**应该**被记下来 ——
   * 它会出现在当天的日报里。没有日报，进摘要就是静默丢失；只播报，就是刷屏。
   */
  function announceProgress(before, saved) {
    if (notify === null || notify === undefined) return
    const beforeCount = Array.isArray(before?.evidence) ? before.evidence.length : 0
    const evidence = Array.isArray(saved.evidence) ? saved.evidence : []
    if (evidence.length <= beforeCount) return
    const latest = evidence[evidence.length - 1]
    const note = String(latest?.note ?? '').replace(/\s+/g, ' ').trim()
    const line = saved.id + '：' + (note === '' ? '新增一条证据（' + String(latest?.kind ?? 'note') + '）' : note.slice(0, 80))
    Promise.resolve()
      .then(() => notify.task(saved, { reason: 'progress', progress: true, line }))
      .catch(() => {})
  }

  /**
   * 状态变了 → 在它所属的群里播报（异步：模型不该等一张卡发出去）。
   *
   * `pendingGates` 由对象自己算：哪个门禁**已激活、还没满足、有明确确认人**，就是要 @
   * 的那批人。于是"接受超时释放后 @ 回可承接的人"是自然发生的，不需要每个动作各传一遍。
   */
  function announceTask(task) {
    if (notify === null || notify === undefined) return
    announced.add(task.id)
    Promise.resolve()
      .then(() => notify.task(task, { pendingGates: activePendingGates(task) }))
      .then((delivery) => {
        if (delivery !== null && delivery.action === 'failed') {
          console.error?.('[team] 播报失败：' + JSON.stringify(delivery))
        }
      })
      .catch(() => {})
  }

  /**
   * 需求下所有任务都完成了 → 把需求推到 `done`（设计 06 §7 完整性约束 2）。
   *
   * 这是"需求只进不出"那一半的出口：任务验收完、需求却永远停在 `dispatched`，
   * 看板上就永远有一个"在做"的需求，而它其实早就做完了。
   * 人工也能推（`finish_requirement`），但系统该自己做的这一步不该等人。
   *
   * @returns {{id: string, state: string, what: string}|null} 推进了就返回，否则 null
   */
  function tryFinishRequirement(reqId, actor) {
    const req = loadRequirement(reqId)
    if (req === null) return null
    if (req.state !== 'dispatched') return null
    if (requirementComplete(req, store.all('task')) !== true) return null
    const result = transitionRequirement(req, 'finish', actor, transitionCtx(null, req))
    if (result.ok !== true) return null
    const saved = store.put('requirement', result.next)
    return { id: saved.id, state: saved.state, what: '这个需求的任务都完成了' }
  }

  /**
   * 一个任务的验收人：需求负责人 + 它跨越的每个域的负责人（域没人时用 fallback）。
   *
   * @returns {string[]} 去重、按域名顺序，且**一定包含需求负责人**（他能最终拍板）
   */
  function acceptanceConfirmers(req, domains, assignee) {
    const out = []
    const push = (who) => {
      const value = who === null || who === undefined ? '' : String(who)
      if (value === '' || value === assignee || out.includes(value)) return
      out.push(value)
    }
    push(req === null ? null : req.owner)
    for (const domain of domains) {
      const owners = Array.isArray(config.members?.[domain]) ? config.members[domain] : []
      for (const owner of owners) push(owner)
      if (owners.length === 0) push(config.domainFallbacks?.[domain] ?? null)
    }
    return out
  }

  /** 需求侧治理动作的公共壳（挂起/恢复/废弃/阻塞/解除）。 */
  function requirementAction(args, action, describe) {
    const req = loadRequirement(args.id)
    if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
    const result = transitionRequirement(req, action, actorFor(args, req.owner), transitionCtx(null, req))
    return commit('requirement', result, describe)
  }

  /** 已激活、未满足、且有确认人的门禁（@ 人的依据）。 */
  function activePendingGates(task) {
    const out = []
    for (const name of ['accept', 'start', 'acceptance']) {
      const gate = task.gates === undefined ? undefined : task.gates[name]
      if (gate === undefined || gate === null || gate.not_applicable === true) continue
      const pending = gatePendingOf(task, name)
      if (pending.length > 0) out.push({ name, pending })
    }
    return out
  }

  /** 一次性通知（催办/升级/收回）：不走"同一张卡"的幂等，每次都是一条要被看见的消息。 */
  function announceTick(opts) {
    if (notify === null || notify === undefined) return
    const chatId = chatIdOfTask(store, opts.task)
    Promise.resolve()
      .then(() =>
        notify.notice({
          title: opts.title,
          status: opts.status,
          lines: opts.lines,
          chatId,
          id: opts.reason + ':' + opts.task.id,
          pendingGates: opts.pendingGates,
          headerTemplate: opts.reason === 'escalate' ? 'orange' : 'grey',
        }),
      )
      .catch(() => {})
  }

  /** 一个门禁还差谁确认（用于催办时 @ 对的人）。 */
  function gatePendingOf(task, gateName) {
    const gate = task.gates === undefined ? undefined : task.gates[gateName]
    if (gate === undefined || gate === null || gate.not_applicable === true) return []
    const done = new Set((gate.confirmed_by ?? []).map((one) => one.by))
    return (gate.required_by ?? []).filter((who) => !done.has(who)).map((who) => String(who))
  }

  /** 升级给谁：需求负责人（没人可升级时退回默认负责人）。 */
  function escalationTargets(task, req) {
    const owner = req !== null && typeof req.owner === 'string' ? req.owner : null
    return [owner ?? config.defaultOwner]
  }

  /** 接受门禁还差谁（自动释放之后要 @ 回可承接的人）。 */
  function acceptTargets(task) {
    const pending = gatePendingOf(task, 'accept')
    return pending.length > 0 ? pending : escalationTargets(task, loadRequirement(task.req))
  }

  /** 卡片上认得出是哪个任务。 */
  function taskLabel(task) {
    return String(task.id) + ' · ' + String(task.title ?? '')
  }

  /** 把"还差谁确认"翻译成播报引擎认的 `pending_gates`（它据此决定 @ 谁）。 */
  function pendingGateInputs(task, pending) {
    if (!Array.isArray(pending) || pending.length === 0) return []
    return [{ name: 'gate_needs_human', pending: pending.map((one) => String(one)) }]
  }

  function loadTask(id) {
    return store.get('task', String(id))
  }

  function loadRequirement(id) {
    return store.get('requirement', String(id))
  }

  /** The lease record for a task, if any (one lease per task by construction). */
  function leaseOf(taskId) {
    return store.get('lease', String(taskId))
  }

  /* ---------------------------------------------------------------- *
   * Handlers
   * ---------------------------------------------------------------- */

  /** 仓库检出路径：配置里的 `repos.roots.<名字>`，或调用方直接给的 path。 */
  function repoRootOf(config, name, explicit) {
    if (typeof explicit === 'string' && explicit !== '') return explicit
    const roots = config.repos?.roots
    if (roots === null || typeof roots !== 'object') return null
    const value = roots[name]
    return typeof value === 'string' && value !== '' ? value : null
  }

  /** 这个 actor 是不是 ops（设计 03 §1.6：只有 ops 能在批准后合并）。 */
  function actorIsOps(config, actor) {
    const key = String(actor ?? '')
    if (key === '') return false
    for (const bot of config.bots ?? []) {
      if (bot === null || typeof bot !== 'object') continue
      const ids = [bot.id, 'bot:' + String(bot.id ?? '')]
      if (ids.includes(key) && (bot.role === 'ops' || bot.baseRole === 'ops')) return true
    }
    const member = (config.memberList ?? []).find((one) => one.key === key)
    return member !== null && member !== undefined && member.role === 'ops'
  }

  /**
   * 敏感文件改动 → 相关文档标 stale（设计 03 §1.4）。
   *
   * "相关"的判据是 frontmatter 的 `related.repos` 含这个仓库。**只改状态、不改正文**：
   * 插件不该替人写文档，但"这份文档描述的东西刚被动过"是它能算出来的事实。
   */
  function markRelatedDocsStale(repoName, sensitive) {
    if (sensitive.length === 0 || repoName === '' || docs === null || docs === undefined) return []
    const marked = []
    for (const doc of docs.list()) {
      const repos = Array.isArray(doc.related?.repos) ? doc.related.repos : []
      if (!repos.includes(repoName)) continue
      if (doc.status === 'stale' || doc.status === 'superseded') continue
      const written = docs.write({
        id: doc.id,
        type: doc.type,
        title: doc.title,
        owner: doc.owner,
        status: 'stale',
        body: doc.body,
        related: doc.related,
      })
      if (written.ok === true) marked.push({ id: doc.id, path: doc.path })
    }
    if (marked.length > 0) docs.rebuildIndex()
    return marked
  }

  /** 动作的发起者：写文档/记忆时用它当 `owner`（缺省时宁可拒绝，也不编一个）。 */
  function actorOf(args) {
    for (const key of ['actor', 'owner', 'assignee']) {
      if (typeof args?.[key] === 'string' && args[key] !== '') return args[key]
    }
    return null
  }

  /** 标题 → 文档 id（中文标题没有 slug 可用时退回时间戳，仍然合法）。 */
  function slugOf(title) {
    const ascii = String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (ascii !== '') return ascii.slice(0, 60)
    return 'note-' + Date.now().toString(36)
  }

  const actions = {
    /**
     * 文档载体（设计 01 §4）：列 / 读 / 写 / 重建索引 / 陈旧检测。
     *
     * 写操作**必须有 owner**：一份没有责任人的文档三个月后一定会腐烂（设计原话），
     * 所以 `write` 缺字段就直接拒绝，而不是"先存着以后再补"。
     */
    docs(args) {
      if (docs === null || docs === undefined) {
        return { ok: false, code: 'docs_unavailable', message: '文档库没接上（工作区不可写？）' }
      }
      const op = typeof args.op === 'string' && args.op !== '' ? args.op : 'list'
      if (op === 'init') return { ok: true, ...docs.init(), what: '按目录规范建好文档库' }
      if (op === 'list') {
        const rows = docs.list().map((doc) => ({
          id: doc.id,
          type: doc.type,
          title: doc.title,
          owner: doc.owner,
          status: doc.status,
          updated: doc.updated,
          path: doc.path,
          problems: doc.problems,
        }))
        return { ok: true, count: rows.length, rows, stats: docs.stats() }
      }
      if (op === 'read') {
        const doc = docs.read(String(args.id ?? ''))
        if (doc === null) return { ok: false, code: 'not_found', message: '没有这份文档：' + String(args.id ?? '') }
        return { ok: true, id: doc.id, path: doc.path, frontmatter: doc.frontmatter, body: doc.body, what: doc.title }
      }
      if (op === 'search') {
        const rows = docs.search(String(args.query ?? ''), { limit: Number.isFinite(args.limit) ? Number(args.limit) : 10 })
        return { ok: true, count: rows.length, rows }
      }
      if (op === 'index') {
        const result = docs.rebuildIndex()
        return { ok: result.ok === true, ...result, what: '索引已从 frontmatter 重建' }
      }
      if (op === 'stale') {
        return { ok: true, ...docs.staleReport({ staleAfterDays: Number.isFinite(args.staleAfterDays) ? Number(args.staleAfterDays) : undefined }) }
      }
      if (op !== 'write') return { ok: false, code: 'bad_request', message: 'op 是 init | list | read | write | index | stale | search' }
      const written = docs.write({
        id: String(args.id ?? ''),
        type: args.type === undefined ? undefined : String(args.type),
        title: args.title === undefined ? undefined : String(args.title),
        owner: args.owner === undefined ? actorOf(args) ?? undefined : String(args.owner),
        status: args.status === undefined ? undefined : String(args.status),
        body: typeof args.body === 'string' ? args.body : '',
        ...(args.related === undefined ? {} : { related: args.related }),
        ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
        ...(args.visibility === undefined ? {} : { visibility: args.visibility }),
        ...(args.source === undefined ? {} : { source: args.source }),
      })
      if (written.ok !== true) {
        return {
          ok: false,
          code: written.code ?? 'invalid_frontmatter',
          message: 'frontmatter 不合法，什么都没写',
          problems: written.problems ?? [{ path: '', message: written.message ?? '' }],
        }
      }
      // 写完顺手重建索引：索引是派生物，不让它落后于内容。
      const index = docs.rebuildIndex()
      return { ok: true, id: written.id, path: written.path, created: written.created, index: index.ok === true, what: '文档已写入 ' + written.path }
    },

    /**
     * 沉淀一条知识（约定 / 术语 / 踩过的坑 / 决策）到工作区文件（设计 07 §0.3）。
     *
     * **不是**写自建记忆库：沉淀知识的家就是 `docs/`，因为它要人能读能改能 diff。
     * 情景记忆（谁在什么时候说了什么）在 DSH 的会话历史里，用 `recall` 查。
     */
    remember(args) {
      if (docs === null || docs === undefined) {
        return { ok: false, code: 'docs_unavailable', message: '文档库没接上（工作区不可写？）' }
      }
      const title = String(args.title ?? '').trim()
      const body = String(args.body ?? '').trim()
      if (title === '' || body === '') return { ok: false, code: 'bad_request', message: '需要 title 与 body：一条没有标题或没有内容的"记忆"检索不到' }
      const id = String(args.id ?? '').trim() !== '' ? String(args.id) : slugOf(title)
      const written = docs.write({
        id,
        type: String(args.type ?? 'note'),
        title,
        owner: args.owner === undefined ? actorOf(args) ?? undefined : String(args.owner),
        // 涉及人/流程的判断要人点头（设计 07 §1.2）→ 默认 draft，等人确认再 active。
        status: String(args.status ?? 'draft'),
        body,
        ...(args.related === undefined ? {} : { related: args.related }),
        ...(args.source === undefined ? {} : { source: args.source }),
      })
      if (written.ok !== true) {
        return { ok: false, code: written.code ?? 'invalid_frontmatter', message: 'frontmatter 不合法，什么都没写', problems: written.problems ?? [] }
      }
      docs.rebuildIndex()
      return {
        ok: true,
        id: written.id,
        path: written.path,
        status: String(args.status ?? 'draft'),
        what: '已沉淀为 ' + written.path + '（draft 需要人确认后改成 active）',
      }
    },

    /**
     * 回忆（设计 07 §0.2）：一次提问同时查**沉淀知识**（工作区文档）、
     * **情景记忆**（DSH 会话历史）与**台账**（需求/任务/决策）。
     */
    async recall(args) {
      if (recall === null || recall === undefined) {
        return { ok: false, code: 'recall_unavailable', message: '回忆层没接上' }
      }
      const query = String(args.query ?? '').trim()
      if (query === '') return { ok: false, code: 'bad_request', message: '需要 query' }
      return recall.recall(query, { limit: Number.isFinite(args.limit) ? Number(args.limit) : 10 })
    },

    /** Ledger overview — cheap, read-only, the answer to "what is going on". */
    list(args) {
      const kind = typeof args.kind === 'string' && args.kind !== '' ? args.kind : 'task'
      const state = typeof args.state === 'string' && args.state !== '' ? args.state : null
      const reqFilter = typeof args.req === 'string' && args.req !== '' ? args.req : null
      let rows = store.all(kind)
      if (state !== null) rows = rows.filter((row) => row.state === state)
      if (reqFilter !== null) rows = rows.filter((row) => row.req === reqFilter || row.id === reqFilter)
      rows = rows.slice(0, Number.isFinite(args.limit) ? Number(args.limit) : 50)
      return {
        ok: true,
        kind,
        count: rows.length,
        rows: rows.map((row) => ({
          id: row.id,
          state: row.state ?? row.status ?? null,
          title: row.title ?? row.subject ?? null,
          assignee: row.assignee ?? row.holder ?? null,
          gates: row.gates !== undefined ? gateLine(row) : null,
        })),
      }
    },

    /** One object plus everything reachable from it. */
    show(args) {
      const id = String(args.id ?? '')
      if (id === '') return { ok: false, code: 'bad_request', message: '需要 id' }
      for (const kind of ['requirement', 'task', 'lease', 'decision']) {
        const doc = store.get(kind, id)
        if (doc === null) continue
        const related = {}
        if (kind === 'requirement') related.tasks = tasksOf(id).map((t) => ({ id: t.id, title: t.title, state: t.state, assignee: t.assignee }))
        if (kind === 'task') {
          related.requirement = loadRequirement(doc.req)
          related.lease = leaseOf(doc.id)
          related.actions = availableActions(doc)
          related.gates = gateLine(doc)
        }
        return { ok: true, kind, object: doc, related }
      }
      return { ok: false, code: 'not_found', message: '台账里没有 ' + id }
    },

    create_requirement(args) {
      const title = typeof args.title === 'string' && args.title !== '' ? args.title : null
      if (title === null) return { ok: false, code: 'bad_request', message: '需要 title' }
      const owner = actorFor({ actor: args.owner }, config.defaultOwner)
      const requester = actorFor({ actor: args.requester }, owner)
      const id = store.nextId('requirement')
      // The origin keeps the requirement traceable to where it was asked for:
      // a Feishu chat when it came from a group, `internal` when a session or a
      // person created it through this tool.
      const fromChat = typeof args.chat_id === 'string' && args.chat_id !== ''
      const doc = createRequirement(
        {
          id,
          title,
          type: typeof args.type === 'string' && args.type !== '' ? args.type : 'feature_delivery',
          origin: {
            surface: fromChat ? 'feishu' : 'internal',
            ...(fromChat ? { chat_id: args.chat_id } : {}),
            ...(typeof args.message_id === 'string' && args.message_id !== '' ? { thread: args.message_id } : {}),
            excerpts: Array.isArray(args.excerpts) ? args.excerpts.map(String) : [],
          },
          requester,
          owner,
          priority: typeof args.priority === 'string' && args.priority !== '' ? args.priority : 'P2',
          body: {
            problem: typeof args.problem === 'string' ? args.problem : '',
            proposal: typeof args.proposal === 'string' ? args.proposal : '',
          },
          acceptance_criteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String) : [],
          links: { repos: Array.isArray(args.repos) ? args.repos.map(String) : [] },
        },
        { now: nowDate() },
      )
      store.put('requirement', doc)
      return { ok: true, id: doc.id, state: doc.state, title: doc.title, owner: doc.owner, what: '需求已创建（draft）' }
    },

    confirm_requirement(args) {
      const req = loadRequirement(args.id)
      if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
      const result = transitionRequirement(req, 'confirm', actorFor(args, req.owner), transitionCtx(null, req))
      return commit('requirement', result, '需求已确认，等待拆解')
    },

    /**
     * Draft tasks under a requirement. They land in `proposed` — a bot proposes,
     * it does not assign (design doc 02 §5.1).
     */
    propose_tasks(args) {
      const req = loadRequirement(args.id)
      if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
      const drafts = Array.isArray(args.tasks) ? args.tasks : []
      if (drafts.length === 0) return { ok: false, code: 'bad_request', message: '需要 tasks 数组' }
      const created = []
      for (const draft of drafts) {
        if (draft === null || typeof draft !== 'object') continue
        const title = typeof draft.title === 'string' && draft.title !== '' ? draft.title : null
        if (title === null) continue
        const type = typeof draft.type === 'string' && draft.type !== '' ? draft.type : req.type
        /*
         * 域由**任务类型**推导（设计 03 §2.4②），模型显式给了才用它 —— 这句判断的
         * 意义是"谁会进确认名单"：以前 `domains` 完全由模型现给，于是"这活算开发还是
         * 算测试"取决于模型当天怎么想，而它决定了谁被拉进来点头。
         */
        const derived = domainsOfTaskType(config.taskTypes, type)
        const domains =
          Array.isArray(draft.domains) && draft.domains.length > 0 ? draft.domains.map(String) : derived.domains
        const assignee = typeof draft.assignee === 'string' && draft.assignee !== '' ? asPrincipal(draft.assignee) : null
        const id = store.nextId('task')
        /*
         * 验收人（设计 04 §3.5 跨域并行确认）：需求负责人 + 这个任务跨越的每个域的
         * 负责人（域里没人时用该域的 fallback）。**缺一方不推进** —— 这正是
         * acceptance 门禁列多个名字的用途（确认累积、人齐才完成）。
         */
        const confirmers = {
          confirm_split: [req.owner],
          accept: assignee === null ? [] : [assignee],
          start: assignee === null ? [] : [assignee],
          acceptance: acceptanceConfirmers(req, domains, assignee),
        }
        const gates = buildGates({ assignee, confirmers }, config.gates)
        const task = createTask(
          {
            id,
            req: req.id,
            title,
            type,
            domains,
            assignee,
            owner: assignee,
            acceptance_criteria: Array.isArray(draft.acceptance_criteria) ? draft.acceptance_criteria.map(String) : [],
            repo: typeof draft.repo === 'string' && draft.repo !== '' ? draft.repo : (req.links?.repos?.[0] ?? null),
            gates,
          },
          { now: nowDate() },
        )
        writeTask(task)
        created.push({ id: task.id, title: task.title, state: task.state, assignee: task.assignee })
      }
      if (created.length > 0) {
        store.put('requirement', { ...req, tasks: [...(req.tasks ?? []), ...created.map((t) => t.id)] })
      }
      const unknownTypes = drafts
        .map((draft) => (draft !== null && typeof draft === 'object' && typeof draft.type === 'string' ? draft.type : ''))
        .filter((type) => type !== '' && domainsOfTaskType(config.taskTypes, type).unknown === true)
      return {
        ok: true,
        count: created.length,
        tasks: created,
        what: '任务已提案（proposed），等需求负责人确认拆解',
        // 任务建出来了，但"这个类型没人认识"必须说出来，否则它会静默按开发域走。
        ...(unknownTypes.length === 0 ? {} : { unknown_types: [...new Set(unknownTypes)] }),
      }
    },

    /** Confirm the split: requirement → dispatched, its tasks → confirmed. */
    confirm_split(args) {
      const req = loadRequirement(args.id)
      if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
      const actor = actorFor(args, req.owner)
      const result = transitionRequirement(req, 'confirm_split', actor, transitionCtx(null, req))
      if (result.ok !== true) return { ok: false, code: result.code, message: result.message, pending: [] }
      let requirement = store.put('requirement', result.next)
      const promoted = []
      for (const task of tasksOf(requirement.id)) {
        if (task.state !== 'proposed') continue
        // The task-side action is `confirm_split`, not a bare `confirm`: the
        // state machine has no `confirm` for tasks (`confirm` is the
        // REQUIREMENT action draft → confirmed, one scope up). This is
        // proposed → confirmed; `assign` follows.
        const confirmed = transitionTask(task, 'confirm_split', actor, transitionCtx(task, requirement))
        if (confirmed.ok !== true) {
          promoted.push({ id: task.id, ok: false, code: confirmed.code, message: confirmed.message })
          continue
        }
        let next = confirmed.next
        if (next.assignee !== null) {
          const assigned = transitionTask(
            next,
            'assign',
            actor,
            transitionCtx(next, requirement, { suggestedAssignee: next.assignee }),
          )
          if (assigned.ok === true) next = assigned.next
          else promoted.push({ id: next.id, ok: false, code: assigned.code, message: assigned.message })
        }
        writeTask(next)
        promoted.push({ id: next.id, ok: true, state: next.state })
      }
      return { ok: true, id: requirement.id, state: requirement.state, tasks: promoted, what: '拆解已确认，任务已生成' }
    },

    assign_task(args) {
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const assignee = typeof args.assignee === 'string' && args.assignee !== '' ? asPrincipal(args.assignee) : task.assignee
      if (assignee === null) return { ok: false, code: 'bad_request', message: '需要 assignee' }
      const req = loadRequirement(task.req)
      // `assign` reads the executor from the context, not from the object: the
      // machine also recomputes `owner` and re-times the accept gate for a bot.
      const result = transitionTask(
        task,
        'assign',
        actorFor(args, req?.owner ?? config.defaultOwner),
        transitionCtx(task, req, { suggestedAssignee: assignee }),
      )
      return commit('task', result, '已指派给 ' + assignee)
    },

    accept_task(args) {
      const gateActor = actorFor(args, config.defaultOwner)
      const gateCheck = gateWrite(gateActor, null)
      if (gateCheck.ok !== true) return { ok: false, code: 'member_readonly', message: gateCheck.message }
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const req = loadRequirement(task.req)
      const actor = actorFor(args, task.assignee ?? task.owner ?? config.defaultOwner)
      const result = transitionTask(task, 'accept', actor, transitionCtx(task, req))
      if (result.ok !== true) return { ok: false, code: result.code, message: result.message, pending: result.pending ?? [] }
      const saved = writeTask(result.next)
      // Accepting starts the lease: "accepted but not moving" is the state most
      // worth watching (design doc 02 §5.3).
      const lease = openLease(saved, actor, DEFAULT_LEASE_POLICY, nowDate())
      store.put('lease', lease)
      return { ok: true, id: saved.id, state: saved.state, lease: { holder: lease.holder, expires_at: lease.expires_at }, what: '已接受（门禁 1 通过），租约已起' }
    },

    start_task(args) {
      const gateActor = actorFor(args, config.defaultOwner)
      const gateCheck = gateWrite(gateActor, null)
      if (gateCheck.ok !== true) return { ok: false, code: 'member_readonly', message: gateCheck.message }
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const req = loadRequirement(task.req)
      const actor = actorFor(args, task.assignee ?? task.owner ?? config.defaultOwner)
      const result = transitionTask(task, 'start', actor, transitionCtx(task, req))
      return commit('task', result, '已开始（门禁 2 通过）')
    },

    /**
     * THE HEART. Hand the task to a real DSH session and drive one turn.
     *
     * A human assignee must have passed both gates first: this action never
     * fabricates a confirmation on a person's behalf. A bot assignee gets the
     * documented auto-receipt (`assigned → in_progress` in one step), because
     * the gates exist to make people commit, not to make robots wait for
     * themselves.
     */
    async run_task(args) {
      let task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      let req = loadRequirement(task.req)
      const assignee = task.assignee
      if (assignee === null) return { ok: false, code: 'no_assignee', message: '任务还没有执行者，先 assign_task' }

      const autopilot = isBot(assignee)
      if (!autopilot) {
        if (task.state === 'assigned') {
          return {
            ok: false,
            code: 'gate_incomplete',
            message: '人承接的任务要先在接受者本人那里过两道门禁：accept_task → start_task（机器人不用）',
            pending: [assignee],
          }
        }
        if (task.state === 'accepted') {
          return { ok: false, code: 'gate_incomplete', message: '还差门禁 2（start_task）：请执行者本人确认开始', pending: [assignee] }
        }
        if (task.state !== 'in_progress') {
          return { ok: false, code: 'invalid_state', message: '任务当前是 ' + task.state + '，不能执行' }
        }
      } else {
        if (task.state === 'assigned') {
          for (const action of BOT_AUTO) {
            const stepped = transitionTask(task, action, assignee, transitionCtx(task, req))
            if (stepped.ok !== true) return { ok: false, code: stepped.code, message: stepped.message, pending: stepped.pending ?? [] }
            task = writeTask(stepped.next)
          }
          store.put('lease', openLease(task, assignee, DEFAULT_LEASE_POLICY, nowDate()))
        } else if (task.state === 'accepted') {
          const stepped = transitionTask(task, 'start', assignee, transitionCtx(task, req))
          if (stepped.ok !== true) return { ok: false, code: stepped.code, message: stepped.message, pending: stepped.pending ?? [] }
          task = writeTask(stepped.next)
        } else if (task.state !== 'in_progress') {
          return { ok: false, code: 'invalid_state', message: '任务当前是 ' + task.state + '，不能执行' }
        }
      }

      if (req === null) return { ok: false, code: 'orphan_task', message: '任务没有归属需求（违反完整性约束 1）' }

      /*
       * One session per task, reused across turns: a worker that already did
       * half the job keeps the context of having done it.
       */
      const run = store.get('session', task.id) ?? { id: task.id, session_id: 'team-' + task.id, turns: 0 }
      const spec = sessionSpecFor(config, task)
      const role = spec.role
      /*
       * 执行前的两道机器人闸：**能力**（角色默认 + 机器人自己的 cannot）与
       * **作用域**（scope.repos）。设计 02 §1.1 那张"绝不能做什么"的表以前
       * 只在文档里，代码里没有任何落点。
       */
      if (spec.botId !== null) {
        const bot = findBot(config.bots, spec.botId)
        if (bot !== null) {
          const canRun = botCan(bot, 'run_task')
          if (canRun.ok !== true) return { ok: false, code: 'bot_not_allowed', message: canRun.message }
          // 代码类任务额外看"能不能写代码"（需求机器人、调度机器人都不行）
          const codeish = ['code_change', 'defect_fix', 'feature_delivery', 'new_feature', 'data_change'].includes(String(task.type))
          if (codeish) {
            const canCode = botCan(bot, 'write_code')
            if (canCode.ok !== true) return { ok: false, code: 'bot_not_allowed', message: canCode.message }
          }
          const repoCheck = botCanTouchRepo(bot, task.repo)
          if (repoCheck.ok !== true) return { ok: false, code: 'bot_out_of_scope', message: repoCheck.message }
        }
      }
      let agent = null
      try {
        mkdirSync(config.workspace, { recursive: true })
        // The session is created ON DEMAND here, from the bot the task is assigned
        // to: there is nothing to pre-declare per role.
        agent = await pool.open({ sessionId: run.session_id, role, cwd: config.workspace, preset: spec.preset, model: spec.model })
      } catch (error) {
        return {
          ok: false,
          code: 'session_unavailable',
          message: '起不了执行会话：' + String(error && error.message ? error.message : error),
        }
      }

      const prompt = taskPrompt(task, req, { note: typeof args.note === 'string' ? args.note : '' })
      let driven = null
      try {
        driven = await pool.drive(agent, prompt, { timeoutMs: args.timeoutMs })
      } catch (error) {
        return { ok: false, code: 'drive_failed', message: '驱动会话失败：' + String(error && error.message ? error.message : error) }
      }

      /*
       * 这一轮的**事实**留在会话记录上：耗时 / 步数 / token。卡片 footer 要的
       * 就是这三个（设计 04 §3.1），而卡片是在**任何一次状态跃迁**时重画的，
       * 所以事实必须落盘 —— 否则"完成"那张卡上就没有上一轮的耗时。
       */
      store.put('session', {
        ...run,
        turns: Number(run.turns ?? 0) + 1,
        role,
        last_used: new Date().toISOString(),
        last_run: {
          at: new Date().toISOString(),
          elapsed_ms: Number(driven.elapsedMs ?? 0),
          steps: Number(driven.steps ?? 0),
          tokens: driven.tokens ?? null,
          timed_out: driven.timedOut === true,
        },
      })

      const report = typeof driven.text === 'string' ? driven.text.trim() : ''
      if (driven.timedOut && report === '') {
        return {
          ok: false,
          code: 'turn_timeout',
          message: '这一轮没有在时限内产出任何结论，任务留在 in_progress（会话 ' + run.session_id + ' 可以继续）',
          session_id: run.session_id,
          state: store.get('task', task.id)?.state ?? task.state,
        }
      }

      const evidence = {
        kind: 'note',
        ref: 'session:' + run.session_id,
        note: (report === '' ? '(本轮没有文本汇报)' : report).slice(0, 4000),
        at: new Date().toISOString(),
      }
      const withEvidence = { ...store.get('task', task.id), evidence: [...(store.get('task', task.id).evidence ?? []), evidence] }
      writeTask(withEvidence)

      const submitted = transitionTask(withEvidence, 'submit', assignee, transitionCtx(withEvidence, req))
      if (submitted.ok !== true) {
        return {
          ok: false,
          code: submitted.code,
          message: '执行完成但提交验收被拒：' + submitted.message,
          session_id: run.session_id,
          report,
        }
      }
      const saved = writeTask(submitted.next)
      return {
        ok: true,
        id: saved.id,
        state: saved.state,
        session_id: run.session_id,
        timedOut: driven.timedOut === true,
        report,
        evidence: evidence.ref,
        gates: gateLine(saved),
        what: '机器人执行完毕并提交验收（in_review）',
      }
    },

    /**
     * Submit for acceptance, optionally attaching one piece of evidence.
     *
     * Omitting the evidence is allowed ON PURPOSE: the refusal then comes from
     * the state machine (`evidence_required`), which is the one place the rule
     * lives. Rejecting the call here instead would produce a different code for
     * the same rule and teach the model that "no evidence" is a syntax error
     * rather than a rule of the workflow.
     */
    submit_task(args) {
      const gateActor = actorFor(args, config.defaultOwner)
      const gateCheck = gateWrite(gateActor, null)
      if (gateCheck.ok !== true) return { ok: false, code: 'member_readonly', message: gateCheck.message }
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const req = loadRequirement(task.req)
      const evidence = args.evidence
      const usable =
        evidence !== null &&
        typeof evidence === 'object' &&
        typeof evidence.ref === 'string' &&
        evidence.ref !== ''
      const current = usable
        ? {
            ...task,
            evidence: [
              ...(task.evidence ?? []),
              {
                kind: typeof evidence.kind === 'string' && evidence.kind !== '' ? evidence.kind : 'note',
                ref: evidence.ref,
                note: typeof evidence.note === 'string' ? evidence.note : undefined,
                at: new Date().toISOString(),
              },
            ],
          }
        : task
      const result = transitionTask(current, 'submit', actorFor(args, task.assignee ?? config.defaultOwner), transitionCtx(current, req))
      return commit('task', result, '已提交验收')
    },

    /** Acceptance: the author of the work may not be its judge. */
    verify_task(args) {
      const gateActor = actorFor(args, config.defaultOwner)
      const gateCheck = gateWrite(gateActor, 'acceptance')
      if (gateCheck.ok !== true) return { ok: false, code: 'member_readonly', message: gateCheck.message }
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const req = loadRequirement(task.req)
      const fallback = req !== null && req.owner !== task.assignee ? req.owner : config.defaultOwner
      const result = transitionTask(task, 'verify', actorFor(args, fallback), transitionCtx(task, req))
      const committed = commit(
        'task',
        result,
        result.partial === true ? '已记下这次验收（还差其他人）' : '验收通过，任务完成',
      )
      /*
       * 验收通过之后：如果这个需求的所有任务都完成了，需求本身也该走到头 ——
       * 设计 06 §7 完整性约束 2。以前没有人做这一步，于是需求永远停在 `dispatched`。
       */
      if (committed.ok === true && result.partial !== true) {
        const finished = tryFinishRequirement(task.req, actorFor(args, fallback))
        if (finished !== null) committed.requirement = finished
      }
      return committed
    },

    /**
     * 拒绝接活：`assigned → rejected`（设计 06 §4.1 / 02 §5.3）。
     *
     * 群里一直宣传这个动词（`DEFAULT_COMMANDS` 里的「拒绝」），handler 却不存在 ——
     * 人照着提示打过去只会得到"这个动作还没有接上"。设计明说"拒绝无需理由"，
     * 所以 `note` 可选；拒绝之后任务回到待派发（`assign` 现在也接受 `rejected`）。
     */
    reject_task(args) {
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const req = loadRequirement(task.req)
      const result = transitionTask(task, 'reject', actorFor(args, task.assignee ?? req?.owner ?? config.defaultOwner), transitionCtx(task, req))
      return commit('task', result, '已拒绝，任务回到待派发（换人或重新确认）')
    },

    /**
     * 阻塞：`in_progress/ci_running/in_review → blocked`（设计 02 §5.3）。
     *
     * 卡住必须说出来，否则"看起来一切正常"——所以 `note` 会被写进 `blocked_reason`，
     * 它也是之后 unblock 时唯一能回答"当时卡在哪"的东西。
     */
    block_task(args) {
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const note = typeof args.note === 'string' ? args.note.trim() : ''
      if (note === '') return { ok: false, code: 'bad_request', message: '阻塞要写一句原因（后来的人只能靠它知道当时卡在哪）' }
      const req = loadRequirement(task.req)
      const result = transitionTask(task, 'block', actorFor(args, task.assignee ?? req?.owner ?? config.defaultOwner), transitionCtx(task, req))
      if (result.ok !== true) return { ok: false, code: result.code, message: result.message, pending: result.pending ?? [] }
      const saved = commit('task', result, '已阻塞：' + note)
      // 原因写在对象上：`commit` 只管状态，`blocked_reason` 是它的说明。
      const task2 = store.get('task', saved.id)
      const withReason = writeTask({ ...task2, blocked_reason: note })
      return { ...saved, id: withReason.id, blocked_reason: note }
    },

    /**
     * 解除阻塞：`blocked → in_progress`。
     *
     * `blocked` 是必需的一条回路：没有它，被阻塞的任务只能靠 suspend/drop 处理，
     * 而那两条都会丢掉"它本来在做"这件事。
     */
    unblock_task(args) {
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const req = loadRequirement(task.req)
      const result = transitionTask(task, 'unblock', actorFor(args, task.assignee ?? req?.owner ?? config.defaultOwner), transitionCtx(task, req))
      if (result.ok !== true) return { ok: false, code: result.code, message: result.message, pending: result.pending ?? [] }
      const saved = commit('task', result, '已解除阻塞，继续做')
      const task2 = store.get('task', saved.id)
      writeTask({ ...task2, blocked_reason: null })
      return { ...saved, id: task2.id }
    },

    /**
     * 人工确认需求完成：`dispatched → done`（系统在最后一个任务验收后会自动做一次，
     * 这里给人一个明确入口 —— "这个需求结束了"有时是人的判断）。
     */
    finish_requirement(args) {
      const req = loadRequirement(args.id)
      if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
      const tasks = store.all('task')
      const open = tasks.filter((t) => t.req === req.id && t.state !== 'done' && t.state !== 'archived')
      const result = transitionRequirement(req, 'finish', actorFor(args, req.owner), {
        ...transitionCtx(null, req),
        allTasksDone: open.length === 0,
      })
      if (result.ok !== true) {
        return {
          ok: false,
          code: result.code,
          message: result.message,
          pending: open.map((t) => t.id),
        }
      }
      return commit('requirement', result, '需求已完成')
    },

    /** 归档：`done → archived`（视图转只读）。 */
    archive_requirement(args) {
      const req = loadRequirement(args.id)
      if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
      const result = transitionRequirement(req, 'archive', actorFor(args, req.owner), transitionCtx(null, req))
      return commit('requirement', result, '需求已归档（只读）')
    },

    /**
     * 需求变更：`confirmed|dispatched → changed`（设计 06 §3.1）。
     *
     * 设计要求它带**影响面清单**（受影响任务 / 已写测试 / 已开分支）。这里至少把
     * "受影响任务"算出来并挂起它们 —— 以前这个动作连入口都没有，
     * 于是"需求改了"只能靠人另建一个需求。
     */
    change_requirement(args) {
      const req = loadRequirement(args.id)
      if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
      const note = typeof args.note === 'string' ? args.note.trim() : ''
      if (note === '') return { ok: false, code: 'bad_request', message: '需求变更要写一句变了什么（影响面清单要有人看得懂的原因）' }
      const affected = store.all('task').filter((t) => t.req === req.id && t.state !== 'done' && t.state !== 'archived')
      const result = transitionRequirement(req, 'change', actorFor(args, req.owner), transitionCtx(null, req))
      if (result.ok !== true) return { ok: false, code: result.code, message: result.message, pending: result.pending ?? [] }
      const saved = commit('requirement', result, '需求已标记变更：' + note)
      // 受影响的任务置为 suspended（设计 06 §3.1 那张表里的 effects）
      const suspended = []
      for (const task of affected) {
        const stepped = transitionTask(task, 'suspend', actorFor(args, req.owner), transitionCtx(task, req))
        if (stepped.ok === true) {
          writeTask(stepped.next)
          suspended.push(task.id)
        }
      }
      return { ...saved, effects: [...(saved.effects ?? []), '受影响任务已挂起：' + (suspended.join('、') || '（没有）')], affected: suspended }
    },

    /** 变更确认：`changed → confirmed`（重走拆解）。 */
    reconfirm_requirement(args) {
      const req = loadRequirement(args.id)
      if (req === null) return { ok: false, code: 'not_found', message: '没有这个需求：' + String(args.id) }
      const result = transitionRequirement(req, 'reconfirm', actorFor(args, req.owner), transitionCtx(null, req))
      return commit('requirement', result, '变更已确认，重走拆解')
    },

    /** 需求挂起/恢复/废弃/阻塞/解除阻塞：治理类动作，只有需求负责人或 pm 能做。 */
    suspend_requirement(args) {
      return requirementAction(args, 'suspend', '需求已挂起')
    },
    resume_requirement(args) {
      return requirementAction(args, 'resume', '需求已恢复')
    },
    drop_requirement(args) {
      const note = typeof args.note === 'string' ? args.note.trim() : ''
      if (note === '') return { ok: false, code: 'bad_request', message: '废弃要写原因（设计 06 §3.1：* → dropped 需填原因）' }
      const result = requirementAction(args, 'drop', '需求已废弃：' + note)
      if (result.ok === true) {
        const req = store.get('requirement', result.id)
        store.put('requirement', { ...req, body: { ...(req.body ?? {}), problem: (req.body?.problem ?? '') , proposal: (req.body?.proposal ?? ''), drop_reason: note } })
      }
      return result
    },
    block_requirement(args) {
      return requirementAction(args, 'block', '需求被外部依赖阻塞')
    },
    unblock_requirement(args) {
      return requirementAction(args, 'unblock', '需求已解除阻塞')
    },

    /**
     * 指定/更换一个群的**主机器人**（群里所有消息的记录归属）。
     *
     * 主在首次接触时自动定下（见 `lib/bots.js` 的 `pickPrimaryBot`），此后**不变** ——
     * 但人要能改：一个群从"需求阶段"进入"开发阶段"时，把它交给开发机器人是正常的
     * 治理动作。这是显式动作，所以要 actor，也会记下是谁、什么时候改的。
     */
    set_primary_bot(args) {
      const chatId = typeof args.id === 'string' ? args.id : ''
      const chat = chatId === '' ? null : store.get('chat', chatId)
      if (chat === null) return { ok: false, code: 'not_found', message: '没有这个群：' + String(chatId) }
      const botId = typeof args.assignee === 'string' ? args.assignee.replace(/^bot:/, '') : ''
      const bot = findBot(config.bots, botId)
      if (bot === null) return { ok: false, code: 'not_found', message: '名册里没有这个机器人：' + String(botId) }
      const actor = actorFor(args, config.defaultOwner)
      const at = new Date().toISOString()
      store.put('chat', {
        ...chat,
        primary_bot_id: bot.id,
        primary_since: at,
        primary_changed_by: actor,
        // 主换了，这个群的记录从这里开始归新的机器人：给它建一段会话记录。
        previous_primary_bot_id: chat.primary_bot_id ?? chat.bot_id ?? null,
      })
      try {
        noteMessage(store, { botId: bot.id, chatId, chatType: chat.chat_type, workspace: chat.workspace, at, text: '' })
      } catch (error) {
        /* 记录是尽力而为：换主本身已经成立 */
      }
      return { ok: true, id: chatId, state: bot.id, what: '这个群的主机器人已改成 ' + bot.displayName + '（' + bot.id + '）' }
    },

    /** 群列表：主机器人、消息数、最后活动（面板「会话」页与排查"这个群归谁"用）。 */
    list_chats() {
      const rows = store.all('chat').map((chat) => {
        const primary = findBot(config.bots, chat.primary_bot_id ?? chat.bot_id ?? '')
        return {
          id: chat.id,
          title: typeof chat.title === 'string' ? chat.title : null,
          chatType: chat.chat_type ?? null,
          appId: chat.app_id ?? null,
          primaryBotId: primary === null ? null : primary.id,
          primaryBotName: primary === null ? null : primary.displayName,
          primarySince: chat.primary_since ?? null,
          lastBotId: chat.last_bot_id ?? null,
          messages: Number(chat.messages ?? 0),
          turns: Number(chat.turns ?? 0),
          lastSeen: chat.last_seen ?? null,
          lastReplyAt: chat.last_reply_at ?? null,
          lastInbound: chat.last_inbound ?? null,
        }
      })
      return { ok: true, rows }
    },

    /**
     * 转派：`accepted → assigned`（新执行者 = 参数给的 assignee）。
     *
     * 设计 02 §5.3 里"派错了怎么办"的回路之一，卡片上一直有它的位置，
     * 状态机里也一直有这个动作（`reassign`）—— 缺的就是入口。
     * 门禁会跟着新执行者重置：**新执行者仍需点接受**。
     */
    reassign_task(args) {
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const who = typeof args.assignee === 'string' ? args.assignee.trim() : ''
      if (who === '') return { ok: false, code: 'bad_request', message: '转派要给出新的执行者（human:<名字> 或 bot:<角色>）' }
      const req = loadRequirement(task.req)
      const result = transitionTask(task, 'reassign', actorFor(args, task.assignee), {
        ...transitionCtx(task, req),
        suggestedAssignee: who,
      })
      if (result.ok !== true) return { ok: false, code: result.code, message: result.message, pending: result.pending ?? [] }
      const saved = commit('task', result, '已转派给 ' + who + '（新执行者仍需点接受）')
      // 转派意味着旧的租约不再代表当前执行者：释放它，否则"谁在干这活"有两个答案。
      const lease = store.get('lease', task.id)
      if (lease !== null && lease.state === 'active') store.put('lease', { ...lease, state: 'released', release_reason: 'reassigned' })
      return saved
    },

    /**
     * CI 状态机（设计 03 §1.5）：`in_progress → ci_running → passed/failed`。
     *
     * 状态机里一直有这三个动作（`ci_start` / `ci_pass` / `ci_fail`），但**没有入口** ——
     * 于是"长流水线看起来像卡住"这件事在群里没有任何痕迹。`op=status` 顺带把
     * `ci_stuck`（超时未结论）算出来，tick 会把它播报出去。
     */
    ci(args) {
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const op = typeof args.op === 'string' && args.op !== '' ? args.op : 'status'
      const now = nowDate()
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : Number(config.repos?.ciTimeoutMs)
      if (op === 'status') {
        return { ok: true, id: task.id, state: task.state, ci: ciState(task, { timeoutMs, now }) }
      }
      if (op !== 'start' && op !== 'pass' && op !== 'fail') {
        return { ok: false, code: 'bad_request', message: 'op 是 start | pass | fail | status' }
      }
      const req = loadRequirement(task.req)
      const actor = actorFor(args, task.assignee ?? req?.owner ?? config.defaultOwner)
      const action = op === 'start' ? 'ci_start' : op === 'pass' ? 'ci_pass' : 'ci_fail'
      const result = transitionTask(task, action, asPrincipal(actor), transitionCtx(task, req))
      if (result.ok !== true) return { ok: false, code: result.code, message: result.message, pending: result.pending ?? [] }

      /*
       * `task.ci` 是**记账**，不是状态机：CI 的结论（url / summary / 什么时候开始）
       * 要让卡片、门禁判定与观测页都能读到，所以写在任务对象上。
       */
      const summary = typeof args.summary === 'string' ? args.summary : undefined
      const url = typeof args.url === 'string' ? args.url : undefined
      const ci = ciPatch(result.next, {
        state: op === 'start' ? 'running' : op === 'pass' ? 'passed' : 'failed',
        ...(summary === undefined ? {} : { summary }),
        ...(url === undefined ? {} : { url }),
      }, now)
      const saved = writeTask({ ...result.next, ci })
      const describe =
        op === 'start'
          ? '已进入等 CI（' + task.id + '）'
          : op === 'pass'
            ? 'CI 通过，转验收（' + task.id + '）'
            : 'CI 失败，退回执行者（' + task.id + '）'
      return {
        ok: true,
        id: saved.id,
        state: saved.state,
        ci: ciState(saved, { timeoutMs, now }),
        what: describe,
        ...(summary === undefined ? {} : { summary }),
      }
    },

    /**
     * 仓库这一侧（设计 03 §1.3–§1.7）。
     *
     * **先说清楚做不到的**：公网 webhook 与卡片按钮都不存在，所以这里的"链接 MR / 审批 /
     * 合并"是**记账与判定**，真正开 MR 与合并的是执行会话里的 `git` / `gh`。
     * 这个动作的价值在于：能不能合并由**判定**说话，而不是靠提示词。
     */
    async repo(args) {
      const op = typeof args.op === 'string' && args.op !== '' ? args.op : 'branch'
      if (op === 'branch') {
        const task = args.id === undefined ? null : loadTask(args.id)
        const reqId = String(args.req ?? task?.req ?? '')
        if (reqId === '') return { ok: false, code: 'bad_request', message: '需要 id（任务）或 req（需求）' }
        const req = loadRequirement(reqId)
        const branch = branchName({ requirementId: reqId, taskId: task?.id, slug: args.slug ?? req?.title ?? '' })
        return {
          ok: true,
          branch,
          trailers: commitTrailers({ requirementId: reqId, taskId: task?.id }),
          problems: typeof args.message === 'string' ? commitProblems(args.message, { requirementId: reqId, taskId: task?.id }) : [],
          what: '分支 ' + String(branch) + '；提交信息末尾带 Req/Task trailer，代码历史才与需求对得上',
        }
      }

      if (op === 'index' || op === 'overview') {
        const repoName = String(args.repo ?? '')
        if (repoName === '') return { ok: false, code: 'bad_request', message: '需要 repo 名字' }
        const root = repoRootOf(config, repoName, args.path)
        if (root === null) {
          return {
            ok: false,
            code: 'no_repo_path',
            message: '不知道 ' + repoName + ' 的检出在哪：在配置里写 repos.roots.' + repoName + '（或传 path）',
          }
        }
        const index = indexRepo(root)
        if (index.ok !== true) return { ok: false, code: index.code, message: index.message }
        if (op === 'index') {
          return {
            ok: true,
            repo: repoName,
            root,
            dirs: index.dirs,
            testDirs: index.testDirs,
            ciFiles: index.ciFiles,
            scripts: Object.keys(index.scripts ?? {}),
            what: '扫到 ' + String(index.dirs.length) + ' 个顶层目录、' + String((index.testDirs ?? []).length) + ' 个测试目录',
          }
        }
        if (docs === null || docs === undefined) return { ok: false, code: 'docs_unavailable', message: '文档库没接上，写不了仓库概览' }
        const spec = overviewDoc(repoName, index, {
          owner: actorFor(args, config.defaultOwner) ?? config.defaultOwner,
          status: String(args.status ?? 'draft'),
        })
        const written = docs.write(spec)
        if (written.ok !== true) {
          return { ok: false, code: written.code ?? 'invalid_frontmatter', message: '概览文档写入被拒', problems: written.problems ?? [] }
        }
        docs.rebuildIndex()
        return {
          ok: true,
          repo: repoName,
          path: written.path,
          id: written.id,
          dirs: index.dirs.length,
          what: '仓库概览已写到 ' + written.path + '（职责那一栏要人补）',
        }
      }

      const task = args.id === undefined ? null : loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '需要 id（任务）：MR 的记账挂在任务上' }

      if (op === 'link_mr') {
        const url = String(args.url ?? '')
        if (url === '') return { ok: false, code: 'bad_request', message: '需要 url（MR 链接）' }
        const actor = actorFor(args, task.assignee ?? config.defaultOwner)
        const sensitive = sensitiveFiles(args.files)
        const mr = {
          url,
          branch: String(args.branch ?? task.branch ?? branchName({ requirementId: task.req, taskId: task.id, slug: task.title }) ?? ''),
          repo: String(args.repo ?? task.repo ?? ''),
          by: actor,
          at: nowDate().toISOString(),
          approvals: Array.isArray(task.mr?.approvals) ? task.mr.approvals : [],
          ...(sensitive.length === 0 ? {} : { sensitive_files: sensitive }),
          merged_at: null,
        }
        const saved = writeTask({ ...task, mr, branch: mr.branch, ...(mr.repo === '' ? {} : { repo: mr.repo }) })
        /*
         * 敏感文件 → **相关文档标记陈旧**（设计 03 §1.4）：改了接口契约/迁移/配置模板，
         * 描述它的那些文档就过时了，而"过时"必须有人看得见 —— 否则团队记忆会变成
         * "信誓旦旦的错误答案库"。
         */
        const marked = markRelatedDocsStale(mr.repo, sensitive)
        return {
          ok: true,
          id: saved.id,
          mr: saved.mr,
          sensitive,
          stale_docs: marked,
          what:
            sensitive.length === 0
              ? 'MR 已记账'
              : 'MR 已记账；动到了 ' + sensitive.map((one) => one.why).join('、') + '，相关文档标成 stale',
        }
      }

      if (op === 'approve') {
        const actor = actorFor(args, '')
        if (actor === '') return { ok: false, code: 'bad_request', message: '审批必须说明是谁在批（没有 actor 的写操作一律拒绝）' }
        const member = (members.list ?? []).find((one) => one.key === actor) ?? null
        const allowed = Array.isArray(member?.canApprove) ? member.canApprove : []
        if (allowed.length === 0) {
          return {
            ok: false,
            code: 'not_approver',
            message: actor + ' 不在任何域的可批准名单里（成员表的 canApprove）——设计 03 §1.4 的"至少一个人类审批"就是这样被挡住的',
          }
        }
        const approvals = (Array.isArray(task.mr?.approvals) ? task.mr.approvals : []).filter((one) => one?.by !== actor)
        approvals.push({
          by: actor,
          at: nowDate().toISOString(),
          domains: allowed,
          note: typeof args.note === 'string' ? args.note : null,
          approved: args.approved !== false,
        })
        const saved = writeTask({ ...task, mr: { ...(task.mr ?? {}), approvals } })
        return { ok: true, id: saved.id, approvals: saved.mr.approvals.length, what: actor + ' 审批了 MR' }
      }

      if (op === 'merge') {
        const actor = actorFor(args, '')
        const decision = mergeDecision(task, {
          actor,
          requiredApprovals: Number.isFinite(args.requiredApprovals) ? Number(args.requiredApprovals) : Number(config.repos?.requiredApprovals),
          ciTimeoutMs: Number(config.repos?.ciTimeoutMs),
          allowAutoMerge: config.repos?.autoMerge === true,
          actorIsOps: actorIsOps(config, actor),
          actorCanApprove: (members.list ?? []).find((one) => one.key === actor)?.canApprove ?? [],
          now: nowDate(),
        })
        if (decision.ok !== true) {
          return { ok: false, code: 'merge_blocked', message: decision.blockers.map((one) => one.message).join('；'), blockers: decision.blockers }
        }
        const at = nowDate().toISOString()
        const merged = { ...task, mr: { ...(task.mr ?? {}), merged_at: at, merged_by: actor } }
        // 合并之后任务该往前走：CI 已经通过了，`ci_pass` 把它送进验收。
        const req = loadRequirement(task.req)
        const next = merged.state === 'ci_running' ? transitionTask(merged, 'ci_pass', asPrincipal(actor), transitionCtx(merged, req)) : { ok: true, next: merged }
        const saved = writeTask(next.ok === true ? next.next : merged)
        return { ok: true, id: saved.id, state: saved.state, merged_at: at, what: 'MR 已合并（' + actor + '），任务进入 ' + saved.state }
      }

      return { ok: false, code: 'bad_request', message: 'op 是 branch | index | overview | link_mr | approve | merge' }
    },

    /**
     * 验收打回：`in_review → in_progress`（设计 06 §4.1 表末行）。
     *
     * 卡片上一直带着这个按钮、状态机现在也有这个动作，缺的只是入口 —— 没有入口的
     * 动作等于不存在，而"验收没过要能打回"是人最常用的回路之一。
     */
    reject_review(args) {
      const task = loadTask(args.id)
      if (task === null) return { ok: false, code: 'not_found', message: '没有这个任务：' + String(args.id) }
      const req = loadRequirement(task.req)
      const result = transitionTask(task, 'reject_review', actorFor(args, req?.owner ?? config.defaultOwner), {
        ...transitionCtx(task, req),
        reason: typeof args.note === 'string' ? args.note : '',
      })
      return commit('task', result, '验收未通过，已打回继续做')
    },

    /**
     * 记一条决策（ADR）：设计 06 §6 的第四个一等对象。
     *
     * 它此前是**只有 schema 没有入口**的对象：`parseDecision` 除了测试没人调用，
     * 而 store 的 id 前缀（`dec-`）与 schema 的正则（`adr-`）互相矛盾 —— 真去造一条
     * 会立刻抛校验错。决策的价值是"以后能回答为什么这么定"，所以正文与理由一起进
     * `title`/`related`，而不是只留一个 id。
     *
     * 形状**照 schema 来**（`lib/domain/schema.js` `decisionValue`），不自己发明字段：
     * `{ id, title, status, owner, date, supersedes[], related{requirements,tasks,repos}, source? }`。
     * 第一版我按"state/decided_by/body/links"写了一版，parse 直接报
     * `decision.status: Required` —— 这正是"先读 schema 再写代码"的那一课。
     */
    record_decision(args) {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (title === '') return { ok: false, code: 'bad_request', message: '决策需要一个标题（它是一句话的结论）' }
      const actor = actorFor(args, config.defaultOwner)
      const requirement = typeof args.req === 'string' && args.req !== '' ? args.req : null
      const task = typeof args.id === 'string' && args.id !== '' ? args.id : null
      const status = DECISION_STATUSES.includes(args.status) ? args.status : 'accepted'
      const decision = {
        id: store.nextId('decision', nowDate()),
        title,
        status,
        owner: actor,
        date: new Date().toISOString().slice(0, 10),
        supersedes: Array.isArray(args.supersedes) ? args.supersedes.map((one) => String(one)) : [],
        related: {
          requirements: requirement === null ? [] : [requirement],
          tasks: task === null ? [] : [task],
          repos: Array.isArray(args.repos) ? args.repos.map((one) => String(one)) : [],
        },
        // 决策从哪来：模型用工具记的是 `dsh_session`，群里那条命令记的是 `feishu_chat`。
        source: { kind: typeof args.source === 'string' && DECISION_SOURCE_KINDS.includes(args.source) ? args.source : 'dsh_session', ref: typeof args.note === 'string' ? args.note : '' },
      }
      let saved = null
      try {
        saved = store.put('decision', parseDecision(decision))
      } catch (error) {
        return { ok: false, code: 'invalid', message: String(error && error.message ? error.message : error) }
      }
      /*
       * 双向可追（设计 06 §2）：需求那一侧也记一条引用，这样"这个需求为什么这么定"
       * 从需求对象就能翻到决策，不用全库扫 decisions/。
       */
      if (requirement !== null) {
        const req = loadRequirement(requirement)
        if (req !== null) {
          const decisions = Array.isArray(req.decisions) ? req.decisions : []
          store.put('requirement', { ...req, decisions: [...new Set([...decisions, saved.id])] })
        }
      }
      return { ok: true, id: saved.id, what: '已记下决策：' + title, state: saved.status }
    },

    /**
     * Time-driven sweep: gate timeouts and lease expiry.
     *
     * Dry by default, and the dry run is honest — it reports exactly the
     * transitions it would take without touching a single object.
     */
    tick(args) {
      const dryRun = args.dry_run !== false
      const now = nowDate()
      const tasks = store.all('task')
      const leases = store.all('lease')
      const due = scanDue({ now, tasks, leases })
      const decided = []

      for (const item of due.gates) {
        const action = dueAction(item)
        if (action === null) {
          /*
           * 只催办、不动状态 —— 但**必须真的催**：这条以前只往 `decided` 里推一行，
           * 于是"门禁超时会提醒人"这句设计承诺在群里没有任何痕迹。
           */
          announceTick({
            task: item.task,
            title: '⏳ 门禁超时（只催办）',
            status: taskLabel(item.task) + ' · ' + item.gate + ' 已超时',
            pendingGates: [{ name: item.gate, pending: gatePendingOf(item.task, item.gate) }],
            reason: item.gate,
          })
          decided.push({ task: item.task.id, gate: item.gate, action: 'notify_only', what: '只催办，不动状态', notified: true })
          continue
        }
        const actor = item.task.assignee ?? item.task.owner ?? config.defaultOwner
        if (dryRun) {
          decided.push({ task: item.task.id, gate: item.gate, action, dry_run: true })
          continue
        }
        const result = transitionTask(item.task, action, asPrincipal(actor), transitionCtx(item.task, loadRequirement(item.task.req)))
        if (result.ok !== true) {
          // `escalate` 不是失败：它是"不再轮回派发，升级给人"——而升级必须让人知道。
          const escalated = result.code === 'escalate'
          if (escalated) {
            announceTick({
              task: item.task,
              title: '🔺 需要人决定（已升级）',
              status: taskLabel(item.task) + ' · ' + item.gate,
              lines: [String(result.message ?? '')],
              pendingGates: [{ name: 'escalation', pending: escalationTargets(item.task, loadRequirement(item.task.req)) }],
              reason: 'escalate',
            })
          }
          decided.push({ task: item.task.id, gate: item.gate, action, ok: false, code: result.code, message: result.message, notified: escalated })
          continue
        }
        const saved = writeTask(result.next)
        // 状态真的变了 → `writeTask` 已经原地更新了那张任务卡（消息就在那里），
        // 不另发一条通知：同一个话题出现两张卡正是设计要避免的刷屏。
        decided.push({ task: saved.id, gate: item.gate, action, ok: true, state: saved.state, release_count: saved.release_count, notified: true })
      }

      /*
       * `ci_stuck`：长流水线看起来就像"卡住了"，不播报人就会以为机器人在偷懒
       * （设计 03 §1.5 把它单列成一条分支，理由就是这个）。判定不改状态 ——
       * CI 慢不等于失败，结论来了照样能进 `passed`。
       */
      for (const task of tasks) {
        if (task.state !== 'ci_running') continue
        const ci = ciState(task, { timeoutMs: Number(config.repos?.ciTimeoutMs), now })
        if (ci.stuck !== true || ci.notified === true) continue
        if (dryRun) {
          decided.push({ task: task.id, ci: 'ci_stuck', dry_run: true })
          continue
        }
        announceTick({
          task,
          title: '⏳ CI 迟迟没有结论',
          status: taskLabel(task) + ' · 已经等了 ' + String(Math.round(ci.elapsedMs / 60000)) + ' 分钟',
          lines: [
            'CI 从 ' + String(ci.startedAt ?? '（没有开始时间）') + ' 起就没有结论。',
            '这不是失败：它只是还没回来。要么去 CI 上看一眼，要么把它当失败退回执行者',
            '（`ci op=fail`）—— 但**不要让它静默地卡着**。',
          ],
          reason: 'ci_stuck',
        })
        writeTask({ ...task, ci: { ...(task.ci ?? {}), stuck_notified_at: now.toISOString() } })
        decided.push({ task: task.id, ci: 'ci_stuck', notified: true, waited_ms: ci.elapsedMs })
      }

      for (const item of due.leases) {
        const lease = leaseOf(item.task_id)
        if (lease === null) continue
        const verdict = leaseVerdict(lease, DEFAULT_LEASE_POLICY, now)
        if (verdict.kind === 'ok') continue
        if (dryRun) {
          decided.push({ task: item.task_id, lease: verdict.kind, dry_run: true })
          continue
        }
        if (verdict.kind === 'notify') {
          const noticed = { ...lease, state: 'expired', expiry_notices: Number(lease.expiry_notices ?? 0) + 1 }
          store.put('lease', noticed)
          const leased = loadTask(item.task_id)
          if (leased !== null) {
            announceTick({
              task: leased,
              title: '⏰ 租约已过期',
              status: taskLabel(leased) + ' · 宽限期内不动任务',
              lines: ['请决定：让执行者续约，还是收回任务重新走两道确认。'],
              pendingGates: [{ name: 'lease', pending: escalationTargets(leased, loadRequirement(leased.req)) }],
              reason: 'lease_expired',
            })
          }
          decided.push({ task: item.task_id, lease: 'notify', ok: true, what: '租约过期，已播报（宽限期内不动任务）', notified: leased !== null })
          continue
        }
        const task = loadTask(item.task_id)
        if (task === null) continue
        const result = transitionTask(task, 'timeout_lease', task.assignee ?? task.owner ?? config.defaultOwner, transitionCtx(task, loadRequirement(task.req)))
        if (result.ok !== true) {
          decided.push({ task: item.task_id, lease: 'reclaim', ok: false, code: result.code, message: result.message })
          continue
        }
        const saved = writeTask(result.next)
        store.put('lease', { ...lease, state: 'returned', release_reason: 'expired' })
        decided.push({ task: saved.id, lease: 'reclaim', ok: true, state: saved.state, notified: true })
      }

      return { ok: true, dry_run: dryRun, gates: due.gates.length, leases: due.leases.length, decided }
    },
  }

  return actions
}

/** Which role a task's worker session runs as: the bot's role, else its first domain. */
function roleOf(config, task) {
  const assignee = typeof task.assignee === 'string' ? task.assignee : ''
  if (assignee.startsWith('bot:')) {
    // With a roster, `bot:dev` is a ROW, and its role is whatever that row says — a
    // project bot called `dev-pay` may hold the `dev` role, but the id is the
    // identity and the role is a property of it.
    const bot = findBot(config.bots, assignee)
    if (bot !== null) return bot.role
    return assignee.slice(4)
  }
  const domains = Array.isArray(task.domains) ? task.domains : []
  return domains.length > 0 ? domains[0] : 'dev'
}

/**
 * The session identity a task runs under.
 *
 * THE BOT IS THE SOURCE, NOT THE ROLE TABLE. A task is assigned to `bot:<id>`, so
 * that bot's own `agentPreset` and `model.primary` are what the executing session
 * must use — otherwise the roster would be a display-only object and "this bot runs
 * on the fast model" would quietly mean nothing. The role mapping and the global
 * defaults remain the FALLBACK: for a task assigned to a `bot:` id that is not in the
 * roster (a ledger written before the roster existed), and for human-assigned work
 * that has only a domain.
 *
 * @returns {{role: string, botId: string|null, preset?: string, model?: string}}
 */
export function sessionSpecFor(config, task) {
  const assignee = task !== null && typeof task === 'object' && typeof task.assignee === 'string' ? task.assignee : ''
  const bot = assignee.startsWith('bot:') ? findBot(config.bots, assignee) : null
  const spec = { role: roleOf(config, task), botId: bot === null ? null : bot.id }
  if (bot !== null) {
    if (typeof bot.agentPreset === 'string' && bot.agentPreset !== '') spec.preset = bot.agentPreset
    if (typeof bot.model?.primary === 'string' && bot.model.primary !== '') spec.model = bot.model.primary
  }
  return spec
}

/** Human-readable rendering of one handled call, used as the tool's content. */
function render(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (value.ok === false) {
    const pending = Array.isArray(value.pending) && value.pending.length > 0 ? '（还差：' + value.pending.join('、') + '）' : ''
    return '✖ ' + String(value.message ?? value.code) + pending
  }
  const lines = []
  if (typeof value.what === 'string' && value.what !== '') lines.push(value.what)
  if (typeof value.id === 'string') lines.push('对象：' + value.id + (value.state !== undefined && value.state !== null ? '（' + String(value.state) + '）' : ''))
  if (typeof value.title === 'string') lines.push('标题：' + value.title)
  if (typeof value.gates === 'string' && value.gates !== '') lines.push('门禁：' + value.gates)
  if (typeof value.session_id === 'string') lines.push('会话：' + value.session_id)
  if (typeof value.report === 'string' && value.report !== '') lines.push('汇报：' + value.report)
  if (Array.isArray(value.rows)) {
    lines.push('共 ' + value.rows.length + ' 条：')
    for (const row of value.rows) {
      lines.push('  - ' + [row.id, row.state, row.title, row.assignee === null || row.assignee === undefined ? '' : '@' + String(row.assignee), row.gates ?? ''].filter(Boolean).join(' | '))
    }
  }
  if (Array.isArray(value.tasks)) {
    for (const row of value.tasks) {
      lines.push('  - ' + (row.ok === false ? '✖ ' : '') + String(row.id) + ' ' + String(row.state ?? row.message ?? '') + (row.title !== undefined ? ' ' + String(row.title) : ''))
    }
  }
  if (Array.isArray(value.decided)) {
    lines.push('到期处理 ' + value.decided.length + ' 项：')
    for (const row of value.decided) lines.push('  - ' + JSON.stringify(row))
  }
  if (lines.length === 0) lines.push(JSON.stringify(value))
  return lines.join('\n')
}

/**
 * The tool definition handed to `ctx.tools.register`.
 *
 * `execute` never throws for a business refusal: a refused transition is a
 * normal answer the model must read and act on, not an exception.
 *
 * @param {object} handlers the action table from {@link createHandlers}
 * @param {{isWorker?: (agentId: string) => boolean}} [options] `isWorker` marks
 *   the sessions this plugin drives. They must NOT edit the ledger: a worker
 *   reporting "done" through the tool would let a task write its own evidence
 *   and advance its own state, and a worker that could call `run_task` could
 *   recurse. The worker's final message is the report; the team layer records it.
 */
export function buildTeamTool(handlers, options = {}) {
  const isWorker = typeof options.isWorker === 'function' ? options.isWorker : () => false
  return {
    name: 'team',
    description:
      '团队协作台账：需求（requirement）、任务（task）、租约（lease）与两道人工确认门禁。' +
      'action=create_requirement 建需求；propose_tasks 拆任务（落 proposed）；confirm_split 确认拆解；' +
      'assign_task/accept_task/start_task 指派与两道确认；run_task 把任务交给一个真实的 DSH 执行会话跑一轮并回写证据；' +
      'submit_task/verify_task 提交与验收；reject_review 验收打回；reject_task/block_task/unblock_task 拒绝与阻塞回路；' +
      'record_decision 记一条决策（ADR）；tick 扫门禁与租约超时；list/show 查台账；' +
      'docs 维护工作区文档库（frontmatter 是硬要求，缺 owner 会被拒；op=stale 看哪些文档过期了）；' +
      'remember 把一条结论沉淀成文档草稿；recall 同时查文档、DSH 会话历史与台账；' +
      'ci 推进 CI 状态机（start/pass/fail，卡住会被 tick 播报）；' +
      'repo 给分支名与提交 trailer、扫仓库出概览、记 MR 与审批、判"能不能合并"。' +
      '状态机自己会拒绝不合法的跃迁（返回 ok:false + code），照它的意思办，不要绕过门禁。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create_requirement',
            'confirm_requirement',
            'propose_tasks',
            'confirm_split',
            'assign_task',
            'accept_task',
            'start_task',
            'run_task',
            'submit_task',
            'verify_task',
            'reject_review',
            'reassign_task',
            'reject_task',
            'block_task',
            'unblock_task',
            'record_decision',
            'docs',
            'remember',
            'recall',
            'ci',
            'repo',
            'finish_requirement',
            'archive_requirement',
            'change_requirement',
            'reconfirm_requirement',
            'suspend_requirement',
            'resume_requirement',
            'drop_requirement',
            'block_requirement',
            'unblock_requirement',
            'set_primary_bot',
            'list_chats',
            'tick',
            'list',
            'show',
          ],
          description: '要执行的动作',
        },
        id: { type: 'string', description: '对象 id（req-2026-001 / task-1 / …）' },
        title: { type: 'string', description: 'create_requirement 的标题' },
        owner: { type: 'string', description: '需求负责人，形如 human:wangmengfan；缺省用配置里的 defaultOwner' },
        requester: { type: 'string', description: '提出人，形如 human:xxx' },
        actor: { type: 'string', description: '本次动作的actor（谁在点这个按钮），形如 human:xxx / bot:dev' },
        problem: { type: 'string', description: '需求要解决的问题' },
        proposal: { type: 'string', description: '建议方案' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: '优先级，默认 P2' },
        type: { type: 'string', description: '任务类型，默认 feature_delivery' },
        repos: { type: 'array', items: { type: 'string' }, description: '关联代码库名' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, description: '验收标准' },
        tasks: {
          type: 'array',
          description: 'propose_tasks 的任务草案',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              domains: { type: 'array', items: { type: 'string' } },
              assignee: { type: 'string', description: '形如 human:zhouyu / bot:dev' },
              acceptance_criteria: { type: 'array', items: { type: 'string' } },
              repo: { type: 'string' },
              type: { type: 'string' },
            },
            required: ['title'],
          },
        },
        assignee: { type: 'string', description: 'assign_task 的执行者' },
        evidence: {
          type: 'object',
          description: 'submit_task 的证据',
          properties: {
            kind: { type: 'string', enum: ['test', 'diff', 'artifact', 'link', 'note'] },
            ref: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ref'],
        },
        note: { type: 'string', description: 'run_task 给执行会话的补充说明' },
        timeoutMs: { type: 'number', description: 'run_task 等待一轮结束的时限（毫秒）' },
        kind: { type: 'string', enum: ['requirement', 'task', 'lease', 'decision'], description: 'list 查哪一类对象' },
        state: { type: 'string', description: 'list 的状态过滤' },
        req: { type: 'string', description: 'list 的需求过滤' },
        limit: { type: 'number', description: 'list 返回条数上限，默认 50' },
        dry_run: { type: 'boolean', description: 'tick 是否只预演（默认 true）' },
        op: {
          type: 'string',
          description: '子动作：docs 用 init|list|read|write|search|index|stale；ci 用 start|pass|fail|status；repo 用 branch|index|overview|link_mr|approve|merge',
        },
        repo: { type: 'string', description: '仓库名（repos.roots.<名字> 里的键）' },
        path: { type: 'string', description: 'repo op=index/overview 时的检出路径（缺省读配置）' },
        url: { type: 'string', description: 'MR 链接（repo op=link_mr）或 CI 详情链接' },
        branch: { type: 'string', description: '分支名（缺省按约定算：req/<需求>/<任务>）' },
        files: { type: 'array', items: { type: 'string' }, description: '这次 MR 改到的文件（用来判敏感文件 → 相关文档标 stale）' },
        summary: { type: 'string', description: 'CI 结论摘要（失败时写清哪一步挂了）' },
        message: { type: 'string', description: 'repo op=branch 时给一段提交信息，用来检查 Req/Task trailer' },
        actor: { type: 'string', description: '谁在做这件事（审批/合并必须有）' },
        query: { type: 'string', description: 'recall / docs op=search 的查询词' },
        body: { type: 'string', description: '文档或记忆的正文（markdown）' },
        title: { type: 'string', description: '文档/记忆的标题' },
        owner: { type: 'string', description: '文档责任人（形如 human:xxx）；remember/write 缺它会被拒' },
        related: { type: 'object', description: '关联：{ requirements: [], tasks: [], repos: [], docs: [] }' },
        supersedes: { type: 'array', items: { type: 'string' }, description: '这份文档取代了哪些旧文档（它们会进陈旧报告）' },
        staleAfterDays: { type: 'number', description: 'stale 检查的"多久没更新算过期"阈值（默认 180 天）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          what: { type: 'string' },
          id: { type: 'string' },
          state: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
          report: { type: 'string' },
        },
        required: ['ok'],
      },
      render(args, value) {
        return [{ type: 'text', text: render(value) }]
      },
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = typeof input.action === 'string' ? input.action : ''
      const caller = exec !== null && typeof exec === 'object' && exec.agent !== null && typeof exec.agent === 'object' ? exec.agent.id : undefined
      if (typeof caller === 'string' && isWorker(caller)) {
        return {
          ok: false,
          code: 'worker_session',
          message: '执行会话不要直接改台账：把结果写进汇报，由团队层回写证据并推进状态',
        }
      }
      const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : undefined
      if (handler === undefined) {
        return { ok: false, code: 'bad_request', message: '未知 action：' + action + '（可用：' + Object.keys(handlers).join(', ') + '）' }
      }
      try {
        const result = await handler(input)
        return result === undefined ? { ok: true } : result
      } catch (error) {
        return {
          ok: false,
          code: 'handler_failed',
          message: String(error && error.message ? error.message : error),
        }
      }
    },
  }
}
