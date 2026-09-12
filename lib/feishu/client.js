/*
 * Feishu HTTP transport.
 *
 * WHY THIS EXISTS AT ALL. Sending a card is one authenticated POST, and doing it
 * here with `fetch` keeps the whole Feishu surface inside this plugin: no
 * external commands (another implementation shells out to `curl`/`openssl`, which
 * is why it is macOS/Linux only), no second process, and no dependency on
 * anybody else's client. `connection.js` owns the receive side; this file owns
 * the send side.
 *
 * THE THREE THINGS THAT BITE, ALL LEARNED THE HARD WAY IN THE HUB:
 *
 * 1. THE TOKEN LIVES AT THE TOP LEVEL of the auth response —
 *    `{code, msg, tenant_access_token, expire}`, not under `data` — unlike
 *    almost every other Feishu endpoint.
 *
 * 2. FEISHU SIGNALS FAILURE WITH A NON-ZERO `code`, NOT BY THROWING. A caller
 *    that only handles exceptions will believe a card was delivered when it was
 *    rejected, which is how a "reply" silently disappears. So `call()` treats a
 *    non-zero code as a failure and says so.
 *
 * 3. CONCURRENT AUTH MUST BE MERGED. Several bots waking at once would
 *    otherwise each fetch a token; the in-flight promise is shared instead.
 *
 * Secrets never reach the log: `describe()` redacts, and nothing here prints a
 * token or a secret.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Refresh this long before expiry, so a slow request cannot race the clock. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/*
 * CREDENTIALS COME FROM THE TEAM PLUGIN'S OWN CONFIG — nothing else.
 *
 * There used to be a fallback here that read `~/.dsh/feishu-bot/config.json`, on
 * the theory that the app, its permissions and its group registrations already
 * existed there. It worked, and it was wrong: it silently made this plugin a
 * passenger of another plugin's configuration, so moving, disabling or
 * re-configuring that other package changed this one. The two values now live in
 * the team config (`feishu.appId` / `feishu.appSecret`) or in
 * `DSH_TEAM_FEISHU_APP_ID` / `_APP_SECRET`.
 */
export { resolveCredentials } from './connection.js'

/** One Feishu app's HTTP surface: token cache, plus the calls the team layer needs. */
export class FeishuClient {
  /**
   * @param {{appId: string, appSecret: string, baseUrl: string, ready: boolean}} credentials
   * @param {{fetch?: Function, now?: () => number, logger?: object}} [options]
   *   `fetch` is injectable so the transport is testable without a network.
   */
  constructor(credentials, options = {}) {
    this.credentials = credentials
    this.baseUrl = String(credentials.baseUrl ?? 'https://open.feishu.cn').replace(/\/+$/, '')
    this.fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /*
     * A HUNG FEISHU MUST NOT HANG THE PLUGIN.
     *
     * Every call here sits on someone's critical path: the reply to a chat, the
     * card that files a requirement, the diagnostics button in the panel. Without
     * a bound, one unreachable endpoint (a firewall, a stale keep-alive) turns
     * `await client.send(...)` into a promise that never settles — the chat goes
     * quiet and nothing anywhere says why. 15s is longer than any healthy Feishu
     * call and far shorter than a person's patience.
     */
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Number(options.timeoutMs) : 15_000
    this.logger = options.logger ?? console
    /** @type {{token: string, expiresAt: number}|null} */
    this.token = null
    /** @type {Promise<string>|null} in-flight auth, shared by concurrent callers */
    this.pending = null
  }

  get ready() {
    return this.credentials.ready === true && typeof this.fetchImpl === 'function'
  }

  /** Never log this object; the app secret is in it. */
  describe() {
    return {
      appId: this.credentials.appId === '' ? null : this.credentials.appId.slice(0, 8) + '…',
      source: this.credentials.source,
      baseUrl: this.baseUrl,
    }
  }

  async #tenantToken() {
    if (this.token !== null && this.now() < this.token.expiresAt - REFRESH_MARGIN_MS) return this.token.token
    if (this.pending !== null) return this.pending
    this.pending = (async () => {
      const response = await this.fetchImpl(this.baseUrl + '/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret }),
      })
      const body = await response.json()
      // The token is at the TOP level here; `data` is empty on this endpoint.
      if (body === null || typeof body !== 'object' || typeof body.tenant_access_token !== 'string') {
        throw new Error('feishu auth failed: code=' + String(body?.code) + ' msg=' + String(body?.msg))
      }
      const expireSeconds = Number(body.expire)
      const ttl = Number.isFinite(expireSeconds) && expireSeconds > 0 ? expireSeconds * 1000 : 7_200_000
      this.token = { token: body.tenant_access_token, expiresAt: this.now() + ttl }
      return this.token.token
    })()
    try {
      return await this.pending
    } finally {
      this.pending = null
    }
  }

  /**
   * One authenticated call.
   *
   * @returns {Promise<{ok: boolean, code: number, msg: string, data: unknown, raw: unknown}>}
   *   A non-zero `code` is a FAILURE, not an exception — callers that only
   *   catch will silently lose messages.
   */
  async call(path, init = {}) {
    if (!this.ready) return { ok: false, code: -1, msg: 'feishu credentials are not configured', data: null }
    let token = ''
    try {
      token = await this.#tenantToken()
    } catch (error) {
      return { ok: false, code: -2, msg: String(error && error.message ? error.message : error), data: null }
    }
    try {
      const signal =
        init.signal ??
        (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined)
      const response = await this.fetchImpl(this.baseUrl + path, {
        ...init,
        ...(signal === undefined ? {} : { signal }),
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: 'Bearer ' + token,
          ...(init.headers ?? {}),
        },
      })
      const body = await response.json().catch(() => null)
      const code = body !== null && typeof body === 'object' && typeof body.code === 'number' ? body.code : -3
      const msg = body !== null && typeof body === 'object' && typeof body.msg === 'string' ? body.msg : 'malformed response'
      /*
       * `raw` is the parsed body, and it is NOT decoration. Feishu is not
       * consistent about where it puts things: most endpoints nest their payload
       * under `data`, while `/auth/v3/tenant_access_token/internal` puts the
       * token at the top level and `/bot/v3/info` puts `bot` there too. A client
       * that only forwards `data` reports `code: 0` and hands back nothing —
       * which is exactly how a bot ends up unable to recognise an @-mention.
       */
      return { ok: code === 0, code, msg, data: body !== null && typeof body === 'object' ? body.data ?? null : null, raw: body }
    } catch (error) {
      return { ok: false, code: -4, msg: String(error && error.message ? error.message : error), data: null }
    }
  }

  /**
   * Download a message resource (image / file) as bytes.
   *
   * `call()` is JSON-only by construction — it always parses the body — and the
   * resource endpoint answers with the raw file. So this is a second, small
   * transport: same credentials, same retry-free policy, but it returns
   * `{ok, code, msg, bytes, contentType}` and never tries to parse JSON.
   *
   * @param {string} messageId the message the resource belongs to (Feishu scopes
   *   the key to the message; a bare file_key is not enough)
   * @param {string} fileKey `image_key` or `file_key` from the message content
   * @param {{type?: 'image'|'file'}} [options] the endpoint takes the resource type
   */
  async download(messageId, fileKey, options = {}) {
    if (!this.ready) return { ok: false, code: -1, msg: 'feishu credentials are not configured', bytes: null }
    let token = ''
    try {
      token = await this.#tenantToken()
    } catch (error) {
      return { ok: false, code: -2, msg: String(error && error.message ? error.message : error), bytes: null }
    }
    const kind = options.type === 'file' ? 'file' : 'image'
    const path =
      '/open-apis/im/v1/messages/' + encodeURIComponent(String(messageId)) +
      '/resources/' + encodeURIComponent(String(fileKey)) + '?type=' + kind
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(this.timeoutMs)
          : undefined
      const response = await this.fetchImpl(this.baseUrl + path, {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
        headers: { authorization: 'Bearer ' + token },
      })
      const contentType = String(response.headers?.get?.('content-type') ?? '')
      if (response.ok !== true) {
        // An error body IS JSON (code + msg) — read it for the reason, keep bytes null.
        const body = await response.json().catch(() => null)
        return {
          ok: false,
          code: typeof body?.code === 'number' ? body.code : -3,
          msg: typeof body?.msg === 'string' ? body.msg : 'resource download failed: HTTP ' + String(response.status),
          bytes: null,
        }
      }
      const buffer = await response.arrayBuffer()
      return { ok: true, code: 0, msg: 'ok', bytes: Buffer.from(buffer), contentType }
    } catch (error) {
      return { ok: false, code: -4, msg: String(error && error.message ? error.message : error), bytes: null }
    }
  }

  /**
   * One raw call in the shape the ported card layer expects.
   *
   * WHY THIS EXISTS. `lib/feishu/cards.js` was ported from the hub together with a
   * delivery path (`deliverCard` / `deliverText`) that UPDATES a card in place —
   * `PATCH /im/v1/messages/:message_id` — so that one topic stays one card instead of
   * scrolling the group with a new one every time. Those functions call
   * `client.request(method, path, body)`, which is the hub's client shape; this
   * transport has `call(path, init)`. Without this adapter the whole card-update path
   * is dead code, and every notification is a brand-new message (which is exactly how
   * a group becomes unreadable).
   *
   * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
   * @param {string} path starts with `/` (e.g. `/im/v1/messages/om_x`)
   * @param {object|null} [body]
   * @returns {Promise<{ok: boolean, code: number, msg: string, data: object|null, raw: object|null}>}
   */
  async request(method, path, body) {
    const upper = String(method ?? 'GET').toUpperCase()
    const init = { method: upper }
    if (body !== undefined && body !== null && upper !== 'GET') init.body = JSON.stringify(body)
    // `cards.js` speaks paths relative to the API root; `call` prefixes the base URL.
    const full = path.startsWith('/open-apis') ? path : '/open-apis' + path
    return this.call(full, init)
  }

  /**
   * Send one already-built payload to one chat.
   *
   * TWO SHAPES ARRIVE HERE, and both must work:
   *
   *   `{ msg_type, content, uuid }`  — what the degradation ladder produces;
   *                                    `content` is already a JSON string.
   *   `{ msg_type: 'interactive', card }` — the hand-built form.
   *
   * `uuid` is passed through when present: Feishu treats it as an idempotency
   * key, which is what keeps a retry from posting the same card twice.
   *
   * @param {string} chatId `oc_…`
   * @param {object} payload
   */
  async send(chatId, payload) {
    const msgType = typeof payload.msg_type === 'string' && payload.msg_type !== '' ? payload.msg_type : 'text'
    const content =
      typeof payload.content === 'string'
        ? payload.content
        : JSON.stringify(payload.content ?? payload.card ?? {})
    const request = { receive_id: chatId, msg_type: msgType, content }
    if (typeof payload.uuid === 'string' && payload.uuid !== '') request.uuid = payload.uuid
    const result = await this.call('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify(request),
    })
    return { ...result, chatId, msgType }
  }

  /**
   * Deliver through a degradation ladder, stopping at the first accepted level.
   *
   * The ladder is the whole point of the card design: content must never be
   * lost because a render failed. `via` records which level actually went out,
   * so a deployment that is permanently answering on a low level is visible
   * rather than mysterious.
   *
   * @param {string} chatId
   * @param {Array<{level: number, via: string, payload: object}>} ladder
   */
  async sendThrough(chatId, ladder, options = {}) {
    const attempts = []
    if (!Array.isArray(ladder) || ladder.length === 0) {
      return { ok: false, via: 'none', level: 0, attempts, message: 'empty ladder' }
    }
    /*
     * 话题隔离（设计 04 §5）：`replyTo` 非空时走**引用回复**，让多个机器人在同一个群里
     * 各说各话时不会串成一条看不懂的瀑布流。引用失败**自动退化为普通消息** ——
     * 一条引用不能把答案吞掉（hub 的测试抓出来的正是这个）。
     */
    const replyTo = typeof options.replyTo === 'string' && options.replyTo !== '' ? options.replyTo : null
    for (const rung of ladder) {
      const payload = replyTo === null ? rung.payload : { ...rung.payload }
      if (replyTo !== null) delete payload.uuid
      const result =
        replyTo === null
          ? await this.send(chatId, payload)
          : await this.call('/open-apis/im/v1/messages/' + encodeURIComponent(replyTo) + '/reply', {
              method: 'POST',
              body: JSON.stringify({ msg_type: payload.msg_type, content: payload.content }),
            })
      // 没走引用时不多写一个 `reply_to: null`：`attempts` 的形状保持与以前一致。
      attempts.push({
        level: rung.level,
        via: rung.via,
        code: result.code,
        ok: result.ok,
        ...(replyTo === null ? {} : { reply_to: replyTo }),
      })
      if (result.ok) {
        return {
          ok: true,
          via: rung.via,
          level: rung.level,
          attempts,
          reply_to: replyTo,
          messageId: result.data?.message_id ?? null,
        }
      }
      // 引用这条路走不通（消息被撤回、权限不足）：退回普通消息再试同一级。
      if (replyTo !== null) {
        const fallback = await this.send(chatId, rung.payload)
        attempts.push({ level: rung.level, via: rung.via, code: fallback.code, ok: fallback.ok, reply_to: null, fallback: true })
        if (fallback.ok) {
          return { ok: true, via: rung.via, level: rung.level, attempts, reply_to: null, messageId: fallback.data?.message_id ?? null }
        }
      }
    }
    return { ok: false, via: 'exhausted', level: ladder.length, attempts, message: 'every level was rejected' }
  }
}

/**
 * The live self-check: "can this deployment actually reach Feishu, as whom, and
 * in which chats" — the questions the old hub answered with `hub check`, and the
 * ones a person asks right after pasting credentials.
 *
 * Every probe is best-effort and reported as data: a failure says what failed,
 * because a diagnostics page that only ever says "error" is not diagnostics.
 */
export async function diagnose(deps) {
  const { config, credentials, client, connection, store, inbox } = deps
  const out = { checkedAt: new Date().toISOString() }

  out.credentials = {
    ok: credentials !== null && credentials !== undefined && credentials.ready === true,
    source: credentials?.source ?? 'none',
    appId: typeof credentials?.appId === 'string' && credentials.appId !== '' ? credentials.appId.slice(0, 10) + '…' : '',
  }

  if (client !== null && client !== undefined && client.ready === true) {
    const info = await client.call('/open-apis/bot/v3/info')
    const bot = info.ok === true ? info.raw?.bot ?? info.data?.bot ?? null : null
    out.identity =
      bot === null
        ? { ok: false, message: 'code=' + String(info.code) + ' ' + String(info.msg) }
        : { ok: true, name: typeof bot.app_name === 'string' ? bot.app_name : null, openId: typeof bot.open_id === 'string' ? bot.open_id : null }

    const chats = await client.call('/open-apis/im/v1/chats?page_size=20')
    out.chats =
      chats.ok !== true
        ? { ok: false, message: 'code=' + String(chats.code) + ' ' + String(chats.msg) }
        : {
            ok: true,
            items: (Array.isArray(chats.data?.items) ? chats.data.items : []).map((chat) => ({
              chatId: chat.chat_id ?? '',
              name: typeof chat.name === 'string' && chat.name !== '' ? chat.name : null,
              mode: typeof chat.chat_mode === 'string' ? chat.chat_mode : null,
            })),
          }
  } else {
    const message = credentials?.ready === true ? '飞书客户端不可用（SDK 未安装？）' : '没有凭据，先把 appId / appSecret 填上'
    out.identity = { ok: false, message }
    out.chats = { ok: false, message }
  }

  const described = connection !== null && connection !== undefined && typeof connection.describe === 'function' ? connection.describe() : null
  out.connection =
    described === null
      ? { ready: false, connected: false, message: '这次启动没有建立长连接（看 [team] 日志里的原因）' }
      : {
          ready: described.ready === true,
          connected: described.state?.connected === true,
          lastReadyAt: described.state?.lastReadyAt ?? null,
          lastError: described.state?.lastError ?? null,
          ...(described.reason === undefined ? {} : { message: described.reason }),
        }

  out.ledger = {
    requirements: store.all('requirement').length,
    tasks: store.all('task').length,
    chats: store.all('chat').length,
    inbox: inbox !== null && inbox !== undefined ? inbox.all().length : 0,
  }
  out.mode = config.feishu?.mode ?? 'off'
  return out
}
