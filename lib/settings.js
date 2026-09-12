/*
 * The configuration console's host half: read, validate, save, self-check.
 *
 * WHY A CONSOLE AT ALL, WHEN THE CONFIG IS ONE JSON FILE. Because the file is
 * the escape hatch, not the interface. Editing it by hand is fine until the day
 * a typo makes the plugin fail to *do* something quietly — a misspelled
 * `on_timeout` that never fires, a `human:wanger` that never matches a gate, an
 * app secret pasted with a trailing space. The old team hub had a console with a
 * validate step and a live "can we actually reach Feishu" check for exactly this
 * reason; this module is that, minus the process.
 *
 * THREE RULES SHAPE IT:
 *
 *  1. VALIDATE BEFORE WRITING, AND REFUSE RATHER THAN HALF-APPLY. A rejected save
 *     leaves the file exactly as it was; the problems come back as data, with the
 *     path that is wrong.
 *  2. THE SECRET IS WRITE-ONLY. `appSecret` can be set and never read back; the
 *     response says whether one is present. A console that can display a secret
 *     is a console that leaks one into a screenshot.
 *  3. SAVING RELOADS. The running plugin re-reads the file into its live config
 *     object, so a fix takes effect without a restart — except where the design
 *     deliberately freezes values: a task's gate snapshot never changes, so
 *     editing a timeout affects new tasks only. That is not a limitation of the
 *     reload, it is the design (doc 06 §4.2).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { botProblems, normalizeBot } from './bots.js'
import { DEFAULT_DOMAINS, resolveTaskTypes, taskTypeProblems } from './tasktypes.js'
import { AUTO_RELEASE_GATES } from './domain/index.js'
import { appsView } from './feishu/apps.js'
import { memberProblems, normalizeMember } from './members.js'

/** Roles the panel offers when the config has no opinion yet. */
export const KNOWN_DOMAINS = DEFAULT_DOMAINS
/** Worker roles a session preset can be named for. */
export const KNOWN_ROLES = ['req', 'dev', 'qa', 'coord', 'chat', 'lib', 'ops']
const GATE_NAMES = ['confirm_split', 'accept', 'start', 'acceptance']
const ON_TIMEOUT = ['remind_then_escalate', 'auto_release', 'escalate_to_owner', 'notify_submitter']
const PRINCIPAL = /^(human|bot):[^\s:]+$/
const DURATION = /^\d+(m|h|d)$/

/** Every top-level key the console may write. */
const EDITABLE = [
  'defaultOwner',
  'workspace',
  'workspaceTitle',
  'tickIntervalMs',
  /** The member table: one row per person, roles assigned on the person. */
  'members',
  /** The bot roster: one row per agent, each with its own app, chats, sessions. */
  'bots',
  /** Domain → principals. Derived from the member table, writable on its own. */
  'domains',
  'senders',
  'chatActors',
  'knownRepos',
  /** 任务类型 → 所需域（决定谁会进确认名单）。 */
  'taskTypes',
  /** 域 → 兜底确认人（域没人时不会静默卡在门禁上）。 */
  'domainFallbacks',
  'gates',
  'sessions',
  'feishu',
]

const FEISHU_KEYS = [
  'mode',
  'appId',
  'appSecret',
  'botOpenId',
  'requireMention',
  'respond',
  'buttons',
  'chatIds',
  'addressedOverridesIntent',
  'speakLeaseMs',
  /** 准入第一道：只处理登记过的群（设计 04 §6）。 */
  'requireRegisteredChat',
  'chatAllowlist',
  /**
   * `senders` / `chatActors` are accepted BOTH here and at the top level.
   *
   * The panel treats them as peers of `members` (top level) while the FILE has
   * always kept them under `feishu` — and `mergePatch` normalises both onto the
   * nested copy. Refusing the nested shape would mean a hand-written file that uses
   * the file's own layout cannot be saved from the console at all.
   */
  'senders',
  'chatActors',
  /**
   * The other Feishu apps, as a MAP `{appId: {appSecret, botOpenId, name}}`.
   *
   * The read side (`redact`) hands the console an ARRAY of redacted entries, so a
   * patch shaped like the view it was given is refused rather than merged: writing
   * that array into the file would replace every secret with the word
   * `appSecretSet`, which is the kind of loss nobody notices until a bot goes
   * silent. `mergePatch` merges per app, so saving one app's secret keeps the rest.
   */
  'apps',
]

/** Keys the panel may see on a `feishu` object (the secret is replaced by a flag). */
export function redact(config) {
  const feishu = config.feishu ?? {}
  return {
    workspace: config.workspace,
    workspaceTitle: config.workspaceTitle,
    dataDir: config.dataDir,
    configFile: config.configFile,
    defaultOwner: config.defaultOwner,
    tickIntervalMs: config.tickIntervalMs,
    /** The member table (what the 成员 page edits). */
    members: config.memberList ?? [],
    /** The derived domain→principals map (what the ledger reads). */
    domains: config.members ?? {},
    /** The bot roster (what the 机器人 page edits). */
    bots: config.bots ?? [],
    senders: feishu.senders ?? {},
    chatActors: feishu.chatActors ?? {},
    knownRepos: config.knownRepos ?? [],
    taskTypes: config.taskTypes ?? {},
    domainFallbacks: config.domainFallbacks ?? {},
    /*
     * 域清单叫 `knownDomains`，**不能叫 `domains`** —— 后者在面板里已经是
     * "域 → 负责人"那张映射（成员表派生出来的）。同名会把一个数组塞进一个对象的
     * 位置，校验器当场报"必须是一个对象"，而人看到的是"配置里有个问题"却不知道
     * 问题出在投影本身。名字撞车就是这么变成假问题的。
     */
    knownDomains: config.domains ?? [],
    gates: config.gates ?? {},
    sessions: {
      preset: config.sessions?.preset ?? null,
      presets: config.sessions?.presets ?? {},
      provider: config.sessions?.provider ?? null,
      model: config.sessions?.model ?? null,
      reasoningEffort: config.sessions?.reasoningEffort ?? null,
      turnTimeoutMs: config.sessions?.turnTimeoutMs ?? null,
      maxLive: config.sessions?.maxLive ?? null,
    },
    feishu: {
      mode: feishu.mode ?? 'own',
      appId: feishu.appId ?? '',
      appSecretSet: typeof feishu.appSecret === 'string' && feishu.appSecret !== '',
      botOpenId: feishu.botOpenId ?? '',
      requireMention: feishu.requireMention !== false,
      respond: feishu.respond !== false,
      buttons: feishu.buttons === true,
      chatIds: feishu.chatIds ?? [],
      addressedOverridesIntent: feishu.addressedOverridesIntent !== false,
      speakLeaseMs: feishu.speakLeaseMs ?? 90 * 1000,
      requireRegisteredChat: feishu.requireRegisteredChat === true,
      chatAllowlist: feishu.chatAllowlist ?? [],
      /*
       * READ-ONLY VIEW. An array of `{appId, name, botOpenId, appSecretSet,
       * secretFingerprint, source, bots}` — never a secret, and never what a save
       * should send back (the writable shape is the map described in EDITABLE).
       */
      apps: appsView(config),
    },
  }
}

/**
 * Validate one patch. Returns problems, never throws.
 *
 * @param {object} patch a partial config document
 * @param {{defaultAppId?: string, knownPresets?: string[]}} [context]
 *   Validation needs to know the installation's default Feishu app: "this bot has
 *   no app of its own" is only a problem when there is nothing to fall back to, and
 *   a validator that assumed the worst would refuse every roster on a working
 *   single-app installation.
 * @returns {Array<{path: string, message: string}>}
 */
export function validatePatch(patch, context = {}) {
  const problems = []
  const bad = (path, message) => problems.push({ path, message })

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return [{ path: '', message: '配置必须是一个对象' }]
  }
  for (const key of Object.keys(patch)) {
    if (!EDITABLE.includes(key)) bad(key, '未知配置项（拒绝写入：拼错的键必须报错，不能被静默忽略）')
  }

  const principal = (path, value) => {
    if (typeof value !== 'string' || !PRINCIPAL.test(value)) {
      bad(path, '必须形如 human:<名字> 或 bot:<角色>')
    }
  }

  if (patch.defaultOwner !== undefined) principal('defaultOwner', patch.defaultOwner)
  if (patch.workspace !== undefined) {
    if (typeof patch.workspace !== 'string' || patch.workspace === '') bad('workspace', '不能为空')
    else if (!isAbsolute(patch.workspace)) bad('workspace', '必须是绝对路径（工作区由进程按这个路径使用）')
  }
  if (patch.workspaceTitle !== undefined && (typeof patch.workspaceTitle !== 'string' || patch.workspaceTitle === '')) {
    bad('workspaceTitle', '不能为空')
  }
  if (patch.tickIntervalMs !== undefined) {
    const value = Number(patch.tickIntervalMs)
    if (!Number.isFinite(value) || value < 0) bad('tickIntervalMs', '必须是不小于 0 的数字（0 = 关闭自动扫描）')
  }
  if (patch.knownRepos !== undefined) {
    if (!Array.isArray(patch.knownRepos)) bad('knownRepos', '必须是字符串数组')
    else patch.knownRepos.forEach((entry, i) => {
      if (typeof entry !== 'string' || entry === '') bad('knownRepos[' + i + ']', '不能为空')
    })
  }

  for (const [field, key] of [
    ['domains', 'domains'],
    ['senders', 'senders'],
    ['chatActors', 'chatActors'],
  ]) {
    const value = patch[field]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      bad(key, '必须是一个对象')
      continue
    }
    for (const [name, entry] of Object.entries(value)) {
      if (field === 'domains') {
        if (!Array.isArray(entry)) bad('domains.' + name, '必须是数组（可以是空数组：表示该域暂无负责人）')
        else entry.forEach((one, i) => principal('domains.' + name + '[' + i + ']', one))
      } else {
        principal(field + '.' + name, entry)
      }
    }
  }

  /*
   * THE MEMBER TABLE. An OBJECT here is the legacy domain map, and is accepted
   * rather than refused: a browser holding the previous console bundle still
   * sends that shape, and "your tab is stale" must not read as "your config is
   * wrong". It is routed to `domains` by mergePatch, so the table is never
   * overwritten by a map.
   */
  if (patch.members !== undefined && !Array.isArray(patch.members)) {
    if (patch.members === null || typeof patch.members !== 'object') {
      bad('members', '必须是数组（成员表）或对象（旧的角色域映射）')
    } else {
      for (const [name, entry] of Object.entries(patch.members)) {
        if (!Array.isArray(entry)) bad('members.' + name, '必须是数组（可以是空数组：表示该域暂无负责人）')
        else entry.forEach((one, i) => principal('members.' + name + '[' + i + ']', one))
      }
    }
  }
  if (Array.isArray(patch.members)) {
    const normalized = patch.members.map((one) => normalizeMember(one))
    normalized.forEach((member, i) => {
      for (const problem of memberProblems(member, { members: normalized })) {
        // Only errors block: a missing open_id or an unassigned person is worth
        // saying, and in the section that shows warnings — not a reason to refuse
        // a roster edit that is otherwise correct.
        if (problem.level === 'error') bad('members[' + i + '].' + problem.field, problem.message)
      }
    })
  }

  /*
   * THE BOT ROSTER. `[]` is legal and meaningful (single-assistant mode), which is
   * why the emptiness check above is `Array.isArray` and not a truthiness test.
   */
  if (patch.bots !== undefined) {
    if (!Array.isArray(patch.bots)) {
      bad('bots', '必须是数组（[] = 不启用任何机器人，退回单助手模式）')
    } else {
      const normalized = patch.bots.map((one, i) => {
        if (one === null || typeof one !== 'object' || Array.isArray(one)) {
          bad('bots[' + i + ']', '必须是一个对象')
          return null
        }
        return normalizeBot(one)
      })
      const rows = normalized.filter((one) => one !== null)
      /*
       * An app this very patch is adding counts as configured: refusing "bot names
       * cli_new" while the same save writes cli_new's secret would be a false refusal
       * on the one flow the console is actually used for.
       */
      const patchApps = patch.feishu !== null && typeof patch.feishu === 'object' && patch.feishu.apps !== null && typeof patch.feishu.apps === 'object'
        ? Object.entries(patch.feishu.apps)
            .filter(([, entry]) => entry !== null && typeof entry === 'object' && typeof entry.appSecret === 'string' && entry.appSecret !== '')
            .map(([appId]) => appId)
        : []
      const appsWithSecret = Array.isArray(context.appsWithSecret) ? [...new Set([...context.appsWithSecret, ...patchApps])] : undefined
      normalized.forEach((bot, i) => {
        if (bot === null) return
        for (const problem of botProblems(bot, {
          bots: rows,
          knownPresets: context.knownPresets,
          defaultAppId: context.defaultAppId,
          appsWithSecret,
        })) {
          if (problem.level === 'error') bad('bots[' + i + '].' + problem.field, problem.message)
        }
      })
    }
  }

  for (const [field, key] of [
    ['taskTypes', 'taskTypes'],
    ['domainFallbacks', 'domainFallbacks'],
  ]) {
    const value = patch[field]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      bad(key, '必须是一个对象')
      continue
    }
    if (field === 'taskTypes') {
      // 简写（数组）也接受：`code_change: ["development"]`
      const normalized = {}
      for (const [name, spec] of Object.entries(value)) {
        normalized[name] = Array.isArray(spec) ? { domains: spec.map(String) } : spec
      }
      for (const problem of taskTypeProblems(resolveTaskTypes(normalized), KNOWN_DOMAINS)) bad(problem.path, problem.message)
      continue
    }
    for (const [domain, who] of Object.entries(value)) {
      if (who === null || who === '') continue
      principal('domainFallbacks.' + domain, who)
    }
  }

  if (patch.gates !== undefined) {
    if (patch.gates === null || typeof patch.gates !== 'object') bad('gates', '必须是一个对象')
    else {
      for (const [name, gate] of Object.entries(patch.gates)) {
        if (!GATE_NAMES.includes(name)) {
          bad('gates.' + name, '未知门禁（只有 ' + GATE_NAMES.join(' / ') + '）')
          continue
        }
        if (gate === null || typeof gate !== 'object') {
          bad('gates.' + name, '必须是一个对象')
          continue
        }
        if (gate.timeout !== undefined && gate.timeout !== null && !DURATION.test(String(gate.timeout))) {
          bad('gates.' + name + '.timeout', '超时写法形如 30m / 2h / 1d')
        }
        if (gate.on_timeout !== undefined && gate.on_timeout !== null && !ON_TIMEOUT.includes(gate.on_timeout)) {
          bad('gates.' + name + '.on_timeout', '只能是 ' + ON_TIMEOUT.join(' / '))
        } else if (gate.on_timeout === 'auto_release' && !AUTO_RELEASE_GATES.includes(name)) {
          /*
           * 拒绝而不是忽略：`auto_release` 只有 `start` 门禁有对应的机器动作，
           * 配在别处是一个"显示得出来、改了不生效"的旋钮 —— 那比没有这个旋钮更坏。
           */
          bad(
            'gates.' + name + '.on_timeout',
            '只有 start 门禁支持 auto_release（它对应"确认开始超时自动释放回待接受"这个机器动作）；' +
              '其它门禁只能催办/升级，请用 remind_then_escalate / escalate_to_owner / notify_submitter',
          )
        }
        if (gate.max_release !== undefined && gate.max_release !== null) {
          const value = Number(gate.max_release)
          if (!Number.isInteger(value) || value < 1) bad('gates.' + name + '.max_release', '必须是正整数或留空')
        }
      }
    }
  }

  if (patch.sessions !== undefined) {
    const sessions = patch.sessions
    if (sessions === null || typeof sessions !== 'object') bad('sessions', '必须是一个对象')
    else {
      for (const key of Object.keys(sessions)) {
        if (!['preset', 'presets', 'provider', 'model', 'reasoningEffort', 'turnTimeoutMs', 'maxLive'].includes(key)) {
          bad('sessions.' + key, '未知配置项')
        }
      }
      for (const key of ['preset', 'provider', 'model', 'reasoningEffort']) {
        const value = sessions[key]
        if (value !== undefined && value !== null && typeof value !== 'string') bad('sessions.' + key, '必须是字符串或留空')
      }
      if (sessions.presets !== undefined) {
        if (sessions.presets === null || typeof sessions.presets !== 'object') bad('sessions.presets', '必须是一个对象')
        else {
          for (const [role, preset] of Object.entries(sessions.presets)) {
            if (preset !== null && typeof preset !== 'string') bad('sessions.presets.' + role, '必须是 preset 名字或留空')
          }
        }
      }
      const turn = sessions.turnTimeoutMs
      if (turn !== undefined && turn !== null && (!Number.isFinite(Number(turn)) || Number(turn) <= 0)) {
        bad('sessions.turnTimeoutMs', '必须是正数（毫秒）')
      }
      const live = sessions.maxLive
      if (live !== undefined && live !== null && (!Number.isInteger(Number(live)) || Number(live) < 1)) {
        bad('sessions.maxLive', '必须是正整数')
      }
    }
  }

  if (patch.feishu !== undefined) {
    const feishu = patch.feishu
    if (feishu === null || typeof feishu !== 'object') bad('feishu', '必须是一个对象')
    else {
      for (const key of Object.keys(feishu)) {
        if (!FEISHU_KEYS.includes(key)) bad('feishu.' + key, '未知配置项')
      }
      if (feishu.mode !== undefined && !['own', 'off'].includes(feishu.mode)) {
        bad('feishu.mode', '只能是 own（自己连飞书）或 off（不接收）')
      }
      if (feishu.appId !== undefined && typeof feishu.appId !== 'string') bad('feishu.appId', '必须是字符串')
      /*
       * AN EMPTY SECRET IS NOT AN ERROR: it is the documented way to say "leave the
       * one you have alone", which is what an untouched password box means. (The
       * whitespace check stays: a pasted secret with a trailing space is the classic
       * accident, and it silently fails authentication.)
       */
      if (feishu.appSecret !== undefined && typeof feishu.appSecret !== 'string') {
        bad('feishu.appSecret', '必须是字符串')
      } else if (typeof feishu.appSecret === 'string' && feishu.appSecret !== '' && feishu.appSecret !== feishu.appSecret.trim()) {
        bad('feishu.appSecret', '首尾有空白字符 —— 复制粘贴密钥时最常见的问题')
      }
      if (feishu.botOpenId !== undefined && feishu.botOpenId !== '' && !/^ou_/.test(String(feishu.botOpenId))) {
        bad('feishu.botOpenId', '形如 ou_xxx（留空则启动时自动探测）')
      }
      /*
       * `feishu.chatIds` NO LONGER DOES ANYTHING, and that is why it is refused rather
       * than merely deprecated: nothing in the plugin ever read it, so a file that says
       * "only these groups" was silently processing every group. Group binding lives on
       * the bot now (`bots[].feishu.chats`), where it is enforced by the router.
       *
       * A key that is accepted and ignored is worse than one that is rejected: the
       * first teaches the operator a rule the system does not have.
       */
      if (feishu.chatIds !== undefined) {
        bad('feishu.chatIds', '这个键已经不生效了（插件从来没有读它）：群绑定在机器人身上 —— 在「机器人」页给每台机器人填「所在群」（bots[].feishu.chats）')
      }
      if (feishu.chatAllowlist !== undefined) {
        if (!Array.isArray(feishu.chatAllowlist)) bad('feishu.chatAllowlist', '必须是数组')
        else feishu.chatAllowlist.forEach((id, i) => {
          if (typeof id !== 'string' || !/^oc_/.test(id)) bad('feishu.chatAllowlist[' + i + ']', '形如 oc_xxx')
        })
      }
      for (const key of ['requireMention', 'respond', 'buttons', 'addressedOverridesIntent', 'requireRegisteredChat']) {
        if (feishu[key] !== undefined && typeof feishu[key] !== 'boolean') bad('feishu.' + key, '必须是 true / false')
      }
      if (feishu.apps !== undefined) {
        if (feishu.apps === null || typeof feishu.apps !== 'object' || Array.isArray(feishu.apps)) {
          bad('feishu.apps', '必须是对象 {appId: {appSecret, botOpenId, name}}（页面上的数组是只读视图，不能写回）')
        } else {
          for (const [appId, entry] of Object.entries(feishu.apps)) {
            if (!/^cli_[A-Za-z0-9]+$/.test(appId)) {
              bad('feishu.apps.' + appId, 'app id 形如 cli_xxx')
              continue
            }
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
              bad('feishu.apps.' + appId, '必须是一个对象')
              continue
            }
            for (const key of Object.keys(entry)) {
              if (!['appSecret', 'botOpenId', 'name'].includes(key)) {
                bad('feishu.apps.' + appId + '.' + key, '未知配置项（只接受 appSecret / botOpenId / name）')
              }
            }
            if (entry.appSecret !== undefined && typeof entry.appSecret !== 'string') {
              bad('feishu.apps.' + appId + '.appSecret', '必须是字符串')
            } else if (
              typeof entry.appSecret === 'string' &&
              entry.appSecret !== '' &&
              entry.appSecret !== entry.appSecret.trim()
            ) {
              bad('feishu.apps.' + appId + '.appSecret', '首尾有空白字符 —— 复制粘贴密钥时最常见的问题')
            }
            if (entry.botOpenId !== undefined && entry.botOpenId !== '' && !/^ou_/.test(String(entry.botOpenId))) {
              bad('feishu.apps.' + appId + '.botOpenId', '形如 ou_xxx（留空则启动时自动探测）')
            }
          }
        }
      }
      for (const key of ['senders', 'chatActors']) {
        const value = feishu[key]
        if (value === undefined) continue
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          bad('feishu.' + key, '必须是一个对象')
          continue
        }
        for (const [name, entry] of Object.entries(value)) principal('feishu.' + key + '.' + name, entry)
      }
      if (
        feishu.speakLeaseMs !== undefined &&
        feishu.speakLeaseMs !== null &&
        (!Number.isFinite(Number(feishu.speakLeaseMs)) || Number(feishu.speakLeaseMs) <= 0)
      ) {
        bad('feishu.speakLeaseMs', '必须是正数（毫秒）：两个机器人同时想接话时的让位窗口')
      }
    }
  }

  return problems
}

/**
 * Merge one patch into the on-disk document.
 *
 * TWO SHAPES MEET HERE, and getting this wrong is invisible: the panel treats
 * `senders` / `chatActors` as peers of `members` (top level), while the FILE
 * keeps them under `feishu` — which is where the loader reads them. A merge that
 * wrote them top-level would report success and change nothing at all, so the
 * mapping is explicit here and pinned by a test.
 *
 * Unknown keys of the EXISTING document are kept, including the `"//": "…"`
 * comment keys a human wrote there: the console edits a file, it does not own it.
 */
export function mergePatch(doc, patch) {
  const next = { ...doc }
  const feishu = { ...(next.feishu ?? {}) }
  let touchedFeishu = false

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'feishu') {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (inner === 'apps') {
          /*
           * PER-APP MERGE, and never a wholesale replacement: the console sends only
           * the apps whose secret someone retyped, and replacing the map would drop
           * every other app's credentials — silently taking those bots offline.
           */
          const existing = feishu.apps !== null && typeof feishu.apps === 'object' && !Array.isArray(feishu.apps) ? feishu.apps : {}
          const incoming = innerValue !== null && typeof innerValue === 'object' && !Array.isArray(innerValue) ? innerValue : {}
          const merged = { ...existing }
          for (const [appId, entry] of Object.entries(incoming)) {
            const current = existing[appId] !== null && typeof existing[appId] === 'object' ? existing[appId] : {}
            const nextEntry = { ...current }
            for (const [field, fieldValue] of Object.entries(entry ?? {})) {
              // An empty secret means "leave it alone": the panel cannot read it
              // back, so an empty box must never erase a working credential.
              if (field === 'appSecret' && (typeof fieldValue !== 'string' || fieldValue === '')) continue
              nextEntry[field] = fieldValue
              /*
               * MIGRATION, ONE HOME PER CREDENTIAL. The installation-level
               * `feishu.appSecret` / `feishu.botOpenId` describe ONE app — the one in
               * `feishu.appId`. Now that the console writes a credential onto the app
               * itself, leaving the old key in place would mean two places claim to
               * hold the same secret, and only one of them is read (the app entry
               * wins). So once the app entry genuinely HAS the value, the legacy key is
               * removed rather than left to rot — never before, because an app entry
               * without a secret still needs the fallback to work.
               */
              if (appId === feishu.appId && typeof nextEntry[field] === 'string' && nextEntry[field] !== '') {
                delete feishu[field]
              }
            }
            merged[appId] = nextEntry
          }
          feishu.apps = merged
          touchedFeishu = true
          continue
        }
        if (inner === 'senders' || inner === 'chatActors') {
          // Same migration, for a patch that already speaks the file's own shape.
          feishu[inner] = innerValue
          delete next[inner]
          touchedFeishu = true
          continue
        }
        if (inner === 'appSecret') {
          // Empty means "leave it alone", and is never written: the panel cannot
          // read the secret back, so an empty box must not erase it.
          if (typeof innerValue === 'string' && innerValue !== '') feishu.appSecret = innerValue
          touchedFeishu = true
          continue
        }
        feishu[inner] = innerValue
        touchedFeishu = true
      }
      continue
    }
    if (key === 'senders' || key === 'chatActors') {
      /*
       * ONE HOME, OR THE SAVE IS A LIE. The loader reads the nested copy first and
       * the top-level one second — so a stale top-level copy OVERRIDES what a save
       * just wrote under `feishu`: the console would report success and nothing would
       * change. The nested copy is the canonical one (it is where the loader looks
       * first and where the panel's patch is normalised to), so the legacy top-level
       * key is migrated and removed rather than left to drift.
       */
      feishu[key] = value
      delete next[key]
      touchedFeishu = true
      continue
    }
    if (key === 'members' && !Array.isArray(value)) {
      /*
       * A legacy map arriving under `members`. It must NOT be written there: the
       * file's `members` now holds the table, and a map in that slot would replace
       * every member row with a domain map. Route it to `domains`, which is the
       * key the loader reads for exactly this shape.
       */
      next.domains = value
      continue
    }
    if (key === 'bots' && Array.isArray(value)) {
      /*
       * NORMALIZED ON THE WAY TO DISK. The console renders a row it read from the
       * API — which carries `problems`, `sessions`, `appIdResolved` and a live
       * `feishu.connected` flag — and posts the row back. Writing that verbatim would
       * put runtime state into the config file, where it would then be read as
       * configuration. `normalizeBot` keeps exactly the documented fields.
       */
      next.bots = value.map((one) => normalizeBot(one))
      continue
    }
    if (key === 'members' && Array.isArray(value) && !Array.isArray(next.members)) {
      /*
       * First write of the table over a file that still holds the legacy map:
       * migrate it into `domains` first, or those domain assignments would vanish
       * the moment the table takes the `members` slot — and the people listed in
       * them would lose the right to confirm their own requirements.
       */
      if (next.members !== null && typeof next.members === 'object') {
        next.domains = { ...next.members, ...(next.domains ?? {}) }
      }
      next.members = value.map((one) => normalizeMember(one))
      continue
    }
    if (key === 'members' && Array.isArray(value)) {
      next.members = value.map((one) => normalizeMember(one))
      continue
    }
    next[key] = value
  }

  if (touchedFeishu) next.feishu = feishu
  return next
}

/**
 * Project member rows onto `feishu.senders`: an `open_id` typed on the 成员 page
 * must become the mapping that attributes that person's button presses.
 *
 * ADD ONLY, NEVER REMOVE — and that asymmetry is deliberate. Adding is safe: the
 * mapping can only be right, since it is derived from a row a human just wrote.
 * Removing is not: an entry could have been typed by hand for someone who is not
 * in the table on purpose, and a console that silently deleted it would lock that
 * person out with no error. A mapping whose principal is no longer a member is
 * instead REPORTED (see the console's 配置检查), so the operator decides.
 *
 * @returns {{doc: object, added: Array<{openId: string, principal: string}>}}
 */
export function projectMemberSenders(doc) {
  if (!Array.isArray(doc.members)) return { doc, added: [] }
  const feishu = { ...(doc.feishu ?? {}) }
  const senders = { ...(feishu.senders ?? {}) }
  const added = []
  for (const row of doc.members) {
    if (row === null || typeof row !== 'object') continue
    const openId = typeof row.openId === 'string' ? row.openId.trim() : ''
    const key = typeof row.key === 'string' ? row.key.trim() : ''
    if (openId === '' || key === '') continue
    if (typeof senders[openId] === 'string' && senders[openId] !== '') continue
    senders[openId] = key
    added.push({ openId, principal: key })
  }
  if (added.length === 0) return { doc, added }
  feishu.senders = senders
  return { doc: { ...doc, feishu }, added }
}

/** Read the raw config document (never throws; a missing file is `{}`). */
export function readConfigDoc(configFile) {
  if (!existsSync(configFile)) return {}
  try {
    const doc = JSON.parse(readFileSync(configFile, 'utf8'))
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch (error) {
    return {}
  }
}

/**
 * The whole write path: validate, back up, write atomically, reload live.
 *
 * @param {{configFile: string, dataDir: string, patch: object, actor: string, reload: () => void,
 *          context?: {defaultAppId?: string, knownPresets?: string[]}}} input
 * @returns {{ok: boolean, applied?: string[], problems?: Array<{path: string, message: string}>, backup?: string, message?: string}}
 */
/**
 * 只保留最近 N 份配置备份（它们含明文密钥，不能让它们无限堆积）。
 *
 * 排序用文件名里的 epoch 毫秒（`config.json.bak-<ms>`），不依赖文件系统时间。
 *
 * @returns {number} 清理前存在的备份份数（失败返回 0 —— 清理不该影响这次保存）
 */
export function pruneBackups(dir, base, keep = 5) {
  try {
    const prefix = base + '.bak-'
    const files = readdirSync(dir)
      .filter((one) => one.startsWith(prefix))
      .map((one) => ({ name: one, at: Number(one.slice(prefix.length)) || 0 }))
      .sort((a, b) => b.at - a.at)
    for (const item of files.slice(keep)) rmSync(join(dir, item.name), { force: true })
    return files.length
  } catch (error) {
    return 0
  }
}

export function saveConfig(input) {
  const problems = validatePatch(input.patch, input.context ?? {})
  if (problems.length > 0) return { ok: false, problems }
  const doc = readConfigDoc(input.configFile)

  // `workspace` gets created here rather than at next use: "saved but unusable"
  // is the failure mode a console exists to prevent.
  const workspace = input.patch.workspace ?? doc.workspace
  if (typeof workspace === 'string' && workspace !== '') {
    try {
      mkdirSync(workspace, { recursive: true })
    } catch (error) {
      return { ok: false, problems: [{ path: 'workspace', message: '目录不可用：' + String(error && error.message ? error.message : error) }] }
    }
  }

  const merged = mergePatch(doc, input.patch)
  const projected = projectMemberSenders(merged)
  const next = projected.doc
  const backup = existsSync(input.configFile) ? input.configFile + '.bak-' + String(Date.now()) : null
  try {
    if (backup !== null) {
      writeFileSync(backup, readFileSync(input.configFile), { mode: 0o600 })
      /*
       * 备份**只留最近 5 份**。以前每次保存都留一份、永远不删：一个常改配置的安装会攒出
       * 几百个 `config.json.bak-*`，而每一个都含**明文密钥**。
       */
      pruneBackups(dirname(backup), basename(input.configFile))
    }
    mkdirSync(dirname(input.configFile), { recursive: true })
    const tmp = input.configFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, input.configFile)
  } catch (error) {
    return { ok: false, problems: [{ path: '', message: '写入失败：' + String(error && error.message ? error.message : error) }] }
  }

  /*
   * The audit line is the cheapest possible answer to "who turned the mention
   * requirement off on Tuesday" — the question that otherwise gets answered by
   * diffing backups by hand.
   */
  try {
    appendFileSync(
      join(input.dataDir, 'config-audit.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        actor: input.actor,
        keys: Object.keys(input.patch),
        backup,
        // Derived writes are recorded too: "the console added a sender mapping"
        // must be distinguishable from a human having typed it.
        sendersAdded: projected.added.map((one) => one.openId),
      }) + '\n',
      'utf8',
    )
  } catch (error) {
    /* the audit trail is best-effort; the write itself already succeeded */
  }

  input.reload()
  return { ok: true, applied: Object.keys(input.patch), backup, derived: { sendersAdded: projected.added } }
}
