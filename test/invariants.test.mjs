/*
 * 跨文件的规矩，放在一个文件里钉住。
 *
 * 这里的两条都不是"某个函数的返回值对不对"，而是**顺序**与**唯一写法**：
 *
 *   ① 准入（群在不在册）必须发生在**任何副作用之前** —— 它是"要不要收"，
 *      判重是"收过没有"，前者在外层。写反了的后果不是脏数据那么轻：
 *      把群加进白名单之后，飞书重投的那条消息会被判成"重复"而永远进不了流水线
 *      （R1.5）。
 *   ② 租约的状态只能由**领域函数**改（R5.7）。以前 `tools.js` 里有四处手写
 *      `store.put('lease', { ...lease, state: 'returned' })`，于是"什么原因对应什么状态"
 *      这件事散在调用点上，改一处忘一处就会让 `state` 与 `release_reason` 对不上。
 *
 * 两条都**在真实入站路径上验**（真 `apply()`，只有飞书那一半是假的，一条长连接都不拨），
 * 而不是把逻辑复制一份到测试里 —— 复制的测试测的是复制品。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { fileURLToPath } from 'node:url'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const BOT_OPEN_ID = 'ou_bot'

/* ------------------------------------------------------------------ *
 * 一个最小上下文 + 一个假客户端 + 一个真控制器（与 test/reaction.test.mjs 同形）
 * ------------------------------------------------------------------ */

function fakeCtx() {
  const effects = []
  return {
    effects,
    tools: { register: () => () => {} },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on: () => () => {},
    get: () => undefined,
  }
}

function fakeClient() {
  const calls = []
  return {
    calls,
    ready: true,
    appId: 'cli_x',
    async call(path, init) {
      calls.push({ path, method: init?.method })
      return { ok: true, code: 0, data: {} }
    },
    async download() {
      return { ok: true, code: 0, contentType: 'image/png', bytes: Buffer.from('PNGDATA') }
    },
  }
}

async function mount(dir, feishu = {}) {
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  await team.apply(ctx, {
    dataDir: dir,
    workspace: join(dir, 'ws'),
    tickIntervalMs: 0,
    bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }],
    feishu: { mode: 'off', appId: 'cli_x', appSecret: 's', ...feishu },
  })
  const controller = team.feishuSeam
  const client = fakeClient()
  controller.state.client = client
  controller.state.clients.set('cli_x', client)
  // 让 `addressed` 在 mode 'off' 下也算得出来（只说"机器人是谁"）。
  controller.state.connectionPool = { botOpenIdFor: () => BOT_OPEN_ID }
  return { team, ctx, controller, client }
}

let sequence = 0

/** 一条 `im.message.receive_v1`（结构性 @，与飞书真实投递一致）。 */
function event(text, options = {}) {
  sequence += 1
  return {
    __appId: 'cli_x',
    event_id: options.eventId ?? 'ev_' + String(sequence),
    sender: { sender_id: { open_id: options.sender ?? 'ou_wang' }, sender_type: 'user' },
    message: {
      chat_id: options.chatId ?? 'oc_a',
      chat_type: 'group',
      message_id: options.messageId ?? 'om_' + String(sequence),
      message_type: 'text',
      content: JSON.stringify({ text: options.addressed === true ? '@_user_1 ' + text : text }),
      mentions: options.addressed === true ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: '机器人' }] : [],
      create_time: String(Date.now()),
    },
  }
}

/* ------------------------------------------------------------------ *
 * ① 准入在副作用之前
 * ------------------------------------------------------------------ */

test('不在准入范围内的群：连收件箱都不进、也不表态；加进白名单后同一条消息照样能进', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-invariants-'))
  try {
    const { ctx, controller, client } = await mount(dir, { requireRegisteredChat: true })
    try {
      const first = event('支付超时，需要自动重试三次', { chatId: 'oc_other', messageId: 'om_admission_1' })

      await controller.handleInbound(first)
      assert.equal(controller.state.inbox.all().length, 0, '不在册的群连收件箱都不该进（那是副作用）')
      assert.equal(client.calls.length, 0, '不处理的群也不该收到回执/表态')

      /*
       * 把它登记进这台机器人的群列表里 —— 就是面板上点一下的那件事。
       * 配置对象是**活的**（面板保存就地重载），所以这里改的就是生效的那份。
       */
      controller.config.bots[0].feishu.chats.push('oc_other')

      // 飞书重投同一条事件（同一个 event_id / message_id）。
      await controller.handleInbound(first)
      assert.equal(
        controller.state.inbox.all().length,
        1,
        '登记之后同一条消息必须能进流水线 —— 以前准入排在认领后面，这里会被判成"重复"而永远进不来',
      )
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * ② 租约只能由领域函数改
 * ------------------------------------------------------------------ */

/** 走一遍 lib/ 下所有 .js（`domain/` 除外）。 */
function jsFilesExcept(dir, skip) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (statSync(full).isDirectory()) {
      if (entry.name === skip) continue
      out.push(...jsFilesExcept(full, skip))
      continue
    }
    if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('租约对象不许手写：`store.put(\'lease\', { … })` 在 lib/ 里一处都不许有（domain 除外）', () => {
  /*
   * 判据取"手写的对象字面量"，因为那就是语义分叉的入口：
   *   ✅ store.put('lease', releaseLease(lease, 'reassigned').lease)   —— 状态由领域函数决定
   *   ✅ store.put('lease', noticeLeaseExpiry(lease))                   —— 同上
   *   ❌ store.put('lease', { ...lease, state: 'released', release_reason: 'reassigned' })
   *
   * 用正则扫而不是靠人记：这条规矩以前就悄悄破了四处。
   */
  const offenders = []
  for (const file of jsFilesExcept(LIB, 'domain')) {
    const text = readFileSync(file, 'utf8')
    if (/store\.put\(\s*'lease'\s*,\s*\{/.test(text)) offenders.push(relative(LIB, file))
  }
  assert.deepEqual(offenders, [], '这些文件在手写租约对象，请改为 releaseLease / returnLease / noticeLeaseExpiry')
})
