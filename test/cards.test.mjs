/*
 * 飞书卡片层测试（node:test + node:assert/strict，零依赖，零网络）。
 *
 * 覆盖来源：
 *   - hub/test/messages.test.ts —— 标题**逐个保留**，共 17 例
 *     （渲染 5 例 + 降级链 5 例 + 引用回复/原地更新 2 例 + 杂项 3 例
 *      + 表格/超宽/卡片 JSON 等已在渲染节内）
 *   - 本次移植新增：
 *     · 五级链的每一级都能**单独取出**并单独发送（顺序不许变）
 *     · `via` / `attempts` 被如实记录（含全链路失败时的四个 variant）
 *     · 超长内容截断成附件（第 5 级）——hub 里这一级「交给调用方」，
 *       纯函数版必须自己给出附件形态
 *     · 按钮 value 的字段集合（action/object/id/actor/expect/nonce/expires_at）
 *     · 飞书原生 payload 形状（msg_type/content 可直接 POST）与 uuid ≤ 50 字符
 *
 * 与 hub 用例的差异只有一处，且是**故意**的：
 *   hub 的「第一级成功」「表格被拒」等用例断言的是 `sendCard()` 打了哪几个
 *   网络请求；这里没有 FeishuClient，所以断言的是等价的 payload 序列
 *   （`degradationLadder()` + `deliverCard()` 的假 client 各测一遍）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CARD_MAX_BYTES,
  FILE_THRESHOLD_BYTES,
  MAX_TABLE_ELEMENTS,
  atLineAsText,
  buildCardJson,
  cleanCell,
  buildCardPayload,
  degradationLadder,
  deliverCard,
  deliverText,
  fileTypeOf,
  newMessageId,
  renderCardAsMarkdown,
  renderTableAsText,
  toFeishuCard,
  truncateUtf8,
  utf8Bytes,
} from '../lib/feishu/cards.js'

/* ------------------------------------------------------------------ *
 * 假的飞书客户端：按脚本回应，并记录每次请求
 * ------------------------------------------------------------------ */

function fakeClient(script) {
  const calls = []
  const queue = [...script]
  const client = {
    async request(method, path, body) {
      calls.push({ method, path, body })
      const next = queue.shift() ?? { code: 0, data: { message_id: `om_${calls.length}` } }
      if (next.throw !== undefined) throw new Error(next.throw)
      return {
        code: next.code ?? 0,
        msg: next.msg ?? 'ok',
        data: next.data ?? { message_id: `om_${calls.length}` },
        request_id: 'req-1',
      }
    },
  }
  return { client, calls, remaining: () => queue.length }
}

/** 取出第 n 次调用发出去的卡片 JSON */
function cardOf(call) {
  assert.ok(call !== undefined, '应该有这次调用')
  const body = call.body
  return JSON.parse(body.content ?? '{}')
}

const SAMPLE = {
  title: '支付线开发机器人',
  anchor: 'req-2026-014',
  status: '🟡 开发中 · 负责人 @张三',
  confirm_line: '✅ 需求已确认 · ⏳ 待开发确认',
  blocks: [
    { kind: 'markdown', content: '正在实现重试与退避。' },
    {
      kind: 'table',
      table: {
        headers: ['文件', '大小', '说明'],
        rows: [
          ['retry.ts', '3 KB', '重试策略'],
          ['backoff.ts', '1 KB', '退避序列'],
        ],
        align: ['left', 'right', 'left'],
      },
    },
    {
      kind: 'buttons',
      buttons: [
        { label: '接受', action: 'task.accept', value: { task_id: 'task-8891' }, type: 'primary' },
        { label: '拒绝', action: 'task.reject', value: { task_id: 'task-8891' }, type: 'danger' },
      ],
    },
  ],
  footer: '⏱ 2m14s · 🧠 12.3k tok',
}

/** 五级链的级别名，与 hub 的 DeliveryVariant 逐字一致 */
const VARIANTS = ['card', 'card-plain-table', 'card-no-buttons', 'text', 'text-with-file']

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

test('表格降级为等宽文本，保留对齐与列宽', () => {
  const text = renderTableAsText({
    headers: ['文件', '大小'],
    rows: [
      ['retry.ts', '3 KB'],
      ['backoff.ts', '1 KB'],
    ],
    align: ['left', 'right'],
  })
  const lines = text.split('\n')
  assert.equal(lines.length, 4, '表头 + 分隔线 + 两行')
  assert.ok(lines[0]?.startsWith('文件'))
  assert.ok(lines[0]?.trimEnd().endsWith('大小'))
  assert.ok(lines[1]?.includes('---'))
  // 右对齐：数字列应贴右侧
  assert.ok(lines[2]?.trimEnd().endsWith('3 KB'))
})

test('超宽单元格被裁剪，不会把卡片撑爆', () => {
  const long = 'x'.repeat(200)
  const text = renderTableAsText({ headers: ['说明'], rows: [[long]] }, 20)
  assert.ok(text.includes('…'), '应出现省略号')
  for (const line of text.split('\n')) assert.ok(line.length <= 40, `行太长: ${line.length}`)
})

test('卡片渲染成 markdown：状态行、确认行、表格、按钮、页脚都在', () => {
  const md = renderCardAsMarkdown(SAMPLE, { buttons: true })
  assert.ok(md.includes('🟡 开发中'))
  assert.ok(md.includes('✅ 需求已确认'))
  assert.ok(md.includes('```'), '表格应降级为代码块')
  assert.ok(md.includes('[接受]'))
  assert.ok(md.includes('task.accept'), '要有文本兜底指令')
  assert.ok(md.includes('⏱ 2m14s'))
})

test('去掉按钮时，按钮变成"回复动作名"的文本指令', () => {
  const md = renderCardAsMarkdown(SAMPLE, { buttons: false })
  assert.ok(!md.includes('[接受]'))
  assert.ok(md.includes('回复 `task.accept`'))
})

test('卡片 JSON：header 带锚点，表格用原生组件，按钮 value 带 action', () => {
  const card = JSON.parse(buildCardJson(SAMPLE))
  assert.equal(card.header.title.content, '支付线开发机器人')
  assert.equal(card.header.subtitle.content, 'req-2026-014')

  const table = card.elements.find((e) => e.tag === 'table')
  assert.ok(table !== undefined, '应有原生表格组件')
  const buttons = card.elements.find((e) => e.tag === 'action')
  assert.equal(buttons.actions[0]?.value.action, 'task.accept')
  assert.equal(buttons.actions[0]?.value.task_id, 'task-8891')
})

test('footer note 在原生卡片上也渲染出来（以前只有文本降级里有）', () => {
  const card = JSON.parse(buildCardJson(SAMPLE))
  const note = card.elements[card.elements.length - 1]
  assert.equal(note.tag, 'note', 'footer 是最后一段灰字')
  assert.equal(note.elements[0].content, '⏱ 2m14s · 🧠 12.3k tok')
  // 没有 footer 时不多出一个空 note。
  const bare = JSON.parse(buildCardJson({ title: 't', blocks: [{ kind: 'markdown', content: 'x' }] }))
  assert.equal(bare.elements.length, 1)
  assert.equal(bare.elements.some((e) => e.tag === 'note'), false)
})

test('表格单元格先清理再渲染：换行、制表符、竖线都不会破坏表格', () => {
  const table = {
    headers: ['文件', '说明'],
    rows: [
      ['retry.ts\n（新增）', '第一行 | 第二行'],
      ['back\toff.ts', 'ok'],
    ],
  }
  // 等宽文本：一行还是_两_行（表头 + 分隔线 + 两行数据），没有被换行拆散。
  const text = renderTableAsText(table)
  assert.equal(text.split('\n').length, 4)
  assert.match(text, /retry\.ts （新增）/)
  assert.match(text, /第一行 \\?\| 第二行/, '竖线被转义，不再被当作列分隔符')

  // 原生卡片：单元格里没有换行/制表符，竖线保持转义后的样子。
  const rows = toFeishuCard({ title: 't', blocks: [{ kind: 'table', table }] }).card.elements[0].rows
  assert.equal(rows[0].c0, 'retry.ts （新增）')
  assert.equal(rows[0].c1, '第一行 \\| 第二行')
  assert.equal(rows[1].c0, 'back off.ts')
  assert.equal(cleanCell(null), '')
  assert.equal(cleanCell(42), '42')
})

test('@人：卡片用 <at id>，纯文本降级自动换成 <at user_id>（两种语法不通用）', () => {
  const spec = {
    title: 't',
    status: '🟡 开发中',
    at_line: '<at id=ou_zhang></at> 这块等你确认',
    blocks: [{ kind: 'markdown', content: '正文' }],
  }
  // 卡片：真的会通知人的那种写法。
  const elements = JSON.parse(buildCardJson(spec)).elements
  assert.equal(elements[1].content, '<at id=ou_zhang></at> 这块等你确认')
  // 纯文本降级（4/5 级都用它当内容源）：语法必须换，否则人收不到通知。
  const text = renderCardAsMarkdown(spec)
  assert.match(text, /<at user_id="ou_zhang"><\/at> 这块等你确认/)
  assert.equal(/<at id=/.test(text), false)
  assert.equal(atLineAsText('<at id=ou_a></at> <at id=ou_b></at>'), '<at user_id="ou_a"></at> <at user_id="ou_b"></at>')
  assert.equal(atLineAsText('没有标签'), '没有标签')
})

test('超过 5 个表格组件时，多出来的降级为文本（飞书的硬限制）', () => {
  const table = { headers: ['a'], rows: [['1']] }
  const many = {
    title: 't',
    blocks: Array.from({ length: MAX_TABLE_ELEMENTS + 3 }, () => ({ kind: 'table', table })),
  }
  const card = JSON.parse(buildCardJson(many))
  const native = card.elements.filter((e) => e.tag === 'table').length
  assert.equal(native, MAX_TABLE_ELEMENTS)
  assert.equal(card.elements.length, MAX_TABLE_ELEMENTS + 3, '其余仍是元素，只是变成 markdown')
})

/* ------------------------------------------------------------------ *
 * 约定好的两个接口：toFeishuCard / degradationLadder
 * ------------------------------------------------------------------ */

test('toFeishuCard(spec) 返回飞书原生卡片：{ msg_type, card }', () => {
  const out = toFeishuCard(SAMPLE)
  assert.deepEqual(Object.keys(out).sort(), ['card', 'msg_type'])
  assert.equal(out.msg_type, 'interactive')
  assert.equal(out.card.config.wide_screen_mode, true)
  assert.equal(out.card.header.template, 'blue')
  assert.equal(out.card.header.title.content, '支付线开发机器人')
  // 对象视图与字符串视图必须是同一份 JSON
  assert.equal(JSON.stringify(out.card), buildCardJson(SAMPLE))
})

test('degradationLadder 是有序的五个级别，一级不少、顺序不变', () => {
  const ladder = degradationLadder(SAMPLE)
  assert.equal(ladder.length, 5)
  assert.deepEqual(
    ladder.map((item) => item.level),
    [1, 2, 3, 4, 5],
  )
  assert.deepEqual(
    ladder.map((item) => item.via),
    VARIANTS,
  )
})

test('五级链的每一级都能被单独取出并发送（内容不因取用方式而变）', () => {
  for (const item of degradationLadder(SAMPLE)) {
    const payload = buildCardPayload(SAMPLE, item.via)
    assert.deepEqual(payload, item.payload, `${item.via} 单独构造应与链上一致`)
    // payload 就是飞书 API 的请求体：msg_type + content 都在，且 content 是合法 JSON
    assert.ok(typeof payload.msg_type === 'string' && payload.msg_type !== '')
    assert.doesNotThrow(() => JSON.parse(payload.content), `${item.via} 的 content 应是合法 JSON`)
  }
})

test('前三级是卡片、后两级是文本；表格与按钮逐级变少', () => {
  const ladder = degradationLadder(SAMPLE)
  assert.deepEqual(
    ladder.map((item) => item.payload.msg_type),
    ['interactive', 'interactive', 'interactive', 'text', 'text'],
  )
  const countTags = (payload, tag) =>
    JSON.parse(payload.content).elements.filter((e) => e.tag === tag).length
  assert.equal(countTags(ladder[0].payload, 'table'), 1, '第 1 级有原生表格')
  assert.equal(countTags(ladder[0].payload, 'action'), 1, '第 1 级有按钮')
  assert.equal(countTags(ladder[1].payload, 'table'), 0, '第 2 级表格拍平成文本')
  assert.equal(countTags(ladder[1].payload, 'action'), 1, '第 2 级仍保留按钮')
  assert.equal(countTags(ladder[2].payload, 'action'), 0, '第 3 级去按钮改文本指令')
  assert.ok(ladder[2].payload.content.includes('回复 `task.accept`'), '去按钮要留文本兜底')
  assert.ok(ladder[3].payload.content.includes('task.accept'), '第 4 级纯文本仍带动作名')
})

test('每一级的 payload 都带幂等键，且不超过飞书的 50 字符上限', () => {
  for (const item of degradationLadder(SAMPLE)) {
    assert.ok(typeof item.payload.uuid === 'string' && item.payload.uuid.length > 0, '每级都要有幂等键')
    assert.ok(item.payload.uuid.length <= 50, `${item.via} 的 uuid 太长: ${item.payload.uuid}`)
  }
})

/* ------------------------------------------------------------------ *
 * 第 5 级：超长内容落附件
 * ------------------------------------------------------------------ */

test('超长内容不会丢：第 5 级把正文截断成附件，并在摘要里说明完整版在哪', () => {
  const huge = '这是一段很长的正文。'.repeat(2000) // 约 54KB，远超第 4 级的体面上限
  const spec = {
    title: '📋 任务',
    anchor: 'task-8891',
    status: '🟡 进行中',
    blocks: [{ kind: 'markdown', content: huge }],
  }
  const ladder = degradationLadder(spec)
  const last = ladder[4].payload

  assert.equal(last.msg_type, 'text')
  assert.ok(last.file !== null, '第 5 级必须带附件，否则内容真的丢了')
  assert.equal(last.file.file_name, 'task-8891.md')
  assert.equal(last.file.file_type, 'stream', 'markdown 落 stream')
  assert.equal(last.file.truncated, true, '超长就该截断')
  assert.ok(last.file.bytes <= FILE_THRESHOLD_BYTES, `附件也不能超限: ${last.file.bytes}`)
  assert.ok(last.file.full_bytes > last.file.bytes, '要能看出原文多大')

  const summary = JSON.parse(last.content).text
  assert.ok(summary.includes('task-8891.md'), '摘要要指向附件')
  assert.ok(summary.includes('完整版见附件'), summary)
})

test('正文没超过阈值时附件照发但不截断（第 5 级也可独立使用）', () => {
  const spec = {
    title: '📋 任务',
    anchor: 'task-1',
    blocks: [{ kind: 'markdown', content: '短正文' }],
  }
  const last = degradationLadder(spec)[4].payload
  assert.equal(last.file.truncated, false)
  assert.equal(last.file.markdown, renderCardAsMarkdown(spec, { buttons: false }))
})

test('卡片 JSON 超过体积上限时按字节截断，仍然是合法 JSON', () => {
  const huge = 'x'.repeat(CARD_MAX_BYTES + 5_000)
  const spec = { title: 't', anchor: 'task-1', blocks: [{ kind: 'markdown', content: huge }] }
  const payload = degradationLadder(spec)[0].payload
  assert.ok(utf8Bytes(payload.content) <= CARD_MAX_BYTES, `卡片仍然超限: ${utf8Bytes(payload.content)}`)
  const card = JSON.parse(payload.content)
  assert.ok(card.elements.some((e) => e.content.includes('已截断')), '要说明被截断')
})

test('truncateUtf8 按字节截断，不会把多字节字符劈成乱码', () => {
  const text = '中'.repeat(100) // 300 字节
  const out = truncateUtf8(text, 100, '…')
  assert.ok(utf8Bytes(out.text) <= 100)
  assert.equal(out.truncated, true)
  assert.ok(!out.text.includes('\uFFFD'), '不该出现替换字符')
  assert.equal(truncateUtf8('短', 100).truncated, false)
})

/* ------------------------------------------------------------------ *
 * 降级链：内容永远送得到
 * ------------------------------------------------------------------ */

test('第一级成功：走完整卡，不发第二次', async () => {
  const { client, calls } = fakeClient([{ code: 0, data: { message_id: 'om_1' } }])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE)
  assert.equal(result.ok, true)
  assert.equal(result.via, 'card')
  assert.equal(result.message_id, 'om_1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.path, '/im/v1/messages?receive_id_type=chat_id')
  assert.deepEqual(result.attempts, [])
})

test('表格被拒 → 自动拍平重试，仍算成功', async () => {
  const { client, calls } = fakeClient([
    { code: 230_099, msg: 'table not supported' },
    { code: 0, data: { message_id: 'om_2' } },
  ])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE)
  assert.equal(result.ok, true)
  assert.equal(result.via, 'card-plain-table')
  assert.equal(calls.length, 2)
  assert.deepEqual(result.attempts, [{ variant: 'card', error: 'table not supported' }])
  const second = cardOf(calls[1])
  assert.equal(second.elements?.toString().includes('table'), false, '第二次不应有原生表格')
})

test('卡片整体被拒 → 去按钮再试，最后退到纯文本', async () => {
  const { client, calls } = fakeClient([
    { code: 1, msg: 'bad card' },
    { code: 1, msg: 'bad card again' },
    { code: 1, msg: 'buttons rejected' },
    { code: 0, data: { message_id: 'om_text' } },
  ])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE)
  assert.equal(result.ok, true)
  assert.equal(result.via, 'text')
  assert.equal(calls.length, 4)
  assert.equal(calls[3]?.body && calls[3].body.msg_type, 'text')
  assert.equal(result.attempts.length, 3, '三次卡片尝试都留了记录')
})

test('全链路失败：五级都失败时如实报告，不假装成功', async () => {
  const { client, calls } = fakeClient([
    { code: 1, msg: 'e1' },
    { code: 1, msg: 'e2' },
    { code: 1, msg: 'e3' },
    { code: 1, msg: 'e4' },
    { code: 1, msg: 'e5' },
  ])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE)
  assert.equal(result.ok, false)
  assert.equal(result.via, 'text-with-file', '指示调用方走最后一级')
  assert.equal(calls.length, 5, '四级 + 第 5 级的正文摘要（附件另算）')
  assert.deepEqual(
    result.attempts.map((a) => a.variant),
    ['card', 'card-plain-table', 'card-no-buttons', 'text', 'text-with-file'],
  )
  assert.ok(result.file !== null && result.file !== undefined, '失败也要把附件交给调用方，内容不能丢')
})

test('网络异常也被降级链吃掉，不会把异常抛给上层', async () => {
  const { client } = fakeClient([{ throw: '网络异常: socket hang up' }, { code: 0, data: { message_id: 'om_ok' } }])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE)
  assert.equal(result.ok, true)
  assert.equal(result.via, 'card-plain-table')
  assert.equal(result.attempts[0]?.error, '网络异常: socket hang up')
})

test('全链路都抛异常时也如实报告失败（不把异常丢出去）', async () => {
  const { client, calls } = fakeClient([
    { throw: 'boom' },
    { throw: 'boom' },
    { throw: 'boom' },
    { throw: 'boom' },
    { throw: 'boom' },
  ])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE)
  assert.equal(result.ok, false)
  assert.equal(result.via, 'text-with-file')
  assert.equal(result.attempts.length, 5, '四级 + 第 5 级的摘要各失败一次')
  assert.equal(calls.length, 5)
})

/* ------------------------------------------------------------------ *
 * 引用回复与回退
 * ------------------------------------------------------------------ */

test('引用回复失败时自动退化为普通消息（不能让一条引用吞掉答案）', async () => {
  const { client, calls } = fakeClient([
    { code: 230_011, msg: 'message not found' },
    { code: 0, data: { message_id: 'om_plain' } },
  ])
  const result = await deliverText(client, { chat_id: 'oc_x', reply_to: 'om_gone' }, 'hello')
  assert.equal(result.ok, true)
  assert.equal(result.message_id, 'om_plain')
  assert.equal(calls.length, 2)
  assert.ok(String(calls[0]?.path).includes('/reply'))
  assert.equal(calls[1]?.path, '/im/v1/messages?receive_id_type=chat_id')
})

test('更新卡片走 PATCH，失败后按同一降级链重试', async () => {
  const { client, calls } = fakeClient([{ code: 1, msg: 'patch table failed' }, { code: 0, data: { message_id: 'om_9' } }])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE, { patchMessageId: 'om_9' })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'card-plain-table')
  assert.equal(calls[0]?.method, 'PATCH')
  assert.ok(String(calls[0]?.path).includes('/im/v1/messages/om_9'))
})

test('原地更新失败到底时退化为新发一条文本（而不是原地报错）', async () => {
  const { client, calls } = fakeClient([
    { code: 1, msg: 'p1' },
    { code: 1, msg: 'p2' },
    { code: 1, msg: 'p3' },
    { code: 0, data: { message_id: 'om_new' } },
  ])
  const result = await deliverCard(client, { chat_id: 'oc_x' }, SAMPLE, { patchMessageId: 'om_9' })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'text')
  assert.equal(calls[3]?.method, 'POST', '文本级不该再 PATCH')
})

/* ------------------------------------------------------------------ *
 * 按钮 value：字段集合与身份的铁律
 * ------------------------------------------------------------------ */

test('按钮 value 的字段集合是 action/object/id/actor/expect/nonce/expires_at', () => {
  const spec = {
    title: 't',
    blocks: [
      {
        kind: 'buttons',
        buttons: [
          {
            label: '接受',
            action: 'task.accept',
            value: {
              action: 'task.accept',
              object: 'task',
              id: 'task-8891',
              actor: 'ou_zhao',
              expect: 'human:zhao-dev',
              nonce: 'n-1',
              expires_at: '2026-03-01T10:00:00.000Z',
            },
          },
        ],
      },
    ],
  }
  const card = toFeishuCard(spec).card
  const button = card.elements[0].actions[0]
  assert.deepEqual(Object.keys(button.value).sort(), [
    'action',
    'actor',
    'expect',
    'expires_at',
    'id',
    'nonce',
    'object',
  ])
  // action 以按钮自身为准（即使 value 里漏写，渲染时也会补上）
  assert.equal(button.value.action, 'task.accept')
  assert.equal(button.text.content, '接受')
  assert.equal(button.type, 'default')
})

test('缺字段的按钮 value 不伪造身份：没有 actor/expect 就只有五个键', () => {
  const spec = {
    title: 't',
    blocks: [
      {
        kind: 'buttons',
        buttons: [
          { label: '批准', action: 'cfg.approve', value: { object: 'decision', id: 'adr-2026-001', nonce: 'n-2' } },
        ],
      },
    ],
  }
  const value = toFeishuCard(spec).card.elements[0].actions[0].value
  assert.deepEqual(Object.keys(value).sort(), ['action', 'id', 'nonce', 'object'])
})

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

test('消息幂等键不超过飞书的 50 字符上限', () => {
  for (let i = 0; i < 50; i += 1) {
    const id = newMessageId()
    assert.ok(id.length <= 50, `${id} 太长了`)
    assert.ok(id.startsWith('msg-'))
  }
})

test('文件类型按扩展名映射，未知落 stream', () => {
  assert.equal(fileTypeOf('report.pdf'), 'pdf')
  assert.equal(fileTypeOf('design.PPTX'), 'ppt')
  assert.equal(fileTypeOf('notes.md'), 'stream')
  assert.equal(fileTypeOf('data.csv'), 'stream')
})

test('每种降级级别都是已知枚举（可观测性依赖它）', () => {
  const variants = ['card', 'card-plain-table', 'card-no-buttons', 'text', 'text-with-file']
  assert.equal(new Set(variants).size, 5)
  assert.deepEqual(
    degradationLadder(SAMPLE).map((i) => i.via),
    variants,
  )
})

test('构造卡片不碰任何网络与全局（纯函数：同一输入两次调用结果相同）', () => {
  const before = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('构造阶段不该发网络请求')
  }
  try {
    const a = degradationLadder(SAMPLE)
    const b = degradationLadder(SAMPLE)
    assert.deepEqual(a, b)
    assert.equal(JSON.stringify(toFeishuCard(SAMPLE)), JSON.stringify(toFeishuCard(SAMPLE)))
  } finally {
    globalThis.fetch = before
  }
})

test('输入 spec 不被修改（纯函数不许改调用方的对象）', () => {
  const spec = structuredClone(SAMPLE)
  const snapshot = JSON.stringify(spec)
  degradationLadder(spec)
  toFeishuCard(spec)
  assert.equal(JSON.stringify(spec), snapshot)
})
