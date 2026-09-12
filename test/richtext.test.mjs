/*
 * Markdown → Feishu rendering.
 *
 * The failure this file exists for: a model answered with `**bold**`, `> quotes`
 * and a table, the plugin sent it as a Feishu `text` message, and the person in
 * the chat saw raw punctuation. Feishu renders markdown nowhere except inside an
 * interactive card's `markdown` element, and even there only a subset.
 *
 * These tests are therefore about two things at once: what goes out as a card,
 * and what the parts Feishu cannot express turn into.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { CARD_CONTENT_LIMIT, answerCard, normalizeInline, shouldRenderAsCard, splitBlocks, stripMarkdown, toElements } from '../lib/feishu/richtext.js'

test('a heading, a quote and a list become what lark_md can actually render', () => {
  const normalized = normalizeInline(['## 状态', '> 这条是引用', '- 第一项', '  - 缩进项', '1. 有序项'].join('\n'))
  assert.equal(
    normalized,
    ['**状态**', '▎这条是引用', '• 第一项', '  • 缩进项', '1. 有序项'].join('\n'),
  )
  // What it must NOT do: eat the constructs Feishu DOES render. (Inline code is
  // not one of them — its backticks are dropped, see the test below.)
  assert.equal(normalizeInline('**已经是粗体** 和 *斜的*'), '**已经是粗体** 和 *斜的*')
})

test('inline code loses its backticks, because lark_md shows them and then stops parsing emphasis', () => {
  /*
   * Measured on a real card: `行内：`code` · **加粗**` rendered with literal
   * backticks AND literal asterisks — the same `**bold**` at the start of
   * another line rendered fine, so the backticks are what break the rest of the
   * line. Feishu has no inline code; the backticks are pure loss.
   */
  assert.equal(normalizeInline('行内：`code` · **加粗**'), '行内：code · **加粗**')
  assert.equal(normalizeInline('用 `npm test` 跑'), '用 npm test 跑')
  // Inside a fence it is different: there the backticks are content.
  const elements = toElements('```bash\necho "`x`"\n```')
  assert.match(elements[0].content, /echo "`x`"/)
})

test('code fences survive untouched, even when they contain markdown', () => {
  const markdown = ['看这个：', '```bash', '# 这是注释，不是标题', 'echo "**不要动**"', '```', '结束'].join('\n')
  const blocks = splitBlocks(markdown)
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['markdown', 'code', 'markdown'],
  )
  assert.equal(blocks[1].language, 'bash')
  assert.match(blocks[1].text, /# 这是注释，不是标题/)
  // A comment inside a shell snippet must not be turned into bold by the normalizer.
  const elements = toElements(markdown)
  const code = elements.find((e) => e.tag === 'markdown' && e.content.startsWith('```'))
  assert.notEqual(code, undefined, 'the fence is still a fence')
  assert.match(code.content, /# 这是注释，不是标题/)
})

test('a markdown table becomes a native Feishu table element', () => {
  const markdown = ['| 任务 | 状态 |', '| --- | --- |', '| task-1 | 进行中 |', '| task-2 | 完成 |'].join('\n')
  const elements = toElements(markdown)
  assert.equal(elements.length, 1)
  assert.equal(elements[0].tag, 'table')
  assert.equal(elements[0].columns.length, 2)
  assert.deepEqual(elements[0].columns.map((c) => c.display_name), ['任务', '状态'])
  assert.deepEqual(elements[0].rows, [{ c0: 'task-1', c1: '进行中' }, { c0: 'task-2', c1: '完成' }])
  // A pipe line that is NOT a table (no separator row) stays markdown.
  assert.equal(toElements('| 只是一行竖线 |').length, 1)
  assert.equal(toElements('| 只是一行竖线 |')[0].tag, 'markdown')
})

test('horizontal rules become the native element instead of three dashes', () => {
  const elements = toElements('上面\n\n---\n\n下面')
  assert.deepEqual(elements.map((e) => e.tag), ['markdown', 'hr', 'markdown'])
})

test('a card is only built when there is something to render', () => {
  assert.equal(answerCard(''), null)
  assert.equal(answerCard('   \n  '), null)

  // Plain prose does not need card chrome…
  assert.equal(shouldRenderAsCard('好的，我这就去看。'), false)
  // …while anything with formatting, code or a list does.
  assert.equal(shouldRenderAsCard('**重点**：看这里'), true)
  assert.equal(shouldRenderAsCard('用 `npm test` 跑一下'), true)
  assert.equal(shouldRenderAsCard('- 第一\n- 第二'), true)
  assert.equal(shouldRenderAsCard('> 引用'), true)
  assert.equal(shouldRenderAsCard('# 标题'), true)
  assert.equal(shouldRenderAsCard('| a | b |\n| --- | --- |\n| 1 | 2 |'), true)
  assert.equal(shouldRenderAsCard('x'.repeat(300)), true, 'a long answer is easier to read as a card')
})

test('the card payload is what the Feishu API expects', () => {
  const card = answerCard('**完成**\n\n用这个命令：\n\n```bash\nnpm test\n```', { header: '飞书 · AAB' })
  assert.equal(card.msg_type, 'interactive')
  assert.equal(card.card.config.wide_screen_mode, true)
  assert.equal(card.card.header.title.content, '飞书 · AAB')
  assert.equal(card.truncated, false)
  assert.deepEqual(card.card.elements.map((e) => e.tag), ['markdown', 'markdown'])
  // The prose before the fence is one markdown element; a leading `**完成**`
  // surviving verbatim is what matters (bold must NOT be stripped).
  assert.match(card.card.elements[0].content, /^\*\*完成\*\*/)
  assert.match(card.card.elements[1].content, /```bash\nnpm test\n```/)
})

test('an over-long answer is cut on a line boundary and says so', () => {
  const long = Array.from({ length: 2000 }, (_, i) => '第 ' + i + ' 行：' + 'x'.repeat(30)).join('\n')
  const card = answerCard(long)
  assert.equal(card.truncated, true)
  const text = card.card.elements.map((e) => e.content ?? '').join('\n')
  assert.match(text, /已截断/)
  assert.ok(Buffer.byteLength(JSON.stringify(card.card), 'utf8') < CARD_CONTENT_LIMIT * 2, 'and the payload stays deliverable')
})

test('the plain-text fallback drops the markers instead of shipping them', () => {
  const plain = stripMarkdown('## 状态\n> 引用\n- 项一\n**加粗** 和 `代码` 与 [链接](https://x.test)\n```\ncode line\n```')
  assert.equal(/[#>*`]/.test(plain.replace(/•/g, '')), false, 'no raw markdown punctuation survives: ' + JSON.stringify(plain))
  assert.match(plain, /状态/)
  assert.match(plain, /加粗 和 代码 与 链接 \(https:\/\/x\.test\)/)
  assert.match(plain, /code line/)
})
