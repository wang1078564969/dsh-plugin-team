/*
 * Team configuration: where the data lives, which workspace worker sessions
 * run in, and which gate policy a new task snapshots.
 *
 * WHY THREE SOURCES AND NOT ONE. The sibling Feishu bridge learned this the
 * hard way: a Cordis row's `config:` block is convenient but invisible — it
 * lives in whichever composition file happened to insert the row, and the
 * operator editing "the team config" has no way to find it. So the row config
 * is honoured, but the durable answer is a file the operator owns
 * (`$DSH_HOME/team/config.json`, `cat`-able, hand-editable, git-ignorable),
 * and an environment variable is available for one-off experiments:
 *
 *     env  >  config file  >  row config  >  defaults
 *
 * Everything here is a plain value with a default, because a collaboration
 * layer that refuses to start over a missing key is worse than one that starts
 * with a documented default and says what it used.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_DOMAINS, resolveTaskTypes } from './tasktypes.js'
import { defaultBots, resolveBots } from './bots.js'
import { resolveMembers } from './members.js'

/** `$DSH_HOME`, falling back to `~/.dsh` the way the rest of the harness resolves it. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Where the object ledger lives. `DSH_TEAM_DATA` wins, then `<home>/team`. */
export function defaultDataDir() {
  const fromEnv = process.env.DSH_TEAM_DATA
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(dshHome(), 'team')
}

/**
 * Gate policy a new task snapshots into its own `gates` record.
 *
 * The snapshot is the point (design doc 06 §4.2): editing this file later must
 * NOT re-time work that is already in flight, so these values are read once per
 * task creation and frozen onto the task. Defaults mirror the example config in
 * the design (`workflow.yaml`): 8h / 4h / 2h / 8h, `accept` reminds, `start`
 * releases.
 */
export function defaultGateSpecs() {
  return {
    confirm_split: { timeout: '8h', on_timeout: 'remind_then_escalate', max_release: null },
    accept: { timeout: '4h', on_timeout: 'remind_then_escalate', max_release: null },
    start: { timeout: '2h', on_timeout: 'auto_release', max_release: 2 },
    acceptance: { timeout: '8h', on_timeout: 'escalate_to_owner', max_release: null },
  }
}

/**
 * Who counts as a domain owner, and who may accept work.
 *
 * Placeholders on purpose: the ledger is useful before a team exists, and an
 * empty list has a defined meaning in the state machine (no listed confirmer ⇒
 * the requirement owner or PM may confirm). Filling these in is a config edit,
 * not a code change.
 */
export function defaultMembers() {
  return {
    pm: [],
    requirement: [],
    development: [],
    testing: [],
    ops: [],
    security: [],
  }
}

/**
 * 角色域 → 兜底确认人（设计 03 §2.4 规则 5："每个被引用的域都必须有 owner 或 fallback"）。
 *
 * 为什么必须有兜底：一个域没人负责时，跨域任务会**静默卡在门禁上** ——
 * 卡片在等一个不存在的人，而没有任何地方报错。`fallback` 是"这个人不在时找谁"，
 * 与"这个域没人"是两件事，所以它单独存一份。
 */
export function defaultDomainFallbacks() {
  return {
    pm: null,
    product: null,
    design: null,
    requirement: null,
    development: null,
    testing: null,
    ops: null,
    data: null,
    security: null,
    docs: null,
  }
}

/** Worker-session defaults: a preset per role, and the model override, if any. */
function defaultSessions() {
  return {
    /** Agent preset for worker sessions when the role has no specific one. */
    preset: null,
    /** role (req/dev/qa/coord/pm/lib/ops) → agent preset id. */
    presets: {},
    provider: null,
    model: null,
    reasoningEffort: null,
    /** How long one driven turn may take before the driver gives up on it. */
    turnTimeoutMs: 15 * 60 * 1000,
    /** Live worker sessions kept warm; the oldest is disposed beyond this. */
    maxLive: 4,
  }
}

/**
 * Give every bot its OWN app id.
 *
 * WHY THIS IS A LOADER JOB AND NOT A FALLBACK AT USE TIME. A bot that inherits
 * "whatever app the installation has" has no identity of its own: the console would
 * have to show an empty field next to a global app id labelled the default, and
 * "which app is this bot on" would stop being a property of the bot. So the
 * installation-level `feishu.appId` is ADOPTED into each bot that names none — once,
 * here — and from then on every bot answers the question itself. Saving the roster
 * writes that id into the bot, which is what the editor shows and submits.
 *
 * Nothing changes at runtime (the same app is dialled), and nothing breaks when no
 * app is configured at all: the id stays empty and the roster says so.
 */
export function ownApps(bots, appId) {
  if (typeof appId !== 'string' || appId === '') return bots
  return bots.map((bot) =>
    bot.feishu.appId === '' ? { ...bot, feishu: { ...bot.feishu, appId } } : bot,
  )
}

/** Read `$DSH_HOME/team/config.json` if it exists; never throw over a bad file. */
function readConfigFile(path) {
  if (!existsSync(path)) return {}
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      console.error('[team] ' + path + ' is not a JSON object — ignoring it')
      return {}
    }
    return doc
  } catch (error) {
    console.error('[team] cannot read ' + path + ': ' + String(error && error.message ? error.message : error))
    return {}
  }
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** 数字型配置：非法值（`'abc'` / `NaN`）退回默认，而不是让 `Number()` 的 NaN 漏进运行时。 */
function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function objectOf(...values) {
  const out = {}
  for (const value of values) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, value)
  }
  return out
}

/**
 * Resolve the effective configuration.
 *
 * @param {object|undefined} rowConfig the row's `config:` block, if any
 * @returns {object} resolved configuration (never null)
 */
export function loadConfig(rowConfig) {
  const row = rowConfig !== null && typeof rowConfig === 'object' ? rowConfig : {}
  // The data directory has to be resolved BEFORE the config file is read: the
  // file lives inside it. So it is the one setting the file cannot provide.
  const dataDir = pick(process.env.DSH_TEAM_DATA, row.dataDir, defaultDataDir())
  const file = readConfigFile(join(dataDir, 'config.json'))

  const fileSessions = objectOf(file.sessions)
  const rowSessions = objectOf(row.sessions)

  const sessions = {
    ...defaultSessions(),
    preset: pick(rowSessions.preset, fileSessions.preset, null),
    presets: objectOf(fileSessions.presets, rowSessions.presets),
    provider: pick(rowSessions.provider, fileSessions.provider, null),
    model: pick(rowSessions.model, fileSessions.model, null),
    reasoningEffort: pick(rowSessions.reasoningEffort, fileSessions.reasoningEffort, null),
    turnTimeoutMs: pick(rowSessions.turnTimeoutMs, fileSessions.turnTimeoutMs, 15 * 60 * 1000),
    maxLive: pick(rowSessions.maxLive, fileSessions.maxLive, 4),
  }
  if (process.env.DSH_TEAM_PRESET !== undefined && process.env.DSH_TEAM_PRESET !== '') {
    sessions.preset = process.env.DSH_TEAM_PRESET
  }

  const workspace = pick(
    process.env.DSH_TEAM_WORKSPACE,
    row.workspace,
    file.workspace,
    join(dataDir, 'workspace'),
  )

  const rowFeishu = objectOf(row.feishu)
  const fileFeishu = objectOf(file.feishu)

  /*
   * Accepted in both places on purpose: the console writes them under `feishu`
   * (where this loader reads them), while a hand-written file may very reasonably
   * put `senders` next to `members`. Reading only one shape is how a saved value
   * goes missing without an error.
   */
  const senders = objectOf(fileFeishu.senders, file.senders, rowFeishu.senders, row.senders)
  const chatActors = objectOf(fileFeishu.chatActors, file.chatActors, rowFeishu.chatActors, row.chatActors)

  /*
   * THE ROSTER AND THE MEMBER TABLE, resolved before the return because the rest
   * of the return reads them: `bots` is what inbound messages route to, and the
   * member rows DERIVE the domain map the ledger has always consumed.
   *
   * `bots: []` is meaningful (single-assistant mode), so an empty array must not
   * be confused with "not configured" — hence the explicit undefined check rather
   * than a truthiness test.
   */
  const rawBots = pick(row.bots, file.bots)
  const bots = ownApps(resolveBots(rawBots === undefined ? defaultBots() : rawBots), pick(rowFeishu.appId, fileFeishu.appId, ''))
  const rawMembers = pick(row.members, file.members)
  const members = resolveMembers({
    members: rawMembers === undefined ? defaultMembers() : rawMembers,
    domains: pick(row.domains, file.domains),
    senders,
  })

  /*
   * **被 row config 固定的键**（诊断用）。
   *
   * 配置来源的真实顺序是 `env > row > config.json > 默认值`（见 `pick(row.X, file.X, …)`），
   * 所以 profile 里写过的键，面板改它不会有任何效果 —— 保存会成功、值会落进 config.json，
   * 但读出来的仍是 row 的值。这种"改了没反应"最容易被当成 bug，所以把清单算出来交给面板显示。
   */
  const rowPinned = []
  const markPinned = (prefix, source, skip) => {
    for (const key of Object.keys(source ?? {})) {
      if (source[key] === undefined || source[key] === null) continue
      if (Array.isArray(skip) && skip.includes(key)) continue
      rowPinned.push(prefix === '' ? key : prefix + '.' + key)
    }
  }
  markPinned('', row, ['feishu', 'sessions', 'repos'])
  markPinned('feishu', rowFeishu)
  markPinned('sessions', row.sessions)
  markPinned('repos', row.repos)

  return {
    dataDir,
    /** row config 提供过的键（面板据此提示"这个改动不会生效，它被 profile 固定了"）。 */
    rowPinned,
    /**
     * **被读进来、但谁也不读**的键。这类键是"看起来能配、实际不生效"的陷阱 ——
     * 配置台保存时会拒绝它们（`validatePatch`），但手写 config.json 的人绕过了那道检查，
     * 所以加载期也要把清单算出来，让「配置检查」能把它们显示成问题。
     */
    ignoredKeys: [
      ...((Array.isArray(fileFeishu.chatIds) ? fileFeishu.chatIds : Array.isArray(rowFeishu.chatIds) ? rowFeishu.chatIds : []).length === 0
        ? []
        : ['feishu.chatIds']),
      ...(fileFeishu.statePath === undefined && rowFeishu.statePath === undefined ? [] : ['feishu.statePath']),
    ],
    configFile: join(dataDir, 'config.json'),
    workspace,
    sessions,
    gates: objectOf(defaultGateSpecs(), file.gates, row.gates),
    /**
     * Domain → principals, DERIVED from the member table (plus any legacy
     * `members` map or explicit `domains` block). Kept under this name because
     * the ledger's consumers have always read it here; the table itself is
     * `memberList`.
     */
    members: members.domains,
    /** The member table: one row per person, roles assigned on the person. */
    memberList: members.list,
    memberIndex: { byKey: members.byKey, byOpenId: members.byOpenId },
    /** The bot roster: one row per agent, each 1:1 with its own conversations. */
    bots,
    /** 生效的角色域清单（设计 10 个，配置可以加自己的）。 */
    domains: DEFAULT_DOMAINS,
    /**
     * 任务类型 → 所需域。9 个内置类型 + 配置逐个覆盖。
     * 判定"谁会进确认名单"就靠它（04 §3.5 跨域并行确认）。
     */
    taskTypes: resolveTaskTypes(pick(row.taskTypes, file.taskTypes)),
    /** 每个域的兜底确认人（域没人时不会静默卡住）。 */
    domainFallbacks: objectOf(defaultDomainFallbacks(), file.domainFallbacks, row.domainFallbacks),
    /**
     * Requirement owner used when a requirement is created without one — the
     * ledger stays usable in a single-operator installation.
     */
    defaultOwner: pick(row.defaultOwner, file.defaultOwner, 'human:owner'),
    /** `tick` cadence for gate/lease timeouts; 0 disables the timer entirely. */
    tickIntervalMs: pick(row.tickIntervalMs, file.tickIntervalMs, 60 * 1000),
    /**
     * The workspace title the host client shows for the bots' conversations.
     *
     * Every Feishu chat gets one DSH session; they all live in `workspace`, and
     * this is the name that appears in the sidebar so they are findable.
     */
    workspaceTitle: pick(row.workspaceTitle, file.workspaceTitle, '团队 · 飞书'),
    /** Repository names the extractor may recognise in a message. */
    knownRepos: Array.isArray(file.knownRepos) ? file.knownRepos : Array.isArray(row.knownRepos) ? row.knownRepos : [],
    /**
     * 代码仓库这一侧（设计 03 §1.3–§1.7）。
     *
     * `roots` 是"名字 → 本地检出路径"：仓库知识索引要扫一个真实的目录，而配置里
     * `knownRepos` 只是名字清单（提取器认出仓库名时用的就是它）。
     * `ciTimeoutMs` 是 `ci_stuck` 的判定线：超了就播报（CI 慢 ≠ 失败，但也不能静默）。
     * `autoMerge` 默认关 —— 设计原话是"默认关闭，按需开启"。
     */
    repos: (() => {
      const fileRepos = objectOf(file.repos, row.repos)
      const roots = objectOf(fileRepos.roots)
      const out = {}
      for (const [name, value] of Object.entries(roots)) {
        if (typeof value === 'string' && value !== '') out[name] = value
      }
      return {
        roots: out,
        ciTimeoutMs: numberOr(fileRepos.ciTimeoutMs, 30 * 60 * 1000),
        requiredApprovals: numberOr(fileRepos.requiredApprovals, 1),
        autoMerge: fileRepos.autoMerge === true,
      }
    })(),
    /**
     * The Feishu surface.
     *
     * `mode` decides where INBOUND messages come from:
     *   'own'     this plugin dials Feishu itself (default): its own long
     *             connection, its own chat registry, its own credentials
     *   'off'     no intake at all; cards can still be sent by the tool layer
     *
     * `buttons: false` is the honest default: a card button needs Feishu to
     * reach an HTTPS callback, and this harness listens on 127.0.0.1. With it
     * off, cards carry the text command a human should send instead — which is
     * the card design's own "buttons removed" rung, not a workaround.
     */
    feishu: {
      mode: pick(process.env.DSH_TEAM_FEISHU, rowFeishu.mode, fileFeishu.mode, 'own'),
      /** Answer a group message only when the bot was addressed (p2p always answers). */
      requireMention: pick(rowFeishu.requireMention, fileFeishu.requireMention, true),
      /** Set false to file messages into the ledger without answering in the chat. */
      respond: pick(rowFeishu.respond, fileFeishu.respond, true),
      /**
       * Being @-mentioned outranks the intent word list (design doc 02 §3).
       *
       * True by default, and the trade-off is deliberate: a joke aimed at the bot
       * becomes a draft requirement a human can drop, rather than a person
       * concluding the bot ignores them. False restores the stricter rule.
       */
      addressedOverridesIntent: pick(rowFeishu.addressedOverridesIntent, fileFeishu.addressedOverridesIntent, true),
      /** How long one chat turn may take before the driver gives up on it. */
      turnTimeoutMs: pick(rowFeishu.turnTimeoutMs, fileFeishu.turnTimeoutMs, 15 * 60 * 1000),
      buttons: pick(rowFeishu.buttons, fileFeishu.buttons, false),
      chatIds: Array.isArray(fileFeishu.chatIds) ? fileFeishu.chatIds : Array.isArray(rowFeishu.chatIds) ? rowFeishu.chatIds : [],
      defaultActor: pick(rowFeishu.defaultActor, fileFeishu.defaultActor, 'human:owner'),
      /*
       * `feishu.statePath` **没有任何读取点**（它是从旧 hub 形态抄过来的键）。
       * 保留一个"接受但被忽略"的键，比拒绝它更坏 —— 人会以为自己改了什么：
       * 这与我们对 `feishu.chatIds` 的处理是同一条规矩。这里如实报成
       * `statePathIgnored`，配置台的校验会把它作为问题指出来。
       */
      /*
       * `feishu.statePath` **没有任何读取点**（旧 hub 形态的遗留键）。保留一个
       * "接受但被忽略"的键比拒绝它更坏，所以它只被记进下面的 `ignoredKeys` 里报出来。
       */
      statePathIgnored: pick(rowFeishu.statePath, fileFeishu.statePath, undefined),
      appId: pick(rowFeishu.appId, fileFeishu.appId, ''),
      appSecret: pick(rowFeishu.appSecret, fileFeishu.appSecret, ''),
      /**
       * The bot identity of the DEFAULT app (`ou_…`).
       *
       * Read from the file rather than only probed: with several apps the probe
       * cannot be the only source (each app has its own identity), and pinning it
       * makes "was I mentioned?" answerable before the first API call.
       */
      botOpenId: pick(rowFeishu.botOpenId, fileFeishu.botOpenId, ''),
      /**
       * The other apps this installation speaks through, keyed by app id:
       * `{ "cli_xxx": { appSecret, botOpenId, name } }`.
       *
       * ONE APP IS ONE LONG CONNECTION AND ONE IDENTITY, so a roster with several
       * visible bots needs several apps (see lib/feishu/apps.js). The default app
       * stays in `appId`/`appSecret` above; this map is only for the rest, and a bot
       * selects one with its own `feishu.appId`.
       */
      apps: objectOf(fileFeishu.apps, rowFeishu.apps),
      baseUrl: pick(rowFeishu.baseUrl, fileFeishu.baseUrl, 'https://open.feishu.cn'),
      triage: objectOf(fileFeishu.triage, rowFeishu.triage),
      commands: objectOf(fileFeishu.commands, rowFeishu.commands),
      /**
       * Feishu `open_id` → `human:<name>`.
       *
       * Required for anything a person must personally confirm: without it the
       * team layer cannot tell who pressed the button, and guessing (a default
       * actor) would let anyone accept anyone's task. Unmapped senders are
       * REFUSED on state-changing commands, not admitted as a fallback.
       */
      senders,
      /**
       * `chat_id` → `human:<name>`: "in this chat, relayed messages are this
       * person's".
       *
       * Needed because a message relayed by a bridging plugin carries no sender
       * identity — the bridge strips both the mention and the speaker, so a group
       * command cannot be attributed from what arrives here. Opt in per chat, and
       * only where "one chat = one operator" is actually true: it is a real
       * weakening of "only the assignee may accept" everywhere else.
       */
      chatActors,
      /**
       * How long a bot's claim on "I am answering this chat" stands.
       *
       * Only consulted when two or more bots are candidates and the message was
       * not addressed to one of them (`speakPolicy.leaseRequired`): the first bot
       * takes the lease, the others stay quiet instead of answering the same
       * sentence. Long enough to cover a slow turn, short enough that the next
       * question in the chat is answered normally.
       */
      speakLeaseMs: pick(rowFeishu.speakLeaseMs, fileFeishu.speakLeaseMs, 90 * 1000),
      /**
       * 只处理"登记过的群"（设计 04 §6 准入第一道：群在册）。
       *
       * 默认 false：装了插件、被人拉进一个群，它就干活 —— 这是小团队想要的默认。
       * 打开之后，只有**某个启用机器人的 `feishu.chats` 里明确列了**、或者在
       * `chatAllowlist` 里的群才会被处理；其余群连收件箱都不进（记一行日志）。
       * 一个真跑起来的团队迟早会需要这个开关：被拉进一个不相关的群、
       * 或者某人把机器人转发到私聊里试东西，都会被"默认全收"变成台账噪音。
       */
      requireRegisteredChat: pick(rowFeishu.requireRegisteredChat, fileFeishu.requireRegisteredChat, false),
      /** 收到 @ 的消息先加个表情（设计 04 §0.1 已定："先表态，再走分诊"）。 */
      reaction: pick(rowFeishu.reaction, fileFeishu.reaction, true),
      reactionEmoji: pick(rowFeishu.reactionEmoji, fileFeishu.reactionEmoji, 'Get'),
      /**
       * 追问策略（`ingest.js:421` 读的就是这一块）。
       *
       * 以前它只在读取侧有默认值、配置侧根本没有这个键 —— 于是"每个群最多追问几次、
       * 多久算过期"看着像个旋钮，实际拧不动。补上解析：可配，且有明确默认。
       */
      ask: (() => {
        const fileAsk = objectOf(fileFeishu.ask)
        return {
          maxAsks: numberOr(pick(rowFeishu.ask?.maxAsks, fileAsk.maxAsks, 1), 1),
          ttlMs: numberOr(pick(rowFeishu.ask?.ttlMs, fileAsk.ttlMs, 30 * 60 * 1000), 30 * 60 * 1000),
        }
      })(),
      /**
       * 去重表的保留窗口（天）。设计 04 §4.1："存储：持久表，保留窗口按策略（例如 30 天）"。
       * `0` = 不清理。它同时决定**漏单/观测能回看多久**，所以是一个有语义的配置，
       * 不是纯技术参数。
       */
      dedupeRetentionDays: numberOr(pick(rowFeishu.dedupeRetentionDays, fileFeishu.dedupeRetentionDays, 30), 30),
      /**
       * 日报时刻（**本地时间**的小时，0-23；`-1` 关掉），默认 18 点。
       *
       * 设计 04 §2.1 的报告卡与 02 §1.1 的"调度机器人核心产出"都指着它：
       * 进 digest 的进度**必须有人定期说**，否则"不刷屏"就等于"静默丢失"。
       */
      dailyReportHour: numberOr(pick(rowFeishu.dailyReportHour, fileFeishu.dailyReportHour, 18), 18),
      /** 明确放行的群（与机器人自己的 `chats` 取并集）。 */
      chatAllowlist: Array.isArray(fileFeishu.chatAllowlist)
        ? fileFeishu.chatAllowlist.map((one) => String(one))
        : Array.isArray(rowFeishu.chatAllowlist)
          ? rowFeishu.chatAllowlist.map((one) => String(one))
          : [],
    },
    /**
     * Preset ids the roster may name, for 配置检查 to catch a typo.
     *
     * Collected from the session defaults only: this plugin knows which presets it
     * is configured to use, not the installation's whole catalog. An empty list
     * means "no opinion", and `botProblems` then says nothing rather than flagging
     * every preset as unknown.
     */
    knownPresets: [sessions.preset, ...Object.values(sessions.presets)].filter(
      (one) => typeof one === 'string' && one !== '',
    ),
  }
}
