/*
 * The ledger's HTTP surface, for the shipped browser half.
 *
 * WHY A ROUTE AND NOT A CORDIS SERVICE. A shipped client half is a classic
 * script in the page: it has no `host.call` (that belongs to the dynamic
 * runner), so the only way home is a Fetch route on the `connection` service —
 * which is also what wraps it in the GUI's own browser-cookie authentication.
 * A raw `webServer` route would have been simpler and wrong: this endpoint can
 * start tasks and confirm gates, and an unauthenticated endpoint that does that
 * is a remote control for the team's workflow.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not invent an actor. Every
 * state-changing call must say who is acting, and the state machine then decides
 * whether that principal is allowed — the same refusal a Feishu command gets.
 * The GUI is authenticated as a *browser*; it is not authenticated as a person,
 * and pretending otherwise would put the two gates behind a dropdown.
 */
import { botProblems, sessionRoleView } from './bots.js'
import { availableActions, gateLine } from './domain/index.js'
import { appIdOfBot, appsView } from './feishu/apps.js'
import { diagnose } from './feishu/client.js'
import { memberProblems } from './members.js'
import { sessionRows } from './sessions.js'
import { redact, saveConfig, validatePatch } from './settings.js'

/** Compact projection of one requirement for the list view. */
function requirementRow(requirement, tasks) {
  return {
    id: requirement.id,
    title: requirement.title,
    state: requirement.state,
    owner: requirement.owner,
    requester: requirement.requester,
    priority: requirement.priority,
    type: requirement.type,
    origin: requirement.origin?.surface ?? 'internal',
    chat_id: requirement.origin?.chat_id ?? null,
    acceptance_criteria: requirement.acceptance_criteria ?? [],
    tasks: tasks.filter((task) => task.req === requirement.id).map((task) => task.id),
    /** 状态机现在允许的动作 —— 面板据此渲染按钮，不再自己维护一份状态表。 */
    available: availableActions(requirement),
    body: requirement.body ?? { problem: '', proposal: '' },
    history: (requirement.history ?? []).slice(-5),
  }
}

/** Compact projection of one task, including what a human may do to it next. */
function taskRow(task, leases) {
  const lease = leases.find((item) => item.task === task.id) ?? null
  return {
    id: task.id,
    req: task.req,
    title: task.title,
    state: task.state,
    type: task.type,
    domains: task.domains ?? [],
    assignee: task.assignee,
    owner: task.owner,
    acceptance_criteria: task.acceptance_criteria ?? [],
    repo: task.repo,
    branch: task.branch,
    release_count: task.release_count ?? 0,
    blocked_reason: task.blocked_reason ?? null,
    gates: gateLine(task),
    gate_detail: task.gates ?? {},
    evidence: task.evidence ?? [],
    available: availableActions(task),
    lease: lease === null ? null : { holder: lease.holder, state: lease.state, expires_at: lease.expires_at, renewals: lease.renewals },
    history: (task.history ?? []).slice(-5),
  }
}

/**
 * Build the route handler.
 *
 * @param {{store: object, handlers: object, config: object}} deps
 */
export function createTeamApi(deps) {
  const { store, handlers, config } = deps

  function snapshot() {
    const requirements = store.all('requirement')
    const tasks = store.all('task')
    const leases = store.all('lease')
    const runs = store.all('session')
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      config: {
        dataDir: config.dataDir,
        workspace: config.workspace,
        defaultOwner: config.defaultOwner,
        feishuMode: config.feishu?.mode ?? 'off',
        /*
         * `members` STAYS THE DOMAIN MAP here. The ledger page reads it to pick a
         * default actor, and every consumer of "who owns this domain" has read it
         * here since the first version; changing its meaning would silently empty
         * the owner lists. The member TABLE arrives beside it, under its own name.
         */
        members: config.members ?? {},
        memberList: config.memberList ?? [],
        bots: (config.bots ?? []).map((bot) => ({
          id: bot.id,
          displayName: bot.displayName,
          role: bot.role,
          enabled: bot.enabled === true,
        })),
        tickIntervalMs: config.tickIntervalMs,
      },
      requirements: requirements.map((requirement) => requirementRow(requirement, tasks)),
      tasks: tasks.map((task) => taskRow(task, leases)),
      leases: leases.map((lease) => ({ task: lease.task, holder: lease.holder, kind: lease.kind, state: lease.state, expires_at: lease.expires_at })),
      runs: runs.map((run) => ({ task: run.id, session_id: run.session_id, turns: run.turns, role: run.role, last_used: run.last_used })),
      counts: { requirements: requirements.length, tasks: tasks.length, leases: leases.length, runs: runs.length },
    }
  }

  /**
   * One action from the panel.
   *
   * The body is the same shape the `team` tool accepts, so the GUI, a model and
   * a group command all end up in the same place — and a refusal reads the same
   * in all three.
   */
  async function act(body) {
    const action = body !== null && typeof body === 'object' && typeof body.action === 'string' ? body.action : ''
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : undefined
    if (handler === undefined) {
      return { ok: false, code: 'bad_request', message: '未知动作：' + action }
    }
    if (typeof body.actor !== 'string' || body.actor === '') {
      return { ok: false, code: 'bad_request', message: '需要 actor：这个界面以浏览器身份登录，不代表某个人；谁在点必须写清楚' }
    }
    try {
      const result = await handler(body)
      return result === undefined ? { ok: true } : result
    } catch (error) {
      return { ok: false, code: 'handler_failed', message: String(error && error.message ? error.message : error) }
    }
  }

  /** The Fetch-shaped handler the connection service will call. */
  async function handler(request) {
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
    try {
      if (request.method === 'GET') return json(snapshot())
      if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed', message: request.method }, 405)
      const text = await request.text()
      const body = text === '' ? {} : JSON.parse(text)
      const result = await act(body)
      return json({ ...result, snapshot: result.ok === true ? snapshot() : undefined })
    } catch (error) {
      return json({ ok: false, code: 'api_failed', message: String(error && error.message ? error.message : error) }, 500)
    }
  }

  return { path: '/api/team/ledger', methods: ['GET', 'POST'], requestBody: 'buffered', handler, snapshot, act }
}


/**
 * The configuration console's route: read, validate, save, self-check.
 *
 * Same fence as the ledger route (it is registered under `/api`, so the
 * connection service's Host/Origin check plus browser authentication run in
 * front of it) — which matters more here than anywhere else, because this
 * endpoint can change the app credentials and the permission mapping.
 *
 * @param {{config: object, store: object, inbox: object, handlers?: object, client: object|null,
 *          credentials: () => object, connection: () => object|null,
 *          appReports?: () => Array<object>, offlineBots?: () => Array<object>,
 *          reload: () => Promise<object>|object}} deps
 */
/**
 * 日志与观测的路由：`/api/team/logs`。
 *
 * 与台账/配置同一个围栏（注册在 `connection` 下，走 `/api` 的浏览器鉴权）：
 * 日志里有群 id、人名、消息预览，它和配置一样不该是公开的。
 *
 * WHY THIS IS A SEPARATE ROUTE. 配置页一次 GET 要把配置、名册、会话、诊断全带回来，
 * 而日志是**会动**的东西：页面每 3 秒刷一次。把它塞进配置快照里等于每 3 秒重算
 * 一遍名册与自检（自检还会真调飞书）。所以：静态的东西走配置，滚动的东西走这里。
 *
 * @param {{logbus: object, store: object, inbox: object, notify?: object}} deps
 */
export function createLogsApi(deps) {
  const { logbus, store, metrics, assets } = deps

  function snapshot(query) {
    const level = typeof query?.level === 'string' && query.level !== '' ? query.level : 'debug'
    const source = typeof query?.source === 'string' && query.source !== '' ? query.source : ''
    const limit = Number.isFinite(Number(query?.limit)) ? Number(query.limit) : 200
    const withFile = query?.file !== 'false' && query?.file !== false
    const logged = logbus.query({ level, source, limit, includeFile: withFile, contains: query?.contains })

    const inboxAll = typeof deps.inbox?.all === 'function' ? deps.inbox.all() : []
    const unconsumed = typeof deps.inbox?.unconsumed === 'function' ? deps.inbox.unconsumed() : []
    /*
     * 漏单 = 看了、什么都没产出、也没写下原因的。设计 04 §11 把它列为可观测第三条：
     * "漏单检测"要能一眼看到，而不是靠人回忆"我是不是发过那条"。
     */
    const rows = inboxAll.slice(-200).map((doc) => ({
      messageId: doc.message_id,
      at: doc.create_time ?? doc.received_at ?? null,
      chatId: doc.chat_id ?? null,
      sender: doc.sender_principal ?? doc.sender_open_id ?? null,
      // 分诊结论：**可见**（设计 04 §0.2）。没建单的也要能回答"为什么没建"。
      triageKind: doc.triage_kind ?? null,
      ignoredReason: doc.ignored_reason ?? null,
      handled: doc.handled ?? null,
      recordedBy: doc.recorded_by ?? null,
      duplicateOf: doc.duplicate_of ?? null,
      consumedBy: Array.isArray(doc.consumed_by) ? doc.consumed_by : [],
      preview: String(doc.text ?? '').slice(0, 80),
    }))

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      log: {
        rows: logged.rows,
        fromFile: logged.fromFile,
        counts: logbus.counts(),
        sources: logbus.sources(),
        level,
        file: logbus.file ?? null,
      },
      messages: { rows, unconsumed: unconsumed.length, total: inboxAll.length },
      /**
       * 投递统计：降级率（哪一级在发）与机器人的发言占比 —— 设计 04 §11 的
       * 第 4、5 条。`metrics` 不在时退回到原始计数（不编数字：比率是算出来的，
       * 算不出来就只给原始计数）。
       */
      delivery: typeof metrics?.delivery === 'function'
        ? metrics.delivery()
        : typeof deps.notify?.stats === 'function'
          ? deps.notify.stats()
          : null,
      /** 每个群一行：机器人发言占比（> 25% 告警）、@人次数、被静默的播报数。 */
      share: typeof metrics?.snapshot === 'function' ? metrics.snapshot() : null,
      /**
       * 入站资产（图片/文件）：`asset://` 引用要能被找到，否则"落库 + 引用"只完成了
       * 一半 —— 引用是给人用的，人得有个地方查它。`exists:false` 的行要显示出来
       * （文件被删了/搬走了），不是悄悄消失。
       */
      assets: typeof assets?.all === 'function'
        ? { count: assets.count(), rows: assets.all().slice(-50) }
        : null,
      counts: {
        requirements: store.all('requirement').length,
        tasks: store.all('task').length,
        leases: store.all('lease').length,
      },
    }
  }

  async function handler(request) {
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url)
        const query = Object.fromEntries(url.searchParams.entries())
        return json(snapshot(query))
      }
      if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed', message: request.method }, 405)
      const text = await request.text()
      const body = text === '' ? {} : JSON.parse(text)
      // 只允许一件事：清空**内存缓冲**（文件保留 —— "清空日志"不等于"销毁证据"）
      if (body?.action !== 'clear_buffer') {
        return json({ ok: false, code: 'bad_request', message: '唯一支持的动作是 clear_buffer' })
      }
      logbus.clearBuffer()
      return json(snapshot({}))
    } catch (error) {
      return json({ ok: false, code: 'api_failed', message: String(error && error.message ? error.message : error) }, 500)
    }
  }

  return { path: '/api/team/logs', methods: ['GET', 'POST'], requestBody: 'buffered', handler, snapshot }
}

export function createConfigApi(deps) {
  const { config, store, inbox } = deps

  /**
   * The roster as the console renders it: every bot with the problems that belong
   * to IT, its resolved app, and its own conversations.
   *
   * Per-row problems rather than one flat list is the whole point of the page: "which
   * bot is misconfigured" is the question someone opens it with, and a flat list of
   * paths (`bots[3].feishu.appId`) makes them count rows by hand.
   */
  function roster() {
    const bots = Array.isArray(config.bots) ? config.bots : []
    const members = Array.isArray(config.memberList) ? config.memberList : []
    const sessions = sessionRows(store)
    const appReports = typeof deps.appReports === 'function' ? deps.appReports() : []
    const readyApps = new Set(appReports.filter((one) => one.ready === true).map((one) => one.appId))
    /*
     * "Is this bot's app online" is answered from the POOL's per-app reports, not
     * from one flag: with several apps, "the plugin is connected" and "THIS bot can
     * speak" are different statements, and the row that says 已启用 next to 未连接 is
     * the one an operator needs to see. The single-app fallback covers a profile
     * whose pool reports are unavailable.
     */
    const defaultAppId = typeof config.feishu?.appId === 'string' ? config.feishu.appId : ''

    return {
      bots: bots.map((bot) => {
        const appIdResolved = appIdOfBot(bot, config)
        return {
          ...bot,
          appIdResolved,
          /**
           * Whether the app this bot speaks through is actually connected right
           * now. Not part of the config (it is dropped on write — see
           * settings.mergePatch), it is the answer to "it is enabled, so why is it
           * silent".
           */
          feishu: {
            ...bot.feishu,
            connected:
              appIdResolved !== '' &&
              (readyApps.size > 0 ? readyApps.has(appIdResolved) : deps.connection() !== null && appIdResolved === defaultAppId),
          },
          problems: botProblems(bot, {
            bots,
            knownPresets: config.knownPresets ?? [],
            defaultAppId: config.feishu?.appId ?? '',
            appsWithSecret: validationContext().appsWithSecret,
          }),
          sessions: sessions.filter((one) => one.botId === bot.id),
        }
      }),
      members: members.map((member) => ({
        ...member,
        problems: memberProblems(member, { members }),
      })),
      apps: appsView(config),
      /** Bots that are enabled yet cannot come online, with the reason. */
      offline: deps.offlineBots === undefined ? [] : deps.offlineBots(),
      /**
       * Sender mappings whose principal is not a member any more.
       *
       * REPORTED, not pruned: an entry could have been typed by hand for someone
       * deliberately outside the table, and a console that deleted it would lock
       * that person out with no error. The operator decides.
       */
      senders: {
        unbound: unboundSenders(),
      },
    }
  }

  /** What the validator needs to know about the installation to judge a patch. */
  function validationContext() {
    return {
      defaultAppId: typeof config.feishu?.appId === 'string' ? config.feishu.appId : '',
      knownPresets: Array.isArray(config.knownPresets) ? config.knownPresets : [],
      // Which apps actually have a credential: without it, a bot naming an app
      // nobody configured looks fine and comes online as the wrong identity.
      appsWithSecret: appsView(config)
        .filter((one) => one.appSecretSet === true)
        .map((one) => one.appId),
    }
  }

  function unboundSenders() {
    const senders = config.feishu?.senders ?? {}
    const members = Array.isArray(config.memberList) ? config.memberList : []
    const known = new Set(members.map((one) => one.key))
    // In a legacy installation the domain map IS the roster: a principal listed
    // there is a known person even with no member row.
    for (const principals of Object.values(config.members ?? {})) {
      for (const principal of Array.isArray(principals) ? principals : []) known.add(String(principal))
    }
    const out = []
    for (const [openId, principal] of Object.entries(senders)) {
      if (known.has(String(principal))) continue
      out.push({ openId, principal: String(principal), principalKnown: false })
    }
    return out
  }

  /** Everything the console needs to render, including what is wrong right now. */
  async function snapshot() {
    return {
      ok: true,
      config: redact(config),
      roster: roster(),
      /**
       * Which bot supplies each role's agent preset, and where that came from.
       *
       * READ-ONLY, and derived: the preset belongs to the bot, so there is nothing to
       * type per role on 配置 — this is what the console prints instead of a form.
       */
      sessionRoles: sessionRoleView(config),
      /**
       * 群列表：**每个群的主机器人**（这个群的消息都记在它名下）+ 消息数 + 最后活动。
       *
       * 主在首次接触时自动定下、此后不变，但人可以显式改（`set_primary_bot`）——
       * 所以面板要能看到"现在是哪个"和"什么时候定的"。
       */
      chats:
        deps.handlers !== undefined && typeof deps.handlers.list_chats === 'function'
          ? deps.handlers.list_chats().rows
          : // 没有台账处理器时显式 null：面板会显示"接口没有返回 chats"，
            // 而不是画一张空表假装"一个群都没有"。
            null,
      /** Every bot conversation, for the 会话 page. */
      sessions: sessionRows(store),
      // Pre-existing problems are shown on load, not only after a failed save:
      // "this config is already broken" is the most useful thing a console says.
      problems: validatePatch(projection(config), validationContext()),
      diagnostics: await diagnose({
        config,
        credentials: deps.credentials(),
        client: deps.client(),
        connection: deps.connection(),
        store,
        inbox,
      }),
      editable: [
        'defaultOwner',
        'workspace',
        'workspaceTitle',
        'tickIntervalMs',
        'members',
        'senders',
        'chatActors',
        'knownRepos',
        'gates',
        'sessions',
        'feishu.mode',
        'feishu.requireMention',
        'feishu.respond',
        'feishu.buttons',
        'feishu.appId',
        'feishu.appSecret',
        'feishu.botOpenId',
        // The "@ outranks the word list" policy is a real switch with a real
        // trade-off (see ingest.js), so it belongs in the form rather than in a
        // disabled checkbox the operator cannot act on.
        'feishu.addressedOverridesIntent',
        // The roster and the member table: whole-array replaces, validated per row.
        'bots',
        'domains',
        'feishu.speakLeaseMs',
        'taskTypes',
        'domainFallbacks',
        'feishu.requireRegisteredChat',
        'feishu.chatAllowlist',
        'feishu.apps',
      ],
    }
  }

  /**
   * The loaded config in the shape the console (and the validator) speaks.
   *
   * DISPLAY FIELDS ARE NOT CONFIG FIELDS. `redact()` answers the panel's
   * questions — "is a secret set?" — and `appSecretSet` is one of those answers,
   * not a key anyone may write. Passing the redacted object straight into the
   * validator made the console report a permanent, bogus problem
   * (`feishu.appSecretSet: 未知配置项`), which is how a real warning gets ignored:
   * the list is never empty, so nobody reads it.
   */
  function projection(current) {
    const shape = redact(current)
    return {
      defaultOwner: shape.defaultOwner,
      workspace: shape.workspace,
      workspaceTitle: shape.workspaceTitle,
      tickIntervalMs: shape.tickIntervalMs,
      members: shape.members,
      domains: shape.domains,
      domainFallbacks: shape.domainFallbacks,
      taskTypes: shape.taskTypes,
      bots: shape.bots,
      senders: shape.senders,
      chatActors: shape.chatActors,
      knownRepos: shape.knownRepos,
      gates: shape.gates,
      sessions: shape.sessions,
      feishu: {
        mode: shape.feishu.mode,
        appId: shape.feishu.appId,
        botOpenId: shape.feishu.botOpenId,
        requireMention: shape.feishu.requireMention,
        respond: shape.feishu.respond,
        buttons: shape.feishu.buttons,
        /*
         * `chatIds` 留在投影里，只为了一件事：装了旧配置的安装能在「配置检查」里
         * 看到"这个键已经不生效了"以及替代品在哪。它不在 editable 里，所以面板
         * 不会为它渲染任何控件。
         */
        ...(Array.isArray(shape.feishu.chatIds) && shape.feishu.chatIds.length > 0 ? { chatIds: shape.feishu.chatIds } : {}),
        addressedOverridesIntent: shape.feishu.addressedOverridesIntent,
        speakLeaseMs: shape.feishu.speakLeaseMs,
        requireRegisteredChat: shape.feishu.requireRegisteredChat,
        chatAllowlist: shape.feishu.chatAllowlist,
        /*
         * The RAW map, not the redacted array `redact()` shows: validating the view
         * is how a console ends up reporting a permanent bogus problem
         * (`feishu.apps: 必须是对象`) — the same mistake `appSecretSet` caused once
         * already, and the reason a real warning goes unread.
         */
        apps: current.feishu?.apps ?? {},
      },
    }
  }

  async function handler(request) {
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
    try {
      if (request.method === 'GET') return json(await snapshot())
      if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed', message: request.method }, 405)

      const text = await request.text()
      const body = text === '' ? {} : JSON.parse(text)
      if (body === null || typeof body !== 'object' || body.patch === null || typeof body.patch !== 'object') {
        return json({ ok: false, code: 'bad_request', message: '需要 { patch: {…} }：只提交被改动的字段' })
      }
      if (typeof body.actor !== 'string' || body.actor === '') {
        return json({ ok: false, code: 'bad_request', message: '需要 actor：谁在改配置必须写清楚' })
      }

      const saved = saveConfig({
        configFile: config.configFile,
        dataDir: config.dataDir,
        patch: body.patch,
        actor: body.actor,
        context: validationContext(),
        reload: () => {
          const fresh = deps.reload()
          return fresh
        },
      })
      if (saved.ok !== true) {
        // A refused save returns the problems AND the untouched config, so the
        // form can mark the exact field instead of throwing the edit away.
        return json({ ok: false, code: 'invalid_config', problems: saved.problems, config: redact(config) })
      }

      /*
       * A credential or mode change has to reach the running connection, not just
       * the file: "saved" that means "next restart" is the kind of console people
       * stop trusting.
       */
      const changed = new Set(saved.applied ?? [])
      const feishuTouched = [
        'feishu',
        'feishu.appId',
        'feishu.appSecret',
        'feishu.mode',
        'feishu.botOpenId',
        'feishu.apps',
        // The roster decides which apps must be dialled at all: adding an enabled
        // bot on a second app has to open that app's connection now, not at the
        // next restart.
        'bots',
      ].some((key) => changed.has(key))
      const restarted = feishuTouched && typeof deps.restartFeishu === 'function' ? await deps.restartFeishu() : null

      const after = await snapshot()
      /*
       * `derived` is what the save wrote ON THE OPERATOR'S BEHALF — today, the sender
       * mappings derived from open_ids typed on the 成员 page. Reported rather than
       * silent: "the console added a mapping" and "a human typed one" must be
       * distinguishable in the UI as well as in the audit trail.
       */
      return json({ ...after, ok: true, applied: saved.applied, backup: saved.backup, derived: saved.derived, restarted })
    } catch (error) {
      return json({ ok: false, code: 'api_failed', message: String(error && error.message ? error.message : error) }, 500)
    }
  }

  return { path: '/api/team/config', methods: ['GET', 'POST'], requestBody: 'buffered', handler, snapshot }
}
