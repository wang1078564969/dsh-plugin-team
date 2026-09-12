/*
 * 「每个群有一个主的机器人，主机器人负责这个群所有消息的记录。」
 *
 * 这一条把"主"从**隐式**（谁回答谁是）变成**显式**（群级的记录归属）：
 *   · 首次接触就定主，哪怕这一条没人回答；
 *   · 被点名的是别的机器人 → 它回答，但主不变；
 *   · 群里每条消息都算在主机器人名下（`seen`），而 `turns` 只数它真正回答过的轮次。
 *
 * 为什么这两个数字必须分开：把没回答的消息也记成 turn，"这个机器人干了多少活"
 * 就成了一句假话；反过来只数 turns，"这个群最近发生了什么"就没有主。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../lib/config.js'
import { pickPrimaryBot } from '../lib/bots.js'
import { noteMessage } from '../lib/sessions.js'
import { createHandlers } from '../lib/tools.js'
import { Store } from '../lib/store.js'

const ROSTER = [
  { id: 'req', displayName: '需求机器人', role: 'req', enabled: true },
  { id: 'dev', displayName: '开发机器人', role: 'dev', enabled: true },
]

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-primary-'))
  const config = loadConfig({ dataDir: dir, tickIntervalMs: 0, bots: ROSTER, feishu: { appId: 'cli_one' } })
  return { config, store: new Store(dir).load(), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the primary bot is chosen by the routing rules, deterministically', () => {
  const { config, cleanup } = makeStore()
  try {
    // 没有点名、没有绑定 → 角色优先级（req 高于 dev）。
    assert.equal(pickPrimaryBot(config, { chatId: 'oc_a' }).id, 'req')
    // 点名另一个 → 首次接触就以它为主（"这个群是谁的"由第一次说话的人定）。
    assert.equal(pickPrimaryBot(config, { chatId: 'oc_a', text: '@开发机器人 看下' }).id, 'dev')
    // 已经绑定过的主优先于优先级：黏性不是"每次重算"。
    assert.equal(pickPrimaryBot(config, { chatId: 'oc_a', boundBotId: 'dev' }).id, 'dev')
    // 没有任何机器人为这个应用服务时，没有主（而不是硬塞一个）。
    assert.equal(pickPrimaryBot(config, { chatId: 'oc_a', appId: 'cli_other' }), null)
  } finally {
    cleanup()
  }
})

test('noteMessage counts messages seen, separately from turns answered', () => {
  const { store, cleanup } = makeStore()
  try {
    const first = noteMessage(store, { botId: 'req', chatId: 'oc_a', chatType: 'group', text: '重试这块要不要加？' })
    assert.equal(first.seen, 1)
    assert.equal(first.turns, 0, '记录不等于回答')
    assert.equal(first.last_inbound, '重试这块要不要加？')
    assert.equal(first.session_id, 'team-bot-req-oc_a')
    // 第二次接着数
    assert.equal(noteMessage(store, { botId: 'req', chatId: 'oc_a', text: 'x' }).seen, 2)
    // 另一个群是另一段
    assert.equal(noteMessage(store, { botId: 'req', chatId: 'oc_b', text: 'y' }).seen, 1)
  } finally {
    cleanup()
  }
})

test('a chat keeps its primary bot even when another bot answers', async () => {
  /*
   * 端到端：用 respondery 的真实路径（主机器人在 team.js 的 handleInbound 里定，
   * 这里手工复现那一步，因为驱动整个连接层不是这个用例的目的）。
   */
  const { config, store, cleanup } = makeStore()
  try {
    const chat = { id: 'oc_a', chat_type: 'group', app_id: 'cli_one', primary_bot_id: 'req', primary_since: '2026-09-12T10:00:00Z', messages: 0 }
    store.put('chat', chat)
    // 一条没人回答的消息：仍然记在主机器人名下。
    noteMessage(store, { botId: chat.primary_bot_id, chatId: 'oc_a', chatType: 'group', text: '今天天气不错' })
    const seen = store.get('botsession', 'req.oc_a')
    assert.equal(seen.seen, 1)
    assert.equal(seen.turns, 0, '它没回答，这一轮不算它的工作')

    // 换个机器人被点名回答：主不变（responder 的规则已在 bot-routing 用例里钉住）。
    assert.equal(pickPrimaryBot(config, { chatId: 'oc_a', text: '@开发机器人 看下', boundBotId: 'req' }).id, 'req')
  } finally {
    cleanup()
  }
})

test('a human can hand a group to another bot, explicitly and traceably', () => {
  const { config, store, cleanup } = makeStore()
  try {
    store.put('chat', { id: 'oc_a', chat_type: 'group', app_id: 'cli_one', primary_bot_id: 'req', primary_since: '2026-09-12T10:00:00Z', messages: 3, turns: 1 })
    const handlers = createHandlers({
      ctx: { get: () => undefined, effect: (factory) => factory() },
      config,
      store,
      pool: { open: async () => {}, drive: async () => ({}) },
    })

    // 面板/工具都能看到"这个群归谁"
    const rows = handlers.list_chats().rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].primaryBotId, 'req')
    assert.equal(rows[0].primaryBotName, '需求机器人')
    assert.equal(rows[0].messages, 3)

    // 显式换主：记下是谁换的、什么时候、之前是谁
    const moved = handlers.set_primary_bot({ id: 'oc_a', assignee: 'bot:dev', actor: 'human:owner' })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    const after = store.get('chat', 'oc_a')
    assert.equal(after.primary_bot_id, 'dev')
    assert.equal(after.previous_primary_bot_id, 'req')
    assert.equal(after.primary_changed_by, 'human:owner')
    assert.equal(typeof after.primary_since, 'string')

    // 换主之后，这个群的消息记在新主名下（旧的那段记录还在，不会被改写）
    assert.equal(store.get('botsession', 'dev.oc_a').seen, 1, '新主从这个群的第一条开始记')

    // 名册里没有的机器人不能当主（否则"记录归谁"会指向一个不存在的东西）
    const ghost = handlers.set_primary_bot({ id: 'oc_a', assignee: 'bot:nobody', actor: 'human:owner' })
    assert.equal(ghost.ok, false)
    assert.equal(ghost.code, 'not_found')
  } finally {
    cleanup()
  }
})
