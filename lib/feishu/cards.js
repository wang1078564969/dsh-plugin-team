/*
 * 来源：hub/src/feishu/messages.ts（475 行，TypeScript）
 *      + hub/test/messages.test.ts 的「渲染」与「降级链」两节
 *
 * 设计文档：team-agent-architecture/04-feishu-message-design.md §3.1 / §3.2 / §3.4
 *
 * 这是本插件的**飞书卡片投影层**：把一张与传输无关的 CardSpec 变成
 * 「可以直接 POST 给飞书 API 的 payload 序列」，并给出五级降级链。
 *
 * 改了什么：
 *   1. **发送 → 纯函数**。hub 的 messages.ts 里 `post/patch/sendCard/updateCard/
 *      sendText/uploadFile` 是 async 网络代码（依赖 FeishuClient + SDK + Buffer）。
 *      本文件只保留「构造要发什么」的纯函数部分：输入对象 → 输出 payload，
 *      一个字节都不发出去。真正发的地方是 `deliverCard()`（唯一的 I/O 边界，
 *      client 由调用方注入），所以本文件可以在任何环境里被单测。
 *   2. **五级链变成一份数据**：`degradationLadder(spec)` 返回**有序数组**，
 *      每项 `{ level, via, payload }`，`payload` 直接可发。hub 用 for 循环 +
 *      await 走这条链，级别顺序散在控制流里；抽成数组之后「每一级都能被单独
 *      取出并发送」变成类型层面的事实，而不是注释里的承诺。
 *   3. **TS 类型 → JSDoc @typedef**（CardSpec / CardBlock / CardButton /
 *      CardTable / DeliveryVariant / DeliveryResult / SendTarget / FileAttachment）。
 *   4. **新增 `toFeishuCard(spec)`**：约定好的接口名，返回 `{ msg_type:
 *      'interactive', card: {...} }`——`buildCardJson()` 仍返回 JSON **字符串**
 *      （与 hub 逐字一致，飞书 API 的 `content` 字段要的就是字符串），
 *      `toFeishuCard()` 返回**对象**，两者是同一份 JSON 的两种视图。
 *   5. **新增第 5 级的 payload**。hub 里第 5 级（超长内容落文件）返回
 *      `{ ok:false, via:'text-with-file' }` 并注释「交给调用方」，
 *      由 `sendLongTextViaFile()` 另行实现（要 Buffer + SDK 上传）。
 *      纯函数版把它补齐：第 5 级是一个 `{ text 摘要 } ∪ { file 附件 }` 的
 *      payload 对，超长正文按 UTF-8 字节截断 + 省略标记，内容不丢但也不超限。
 *   6. **卡片 JSON 有体积上限**：超过 `CARD_MAX_BYTES` 时，卡片级的
 *      markdown 会被按字节截断并追加「完整版见附件」，保证发出去的一定是
 *      合法 JSON（hub 没有这道闸，超限只会在飞书那一侧失败一次）。
 *   7. **引用回复**：卡片/文本 payload 不再在构造期决定 reply 路径——
 *      hub 在 `post()` 里先发 `/reply` 再退化。纯函数版把这件事留给
 *      `deliverCard()` 的 `target.reply_to`（语义保留，见那里的注释）。
 *
 * 没能保住的语义（显式列出）：
 *   - **六个发送函数改名，语义一一对应**（hub 名 → 这里）：
 *     `sendCard` / `updateCard` → `deliverCard(client, target, card, { patchMessageId })`
 *     （`patchMessageId` 非空即原地更新，就是 hub 的 updateCard）；
 *     `sendText` → `deliverText`；`uploadFile` / `sendFileByKey` /
 *     `sendLongTextViaFile` → **不存在**，第 5 级的附件由 payload 里的
 *     `file: { file_name, file_type, markdown, bytes, truncated, full_bytes }`
 *     描述，上传与发送是发送层的事（需要 multipart 与真实凭证）。
 *   - **真实发送**：`post()` 的 uuid 幂等键、`PATCH /im/v1/messages/:id`、
 *     `uploadFile()` 的 multipart 上传、`FILE_MAX_BYTES` 的 30MB 前置拒绝
 *     （`buildAttachment` 里保留了同一道判断，只是不再真的上传），
 *     都在需要真网络/Buffer/SDK 的那一层。本文件只产出 payload；
 *     `deliverCard()` 负责 POST/PATCH 与引用退化，但**不含**重试退避
 *     （那是 FeishuClient 的事，本插件不复刻客户端）。
 *   - **飞书卡片 v2（schema 2.0）** 未涉及：hub 也只用 v1 形状的
 *     interactive card（`config/header/elements`）。
 *   - **卡片 JSON 体积上限的具体数值**（`CARD_MAX_BYTES = 30000`）是估计值：
 *     hub 与设计文档都只说「有上限」，没说多少。改成真实值只需改这一个常量。
 *   - **`renderTableAsText` 的列宽按 code point 计**（与 hub 一致），
 *     中文/全角字符在等宽字体下会偏窄。要保持 hub 行为就必须保留这一点，
 *     所以只在此处说明，不改。
 */

/* ------------------------------------------------------------------ *
 * 与传输无关的卡片形状：只描述「要什么」，不描述飞书的 JSON 细节
 * ------------------------------------------------------------------ */

/**
 * @typedef {'card'|'card-plain-table'|'card-no-buttons'|'text'|'text-with-file'} DeliveryVariant
 *
 * @typedef {object} CardButton
 * @property {string} label 按钮文字
 * @property {string} action 动作名（如 task.accept）；降级成文本时渲染为「回复 `task.accept`」
 * @property {Record<string, unknown>} value 传给服务端的强类型 value
 * @property {'default'|'primary'|'danger'} [type]
 *
 * @typedef {object} CardTable
 * @property {string[]} headers
 * @property {string[][]} rows
 * @property {Array<'left'|'right'>} [align] 每列对齐，降级成文本时保持可读
 *
 * @typedef {{kind:'markdown', content:string}
 *   |{kind:'table', table:CardTable}
 *   |{kind:'buttons', buttons:CardButton[]}
 *   |{kind:'note', content:string}} CardBlock
 *
 * @typedef {object} CardSpec
 * @property {string} title
 * @property {string} [anchor] 标题右侧小字锚点（req-id / task-id），方便复制搜索
 * @property {string} [status] 状态行：一眼看出「什么状态、归谁」
 * @property {string} [confirm_line] 确认行：跨域任务才有
 * @property {string} [at_line] @人行：真正的飞书 @（`<at id=ou_x></at>`）——
 *   写"@张三"只是文字，**不会通知任何人**；要通知就必须用这个标签。
 * @property {CardBlock[]} blocks
 * @property {string} [footer] 底部灰字：耗时 / token / 进度
 * @property {'blue'|'green'|'red'|'orange'|'grey'} [headerTemplate]
 * @property {{file_name:string, markdown?:string, summary?:string}} [file]
 *   降级到第 5 级时要落成附件的内容源；缺省时由整卡 markdown 合成
 *
 * @typedef {object} SendTarget
 * @property {string} chat_id
 * @property {string|null} [reply_to] 引用回复的目标消息（话题隔离用）；失败自动退化为普通消息
 *
 * @typedef {object} FileAttachment
 * @property {string} file_name
 * @property {'opus'|'mp4'|'pdf'|'doc'|'xls'|'ppt'|'stream'} file_type
 * @property {string} markdown
 * @property {number} bytes UTF-8 字节数
 * @property {boolean} truncated 是否被截断（截断了就必须在摘要里说明）
 * @property {number} full_bytes 截断前的完整字节数
 *
 * @typedef {object} DeliveryAttempt
 * @property {DeliveryVariant} variant 哪一级失败了
 * @property {string} error 失败原因
 *
 * @typedef {object} DeliveryResult
 * @property {boolean} ok
 * @property {DeliveryVariant} via 实际走通的那一级（连续走低级 = 卡片渲染有问题的可观测信号）
 * @property {string|null} message_id
 * @property {DeliveryAttempt[]} attempts
 */

/* ------------------------------------------------------------------ *
 * 体量常量
 * ------------------------------------------------------------------ */

/** 飞书一张卡最多 5 个原生表格组件，超出的降级为文本 */
export const MAX_TABLE_ELEMENTS = 5

/**
 * 卡片 JSON 的体积上限（字节）。
 *
 * hub 与设计文档都只说「有上限」而没给数值，这里取一个保守值：
 * 20KB 的卡片在飞书客户端稳定可渲染，30KB 开始出现「卡片过大」类报错。
 */
export const CARD_MAX_BYTES = 30_000

/** 超过这个字节数的正文，第 4 级（纯文本）已经不体面了，应直接落附件 */
export const FILE_THRESHOLD_BYTES = 8_000

/** 飞书单个文件上限（hub: FILE_MAX_BYTES = 30MB）——超过就只发摘要，附件放弃 */
export const FILE_MAX_BYTES = 30 * 1024 * 1024

/* ------------------------------------------------------------------ *
 * UTF-8 字节工具（降级到第 5 级时用）
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder()

/** 字符串的 UTF-8 字节数（不是 .length——中文一个字 3 字节） */
export function utf8Bytes(text) {
  return encoder.encode(text).byteLength
}

/**
 * 按 UTF-8 字节数截断，并追加省略标记。
 *
 * 逐字符累加而不是先 encode 再 slice 字节：后者会把一个多字节字符劈成
 * 半个，发出去就是乱码。
 */
export function truncateUtf8(text, maxBytes, marker = '\n\n…（内容过长，已截断；完整版见附件）') {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false }
  const budget = Math.max(0, maxBytes - utf8Bytes(marker))
  let used = 0
  let out = ''
  for (const ch of text) {
    const n = utf8Bytes(ch)
    if (used + n > budget) break
    used += n
    out += ch
  }
  return { text: out + marker, truncated: true }
}

/** 截断到**整行**（附件内容截在句子中间很难读） */
function truncateUtf8AtLine(text, maxBytes, marker) {
  const first = truncateUtf8(text, maxBytes, marker)
  if (!first.truncated) return first
  const cut = first.text.slice(0, first.text.length - marker.length)
  const nl = cut.lastIndexOf('\n')
  const kept = nl > 0 ? cut.slice(0, nl) : cut
  return { text: kept + marker, truncated: true }
}

/* ------------------------------------------------------------------ *
 * 表格与文本渲染
 * ------------------------------------------------------------------ */

/** 表格拍平成等宽文本——飞书卡片最多 5 个表格组件，超出的必须降级 */
export function renderTableAsText(table, maxWidth = 40) {
  const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
  const widths = table.headers.map((h, i) => {
    const cells = [h, ...table.rows.map((r) => r[i] ?? '')]
    return Math.min(maxWidth, Math.max(...cells.map((c) => clip(cleanCell(c), maxWidth).length)))
  })
  const line = (cells) =>
    cells
      .map((c, i) => {
        const text = clip(cleanCell(c), widths[i] ?? maxWidth)
        const pad = ' '.repeat(Math.max(0, (widths[i] ?? maxWidth) - text.length))
        return table.align?.[i] === 'right' ? pad + text : text + pad
      })
      .join('  ')
      .trimEnd()

  const out = [line(table.headers.map(cleanCell)), widths.map((w) => '-'.repeat(w)).join('  ')]
  for (const row of table.rows) out.push(line(row))
  return out.join('\n')
}

/**
 * 卡片里的 `@` 标签 → 纯文本消息里的写法。
 *
 * 两张载体的语法不同且**不通用**：卡片（lark_md）是 `<at id=ou_x></at>`，
 * 文本消息是 `<at user_id="ou_x"></at>`。写错了不会报错，只会静静地不通知任何人 ——
 * 这正是"谁没确认就 @ 谁"最容易失效的地方。
 */
export function atLineAsText(line) {
  return String(line ?? '').replace(/<at id=([^>\s]+)\s*>\s*<\/at>/g, '<at user_id="$1"></at>')
}

/** 把整张卡渲染成 markdown（降级到第 3 级「去按钮」时用，也是纯文本兜底的内容源） */
export function renderCardAsMarkdown(card, opts = {}) {
  const withButtons = opts.buttons ?? true
  const lines = []
  if (card.status !== undefined && card.status !== '') lines.push(card.status)
  if (card.confirm_line !== undefined && card.confirm_line !== '') lines.push(card.confirm_line)
  /*
   * @人行：卡片 markdown 用 `<at id=ou_x></at>`，而**纯文本消息**用的是
   * `<at user_id="ou_x"></at>` —— 飞书两种载体的语法不同且不通用。降级到
   * 4/5 级时必须换过来，否则人看到的是一个字面标签，或者干脆收不到通知。
   */
  if (card.at_line !== undefined && card.at_line !== '') lines.push(atLineAsText(card.at_line))
  if (lines.length > 0) lines.push('')

  for (const block of card.blocks) {
    switch (block.kind) {
      case 'markdown':
        lines.push(block.content)
        break
      case 'table':
        lines.push('```\n' + renderTableAsText(block.table) + '\n```')
        break
      case 'buttons':
        if (withButtons) {
          lines.push(block.buttons.map((b) => `[${b.label}]`).join('  '))
          lines.push('')
          lines.push(
            '（按钮不可用时，直接回复：' +
              block.buttons.map((b) => `${b.action} → 回 "${b.action}"`).join('；') +
              '）',
          )
        } else {
          lines.push('操作：' + block.buttons.map((b) => `回复 \`${b.action}\` 表示「${b.label}」`).join('；'))
        }
        break
      case 'note':
        lines.push(block.content)
        break
      default:
        break
    }
    lines.push('')
  }
  if (card.footer !== undefined && card.footer !== '') lines.push(card.footer)
  return lines.join('\n').trimEnd()
}

/* ------------------------------------------------------------------ *
 * 卡片 JSON（飞书交互卡片格式）
 * ------------------------------------------------------------------ */

/**
 * 渲染飞书交互卡片的 JSON **字符串**。
 *
 * 与 hub 的 `buildCardJson()` 逐字一致（含 `config` / `header` / `elements`
 * 三层形状与 `JSON.stringify` 的紧凑输出）：飞书 API 的 `content` 字段要的
 * 就是这样一个字符串。要对象视图请用 `toFeishuCard()`。
 */
export function buildCardJson(card, opts = {}) {
  const withTables = opts.tables ?? true
  const withButtons = opts.buttons ?? true
  const elements = []

  if (card.status !== undefined && card.status !== '') {
    elements.push({ tag: 'markdown', content: `**${card.status}**` })
  }
  if (card.confirm_line !== undefined && card.confirm_line !== '') {
    elements.push({ tag: 'markdown', content: card.confirm_line })
  }
  /*
   * @人行放在分隔线**之前**：它属于卡片头部那几行（状态 / 确认 / @谁），
   * 不是正文的一部分。飞书的 `<at id=ou_x></at>` 是真的通知 ——
   * 与正文里手写的"@张三"完全是两件事（后者不通知任何人）。
   */
  if (card.at_line !== undefined && card.at_line !== '') {
    elements.push({ tag: 'markdown', content: card.at_line })
  }
  if (elements.length > 0) elements.push({ tag: 'hr' })

  let tablesPlaced = 0
  for (const block of card.blocks) {
    switch (block.kind) {
      case 'markdown':
        elements.push({ tag: 'markdown', content: block.content })
        break
      case 'table':
        if (withTables && tablesPlaced < MAX_TABLE_ELEMENTS) {
          tablesPlaced += 1
          elements.push(tableElement(block.table))
        } else {
          elements.push({ tag: 'markdown', content: '```\n' + renderTableAsText(block.table) + '\n```' })
        }
        break
      case 'buttons':
        if (withButtons) {
          elements.push({
            tag: 'action',
            actions: block.buttons.map((b) => ({
              tag: 'button',
              text: { tag: 'plain_text', content: b.label },
              type: b.type ?? 'default',
              value: { ...b.value, action: b.action },
            })),
          })
        } else {
          elements.push({
            tag: 'markdown',
            content: '操作：' + block.buttons.map((b) => `回复 \`${b.action}\` 表示「${b.label}」`).join('；'),
          })
        }
        break
      case 'note':
        elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: block.content }] })
        break
      default:
        break
    }
  }

  /*
   * footer → `note` 元素（灰色小字）。
   *
   * 这一段以前**只在文本降级里有**：卡片 JSON 的构造整个漏了它，所以原生卡片上
   * "⏱ 2m14s · 🧠 12.3k tok · 🔄 3 步"永远不显示 —— 而它恰恰是"这活花了多久、
   * 走了几步"唯一的落点（设计 04 §3.1）。放在**最后**：note 是卡片的脚注。
   */
  if (card.footer !== undefined && card.footer !== '') {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: card.footer }] })
  }

  if (elements.length === 0) elements.push({ tag: 'markdown', content: '（没有可展示的内容）' })

  const header = {
    template: card.headerTemplate ?? 'blue',
    title: { tag: 'plain_text', content: card.title },
  }
  if (card.anchor !== undefined && card.anchor !== '') {
    header.subtitle = { tag: 'plain_text', content: card.anchor }
  }

  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header,
    elements,
  })
}

/**
 * 约定好的接口：飞书原生卡片 JSON。
 *
 * @param {CardSpec} spec
 * @param {{tables?:boolean, buttons?:boolean}} [opts]
 * @returns {{msg_type:'interactive', card:{config:object, header:object, elements:object[]}}}
 *   `card` 是**已解析的对象**（便于断言与二次加工），`content` 不在其中——
 *   要发给飞书 API 的字符串形态请用 `buildCardJson()`；本函数的对象
 *   `JSON.stringify()` 之后与它逐字节相同。
 */
export function toFeishuCard(spec, opts = {}) {
  return { msg_type: 'interactive', card: JSON.parse(buildCardJson(spec, opts)) }
}

/** 超限时按字节截断所有 markdown 元素，保证发出去的一定是合法 JSON */
function fitCardJson(card, opts, maxBytes) {
  const raw = buildCardJson(card, opts)
  if (utf8Bytes(raw) <= maxBytes) return raw

  const parsed = JSON.parse(raw)
  const marker = '\n\n…（内容过长，已截断；完整版见附件）'
  const contents = parsed.elements.filter((el) => el.tag === 'markdown' && typeof el.content === 'string')
  // 先把正文抄下来，再把它们清空，量出「骨架」的字节数；剩下的额度按元素平分。
  // 这样不论卡里有几个 markdown 元素，总量都收敛在 maxBytes 以内。
  const originals = contents.map((el) => el.content)
  for (const el of contents) el.content = ''
  const skeleton = utf8Bytes(JSON.stringify(parsed))

  // 每个元素都要追加省略标记，标记本身也吃额度——先把它从总额里扣掉
  const overhead = utf8Bytes(marker) * contents.length
  const room = Math.max(0, maxBytes - skeleton - overhead)
  const each = contents.length === 0 ? 0 : Math.floor(room / contents.length)
  for (let i = 0; i < contents.length; i += 1) {
    contents[i].content = truncateUtf8(originals[i], each, marker).text
  }
  return JSON.stringify(parsed)
}

/**
 * 一个单元格里的文字，先清理再渲染。
 *
 * 表格的两种渲染目标都**容不下多行**：等宽文本里一个 `\n` 会把一行拆成两行、
 * 整张表的列宽全乱；飞书原生表格单元格里的换行也同样把行高撑坏。而表格数据的
 * 来源（验收标准、文件清单、agent 汇报的摘要）里换行是常态。
 *
 * `|` 也要处理：等宽文本会被塞进 ``` 围栏（那边无所谓），但第 2/3 级降级里的
 * 表格是 markdown 源码，未转义的 `|` 会把一格切成两格 —— 那是**渲染出来的内容
 * 与数据不一致**，比缺一格更难发现。
 */
export function cleanCell(value) {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  return text
    .replace(/\r\n?/g, '\n')
    // 单元格内的换行 → 空格（不是删掉："a 换行 b" 读作 "a b"，不是 "ab"）
    .replace(/\n+/g, ' ')
    .replace(/\t/g, ' ')
    // markdown 表格里的竖线要转义；等宽文本里 反斜杠加竖线 也就是多一个反斜杠，可接受
    .replace(/\|/g, '\\|')
    .replace(/ {2,}/g, ' ')
    .trim()
}

function tableElement(table) {
  return {
    tag: 'table',
    page_size: Math.max(1, Math.min(10, table.rows.length)),
    row_height: 'low',
    header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', bold: true },
    columns: table.headers.map((h, i) => ({
      name: `c${i}`,
      display_name: cleanCell(h),
      data_type: 'text',
      ...(table.align?.[i] === 'right' ? { horizontal_align: 'right' } : {}),
    })),
    rows: table.rows.map((row) => {
      const cells = {}
      for (let i = 0; i < table.headers.length; i += 1) cells[`c${i}`] = cleanCell(row[i])
      return cells
    }),
  }
}

/* ------------------------------------------------------------------ *
 * 降级链：内容永远不能因为渲染问题丢失
 * ------------------------------------------------------------------ */

/**
 * 前三级 = 卡片真的发出去了；后两级 = 降级（设计 04 §3.2）。
 *
 * 「降级率」（04 §11 第 4 条）就是后两级占成功投递的比例，所以这两个集合是
 * **被观测的常量**，不是实现细节：观测层（`lib/metrics.js`）从这里 import，
 * 而不是自己再写一遍字符串数组 —— 否则以后加了第六级，比率会静默算错。
 */
export const CARD_VIAS = ['card', 'card-plain-table', 'card-no-buttons']
export const FALLBACK_VIAS = ['text', 'text-with-file']

/**
 * 五级降级链（设计文档 04 §3.2，顺序**不许改**）：
 *
 *   1. card              完整卡（含表格、按钮）
 *   2. card-plain-table  卡（表格拍平为等宽文本）
 *   3. card-no-buttons   卡（去掉按钮，改为文本指令）
 *   4. text              纯文本消息
 *   5. text-with-file    纯文本 + 附件（超长内容落文件）
 *
 * @param {CardSpec} spec
 * @param {{tables?:boolean, buttons?:boolean, ladderId?:string, maxBytes?:number,
 *          file?:{file_name:string, markdown?:string, summary?:string}}} [opts]
 * @returns {Array<{level:number, via:DeliveryVariant, payload:object}>}
 *   有序数组；每项都能被**单独取出并发送**（这就是「每一级都可独立构造」的形态）。
 *   payload 直接就是飞书 API 的请求体：
 *     - 1–3 级：`{ msg_type:'interactive', content:'<卡片 JSON 字符串>', uuid }`
 *     - 4 级  ：`{ msg_type:'text', content:'{"text":"..."}', uuid }`
 *     - 5 级  ：`{ text:{...}, file:{ file_name, file_type, markdown, bytes, … } | null }`
 *
 * 说明：第 5 级的 rank 用**降级位次**（1..5）而不是级别名——位次和 `via`
 * 是一一对应的，`via` 才是日志里那个可观测信号。1–3 级额外带 `variant`
 * （与 hub 的 `DeliveryVariant` 同名），方便直接对照 hub 的 attempts 记录。
 */
export function degradationLadder(spec, opts = {}) {
  const maxBytes = opts.maxBytes ?? CARD_MAX_BYTES
  const ladderId = opts.ladderId ?? specFileStem(spec)
  const text = renderCardAsMarkdown(spec, { buttons: false })
  const attachment = buildAttachment(spec, opts, text)

  const cardPayload = (tables, buttons) => ({
    msg_type: 'interactive',
    content: fitCardJson(spec, { tables, buttons }, maxBytes),
    uuid: ladderUuid(ladderId, tables ? 'card' : buttons ? 'card-plain-table' : 'card-no-buttons'),
  })

  return [
    { level: 1, via: 'card', payload: cardPayload(true, true) },
    { level: 2, via: 'card-plain-table', payload: cardPayload(false, true) },
    { level: 3, via: 'card-no-buttons', payload: cardPayload(false, false) },
    {
      level: 4,
      via: 'text',
      payload: { msg_type: 'text', content: JSON.stringify({ text }), uuid: ladderUuid(ladderId, 'text') },
    },
    {
      level: 5,
      via: 'text-with-file',
      payload: {
        msg_type: 'text',
        content: JSON.stringify({ text: attachment.summary }),
        uuid: ladderUuid(ladderId, 'text-with-file'),
        // 附件本身不能塞进这条消息的 content 里：上传要 multipart，由发送层接着做。
        // `file: null` 表示「没有任何内容可落附件」，此时这一级就等于一条摘要。
        file: attachment.file,
      },
    },
  ]
}

/**
 * 取某一级的 payload（`degradationLadder()` 的便捷视图，语义完全相同）。
 *
 * @param {CardSpec} spec
 * @param {DeliveryVariant} variant
 * @param {object} [opts] 与 `degradationLadder` 相同的选项
 */
export function buildCardPayload(spec, variant, opts = {}) {
  const found = degradationLadder(spec, opts).find((item) => item.via === variant)
  if (found === undefined) {
    throw new Error(`未知的投递级别: ${String(variant)}`)
  }
  return found.payload
}

/** 第 5 级的附件：优先用 spec.file 指定的内容，否则用整卡 markdown */
function buildAttachment(spec, opts, fallbackMarkdown) {
  const source = opts.file ?? spec.file ?? {}
  const markdown = source.markdown ?? fallbackMarkdown
  const summary = source.summary ?? firstLines(spec, fallbackMarkdown)
  const fullBytes = utf8Bytes(markdown)
  const fileName = source.file_name ?? `${specFileStem(spec)}.md`

  if (fullBytes > FILE_MAX_BYTES) {
    // 超过飞书 30MB 上限：提前拒绝附件，但摘要与内容判定仍然如实上报
    return {
      summary,
      file: {
        file_name: fileName,
        file_type: fileTypeOf(fileName),
        markdown: '',
        bytes: 0,
        truncated: true,
        full_bytes: fullBytes,
        dropped: `内容 ${fullBytes} 字节，超过飞书文件上限 ${FILE_MAX_BYTES}`,
      },
    }
  }

  const fit = truncateUtf8AtLine(markdown, FILE_THRESHOLD_BYTES, '\n\n…（已截断，完整内容见工作区证据）')
  return {
    summary,
    file: {
      file_name: fileName,
      file_type: fileTypeOf(fileName),
      markdown: fit.text,
      bytes: utf8Bytes(fit.text),
      truncated: fit.truncated,
      full_bytes: fullBytes,
    },
  }
}

/** 附件存在时摘要要说明「完整版在哪」，否则人会以为内容丢了 */
function firstLines(spec, markdown) {
  const head = markdown.split('\n').filter((l) => l.trim() !== '').slice(0, 3).join('\n')
  const short = truncateUtf8(head, 300, '…')
  const where = `${spec.title}${spec.anchor === undefined || spec.anchor === '' ? '' : `（${spec.anchor}）`}`
  return `${where}\n${short.text}\n完整版见附件 ${specFileStem(spec)}.md`
}

/** 附件/幂等键用的稳定文件名词干 */
function specFileStem(spec) {
  const base = spec.anchor !== undefined && spec.anchor !== '' ? spec.anchor : spec.title
  return String(base).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'card'
}

/** 幂等键：飞书要求 uuid ≤ 50 字符，同一级在同一张卡上稳定不变 */
export function ladderUuid(id, via) {
  return `${id}-${via}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 50)
}

/**
 * 新消息的幂等键（hub 的 `newMessageId()` 逐字保留）。
 *
 * 飞书要求 uuid ≤ 50 字符；重投时飞书自己去重，避免同一张卡发两遍。
 */
export function newMessageId() {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`.slice(0, 50)
}

/** 文件类型按扩展名映射，未知落 stream（hub 的 `fileTypeOf()` 逐字保留） */
export function fileTypeOf(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.opus')) return 'opus'
  if (lower.endsWith('.mp4')) return 'mp4'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'doc'
  if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) return 'xls'
  if (lower.endsWith('.ppt') || lower.endsWith('.pptx')) return 'ppt'
  return 'stream'
}

/* ------------------------------------------------------------------ *
 * 发送（**唯一的 I/O 边界**；client 由调用方注入，测试里是假的）
 * ------------------------------------------------------------------ */

/**
 * 按降级链发送一张卡。
 *
 * 与 hub 的 `sendCard()` / `updateCard()` 同一套语义，只是把「发什么」交给
 * `degradationLadder()`：
 *   - `target.reply_to` 存在时先走引用回复；**引用失败自动退化为普通消息**
 *     （不能让一条引用吞掉答案——这是 hub 的测试抓出来的 bug）
 *   - 1–3 级走 `interactive`，4 级走 `text`，5 级只发摘要并回报 `file`
 *   - 失败**不抛异常**，逐级记进 `attempts`
 *
 * @param {{request:(method:string, path:string, body?:unknown)=>Promise<{code:number,msg?:string,data?:{message_id?:string}}>}} client
 * @param {SendTarget} target
 * @param {CardSpec} card
 * @param {{patchMessageId?:string|null, opts?:object}} [options]
 *   `patchMessageId` 非空时前三级走 `PATCH /im/v1/messages/:id`（原地更新）
 * @returns {Promise<DeliveryResult & {file?:object|null}>}
 */
export async function deliverCard(client, target, card, options = {}) {
  /** @type {DeliveryAttempt[]} */
  const attempts = []
  const patchMessageId = options.patchMessageId ?? null
  const ladder = degradationLadder(card, options.opts ?? {})

  const send = async (payload) => {
    if (patchMessageId !== null && payload.msg_type === 'interactive') {
      return patch(client, patchMessageId, payload)
    }
    return post(client, target, payload)
  }

  for (const item of ladder.slice(0, 4)) {
    const result = await send(item.payload)
    if (result.code === 0) {
      return { ok: true, via: item.via, message_id: result.message_id ?? patchMessageId, attempts }
    }
    attempts.push({ variant: item.via, error: result.msg })
  }

  // 第 5 级：摘要已经发出去了，附件由调用方（上传需要 multipart）接着发。
  const last = ladder[4].payload
  const summary = await post(client, target, { msg_type: 'text', content: last.content })
  if (summary.code === 0) {
    return {
      ok: true,
      via: 'text-with-file',
      message_id: summary.message_id,
      attempts,
      file: last.file,
    }
  }
  attempts.push({ variant: 'text-with-file', error: summary.msg })
  return { ok: false, via: 'text-with-file', message_id: null, attempts, file: last.file }
}

/** 只发纯文本（简单场景不必过卡片） */
export async function deliverText(client, target, text) {
  /** @type {DeliveryAttempt[]} */
  const attempts = []
  const result = await post(client, target, { msg_type: 'text', content: JSON.stringify({ text }) })
  if (result.code === 0) return { ok: true, via: 'text', message_id: result.message_id, attempts }
  attempts.push({ variant: 'text', error: result.msg })
  return { ok: false, via: 'text', message_id: null, attempts }
}

/**
 * POST 一条消息。引用失败时退化为普通消息。
 *
 * 与 hub 的 `post()` 一致，**包括那个关键细节**：飞书用非零 `code` 表示失败
 * 而不是抛异常，所以回退不能只写在 catch 里——那样「引用失败」永远退不回去。
 */
async function post(client, target, payload) {
  const replying = target.reply_to !== undefined && target.reply_to !== null && target.reply_to !== ''
  const body = {
    msg_type: payload.msg_type,
    content: payload.content,
    uuid: payload.uuid ?? newMessageId(),
  }
  try {
    const r = replying
      ? await client.request('POST', `/im/v1/messages/${encodeURIComponent(target.reply_to)}/reply`, body)
      : await client.request('POST', '/im/v1/messages?receive_id_type=chat_id', {
          receive_id: target.chat_id,
          ...body,
        })
    if (r.code !== 0 && replying) {
      return await post(client, { chat_id: target.chat_id, reply_to: null }, payload)
    }
    return { code: r.code, message_id: r.data?.message_id ?? null, msg: r.msg ?? '' }
  } catch (error) {
    const message = String(error && error.message !== undefined ? error.message : error)
    if (replying) return await post(client, { chat_id: target.chat_id, reply_to: null }, payload)
    return { code: -1, message_id: null, msg: message }
  }
}

async function patch(client, messageId, payload) {
  try {
    const r = await client.request('PATCH', `/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: payload.content,
    })
    return { code: r.code, message_id: messageId, msg: r.msg ?? '' }
  } catch (error) {
    const message = String(error && error.message !== undefined ? error.message : error)
    return { code: -1, message_id: null, msg: `更新卡片失败: ${message}` }
  }
}
