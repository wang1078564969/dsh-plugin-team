/*
 * The bot registry: WHO the team's agents are.
 *
 * WHY THIS EXISTS AS ITS OWN OBJECT. The first version of this plugin had one
 * implicit bot: whatever app_id the config carried, answering with a session per
 * chat. That is the shape of a support widget, not of a team. The workbench this
 * replaces knows the difference (design doc 02 §1): a bot is a durable identity —
 * a display name, a role, a persona, the Feishu app it speaks through, the chats
 * it serves, how it decides to speak, what it may touch, which model and preset
 * drive it, and which skills/knowledge pack it carries. Several of them exist at
 * once, each is 1:1 with an agent, and each keeps its OWN conversations.
 *
 * WHY NORMALIZE INSTEAD OF VALIDATING AND REFUSING. A roster with one bad row
 * must still start the good rows: the operator typed `role: require` in a YAML
 * habit, and refusing to boot the whole collaboration layer over that is worse
 * than keeping the bot and saying so on the 配置检查 page. So `normalizeBot`
 * never throws, and `botProblems` reports what a human should fix. The ONE thing
 * that is fatal is an id we cannot address the bot by, because a bot with no id
 * cannot be routed to, mentioned, or repaired.
 *
 * SNAKE_CASE IS ACCEPTED ON PURPOSE. The design's `bot.yaml` uses `display_name`,
 * `base_role`, `speak_policy`, `agent_preset`, `knowledge_pack`. Someone copying
 * a bot from the docs (or from `$DSH_HOME/team/config.json` written by hand)
 * should not have their values silently dropped because the console writes
 * camelCase. Both shapes land on the same normalized field.
 */

/** Roles a bot can hold. Mirrors the workbench's `botSchema.role`. */
export const BOT_ROLES = ['req', 'dev', 'qa', 'coord', 'lib', 'ops', 'custom']

/** Human labels, used by the console and by the card headers. */
export const ROLE_LABELS = {
  req: '需求',
  dev: '开发',
  qa: '测试',
  coord: '调度',
  lib: '资料',
  ops: '运维',
  custom: '专项',
}

/**
 * Who answers when several bots could.
 *
 * Low number wins. `coord` first is deliberate: the scheduler is the one bot
 * whose whole job is to answer "where does this stand", and the design gives it
 * read-only authority precisely so that being the default responder is safe.
 * `req` is next because intake is the other safe default. A `custom` project bot
 * never wins a tie — it only speaks when it is the bound bot or was named.
 */
export const ROLE_PRIORITY = { coord: 0, req: 1, dev: 2, qa: 3, lib: 4, ops: 5, custom: 6 }

/** What a bot does when a message arrives that it is a candidate for. */
export function defaultSpeakPolicy() {
  return {
    /** Was it @-mentioned (or named in the text)? Then it answers. */
    onMention: true,
    /**
     * May it answer an un-mentioned message that looks like its kind of work
     * (the intent word list)? Off by default: a bot that pipes up on every
     * message is a bot people mute.
     */
    onIntent: false,
    /**
     * Must it hold the reply lease for the chat before speaking un-mentioned?
     * On by default, and it is what keeps two bots from answering the same
     * sentence — the second one sees the lease and stays quiet.
     */
    leaseRequired: true,
    /** Broadcast only: no cards, no follow-up questions, capped length. */
    digestOnly: false,
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** First defined non-empty value, so an explicit `false`/`0` still wins. */
function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((one) => String(one)).filter((one) => one !== '')
}

function boolOf(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** `dev-pay` — lowercase, digits, dash, underscore. Stable enough to be an id. */
export function validBotId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(id)
}

/**
 * Fold one raw bot (from the file, the row config, or the console) into the
 * canonical shape. Never throws; `raw` is returned as `{}` if it is not an
 * object, which yields a bot with an empty id that `botProblems` will flag.
 */
export function normalizeBot(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const feishu = isPlainObject(source.feishu) ? source.feishu : {}
  const policy = isPlainObject(feishu.speakPolicy)
    ? feishu.speakPolicy
    : isPlainObject(feishu.speak_policy)
      ? feishu.speak_policy
      : {}
  const persona = isPlainObject(source.persona) ? source.persona : {}
  const defaults = defaultSpeakPolicy()

  const id = pick(source.id, source.bot_id) ?? ''
  const role = String(pick(source.role, 'custom'))
  const baseRole = String(pick(source.baseRole, source.base_role, role))

  return {
    id: typeof id === 'string' ? id.trim() : String(id),
    displayName: String(pick(source.displayName, source.display_name, source.name, id) ?? ''),
    role,
    /** The role whose permissions/preset this bot starts from (02 §1.2). */
    baseRole,
    persona: {
      tone: String(pick(persona.tone, 'concise')),
      language: String(pick(persona.language, 'zh')),
    },
    /**
     * Which DSH agent preset this bot runs as.
     *
     * Empty means "ask `sessions.presets[role]`, then `sessions.preset`" — the
     * resolution lives in one place (exec.js) so the roster cannot disagree with
     * what actually runs.
     */
    agentPreset: pick(source.agentPreset, source.agent_preset) ?? null,
    feishu: {
      /**
       * Which Feishu app this bot speaks through. Empty = the plugin's default
       * app (`feishu.appId`). ONE APP IS ONE LONG CONNECTION AND ONE IDENTITY:
       * two bots sharing an app_id are the same face in the chat, so a real
       * multi-bot group needs one app per bot (02 §1.2, README).
       */
      appId: String(pick(feishu.appId, feishu.app_id) ?? ''),
      /** Chats it serves. EMPTY MEANS EVERY CHAT OF ITS APP (see docs §18). */
      chats: stringList(pick(feishu.chats, feishu.chat_ids, [])),
      speakPolicy: {
        onMention: boolOf(pick(policy.onMention, policy.on_mention), defaults.onMention),
        onIntent: boolOf(pick(policy.onIntent, policy.on_intent), defaults.onIntent),
        leaseRequired: boolOf(pick(policy.leaseRequired, policy.lease_required), defaults.leaseRequired),
        digestOnly: boolOf(pick(policy.digestOnly, policy.digest_only), defaults.digestOnly),
      },
    },
    scope: {
      projects: stringList(isPlainObject(source.scope) ? source.scope.projects : undefined),
      repos: stringList(isPlainObject(source.scope) ? source.scope.repos : undefined),
      docs: stringList(isPlainObject(source.scope) ? source.scope.docs : undefined),
      memoryScopes: stringList(
        isPlainObject(source.scope)
          ? pick(source.scope.memoryScopes, source.scope.memory_scopes, [])
          : undefined,
      ),
    },
    permissions: normalizePermissions(source.permissions),
    model: {
      primary: pick(isPlainObject(source.model) ? source.model.primary : undefined) ?? null,
      perTask: isPlainObject(isPlainObject(source.model) ? source.model.perTask : undefined)
        ? { ...source.model.perTask }
        : isPlainObject(isPlainObject(source.model) ? source.model.per_task : undefined)
          ? { ...source.model.per_task }
          : {},
    },
    budget: normalizeBudget(source.budget),
    skills: stringList(source.skills),
    knowledgePack: pick(source.knowledgePack, source.knowledge_pack) ?? null,
    /*
     * New bots start DISABLED unless the roster says otherwise. A hand-written
     * roster that forgets `enabled` must not silently start answering in a real
     * group; the console's 机器人 page is where it gets switched on.
     */
    enabled: boolOf(source.enabled, false),
  }
}

function normalizePermissions(raw) {
  const source = isPlainObject(raw) ? raw : {}
  return {
    canCreate: stringList(pick(source.canCreate, source.can_create, [])),
    canUpdate: stringList(pick(source.canUpdate, source.can_update, [])),
    cannot: stringList(source.cannot),
    writesTo: stringList(pick(source.writesTo, source.writes_to, [])),
    approvalRequired: stringList(pick(source.approvalRequired, source.approval_required, [])),
  }
}

function normalizeBudget(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const number = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return {
    dailyTokens: number(pick(source.dailyTokens, source.daily_tokens, null)),
    dailyCostUsd: number(pick(source.dailyCostUsd, source.daily_cost_usd, null)),
    maxConcurrentTasks: number(pick(source.maxConcurrentTasks, source.max_concurrent_tasks, 1)) ?? 1,
    onExceed: String(pick(source.onExceed, source.on_exceed, 'pause')),
  }
}

/**
 * The six standing roles from design doc 02 §1.1, as the roster the plugin
 * ships with.
 *
 * ONLY `req` IS ENABLED. Two reasons, both about not surprising an operator:
 *   - a fresh install has one Feishu app, so five more enabled bots would all be
 *     the same face in the same group, answering each other's cues;
 *   - intake (`req`) is the one role that is useful the moment someone writes to
 *     the bot, and it is the role whose job is defined as "listen, extract,
 *     draft a requirement" — the behaviour this plugin already has.
 * The rest are there to be switched on, with their roles and display names ready.
 */
export function defaultBots() {
  return [
    {
      id: 'req',
      displayName: '需求机器人',
      role: 'req',
      enabled: true,
      feishu: { speakPolicy: { onIntent: true } },
    },
    { id: 'dev', displayName: '开发机器人', role: 'dev' },
    { id: 'qa', displayName: '测试机器人', role: 'qa' },
    { id: 'coord', displayName: '调度机器人', role: 'coord' },
    { id: 'lib', displayName: '资料机器人', role: 'lib' },
    { id: 'ops', displayName: '运维机器人', role: 'ops' },
  ].map((one) => normalizeBot(one))
}

/**
 * The effective roster: whatever the sources carry, normalized, defaults filled.
 *
 * AN EXPLICIT EMPTY ARRAY MEANS "NO ROSTER", not "use the defaults". That is the
 * switch for single-assistant mode: someone who wants the old behaviour — one
 * assistant, one session per chat, no bot identity — writes `bots: []` and gets
 * it. Getting the defaults *back* requires an explicit roster, which is a
 * deliberate act rather than a typo away.
 */
export function resolveBots(raw) {
  if (Array.isArray(raw)) return raw.map((one) => normalizeBot(one))
  if (isPlainObject(raw)) {
    // A map keyed by id is a reasonable hand-written shape: `bots: {dev: {...}}`.
    return Object.entries(raw).map(([id, one]) =>
      normalizeBot({ id, ...(isPlainObject(one) ? one : {}) }),
    )
  }
  return defaultBots()
}

/** Enabled bots, in the order a tie is broken. */
export function orderedBots(bots) {
  return [...bots].sort((a, b) => {
    const byRole = (ROLE_PRIORITY[a.role] ?? 99) - (ROLE_PRIORITY[b.role] ?? 99)
    if (byRole !== 0) return byRole
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Configuration problems as VALUES, so the console can show them per row instead
 * of the operator reading the log.
 *
 * @param {object} bot normalized bot
 * @param {{bots: object[], knownPresets?: string[], defaultAppId?: string,
 *   appsWithSecret?: string[]}} context
 *   `appsWithSecret` is what makes "this bot names an app nobody configured" an
 *   error instead of a silent fallback to the default app. It is optional: a caller
 *   that does not know the app registry says nothing rather than guessing.
 * @returns {{field: string, message: string, level: 'warn'|'error'}[]}
 */
export function botProblems(bot, context) {
  const bots = Array.isArray(context?.bots) ? context.bots : []
  const others = bots.filter((one) => one !== bot)
  const out = []
  const bad = (field, message) => out.push({ field, message, level: 'error' })
  const warn = (field, message) => out.push({ field, message, level: 'warn' })

  if (!validBotId(bot.id)) {
    bad('id', '机器人 id 必须是 [a-z][a-z0-9_-]*（最长 32 位）：没有 id 就无法路由、@ 或修复')
    return out
  }
  if (others.some((one) => one.id === bot.id)) bad('id', '机器人 id 重复：' + bot.id)

  // The id is the documented fallback, so this only fires on a name that is
  // whitespace: "no name at all" already resolved to the id (and IS mentionable).
  if (String(bot.displayName).trim() === '') warn('displayName', '没有显示名：群里 @ 不到它，卡片上也没法称呼它')
  if (!BOT_ROLES.includes(bot.role)) bad('role', '未知角色 ' + bot.role + '（可用：' + BOT_ROLES.join('/') + '）')
  if (!BOT_ROLES.includes(bot.baseRole)) bad('baseRole', '未知基准角色 ' + bot.baseRole)

  const appId = bot.feishu.appId !== '' ? bot.feishu.appId : String(context?.defaultAppId ?? '')
  if (bot.enabled && appId === '') {
    bad('feishu.appId', '已启用但没有可用的飞书应用：本机器人填了空，全局 feishu.appId 也是空 —— 它上不了线')
  } else if (bot.enabled && Array.isArray(context?.appsWithSecret) && !context.appsWithSecret.includes(appId)) {
    /*
     * Answering as a robot nobody configured must not happen BY FALLBACK: a bot that
     * names an app with no secret would otherwise come online as the default app —
     * the wrong identity, saying things in the wrong voice, with no error anywhere.
     */
    bad(
      'feishu.appId',
      '这台机器人的应用 ' + appId.slice(0, 8) + '… 还没有 appSecret：在「机器人」页选中它，填「应用密钥」',
    )
  }
  if (typeof bot.agentPreset === 'string' && Array.isArray(context?.knownPresets)) {
    if (context.knownPresets.length > 0 && !context.knownPresets.includes(bot.agentPreset)) {
      warn('agentPreset', '未知 agent 预设 ' + bot.agentPreset + '：会退回按角色的预设或全局预设')
    }
  }

  /*
   * Two enabled bots on one app, both serving one chat, neither requiring a
   * mention: both would answer every message, as the same face. That is the
   * single most likely misconfiguration of this page, so it is named here.
   */
  if (bot.enabled) {
    for (const other of others) {
      if (other.enabled !== true || other.id === bot.id) continue
      /*
       * The comparison is on the app each bot ACTUALLY speaks through, not on whether
       * both left the field empty: a bot that adopted the installation's app id (see
       * config.ownApps) is just as much on that app. Two enabled bots on one app are
       * one face in the group — advice, not a refusal, because sharing deliberately is
       * allowed and only the operator knows whether that is what they meant.
       */
      const otherAppId = other.feishu.appId !== '' ? other.feishu.appId : String(context?.defaultAppId ?? '')
      if (appId === '' || otherAppId !== appId) continue
      const overlaps =
        bot.feishu.chats.length === 0 ||
        other.feishu.chats.length === 0 ||
        bot.feishu.chats.some((chat) => other.feishu.chats.includes(chat))
      if (!overlaps) continue
      const bothLoose = bot.feishu.speakPolicy.onMention === false && other.feishu.speakPolicy.onMention === false
      if (bothLoose) {
        warn('feishu.speakPolicy', '和 ' + other.id + ' 都关了「被 @ 才回答」，同一个群会各答一遍')
      } else {
        warn(
          'feishu.appId',
          '和 ' + other.id + ' 共用同一个飞书应用（' + appId.slice(0, 8) + '…）：在群里是同一张脸；要各有身份就得每个机器人一个应用',
        )
      }
    }
  }

  const policy = bot.feishu.speakPolicy
  if (policy.onMention === false && policy.onIntent === false) {
    warn('feishu.speakPolicy', '既不回答 @ 也不看意图：这个机器人只会记录，不会在群里说话')
  }
  if (policy.digestOnly === true && policy.onIntent === true) {
    warn('feishu.speakPolicy', '只播报却又看意图：未被 @ 时也可能会发一条摘要')
  }
  return out
}

/**
 * Which bots handle a message in this chat, best candidate first.
 *
 * ORDER MATTERS AND IS DOCUMENTED because it decides who speaks:
 *   1. a bot NAMED in the text (`@需求机器人`, `需求机器人`, `req`). An explicit
 *      address outranks everything: a person who types the name of a bot means that
 *      bot, and a sticky binding that swallowed the request would make the roster
 *      unusable in a group served by several bots;
 *   2. the chat's bound bot, if it is still a candidate — a chat that has been
 *      served by one bot keeps that bot, so a roster edit does not silently swap
 *      the personality people have been talking to;
 *   3. the highest-priority candidate (see ROLE_PRIORITY).
 *
 * `defaultAppId` IS NOT `appId`, and conflating them is a real bug: `appId` is the
 * app this EVENT arrived on, while a bot with no `feishu.appId` of its own belongs
 * to the installation's default app. Using the event's app as the fallback makes
 * every app-less bot a candidate on every app — several identities answering one
 * message, the exact opposite of what the filter is for.
 *
 * @param {{bots: object[], chatId: string, text?: string, appId?: string,
 *          defaultAppId?: string, boundBotId?: string|null}} input
 * @returns {object[]} candidates, best first
 */
export function routeBots(input) {
  const chatId = String(input.chatId ?? '')
  const appId = String(input.appId ?? '')
  const defaultAppId = String(input.defaultAppId ?? '')
  const enabled = orderedBots((input.bots ?? []).filter((one) => one.enabled === true))

  const serving = enabled.filter((bot) => {
    const botApp = bot.feishu.appId !== '' ? bot.feishu.appId : defaultAppId
    if (appId !== '' && botApp !== appId) return false
    // Empty `chats` = every chat of its app; a non-empty list is a real filter.
    return bot.feishu.chats.length === 0 || bot.feishu.chats.includes(chatId)
  })
  if (serving.length === 0) return []

  const ranked = []
  const text = typeof input.text === 'string' ? input.text : ''
  if (text !== '') {
    for (const bot of serving) if (addressesBot(text, bot)) ranked.push(bot)
  }
  const bound = serving.find((bot) => bot.id === input.boundBotId)
  if (bound !== undefined && !ranked.includes(bound)) ranked.push(bound)
  for (const bot of serving) if (!ranked.includes(bot)) ranked.push(bot)
  return ranked
}

/**
 * Whether the text names this bot.
 *
 * Deliberately literal: the display name, the id, and `@<display name>`. There is
 * no fuzzy matching, because "the bot decided you meant it" is indistinguishable
 * from "the bot interrupts people".
 */
export function addressesBot(text, bot) {
  const haystack = String(text)
  const needles = [bot.displayName, bot.id].filter((one) => typeof one === 'string' && one.length > 1)
  return needles.some((one) => haystack.includes(one))
}

/**
 * The roster entry behind a `bot:<id>` principal, or null.
 *
 * The assignee on a task IS the identity of the worker (`bot:dev`), so this is the
 * lookup that decides which agent preset, model and role a task runs with. A task
 * assigned to a bot id that is not in the roster is not an error — it falls back to
 * the role mapping (exec.js `presetFor`), which is what a hand-written ledger from
 * before the roster looks like.
 */
export function findBot(bots, id) {
  if (typeof id !== 'string' || id === '') return null
  const wanted = id.startsWith('bot:') ? id.slice(4) : id
  return (Array.isArray(bots) ? bots : []).find((one) => one.id === wanted) ?? null
}

/**
 * Who supplies the agent preset for each role, as the console shows it.
 *
 * WHY THIS IS DERIVED AND NOT CONFIGURED. The preset belongs to the BOT — it is a
 * property of "which agent this is" — and a session is created on demand from that
 * bot, so a per-role table on the 配置 page was asking a human to type the same
 * decision twice, in the place that loses. What remains writable is the bot's own
 * `agentPreset` (机器人 page) plus the global `sessions.preset` fallback; this view
 * exists so the console can SHOW the resolution instead of offering it as a form.
 *
 * @returns {Array<{role: string, roleLabel: string, botId: string|null, botName: string|null,
 *   preset: string|null, source: 'bot'|'sessions.presets'|'sessions.preset'|'none'}>}
 */
export function sessionRoleView(config) {
  const bots = Array.isArray(config?.bots) ? config.bots : []
  const sessions = config?.sessions !== null && typeof config?.sessions === 'object' ? config.sessions : {}
  const byRole = sessions.presets !== null && typeof sessions.presets === 'object' && !Array.isArray(sessions.presets) ? sessions.presets : {}
  const fallback = typeof sessions.preset === 'string' && sessions.preset !== '' ? sessions.preset : null

  const row = (role, bot) => {
    const own = bot !== null && typeof bot.agentPreset === 'string' && bot.agentPreset !== '' ? bot.agentPreset : null
    const mapped = typeof byRole[role] === 'string' && byRole[role] !== '' ? byRole[role] : null
    const preset = own ?? mapped ?? fallback
    return {
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
      botId: bot === null ? null : bot.id,
      botName: bot === null ? null : bot.displayName,
      preset,
      source: own !== null ? 'bot' : mapped !== null ? 'sessions.presets' : fallback !== null ? 'sessions.preset' : 'none',
    }
  }

  const out = []
  const seen = new Set()
  // One row per role, taken from the roster in the same order routing uses, so the
  // first bot of a role is the one whose preset wins.
  for (const bot of orderedBots(bots)) {
    if (seen.has(bot.role)) continue
    seen.add(bot.role)
    out.push(row(bot.role, bot))
  }
  /*
   * Roles that exist ONLY as a mapping. Shown rather than hidden: a leftover
   * `sessions.presets.req` with no req bot is exactly the kind of stale knob that
   * silently applies to a session nobody connected to a bot.
   */
  for (const role of Object.keys(byRole)) {
    if (seen.has(role)) continue
    seen.add(role)
    out.push(row(role, null))
  }
  return out
}

/**
 * 这个群的**主机器人**是谁。
 *
 * 设计要求（2026-09-12 用户补充）：**每个群有一个主的机器人，而且主机器人负责这个群
 * 所有消息的记录** —— 不管最后是谁回答、甚至没人回答。
 *
 * 之所以要一个"主"而不是"谁回答谁是"，有两个原因：
 *   1. **记录要有归属**：群里每条消息都要落到某个机器人的账上（它看到了什么、
 *      这个群最近发生了什么），否则"这个群最近在聊什么"没有主；
 *   2. **黏性要有依据**：一个群昨天是需求机器人在跟，今天不该因为一条被点名的消息
 *      就换主 —— 换主是**显式动作**（群里点名可以定主，也可以由人改），
 *      而不是回答顺序的副作用。
 *
 * 选法就是路由顺序（点名 > 已绑定 > 角色优先级），取第一个：
 * 与"谁来回这一条"共用同一套规则，避免出现"记录归 A、回答归 B 且没人说得清为什么"。
 */
export function pickPrimaryBot(config, input) {
  const bound = typeof input?.boundBotId === 'string' && input.boundBotId !== '' ? input.boundBotId : null
  const candidates = routeBots({
    bots: Array.isArray(config?.bots) ? config.bots : [],
    chatId: input?.chatId ?? '',
    text: typeof input?.text === 'string' ? input.text : '',
    appId: input?.appId ?? '',
    defaultAppId: typeof config?.feishu?.appId === 'string' ? config.feishu.appId : '',
    boundBotId: bound,
  })
  if (candidates.length === 0) return null
  /*
   * 已经有主 → **只要它还在服务这个群，主就是它**。
   *
   * 这一句是"回答"与"归属"两件事的分界线：回答的顺序是**点名 > 已绑定 > 优先级**
   * （被点名的人来答），而归属是**黏性的** —— 一个群被点名换人回答一次，
   * 不该把"这个群归谁记"也换掉。只有当原来的主不再服务这个群（被停用、
   * 或者它的 chats 不再包含这个群）时才重新选。
   */
  if (bound !== null) {
    const stillServing = candidates.find((bot) => bot.id === bound)
    if (stillServing !== undefined) return stillServing
  }
  // 首次接触：这条消息点名了谁，这个群就归谁（"第一次说话的人定归属"），否则按优先级。
  return candidates[0]
}

/**
 * 每个角色**默认不能做什么**（设计 02 §1.1 的"绝不能做什么"那一列）。
 *
 * 这份表以前只存在于文档里：机器人名册有 `permissions.cannot` 字段，但没有任何
 * 地方读它，于是"需求机器人手里不该有 git 写权限"这句话在代码里没有落点 ——
 * 一个被派了活的需求机器人和开发机器人权限完全一样。
 *
 * 能力名是硬编码的一套小词汇（下面 `CAPABILITIES`），因为它要被三处同时引用：
 * 角色默认表、机器人自己的 `permissions.cannot`、以及执行时的判定。
 * `approval_required` 里的能力**不是禁止**，而是"要有人点头"——判定结果里单独标出来。
 */
export const CAPABILITIES = Object.freeze(['run_task', 'write_code', 'merge', 'deploy', 'edit_requirement', 'assign'])

export const ROLE_CAPABILITIES = Object.freeze({
  req: Object.freeze({ cannot: ['write_code', 'merge', 'deploy'], approval_required: [] }),
  dev: Object.freeze({ cannot: ['merge', 'deploy'], approval_required: [] }),
  qa: Object.freeze({ cannot: ['merge', 'deploy'], approval_required: [] }),
  coord: Object.freeze({ cannot: ['write_code', 'merge', 'edit_requirement'], approval_required: [] }),
  lib: Object.freeze({ cannot: ['merge', 'deploy'], approval_required: [] }),
  ops: Object.freeze({ cannot: [], approval_required: ['deploy'] }),
  custom: Object.freeze({ cannot: [], approval_required: [] }),
})

/**
 * 这台机器人能不能做这件事。
 *
 * 顺序：机器人自己的 `permissions.cannot`（最具体，先看）→ 角色的默认表 →
 * `approval_required`（不是拒绝，是需要点头）。
 *
 * @param {object} bot normalized bot
 * @param {string} capability one of CAPABILITIES
 * @returns {{ok: true, approvalRequired: boolean}|{ok: false, message: string}}
 */
export function botCan(bot, capability) {
  const name = String(capability ?? '')
  const own = bot?.permissions?.cannot ?? []
  if (own.includes(name)) return { ok: false, message: bot.displayName + '（' + bot.id + '）的 permissions.cannot 里写着不能 ' + name }
  const byRole = ROLE_CAPABILITIES[bot?.role] ?? ROLE_CAPABILITIES.custom
  const extra = bot?.permissions?.cannot ?? []
  if (byRole.cannot.includes(name) && !own.includes('allow:' + name)) {
    return {
      ok: false,
      message:
        bot.displayName + '（' + bot.id + '）是' + (ROLE_LABELS[bot.role] ?? bot.role) +
        '角色：按设计它不能 ' + name + '（要放开就写 permissions.cannot 里加 allow:' + name + '）',
    }
  }
  const approvals = [...(byRole.approval_required ?? []), ...(bot?.permissions?.approvalRequired ?? []), ...extra.filter((one) => one.startsWith('approval:'))]
  return { ok: true, approvalRequired: approvals.some((one) => one === name || one === 'approval:' + name) }
}

/**
 * 这台机器人能不能碰这个仓库（`scope.repos`）。
 *
 * 空 = 不限（默认不打扰）。非空就是白名单：一个只该动 `pay-service` 的机器人
 * 不应该因为模型给任务填了另一个仓库就去动它。
 */
export function botCanTouchRepo(bot, repo) {
  const scoped = bot?.scope?.repos ?? []
  if (scoped.length === 0) return { ok: true }
  const name = typeof repo === 'string' ? repo : ''
  if (name === '') return { ok: true }
  if (scoped.includes(name)) return { ok: true }
  return { ok: false, message: bot.displayName + '（' + bot.id + '）的 scope.repos 不含 ' + name + '（现有：' + scoped.join('/') + '）' }
}

/**
 * 这个群登记过吗（设计 04 §6 准入第一道）。
 *
 * 登记 = **某个启用机器人的 `feishu.chats` 里明确写了它**，或者在 `chatAllowlist` 里。
 * 注意与"chats 为空 = 服务该应用下所有群"不冲突：那是"没登记也能干活"的默认，
 * 由 `feishu.requireRegisteredChat` 决定要不要收紧；这里只回答"登记过没有"。
 */
export function isRegisteredChat(config, chatId) {
  const id = String(chatId ?? '')
  if (id === '') return false
  const allow = Array.isArray(config?.feishu?.chatAllowlist) ? config.feishu.chatAllowlist : []
  if (allow.includes(id)) return { ok: true, via: 'allowlist' }
  for (const bot of Array.isArray(config?.bots) ? config.bots : []) {
    if (bot.enabled !== true) continue
    if (bot.feishu.chats.includes(id)) return { ok: true, via: bot.id }
  }
  return { ok: false }
}

/** One-line description for the roster list and the logs. */
export function describeBot(bot) {
  const label = ROLE_LABELS[bot.role] ?? bot.role
  const app = bot.feishu.appId !== '' ? bot.feishu.appId : '（没有应用）'
  const chats = bot.feishu.chats.length === 0 ? '全部群' : bot.feishu.chats.length + ' 个群'
  return bot.displayName + '（' + bot.id + ' · ' + label + ' · ' + app + ' · ' + chats + '）'
}
