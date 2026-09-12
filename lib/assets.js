/*
 * 入站资产：图片与文件**落库**，然后给它一个引用（设计 04 §9）。
 *
 * 为什么不能"读一眼就算了"：飞书的 `image_key` / `file_key` 只在**消息**的范围内
 * 有效，消息过期、或者这个 key 只是别人转发过来的一次性资源时，事后谁都取不回来。
 * 设计里那句"落库 + 生成引用（`asset://...`），agent 按需读取"要解决的正是这件事：
 * 内容存在**我们自己的盘上**，引用可以在台账、卡片、需求正文里被记下来、被搜到。
 *
 * 三条约定：
 *   1. **落库成功才算收到**。下载失败不编引用 —— 一个指向不存在文件的 `asset://`
 *      比"没收到"更糟，因为后面所有人都会以为东西在。
 *   2. 引用是 `asset://<id>`，`id` 里带消息与原始 key 的指纹（同一张图重投不会存两份），
 *      文件名单独放在记录里，不参与定位。
 *   3. 目录是"人可读的"：`assets/<id>/<原名>`，加一份 `assets/index.jsonl` 追加记录，
 *      `tail` 就能看出收到过什么（与 store / inbox 同一个逃生口）。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

/** `asset://` 引用的前缀。台账、卡片、文档里都是它。 */
export const ASSET_SCHEME = 'asset://'

/**
 * 从原始 key 与消息 id 算出资产 id。
 *
 * 加消息 id 是因为**同一个 key 在不同消息里可能指向不同内容**；用哈希而不是
 * 直接拼 key，是因为 key 里有 `/` 一类不能进文件名的字符（与 store 的 `safeId` 同一个理由）。
 */
export function assetId(messageId, fileKey) {
  const digest = createHash('sha1').update(String(messageId) + '\u0000' + String(fileKey)).digest('hex')
  return digest.slice(0, 16)
}

/**
 * 文件名：只留安全字符，避免路径穿越与空名。
 *
 * 两道都要有：先把 `/` 与 `\` 拍平（`../../etc/passwd` 不再是路径），再把剩下的
 * `..` 消掉 —— 只拍平斜杠的话，名字里还留着 `..`，某个调用方一旦把它拼进路径
 * 就又是一次穿越。名字是**别人给的**，不能假设它友善。
 */
export function safeFileName(name, fallback = 'file') {
  const raw = typeof name === 'string' && name.trim() !== '' ? name.trim() : fallback
  const flat = raw
    .replace(/[\\/]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+/, '_')
    .trim()
  return flat === '' ? fallback : flat.slice(0, 120)
}

/**
 * 按扩展名猜"这是什么"。
 *
 * 只为回答一个问题：**能不能直接进任务上下文**（设计 04 §9 的"代码/文档类文件
 * 可直接进任务上下文"）。猜不出来就是 `binary`，照样落库 —— 不因为认不出类型就丢。
 */
export function classifyAsset(name, contentType = '') {
  const ext = extname(String(name ?? '')).toLowerCase()
  const type = String(contentType).toLowerCase()
  if (/^image\//.test(type) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image'
  if (['.md', '.markdown', '.txt', '.rst'].includes(ext)) return 'doc'
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.csv', '.log'].includes(ext)) return 'data'
  if (
    [
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
      '.c', '.h', '.cc', '.cpp', '.cs', '.swift', '.sh', '.sql', '.vue', '.html', '.css', '.scss',
    ].includes(ext)
  ) {
    return 'code'
  }
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'document'
  if (['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'].includes(ext)) return 'archive'
  return 'binary'
}

/** 人类能读的大小（卡片与页面都用它，不要出现 1.234567e+7 字节）。 */
export function humanSize(bytes) {
  const total = Number(bytes)
  if (!Number.isFinite(total) || total < 0) return '未知大小'
  if (total < 1024) return String(Math.round(total)) + ' B'
  if (total < 1024 * 1024) return (total / 1024).toFixed(1) + ' KB'
  if (total < 1024 * 1024 * 1024) return (total / (1024 * 1024)).toFixed(1) + ' MB'
  return (total / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

/**
 * @param {{dataDir: string, log?: object, now?: () => Date}} deps
 */
export function createAssetStore(deps) {
  const root = join(String(deps.dataDir), 'assets')
  const indexFile = join(root, 'index.jsonl')
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  /** @type {Map<string, object>} */
  const records = new Map()
  let loaded = false

  function ensure() {
    if (loaded) return
    mkdirSync(root, { recursive: true })
    if (existsSync(indexFile)) {
      try {
        for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          const doc = JSON.parse(line)
          if (doc !== null && typeof doc === 'object' && typeof doc.id === 'string') records.set(doc.id, doc)
        }
      } catch (error) {
        // 坏掉的一行不能让它整个不可用：能读多少读多少（与 Inbox 同一个策略）。
        deps.log?.error?.('[team] assets/index.jsonl 读不动，按能读到的继续：' + String(error && error.message ? error.message : error))
      }
    }
    loaded = true
  }

  function record(ref) {
    ensure()
    const id = String(ref).startsWith(ASSET_SCHEME) ? String(ref).slice(ASSET_SCHEME.length) : String(ref)
    return records.get(id) ?? null
  }

  /**
   * 存一个资产。
   *
   * @param {{messageId: string, chatId?: string|null, fileKey: string, kind?: 'image'|'file',
   *          name?: string, contentType?: string, bytes: Buffer|Uint8Array, recordedBy?: string|null}} input
   * @returns {{ok: true, id: string, ref: string, path: string, record: object}|{ok: false, code: string, message: string}}
   */
  function save(input) {
    ensure()
    const bytes = input?.bytes
    if (bytes === null || bytes === undefined || typeof bytes.length !== 'number' || bytes.length === 0) {
      return { ok: false, code: 'empty', message: '资源下载回来是空的：不落库，也不给引用' }
    }
    const messageId = String(input.messageId ?? '')
    const fileKey = String(input.fileKey ?? '')
    if (messageId === '' || fileKey === '') {
      return { ok: false, code: 'no-key', message: '缺少 message_id 或 file_key，无法定位资源' }
    }
    const id = assetId(messageId, fileKey)
    const existing = records.get(id)
    if (existing !== undefined && existsSync(existing.path)) {
      // 同一条消息的同一个 key 重投（飞书会重投）：内容已经在盘上，不存第二份。
      return { ok: true, id, ref: ASSET_SCHEME + id, path: existing.path, record: existing, duplicate: true }
    }
    const kind = input.kind === 'file' ? 'file' : 'image'
    const name = safeFileName(input.name, kind === 'image' ? 'image.png' : 'file')
    const dir = join(root, id)
    const path = join(dir, name)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, Buffer.from(bytes))
    } catch (error) {
      return { ok: false, code: 'write_failed', message: '写资产失败：' + String(error && error.message ? error.message : error) }
    }
    const doc = {
      id,
      ref: ASSET_SCHEME + id,
      kind,
      class: classifyAsset(name, input.contentType),
      name,
      path,
      bytes: bytes.length,
      message_id: messageId,
      file_key: fileKey,
      chat_id: input.chatId ?? null,
      recorded_by: input.recordedBy ?? null,
      at: now().toISOString(),
    }
    records.set(id, doc)
    try {
      mkdirSync(dirname(indexFile), { recursive: true })
      appendFileSync(indexFile, JSON.stringify(doc) + '\n', 'utf8')
    } catch (error) {
      // 索引写不进去不影响这次落库：文件已经在盘上，引用照样有效。
      deps.log?.error?.('[team] assets 索引写失败：' + String(error && error.message ? error.message : error))
    }
    return { ok: true, id, ref: doc.ref, path, record: doc }
  }

  /** 一条记录能不能真的被读到（文件还在不在）—— "有引用"不等于"有内容"。 */
  function describe(doc) {
    if (doc === null) return null
    let exists = false
    let size = doc.bytes ?? null
    try {
      const info = statSync(doc.path)
      exists = info.isFile()
      size = info.size
    } catch (error) {
      exists = false
    }
    return { ...doc, exists, bytes: size, human: humanSize(size) }
  }

  return {
    root,
    indexFile,
    save,
    get: (ref) => describe(record(ref)),
    has: (ref) => record(ref) !== null,
    all: () => {
      ensure()
      return [...records.values()].map(describe)
    },
    count: () => {
      ensure()
      return records.size
    },
  }
}

/** `asset://<id>` → `<id>`；不是资产引用时返回 null（别的 scheme 不归这里管）。 */
export function assetIdOf(ref) {
  const text = typeof ref === 'string' ? ref : ''
  if (!text.startsWith(ASSET_SCHEME)) return null
  const id = text.slice(ASSET_SCHEME.length).trim()
  return id === '' ? null : id
}
