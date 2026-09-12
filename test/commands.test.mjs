/*
 * 群命令 ↔ handler ↔ 卡片按钮：**三张表必须对得上**。
 *
 * 为什么值得单独一个文件：这三张表分处三个模块，而它们的漂移是**静默**的 ——
 * 卡片上写着"废弃"、群里却没有这个动词；动词表里有一个动作、handler 里没有；
 * 兜底文案教人回一句解析器不认的话。三种情况都不会报错，只会让人以为"机器人不听话"。
 *
 * 历史上真实发生过的:
 *   · 卡片教人回复 `task.accept`，而词表只认 `接受`（照做会被当散文走分诊）；
 *   · `阻塞`/`转派` 需要的参数给不出（`阻塞 task-1 等接口` 整条解析失败）；
 *   · `提交验收`/`确认拆解`/`续约`/`交回` 有按钮、没有动词；
 *   · 需求卡的 `确认需求`/`废弃` 没有需求级动词（`废弃` 落到 `drop_task`，按 req id 找不到任务）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildRequirementCard, buildTaskCard } from '../lib/feishu/broadcast.js'
import { commandHintOf, degradationLadder } from '../lib/feishu/cards.js'
import { DEFAULT_COMMANDS, parseCommand } from '../lib/feishu/ingest.js'
import { loadConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'
import { createHandlers } from '../lib/tools.js'

function makeHandlers() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-team-commands-'))
  const config = loadConfig({ dataDir: dir, workspace: join(dir, 'ws'), tickIntervalMs: 0, bots: [], feishu: { mode: 'off', appId: 'cli_x', appSecret: 's' } })
  const handlers = createHandlers({
    ctx: { get: () => undefined, effect: (factory) => factory() },
    config,
    store: new Store(dir).load(),
    pool: {},
    notify: null,
  })
  return { dir, handlers, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('词表里的每个动作都有 handler；每个动词只映射到一个动作（不许有歧义）', () => {
  const world = makeHandlers()
  try {
    for (const [action, words] of Object.entries(DEFAULT_COMMANDS)) {
      // `status` 是唯一的特例：它由 runCommand 内联处理（只读台账，不改任何东西）。
      if (action === 'status') continue
      assert.equal(typeof world.handlers[action], 'function', action + ' 在词表里，但没有 handler')
      assert.equal(Array.isArray(words) && words.length > 0, true, action + ' 至少要有一个动词')
    }
    // 一个动词只能指向一个动作：`parseCommand` 是"先到先得"，重名会让先声明的那个永远赢。
    const owner = new Map()
    for (const [action, words] of Object.entries(DEFAULT_COMMANDS)) {
      for (const word of words) {
        assert.equal(owner.has(word), false, '动词 `' + word + '` 同时属于 ' + owner.get(word) + ' 和 ' + action)
        owner.set(word, action)
      }
    }
  } finally {
    world.cleanup()
  }
})

test('任务卡上每一颗按钮，兜底文案都是一句解析得动的命令', () => {
  const task = {
    id: 'task-8891', req: 'req-2026-014', title: '实现退避', state: 'in_progress', type: 'feature_delivery',
    domains: ['development'], assignee: 'bot:dev', owner: 'bot:dev', acceptance_criteria: ['单测'],
    gates: { start: { required_by: ['bot:dev'], confirmed_by: [{ by: 'bot:dev', at: '2026-02-03T10:00:00Z' }], due_at: null, not_applicable: false, timeout_snapshot: '2h', on_timeout: 'auto_release', max_release: 2 } },
    repo: null, branch: null, mr: null, evidence: [{ kind: 'note', ref: 'x', note: 'n' }],
    release_count: 0, blocked_reason: null, history: [], collaborators: [],
  }
  const card = buildTaskCard(task, { nonce: () => 'n1', now: () => new Date('2026-02-03T10:00:00Z') })
  const buttons = card.blocks.filter((one) => one.kind === 'buttons').flatMap((one) => one.buttons)
  assert.equal(buttons.length > 0, true, '这个状态下应当有按钮')
  for (const button of buttons) {
    const hint = commandHintOf(button)
    const parsed = parseCommand(hint)
    assert.notEqual(parsed, null, '按钮「' + button.label + '」的兜底文案解析不了：' + hint)
    assert.equal(parsed.id, task.id, '兜底文案要带上对象 id')
  }
})

test('需求卡上的按钮同样：需求级动词存在，且 `废弃` 不会落到任务动作上', () => {
  const req = {
    id: 'req-2026-001', title: '支付重试', state: 'draft', owner: 'human:pm', requester: 'human:pm',
    priority: 'P2', type: 'feature_delivery', acceptance_criteria: [], tasks: [],
    body: { problem: 'p', proposal: '' }, links: { repos: [], docs: [], branches: [], mirror: null },
    decisions: [], visibility: 'team', origin: { surface: 'internal', excerpts: [] }, history: [],
  }
  const card = buildRequirementCard(req, [], { nonce: () => 'n1', now: () => new Date('2026-02-03T10:00:00Z') })
  const buttons = card.blocks.filter((one) => one.kind === 'buttons').flatMap((one) => one.buttons)
  assert.equal(buttons.length > 0, true)
  const byLabel = new Map(buttons.map((one) => [one.label, one]))
  assert.equal(parseCommand(commandHintOf(byLabel.get('确认需求'))).action, 'confirm_requirement')
  assert.equal(parseCommand(commandHintOf(byLabel.get('废弃'))).action, 'drop_requirement', '需求卡上的"废弃"是废弃需求')
  for (const button of buttons) {
    assert.notEqual(parseCommand(commandHintOf(button)), null, '需求按钮「' + button.label + '」的兜底文案要能解析')
  }
})

test('buttons:false 时第一级卡片真的没有按钮元素，且留了可执行的文本指令', () => {
  const task = {
    id: 'task-1', req: 'req-1', title: 't', state: 'assigned', type: 'feature_delivery', domains: ['development'],
    assignee: 'bot:dev', owner: 'bot:dev', acceptance_criteria: [], gates: {}, repo: null, branch: null, mr: null,
    evidence: [], release_count: 0, blocked_reason: null, history: [], collaborators: [],
  }
  const card = buildTaskCard(task, { nonce: () => 'n1', now: () => new Date('2026-02-03T10:00:00Z') })
  const off = degradationLadder(card, { buttons: false })
  const first = JSON.parse(off[0].payload.content)
  assert.equal(first.elements.some((el) => el.tag === 'action'), false, '默认配置下不该出现点不动的按钮')
  const contents = first.elements.map((el) => (typeof el.content === 'string' ? el.content : '')).join('\n')
  const hints = [...contents.matchAll(/`([^`]+)`/g)].map((one) => one[1])
  assert.equal(hints.length > 0, true, '去按钮之后必须留下文本指令')
  for (const hint of hints) assert.notEqual(parseCommand(hint), null, '文本指令要能解析：' + hint)
})

test('需求级动词的 handler 真的存在（不只是词表里有）', () => {
  const world = makeHandlers()
  try {
    for (const action of ['confirm_requirement', 'reconfirm_requirement', 'finish_requirement', 'archive_requirement', 'drop_requirement', 'suspend_requirement', 'resume_requirement']) {
      assert.equal(typeof world.handlers[action], 'function', action + ' 缺 handler')
      assert.equal(Object.keys(DEFAULT_COMMANDS).includes(action), true, action + ' 缺群动词')
    }
  } finally {
    world.cleanup()
  }
})
