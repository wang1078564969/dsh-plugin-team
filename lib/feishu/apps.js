/*
 * Feishu APPS: one long connection each, and which bot speaks through which.
 *
 * THE PHYSICAL CONSTRAINT THIS MODULE EXISTS TO HANDLE. A Feishu app has exactly
 * one bot identity and one long connection: two bots configured with the same
 * `app_id` are the SAME face in the group — same name, same avatar, same
 * permissions. So "several bots, each with its own role" is only visible in
 * Feishu when there are several apps. Nothing in the API can work around that, and
 * pretending otherwise (asking a person to "@需求机器人" when every bot is the same
 * account) is how a design quietly becomes a lie.
 *
 * What this module therefore does: it groups the roster BY APP, so the runtime
 * opens one connection per app and can say honestly which bots share a face. The
 * single-app installation that exists today keeps working unchanged — it just gets
 * one group, and the 配置检查 page says that several enabled bots share it.
 *
 * WHERE SECRETS LIVE. A secret per app, in `feishu.apps[appId].appSecret`, plus the
 * original single-app keys (`feishu.appId` / `feishu.appSecret`) as the default app.
 * A per-bot `feishu.appId` selects one of them. A bot naming an app with no secret
 * is a PROBLEM, not a silent fallback to the default app: answering as a different
 * identity than the roster says is exactly the kind of invisible wrong this plugin
 * is supposed to prevent.
 */
import { createHash } from 'node:crypto'

/** The app a bot speaks through: its own, or the plugin's default. */
export function appIdOfBot(bot, config) {
  const own = bot !== null && typeof bot === 'object' && bot.feishu !== null && typeof bot.feishu === 'object' ? bot.feishu.appId : ''
  if (typeof own === 'string' && own !== '') return own
  const fallback = config?.feishu?.appId
  return typeof fallback === 'string' ? fallback : ''
}

/**
 * Every app the plugin must dial, with the bots that speak through it.
 *
 * @param {object} config resolved configuration
 * @param {{includeUnused?: boolean}} [options] `includeUnused` adds apps that are
 *   configured but that no enabled bot speaks through. The runtime does not dial
 *   them (an unused app is not a connection, it is a leftover), but the console must
 *   show them: an app whose secret is set and which no bot uses is a typo someone
 *   needs to see, and it would otherwise be invisible.
 * @returns {Array<{appId: string, appSecret: string, botOpenId: string, name: string,
 *   source: 'default'|'apps', bots: string[], ready: boolean, reason: string|null}>}
 */
export function appDescriptors(config, options = {}) {
  const feishu = config?.feishu ?? {}
  const apps = feishu.apps !== null && typeof feishu.apps === 'object' && !Array.isArray(feishu.apps) ? feishu.apps : {}
  const out = new Map()

  const ensure = (appId) => {
    if (typeof appId !== 'string' || appId === '') return null
    if (!out.has(appId)) {
      const entry = apps[appId] !== null && typeof apps[appId] === 'object' ? apps[appId] : {}
      const isDefault = appId === feishu.appId
      const secret = typeof entry.appSecret === 'string' && entry.appSecret !== ''
        ? entry.appSecret
        : isDefault && typeof feishu.appSecret === 'string'
          ? feishu.appSecret
          : ''
      out.set(appId, {
        appId,
        appSecret: secret,
        botOpenId: typeof entry.botOpenId === 'string' && entry.botOpenId !== ''
          ? entry.botOpenId
          : isDefault && typeof feishu.botOpenId === 'string'
            ? feishu.botOpenId
            : '',
        /*
         * An app's display name is whatever the operator called it, and the app id
         * otherwise. There is no "default app" label any more: a bot names the app it
         * speaks through, so no app is more default than another (see config.ownApps).
         */
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : appId,
        source: isDefault ? 'default' : 'apps',
        bots: [],
        ready: secret !== '',
        reason: secret === '' ? 'no-secret' : null,
      })
    }
    return out.get(appId)
  }

  // The default app exists even with no roster: single-assistant mode still dials.
  ensure(feishu.appId)

  for (const bot of Array.isArray(config?.bots) ? config.bots : []) {
    if (bot.enabled !== true) continue
    const appId = appIdOfBot(bot, config)
    if (appId === '') continue
    const descriptor = ensure(appId)
    if (descriptor === null) continue
    if (!descriptor.bots.includes(bot.id)) descriptor.bots.push(bot.id)
  }

  if (options.includeUnused === true) for (const appId of Object.keys(apps)) ensure(appId)

  return [...out.values()]
}

/**
 * The apps the console may show: never a secret, only whether one is set.
 *
 * `secretFingerprint` is the first 6 hex characters of a SHA-256 of the secret —
 * enough for a human to tell "this is the same secret as the other row" or "this
 * changed since I pasted it", and useless for recovering it.
 */
export function appsView(config) {
  const feishu = config?.feishu ?? {}
  return appDescriptors(config, { includeUnused: true }).map((app) => ({
    appId: app.appId,
    name: app.name,
    botOpenId: app.botOpenId,
    appSecretSet: app.appSecret !== '',
    secretFingerprint: app.appSecret === '' ? null : createHash('sha256').update(app.appSecret).digest('hex').slice(0, 6),
    source: app.source,
    bots: app.bots,
    ready: app.ready,
    reason: app.reason,
  }))
}

/** One line for the log: which app, and who it speaks for. */
export function describeApp(app) {
  const bots = app.bots.length === 0 ? '（无机器人）' : app.bots.join('、')
  // A name equal to the id is not a name: printing both reads like a bug.
  const head = app.name === app.appId ? app.appId.slice(0, 8) + '…' : app.name + ' ' + app.appId.slice(0, 8) + '…'
  return head + ' → ' + bots
}

/** Bots that are enabled but cannot come online, with the reason. */
export function unbootableBots(config) {
  const out = []
  for (const bot of Array.isArray(config?.bots) ? config.bots : []) {
    if (bot.enabled !== true) continue
    const appId = appIdOfBot(bot, config)
    if (appId === '') {
      out.push({ botId: bot.id, reason: 'no-app', message: '没有可用的飞书应用（自己没填，全局 feishu.appId 也是空）' })
      continue
    }
    const descriptor = appDescriptors(config).find((one) => one.appId === appId)
    if (descriptor === undefined || descriptor.ready !== true) {
      out.push({
        botId: bot.id,
        reason: 'no-secret',
        message: '应用 ' + appId.slice(0, 8) + '… 没有 appSecret：在「机器人」页选中用它的那台机器人，填「应用密钥」',
      })
    }
  }
  return out
}
