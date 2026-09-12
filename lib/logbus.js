/*
 * 团队插件的日志：内存环形缓冲 + 追加文件 + 结构化查询。
 *
 * WHY NOT console.log. 设计文档 05 §4.0 把日志放在页面第一屏，理由是一句话：
 * **"出问题时人第一反应是刚才发生什么了"** —— 而不是 ssh 上去 grep。插件到这一版
 * 为止的所有痕迹只有 `console.log`（跟着 harness 的终端滚掉了）与
 * `config-audit.jsonl`（只记配置改了哪些键）。于是"机器人为什么没回这条消息"
 * 只能靠读代码回答。
 *
 * THREE THINGS MAKE IT USABLE, and each is a deliberate limit:
 *
 *   1. **环形缓冲 + 文件双写**。缓冲让页面读得快（不扫文件），文件让**重启前的日志
 *      还在** —— 只留内存的实现重启即空，而恰好"刚重启完"是最需要看上一条的时候。
 *   2. **有上限、会轮转**。默认 2MB 一份，留一份 `.1`。一个会跑几个月的插件，
 *      日志必须自己收敛，不能等磁盘满了才有人发现。
 *   3. **结构化 + 脱敏在写入前**。每条都是 `{at, level, source, message, data}`，
 *      页面按级别/来源筛。脱敏放在**入口**：appSecret 之类的东西一旦写进文件，
 *      再想"显示时过滤"就已经晚了（备份、cat、grep 都会带着它）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 级别从低到高；页面按 `>= level` 筛。 */
export const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'])

/** 缓冲条数上限：够看"刚才"，又不会把内存当数据库用。 */
const DEFAULT_BUFFER = 500
/** 单份日志文件上限（2MB），超了就轮转一份 `.1`。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/**
 * 写入前脱敏。
 *
 * 三类东西永远不该进日志：飞书的 app secret、tenant token、以及任何看起来像
 * 长随机串的凭据。**在入口做**，因为一旦落盘，后面每一个 `cat`/`grep`/备份
 * 都会把它带出去。
 */
export function redactSecrets(text) {
  return String(text)
    .replace(/(appSecret["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***')
    .replace(/(tenant_access_token["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1***')
    .replace(/\b(cli_[A-Za-z0-9]{16,})\b/g, (whole) => whole.slice(0, 8) + '…')
}

function levelRank(level) {
  const at = LEVELS.indexOf(String(level))
  return at < 0 ? LEVELS.indexOf('info') : at
}

/**
 * @param {{dataDir: string, bufferSize?: number, maxBytes?: number, echo?: object|null}} options
 *   `echo` 是还要继续写的地方（默认 console）：harness 的终端仍然要看得到，
 *   但**不看也不会丢** —— 这正是双写的意义。
 */
export function createLogBus(options) {
  const dataDir = String(options?.dataDir ?? '')
  const file = join(dataDir, 'logs', 'team.jsonl')
  const bufferSize = Number.isFinite(options?.bufferSize) ? Number(options.bufferSize) : DEFAULT_BUFFER
  const maxBytes = Number.isFinite(options?.maxBytes) ? Number(options.maxBytes) : DEFAULT_MAX_BYTES
  const echo = options?.echo === undefined ? console : options.echo

  /** @type {Array<{at: string, level: string, source: string, message: string, data: object|null}>} */
  const buffer = []
  const counters = { debug: 0, info: 0, warn: 0, error: 0 }

  function ensureDir() {
    try {
      mkdirSync(join(dataDir, 'logs'), { recursive: true })
    } catch (error) {
      /* 目录建不出来时日志退化成内存缓冲：宁可少留证据，也不要因此抛异常 */
    }
  }

  function rotateIfNeeded() {
    try {
      if (!existsSync(file)) return
      if (statSync(file).size < maxBytes) return
      renameSync(file, file + '.1')
    } catch (error) {
      /* 轮转失败就算了：继续追加，顶多文件大一点 */
    }
  }

  function write(row) {
    buffer.push(row)
    if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize)
    counters[row.level] = (counters[row.level] ?? 0) + 1
    ensureDir()
    rotateIfNeeded()
    try {
      appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
    } catch (error) {
      /* 写不进去只影响"重启后还能看"，不影响运行 */
    }
  }

  function emit(level, source, message, data) {
    const row = {
      at: new Date().toISOString(),
      level,
      source: String(source ?? 'team'),
      message: redactSecrets(message),
      data: data === undefined || data === null ? null : JSON.parse(redactSecrets(JSON.stringify(data))),
    }
    write(row)
    if (echo !== null && echo !== undefined) {
      const line = '[team/' + row.source + '] ' + row.message
      if (level === 'error') echo.error?.(line)
      else if (level === 'warn') echo.warn?.(line)
      else echo.log?.(line)
    }
    return row
  }

  return {
    debug: (source, message, data) => emit('debug', source, message, data),
    info: (source, message, data) => emit('info', source, message, data),
    warn: (source, message, data) => emit('warn', source, message, data),
    error: (source, message, data) => emit('error', source, message, data),
    /** 兼容 `console` 的接口：可以直接当 `log` 传给别的模块。 */
    log: (message) => emit('info', 'team', message),
    file,

    /**
     * 查日志：内存缓冲 + （可选）文件里更早的那些。
     *
     * @param {{level?: string, source?: string, limit?: number, includeFile?: boolean, contains?: string}} [query]
     */
    query(query = {}) {
      const limit = Number.isFinite(query.limit) ? Math.max(1, Number(query.limit)) : 200
      const min = levelRank(query.level ?? 'debug')
      const source = typeof query.source === 'string' && query.source !== '' ? query.source : null
      const contains = typeof query.contains === 'string' && query.contains !== '' ? query.contains.toLowerCase() : null
      const keep = (row) =>
        levelRank(row.level) >= min &&
        (source === null || row.source === source) &&
        (contains === null || String(row.message).toLowerCase().includes(contains))

      const fromBuffer = buffer.filter(keep)
      if (query.includeFile !== true) return { rows: fromBuffer.slice(-limit), fromFile: 0 }

      /*
       * 文件里可能有缓冲之前的行（上次进程写的）。读它、按 `at` 去重、合并排序 ——
       * "重启前的日志"就是靠这一段。
       */
      let older = []
      try {
        if (existsSync(file)) {
          const lines = readFileSync(file, 'utf8').split('\n').filter((one) => one.trim() !== '')
          older = lines
            .map((line) => {
              try {
                return JSON.parse(line)
              } catch (error) {
                return null
              }
            })
            .filter((row) => row !== null && keep(row))
        }
      } catch (error) {
        older = []
      }
      const seen = new Set(fromBuffer.map((row) => row.at + '|' + row.message))
      const merged = [...older.filter((row) => !seen.has(row.at + '|' + row.message)), ...fromBuffer]
      merged.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      return { rows: merged.slice(-limit), fromFile: merged.length - fromBuffer.length }
    },

    /** 级别计数（页面上的角标用）。 */
    counts() {
      return { ...counters, buffered: buffer.length }
    },

    /** 来源清单：页面筛选用，且只列真的出现过的。 */
    sources() {
      const set = new Set(buffer.map((row) => row.source))
      try {
        if (existsSync(file)) {
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (line.trim() === '') continue
            try {
              const row = JSON.parse(line)
              if (typeof row.source === 'string') set.add(row.source)
            } catch (error) {
              /* 坏行跳过 */
            }
          }
        }
      } catch (error) {
        /* 读不到就只报内存里的来源 */
      }
      return [...set].sort()
    },

    /** 测试与运维用：清空内存缓冲（文件保留 —— "清空日志"不该等于"销毁证据"）。 */
    clearBuffer() {
      buffer.length = 0
      return true
    },
  }
}

/** 一个空实现的日志器，给"没有日志也能跑"的测试用。 */
export function nullLogBus() {
  const noop = () => null
  return { debug: noop, info: noop, warn: noop, error: noop, log: noop, query: () => ({ rows: [], fromFile: 0 }), counts: () => ({ buffered: 0 }), sources: () => [], clearBuffer: () => true, file: '' }
}

/** 供测试用：写一份日志文件（模拟"上次进程写的"）。 */
export function writeLogFile(dataDir, rows) {
  const dir = join(dataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'team.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  return join(dir, 'team.jsonl')
}
