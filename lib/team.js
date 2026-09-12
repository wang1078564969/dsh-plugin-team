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
import { createConfigApi, createLogsApi, createTeamApi } from './api.js'
import { createLogBus } from './logbus.js'
import { createMetrics } from './metrics.js'
import { FeishuClient, resolveCredentials } from './feishu/client.js'
import { isRegisteredChat, pickPrimaryBot } from './bots.js'
import { appDescriptors, appIdOfBot, describeApp, unbootableBots } from './feishu/apps.js'
import { noteMessage } from './sessions.js'
import { createConnectionPool, normalizeMessage } from './feishu/connection.js'
import { createAssetStore, humanSize } from './assets.js'
import { chatIdOfTask } from './notify.js'
import { rewriteAssetRefs } from './feishu/connection.js'
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

/** 日志与观测的路由（滚动的东西走它，不塞进配置快照）。 */
export let logsApi = null

/** 观测聚合：降级率与每群发言占比（设计 04 §11）。测试与自检读它。 */
export let metrics = null

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
/**
 * 发今天的日报：摘要桶 + **等谁确认**。
 *
 * 第二段是设计 04 §0 里"人不在时补发"的落点：人离开一天回来，最需要知道的不是
 * "发生过什么"（那是日志），而是**"现在有什么在等我"**。所以待办直接从台账里
 * 现算，而不是从摘要里回忆。
 *
 * 放模块级：定时器在 `apply()` 里，而测试接缝在控制器里 —— 两边调的是同一份实现。
 *
 * @param {{notifier: object, store: object, logbus: object, day: string}} deps
 */
async function sendDailyReports({ notifier, store, logbus, day }) {
  const drained = notifier.drainDigest()
  const byChat = new Map()
  for (const item of drained) {
    const chatId = String(item.bucket).split('|')[0]
    if (chatId === 'no-chat') continue
    const list = byChat.get(chatId) ?? []
    for (const line of item.lines) list.push(String(line))
    byChat.set(chatId, list)
  }
  /*
   * 待办按群归拢：只数**两道门禁还没确认**的任务 —— 那才是"在等人"的东西。
   * 已经确认、正在跑的任务不需要催（催了也只是噪音）。
   */
  for (const task of store.all('task')) {
    const gates = Array.isArray(task.gates) ? task.gates : []
    const open = gates.filter((gate) => gate.state !== 'satisfied' && gate.state !== 'cancelled')
    if (open.length === 0) continue
    const chatId = chatIdOfTask(store, task)
    if (chatId === null) continue
    const waiting = open
      .map((gate) => {
        const who = Array.isArray(gate.required_by) && gate.required_by.length > 0 ? gate.required_by.join('、') : '（没有确认人）'
        return gate.name + '：等 ' + who
      })
      .join('；')
    const list = byChat.get(chatId) ?? []
    list.push('待确认 ' + task.id + '：' + task.title + ' —— ' + waiting)
    byChat.set(chatId, list)
  }
  const sent = []
  for (const [chatId, lines] of byChat) {
    if (lines.length === 0) continue
    const result = await notifier.report({
      id: 'daily:' + day + ':' + chatId,
      chatId,
      title: '📊 日报 ' + day,
      lines: lines.slice(0, 30),
      botId: primaryBotOf(store, chatId),
    })
    sent.push({ chatId, lines: lines.length, action: result.action })
    logbus.info('report', '日报已发往 ' + chatId + '（' + String(lines.length) + ' 条）：' + String(result.action))
  }
  return sent
}

/** 这个群的主机器人（日报由它发，避免"报告卡"换个身份冒出来）。 */
function primaryBotOf(store, chatId) {
  const chat = store.get('chat', chatId)
  return typeof chat?.primary_bot_id === 'string' && chat.primary_bot_id !== '' ? chat.primary_bot_id : undefined
}

function createFeishuController({ ctx, config, store, handlers, pool, notify, logbus, assets }) {
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
    /** 入站资产（图片/文件）落库的地方：`assets/<id>/<原名>` + `assets/index.jsonl`。 */
    assets,
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

  /**
   * 这一条消息带的资源（图片/文件）落库，返回可写进台账的资产列表。
   *
   * 顺序是**先下载、再落库、最后才给引用**：下载失败就没有引用，也不会回
   * "已收到"——一个指向不存在文件的 `asset://` 比"没收到"更糟。每一条失败都
   * 单独记日志并如实进 `problems`，人才能看出是哪一张图没下来。
   *
   * @returns {Promise<{assets: object[], problems: string[]}>}
   */
  async function collectAssets(message) {
    const list = Array.isArray(message.resources) ? message.resources : []
    if (list.length === 0 || state.assets === null) return { assets: [], problems: [] }
    const client = clientForChat(message.chatId)
    const saved = []
    const problems = []
    for (const resource of list) {
      if (client === null || typeof client.download !== 'function') {
        problems.push(resource.key + '：没有可用的飞书客户端（凭据缺失或长连接没起来）')
        continue
      }
      try {
        const downloaded = await client.download(message.messageId, resource.key, { type: resource.kind === 'file' ? 'file' : 'image' })
        if (downloaded.ok !== true) {
          problems.push(resource.key + '：下载失败 ' + String(downloaded.code) + ' ' + String(downloaded.msg))
          continue
        }
        const stored = state.assets.save({
          messageId: message.messageId,
          chatId: message.chatId,
          fileKey: resource.key,
          kind: resource.kind === 'file' ? 'file' : 'image',
          name: resource.name,
          contentType: downloaded.contentType,
          bytes: downloaded.bytes,
        })
        if (stored.ok !== true) {
          problems.push(resource.key + '：' + stored.message)
          continue
        }
        saved.push(stored.record)
      } catch (error) {
        problems.push(resource.key + '：' + String(error && error.message ? error.message : error))
      }
    }
    return { assets: saved, problems }
  }

  /** 写进收件箱的资产摘要（只留台账要用的字段，不带本地路径）。 */
  function assetSummaries(list) {
    return list.map((asset) => ({
      ref: asset.ref,
      kind: asset.kind,
      class: asset.class,
      name: asset.name,
      bytes: asset.bytes,
    }))
  }

  /**
   * "已收到图片/文件"这条回执。
   *
   * 走通知器而不是直接 `send`，是为了与别的播报共用同一套规则与台账：节流、
   * digest、没有群就不发 —— 这里都不用手写第二遍。
   */
  async function receiptForAssets(message, list, primary) {
    await notify.notice({
      id: 'asset:' + message.messageId,
      chatId: message.chatId,
      botId: primary === null ? undefined : primary.id,
      title: '已收到' + (list.some((asset) => asset.kind === 'image') ? '图片' : '文件'),
      lines: list.map((asset) => '`' + asset.ref + '` · ' + asset.name + ' · ' + humanSize(asset.bytes) +
        (asset.class === 'code' || asset.class === 'doc' ? ' · 可以直接进任务上下文' : '')),
      note: '内容已经存在插件自己的盘上，台账里按这个引用取；群里不用再发一遍。',
    })
    logbus.info('asset', '收到 ' + String(list.length) + ' 个资源：' + list.map((asset) => asset.ref).join('、'))
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
      logbus.info('inbound', '被拉进一个群：' + JSON.stringify(raw).slice(0, 200))
      return
    }
    const appId = typeof raw.__appId === 'string' ? raw.__appId : ''
    const botOpenId = state.connectionPool === null ? '' : state.connectionPool.botOpenIdFor(appId)
    const message = normalizeMessage(raw, { botOpenId, appId })
    if (message === null) return

    /*
     * 去重第一道，而且必须在**任何副作用之前**（设计 04 §4.1）：重投的消息不该再
     * 下载一次资产、再落一次盘、再回一次执、再让群记录的计数 +1。`event_id` 是权威
     * 键（重投时 `message_id` 可能会变），`message_id` 是兜底。
     *
     * 流水线里还有一道同样的判断：那道负责回答"这条为什么被跳过"，而这一道负责
     * **别让副作用发生**。两道的顺序不能反。
     */
    const replayed = state.inbox.seenEvent(message.eventId)
    if (replayed !== null && replayed !== message.messageId) {
      logbus.info('inbound', '重投的消息（event_id 已经处理过，原 message_id ' + replayed + '）：' + message.messageId)
      return
    }
    if (state.inbox.seen(message.messageId)) {
      logbus.debug?.('inbound', '重复的 message_id，跳过：' + message.messageId)
      return
    }

    /*
     * 准入第一道：**群在册**（设计 04 §6）。默认不收紧（`requireRegisteredChat: false`），
     * 打开之后没登记的群连收件箱都不进 —— 但要在日志里说清楚，否则"它为什么不理我"
     * 又会变成一个只能读代码才知道答案的问题。
     */
    if (config.feishu.requireRegisteredChat === true && store.get('chat', message.chatId) === null) {
      const registered = isRegisteredChat(config, message.chatId)
      if (registered.ok !== true) {
        logbus.warn('inbound', '忽略了未登记群的消息：' + message.chatId +
          '（requireRegisteredChat 打开着：把它加进某个机器人的 feishu.chats 或 chatAllowlist 才会被处理）')
        return
      }
    }

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
        logbus.error('inbound', '记录群消息失败：' + String(error && error.message ? error.message : error))
      }
    }

    /*
     * 记录是**地板**，不是流水线的副产品：分诊/建单/卡片那一层没起来时，
     * 群记录与"主机器人记下了这一条"照样要成立 —— 否则最需要排查的时候
     * （功能降级）反而什么都查不到。
     */
    /*
     * 资源先落地（设计 04 §9），而且**站在"记录是地板"这一侧**：下载与落库不依赖
     * 分诊/建单那一层起没起来。理由是这里的资产就是"这条消息的内容"——流水线降级时
     * 图片照样要能被事后找到，否则最需要排查的时候恰恰什么都查不到。
     *
     * 顺序也不能反：`asset-ref:` 占位要换成真实引用，而真实引用只有下载成功之后
     * 才存在 —— 让 agent 读到一个指向空气的引用，比让它读到"这里本来有张图，但没下来"更坏。
     */
    const collected = await collectAssets(message)
    if (collected.problems.length > 0) {
      logbus.warn('asset', '有资源没落库（不影响其它内容）：' + collected.problems.join('；'))
    }
    const assetRefs = new Map(collected.assets.map((asset) => [asset.file_key, asset.ref]))
    const text = collected.assets.length === 0
      ? message.text
      : rewriteAssetRefs(message.text, (key) => assetRefs.get(key) ?? null)
    const inbound = { ...message, text }

    /*
     * 收到消息先表态（设计 04 §0.1，已定）：被 @ 的消息立刻加一个 reaction。
     *
     * 为什么值得一个 API 调用：**表态 ≠ 会建单**，它是"我看到了"的唯一即时反馈。
     * 没有它，一个人在群里 @ 机器人之后要等模型跑完一轮才知道它是否活着 ——
     * 而那一轮可能是几分钟。
     *
     * 只对真正 @ 了机器人的消息做（设计里写明了这个边界）：给每条消息都点一下
     * 就成了刷屏。失败只记日志，绝不打断主流程。
     */
    if (message.addressed === true && config.feishu.reaction !== false) {
      const reactor = clientForChat(message.chatId)
      Promise.resolve()
        .then(() => reactor?.call?.('/open-apis/im/v1/messages/' + encodeURIComponent(message.messageId) + '/reactions', {
          method: 'POST',
          body: JSON.stringify({ reaction_type: { emoji_type: String(config.feishu.reactionEmoji ?? 'Get') } }),
        }))
        .then((result) => {
          if (result !== undefined && result !== null && result.ok !== true) {
            logbus.warn('reaction', '表态失败（不影响回答）：' + String(result.code) + ' ' + String(result.msg))
          }
        })
        .catch((error) => logbus.warn('reaction', '表态异常（不影响回答）：' + String(error && error.message ? error.message : error)))
    }

    /*
     * 纯非文本消息（一张图、一个文件、一段语音）：**没有正文可判**，所以不进分诊，
     * 在这里就结束 —— 回执 + 一条日志。设计 04 §9 的原话是"群里回一句『已收到图片』"。
     *
     * 只对"没有可读正文"的消息这样做：一段带图的富文本要进流水线建单，
     * 再额外回一句"已收到图片"就是噪音。
     */
    if (String(text ?? '').trim() === '' && collected.assets.length > 0) {
      if (state.ingest === null) {
        /*
         * 流水线没起来（`feishu.mode: off` / 协议层没加载）：**收件箱由地板自己写**。
         *
         * 这一步不只是"记一笔"：去重表就是收件箱，缺了这条记录，重投的消息会被
         * 再下载一遍、再落一次盘 —— 而那正是不该重复的副作用。
         */
        state.inbox.record(
          {
            message_id: message.messageId,
            dedupe_key: message.eventId ?? message.messageId,
            event_id: message.eventId ?? null,
            chat_id: message.chatId,
            chat_type: message.chatType,
            message_type: message.messageType,
            sender_open_id: message.sender ?? null,
            text,
            assets: assetSummaries(collected.assets),
            create_time: at,
            received_at: new Date().toISOString(),
            consumed_by: [],
            recorded_by: primary === null ? null : primary.id,
          },
          { triage_kind: 'asset', ignored_reason: '非文本消息：内容已落库为资产（分诊流水线没起来）' },
        )
      } else {
        await state.ingest.onMessage(inbound, {
          recorded_by: primary === null ? null : primary.id,
          assets: assetSummaries(collected.assets),
        })
      }
      await receiptForAssets(message, collected.assets, primary)
      return
    }

    if (state.ingest === null) return

    const filed = await state.ingest.onMessage(inbound, {
      recorded_by: primary === null ? null : primary.id,
      assets: assetSummaries(collected.assets),
    })
    /*
     * 分诊结论进日志（设计 04 §0.2）：面板的日志页要能回答"这条为什么没建单"。
     * 收件箱里已经记了原因，日志里再记一行是**为了按时间看** ——
     * 出问题时人的第一反应是"刚才发生什么了"，而不是"翻收件箱筛群"。
     */
    logbus.info('inbound', '收到消息（' + message.chatId + ' · ' + (primary === null ? '无主' : '主：' + primary.id) + '）：' +
      String(message.text ?? '').slice(0, 60), {
      kind: filed.kind ?? null,
      created: filed.created ?? null,
      skipped: filed.skipped ?? null,
      reason: filed.reason ?? null,
    })
    if (filed.skipped === 'duplicate') return
    if (filed.command !== undefined) return
    if (config.feishu.respond === false) return
    await state.responder.onMessage(inbound)
  }

  /** Open the connection with the CURRENT config. Never throws. */
  async function start() {
    state.mode = config.feishu.mode
    state.error = null
    if (config.feishu.mode === 'off') {
      logbus.info('feishu', 'feishu.mode = off：不接收入站消息（出站卡片仍可用）')
      return null
    }

    const credentials = resolveCredentials(config)
    state.credentials = credentials
    if (!credentials.ready) {
      state.error = 'no-credentials'
      logbus.error(
        'feishu',
        '没有飞书凭据：在面板（团队台账 → 配置）或 ' + config.configFile + ' 里填 appId/appSecret，否则什么都收不到',
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

    logbus.info(
      'feishu',
      '拨号：' +
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
      logbus.error('feishu', '长连接没起来：' + state.error)
      return null
    }
    state.connection =
      connectionPool.get(config.feishu.appId) ?? connectionPool.get(descriptors.find((one) => one.ready === true)?.appId ?? '') ?? null
    logbus.info('feishu', '长连接就绪：' + JSON.stringify(connectionPool.describe()))
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
    logbus,
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
    /**
     * 日报的发送路径，暴露出来同样是为了**能被测**：它按群聚合 + 现算待办，
     * 而"人回来时看到什么在等他"这件事值得一条用例，不该只靠定时器到点。
     */
    flushReports: (day) => sendDailyReports({ notifier: notify, store, logbus, day }),
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
  /*
   * 日志总线：内存环形缓冲 + 追加文件**双写**，终端照旧能看到（echo）。
   * 只写终端 = 滚掉就没了；只写内存 = 重启即空 —— 而"刚重启完"恰恰是最需要
   * 看上一条日志的时候（设计 05 §4.0）。
   */
  const logbus = createLogBus({ dataDir: config.dataDir })

  /*
   * 入站资产的落点。它与 store / inbox 同级：都在 `dataDir` 下、都能被人 `tail` 到 ——
   * 图片和文件不是"过程数据"，是这条消息的一部分。
   */
  const assets = createAssetStore({ dataDir: config.dataDir, log: logbus })

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

  const feishu = createFeishuController({ ctx, config, store, handlers, pool, notify: notifier, logbus, assets })
  notifySlot.current = feishu
  /**
   * 测试接缝：让用例能喂一条伪造的飞书事件走真实的入站路径。
   * 生产代码不读它，它只是一条"能测"的通道（与 `clientFor` 同一个理由）。
   */
  if (ctx !== null && typeof ctx === 'object') ctx.teamFeishu = feishu
  feishu.start().catch((error) => {
    logbus.error('feishu', '启动失败：' + String(error && error.message ? error.message : error))
  })
  own(ctx, () => () => feishu.dispose())

  /*
   * Two routes, both under the connection service's authenticated `/api` fence:
   * the ledger the panel shows, and the configuration it edits. Published for
   * the entry to mount (mounting needs the `connection` service, which the entry
   * acquires with `ctx.inject` — see lib/index.js).
   */
  /*
   * 观测聚合（设计 04 §11）：降级率与每群发言占比。它读的是**落盘事实**
   * （卡台账 + 收件箱）与本进程的投递分桶，所以重启不会让指标变好看。
   */
  metrics = createMetrics({ store, inbox: feishu.state.inbox, notify: notifier, logbus })
  api = createTeamApi({ store, handlers, config })
  logsApi = createLogsApi({ logbus, store, inbox: feishu.state.inbox, notify: notifier, metrics, assets })
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
  /** 上次清理去重表的时刻（进程内）：按小时节流，见下面那个 tick。 */
  let lastPruneAt = Date.now()
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    const timer = ctx.get('timer')
    if (timer !== undefined && timer !== null && typeof timer.interval === 'function') {
      own(ctx, () =>
        timer.interval(() => {
          try {
            const report = handlers.tick({ dry_run: false })
            for (const item of report.decided ?? []) {
              logbus.info('tick', '门禁/租约处置：' + JSON.stringify(item))
            }
            /*
             * 同一个轮询里扫发言占比：> 25% 的群写一行 warn（按群冷却）。
             * 放在 tick 里而不是面板的 GET 里 —— 面板每 3 秒读一次，
             * 读一次写一行日志就等于每 3 秒重复告警一次。
             */
            metrics.tick()
            /*
             * 去重表的保留窗口（设计 04 §4.1）。按小时做一次就够了 —— 它是"清理"，
             * 不是"规则"：`prune` 自己只删窗口外的行，多跑几次结果一样。
             */
            if (Date.now() - lastPruneAt >= 60 * 60 * 1000) {
              lastPruneAt = Date.now()
              const pruned = feishu.state.inbox.prune({ retentionDays: config.feishu.dedupeRetentionDays })
              if (pruned.removed > 0) {
                logbus.info('inbox', '去重表清理：移除 ' + String(pruned.removed) + ' 条窗口外的消息（保留 ' +
                  String(pruned.kept) + ' 条，窗口 ' + String(config.feishu.dedupeRetentionDays) + ' 天）')
              }
            }
          } catch (error) {
            logbus.error('tick', '扫描失败：' + String(error && error.message ? error.message : error))
          }
        }, intervalMs),
      )
    }
  }

  /*
   * 日报（设计 04 §2.1 的"报告卡"、02 §1.1 里调度机器人的核心产出）。
   *
   * 为什么必须有：`digest` 模式的意义就是"这类话不必马上说"，但**攒起来的东西
   * 一定要有人说**。没有日报，进摘要的进度就是静默丢失 —— 那比刷屏更糟。
   *
   * 一天一个群一条：桶键是 `群|类型`，所以每个群只看自己的摘要。时刻用**本地时间**
   * （`feishu.dailyReportHour`，0-23；`-1` 关掉），每 10 分钟看一次表，
   * 当天发过就不再发。
   */
  const reportHour = Number(config.feishu.dailyReportHour)
  const reportTimer = ctx.get('timer')
  let lastReportDay = null
  if (
    Number.isFinite(reportHour) &&
    reportHour >= 0 &&
    reportTimer !== null &&
    reportTimer !== undefined &&
    typeof reportTimer.interval === 'function'
  ) {
    own(ctx, () =>
      reportTimer.interval(() => {
        const now = new Date()
        if (now.getHours() !== reportHour) return
        const day = now.toISOString().slice(0, 10)
        if (lastReportDay === day) return
        lastReportDay = day
        flushDailyReports(day).catch((error) =>
          logbus.error('report', '日报失败：' + String(error && error.message ? error.message : error)),
        )
      }, 10 * 60 * 1000),
    )
  }

  /**
   * 发今天的日报（模块级：定时器在 `apply` 里，测试接缝在控制器里，两边都调它）。
   */
  async function flushDailyReports(day) {
    return sendDailyReports({ notifier, store, logbus, day })
  }

  /**
   * 日报的发送路径（模块级实现 + 本安装的依赖）。
   */
  async function flushDailyReports(day) {
    return sendDailyReports({ notifier, store, logbus, day })
  }

  const flushMs = 5_000
  const flushTimer = ctx.get('timer')
  if (flushTimer !== undefined && flushTimer !== null && typeof flushTimer.interval === 'function') {
    own(ctx, () =>
      flushTimer.interval(() => {
        notifier
          .flushThrottled()
          .then((sent) => {
            for (const item of sent) {
              if (item.action === 'failed') logbus.error('notify', '补发播报失败：' + JSON.stringify(item))
            }
          })
          .catch((error) => logbus.error('notify', '补发播报异常：' + String(error && error.message ? error.message : error)))
      }, flushMs),
    )
  }

  logbus.info(
    'team',
    '已激活：data=' + config.dataDir + ' workspace=' + config.workspace + ' tick=' + String(intervalMs) + 'ms',
  )
}
