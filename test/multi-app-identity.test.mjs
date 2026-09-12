/*
 * 多应用的身份：一个应用一条连接、一台机器人一张脸 —— 而"我是谁"必须由**每个应用
 * 自己**回答。
 *
 * 为什么单独一个文件：2026-09-12 用户加了第二个应用（`cli_aa157481…`，机器人
 * "个人网银前端"）拉进群，@ 它没有任何反应；日志里两台机器人的 `botOpenId` 都是
 * **第一个应用的** `ou_847e6…`。根因是安装级 `feishu.botOpenId` 被所有应用继承 ——
 * 于是"这条消息 @ 了我吗"对第二个应用永远是 false（`requireMention` 默认 true →
 * 它永远不开口），反过来 @ 第一台时它倒以为自己被点名了。
 *
 * 三条用例各守一层：
 *   1. 身份解析（`configuredBotOpenId`）：安装级的值只属于默认应用；
 *   2. 名单提取（`mentionedOpenIds`）：@ 到谁按 open_id 记，不按名字猜；
 *   3. 控制器层（真 `handleInbound`）：被点名的应用决定这个群归谁，且群的应用身份
 *      不会随"哪条连接先到"来回跳。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { configuredBotOpenId, mentionedOpenIds, normalizeMessage } from '../lib/feishu/connection.js'

const REQ_OPEN_ID = 'ou_847e6c1667692e892cd81eb4eb2992e4'
const DEV_OPEN_ID = 'ou_bfc12499defc8102b9877ac2a0968d7e'

const config = {
  feishu: { appId: 'cli_req', botOpenId: REQ_OPEN_ID, apps: { cli_dev: { appSecret: 's' } } },
}

test('安装级 botOpenId 只属于默认应用，别的应用自己回答（否则身份串台）', () => {
  // 自己的值最优先 —— 任何应用都是。
  assert.equal(configuredBotOpenId({ appId: 'cli_dev', botOpenId: DEV_OPEN_ID }, config), DEV_OPEN_ID)
  // 默认应用没有自己的值 → 安装级那个说的就是它。
  assert.equal(configuredBotOpenId({ appId: 'cli_req', botOpenId: '' }, config), REQ_OPEN_ID)
  // 没有 descriptor（单应用形态）→ 同上。
  assert.equal(configuredBotOpenId(null, config), REQ_OPEN_ID)
  /*
   * **非默认应用没有自己的值 → 空**。连接拿到空会去问 `/open-apis/bot/v3/info`
   * （用它自己的凭据），那才是它的真实身份；继承安装级的值等于把两张脸搞混。
   */
  assert.equal(configuredBotOpenId({ appId: 'cli_dev', botOpenId: '' }, config), '')
  assert.equal(configuredBotOpenId({ appId: 'cli_dev' }, config), '')
})

test('@ 到谁按 open_id 记下来，不按名字猜', () => {
  assert.deepEqual(
    mentionedOpenIds([
      { key: '@_user_1', id: { open_id: DEV_OPEN_ID }, name: '个人网银前端' },
      { key: '@_user_2', id: { open_id: 'ou_someone' }, name: '王梦凡' },
    ]),
    [DEV_OPEN_ID, 'ou_someone'],
  )
  // 脏数据不能让整条消息炸掉：没有 id / 不是对象 / 空 id 一律跳过。
  assert.deepEqual(mentionedOpenIds([null, 'x', { id: null }, { id: { open_id: '' } }, { id: { open_id: 7 } }]), [])
  assert.deepEqual(mentionedOpenIds(undefined), [])

  // 归一化之后这条消息带着名单（路由层就是靠它认出"被点名的是哪个应用"）。
  const message = normalizeMessage(
    {
      message: {
        chat_id: 'oc_a',
        chat_type: 'group',
        message_id: 'om_1',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 测试会话' }),
        mentions: [{ key: '@_user_1', id: { open_id: DEV_OPEN_ID }, name: '个人网银前端' }],
        create_time: '1790000000000',
      },
      sender: { sender_id: { open_id: 'ou_wang' }, sender_type: 'user' },
    },
    { botOpenId: REQ_OPEN_ID, appId: 'cli_req' },
  )
  assert.deepEqual(message.mentionedOpenIds, [DEV_OPEN_ID])
  assert.equal(message.addressed, false, '收到这条的那个应用（cli_req）并没有被点名')
})

/** 一个最小上下文：只要 tools / effect / on。 */
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

test('控制器：被点名的应用定归属，群的应用身份不再随"谁先到"跳', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-multiapp-'))
  const team = await import('../lib/team.js')
  const ctx = fakeCtx()
  try {
    await team.apply(ctx, {
      dataDir: dir,
      workspace: join(dir, 'ws'),
      tickIntervalMs: 0,
      bots: [
        { id: 'req', displayName: '需求机器人', role: 'req', enabled: true, feishu: { appId: 'cli_req' } },
        { id: 'dev', displayName: '个人网银前端', role: 'dev', enabled: true, feishu: { appId: 'cli_dev' } },
      ],
      feishu: { mode: 'off', appId: 'cli_req', appSecret: 's', apps: { cli_dev: { appSecret: 's2' } }, botOpenId: REQ_OPEN_ID },
    })
    const controller = team.feishuSeam

    /*
     * 连接池替身：每个应用报**自己的**机器人 open_id —— 这正是修好身份之后
     * `connectionPool.botOpenIdFor(appId)` 的真实行为（拿不到就问飞书）。
     */
    controller.state.clients.set('cli_dev', { ready: true, appId: 'cli_dev', async call() { return { ok: true } } })
    controller.state.connectionPool = {
      botOpenIdFor: (appId) => (appId === 'cli_dev' ? DEV_OPEN_ID : appId === 'cli_req' ? REQ_OPEN_ID : ''),
      online: () => 2,
      reports: () => [],
    }

    const event = (messageId, appId, mentions) => ({
      __appId: appId,
      event_id: 'ev_' + messageId,
      sender: { sender_id: { open_id: 'ou_wang' }, sender_type: 'user' },
      message: {
        chat_id: 'oc_hub',
        chat_type: 'group',
        message_id: messageId,
        message_type: 'text',
        content: JSON.stringify({ text: '测试会话' }),
        mentions,
        create_time: String(Date.now()),
      },
    })

    // 第一条从**另一个应用**的连接上来，但 @ 的是开发机器人 → 这个群归它。
    await controller.handleInbound(
      event('om_1', 'cli_req', [{ key: '@_user_1', id: { open_id: DEV_OPEN_ID }, name: '个人网银前端' }]),
    )
    const chat = controller.store.get('chat', 'oc_hub')
    assert.equal(chat.primary_bot_id, 'dev', '被点名的身份定归属（而不是"哪条连接先到"）')
    assert.deepEqual(chat.app_ids, ['cli_req'], '这个群见过哪些应用，如实记下来')
    assert.equal(chat.app_id, 'cli_req', '主机器人的应用还没在这个群出现过 → 先用收到这条的那个')

    // 第二条从开发机器人的应用上来：它现在是"见过的应用"，群的播报身份从此稳定在它上面。
    await controller.handleInbound(event('om_2', 'cli_dev', []))
    const after = controller.store.get('chat', 'oc_hub')
    assert.deepEqual(after.app_ids, ['cli_req', 'cli_dev'])
    assert.equal(after.app_id, 'cli_dev', '主机器人的应用见过之后，播报身份就固定成它，不再看谁先到')
    assert.equal(after.messages, 2)

    /*
     * 最后一段只是"名单确实传到了流水线"：路由决策在 responder 那层已经被
     * `bot-routing.test.mjs` 钉住了（plan → 被点名的那台、speak=true、用它自己的应用发），
     * 这里只需确认 `mentionedAppIds` 没有被 `handleInbound` 吃掉 —— 少了它，
     * 后面整条链都是"知道被点名了却传不下去"。
     */
    const seen = []
    controller.state.ingest = {
      async onMessage(inbound) {
        seen.push({ mentionedAppIds: inbound.mentionedAppIds, addressed: inbound.addressed })
        return { skipped: 'duplicate' } // 到此为止：这条用例不驱动应答
      },
    }
    await controller.handleInbound(
      event('om_3', 'cli_req', [{ key: '@_user_1', id: { open_id: DEV_OPEN_ID }, name: '个人网银前端' }]),
    )
    assert.deepEqual(seen, [{ mentionedAppIds: ['cli_dev'], addressed: false }], '名单一路传到流水线')
  } finally {
    for (const disposer of ctx.effects) if (typeof disposer === 'function') disposer()
    rmSync(dir, { recursive: true, force: true })
  }
})
