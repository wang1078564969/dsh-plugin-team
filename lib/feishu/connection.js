/*
 * The team plugin's OWN Feishu connection.
 *
 * WHY THIS EXISTS. The team layer used to receive group messages by watching the
 * sessions that `dsh-plugin-feishu-bot` drove (that plugin owns a long
 * connection, and one Feishu app can carry exactly one). That arrangement worked
 * but it made the team layer a passenger: no bridge mounted meant no messages at
 * all, the bridge's config decided which app was used, and its `state.json`
 * decided which chats existed. This module removes the dependency entirely — the
 * team plugin now dials Feishu itself, with its own credentials, its own chat
 * registry, and its own reason for every message it ignores.
 *
 * WHY A LONG CONNECTION AND NOT A WEBHOOK. The DSH web server binds 127.0.0.1,
 * so Feishu's servers cannot POST anything to it. In long-connection mode we dial
 * OUT; no public URL, no tunnel, no callback address to re-register when the
 * machine's address changes.
 *
 * WHY THE SDK. The wire protocol is protobuf framing over a WebSocket with its
 * own handshake, ping and reconnect rules. `@larksuiteoapi/node-sdk` owns that;
 * this file owns everything above it: normalising one event into the shape the
 * ingest pipeline already understands, and never letting a handler failure take
 * the connection (or the harness) down.
 *
 * WHAT ARRIVES, EXACTLY. The dispatcher hands us the *event* object:
 *
 *   { message: { chat_id, chat_type, message_id, message_type, content, mentions },
 *     sender:  { sender_id: { open_id, user_id?, union_id? } } }
 *
 * `content` is a JSON STRING (`'{"text":"@_user_1 你好"}'`), and an @-mention
 * appears there as a placeholder key, not as a name — `mentions` carries the
 * mapping. So the text has to be un-placeholdered before anyone reads it, and
 * "was the bot addressed?" is answered from `mentions` + the bot's own open_id,
 * never from the text.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Feishu credentials, from the team plugin's OWN configuration only.
 *
 * Note what is deliberately absent: the previous version fell back to reading
 * `~/.dsh/feishu-bot/config.json`, so a team plugin could silently start as the
 * bridge's app. That is the coupling this module exists to break — if you want
 * the same app, copy the two values into the team config (env vars work too).
 */
export function resolveCredentials(config, override) {
  const feishu = config !== null && typeof config === 'object' && config.feishu !== null && typeof config.feishu === 'object' ? config.feishu : {}
  /*
   * `override` is how a SECOND app is dialled: with several bots, each app has its
   * own credentials, and the environment variable can only describe one of them
   * (the default). So when the caller names an app explicitly, env is not consulted
   * at all — an env override leaking into a second app would silently connect as
   * the wrong identity, which is worse than not connecting.
   */
  const forced = override !== null && typeof override === 'object' ? override : null
  const envId = forced === null ? process.env.DSH_TEAM_FEISHU_APP_ID : undefined
  const envSecret = forced === null ? process.env.DSH_TEAM_FEISHU_APP_SECRET : undefined
  const appId =
    typeof envId === 'string' && envId !== ''
      ? envId
      : typeof forced?.appId === 'string' && forced.appId !== ''
        ? forced.appId
        : typeof feishu.appId === 'string'
          ? feishu.appId
          : ''
  const appSecret =
    typeof envSecret === 'string' && envSecret !== ''
      ? envSecret
      : typeof forced?.appSecret === 'string' && forced.appSecret !== ''
        ? forced.appSecret
        : typeof feishu.appSecret === 'string'
          ? feishu.appSecret
          : ''
  const baseUrl = typeof feishu.baseUrl === 'string' && feishu.baseUrl !== '' ? feishu.baseUrl : 'https://open.feishu.cn'
  return {
    appId,
    appSecret,
    baseUrl,
    ready: appId !== '' && appSecret !== '',
    source:
      typeof envId === 'string' && envId !== ''
        ? 'env'
        : forced !== null
          ? 'app:' + String(forced.appId ?? '').slice(0, 8)
          : appId !== ''
            ? 'team-config'
            : 'none',
  }
}

/** Data directory this plugin owns (`$DSH_HOME/team`), used for its own books. */
export function teamDataDir() {
  const fromEnv = process.env.DSH_TEAM_DATA
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'team')
}

/** Parse an event's `content` JSON string without throwing on garbage. */
export function parseContent(raw) {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/**
 * 富文本（`post`）→ markdown（设计 04 §9）。
 *
 * 飞书的 `post` 长这样：
 *
 *   { title: '标题', content: [[ {tag:'text',text:'看这个 '}, {tag:'a',text:'文档',href:'…'},
 *                                {tag:'at',user_id:'ou_x'}, {tag:'img',image_key:'img_x'} ], [ …段落… ]] }
 *
 * `content` 是**段落 × 行内片段**的二维数组。这个结构直接丢给模型等于丢了个 JSON，
 * 所以这里把它压成 markdown：段落之间空行、行内片段按原顺序拼起来。
 *
 * 两处刻意的取舍：
 *   · 机器人自己的 `at` 依然**删掉**（那是"在叫它"，不是内容）—— 与 `readableText` 同一条理由，
 *     否则每条 @ 消息的标题都会以"@机器人"开头；
 *   · 图片留下 `![图片](asset://image_key...)` 这样的**占位引用**，真正的资产 id 由
 *     下载那一步替换（`rewriteImageRefs`）。没有网络的那一层也能看清"这里本来有张图"。
 */
export function richTextToMarkdown(content, mentions, botOpenId = '') {
  const byKey = new Map()
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    if (mention === null || typeof mention !== 'object' || typeof mention.key !== 'string') continue
    const id = mention.id !== null && typeof mention.id === 'object' ? mention.id : {}
    byKey.set(mention.key, {
      name: typeof mention.name === 'string' && mention.name !== '' ? mention.name : '',
      openId: typeof id.open_id === 'string' ? id.open_id : '',
    })
  }
  const mentionName = (userId) => {
    for (const mention of byKey.values()) if (mention.openId !== '' && mention.openId === userId) return mention.name
    return ''
  }
  /** 行内片段 → 一段 markdown；返回 '' 表示"这一段是空的"。 */
  const inline = (node) => {
    if (node === null || typeof node !== 'object') return ''
    switch (node.tag) {
      case 'text':
        return String(node.text ?? '').replace(/@_user_\d+/g, (placeholder) => {
          const mention = byKey.get(placeholder)
          if (mention === undefined) return ''
          if (botOpenId !== '' && mention.openId === botOpenId) return ''
          return mention.name === '' ? '' : '@' + mention.name
        })
      case 'a': {
        const text = String(node.text ?? node.href ?? '')
        const href = String(node.href ?? '')
        if (href === '') return text
        return '[' + (text === '' ? href : text) + '](' + href + ')'
      }
      case 'at': {
        const userId = String(node.user_id ?? '')
        if (botOpenId !== '' && userId === botOpenId) return ''
        const name = mentionName(userId)
        return name === '' ? '@' + (userId === '' ? '某人' : userId) : '@' + name
      }
      case 'img':
        return '![图片](asset-ref:' + String(node.image_key ?? '') + ')'
      case 'media':
        return '[视频](asset-ref:' + String(node.file_key ?? '') + ')'
      case 'file':
        return '[文件 ' + String(node.file_name ?? '') + '](asset-ref:' + String(node.file_key ?? '') + ')'
      case 'emotion':
        return String(node.emoji_type ?? '')
      case 'code_block':
        return '\n```\n' + String(node.text ?? '') + '\n```\n'
      case 'md':
        return String(node.text ?? '')
      case 'hr':
        return '\n---\n'
      default:
        // 认不出的 tag：有 text 就留着，没有就丢掉 —— 不因为一个未知类型整段消失。
        return typeof node.text === 'string' ? node.text : ''
    }
  }

  const paragraphs = Array.isArray(content?.content) ? content.content : []
  const lines = []
  for (const paragraph of paragraphs) {
    const nodes = Array.isArray(paragraph) ? paragraph : [paragraph]
    const text = nodes.map(inline).join('').replace(/[ \t]+/g, ' ').trim()
    if (text !== '') lines.push(text)
  }
  const title = typeof content?.title === 'string' ? content.title.trim() : ''
  const body = lines.join('\n\n')
  if (title === '') return body
  return body === '' ? '**' + title + '**' : '**' + title + '**\n\n' + body
}

/**
 * 把 `asset-ref:<key>` 占位换成真正的资产引用。
 *
 * 下载与落库在插件层（需要凭据与磁盘），而"这段文字长什么样"在这一层。两边用一个
 * 明确的占位符交接：转换是纯函数，替换是纯字符串运算，各自可测。
 */
export function rewriteAssetRefs(text, resolve) {
  const source = typeof text === 'string' ? text : ''
  if (typeof resolve !== 'function') return source
  return source.replace(/asset-ref:([A-Za-z0-9_\-]+)/g, (whole, key) => {
    const ref = resolve(String(key))
    return typeof ref === 'string' && ref !== '' ? ref : whole
  })
}

/**
 * Replace Feishu's `@_user_N` placeholders with what they stand for.
 *
 * Two different things hide behind the same placeholder, and they must NOT be
 * treated alike:
 *
 *   - `@张三` — someone else. Keeping the name is information: "这块你接手" and
 *     "@张三 这块你接手" are different messages.
 *   - `@机器人` — the bot itself. That is ADDRESSING, not content. Leaving it in
 *     makes every downstream rule fight a prefix: the requirement title becomes
 *     "@机器人 支付重试这块", and a triage pattern anchored at the start of the
 *     sentence stops matching. So the bot's own mention is removed outright.
 */
export function readableText(content, mentions, botOpenId = '') {
  const raw = typeof content?.text === 'string' ? content.text : ''
  if (raw === '') return ''
  const byKey = new Map()
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    if (mention === null || typeof mention !== 'object' || typeof mention.key !== 'string') continue
    const id = mention.id !== null && typeof mention.id === 'object' ? mention.id : {}
    byKey.set(mention.key, {
      name: typeof mention.name === 'string' && mention.name !== '' ? mention.name : '',
      openId: typeof id.open_id === 'string' ? id.open_id : '',
    })
  }
  if (byKey.size === 0) return raw.trim()
  return raw
    .replace(/@_user_\d+/g, (placeholder) => {
      const mention = byKey.get(placeholder)
      if (mention === undefined) return ''
      if (botOpenId !== '' && mention.openId === botOpenId) return ''
      return mention.name === '' ? '' : '@' + mention.name
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 一条消息里带的资源 key（图 / 文件 / 音视频）。
 *
 * 富文本里的图片在**段落深处**，所以这里递归找 `img` / `file` / `media` 节点；
 * 单一类型的消息则在 content 顶层。返回空数组 = 这条消息没有资源，
 * 而不是"没看懂" —— 两者在调用方要分开处理。
 */
export function resourcesOf(type, content) {
  const out = []
  const pushImage = (key) => {
    if (typeof key === 'string' && key !== '') out.push({ kind: 'image', key })
  }
  const pushFile = (key, name) => {
    if (typeof key === 'string' && key !== '') out.push({ kind: 'file', key, name: typeof name === 'string' ? name : '' })
  }
  if (type === 'image') pushImage(content?.image_key)
  else if (type === 'file') pushFile(content?.file_key, content?.file_name)
  else if (type === 'audio') pushFile(content?.file_key, content?.file_name ?? 'voice')
  else if (type === 'media') pushFile(content?.file_key, content?.file_name)
  else if (type === 'post') {
    const walk = (node) => {
      if (node === null || node === undefined) return
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (typeof node !== 'object') return
      if (node.tag === 'img') pushImage(node.image_key)
      else if (node.tag === 'file') pushFile(node.file_key, node.file_name)
      else if (node.tag === 'media') pushFile(node.file_key, node.file_name)
      for (const value of Object.values(node)) if (typeof value === 'object') walk(value)
    }
    walk(content?.content)
  }
  return out
}

/** Whether the event addressed the bot itself. */
export function mentionsBot(mentions, botOpenId) {
  if (typeof botOpenId !== 'string' || botOpenId === '') return false
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    if (mention === null || typeof mention !== 'object') continue
    const id = mention.id
    if (id !== null && typeof id === 'object' && id.open_id === botOpenId) return true
  }
  return false
}

/**
 * 这条消息 @ 到了哪些 open_id（我们自己的机器人）—— 按 open_id，不按名字。
 *
 * 为什么需要它：一个群里有两台机器人时，**每条消息会在两条连接上各到一次**，
 * 谁先到谁处理（去重只放一个过去）。于是"这条消息在 @ 谁"不能由"哪条连接收到了它"
 * 来回答 —— 那是一个竞态。把 open_id 原样带上去，路由层才能按"被点名的身份"派活。
 */
export function mentionedOpenIds(mentions) {
  const out = []
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    if (mention === null || typeof mention !== 'object') continue
    const id = mention.id
    if (id !== null && typeof id === 'object' && typeof id.open_id === 'string' && id.open_id !== '') out.push(id.open_id)
  }
  return out
}

/**
 * 这个应用**自己的**机器人 open_id（拿不到就空着，让连接去问飞书）。
 *
 * 安装级 `feishu.botOpenId` **只属于默认应用**。这是踩过的第二个"默认应用"坑：
 * 第一个是 appId/appSecret（配置加载时按机器人采纳，见 config.ownApps），
 * 而 botOpenId 一直留着继承 —— 后果不是"少一个字段"，是身份串台：
 *
 *   2026-09-12：用户加了第二个应用（cli_aa157481…，机器人"个人网银前端"）拉进群，
 *   @ 它没有任何反应。日志里两台机器人的 `botOpenId` 都是**第一个应用的**
 *   `ou_847e6…`。于是"这条消息 @ 了我吗"对第二个应用永远是 false
 *   （requireMention 默认 true → 它永远不开口），反过来 @ 第一台时它倒以为自己被点名了。
 *   一个应用的身份，只能由它自己回答；答不上来就去问 /open-apis/bot/v3/info。
 *
 * @param {{appId?: string, botOpenId?: string}|null} app the app descriptor, if any
 * @param {object} config resolved configuration
 */
export function configuredBotOpenId(app, config) {
  const own = app !== null && app !== undefined && typeof app.botOpenId === 'string' ? app.botOpenId : ''
  if (own !== '') return own
  const appId = app !== null && app !== undefined && typeof app.appId === 'string' ? app.appId : ''
  // 没有 descriptor（单应用形态）或就是默认应用 → 安装级那个值说的正是它。
  const isDefault = app === null || app === undefined || appId === '' || appId === config?.feishu?.appId
  return isDefault && typeof config?.feishu?.botOpenId === 'string' ? config.feishu.botOpenId : ''
}

/**
 * Normalise one `im.message.receive_v1` event.
 *
 * @returns {object|null} `null` for anything the team layer should not look at
 *   (non-text messages, its own bot messages, unregistered behaviour is decided
 *   by the caller).
 */
export function normalizeMessage(event, options = {}) {
  const botOpenId = typeof options.botOpenId === 'string' ? options.botOpenId : ''
  const message = event !== null && typeof event === 'object' ? event.message : null
  if (message === null || typeof message !== 'object') return null
  if (typeof message.chat_id !== 'string' || typeof message.message_id !== 'string') return null

  const sender = event.sender !== null && typeof event.sender === 'object' ? event.sender : {}
  const senderId = sender.sender_id !== null && typeof sender.sender_id === 'object' ? sender.sender_id : {}
  const openId = typeof senderId.open_id === 'string' ? senderId.open_id : null
  // Our own posts come back as events too; feeding them in would make the bot
  // answer itself forever.
  if (botOpenId !== '' && openId === botOpenId) return null
  if (sender.sender_type === 'app') return null

  /*
   * ONLY TEXT IS TREATED AS A PROMPT, and the reason matters: a picture, a file
   * or a merged-forward has no text to read, so there is nothing to triage and
   * nothing to answer. Saying nothing is better than answering "I didn't
   * understand", and the inbox log records that the message arrived.
   */
  const type = typeof message.message_type === 'string' ? message.message_type : 'text'
  const content = parseContent(message.content)
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  /*
   * 正文按类型取（设计 04 §9）。以前只有 `text`：`post`（富文本）读出来是空字符串，
   * 于是"发了一段带标题、链接、图片排版的说明"在插件看来等于什么都没说。
   * 图片/文件的消息**没有正文**，但也不是空的：它带着一个 `image_key` / `file_key`，
   * 由插件层下载落库（`lib/assets.js`），这里只把 key 交出去。
   */
  const text =
    type === 'post'
      ? richTextToMarkdown(content, mentions, botOpenId)
      : type === 'text'
        ? readableText(content, mentions, botOpenId)
        : type === 'image'
          ? ''
          : ''

  return {
    chatId: message.chat_id,
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    /*
     * WHICH APP THIS ARRIVED ON. With one app this is decoration; with several it is
     * the routing key — "was I mentioned" is answered per app, and two bots behind
     * one app are one identity, so the app (not the mention) is what narrows the
     * candidate list (see feishu/apps.js and bots.js `routeBots`).
     */
    appId: typeof options.appId === 'string' ? options.appId : typeof event.__appId === 'string' ? event.__appId : '',
    messageId: message.message_id,
    messageType: type,
    text,
    /*
     * 资源类消息的 key（图片 / 文件 / 语音 / 富文本里的图）。插件层拿它去下载，
     * 下不下来是插件层的事；这一层只保证"key 没被丢掉"。
     */
    resources: resourcesOf(type, content),
    /** 飞书事件 id：去重键（设计 04 §4.1）——重投时 message_id 可能不变，event_id 才是权威。 */
    eventId: typeof event.event_id === 'string' && event.event_id !== '' ? event.event_id : null,
    addressed: mentionsBot(mentions, botOpenId),
    /**
     * 这条消息 @ 到的 open_id 名单（原样带上，不判断是不是我们的人）。
     *
     * `addressed` 回答的是"**收到这条消息的那个应用**被点名了吗"——一个群里有两台
     * 机器人时，这个问题不足以决定"谁来回答"：两条连接都会收到同一条消息，谁先到谁
     * 处理。路由层需要的是"被点名的**身份**是谁"，于是名单要一路带上去
     * （见 `bots.js` 的 `routeBots` 与 `responder.js` 的 `addressedTo`）。
     */
    mentionedOpenIds: mentionedOpenIds(mentions),
    sender: openId,
    senderName: (() => {
      for (const mention of mentions) {
        if (mention !== null && typeof mention === 'object' && mention.id !== null && typeof mention.id === 'object' && mention.id.open_id === openId) {
          return typeof mention.name === 'string' ? mention.name : null
        }
      }
      return null
    })(),
    at: typeof message.create_time === 'string' && /^\d+$/.test(message.create_time) ? new Date(Number(message.create_time)).toISOString() : new Date().toISOString(),
    raw_content: typeof message.content === 'string' ? message.content : '',
    from_bridge: false,
  }
}

/**
 * Start the long connection.
 *
 * @param {{config: object, onEvent: (event: object) => void, client?: object, log?: object,
 *          app?: {appId: string, appSecret: string, botOpenId?: string}}} options
 *   `client` is this plugin's own HTTP client; it is used only to ask Feishu who
 *   the bot is, because every group rule needs that id. `app` selects which app to
 *   dial when the installation has more than one (see feishu/apps.js).
 * @returns {Promise<{dispose: () => void, describe: () => object, ready: boolean}>}
 */
export async function startConnection(options) {
  const { config, onEvent } = options
  const log = options.log ?? console
  const app = options.app !== null && typeof options.app === 'object' ? options.app : null
  const credentials = resolveCredentials(config, app)
  const configuredBotId = configuredBotOpenId(app, config)
  if (!credentials.ready) {
    return {
      ready: false,
      dispose: () => {},
      describe: () => ({ ready: false, source: credentials.source }),
      reason: 'no feishu appId + appSecret in the team config (or DSH_TEAM_FEISHU_APP_ID / _APP_SECRET)',
    }
  }

  let lark = null
  try {
    lark = await import('@larksuiteoapi/node-sdk')
  } catch (error) {
    return {
      ready: false,
      dispose: () => {},
      describe: () => ({ ready: false, reason: 'sdk-missing' }),
      reason: 'the @larksuiteoapi/node-sdk package is not installed in this plugin: ' + String(error && error.message ? error.message : error),
    }
  }

  const levels = lark.LoggerLevel ?? {}
  const state = { connected: false, lastReadyAt: null, lastError: null }

  /*
   * The bot's own open_id, needed to tell "the message mentions me" from "it
   * mentions someone else". Best effort: without it, only p2p chats can be
   * treated as addressed, and group messages fall back to the intent word list.
   */
  let botOpenId = typeof configuredBotId === 'string' && configuredBotId !== '' ? configuredBotId : ''
  try {
    /*
     * Asked through OUR http client rather than the SDK's, for one reason:
     * `/open-apis/bot/v3/info` puts `bot` at the TOP level of the response,
     * unlike almost every other endpoint, and this client is the one that has
     * been checked against the live API. Without this id, group messages can
     * never be recognised as addressed to the bot — which is the difference
     * between a bot that answers and a bot that is silent in every group.
     */
    const info = botOpenId !== '' ? undefined : await options.client?.call?.('/open-apis/bot/v3/info')
    // `bot` sits at the TOP level of this response (unlike most endpoints).
    const bot = info?.ok === true ? info.raw?.bot ?? info.data?.bot ?? null : null
    if (bot !== null && typeof bot === 'object' && typeof bot.open_id === 'string') botOpenId = bot.open_id
    else if (info !== undefined) state.lastError = 'bot identity: ' + String(info.code) + ' ' + String(info.msg)
  } catch (error) {
    state.lastError = String(error && error.message ? error.message : error)
  }
  if (botOpenId === '' && options.client !== undefined) {
    log.error?.('[team] could not read the bot identity — group messages will not count as addressed (set feishu.botOpenId to fix): ' + String(state.lastError))
  }

  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const payload = { ...data, __botOpenId: botOpenId }
        await onEvent(payload)
      } catch (error) {
        // A handler failure must never reach the socket: the SDK would log it and
        // the event would be lost with no record in our own log.
        log.error?.('[team] inbound handling failed: ' + String(error && error.message ? error.message : error))
      }
    },
    'im.chat.member.bot.added_v1': async (data) => {
      try {
        await onEvent({ ...data, __membership: 'added' })
      } catch (error) {
        log.error?.('[team] membership event failed: ' + String(error && error.message ? error.message : error))
      }
    },
    /*
     * 被移出群也要有记录。没有它，"机器人怎么不理这个群了"只能靠猜 ——
     * 而"删掉再加回来"恰好是最常见的自救动作。
     */
    'im.chat.member.bot.deleted_v1': async (data) => {
      try {
        await onEvent({ ...data, __membership: 'removed' })
      } catch (error) {
        log.error?.('[team] membership removal event failed: ' + String(error && error.message ? error.message : error))
      }
    },
  })

  const wsClient = new lark.WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    loggerLevel: levels.info ?? 'info',
    autoReconnect: true,
    onReady: () => {
      state.connected = true
      state.lastReadyAt = new Date().toISOString()
      log.log?.('[team] feishu long connection established (app=' + credentials.appId.slice(0, 8) + '…)')
    },
    onReconnecting: () => log.log?.('[team] feishu reconnecting…'),
    onReconnected: () => log.log?.('[team] feishu reconnected'),
    onError: (error) => {
      state.connected = false
      state.lastError = String(error && error.message ? error.message : error)
      log.error?.('[team] feishu connection error: ' + state.lastError)
    },
  })

  try {
    await wsClient.start({ eventDispatcher: dispatcher })
  } catch (error) {
    return {
      ready: false,
      dispose: () => {},
      describe: () => ({ ready: false, reason: 'start-failed' }),
      reason: String(error && error.message ? error.message : error),
    }
  }

  return {
    ready: true,
    botOpenId,
    appId: credentials.appId,
    describe: () => ({ ready: true, appId: credentials.appId.slice(0, 8) + '…', source: credentials.source, botOpenId: botOpenId === '' ? null : botOpenId.slice(0, 8) + '…', state }),
    dispose: () => {
      try {
        wsClient.close({ force: true })
      } catch (error) {
        /* already gone */
      }
    },
  }
}

/**
 * One connection per Feishu APP, and the bot identity that comes with each.
 *
 * WHY A POOL. `startConnection` dials exactly one app, which was the whole
 * requirement while the team layer had one bot. A roster with several bots needs
 * one connection per app they name — and, just as importantly, needs a place to
 * answer "which app is this event from, and therefore which bot open_id counts as
 * '@ me'". That is the pool's job: it tags every event it delivers with the app it
 * arrived on, so the routing layer never has to guess.
 *
 * FAILURES ARE PER APP. One app with a wrong secret must not stop the others from
 * coming online: a partially configured roster is the normal state of a roster
 * someone is still filling in, and refusing to dial the good apps because of the
 * bad one would make the console's 接入自检 useless (it could never report "this one
 * works, that one does not").
 *
 * @param {{config: object, onEvent: (event: object) => void,
 *          clientFor: (appId: string) => object|null, log?: object,
 *          descriptors?: Array<object>, start?: Function}} options
 *   `start` defaults to {@link startConnection} and exists so the POOL's own rules
 *   (one connection per app, a failed app does not stop the others, every event
 *   tagged with the app it arrived on) can be tested without dialling Feishu.
 */
export async function createConnectionPool(options) {
  const { config, onEvent } = options
  const log = options.log ?? console
  const start = typeof options.start === 'function' ? options.start : startConnection
  const descriptors = Array.isArray(options.descriptors) ? options.descriptors : []
  /** @type {Map<string, object>} appId → connection */
  const connections = new Map()
  /** @type {Array<{appId: string, name: string, ready: boolean, reason: string|null}>} */
  const reports = []

  for (const descriptor of descriptors) {
    if (descriptor.ready !== true) {
      reports.push({ appId: descriptor.appId, name: descriptor.name, ready: false, reason: descriptor.reason ?? 'not-ready' })
      log.error?.('[team] feishu app ' + String(descriptor.appId).slice(0, 8) + '… is not usable (' + String(descriptor.reason) + ') — bots on it stay offline')
      continue
    }
    const started = await start({
      config,
      app: descriptor,
      client: options.clientFor(descriptor.appId),
      // Tagging the event with its app is what makes multi-app routing possible:
      // "was I mentioned?" is answered per app, not per plugin.
      onEvent: (raw) => onEvent({ ...raw, __appId: descriptor.appId }),
      log,
    })
    if (started.ready === true) {
      connections.set(descriptor.appId, started)
    }
    reports.push({
      appId: descriptor.appId,
      name: descriptor.name,
      ready: started.ready === true,
      reason: started.ready === true ? null : String(started.reason ?? 'start-failed'),
    })
  }

  return {
    /** The connection for one app, or null when it is not online. */
    get: (appId) => connections.get(appId) ?? null,
    /** The bot identity of one app: every group rule needs it. */
    botOpenIdFor: (appId) => {
      const connection = connections.get(appId)
      if (connection !== undefined) return connection.botOpenId
      const fallback = connections.values().next().value
      return fallback === undefined ? '' : fallback.botOpenId
    },
    /** Online apps, for 接入自检 and the log. */
    reports: () => reports.map((one) => ({ ...one })),
    online: () => connections.size,
    describe: () => ({
      online: connections.size,
      apps: [...connections.entries()].map(([appId, connection]) => ({ appId, ...connection.describe() })),
    }),
    dispose: () => {
      for (const connection of connections.values()) {
        try {
          connection.dispose()
        } catch (error) {
          /* already gone */
        }
      }
      connections.clear()
    },
  }
}
