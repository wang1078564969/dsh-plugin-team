/*
 * Markdown → Feishu, on purpose.
 *
 * WHY THIS EXISTS. A model answers in markdown; a Feishu `text` message renders
 * NONE of it. The first time this plugin answered a real question, the person in
 * the chat saw `**bold**`, `` `code` `` and `> quotes` as literal punctuation.
 *
 * Feishu renders markdown only inside an INTERACTIVE CARD's `markdown` element,
 * and even there it is a SUBSET (`lark_md`):
 *
 *   renders     **bold**  *italic*  ~~strike~~  [text](url)
 *               ```fenced code```  <at id=ou_x></at>  <font color='…'>
 *   does NOT    `inline code`    # headings      > blockquotes
 *               - / * list markers as syntax     markdown tables     --- rules
 *
 * So "adapt the markdown" is two jobs, and doing only the first is what produces
 * a card full of stray `>` and `#`:
 *
 *   1. deliver as a card, because that is the only surface that renders any of it;
 *   2. rewrite what `lark_md` cannot express into something it renders ON PURPOSE
 *      — a heading becomes bold, a quote becomes a bar-prefixed line, a list
 *      marker becomes a real bullet, a table becomes a native table element.
 *
 * The plain-text fallback strips the markers instead of shipping them: a fallback
 * that still shows `**` is not a fallback, it is the bug.
 */

/** Feishu rejects oversized card content; stay well under it. */
export const CARD_CONTENT_LIMIT = 28_000

/** `•` is what lark_md shows literally, and it reads as a bullet. */
const BULLET = '•'

/*
 * INLINE CODE IS NOT A THING IN lark_md, and the backticks do real damage: they
 * appear literally to the reader, AND they appear to flip the parser into a code
 * state, so `**bold**` written after them on the same line also stops being
 * parsed. Measured on a real card: the line
 *
 *   行内：`code` · **加粗** · *斜体* · ~~删除~~ · [链接](https://…)
 *
 * rendered as literal `` `code` `` and literal `**加粗**` / `*斜体*` / `~~删除~~`,
 * while the same `**bold**` at the START of another line rendered correctly.
 *
 * So the backticks come off. The word keeps its meaning and loses only a
 * monospace look the platform never had.
 */
const INLINE_CODE = /`([^`\n]+)`/g

/** Does this text contain anything worth rendering as markdown? */
export function shouldRenderAsCard(text) {
  const value = String(text ?? '')
  if (value.length > 240) return true
  return /(\*\*|`|^#{1,6}\s|^>\s|^\s*[-*]\s|^\s*\d+\.\s|^\s*\|.*\|\s*$|^---\s*$)/m.test(value)
}

/**
 * Split markdown into blocks that need different treatment.
 *
 * Fences are extracted FIRST and left untouched: a code block containing `**` or
 * `#` must survive as code, and a normaliser that rewrites inside it turns a
 * shell command into prose.
 *
 * @returns {Array<{kind: 'markdown'|'code'|'table'|'hr', text?: string, language?: string, header?: string[], rows?: string[][]}>}
 */
export function splitBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let buffer = []
  let index = 0

  const flush = () => {
    const text = buffer.join('\n')
    buffer = []
    if (text.trim() !== '') blocks.push({ kind: 'markdown', text })
  }

  while (index < lines.length) {
    const line = lines[index]

    // fenced code
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line)
    if (fence !== null) {
      flush()
      const marker = fence[1][0].repeat(3)
      const language = fence[2] ?? ''
      const body = []
      index += 1
      while (index < lines.length && !new RegExp('^\\s*' + marker + '\\s*$').test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1 // closing fence
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ kind: 'hr' })
      index += 1
      continue
    }

    // a GFM table: a pipe header row followed by a separator row
    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
      flush()
      const header = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    buffer.push(line)
    index += 1
  }
  flush()
  return blocks
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * Adapt the constructs `lark_md` does not understand.
 *
 * Everything it DOES understand is left exactly as written — this is a translator
 * for the parts that would otherwise show up as punctuation, not a markdown
 * cleaner that quietly eats formatting the platform supports.
 */
export function normalizeInline(text) {
  const out = []
  let inTableLike = false
  for (const raw of String(text ?? '').split('\n')) {
    // Inline code first: the backticks are what break emphasis parsing.
    const line = raw.replace(/\s+$/, '').replace(INLINE_CODE, '$1')

    // `# Heading` → bold. lark_md has no heading levels at all.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      out.push('**' + heading[2].trim() + '**')
      inTableLike = false
      continue
    }

    // `> quote` → an explicit bar. lark_md prints `>` as a character, so leaving
    // it produces exactly the "raw markdown" look this module exists to remove.
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      out.push('▎' + quote[1])
      inTableLike = false
      continue
    }

    // `- item` / `* item` → a real bullet character.
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      out.push(bullet[1] + BULLET + ' ' + bullet[2])
      inTableLike = false
      continue
    }

    out.push(line)
  }
  void inTableLike
  return out.join('\n').trim()
}

/** One Feishu `markdown` element. */
function markdownElement(content) {
  return { tag: 'markdown', content }
}

/** A fenced code block, kept as one so lark_md renders it as code. */
function codeElement(text, language) {
  // The language tag rides the OPENING FENCE, not the first line of the block:
  // ```bash\nnpm test\n``` renders as a shell snippet, while ```\nbash\nnpm test\n```
  // renders the word "bash" as the first line of code.
  const open = '```' + (language === '' ? '' : language)
  return markdownElement(open + '\n' + text + '\n```')
}

/** A native Feishu table element — markdown tables are not rendered at all. */
function tableElement(header, rows) {
  return {
    tag: 'table',
    page_size: Math.max(1, Math.min(10, rows.length)),
    row_height: 'low',
    header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', bold: true },
    columns: header.map((name, i) => ({ name: 'c' + i, display_name: name === '' ? ' ' : name, data_type: 'text' })),
    rows: rows.map((row) => {
      const cells = {}
      for (let i = 0; i < header.length; i += 1) cells['c' + i] = row[i] ?? ''
      return cells
    }),
  }
}

/**
 * The card elements for one markdown answer.
 *
 * @param {string} markdown
 * @returns {Array<object>} Feishu card elements, in document order
 */
export function toElements(markdown) {
  const elements = []
  for (const block of splitBlocks(markdown)) {
    if (block.kind === 'code') {
      elements.push(codeElement(block.text, block.language ?? ''))
      continue
    }
    if (block.kind === 'hr') {
      elements.push({ tag: 'hr' })
      continue
    }
    if (block.kind === 'table') {
      elements.push(tableElement(block.header ?? [], block.rows ?? []))
      continue
    }
    const content = normalizeInline(block.text ?? '')
    if (content !== '') elements.push(markdownElement(content))
  }
  return elements
}

/**
 * The payload for one answer.
 *
 * @param {string} markdown
 * @param {{header?: string, color?: string}} [options] optional card header
 * @returns {{msg_type: string, card: object}|null} `null` when there is nothing
 *   to render — the caller should then send nothing rather than an empty card.
 */
export function answerCard(markdown, options = {}) {
  let text = String(markdown ?? '')
  let elements = toElements(text)
  if (elements.length === 0) return null

  let truncated = false
  if (Buffer.byteLength(text, 'utf8') > CARD_CONTENT_LIMIT) {
    // Cut on a character boundary and say so: a silently shortened answer is
    // worse than one that admits it was shortened.
    let cut = text.slice(0, CARD_CONTENT_LIMIT)
    const lastBreak = cut.lastIndexOf('\n')
    if (lastBreak > CARD_CONTENT_LIMIT / 2) cut = cut.slice(0, lastBreak)
    text = cut + '\n\n…（内容过长，已截断）'
    elements = toElements(text)
    truncated = true
  }

  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    elements,
  }
  if (typeof options.header === 'string' && options.header !== '') {
    card.header = {
      template: typeof options.color === 'string' && options.color !== '' ? options.color : 'blue',
      title: { tag: 'plain_text', content: options.header },
    }
  }
  return { msg_type: 'interactive', card, truncated }
}

/**
 * The plain-text shape of the same answer.
 *
 * Used when the card is rejected (missing permission, size, an old client): the
 * markers go away, because a "fallback" that still shows `**` is not a fallback.
 */
export function stripMarkdown(markdown) {
  return String(markdown ?? '')
    .replace(/```[\w+-]*\n([\s\S]*?)```/g, (whole, body) => body.trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, BULLET + ' ')
    .trim()
}
