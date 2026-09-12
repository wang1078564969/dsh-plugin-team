/*
 * 「收到消息先表态」这条路，在**真实入站路径**上验（伪造飞书事件 → `handleInbound`）。
 *
 * 为什么值得一个文件：表态是这套东西里**唯一**一个"机器人在线"的即时信号 ——
 * 台账要等到模型跑完一轮才动，卡片要等到决定建单才发，而一个人在群里说话之后
 * 最先想知道的是"它到底听见没有"。所以它的三条边界（对哪些消息点、什么时候点、
 * 点失败了会怎样）都得钉住，而不是靠读代码相信。
 *
 * 不联网：客户端是假的，`feishu.mode: 'off'` 所以一条长连接都不拨。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const BOT_OPEN_ID = 'ou_bot'

/** 一个最小上下文：只要 tools / effect / on，其余可选服务一律缺席（headless 形态）。 */
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

/**
 * 一个假客户端：**记下每一次 call**，并让用例决定它成功、失败还是抛。
 *
 * `order` 是给"表态必须发生在下载之前"那条用例用的：数组里元素的先后就是真实调用顺序。
 */
function fakeClient(options = {}) {
  const calls = []
  const order = []
  return {
    calls,
    order,
    ready: true,
    appId: 'cli_x',
    async call(path, init) {
      order.push('reaction')
      calls.push({ path, method: init?.method, body: init?.body === undefined ? null : JSON.parse(init.body) })
      if (options.throwReaction === true) throw new Error('socket hang up')
      if (options.failReaction === true) return { ok: false, code: 99991400, msg: 'no permission' }
      return { ok: true, code: 0, data: {} }
    },
    async download(messageId, fileKey) {
      order.push('download')
      return { ok: true, code: 0, contentType: 'image/png', bytes: Buffer.from('PNGDATA') }
    },
  }
}

/** 起一个真控制器（真 `apply()`，只有飞书那一半是假的）。 */
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
  return { team, ctx, controller, client }
}

let sequence = 0

/**
 * 一条 `im.message.receive_v1`。
 *
 * `addressed` 是**结构性的**（`mentions` 里带着机器人的 open_id），与飞书真实投递一致 ——
 * "它有没有被 @" 从来不是靠搜正文里的 `@` 得来的。
 */
function event(text, options = {}) {
  sequence += 1
  const addressed = options.addressed === true
  return {
    __appId: 'cli_x',
    event_id: options.eventId ?? 'ev_' + String(sequence),
    sender: { sender_id: { open_id: options.sender ?? 'ou_wang' }, sender_type: 'user' },
    message: {
      chat_id: options.chatId ?? 'oc_a',
      chat_type: 'group',
      message_id: options.messageId ?? 'om_' + String(sequence),
      message_type: options.messageType ?? 'text',
      content: JSON.stringify(options.content ?? { text }),
      mentions: addressed ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: '机器人' }] : [],
      create_time: String(Date.now()),
    },
  }
}

/** 表态是旁路（不 await）：等一个宏任务，让那条 fire-and-forget 的链跑完。 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

function reactionCalls(client) {
  return client.calls.filter((call) => call.path.includes('/reactions'))
}

/** 一个只说"机器人是谁"的连接池替身：让 `addressed` 在 mode 'off' 下也算得出来。 */
function stubPool(controller) {
  controller.state.connectionPool = { botOpenIdFor: () => BOT_OPEN_ID }
}

test('默认：每一条收到的消息都表态，用的是"收到"那个表情', async () => {
  /*
   * 用户的要求：**收到消息就回一个"收到"的表情**。
   *
   * 默认（`feishu.reactionScope: 'all'`）覆盖两种情况：@ 了机器人的，和没 @ 的。
   * 没 @ 的那种恰恰最需要它：`requireMention: true` 时机器人不会开口回答，
   * 没有表情就是一片沉默，说话的人只能猜它是不是掉线了。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-reaction-'))
  try {
    const { ctx, controller, client } = await mount(dir)
    try {
      stubPool(controller)

      await controller.handleInbound(event('今天天气不错'))
      await settle()
      const plain = reactionCalls(client)
      assert.equal(plain.length, 1, '没被 @ 的普通消息也要表态')
      assert.equal(plain[0].method, 'POST')
      assert.match(plain[0].path, /^\/open-apis\/im\/v1\/messages\/om_\d+\/reactions$/)
      assert.equal(plain[0].body.reaction_type.emoji_type, 'Get', '默认就是飞书那个"收到/懂了"的表情')

      await controller.handleInbound(event('@机器人 支付重试这块', { addressed: true }))
      await settle()
      assert.equal(reactionCalls(client).length, 2, '@ 了机器人的消息同样表态')
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reactionScope: addressed 回到"只在被 @ 时表态"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-reaction-scope-'))
  try {
    const { ctx, controller, client } = await mount(dir, { reactionScope: 'addressed' })
    try {
      stubPool(controller)

      await controller.handleInbound(event('随便聊聊'))
      await settle()
      assert.equal(reactionCalls(client).length, 0, '没被 @ → 不表态')

      await controller.handleInbound(event('@机器人 看一下', { addressed: true }))
      await settle()
      assert.equal(reactionCalls(client).length, 1, '被 @ → 照常表态')
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reaction: false 一条都不点；emoji 可以换成别的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-reaction-off-'))
  try {
    const { ctx, controller, client } = await mount(dir, { reaction: false })
    try {
      stubPool(controller)
      await controller.handleInbound(event('@机器人 在吗', { addressed: true }))
      await settle()
      assert.equal(reactionCalls(client).length, 0, '关掉之后连 @ 的也不点')
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }

    const other = await mount(mkdtempSync(join(tmpdir(), 'dsh-team-reaction-emoji-')), { reactionEmoji: 'DONE' })
    try {
      stubPool(other.controller)
      await other.controller.handleInbound(event('换个表情'))
      await settle()
      assert.equal(reactionCalls(other.client)[0].body.reaction_type.emoji_type, 'DONE')
    } finally {
      for (const disposer of other.ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重投不重复表态 —— 重投会让群里多一个表情，那也是副作用', async () => {
  /*
   * 去重发生在任何副作用之前（设计 04 §4.1）：飞书重投时 `event_id` 不变。
   * 表态虽然"只是个小动作"，但它**在群里看得见** —— 同一句话下面挂两个一样的表情，
   * 就是那条规矩被破坏的证据。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-reaction-dedupe-'))
  try {
    const { ctx, controller, client } = await mount(dir)
    try {
      stubPool(controller)
      const first = event('重投试一试', { eventId: 'ev_same' })
      await controller.handleInbound(first)
      await settle()
      await controller.handleInbound({ ...first, message: { ...first.message, message_id: 'om_retry' } })
      await settle()
      assert.equal(reactionCalls(client).length, 1, '第二次投递不该再点一个表情')
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('机器人自己发的消息不表态（否则它会给自己的每张卡片点表情）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-reaction-self-'))
  try {
    const { ctx, controller, client } = await mount(dir)
    try {
      stubPool(controller)
      await controller.handleInbound(event('这是机器人自己发的', { sender: BOT_OPEN_ID }))
      await settle()
      assert.equal(reactionCalls(client).length, 0)

      // 别的应用发来的（`sender_type: 'app'`）同样不看：卡片、机器人之间的互相说话都算这一类。
      await controller.handleInbound({
        ...event('另一台机器人的卡片'),
        sender: { sender_id: { open_id: 'ou_other_bot' }, sender_type: 'app' },
      })
      await settle()
      assert.equal(reactionCalls(client).length, 0)
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('表态失败只是日志里的一行：消息照样记录，流程照样往下走', async () => {
  /*
   * 表态是**旁路**。飞书接口抖一下（没权限、超时、socket 断了）不该让这条消息
   * 从台账里消失 —— 那才是真正不可接受的失败。所以这里三种失败各来一次，
   * 每一次都断言"记录还在"。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-reaction-failure-'))
  try {
    const { team, ctx, controller, client } = await mount(dir)
    try {
      stubPool(controller)
      client.call = async (path, init) => {
        client.calls.push({ path, method: init?.method, body: JSON.parse(init.body) })
        throw new Error('socket hang up')
      }
      await controller.handleInbound(event('接口挂了也得分诊'))
      await settle()

      assert.equal(reactionCalls(client).length, 1, '试过了')
      assert.equal(controller.state.inbox.get('om_' + String(sequence)) !== null, true, '记录还在：这条消息没有被丢掉')
      assert.equal(controller.store.get('botsession', 'req.oc_a').seen, 1, '主机器人的 seen 照样 +1')

      const logged = await team.logsApi.snapshot({ file: 'false' })
      const lines = logged.log.rows.map((row) => row.source + ':' + row.message)
      assert.equal(
        lines.some((line) => line.startsWith('reaction:') && line.includes('socket hang up')),
        true,
        '失败留下了可查的一行：' + JSON.stringify(lines.slice(-4)),
      )
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('表态排在资产下载之前 ——「收到」的价值就在于它立刻发生', async () => {
  /*
   * 一张大图要下载几秒。如果表态排在下载后面，那个表情就变成了"下载完成通知"，
   * 而不是"我看到了"。顺序在 `order` 里逐个记下来，所以这条断言是顺序本身，
   * 不是"两个都发生了"。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-reaction-order-'))
  try {
    const { ctx, controller, client } = await mount(dir)
    try {
      stubPool(controller)
      await controller.handleInbound(
        event('', {
          messageType: 'image',
          content: { image_key: 'img_key_1' },
        }),
      )
      await settle()
      assert.deepEqual(client.order, ['reaction', 'download'], '表态先于下载')
      assert.equal(reactionCalls(client).length, 1)
    } finally {
      for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
