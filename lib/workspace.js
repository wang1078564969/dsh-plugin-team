/*
 * Making the bots' conversations visible in the host's DSH client.
 *
 * THE REQUIREMENT, IN DSH'S TERMS. The sidebar lists sessions per WORKSPACE, and
 * a workspace's `sessionIds` are filtered by "this session's header cwd is this
 * workspace's path". A session created by a plugin — one per Feishu chat — is
 * therefore invisible for three separate reasons, and all three have to be
 * answered:
 *
 *   1. NOBODY OWNS THE DIRECTORY. `workspaceRegistry.create(path, title)` is what
 *      registers a directory as a browsable workspace. Until that exists, the
 *      chat's cwd is just a directory on disk.
 *   2. THE SESSION MUST BE DURABLE. The index is built from persisted headers, so
 *      a session whose log is still buffered in memory is not listable. On a
 *      long-lived harness that happens on its own; flushing after a turn makes it
 *      true immediately (and matters most right after the first message).
 *   3. IT NEEDS A NAME A HUMAN RECOGNISES. A sidebar full of `feishu-oc_c91d…` is
 *      technically correct and useless; the chat's own name is the label.
 *
 * Everything here is defensive on purpose: a profile without a workspace
 * registry, or a Feishu app without the chat-info scope, must cost the label —
 * never the bot.
 */
import { existsSync, mkdirSync } from 'node:fs'

/** Ask the optional service, never throw when the profile lacks it. */
function optional(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch (error) {
    return undefined
  }
}

/**
 * @param {{ctx: object, config: object, log?: object}} deps
 */
export function createWorkspaceLink(deps) {
  const { ctx, config } = deps
  const log = deps.log ?? console
  const title = typeof config.workspaceTitle === 'string' && config.workspaceTitle !== '' ? config.workspaceTitle : '团队 · 飞书'
  let workspace = null
  let attempted = false

  /*
   * ACQUIRED, NOT PROBED — the same lesson `connection` taught, one service
   * later. `workspaceRegistry` waits for session persistence and builds its
   * header index before it becomes active, so it is NOT there yet when a
   * last-layer row's apply() runs; a one-shot `ctx.get` returns undefined, the
   * plugin concludes "this profile has no workspaces", and the sidebar entry
   * never appears — silently, which is the worst part. `ctx.inject` with a
   * callback waits for it instead.
   *
   * The timeout is what keeps a headless profile honest: there the registry
   * never arrives, `onSession` must not hang waiting for it, and the bot has to
   * keep answering with no session list at all.
   */
  let releaseRegistry = () => {}
  const registryReady = new Promise((resolve) => {
    releaseRegistry = resolve
  })
  let acquired = false
  function acquireRegistry() {
    if (acquired) return
    acquired = true
    const direct = optional(ctx, 'workspaceRegistry')
    if (direct !== undefined && direct !== null) {
      releaseRegistry(direct)
      return
    }
    if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['workspaceRegistry'], (registryCtx) => {
          const registry = optional(registryCtx, 'workspaceRegistry') ?? Reflect.get(registryCtx, 'workspaceRegistry') ?? null
          log.log?.('[team] workspace registry is up')
          releaseRegistry(registry)
        })
        return
      } catch (error) {
        /* fall through to "no registry" */
      }
    }
    releaseRegistry(null)
  }

  async function registryWithin(ms) {
    acquireRegistry()
    return Promise.race([
      registryReady,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  }

  /** Register the team workspace once, lazily, and remember it. */
  async function ensureWorkspace() {
    if (attempted) return workspace
    attempted = true
    const registry = await registryWithin(2000)
    if (registry === undefined || registry === null || typeof registry.create !== 'function') return null
    try {
      if (!existsSync(config.workspace)) mkdirSync(config.workspace, { recursive: true })
      /*
       * Ask first, so the log tells the truth: `create` REUSES the entity for an
       * already-owned path, and a line that says "registered" on every boot
       * would hide the case an operator actually cares about (did it duplicate?).
       */
      let existed = null
      try {
        if (typeof registry.resolveByPath === 'function') existed = await registry.resolveByPath(config.workspace)
      } catch (error) {
        existed = null
      }
      workspace = await registry.create(config.workspace, title)
      log.log?.(
        '[team] workspace ' +
          (existed === null || existed === undefined ? 'created' : 'reused') +
          ': ' +
          title +
          ' → ' +
          config.workspace,
      )
    } catch (error) {
      log.error?.('[team] could not register the team workspace: ' + String(error && error.message ? error.message : error))
      workspace = null
    }
    return workspace
  }

  /**
   * Called once per bot conversation, right after it is opened.
   *
   * THE TITLE CARRIES THE BOT'S NAME, because the session list is where a person
   * looks to find "what did the requirement bot say in the requirement group". Two
   * bots in one group are two sessions with the same chat name; without the bot
   * prefix they are indistinguishable rows, which is exactly the confusion the
   * bot × chat session key exists to remove.
   *
   * @param {{sessionId: string, session?: object, chatTitle?: string|null, botName?: string|null}} info
   */
  async function onSession(info) {
    const ws = await ensureWorkspace()
    if (ws !== null && typeof ws.attachSession === 'function') {
      try {
        await ws.attachSession(info.sessionId)
      } catch (error) {
        // Attaching is belt-and-braces: a session whose cwd already IS the
        // workspace path is listed without it. A failure here is not worth a log.
      }
    }
    const session = info.session
    if (session === undefined || session === null) return
    const botName = typeof info.botName === 'string' && info.botName !== '' ? info.botName : null
    if (typeof info.chatTitle === 'string' && info.chatTitle !== '') {
      const label = botName === null ? '飞书 · ' + info.chatTitle : '飞书 · ' + info.chatTitle + ' · ' + botName
      const sessionTitle = optional(ctx, 'sessionTitle')
      try {
        if (sessionTitle !== undefined && sessionTitle !== null && typeof sessionTitle.rename === 'function') {
          sessionTitle.rename(session, label.slice(0, 80))
        }
      } catch (error) {
        /* the auto-generated title is a fine fallback */
      }
    }
    const sessions = optional(ctx, 'sessions')
    try {
      if (sessions !== undefined && sessions !== null && typeof sessions.flush === 'function') await sessions.flush(session)
    } catch (error) {
      /* durability is the harness's normal job; this only makes it immediate */
    }
  }

  return {
    ensureWorkspace,
    onSession,
    /**
     * Forget the attempt so the next session re-registers — used after the
     * console changes `workspace`, where the old registration is now the wrong
     * directory.
     */
    reset() {
      attempted = false
      workspace = null
    },
    get workspace() {
      return workspace
    },
  }
}

/**
 * The human name of a Feishu chat, best effort.
 *
 * Returns null rather than throwing: an app without chat-info permission must
 * still be able to answer, just with a duller label.
 */
export async function fetchChatTitle(client, chatId) {
  if (client === null || client === undefined || client.ready !== true) return null
  const result = await client.call('/open-apis/im/v1/chats/' + encodeURIComponent(chatId))
  if (result.ok !== true) return null
  const name = result.data?.name
  if (typeof name === 'string' && name !== '') return name
  /*
   * A private chat has NO name — that is how Feishu models it, not a permission
   * problem. Falling back to the last six characters of the id gives the sidebar
   * `私聊 9a10fa` instead of an entry with no label at all, which is the same
   * thing the earlier bridge showed its users.
   */
  if (result.data?.chat_mode === 'p2p') return '私聊 ' + String(chatId).slice(-6)
  return null
}
