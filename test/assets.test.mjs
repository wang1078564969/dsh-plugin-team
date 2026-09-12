/*
 * 入站非文本内容：富文本（`post`）→ markdown、图片/文件落库 + `asset://` 引用 + 回执、
 * 以及 **event_id 去重键 + 保留窗口**（设计 04 §4.1 与 §9）。
 *
 * 这一组用例钉的是三件"看起来能用、其实在丢信息"的事：
 *
 *   1. `post` 以前读出来是空字符串 —— 别人精心排版的说明在插件看来等于没说话；
 *   2. 图片以前落库但**没有引用**，等于事后谁也取不回来（`image_key` 只在消息范围内有效）；
 *   3. 去重以前只认 `message_id`，而设计写明权威键是 `event_id`（重投时前者会变）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { assetIdOf, assetId, classifyAsset, createAssetStore, humanSize, safeFileName } from '../lib/assets.js'
import {
  normalizeMessage,
  resourcesOf,
  rewriteAssetRefs,
  richTextToMarkdown,
} from '../lib/feishu/connection.js'
import { Inbox, createIngest } from '../lib/feishu/ingest.js'
import { loadConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'

/* ------------------------------------------------------------------ *
 * 富文本
 * ------------------------------------------------------------------ */

test('富文本 post 转成 markdown：段落、链接、@人、图片占位都保留', () => {
  const post = {
    title: '支付重试',
    content: [
      [
        { tag: 'text', text: '看这个 ' },
        { tag: 'a', text: '设计文档', href: 'https://x/doc' },
        { tag: 'at', user_id: 'ou_bot' },
      ],
      [{ tag: 'text', text: '要点：' }],
      [{ tag: 'img', image_key: 'img_1' }],
      [{ tag: 'at', user_id: 'ou_zhang' }, { tag: 'text', text: ' 这块你接手' }],
    ],
  }
  const mentions = [
    { key: '@_user_1', name: '需求机器人', id: { open_id: 'ou_bot' } },
    { key: '@_user_2', name: '张三', id: { open_id: 'ou_zhang' } },
  ]
  const md = richTextToMarkdown(post, mentions, 'ou_bot')
  assert.match(md, /^\*\*支付重试\*\*/)
  assert.match(md, /看这个 \[设计文档\]\(https:\/\/x\/doc\)/)
  assert.equal(md.includes('@需求机器人'), false, '机器人自己的 @ 是"在叫它"，不是内容')
  assert.match(md, /@张三 这块你接手/)
  assert.match(md, /!\[图片\]\(asset-ref:img_1\)/, '图片先留占位，落库之后才换成真引用')
  assert.equal(md.includes('ou_bot'), false, '不该出现 open_id')
})

test('富文本里的未知 tag 不吞掉整段：有 text 就留着', () => {
  const md = richTextToMarkdown({ content: [[{ tag: 'future_tag', text: '新类型' }, { tag: 'text', text: '正文' }]] }, [], '')
  assert.equal(md, '新类型正文')
  // 没有 text 的未知 tag：丢掉它，但不影响别的段落。
  assert.equal(richTextToMarkdown({ content: [[{ tag: 'x' }], [{ tag: 'text', text: '还在' }]] }, [], ''), '还在')
})

test('resourcesOf 把富文本深处的图片与顶层附件都找出来', () => {
  assert.deepEqual(resourcesOf('image', { image_key: 'img_a' }), [{ kind: 'image', key: 'img_a' }])
  assert.deepEqual(resourcesOf('file', { file_key: 'f_a', file_name: '报告.pdf' }), [
    { kind: 'file', key: 'f_a', name: '报告.pdf' },
  ])
  const post = { content: [[{ tag: 'text', text: 'x' }], [{ tag: 'img', image_key: 'img_b' }], [{ tag: 'file', file_key: 'f_b', file_name: 'a.go' }]] }
  assert.deepEqual(resourcesOf('post', post), [
    { kind: 'image', key: 'img_b' },
    { kind: 'file', key: 'f_b', name: 'a.go' },
  ])
  assert.deepEqual(resourcesOf('text', { text: 'hi' }), [], '纯文本没有资源，不是"没看懂"')
})

test('normalizeMessage：post 有正文、图片没有正文但有资源、事件 id 被带上', () => {
  const post = normalizeMessage({
    event_id: 'ev_1',
    message: {
      chat_id: 'oc_a', chat_type: 'group', message_id: 'om_1', message_type: 'post',
      content: JSON.stringify({ title: '说明', content: [[{ tag: 'text', text: '正文在这里' }]] }),
      mentions: [],
    },
    sender: { sender_id: { open_id: 'ou_user' } },
  })
  assert.equal(post.text, '**说明**\n\n正文在这里')
  assert.equal(post.messageType, 'post')
  assert.equal(post.eventId, 'ev_1')

  const image = normalizeMessage({
    message: { chat_id: 'oc_a', message_id: 'om_2', message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }) },
    sender: { sender_id: { open_id: 'ou_user' } },
  })
  assert.equal(image.text, '', '图片没有正文')
  assert.deepEqual(image.resources, [{ kind: 'image', key: 'img_1' }])

  assert.equal(
    normalizeMessage({ message: { chat_id: 'oc_a', message_id: 'om_3', message_type: 'text', content: '{"text":"hi"}' }, sender: {} }).eventId,
    null,
    '没有 event_id 就是 null，不编一个',
  )
})

/* ------------------------------------------------------------------ *
 * 资产落库
 * ------------------------------------------------------------------ */

test('资产落库：路径安全、id 稳定、重复不存第二份、空内容拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-assets-'))
  try {
    const store = createAssetStore({ dataDir: dir })
    const first = store.save({
      messageId: 'om_1', chatId: 'oc_a', fileKey: 'img_1',
      name: '../../etc/passwd', contentType: 'image/png', bytes: Buffer.from([1, 2, 3, 4]),
    })
    assert.equal(first.ok, true)
    assert.equal(first.ref.startsWith('asset://'), true)
    // 路径穿越必须被拦住：文件名里的 `/` 与 `..` 都不能带进路径。
    assert.equal(first.record.name.includes('..'), false, '名字里不留 `..`：' + first.record.name)
    assert.equal(first.record.path.startsWith(store.root), true, '落点必须还在 assets 目录里')
    assert.equal(first.record.path.includes('/../'), false)
    assert.equal(store.get(first.ref).exists, true, '落库之后文件真的在盘上')

    const again = store.save({ messageId: 'om_1', chatId: 'oc_a', fileKey: 'img_1', bytes: Buffer.from([9]) })
    assert.equal(again.duplicate, true)
    assert.equal(again.id, first.id)
    assert.equal(store.count(), 1, '同一条消息的同一个 key 不存第二份')

    const empty = store.save({ messageId: 'om_2', fileKey: 'img_2', bytes: Buffer.alloc(0) })
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'empty')
    assert.equal(store.get('asset://unknown'), null, '没落库的引用查出来是 null，不是"有一个空文件"')

    // 索引是人能 tail 的：一行一个资产，原样可读。
    const lines = readFileSync(store.indexFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).ref, first.ref)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assetId 稳定、safeFileName 兜底、classifyAsset 认得出能进上下文的类型', () => {
  assert.equal(assetId('om_1', 'img_1'), assetId('om_1', 'img_1'))
  assert.notEqual(assetId('om_1', 'img_1'), assetId('om_2', 'img_1'))
  assert.equal(assetIdOf('asset://abc'), 'abc')
  assert.equal(assetIdOf('https://x'), null, '别的 scheme 不归它管')
  assert.equal(safeFileName('', 'image.png'), 'image.png')
  assert.equal(safeFileName('a/b\\c.txt'), 'a_b_c.txt')
  assert.equal(classifyAsset('main.go'), 'code')
  assert.equal(classifyAsset('README.md'), 'doc')
  assert.equal(classifyAsset('data.csv'), 'data')
  assert.equal(classifyAsset('chart', 'image/png'), 'image')
  assert.equal(classifyAsset('mystery.bin'), 'binary', '认不出也照样落库')
  assert.equal(humanSize(512), '512 B')
  assert.equal(humanSize(2048), '2.0 KB')
})

test('rewriteAssetRefs：落库的换成真引用，没落库的保留占位（不指向空气）', () => {
  const text = '看这个 ![图片](asset-ref:img_1) 和这个 ![图片](asset-ref:img_2)'
  const out = rewriteAssetRefs(text, (key) => (key === 'img_1' ? 'asset://good' : null))
  assert.equal(out, '看这个 ![图片](asset://good) 和这个 ![图片](asset-ref:img_2)')
})

/* ------------------------------------------------------------------ *
 * 入站流水线：非文本 + event_id 去重
 * ------------------------------------------------------------------ */

function makeIngest(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-inbound-asset-'))
  const config = loadConfig({ dataDir: dir, tickIntervalMs: 0, bots: [], feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' } })
  const store = new Store(dir).load()
  const inbox = new Inbox(dir).load()
  const replies = []
  const ingest = createIngest({
    config,
    store,
    inbox,
    // 没有分诊/提取模块：这一条测的是"非文本消息不进分诊"，不是建单。
    triage: null,
    extract: null,
    client: null,
    cards: null,
    log: { error: () => {}, warn: () => {} },
    reply: async (chatId, text, spec) => { replies.push({ chatId, text, spec }) },
    ...options,
  })
  return { dir, config, store, inbox, ingest, replies, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('图片消息：记账 + 分诊结论「asset」+ 不进分诊（没有正文可判）', async () => {
  const world = makeIngest()
  try {
    const result = await world.ingest.onMessage(
      { chatId: 'oc_a', chatType: 'group', messageId: 'om_img', messageType: 'image', text: '', at: '2026-09-12T10:00:00.000Z', sender: 'ou_user', eventId: 'ev_img' },
      { recorded_by: 'req', assets: [{ ref: 'asset://a1', kind: 'image', class: 'image', name: 'p.png', bytes: 2048 }] },
    )
    assert.equal(result.kind, 'asset')
    const doc = world.inbox.get('om_img')
    assert.equal(doc.triage_kind, 'asset')
    assert.match(doc.ignored_reason, /已落库为资产/)
    assert.equal(doc.event_id, 'ev_img')
    assert.equal(doc.dedupe_key, 'ev_img', '去重键是 event_id')
    assert.deepEqual(doc.assets, [{ ref: 'asset://a1', kind: 'image', class: 'image', name: 'p.png', bytes: 2048 }])
  } finally {
    world.cleanup()
  }
})

test('event_id 是权威去重键：重投（message_id 变了）仍然只处理一次', async () => {
  const world = makeIngest()
  try {
    const base = { chatId: 'oc_a', chatType: 'group', text: '重试这块要不要加？', at: '2026-09-12T10:00:00.000Z', sender: 'ou_user', eventId: 'ev_same' }
    const first = await world.ingest.onMessage({ ...base, messageId: 'om_first' })
    assert.equal(first.skipped, undefined)
    // 飞书重投：同一条消息、新的 message_id、同一个 event_id。
    const replayed = await world.ingest.onMessage({ ...base, messageId: 'om_second' })
    assert.equal(replayed.skipped, 'duplicate')
    assert.equal(replayed.dedupe_key, 'event_id')
    assert.equal(replayed.duplicate_of, 'om_first', '能说清重投的是哪一条')
    assert.equal(world.inbox.all().length, 1, '重投没有进收件箱')
    // message_id 相同的重复也照旧拦住（旧记录的兜底路径）。
    const same = await world.ingest.onMessage({ ...base, messageId: 'om_first', eventId: null })
    assert.equal(same.skipped, 'duplicate')
    assert.equal(same.dedupe_key, 'message_id')
  } finally {
    world.cleanup()
  }
})

test('保留窗口：窗口外的消息被清掉，文件与索引同时收缩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-retention-'))
  try {
    const inbox = new Inbox(dir).load()
    inbox.record({ message_id: 'om_old', event_id: 'ev_old', create_time: '2026-01-01T00:00:00.000Z', chat_id: 'oc_a' })
    inbox.record({ message_id: 'om_new', event_id: 'ev_new', create_time: '2026-09-12T00:00:00.000Z', chat_id: 'oc_a' })
    const pruned = inbox.prune({ retentionDays: 30, now: new Date('2026-09-12T12:00:00.000Z') })
    assert.equal(pruned.removed, 1)
    assert.equal(pruned.kept, 1)
    assert.equal(inbox.seen('om_old'), false)
    assert.equal(inbox.seenEvent('ev_old'), null, '事件索引也跟着清')
    assert.equal(inbox.all().length, 1)
    assert.equal(readFileSync(inbox.path, 'utf8').trim().split('\n').length, 1)

    // 窗口 0 = 不清理（"我要留着"是一个合法选择）。
    assert.deepEqual(inbox.prune({ retentionDays: 0 }).removed, 0)
    // 时间读不出来的记录不删：宁可留一条旧的，也不要因为格式问题让去重失效。
    inbox.record({ message_id: 'om_bad_time', create_time: '不是时间', chat_id: 'oc_a' })
    assert.equal(inbox.prune({ retentionDays: 1, now: new Date('2026-09-12T12:00:00.000Z') }).removed, 0)
    assert.equal(inbox.seen('om_bad_time'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('保留窗口是配置项，默认 30 天', () => {
  assert.equal(loadConfig({}).feishu.dedupeRetentionDays, 30)
  assert.equal(loadConfig({ feishu: { dedupeRetentionDays: 7 } }).feishu.dedupeRetentionDays, 7)
  assert.equal(loadConfig({ feishu: { dedupeRetentionDays: 'abc' } }).feishu.dedupeRetentionDays, 30, '非法值退回默认')
})
