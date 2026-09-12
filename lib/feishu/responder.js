/*
 * The chat responder: one bot answers, from ITS OWN session in THIS chat.
 *
 * WHAT CHANGED AND WHY IT MATTERS. The first version had one implicit bot and one
 * session per chat (`team-feishu-<chatId>`). That is a support widget: whoever the
 * app is, every conversation in a group shares one memory. A team is not that. It
 * has several bots — requirement, development, testing, scheduling — each 1:1 with
 * an agent, each with a role, and each keeping its own conversations:
 *
 *     team-bot-<botId>-<chatId>
 *
 * so the dev bot in the dev group and the dev bot in the requirement group are two
 * contexts, and the requirement bot and the dev bot in ONE group are two contexts
 * as well. That pair key is the whole correction (design doc 02 §1).
 *
 * WHO ANSWERS, IN ORDER (see bots.js `routeBots` for the candidate list):
 *   1. the bot a chat is already bound to — people have been talking to it, and a
 *      roster edit must not silently swap the personality mid-conversation;
 *   2. a bot NAMED in the text (`@需求机器人`, `需求机器人`, `req`) — an explicit
 *      address outranks any default;
 *   3. the highest-priority candidate (coord, then req, then dev, …).
 *
 * WHO SPEAKS — a separate question, decided per bot by `feishu.speakPolicy`:
 *   onMention    被 @（或被点名）时回答。关掉它，这个机器人在群里就只记录不吭声。
 *   onIntent     未被点名但消息像它的活（意图词命中）时也回答，默认关。
 *   leaseRequired 未被点名时先拿下这个群的发言租约。这不是多此一举：一个机器人
 *                一个飞书应用时，同一条群消息会在每条连接上各到一次，而这个抢占
 *                是"这句话只回一次"的唯一依据（同一条消息只会由 routeBots 选出一个
 *                机器人，所以进程内的重复不会发生，跨应用的重复才会）。
 *   digestOnly   只播报：不发卡片，回答截到摘要长度。
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It does not answer non-text messages: there is nothing to read.
 *   - It does not answer a group message that addressed nobody, unless the bot's
 *     policy says it may (a bot that pipes up on every message gets muted).
 *   - It does not invent a session per message: a bot keeps ONE session per chat,
 *     which is the difference between a colleague and a search box.
 *   - IT DOES NOT STOP BEING USEFUL WITH NO ROSTER. `bots: []` (or no bot serving
 *     this chat) falls back to the original single-assistant behaviour, session id
 *     included, so an installation that never writes a roster keeps working.
 */
import { randomUUID } from 'node:crypto'

import { addressesBot, describeBot, routeBots } from '../bots.js'
import { appIdOfBot } from './apps.js'
import { botSessionId, botSessionKey, createReplyLease, ensureBotSession } from '../sessions.js'
import { answerCard, shouldRenderAsCard, stripMarkdown } from './richtext.js'

/** Trim a reply to something a chat message can carry. */
const MAX_REPLY_CHARS = 6000
/** `digestOnly` bots broadcast; a digest is not a document. */
const MAX_DIGEST_CHARS = 800

/**
 * Card header colour per role.
 *
 * Not decoration: it is the second signal (after the header text) that tells a
 * person which of several bots is talking, and it is the only one that survives a
 * glance at a long group scrollback.
 */
const CARD_COLOR_OF_ROLE = {
  req: 'blue',
  dev: 'green',
  qa: 'orange',
  coord: 'purple',
  lib: 'grey',
  ops: 'red',
  custom: 'turquoise',
}

/** A short line for the log, never the full text. */
function preview(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
}

/**
 * @param {{config: object, store: object, pool: object,
 *          client?: object|null, clientFor?: (bot: object|null) => object|null,
 *          matchIntent?: (text: string) => boolean,
 *          lease?: object, log?: object}} deps
 */
export function createResponder(deps) {
  const { config, store, pool } = deps
  const log = deps.log ?? console
  const lease = deps.lease ?? createReplyLease({ ttlMs: config.feishu?.speakLeaseMs })

  /** The bot that serves this chat, or null for single-assistant mode. */
  function pickBot(message) {
    const chat = store.get('chat', message.chatId)
    /*
     * 黏性看**主机器人**（`primary_bot_id`），不是"上一次谁回答的"。
     * 旧记录里那个字段叫 `bot_id`，仍然读（迁移期兼容）。
     */
    const boundBotId =
      chat === null
        ? null
        : typeof chat.primary_bot_id === 'string' && chat.primary_bot_id !== ''
          ? chat.primary_bot_id
          : typeof chat.bot_id === 'string' && chat.bot_id !== ''
            ? chat.bot_id
            : null
    const candidates = routeBots({
      bots: Array.isArray(config.bots) ? config.bots : [],
      chatId: message.chatId,
      text: typeof message.text === 'string' ? message.text : '',
      appId: typeof message.appId === 'string' ? message.appId : '',
      // A bot with no app of its own speaks through the DEFAULT app; passing the
      // event's app here instead would make it a candidate everywhere.
      defaultAppId: typeof config.feishu?.appId === 'string' ? config.feishu.appId : '',
      /*
       * 这条消息按 open_id 点名了哪几个应用（`lib/team.js` 的 `mentionedAppsOf`）。
       * 一个群里两台机器人时"谁收到了"是竞态、"谁被点名"是事实 —— 候选名单必须以后者为准，
       * 否则 @ 了 B 而 A 的连接先到，候选里根本没有 B，结果就是没人回答。
       */
      mentionedAppIds: Array.isArray(message.mentionedAppIds) ? message.mentionedAppIds : [],
      boundBotId,
    })
    return { bot: candidates.length === 0 ? null : candidates[0], candidates, boundBotId }
  }

  /**
   * 这条消息是不是点名了**这台机器人所在的应用**。
   *
   * 名单来自 `lib/team.js` 的 `mentionedAppsOf`（飞书 mention 的 open_id × 每个应用
   * 自己的 botOpenId）。名单为空时返回 false —— 与改动前一样按名字/`addressed` 判。
   */
  function mentionedApp(message, bot) {
    const list = Array.isArray(message?.mentionedAppIds) ? message.mentionedAppIds : []
    if (list.length === 0) return false
    const appId = appIdOfBot(bot, config)
    return appId !== '' && list.includes(appId)
  }

  /** Whether this message was addressed to THIS bot (mention, or its name). */
  function addressedTo(message, bot, candidates) {
    if (message.addressed === true) return true
    if (bot === null) return false
    /*
     * 这条消息点名了**这台机器人所在的应用**：按身份认，不按正文里有没有它的名字。
     *
     * 两条理由。一是名字不可靠：机器人可以在飞书里叫"A"、在名册里叫"B"，那时正文匹配
     * 落空，被点名反而没人回答。二是一个群两台机器人时 `message.addressed` 只回答
     * "收到这条消息的那个应用被点名了吗"（见 connection.js），对另一台永远是 false ——
     * 而它才是真正被 @ 的那一台。
     */
    if (mentionedApp(message, bot)) return true
    if (addressesBot(typeof message.text === 'string' ? message.text : '', bot)) return true
    /*
     * Two bots behind ONE app are the same face in Feishu, so an @-mention cannot
     * say which of them was meant; `message.addressed` already covers that case
     * above. What is left is "the candidate list narrowed to exactly one bot,
     * which the chat is bound to" — the sticky case, where the group has been
     * talking to that bot all along.
     */
    const record = store.get('chat', message.chatId)
    const primary = record === null ? null : record.primary_bot_id ?? record.bot_id ?? null
    return candidates.length === 1 && candidates[0] === bot && bot.id === primary
  }

  /**
   * Whether this bot speaks at all, and why not when it stays quiet.
   *
   * The reason is returned rather than logged here: the caller records it in the
   * chat log, so "why didn't it answer" has an answer that outlives the process.
   */
  function decideSpeech(message, bot, candidates) {
    if (bot === null) {
      // Single-assistant mode: the original rule (p2p always, group when addressed).
      if (message.chatType === 'p2p') return { speak: true, reason: 'p2p' }
      if (message.addressed === true) return { speak: true, reason: 'addressed' }
      if (config.feishu?.requireMention === false) return { speak: true, reason: 'requireMention-off' }
      return { speak: false, reason: 'not-addressed' }
    }

    const policy = bot.feishu?.speakPolicy ?? {}
    const named = addressedTo(message, bot, candidates)
    if (message.chatType === 'p2p') return { speak: true, reason: 'p2p', named }
    if (named) {
      if (policy.onMention === false) return { speak: false, reason: 'on-mention-off', named }
      /*
       * ADDRESSING OUTRANKS THE LEASE, BUT THE ANSWER STILL TAKES IT.
       *
       * Outranks: a person who names a bot means that bot, and a claim held by
       * another one must not silence it (the whole point of naming).
       * Still takes: when every bot has its own Feishu app, the SAME group message
       * arrives once per app's connection. The first delivery is answered here; the
       * second one sees the claim and its own candidate stays quiet — without this,
       * naming a bot would make the group hear two answers to one question.
       */
      lease.claim(message.chatId, bot.id)
      return { speak: true, reason: 'named', named }
    }
    const intent = typeof deps.matchIntent === 'function' ? deps.matchIntent(message.text) === true : false
    if (policy.onIntent === true && intent) {
      /*
       * A message that looks like this bot's work, with several bots able to read
       * it. Whoever claims the chat first answers; the others log the reason. This
       * is the cheap, honest version of "colleagues who can hear each other".
       */
      if (policy.leaseRequired !== false) {
        const claimed = lease.claim(message.chatId, bot.id)
        if (claimed.ok !== true) {
          return { speak: false, reason: 'lease-held-by-' + String(claimed.holder), named, intent }
        }
      }
      return { speak: true, reason: 'intent', named, intent }
    }
    return { speak: false, reason: intent ? 'intent-not-allowed' : 'no-intent', named, intent }
  }

  /** The chat's record: its session, its workspace, how much it has said. */
  function chatRecord(chatId, chatType) {
    const existing = store.get('chat', chatId)
    if (existing !== null) {
      /*
       * Migrate a record written before the bots existed. Its `session_id` may
       * already be bound to another plugin's session on disk (the `feishu-` prefix
       * collided with a bridge), and it has no bot: the next message re-binds both.
       */
      if (typeof existing.session_id === 'string' && existing.session_id.startsWith('feishu-')) {
        return store.put('chat', { ...existing, session_id: null, migrated_from: existing.session_id })
      }
      return existing
    }
    const record = {
      id: chatId,
      chat_type: chatType,
      session_id: null,
      primary_bot_id: null,
      last_bot_id: null,
      workspace: null,
      turns: 0,
      created_at: new Date().toISOString(),
      last_seen: null,
      last_reply_at: null,
    }
    return store.put('chat', record)
  }

  /** Deliver one answer, through the client of the app the bot speaks on. */
  async function reply(chatId, text, bot) {
    const client = typeof deps.clientFor === 'function' ? deps.clientFor(bot) : deps.client
    if (client === null || client === undefined || client.ready !== true) return { ok: false, via: 'no-client' }
    const digest = bot !== null && bot.feishu?.speakPolicy?.digestOnly === true
    const body = digest ? String(text).slice(0, MAX_DIGEST_CHARS) : String(text)

    /*
     * CARD FIRST, TEXT SECOND, and the order is the whole point: a Feishu `text`
     * message renders no markdown at all, so a model answer delivered that way
     * shows the person `**bold**` and `> quotes` as punctuation. The card is the
     * only surface that renders it; text is what we fall back to when the card
     * cannot be delivered — and then the markers are stripped, because a fallback
     * that still shows `**` is not a fallback. A `digestOnly` bot skips the card on
     * purpose: it broadcasts, it does not host a conversation.
     */
    if (digest !== true && shouldRenderAsCard(body)) {
      /*
       * The card carries the bot's own name as its header. On a single-app
       * installation every bot is the same face in the group, so the header is the
       * only place a person can see WHICH role answered — and on a multi-app one it
       * agrees with the sender name instead of competing with it.
       */
      const card = answerCard(body, bot === null ? {} : { header: bot.displayName, color: CARD_COLOR_OF_ROLE[bot.role] ?? 'blue' })
      if (card !== null) {
        const sent = await client.send(chatId, { msg_type: 'interactive', card: card.card })
        if (sent.ok === true) return { ok: true, via: card.truncated === true ? 'card-truncated' : 'card' }
        log.error?.('[team] the card was rejected (' + String(sent.code) + ' ' + String(sent.msg) + '), falling back to text')
      }
    }
    const plain = stripMarkdown(body).slice(0, MAX_REPLY_CHARS)
    const sent = await client.send(chatId, { msg_type: 'text', content: { text: plain } })
    if (sent.ok === true) return { ok: true, via: 'text' }
    return { ok: false, via: 'text', code: sent.code, message: sent.msg }
  }

  return {
    /** The bot that would answer this chat right now (for diagnostics/tests). */
    pickBot,
    /**
     * Whether this message deserves an answer at all, and from whom.
     *
     * One function answers both "should anyone reply" and "which bot", because
     * with a roster they are the same question: the answer depends on WHICH bot, and
     * a separate boolean would have to guess one.
     */
    plan(message) {
      if (message === null || typeof message !== 'object') return { bot: null, candidates: [], speak: false, reason: 'bad-message' }
      if (message.messageType !== 'text') return { bot: null, candidates: [], speak: false, reason: 'not-text' }
      if (typeof message.text !== 'string' || message.text.trim() === '') {
        return { bot: null, candidates: [], speak: false, reason: 'empty' }
      }
      const picked = pickBot(message)
      if (picked.candidates.length === 0) {
        return { ...picked, ...decideSpeech(message, null, picked.candidates) }
      }
      /*
       * THE FIRST CANDIDATE THAT IS WILLING TO SPEAK, not simply the first
       * candidate. The two are different whenever a bot is deliberately quiet: with
       * `req` (onIntent off) outranking `dev` (onIntent on), asking only the top
       * candidate would mean the bot that WAS configured to answer this kind of
       * message never gets the chance — in every chat where a quieter bot happens to
       * have higher priority.
       *
       * The order is the routing order, so "who answers" is still decided by naming,
       * then by the binding, then by role priority; the policy only removes
       * candidates, it never reorders them.
       */
      let last = null
      for (const candidate of picked.candidates) {
        const decision = decideSpeech(message, candidate, picked.candidates)
        if (decision.speak === true) return { ...picked, bot: candidate, ...decision }
        if (last === null) last = decision
      }
      return { ...picked, ...last, speak: false }
    },
    /** The boolean form, for callers that only ask "would it answer". */
    shouldRespond(message) {
      return this.plan(message).speak === true
    },
    /**
     * Answer one message in its chat, from the right bot's own session.
     * Never throws: a failure is a reply, not a crash.
     */
    async onMessage(message) {
      const first = this.plan(message)
      if (first.speak !== true) {
        // Nothing to answer and nobody to answer as: record the reason on the chat
        // and stop. Started bots are not even opened for these.
        if (first.reason === 'not-text' || first.reason === 'empty' || first.reason === 'bad-message') {
          return { ok: true, skipped: first.reason }
        }
      }
      const { bot, candidates } = first
      const decision = first
      if (decision.speak !== true) {
        /*
         * Record WHY, on the chat, so "it ignored me" has a traceable answer — and
         * create the record if this is the first thing that ever happened in the
         * chat. A reason that only exists once someone has already been answered is
         * exactly the case where a person is left guessing.
         */
        const chat = chatRecord(message.chatId, message.chatType)
        store.put('chat', { ...chat, last_skip: decision.reason, last_skip_at: new Date().toISOString() })
        return { ok: true, skipped: decision.reason, botId: decision.bot === null ? null : decision.bot.id }
      }

      const record = chatRecord(message.chatId, message.chatType)
      const cwd = typeof record.workspace === 'string' && record.workspace !== '' ? record.workspace : config.workspace

      /*
       * The chat's human name, fetched once and remembered. It becomes the DSH
       * session's title — the difference between a readable session list and a
       * column of `team-bot-req-oc_c91d…`.
       */
      let chatTitle = typeof record.title === 'string' && record.title !== '' ? record.title : null
      if (chatTitle === null && typeof deps.fetchChatTitle === 'function') {
        try {
          chatTitle = await deps.fetchChatTitle(message.chatId)
          if (chatTitle !== null) store.put('chat', { ...store.get('chat', message.chatId), title: chatTitle })
        } catch (error) {
          chatTitle = null
        }
      }

      /*
       * WHICH SESSION. With a bot it is the bot×chat pair; without one it is the
       * original single-assistant id, so an installation with no roster keeps its
       * existing conversations instead of starting over.
       */
      const botSession =
        bot === null
          ? null
          : ensureBotSession(store, { botId: bot.id, chatId: message.chatId, chatType: message.chatType, workspace: cwd })
      const wantedSessionId = bot === null ? 'team-feishu-' + message.chatId : botSession.session_id

      let agent = null
      try {
        agent = await pool.open({
          sessionId: wantedSessionId,
          role: bot === null ? 'chat' : bot.role,
          cwd,
          preset: bot === null ? undefined : bot.agentPreset ?? undefined,
          model: bot === null ? undefined : bot.model?.primary ?? undefined,
        })
      } catch (error) {
        const reason = String(error && error.message ? error.message : error)
        log.error?.('[team] cannot open the chat session: ' + reason)
        // Nothing will be said, so the claim on this chat must not stand: another
        // bot (or the next delivery of the same message) should be free to answer.
        lease.release(message.chatId, bot === null ? '' : bot.id)
        await reply(message.chatId, '❌ 起不了会话：' + reason, bot)
        return { ok: false, code: 'session_unavailable', message: reason, botId: bot === null ? null : bot.id }
      }

      /*
       * The id the session REALLY got: `open` refuses to resume a session that
       * lives in another directory and starts a fresh, suffixed one instead, and
       * pretending otherwise is how a chat ends up filed under someone else's
       * workspace.
       */
      const sessionId = typeof agent.id === 'string' && agent.id !== '' ? agent.id : wantedSessionId
      if (sessionId !== wantedSessionId) {
        if (botSession !== null) {
          store.put('botsession', { ...store.get('botsession', botSession.id), session_id: sessionId, session_note: 'cwd-conflict', turns: 0 })
        }
      }

      /*
       * Bind the chat to the bot that just answered: this is what makes routing
       * sticky, and it is written BEFORE the turn so a slow answer cannot be
       * answered by a second bot in the meantime (the lease covers the rest).
       */
      if (bot !== null) {
        const latest = store.get('chat', message.chatId) ?? record
        /*
         * 回答**不改主**：主机器人是这个群的记录归属，在首次接触时就定了
         * （见 lib/team.js 的 handleInbound），换主是显式动作。
         * 这里只记"这个群最后是谁回答的"，方便面板显示。
         */
        store.put('chat', {
          ...latest,
          last_bot_id: bot.id,
          session_id: sessionId,
          ...(typeof latest.primary_bot_id === 'string' && latest.primary_bot_id !== ''
            ? {}
            : { primary_bot_id: bot.id, primary_since: latest.primary_since ?? message.at ?? new Date().toISOString() }),
          last_seen: message.at ?? new Date().toISOString(),
        })
      }

      /*
       * Hand the session to whoever can make it visible in the host client.
       * Awaited, but every failure inside is contained there: the answer to the
       * chat must not depend on the sidebar being pretty.
       */
      if (typeof deps.onSession === 'function') {
        try {
          await deps.onSession({
            sessionId,
            session: agent.session,
            chatTitle,
            chatId: message.chatId,
            botId: bot === null ? null : bot.id,
            botName: bot === null ? null : bot.displayName,
          })
        } catch (error) {
          log.error?.('[team] session announcement failed: ' + String(error && error.message ? error.message : error))
        }
      }

      let driven = null
      try {
        driven = await pool.drive(agent, message.text, { timeoutMs: config.feishu?.turnTimeoutMs })
      } catch (error) {
        const reason = String(error && error.message ? error.message : error)
        log.error?.('[team] driving the chat turn failed: ' + reason)
        // Nothing was said, so the lease is not evidence that this bot is the one
        // holding the conversation: release it and let the next bot try.
        lease.release(message.chatId, bot === null ? '' : bot.id)
        await reply(message.chatId, '❌ 处理失败：' + reason, bot)
        return { ok: false, code: 'drive_failed', message: reason, botId: bot === null ? null : bot.id }
      }

      /*
       * Merge onto the CURRENT records, not the ones read before the turn: the
       * chat title (and anything else written meanwhile) lives in a newer copy, and
       * writing a stale one back would silently drop it — which showed up as "the
       * name is re-fetched on every single message".
       */
      const at = message.at ?? new Date().toISOString()
      const latestChat = store.get('chat', message.chatId) ?? record
      store.put('chat', { ...latestChat, turns: Number(latestChat.turns ?? 0) + 1, last_seen: at, last_inbound: preview(message.text) })
      if (botSession !== null) {
        const latestSession = store.get('botsession', botSession.id) ?? botSession
        store.put('botsession', {
          ...latestSession,
          turns: Number(latestSession.turns ?? 0) + 1,
          last_seen: at,
          last_inbound: preview(message.text),
        })
      }

      const text = typeof driven.text === 'string' ? driven.text.trim() : ''
      if (text === '') {
        // Silence with a reason. A model that answered nothing usually hit a
        // limit or an error the driver swallowed; saying so beats a dead chat.
        const notice = driven.timedOut ? '⏳ 这一轮超时了，没有结论。可以再说一次或换个说法。' : '（这一轮没有产出文本）'
        await reply(message.chatId, notice, bot)
        return { ok: false, code: driven.timedOut ? 'turn_timeout' : 'empty_reply', text: '', botId: bot === null ? null : bot.id }
      }

      const delivered = await reply(message.chatId, text, bot)
      const repliedAt = new Date().toISOString()
      store.put('chat', { ...store.get('chat', message.chatId), last_reply_at: repliedAt })
      if (botSession !== null) {
        store.put('botsession', { ...store.get('botsession', botSession.id), last_reply_at: repliedAt })
      }
      return {
        ok: delivered.ok === true,
        sessionId,
        botId: bot === null ? null : bot.id,
        bot: bot === null ? null : describeBot(bot),
        text,
        delivered,
      }
    },
    /** Ids are opaque to the driver; this just needs to be unique. */
    newTurnId: () => 'team-' + randomUUID(),
    /** For 接入自检: which bot holds which chat's reply lease right now. */
    leases: () => lease.snapshot(),
    /** The bot paired with a session id, for diagnostics. */
    botIdOfSession(sessionId) {
      const row = (Array.isArray(config.bots) ? config.bots : []).find((bot) =>
        String(sessionId).startsWith(botSessionId(bot.id, '')),
      )
      return row === undefined ? null : row.id
    },
    sessionIdFor: (botId, chatId) => botSessionId(botId, chatId),
    sessionKeyFor: (botId, chatId) => botSessionKey(botId, chatId),
  }
}
