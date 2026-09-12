/*
 * Bot conversations: which session a bot is speaking from, and who may speak.
 *
 * THE SESSION BELONGS TO A PAIR, NOT TO A CHAT. This is the correction that made
 * this module necessary: with several bots the interesting questions are "what did
 * the dev bot already discuss in the dev group" and "is the requirement bot
 * remembering the same conversation it had yesterday", and a chat-keyed session
 * answers neither — two bots in one group would share one memory, and one bot in
 * two groups would carry one group's context into the other. So the key is
 * `bot × chat`, which degrades to "one memory per bot" exactly when a bot serves
 * one chat, and the DSH session id says so out loud:
 *
 *     team-bot-<botId>-<chatId>
 *
 * WHY A SEPARATE RECORD KIND (`botsession`) AND NOT FIELDS ON THE CHAT. The chat
 * record is about the CHAT — its type, its human name, when it was last heard
 * from — and it is shared by every bot that serves it. Mixing a session id into it
 * is how the first version ended up with one bot's session presented as the
 * chat's, which is precisely the confusion this replaces.
 *
 * WHY THE LEASE IS IN MEMORY. It answers "did another bot just answer here?", a
 * question about the last minute of a live process. Persisting it would make a
 * restart trust a claim that is already stale, which is worse than forgetting.
 */

/** Identity of one bot's conversation in one chat. */
export function botSessionKey(botId, chatId) {
  return String(botId) + '.' + String(chatId)
}

/**
 * The DSH session id for a bot in a chat.
 *
 * The `team-bot-` prefix is a NAMESPACE, not decoration: `feishu-<chat>` was the
 * first scheme and it collided with another plugin's sessions, so `resume` loaded
 * a stranger's conversation into this chat. Anything this plugin creates must be
 * recognisable as its own, and now also as a specific bot's.
 */
export function botSessionId(botId, chatId) {
  return 'team-bot-' + String(botId) + '-' + String(chatId)
}

/** Whether a session id was minted by this plugin for a bot. */
export function isBotSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('team-bot-')
}

/**
 * The record for one bot's conversation in one chat, created on first use.
 *
 * **每个机器人每个群一条自己的会话**（`team-bot-<机器人>-<群>`），这是硬规则：
 * 一个群里的两台机器人各有各的上下文与记忆，谁说话也不会把另一个的会话顶掉。
 *
 * 这里以前有一段"**继承单助手时代的会话**"：名册出现之前，一个群的助手说的是
 * `team-feishu-<群>`；为了让"这个群聊过什么"不丢，第一个服务这个群的机器人会**接着那个
 * 会话说**。这在只有一台机器人时是好事，但用户 2026-09-12 明确要求"一个群里每台机器人
 * 都是单独的会话，不是一个群共用一个会话" —— 而继承恰恰制造了那个画面：会话 id 仍然是
 * 群的名字，看起来这个群只有一条会话。所以继承被拿掉了；历史记录由
 * `migrateLegacySessions()` 一次性改名（旧会话文件留在盘上，不动它）。
 *
 * @param {object} store the team object store
 * @param {{botId: string, chatId: string, chatType?: string, workspace?: string}} input
 */
export function ensureBotSession(store, input) {
  const id = botSessionKey(input.botId, input.chatId)
  const existing = store.get('botsession', id)
  if (existing !== null) return existing

  return store.put('botsession', {
    id,
    bot_id: input.botId,
    chat_id: input.chatId,
    chat_type: input.chatType ?? null,
    // Stable across restarts, so the bot keeps its memory of this chat.
    session_id: botSessionId(input.botId, input.chatId),
    workspace: input.workspace ?? null,
    turns: 0,
    created_at: new Date().toISOString(),
    last_seen: null,
    last_reply_at: null,
    last_inbound: null,
    /** Set when the agent had to open a fresh session (cwd conflict, etc.). */
    session_note: null,
  })
}

/**
 * 把单助手时代的会话记录改名为"机器人 × 群"的 id（一次性，幂等）。
 *
 * 为什么值得一个显式的迁移而不是"让它自己慢慢换掉"：会话 id 是**看得见的** ——
 * 面板的「会话」页和 DSH 客户端的侧栏都按它显示。留着 `team-feishu-<群>` 会让
 * "这台机器人有自己的会话"这句话在界面上一眼看不出来，而这正是用户提的那个要求。
 *
 * 代价说清楚：换了 id 就是换了 DSH 会话，那个旧会话的历史**不会被带过来**
 * （文件还在 `~/.dsh/sessions` 里，随时可以自己接着用）。所以迁移记 `migrated_from`，
 * 并且调用方会往日志里写一行 —— 静默改掉一个人的会话是不可接受的。
 */
export function migrateLegacySessions(store) {
  const out = []
  for (const record of store.all('botsession')) {
    const current = typeof record.session_id === 'string' ? record.session_id : ''
    if (!current.startsWith('team-feishu-') || current === 'team-feishu-') continue
    const next = botSessionId(record.bot_id, record.chat_id)
    if (next === current) continue
    store.put('botsession', { ...record, session_id: next, migrated_from: current })
    out.push({ botId: record.bot_id, chatId: record.chat_id, from: current, to: next })
  }
  return out
}

/**
 * 记下"这个机器人在这个群看到了一条消息"。
 *
 * 与 `turns` 分开记：`turns` 是**它回答过的轮次**，`seen` 是**它名下的消息数**。
 * 主机器人要负责群里所有消息的记录，所以这两个数字必须能对不上 —— 把没回答的消息
 * 也算进 `turns` 会让"这个机器人干了多少活"变成一句假话。
 *
 * @returns {object} 更新后的记录
 */
export function noteMessage(store, input) {
  const record = ensureBotSession(store, {
    botId: input.botId,
    chatId: input.chatId,
    chatType: input.chatType,
    workspace: input.workspace,
  })
  const at = input.at ?? new Date().toISOString()
  return store.put('botsession', {
    ...record,
    seen: Number(record.seen ?? 0) + 1,
    last_seen: at,
    last_inbound: typeof input.text === 'string' ? previewOf(input.text) : record.last_inbound ?? null,
  })
}

/** 一行预览：日志与列表用，永远不是全文。 */
function previewOf(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
}

/** Every conversation of one bot, oldest first. */
export function botSessionsOf(store, botId) {
  return store.find('botsession', (one) => one.bot_id === botId)
}

/**
 * The console's view of every bot conversation.
 *
 * The chat title is joined in from the chat record because it is the chat's
 * property and is fetched once for all bots, not per bot.
 */
export function sessionRows(store) {
  return store.all('botsession').map((one) => {
    const chat = store.get('chat', one.chat_id)
    return {
      botId: one.bot_id,
      chatId: one.chat_id,
      sessionId: one.session_id,
      turns: Number(one.turns ?? 0),
      /** 记下的消息数（含它没有回答的那些）。 */
      seen: Number(one.seen ?? 0),
      lastSeen: one.last_seen ?? null,
      lastReplyAt: one.last_reply_at ?? null,
      title: chat !== null && typeof chat.title === 'string' ? chat.title : null,
      workspace: one.workspace ?? null,
      chatType: one.chat_type ?? null,
    }
  })
}

/**
 * "I am answering this chat" — the cheap way to stop two bots from answering the
 * same sentence.
 *
 * Only consulted for messages that were not addressed to a specific bot and only
 * for bots whose `speakPolicy.leaseRequired` is on (see responder.js). The FIRST
 * bot to claim a chat holds it for `ttlMs`; the others see the holder and stay
 * quiet, which is the behaviour a person expects from colleagues who can hear
 * each other.
 */
export function createReplyLease(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Number(options.ttlMs) : 90 * 1000
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  /** @type {Map<string, {botId: string, at: number}>} */
  const held = new Map()

  return {
    /**
     * @returns {{ok: true, renewed: boolean}|{ok: false, holder: string, ageMs: number}}
     */
    claim(chatId, botId) {
      const current = held.get(chatId)
      const at = now()
      if (current !== undefined && current.botId !== botId && at - current.at < ttlMs) {
        return { ok: false, holder: current.botId, ageMs: at - current.at }
      }
      const renewed = current !== undefined && current.botId === botId
      held.set(chatId, { botId, at })
      return { ok: true, renewed }
    },
    /** Explicit release, for a turn that ended in an error and spoke nothing. */
    release(chatId, botId) {
      const current = held.get(chatId)
      if (current !== undefined && current.botId === botId) held.delete(chatId)
    },
    holderOf(chatId) {
      const current = held.get(chatId)
      if (current === undefined) return null
      if (now() - current.at >= ttlMs) return null
      return current.botId
    },
    /** For 接入自检: who is holding what right now. */
    snapshot() {
      const out = []
      for (const [chatId, value] of held) {
        if (now() - value.at < ttlMs) out.push({ chatId, botId: value.botId, ageMs: now() - value.at })
      }
      return out
    },
    clear() {
      held.clear()
    },
  }
}
