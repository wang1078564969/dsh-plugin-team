/*
 * The implementation `lib/index.js` imports with the file's mtime as its
 * version. Everything here is wiring: configuration, the object store, the
 * worker-session pool, and the one model-facing tool.
 *
 * WHY THE WIRING IS SEPARATE FROM THE ENTRY. The entry point exists to survive
 * a broken edit (see lib/index.js); this file is allowed to fail, because it
 * only runs after the entry has already decided it can be loaded. Keeping the
 * split means a syntax error here costs a log line instead of the whole harness.
 *
 * EVERY SIDE EFFECT IS OWNED BY THIS FIBER. The tool registration, the timer,
 * and each worker session's `AgentHandle` are registered through `ctx.effect`,
 * so unloading the row (or an edit that gets re-activated) takes all of them
 * with it — a plugin that leaves a timer or a live agent behind is a plugin
 * that keeps acting after it has been switched off.
 *
 * EDITING NOTE: this file is imported fresh on every activation (mtime query
 * string), but its static imports — `./store.js`, `./domain/*.js`, `./exec.js`
 * — are cached by Node for the process lifetime. Editing THOSE takes a harness
 * restart; editing this file does not.
 */
import { loadConfig } from './config.js'
import { SessionPool } from './exec.js'
import { Store } from './store.js'
import { buildTeamTool, createHandlers } from './tools.js'
import { createConfigApi, createTeamApi } from './api.js'
import { FeishuClient, resolveCredentials } from './feishu/client.js'
import { pickPrimaryBot } from './bots.js'
import { appDescriptors, appIdOfBot, describeApp, unbootableBots } from './feishu/apps.js'
import { noteMessage } from './sessions.js'
import { createConnectionPool, normalizeMessage } from './feishu/connection.js'
import { Inbox, createIngest } from './feishu/ingest.js'
import { createNotifier } from './notify.js'
import { createResponder } from './feishu/responder.js'
import { createWorkspaceLink, fetchChatTitle } from './workspace.js'

/**
 * The ledger's Fetch route, published for `lib/index.js` to mount.
 *
 * The route is registered by the ENTRY, not here, for the same reason the Feishu
 * bridge does it that way: mounting it needs the `connection` service, which is
 * optional (it ships with the web bundle and is absent in a headless profile),
 * and reading an optional service is the entry's job — declaring it would park
 * this whole plugin in any profile that lacks it.
 */
export let api = null

/** The configuration console's route, published alongside the ledger's. */
export let configApi = null

/** `ctx.effect` with a graceful fallback for a bare test context. */
function own(ctx, factory) {
  if (ctx !== null && typeof ctx.effect === 'function') return ctx.effect(factory)
  try {
    return factory()
  } catch (error) {
    console.error('[team] wiring failed: ' + String(error && error.message ? error.message : error))
    return undefined
  }
}

/**
 * The Feishu protocol layer — triage, extraction, cards, broadcast decisions.
 *
 * Loaded DYNAMICALLY and optionally on purpose. These modules are pure logic
 * with no dependency on the harness, so a fault in one of them is a reason to
 * lose card rendering or intake, never a reason to lose the ledger: the `team`
 * tool must keep working even when the group-chat surface cannot. A failed load
 * is reported once, at activation, where an operator will actually see it.
 */
async function loadProtocol() {
  try {
    const [triage, extract, cards, broadcast] = await Promise.all([
      import('./feishu/triage.js'),
      import('./feishu/extract.js'),
      import('./feishu/cards.js'),
      import('./feishu/broadcast.js'),
    ])
    return { triage, extract, cards, broadcast }
  } catch (error) {
    console.error(
      '[team] the feishu protocol layer did not load (' +
        String(error && error.message ? error.message : error) +
        ') — group intake and card rendering are off; the ledger and the team tool are unaffected',
    )
    return { triage: null, extract: null, cards: null, broadcast: null }
  }
}

/**
 * The Feishu surface, as a controller rather than a one-shot.
 *
 * WHY A CONTROLLER. Everything here is configurable from the console this plugin
 * now ships (credentials, mention policy, whether it answers at all). A surface
 * that can only be configured by editing a file and restarting the harness is a
 * surface people configure once and then avoid; `restart()` is what makes
 * "saved" mean "in effect".
 *
 * The order of work inside a message is the design, not an implementation
 * detail:
 *
 *   1. commands (`接受 task-1`) go straight to the state machine — a person
 *      deciding should not wait behind a model turn;
 *   2. the ledger pipeline files it (triage → extraction → requirement, or a
 *      recorded reason why not);
 *   3. the chat gets an answer, from the chat's own session.
 *
 * Steps 2 and 3 are independent on purpose: a model that fails must not lose the
 * requirement, and a filing decision must not swallow the answer.
 */
function createFeishuController({ ctx, config, store, handlers, pool, notify }) {
  const state = {
    mode: config.feishu.mode,
    credentials: null,
    /** The DEFAULT app's client: what cards and diagnostics use when nothing else fits. */
    client: null,
    /** appId → client, one per app in the roster (see feishu/apps.js). */
    clients: new Map(),
    /** The default app's connection, for the identity self-check. */
    connection: null,
    connectionPool: null,
    protocol: null,
    inbox: new Inbox(config.dataDir).load(),
    ingest: null,
    responder: null,
    error: null,
  }

  /*
   * The link that puts the bots' conversations where a human can find them: the
   * team workspace in the host's own session list (see lib/workspace.js for why
   * that takes three separate things).
   */
  const workspaceLink = createWorkspaceLink({ ctx, config })
  /*
   * Registered NOW, not on the first message: the point of the workspace is that
   * a human can find the bots' conversations, and a sidebar entry that only
   * appears after someone happens to talk is a feature nobody discovers. Not
   * awaited — activation must not depend on a service or the network.
   */
  workspaceLink.ensureWorkspace().catch(() => {})

  /**
   * The client for a chat, chosen by the app the chat last heard from.
   *
   * WHY NOT ALWAYS THE DEFAULT APP. A card that files a requirement must be sent by
   * the app the message arrived on: on a multi-app roster the default app may not
   * even be in that group, and a reply from an app that is not a member of the chat
   * is rejected by Feishu — the message is filed and the person sees nothing.
   *
   * The index is the chat record's `app_id`, written on every inbound message
   * BEFORE the pipeline runs (see `handleInbound`), so a command reply and a prose
   * reply both resolve through the same lookup.
   */
  function clientForChat(chatId) {
    const chat = store.get('chat', chatId)
    const appId = chat !== null && typeof chat.app_id === 'string' ? chat.app_id : ''
    const exact = appId === '' ? undefined : state.clients.get(appId)
    if (exact !== undefined) return exact
    if (state.client !== null) return state.client
    const first = state.clients.values().next().value
    return first === undefined ? null : first
  }

  /** The ingest layer's client, routed per chat through the index above. */
  const dispatcher = {
    get ready() {
      return state.client !== null && state.client.ready === true
    },
    send: (chatId, payload) => {
      const client = clientForChat(chatId)
      return client === null ? Promise.resolve({ ok: false, code: 'no-client' }) : client.send(chatId, payload)
    },
    sendThrough: (chatId, ladder) => {
      const client = clientForChat(chatId)
      return client === null
        ? Promise.resolve({ ok: false, code: 'no-client' })
        : typeof client.sendThrough === 'function'
          ? client.sendThrough(chatId, ladder)
          : client.send(chatId, ladder)
    },
    call: (path, options) => {
      const client = state.client ?? state.clients.values().next().value ?? null
      return client === null ? Promise.resolve({ ok: false, code: 'no-client' }) : client.call(path, options)
    },
  }

  /**
   * 播报用的客户端：按"这个群平时跟哪个机器人说话"解析。
   *
   * 与 `clientForChat` 同一套索引（群记录里的 `app_id`），因为"回消息"和"发卡片"
   * 必须是同一个应用 —— 否则群里会出现两个身份在说话。
   */
  function notifyClientFor(info) {
    const chatId = typeof info?.chatId === 'string' ? info.chatId : ''
    return clientForChat(chatId)
  }

  /** 一行预览：群记录与列表用，永远不是全文。 */
  function previewOf(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
    return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
  }

  async function handleInbound(raw) {
    if (raw.__membership === 'added') {
      // The bot was added to a chat: worth a line in the log, because "why is it
      // quiet in that group" is usually "it was never actually added".
      console.log('[team] added to a chat: ' + JSON.stringify(raw).slice(0, 200))
      return
    }
    const appId = typeof raw.__appId === 'string' ? raw.__appId : ''
    const botOpenId = state.connectionPool === null ? '' : state.connectionPool.botOpenIdFor(appId)
    const message = normalizeMessage(raw, { botOpenId, appId })
    if (message === null) return

    /*
     * 一个群的记录，先于任何回答发生。
     *
     * 三件事在这里定下来，顺序不能反：
     *   1. **这个群跟哪个应用说话**（后面所有回复与卡片都按它解析客户端）；
     *   2. **这个群的主机器人是谁** —— 首次接触时按路由规则定，之后**不变**
     *      （换主是显式动作，不是"谁回答谁是"的副作用）；
     *   3. **这一条消息记在主机器人名下**（`seen` +1），哪怕它不回答、哪怕另一个
     *      机器人被点名回答 —— "主机器人负责这个群所有消息的记录"就落在这一步。
     */
    const chat = store.get('chat', message.chatId)
    const at = message.at ?? new Date().toISOString()
    const existingPrimary =
      chat === null
        ? null
        : typeof chat.primary_bot_id === 'string' && chat.primary_bot_id !== ''
          ? chat.primary_bot_id
          : // 旧记录里那个字段叫 `bot_id`（谁回答谁被记下）：迁移成"主"。
            typeof chat.bot_id === 'string' && chat.bot_id !== ''
            ? chat.bot_id
            : null
    const primary =
      existingPrimary !== null
        ? { id: existingPrimary }
        : pickPrimaryBot(config, { chatId: message.chatId, appId, text: message.text })
    const base = {
      id: message.chatId,
      chat_type: message.chatType,
      app_id: appId,
      session_id: chat === null ? null : chat.session_id ?? null,
      workspace: chat === null ? null : chat.workspace ?? null,
      title: chat === null ? undefined : chat.title,
      turns: Number(chat?.turns ?? 0),
      created_at: chat === null ? at : chat.created_at ?? at,
      last_seen: at,
      last_reply_at: chat === null ? null : chat.last_reply_at ?? null,
      /** 这个群一共收到过多少条消息（每一条都记，不管谁回答）。 */
      messages: Number(chat?.messages ?? 0) + 1,
      last_inbound: previewOf(message.text),
      primary_bot_id: primary === null ? null : primary.id,
      /** 定主的时间：让"这个群什么时候归它的"有据可查。 */
      primary_since:
        existingPrimary !== null
          ? (chat?.primary_since ?? chat?.created_at ?? at)
          : primary === null
            ? null
            : at,
    }
    const savedChat = store.put('chat', { ...(chat ?? {}), ...base })
    if (primary !== null) {
      try {
        // 记在主机器人名下（不驱动一轮：记录不等于回答）。
        noteMessage(store, {
          botId: primary.id,
          chatId: message.chatId,
          chatType: message.chatType,
          workspace: savedChat.workspace,
          at,
          text: message.text,
        })
      } catch (error) {
        console.error('[team] 记录群消息失败：' + String(error && error.message ? error.message : error))
      }
    }

    /*
     * 记录是**地板**，不是流水线的副产品：分诊/建单/卡片那一层没起来时，
     * 群记录与"主机器人记下了这一条"照样要成立 —— 否则最需要排查的时候
     * （功能降级）反而什么都查不到。
     */
    if (state.ingest === null) return

    const filed = await state.ingest.onMessage(message, { recorded_by: primary === null ? null : primary.id })
    if (filed.skipped === 'duplicate') return
    if (filed.command !== undefined) return
    if (config.feishu.respond === false) return
    await state.responder.onMessage(message)
  }

  /** Open the connection with the CURRENT config. Never throws. */
  async function start() {
    state.mode = config.feishu.mode
    state.error = null
    if (config.feishu.mode === 'off') {
      console.log('[team] feishu intake is off (feishu.mode = off)')
      return null
    }

    const credentials = resolveCredentials(config)
    state.credentials = credentials
    if (!credentials.ready) {
      state.error = 'no-credentials'
      console.error(
        '[team] no feishu credentials in this plugin\'s own config — set them in the panel (团队台账 → 配置) or in ' +
          config.configFile +
          '. Nothing can arrive until then.',
      )
      return null
    }

    /*
     * ONE CLIENT AND ONE CONNECTION PER APP. A roster may name several apps (that is
     * the only way several bots get their own face in Feishu), and each app authenticates
     * separately — so the clients are built from the app descriptors, and the default
     * app's client stays `state.client` for the paths that need "some client"
     * (diagnostics, the identity probe).
     */
    const descriptors = appDescriptors(config)
    state.clients = new Map()
    for (const descriptor of descriptors) {
      state.clients.set(descriptor.appId, new FeishuClient(resolveCredentials(config, descriptor)))
    }
    state.client = state.clients.get(credentials.appId) ?? state.clients.values().next().value ?? null

    if (state.protocol === null) state.protocol = await loadProtocol()
    const protocol = state.protocol
    state.ingest = createIngest({
      config,
      handlers,
      // The dispatcher, not one client: a reply must go out through the app the
      // chat actually talks to (see `clientForChat`).
      client: dispatcher,
      inbox: state.inbox,
      store,
      triage: protocol.triage,
      extract: protocol.extract,
      cards: protocol.cards,
      broadcast: protocol.broadcast,
    })
    state.responder = createResponder({
      config,
      store,
      pool,
      client: state.client,
      clientFor: (bot) => {
        if (bot === null) return state.client
        const appId = appIdOfBot(bot, config)
        return state.clients.get(appId) ?? state.client
      },
      /*
       * `onIntent`: the same word list the triage layer uses decides whether an
       * UN-addressed message looks like this bot's kind of work. Borrowed rather
       * than re-declared so "what counts as a requirement" has exactly one answer in
       * this plugin.
       */
      matchIntent: (text) => {
        const triage = protocol.triage
        if (triage === null) return false
        try {
          const words =
            typeof triage.resolveTriageConfig === 'function'
              ? triage.resolveTriageConfig(config.feishu?.triage).intent_words
              : triage.DEFAULT_TRIAGE_CONFIG?.intent_words
          return (Array.isArray(words) ? words : []).some((word) => String(text).includes(String(word)))
        } catch (error) {
          return false
        }
      },
      onSession: (info) => workspaceLink.onSession(info),
      // The chat's own name is read through the app the chat talks to: a chat the
      // default app is not a member of answers "no permission" for a name its own
      // app can perfectly well read.
      fetchChatTitle: (chatId) => fetchChatTitle(clientForChat(chatId), chatId),
    })

    console.log(
      '[team] feishu: dialing out with ' +
        JSON.stringify({ appId: credentials.appId.slice(0, 8) + '…', source: credentials.source }) +
        ' apps=' +
        String(descriptors.length) +
        ' (' +
        descriptors.map((one) => describeApp(one)).join('; ') +
        ') cards=' +
        (protocol.cards === null ? 'off' : 'on') +
        ' requireMention=' +
        String(config.feishu.requireMention !== false) +
        ' respond=' +
        String(config.feishu.respond !== false),
    )
    const connectionPool = await createConnectionPool({
      config,
      descriptors,
      clientFor: (appId) => state.clients.get(appId) ?? null,
      onEvent: handleInbound,
    })
    state.connectionPool = connectionPool
    if (connectionPool.online() === 0) {
      state.error = connectionPool.reports().map((one) => one.reason).filter(Boolean).join(', ') || 'no-app-connected'
      console.error('[team] feishu long connection did not start: ' + state.error)
      return null
    }
    state.connection =
      connectionPool.get(config.feishu.appId) ?? connectionPool.get(descriptors.find((one) => one.ready === true)?.appId ?? '') ?? null
    console.log('[team] feishu ready: ' + JSON.stringify(connectionPool.describe()))
    return connectionPool
  }

  /** Close every socket, keeping everything else. */
  function stop() {
    try {
      if (state.connectionPool !== null) state.connectionPool.dispose()
    } catch (error) {
      /* already gone */
    }
    state.connectionPool = null
    state.connection = null
    state.clients = new Map()
    state.client = null
  }

  /**
   * Re-read the config and reconnect — what the console calls after a credential
   * or mode change so its "saved" is truthful.
   */
  async function restart() {
    stop()
    workspaceLink.reset()
    workspaceLink.ensureWorkspace().catch(() => {})
    const started = await start()
    return {
      mode: config.feishu.mode,
      connected: state.connectionPool !== null && state.connectionPool.online() > 0,
      apps: state.connectionPool === null ? [] : state.connectionPool.reports(),
      error: state.error,
      describe: started === null ? null : started.describe(),
    }
  }

  return {
    state,
    start,
    stop,
    restart,
    dispose: stop,
    /**
     * 「这个群该由哪个应用发话」——播报链路要的那一半信息。
     *
     * 与回消息用的是同一套索引（群记录里的 `app_id`）：播报和回复必须是同一个身份，
     * 否则群里会出现两个"机器人"在同一个话题下说话。
     */
    clientFor: (info) => clientForChat(typeof info?.chatId === 'string' ? info.chatId : ''),
    /** 群记录与会话记录都落在这里；测试要能核对（生产代码用不着它）。 */
    store,
    /**
     * 一条入站事件的处理路径，暴露出来是为了**能被测**：
     * "主机器人负责这个群所有消息的记录"这条要求，只有在真实的入站路径上验过才算数
     * （驱动整条长连接不适合放进单测，而把这段逻辑复制一份到测试里就等于没测）。
     */
    handleInbound,
    describe: () => ({
      mode: state.mode,
      credentials: state.credentials === null ? 'none' : state.credentials.source,
      cards: state.protocol !== null && state.protocol.cards !== null,
      inbox: state.inbox.all().length,
      connected: state.connectionPool !== null && state.connectionPool.online() > 0,
      apps: state.connectionPool === null ? [] : state.connectionPool.reports(),
      /** Which bots cannot come online, and why (see feishu/apps.js). */
      offline: unbootableBots(config),
      error: state.error,
    }),
  }
}

export async function apply(ctx, rowConfig) {
  const config = loadConfig(rowConfig)
  const store = new Store(config.dataDir).load()
  const pool = new SessionPool(ctx, config)

  own(ctx, () => () => pool.dispose())

  /*
   * 出站通知器。它的 `clientFor` 要能回答"这个群该由哪个应用发话"，而那套索引在
   * Feishu 控制器里（群记录 → app_id）。用一个可变槽解这个先有鸡还是先有蛋：
   * handlers 先建（它需要 notify），控制器后建（它需要 handlers），
   * 而真正的调用只会在控制器启动之后发生。
   */
  const notifySlot = { current: null }
  const notifier = createNotifier({
    config,
    store,
    clientFor: (info) => {
      const controller = notifySlot.current
      if (controller === null) return null
      return controller.clientFor(info)
    },
  })
  const handlers = createHandlers({ ctx, config, store, pool, notify: notifier })
  own(ctx, () =>
    ctx.tools.register(
      buildTeamTool(handlers, {
        isWorker: (agentId) => pool.live.has(agentId),
      }),
    ),
  )

  const feishu = createFeishuController({ ctx, config, store, handlers, pool, notify: notifier })
  notifySlot.current = feishu
  /**
   * 测试接缝：让用例能喂一条伪造的飞书事件走真实的入站路径。
   * 生产代码不读它，它只是一条"能测"的通道（与 `clientFor` 同一个理由）。
   */
  if (ctx !== null && typeof ctx === 'object') ctx.teamFeishu = feishu
  feishu.start().catch((error) => {
    console.error('[team] feishu start failed: ' + String(error && error.message ? error.message : error))
  })
  own(ctx, () => () => feishu.dispose())

  /*
   * Two routes, both under the connection service's authenticated `/api` fence:
   * the ledger the panel shows, and the configuration it edits. Published for
   * the entry to mount (mounting needs the `connection` service, which the entry
   * acquires with `ctx.inject` — see lib/index.js).
   */
  api = createTeamApi({ store, handlers, config })
  configApi = createConfigApi({
    config,
    store,
    handlers,
    inbox: feishu.state.inbox,
    client: () => feishu.state.client,
    credentials: () => feishu.state.credentials ?? resolveCredentials(config),
    connection: () => feishu.state.connection,
    appReports: () => feishu.describe().apps,
    offlineBots: () => unbootableBots(config),
    // Reloading in place is what makes "保存" mean "生效": loadConfig reads the
    // file again, and Object.assign replaces the live fields (feishu.* wholesale,
    // so a policy change is picked up on the very next message).
    reload: () => Object.assign(config, loadConfig(rowConfig)),
    restartFeishu: () => feishu.restart(),
  })

  /*
   * Gate and lease timeouts are what make the two gates real rather than
   * ceremonial: a task whose "start" was never confirmed goes back to the pool
   * on its own. The sweep is time-driven for the same reason the Hub had a
   * supervisor tick — nobody should have to run a command to make a deadline
   * happen. `tickIntervalMs: 0` switches it off, and every decision it takes is
   * logged, because a state change nobody can see is indistinguishable from a
   * bug.
   */
  const intervalMs = Number(config.tickIntervalMs)
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    const timer = ctx.get('timer')
    if (timer !== undefined && timer !== null && typeof timer.interval === 'function') {
      own(ctx, () =>
        timer.interval(() => {
          try {
            const report = handlers.tick({ dry_run: false })
            for (const item of report.decided ?? []) {
              console.log('[team] tick: ' + JSON.stringify(item))
            }
          } catch (error) {
            console.error('[team] tick failed: ' + String(error && error.message ? error.message : error))
          }
        }, intervalMs),
      )
    }
  }

  /*
   * 补发定时器：节流窗口（2 秒）内被并掉的卡片，在这里补一次原地更新。
   *
   * 没有它，**最后一次跃迁会永远不出现在群里** —— 而人只关心最后那个状态
   * （任务是"进行中"还是"完成"）。5 秒一次足够跟上 2 秒的窗口，也不会打飞书。
   */
  const flushMs = 5_000
  const flushTimer = ctx.get('timer')
  if (flushTimer !== undefined && flushTimer !== null && typeof flushTimer.interval === 'function') {
    own(ctx, () =>
      flushTimer.interval(() => {
        notifier
          .flushThrottled()
          .then((sent) => {
            for (const item of sent) {
              if (item.action === 'failed') console.error('[team] 补发播报失败：' + JSON.stringify(item))
            }
          })
          .catch((error) => console.error('[team] 补发播报异常：' + String(error && error.message ? error.message : error)))
      }, flushMs),
    )
  }

  console.log(
    '[team] active — data=' + config.dataDir + ' workspace=' + config.workspace + ' tick=' + String(intervalMs) + 'ms',
  )
}
