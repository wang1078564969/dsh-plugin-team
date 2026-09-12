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
 * @param {object} store the team object store
 * @param {{botId: string, chatId: string, chatType?: string, workspace?: string}} input
 */
export function ensureBotSession(store, input) {
  const id = botSessionKey(input.botId, input.chatId)
  const existing = store.get('botsession', id)
  if (existing !== null) return existing

  /*
   * ADOPT THE OLD SINGLE-ASSISTANT CONVERSATION.
   *
   * Before the roster existed, a chat's assistant spoke from `team-feishu-<chatId>`.
   * If that chat has no bot conversation yet, the FIRST bot to serve it continues
   * THAT session instead of starting an empty one — because the alternative is that
   * enabling a roster silently wipes what the bot already knows about the group, and
   * "the agent remembers what this chat discussed" is the whole reason a session is
   * keyed by the chat in the first place.
   *
   * Only the first bot in a chat may adopt it (`alreadyClaimed`): two bots sharing one
   * session is exactly the confusion the bot × chat key exists to remove.
   */
  const chat = store.get('chat', input.chatId)
  const legacy = chat !== null && typeof chat.session_id === 'string' ? chat.session_id : ''
  const claimed = store.find('botsession', (one) => one.chat_id === input.chatId).length > 0
  const adopt = claimed !== true && legacy.startsWith('team-feishu-') && legacy !== 'team-feishu-'

  return store.put('botsession', {
    id,
    bot_id: input.botId,
    chat_id: input.chatId,
    chat_type: input.chatType ?? null,
    // Stable across restarts, so the bot keeps its memory of this chat.
    session_id: adopt ? legacy : botSessionId(input.botId, input.chatId),
    /** Set when this bot took over a single-assistant conversation (see above). */
    adopted_from: adopt ? legacy : null,
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
