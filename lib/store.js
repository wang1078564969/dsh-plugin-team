/*
 * Team store: tiny JSON-file persistence for team objects.
 *
 * WHY NOT SQLITE. The sibling Hub stored observed state (messages, events) in
 * SQLite, but the team objects themselves have always been YAML/JSON files on
 * purpose: a human must be able to `cat` a requirement, see what state it is
 * in and why, and hand-edit it when the GUI is the thing that is broken. That
 * escape hatch is worth more here than query power — the object count is
 * "a few dozen open requirements", not "a million rows", so an index in memory
 * over files on disk is the right shape.
 *
 * ONE FILE PER OBJECT, one directory per kind. Writes go through a temp file
 * plus rename, so a crash mid-write leaves the previous version intact rather
 * than a truncated one.
 *
 * The store is deliberately dumb: it does not validate state transitions, does
 * not know about gates, and does not send anything. Everything interesting
 * lives in `domain/`, which makes it unit-testable without a filesystem.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Object kinds this store holds, in dependency order (requirements own tasks).
 *
 * `session` is NOT a team domain object: it is this plugin's own bookkeeping
 * about which worker session a task is being executed in. It is kept in a
 * separate kind rather than as extra fields on the task because the task schema
 * is strict — and rightly so, since that object is the one humans `cat` and
 * hand-edit. Its id is the task id, exactly like `lease`.
 *
 * `idStyle` is per kind because the two id rules are genuinely different, and
 * the state machine's schemas enforce them (`req-\d{4}-\d{3,}` vs
 * `task-\d+`): requirements are numbered per year so humans can say "2026 年第
 * 14 个需求", while tasks count globally so that renumbering a requirement can
 * never invalidate a task id (design doc 06 §2).
 */
export const KINDS = {
  requirement: { dir: 'requirements', prefix: 'req-', idStyle: 'year-seq' },
  task: { dir: 'tasks', prefix: 'task-', idStyle: 'seq' },
  lease: { dir: 'leases', prefix: 'lease-', idStyle: 'follows-task' },
  /*
   * 前缀是 `adr-`，与 `domain/schema.js` 的 `DECISION_ID_RE`（`/^adr-\d{4}-\d{3,}$/`）
   * 必须一致：这一版之前写的是 `dec-`，于是"生成决策 id"和"校验决策 id"互相矛盾 ——
   * 真去造一条决策会立刻校验失败。生成规则与校验规则是同一件事的两半，分开放就会打架。
   */
  decision: { dir: 'decisions', prefix: 'adr-', idStyle: 'year-seq' },
  session: { dir: 'runs', prefix: 'run-', idStyle: 'follows-task' },
  /**
   * One Feishu chat this plugin answers in: its session, its workspace, its
   * counters. This is the plugin's OWN registry — ids come from Feishu, so they
   * are never generated here (that was the bridge's `state.json` job, and
   * borrowing it was exactly the coupling this plugin no longer has).
   */
  chat: { dir: 'chats', prefix: 'chat-', idStyle: 'external' },
  /**
   * One BOT's conversation in one chat — the pair is the identity, not the chat.
   *
   * With several bots the two questions that matter are "what did the dev bot
   * discuss in the dev group" and "did the requirement bot remember yesterday",
   * and a chat-keyed session answers neither: two bots in one group would share a
   * memory and one bot in two groups would carry one context into the other. The
   * id is `<botId>.<chatId>` (see lib/sessions.js), and like `chat` it comes from
   * outside, so it is never generated here.
   */
  botsession: { dir: 'bot-sessions', prefix: 'bs-', idStyle: 'external' },
  /**
   * 播报台账：`card_key` → 这条卡现在挂在哪条消息上。
   *
   * 它是"同一个话题只有一张卡"能跨重启成立的原因：留在内存里的话，重启之后
   * 引擎以为还没发过，于是群里会多出一张新卡，而旧卡永远停在旧状态。
   * id 是 `card_key` 的文件安全化（`lib/notify.js` 的 `cardRecordId`），
   * 原始 `card_key` 存在记录里，读的时候以它为准。
   */
  card: { dir: 'cards', prefix: 'card-', idStyle: 'external' },
}

export class StoreError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StoreError'
  }
}

/**
 * Which field carries a kind's identity.
 *
 * `lease` is the exception, and it is a real one: a lease has no id of its own
 * — its identity IS the task it leases ("一个任务同时只能有一个有效租约"),
 * and its schema says `task`, not `id`. Giving it a synthetic id here would
 * create a second identity for the same thing and let the two drift apart.
 */
function idFieldOf(kind) {
  return kind === 'lease' ? 'task' : 'id'
}

export class Store {
  /** @param {string} root the team data directory */
  constructor(root) {
    this.root = root
    /** @type {Map<string, Map<string, object>>} */
    this.cache = new Map()
    for (const kind of Object.keys(KINDS)) this.cache.set(kind, new Map())
    this.loaded = false
  }

  dirOf(kind) {
    const spec = KINDS[kind]
    if (spec === undefined) throw new StoreError('unknown kind: ' + String(kind))
    return join(this.root, spec.dir)
  }

  fileOf(kind, id) {
    return join(this.dirOf(kind), id + '.json')
  }

  /** Read every file of every kind into memory. Idempotent. */
  load() {
    for (const kind of Object.keys(KINDS)) {
      const dir = this.dirOf(kind)
      const bucket = this.cache.get(kind)
      bucket.clear()
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        const full = join(dir, file)
        try {
          const doc = JSON.parse(readFileSync(full, 'utf8'))
          const key = doc !== null && typeof doc === 'object' ? doc[idFieldOf(kind)] : undefined
          if (typeof key === 'string' && key !== '') bucket.set(key, doc)
        } catch (error) {
          // A corrupt file must not take the whole team down: skip it and keep
          // the rest readable. The id is recoverable from the filename, so the
          // operator can find and fix it.
          console.error('[team] skipping unreadable object ' + full + ': ' + String(error && error.message ? error.message : error))
        }
      }
    }
    this.loaded = true
    return this
  }

  #ensure() {
    if (!this.loaded) this.load()
  }

  has(kind, id) {
    this.#ensure()
    return this.cache.get(kind).has(id)
  }

  get(kind, id) {
    this.#ensure()
    const doc = this.cache.get(kind).get(id)
    return doc === undefined ? null : doc
  }

  /** All objects of a kind, ordered by their identity (ids are sortable by construction). */
  all(kind) {
    this.#ensure()
    const field = idFieldOf(kind)
    return [...this.cache.get(kind).values()].sort((a, b) => String(a[field]).localeCompare(String(b[field])))
  }

  /** Objects matching a predicate. */
  find(kind, predicate) {
    return this.all(kind).filter(predicate)
  }

  put(kind, doc) {
    this.#ensure()
    const key = doc !== null && typeof doc === 'object' ? doc[idFieldOf(kind)] : undefined
    if (typeof key !== 'string' || key === '') {
      throw new StoreError('refusing to store ' + String(kind) + ' without a ' + idFieldOf(kind))
    }
    const safe = safeId(key)
    const dir = this.dirOf(kind)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, safe + '.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    this.cache.get(kind).set(key, doc)
    return doc
  }

  remove(kind, id) {
    this.#ensure()
    const file = this.fileOf(kind, id)
    if (existsSync(file)) rmSync(file, { force: true })
    return this.cache.get(kind).delete(id)
  }

  /**
   * Next id for a kind.
   *
   * Two shapes, because the objects really do have two id rules:
   *
   *   requirement / decision   `req-2026-001`, `adr-2026-003` — year +序号,
   *                            so a human can say "2026 年第 14 个需求"
   *   task                     `task-8891` — global counter, never restarted,
   *                            so renumbering a requirement cannot invalidate
   *                            a task id (design doc 06 §2)
   *
   * Kinds whose id follows another object (`lease`, `session`) never call this:
   * their id IS the task id, and inventing one would create a second identity
   * for the same thing.
   *
   * Collisions are impossible because the store is the single writer and only
   * ever proposes `max + 1` over what it already holds.
   */
  nextId(kind, now = new Date()) {
    this.#ensure()
    const spec = KINDS[kind]
    if (spec === undefined) throw new StoreError('unknown kind: ' + String(kind))
    if (spec.idStyle === 'follows-task' || spec.idStyle === 'external') {
      throw new StoreError(kind + ' ids come from outside: pass the real id instead of generating one')
    }
    const head = spec.idStyle === 'year-seq' ? spec.prefix + now.getUTCFullYear() + '-' : spec.prefix
    let max = 0
    for (const id of this.cache.get(kind).keys()) {
      if (!String(id).startsWith(head)) continue
      const n = Number(String(id).slice(head.length))
      if (Number.isFinite(n) && n > max) max = n
    }
    const next = String(max + 1)
    return head + (spec.idStyle === 'year-seq' ? next.padStart(3, '0') : next)
  }
}

/**
 * Keep an id usable as a filename.
 *
 * Ids are generated by `nextId`, so this only matters for hand-written or
 * imported data — but a store that will happily write `../../etc/passwd`
 * because someone hand-edited an id is a store that will eventually do it.
 */
function safeId(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new StoreError('unsafe object id: ' + JSON.stringify(id))
  }
  return id
}
