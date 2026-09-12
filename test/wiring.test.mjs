/*
 * The wiring in lib/team.js, exercised for real: `apply()` is called and what it
 * published is inspected.
 *
 * WHY THIS IS WORTH A TEST. `team.js` is the one file a typo takes the whole
 * feature down with — and it is loaded through the entry's dynamic import, so a
 * mistake there shows up as a log line at activation, not as a failing import in
 * CI. Everything else in this suite tests a module in isolation; this one asks the
 * assembled thing to come up, with `feishu.mode: 'off'` so it touches no network
 * (no credentials, no long connection, no group).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

/** A context with just enough surface: tools, effects, and the optional services. */
function fakeCtx() {
  const tools = []
  const effects = []
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on: () => () => {},
    // No `agents`, no `timer`, no `connection`: every optional service is absent,
    // which is the state a headless profile is in — and activation must survive it.
    get: () => undefined,
    tools2: tools,
    registered: tools,
    effects,
  }
  return ctx
}

test('apply() comes up with no optional service present, and publishes both routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-wiring-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [
        { id: 'req', displayName: '需求机器人', role: 'req', enabled: true, feishu: { speakPolicy: { onIntent: true } } },
        { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true, agentPreset: 'standard', feishu: { chats: ['oc_dev'] } },
      ],
      members: [{ key: 'human:wangmengfan', name: '王梦凡', domains: ['pm', 'requirement'], role: 'owner' }],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's', speakLeaseMs: 45000 },
    })

    // The two routes the browser half needs, published for the entry to mount.
    assert.equal(team.api.path, '/api/team/ledger')
    assert.equal(team.configApi.path, '/api/team/config')
    // The model-facing tool, registered through ctx.effect so unloading takes it.
    assert.equal(ctx.registered.length, 1)
    assert.equal(typeof ctx.registered[0].name === 'string' || typeof ctx.registered[0].tool?.name === 'string', true)

    const snapshot = await team.configApi.snapshot()
    assert.equal(snapshot.ok, true)
    assert.deepEqual(
      snapshot.roster.bots.map((one) => one.id),
      ['req', 'dev'],
    )
    assert.equal(snapshot.roster.bots[0].enabled, true)
    // The default app carries the secret, so both bots resolve to it and neither
    // has a problem it should not have.
    assert.equal(snapshot.roster.bots[0].appIdResolved, 'cli_x')
    /*
     * Two enabled bots on ONE app is the honest state of a single-app installation:
     * they are the same face in Feishu, and the console says so per row. What must
     * NOT appear is an error — a warning is advice, an error blocks a save.
     */
    assert.deepEqual(snapshot.roster.bots[0].problems.map((one) => one.level), ['warn'])
    assert.match(snapshot.roster.bots[0].problems[0].message, /同一张脸/)
    assert.equal(snapshot.problems.every((one) => one.message !== ''), true)
    assert.deepEqual(snapshot.problems, [], 'warnings do not block a save, so the 配置 page shows a clean list')
    assert.equal(snapshot.config.feishu.speakLeaseMs, 45000)
    // Owners come from the member table, through the derived domain map.
    assert.deepEqual(snapshot.config.domains.pm, ['human:wangmengfan'])
    assert.equal(snapshot.roster.members.length, 1)
    // No bot conversations yet, and that is a state the console must render.
    assert.deepEqual(snapshot.sessions, [])

    // Feishu is off, so no connection was attempted and the mode says so.
    assert.equal(snapshot.diagnostics.mode, 'off')
  } finally {
    for (const disposer of ctx.effects) {
      if (typeof disposer === 'function') disposer()
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply() with a broken roster still comes up: the ledger must outlive a bad row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-wiring-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      // Two rows with the same id, one with a role nobody defined: the config is
      // wrong, and the plugin still has to load — a collaboration layer that refuses
      // to start over a typo is worse than one that starts and says what is wrong.
      bots: [
        { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
        { id: 'req', displayName: '另一个', role: 'nonsense', enabled: true },
      ],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    const snapshot = await team.configApi.snapshot()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.roster.bots.length, 2)
    // The problems are per row, which is what the 机器人 page renders.
    assert.equal(snapshot.roster.bots[0].problems.some((one) => one.field === 'id'), true)
    assert.equal(snapshot.roster.bots[1].problems.some((one) => one.field === 'role'), true)
    assert.equal(snapshot.problems.length > 0, true, 'and the flat list the 配置 page shows agrees')
  } finally {
    for (const disposer of ctx.effects) {
      if (typeof disposer === 'function') disposer()
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every message in a group is recorded under that group\'s primary bot', async () => {
  /*
   * 用户的要求：**每个群有一个主的机器人，主机器人负责这个群所有消息的记录**。
   *
   * 只有在真实入站路径上验过才算数，所以这里喂伪造的飞书事件，走
   * `handleInbound` → 群记录 → 定主 → 记消息。故意用**没人回答**的闲聊：
   * 记录照样发生，而 `turns` 不动 —— "记录"与"回答"必须分得开。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-primary-wiring-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [
        { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
        { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true },
      ],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    // 接缝在模块作用域上，不在 ctx 上：真 Cordis 上下文拒绝未声明的属性赋值。
    const controller = team.feishuSeam
    assert.notEqual(controller, undefined, 'the controller is reachable for testing')
    const store = controller.store

    let seq = 0
    const event = (text) => {
      seq += 1
      return {
        __appId: 'cli_x',
        sender: { sender_id: { open_id: 'ou_someone' }, sender_type: 'user' },
        message: {
          chat_id: 'oc_a',
          chat_type: 'group',
          message_id: 'om_' + String(seq),
          message_type: 'text',
          content: JSON.stringify({ text }),
          create_time: String(Date.now()),
        },
      }
    }

    // 第一条：闲聊、没人回答 —— 群记录照样发生，主按角色优先级定下来。
    await controller.handleInbound(event('今天天气不错'))
    const chat = store.get('chat', 'oc_a')
    assert.equal(chat.primary_bot_id, 'req', '首次接触就定主（不是"谁回答谁是"）')
    assert.equal(chat.messages, 1)
    assert.equal(typeof chat.primary_since, 'string')
    assert.equal(store.get('botsession', 'req.oc_a').seen, 1, '记在主机器人名下')
    assert.equal(store.get('botsession', 'req.oc_a').turns, 0, '它没有回答，轮次是 0')

    // 第二条：仍然没人回答，仍然记在同一个主名下。
    await controller.handleInbound(event('那明天呢'))
    assert.equal(store.get('chat', 'oc_a').messages, 2)
    assert.equal(store.get('botsession', 'req.oc_a').seen, 2)
    assert.equal(store.get('botsession', 'req.oc_a').turns, 0)

    // 显式换主之后，新的消息记在新主名下；旧的那段记录不被改写。
    store.put('chat', { ...store.get('chat', 'oc_a'), primary_bot_id: 'dev', primary_since: new Date().toISOString() })
    await controller.handleInbound(event('开发看一下'))
    assert.equal(store.get('chat', 'oc_a').primary_bot_id, 'dev')
    assert.equal(store.get('chat', 'oc_a').messages, 3)
    assert.equal(store.get('botsession', 'dev.oc_a').seen, 1, '新主从这个群的下一条开始记')
    assert.equal(store.get('botsession', 'req.oc_a').seen, 2, '旧主的那段记录还在')
  } finally {
    for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an inbound image is downloaded, stored as asset://, receipted — and deduped by event_id', async () => {
  /*
   * 设计 04 §9：图片要"落库 + 生成引用（asset://...）"，群里回一句"已收到图片"。
   * 这条走**真实入站路径**（伪造事件 → handleInbound），只有下载是真的假的：
   * 客户端被替换成一个只会回字节的 `download`。
   *
   * 顺带钉住 event_id 去重：飞书重投时 message_id 会变、event_id 不变，
   * 而"再跑一遍"的副作用就是群里多一句回执、盘上多一个目录。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-asset-wiring-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    // 接缝在模块作用域上，不在 ctx 上：真 Cordis 上下文拒绝未声明的属性赋值。
    const controller = team.feishuSeam
    const downloads = []
    // 入站资源走 `clientForChat(chatId)` 解析出来的客户端：替换它的 download。
    controller.state.client = {
      ready: true,
      appId: 'cli_x',
      download: async (messageId, fileKey, options) => {
        downloads.push({ messageId, fileKey, type: options?.type })
        return { ok: true, code: 0, msg: 'ok', contentType: 'image/png', bytes: Buffer.from('PNGDATA') }
      },
      call: async () => ({ ok: true, code: 0, msg: 'ok', data: {} }),
    }
    controller.state.clients.set('cli_x', controller.state.client)

    const imageEvent = {
      __appId: 'cli_x',
      event_id: 'ev_img_1',
      sender: { sender_id: { open_id: 'ou_someone' }, sender_type: 'user' },
      message: {
        chat_id: 'oc_a', chat_type: 'group', message_id: 'om_img_1', message_type: 'image',
        content: JSON.stringify({ image_key: 'img_key_1' }), create_time: String(Date.now()),
      },
    }
    await controller.handleInbound(imageEvent)
    assert.deepEqual(downloads, [{ messageId: 'om_img_1', fileKey: 'img_key_1', type: 'image' }])

    const stored = controller.state.assets.all()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].ref.startsWith('asset://'), true)
    assert.equal(stored[0].exists, true, '内容真的落在盘上')
    assert.equal(stored[0].chat_id, 'oc_a')

    /*
     * 这一类消息**没有正文可判**，所以它在"记录是地板"那一侧就结束了：
     * 资产落盘 + 收件箱一条"为什么没建单" + 一行日志 + 回执。
     *
     * 注意收件箱那条：`feishu.mode: 'off'` 时流水线没起来，记录由**地板自己**写。
     * 这不只是记账 —— 去重表就是收件箱，少了它，重投的消息会被再下载一遍。
     */
    const doc = controller.state.inbox.get('om_img_1')
    assert.notEqual(doc, null, '记录是地板：流水线没起来，收件箱也要有这一条')
    assert.equal(doc.triage_kind, 'asset')
    assert.match(doc.ignored_reason, /已落库为资产/)
    assert.equal(doc.event_id, 'ev_img_1')
    assert.equal(doc.assets[0].ref, stored[0].ref, 'agent 按需读的就是这个引用')
    assert.equal(doc.recorded_by, 'req', '记在主机器人名下')

    const logged = await team.logsApi.snapshot({ file: 'false' })
    const lines = logged.log.rows.map((row) => row.source + ':' + row.message)
    assert.equal(
      lines.some((line) => line.startsWith('asset:收到 1 个资源：asset://')),
      true,
      '落库要留一行日志：' + JSON.stringify(lines.slice(-4)),
    )

    // 重投（同一个 event_id、新的 message_id）：不再下载、不再多存一份。
    await controller.handleInbound({ ...imageEvent, message: { ...imageEvent.message, message_id: 'om_img_2' } })
    assert.equal(downloads.length, 1, '重投没有重新下载')
    assert.equal(controller.state.assets.all().length, 1, '也没有多存一份')

    // 观测页要能看到这些引用（"落库 + 引用"只完成了一半，另一半是人查得到）。
    const snapshot = await team.logsApi.snapshot({})
    assert.equal(snapshot.assets.count, 1)
    assert.equal(snapshot.assets.rows[0].ref, stored[0].ref)
    assert.equal(snapshot.assets.rows[0].exists, true)
  } finally {
    for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('日报：摘要桶按群聚合，并把「现在有什么在等你」现算出来', async () => {
  /*
   * 设计 04 §2.1 的报告卡 + §0 的"人不在时补发"。
   *
   * 两件事合在一条日报里，理由很直接：`digest` 模式的意义是"这类话不必马上说"，
   * 而"攒起来的东西一定要有人说"；人离开一天回来，最需要知道的不是"发生过什么"
   * （那是日志），而是**现在有什么在等他**。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-report-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [{ id: 'req', displayName: '需求机器人', role: 'req', enabled: true }],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    // 接缝在模块作用域上，不在 ctx 上：真 Cordis 上下文拒绝未声明的属性赋值。
    const controller = team.feishuSeam
    const store = controller.store
    const sent = []
    controller.state.client = {
      ready: true,
      appId: 'cli_x',
      send: async (chatId, payload) => {
        sent.push({ chatId, payload })
        return { ok: true, code: 0, data: { message_id: 'om_' + String(sent.length) } }
      },
      request: async (method, path, body) => {
        sent.push({ method, path, body })
        return { ok: true, code: 0, data: { message_id: 'om_' + String(sent.length) } }
      },
      call: async () => ({ ok: true, code: 0, msg: 'ok', data: {} }),
    }
    controller.state.clients.set('cli_x', controller.state.client)

    // 一个群：主机器人是 req；一个需求长在这个群里；它下面有一个等确认的任务。
    store.put('chat', { id: 'oc_a', chat_type: 'group', app_id: 'cli_x', primary_bot_id: 'req', messages: 3 })
    store.put('requirement', {
      id: 'req-2026-001', title: '支付重试', state: 'dispatched',
      origin: { surface: 'feishu', chat_id: 'oc_a', excerpts: [] },
    })
    const gate = (requiredBy, confirmedBy) => ({
      required_by: requiredBy, confirmed_by: confirmedBy, due_at: null, not_applicable: false,
      timeout_snapshot: '4h', on_timeout: 'remind_then_escalate', max_release: null,
    })
    store.put('task', {
      id: 'task-1', req: 'req-2026-001', title: '实现退避', state: 'assigned', domains: ['development'],
      // `gates` 是**一张表**（不是数组），状态由 gateSatisfied 算 —— 这条用例以前喂的是
      // 一个不存在的形状，于是"待确认"那段代码即使写错了也照样绿。
      gates: {
        accept: gate(['human:zhouyu'], []),
        start: gate(['human:zhouyu'], [{ by: 'human:zhouyu', at: '2026-09-12T09:00:00.000Z' }]),
      },
    })
    // 另一个群没有待办、也没有摘要：日报不该为它发一条空卡。
    store.put('chat', { id: 'oc_empty', chat_type: 'group', app_id: 'cli_x', primary_bot_id: 'req', messages: 0 })

    const report = await controller.flushReports('2026-09-12')
    assert.deepEqual(report.map((row) => row.chatId), ['oc_a'], '只给有内容的群发')
    assert.equal(sent.length >= 1, true, '日报真的发出去了')

    const card = JSON.parse(
      String(sent[sent.length - 1].payload?.content ?? sent[sent.length - 1].body?.content ?? '{}'),
    )
    const text = JSON.stringify(card)
    assert.match(text, /日报 2026-09-12/)
    assert.match(text, /待确认 task-1：实现退避 —— 接受：等 human:zhouyu/)
    assert.equal(text.includes('start：等'), false, '已经确认的门禁不该再催一遍')

    // 桶取走之后就空了：同一条进度不会今天、明天各说一次。
    const again = await controller.flushReports('2026-09-12')
    assert.deepEqual(again.map((row) => row.chatId), ['oc_a'], '待办还在，所以还有内容')
    const lines = (await team.logsApi.snapshot({ file: 'false' })).log.rows.filter((row) => row.source === 'report')
    assert.equal(lines.length >= 1, true, '每次发送都留一行日志')
  } finally {
    for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a timer service arms the daily report, and switching it off (-1) arms nothing', async () => {
  const team = await import('../lib/team.js')
  const armed = []
  const makeCtx = () => {
    const ctx = fakeCtx()
    ctx.get = (name) => (name === 'timer' ? { interval: (callback, ms) => { armed.push({ callback, ms }); return () => {} } } : undefined)
    return ctx
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-report-timer-'))
  try {
    await team.apply(makeCtx(), {
      dataDir: dir, workspace: join(dir, 'ws'), tickIntervalMs: 0, bots: [],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    // 补发定时器（5 秒）一直都在；日报是**多出来的**那一张（10 分钟看一次表）。
    assert.equal(armed.filter((one) => one.ms === 10 * 60 * 1000).length, 1, '默认 18 点：装一张日报表')
    assert.equal(armed.some((one) => one.ms === 5_000), true, '补发节流窗口的表照旧')

    armed.length = 0
    await team.apply(makeCtx(), {
      dataDir: dir, workspace: join(dir, 'ws'), tickIntervalMs: 0, bots: [],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's', dailyReportHour: -1 },
    })
    assert.equal(armed.some((one) => one.ms === 10 * 60 * 1000), false, '-1 = 不发日报，也就不装表')
    assert.equal(armed.some((one) => one.ms === 5_000), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the logs route is published too, and the log bus survives a restart through its file', async () => {
  /*
   * 设计 05 §4.0：日志放在页面第一屏，因为"出问题时人第一反应是刚才发生什么了"。
   * 这一条验两件事：**路由挂上了**，以及**重启前的日志还在**（内存缓冲重启即空，
   * 而"刚重启完"恰恰是最需要看上一条的时候）。
   */
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-logs-'))
  const team = await import('../lib/team.js')
  const { writeLogFile } = await import('../lib/logbus.js')
  const ctx = fakeCtx()
  try {
    // 上一次进程留下的日志（模拟重启前）
    writeLogFile(dir, [
      { at: '2026-09-12T09:00:00.000Z', level: 'info', source: 'feishu', message: '重启前的一条：长连接就绪', data: null },
    ])
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [],
      feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' },
    })
    assert.equal(team.logsApi.path, '/api/team/logs')
    const snapshot = await team.logsApi.snapshot({ file: 'true' })
    assert.equal(snapshot.ok, true)
    assert.equal(
      snapshot.log.rows.some((row) => String(row.message).includes('重启前的一条')),
      true,
      '文件里的旧日志被读出来了：' + JSON.stringify(snapshot.log.rows.map((r) => r.message)),
    )
    assert.equal(snapshot.log.rows.some((row) => String(row.message).includes('已激活')), true, '本次启动也记了')
    assert.equal(typeof snapshot.messages.total, 'number', '收件箱统计（含漏单）')
    assert.equal(typeof snapshot.delivery, 'object', '投递统计（降级率）')
    /*
     * 观测是在**宿主里**接上的，所以这里验的是接线本身：`metrics` 真的被建出来了、
     * 面板要的那两段（降级率的分组、每群发言占比）真的在快照里，而且都是可读的空值
     * 而不是 undefined —— "没有数据"和"这个功能没接"在页面上必须长得不一样。
     */
    assert.notEqual(team.metrics, null, '观测聚合被建出来了')
    assert.deepEqual(snapshot.delivery.tiers, [], '还没有播报过：层级表是空的，不是 undefined')
    assert.equal(snapshot.delivery.fallbackRate, 0)
    assert.equal(snapshot.delivery.mentions, 0)
    assert.equal(snapshot.share.threshold, 0.25)
    assert.equal(snapshot.share.minSample, 8)
    assert.deepEqual(snapshot.share.chats, [])
    assert.deepEqual(team.metrics.tick(), [], '没有超线的群时不写日志')
    // 脱敏：密钥一类的东西永远不该落进日志
    const { redactSecrets } = await import('../lib/logbus.js')
    assert.equal(redactSecrets('appSecret: "abc123"').includes('abc123'), false)
    assert.equal(redactSecrets('Authorization: Bearer t-12345').includes('t-12345'), false)
  } finally {
    for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    rmSync(dir, { recursive: true, force: true })
  }
})
