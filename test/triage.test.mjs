/*
 * 分诊测试（node:test + node:assert/strict，零依赖）。
 *
 * 覆盖来源：
 *   - hub/test/triage.test.ts —— 22 例**全部移植**，标题逐字保留，便于对照。
 *   - 本次移植新增 —— DEFAULT_TRIAGE_CONFIG 与 triageSchema 默认值逐条对齐
 *     （含唯一一处有意偏离 intent_words ∪ {'帮'}）、resolveTriageConfig 补默认值、
 *     忽略原因落盘（markIgnored / IGNORED_NO_MENTION，hub 修过的真 bug）、
 *     纯函数性（不改配置、不改输入批次）、@ 与不 @ 只改解释不改判据这条边界。
 *
 * 与 hub 的差别：hub 用 `triageSchema.parse({})` 取默认配置（zod），
 * 这里用同一个默认值常量 `DEFAULT_TRIAGE_CONFIG`——生产和测试仍然共用一份默认。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TRIAGE_CONFIG,
  HUB_INTENT_WORDS,
  IGNORED_NO_MENTION,
  findIntentHits,
  hasSubstance,
  markIgnored,
  resolveTriageConfig,
  selectContextMessages,
  stripMentions,
  triageMessage,
} from '../lib/feishu/triage.js'

/** 用默认值当基线——测试和生产走同一份默认 */
const CFG = DEFAULT_TRIAGE_CONFIG

function triage(text, directAddress = true) {
  return triageMessage({ text, directAddress, config: CFG })
}

/** 带覆盖项的配置（等价于 hub 的 triageSchema.parse({...})） */
function triageWith(text, directAddress, overrides) {
  return triageMessage({ text, directAddress, config: resolveTriageConfig(overrides) })
}

/** 造一条入站消息（只填 selectContextMessages 用得到的字段） */
function msg(id, principal, text = 'x') {
  return {
    message_id: id,
    dedupe_key: id,
    event_id: null,
    chat_id: 'oc_1',
    chat_type: 'group',
    message_type: 'text',
    thread_id: null,
    sender_open_id: principal,
    sender_principal: principal,
    mentions: [],
    text,
    raw_content: '',
    create_time: null,
    received_at: `2026-01-01T00:00:0${id.slice(-1)}Z`,
    consumed_by: [],
    ignored_reason: null,
  }
}

/* ------------------------------------------------------------------ *
 * hub/test/triage.test.ts —— 逐例移植（标题逐字保留）
 * ------------------------------------------------------------------ */

test('「111」@ 了机器人也不算需求——这是截图里那张卡的成因', () => {
  const v = triage('@_user_1 111')
  assert.equal(v.kind, 'ping', `实际 ${v.kind}：${v.reason}`)
  assert.equal(v.has_intent, false)
  assert.equal(v.substantive, false)
})

test('各种"测试一下在不在"都被挡下：11 / 123123 / test / ...', () => {
  for (const text of ['@_user_1 11', '@_user_1 123123', '@_user_1 ...', '@_user_1 aaa', '@_user_1 ？？？', '@_user_1 333']) {
    const v = triage(text)
    assert.equal(v.kind, 'ping', `${text} 应该被挡住，实际 ${v.kind}（${v.reason}）`)
  }
  // hub 标题里的 'test' 恰好 4 个字符，刚好过得了长度闸门，所以它不是 ping；
  // 但它同样**不建单**（没有诉求词 → status）。两条路都不长需求卡，这正是目的。
  assert.equal(triage('@_user_1 test').kind, 'status', '4 字符的 test：过闸门但不建单')
})

test('纯 @ 机器人（没有正文）→ ping', () => {
  const v = triage('@_user_1')
  assert.equal(v.kind, 'ping')
  assert.match(v.reason, /只有 @/)
})

test('「在吗」是点名，回一声但不建单', () => {
  const v = triage('@_user_1 在吗')
  assert.equal(v.kind, 'ping')
  assert.match(v.reason, /点名/)
})

test('有实质内容但没提要求 → 不建单（status）', () => {
  const v = triage('@_user_1 支付重试这块')
  assert.equal(v.kind, 'status')
  assert.equal(v.substantive, true, '它有实质内容')
  assert.equal(v.has_intent, false, '但没表达诉求')
  assert.match(v.reason, /没有表达诉求/)
})

test('有实质内容 + 表达诉求 → 建单（唯一会建单的一类）', () => {
  for (const text of [
    '@_user_1 支付超时要支持重试三次',
    '@_user_1 把这个接口改成异步的',
    '@_user_1 麻烦修复一下导出乱码',
    '@_user_1 新增一个批量删除功能',
  ]) {
    const v = triage(text)
    assert.equal(v.kind, 'requirement', `${text} 应该建单，实际 ${v.kind}：${v.reason}`)
    assert.equal(v.has_intent, true)
    assert.ok(v.intent_hits.length > 0, '要能说清是哪个词触发的')
  }
})

test('带诉求词的问句归需求——"能不能加个重试？"是要东西', () => {
  const v = triage('@_user_1 能不能加个重试？')
  assert.equal(v.kind, 'requirement', v.reason)
})

test('不带诉求词的问句归提问——不建单', () => {
  const v = triage('@_user_1 这个怎么配置？')
  assert.equal(v.kind, 'question', v.reason)
})

test('寒暄与应答静默——群里回"好的""收到"是纯噪音', () => {
  for (const text of ['@_user_1 好的', '@_user_1 收到', '@_user_1 谢谢', '@_user_1 ok', '@_user_1 辛苦啦']) {
    const v = triage(text)
    assert.equal(v.kind, 'smalltalk', `${text} 应该是寒暄，实际 ${v.kind}`)
  }
})

test('进度同步有信息量但不建单（该进记忆，不是需求）', () => {
  const v = triage('@_user_1 支付重试已经上线了')
  assert.equal(v.kind, 'status', v.reason)
})

test('报结果 vs 提要求：同一批词靠完成态区分（最容易判反的一处）', () => {
  // 这三句里有"上线/发布/修"这些**同时在诉求词表里**的词
  for (const text of ['@_user_1 这个已经发布了', '@_user_1 导出乱码修好了', '@_user_1 订单接口跑通了']) {
    assert.equal(triage(text).kind, 'status', `${text} 是报结果`)
  }
  // 同样含这些词，但句子没有收尾的完成态 → 是提要求
  for (const text of ['@_user_1 上线这个功能', '@_user_1 发布一下新版本', '@_user_1 修一下导出乱码']) {
    assert.equal(triage(text).kind, 'requirement', `${text} 是提要求`)
  }
})

test('require_intent 关掉后退回旧行为（@ 我即需求）——不推荐但可配', () => {
  const v = triageWith('@_user_1 支付重试这块', true, { require_intent: false })
  assert.equal(v.kind, 'requirement', '关掉诉求要求后就建单了')
})

test('min_substance_chars 可调：调高会把更长的消息也挡下', () => {
  const v = triageWith('@_user_1 加个重试', true, { min_substance_chars: 20 })
  assert.equal(v.kind, 'ping', `4 个字低于阈值 20，实际 ${v.kind}`)
})

test('诉求词表可加：团队自己的说法能被认出来', () => {
  const v = triageWith('@_user_1 整一个导出功能', true, { intent_words: ['要', '整一个'] })
  assert.equal(v.kind, 'requirement', v.reason)
  assert.deepEqual(v.intent_hits, ['整一个'])
})

test('配置里写错的正则不会让整条消息处理挂掉', () => {
  const v = triageWith('@_user_1 这个怎么配？', true, {
    question_patterns: ['([unclosed', '[?？]$'],
  })
  assert.equal(v.kind, 'question', '合法的那个正则仍然生效')
})

test('hasSubstance：短、重复字符、纯数字、纯标点都不算实质内容', () => {
  assert.equal(hasSubstance('111', 4), false)
  assert.equal(hasSubstance('。。。', 4), false)
  assert.equal(hasSubstance('123123', 4), false)
  assert.equal(hasSubstance('---', 4), false)
  assert.equal(hasSubstance('ab', 4), false, '太短')

  assert.equal(hasSubstance('加个重试', 4), true)
  assert.equal(hasSubstance('支付要支持重试', 4), true)
  // 重复字符判定是"整串同一个字符"，不能误伤正常文本
  assert.equal(hasSubstance('重试三次', 4), true)
})

test('stripMentions 去掉 @ 提及与多余空白', () => {
  assert.equal(stripMentions('@_user_1 加个重试'), '加个重试')
  assert.equal(stripMentions('@张三 看下这个'), '看下这个')
  assert.equal(stripMentions('@_user_1'), '')
})

test('findIntentHits 报出命中的词（人问"为什么算需求"时要答得出来）', () => {
  assert.deepEqual(findIntentHits('麻烦修复一下', ['麻烦', '修复']), ['麻烦', '修复'])
  assert.deepEqual(findIntentHits('支付重试这块', ['要', '修复']), [])
})

test('只取触发消息往回、同一发件人连续说的话（别人插话就是话题边界）', () => {
  const batch = [
    msg('m1', 'human:zhang'),
    msg('m2', 'human:chen'),
    msg('m3', 'human:chen'),
    msg('m4', 'human:chen'), // 触发消息
  ]
  const picked = selectContextMessages(batch, batch[3], 6)
  assert.deepEqual(picked.map((m) => m.message_id), ['m2', 'm3', 'm4'], '不应把 zhang 的话吞进来')
})

test('窗口上限生效（默认 6）', () => {
  const batch = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 'human:chen'))
  const picked = selectContextMessages(batch, batch[9], 3)
  assert.deepEqual(picked.map((m) => m.message_id), ['m7', 'm8', 'm9'])
})

test('触发消息不在批次里时只处理它自己，不猜上下文', () => {
  const batch = [msg('m1', 'human:chen')]
  const other = msg('m9', 'human:chen')
  const picked = selectContextMessages(batch, other, 6)
  assert.deepEqual(picked.map((m) => m.message_id), ['m9'])
})

test('截图场景：111 / 11 / @机器人 123123 连发 → 三条都不构成需求', () => {
  // 分诊是逐条判的：触发消息是那条 @，它是 ping
  const trigger = triage('@_user_1 123123')
  assert.equal(trigger.kind, 'ping')
  // 而且批次边界会把它们圈在一起（同一发件人连续），但因为是 ping，
  // 整批都不会进需求提取——这正是要的结果
  const batch = [msg('m1', 'human:wang', '111'), msg('m2', 'human:wang', '11'), msg('m3', 'human:wang', '@_user_1 123123')]
  const picked = selectContextMessages(batch, batch[2], 6)
  assert.equal(picked.length, 3, '同一发件人的连着三条会被圈成一批')
  assert.equal(triage(picked[2].text).kind, 'ping', '但整批按触发消息分诊 → 不建单')
})

/* ------------------------------------------------------------------ *
 * 本次移植新增
 * ------------------------------------------------------------------ */

test('DEFAULT_TRIAGE_CONFIG 能被直接当 config 用：@ 了机器人 + 正常请求 → requirement', () => {
  const v = triageMessage({
    text: '@bot 帮我把重试加上',
    directAddress: true,
    config: DEFAULT_TRIAGE_CONFIG,
  })
  assert.equal(v.kind, 'requirement', `${v.kind}：${v.reason}`)
  assert.equal(v.cleaned, '帮我把重试加上')
  assert.deepEqual(v.intent_hits, ['帮'])
})

test('DEFAULT_TRIAGE_CONFIG 与 hub 的 triageSchema 默认值逐条对齐（intent_words 多一个"帮"）', () => {
  // 逐条对照 hub/src/config/schema.ts:174-235 与
  // hub/team-hub/config/workflow.yaml:114-156
  assert.equal(DEFAULT_TRIAGE_CONFIG.reaction, 'Get')
  assert.equal(DEFAULT_TRIAGE_CONFIG.require_intent, true)
  assert.equal(DEFAULT_TRIAGE_CONFIG.min_substance_chars, 4)
  assert.equal(DEFAULT_TRIAGE_CONFIG.min_confidence_for_card, 0.45)
  assert.equal(DEFAULT_TRIAGE_CONFIG.context_window, 6)
  assert.deepEqual(DEFAULT_TRIAGE_CONFIG.question_patterns, [
    '[?？]$',
    '^(怎么|如何|为什么|为啥|什么时候|谁|哪个|是否)',
  ])
  assert.equal(DEFAULT_TRIAGE_CONFIG.smalltalk_patterns.length, 1)
  assert.match('辛苦啦', new RegExp(DEFAULT_TRIAGE_CONFIG.smalltalk_patterns[0]))

  // hub 的 32 个词原样保留可查；默认值 = 那 32 个 + '帮'
  assert.equal(HUB_INTENT_WORDS.length, 32)
  assert.equal(HUB_INTENT_WORDS.includes('帮忙'), true)
  assert.deepEqual(DEFAULT_TRIAGE_CONFIG.intent_words, [...HUB_INTENT_WORDS, '帮'])

  // 偏离的理由本身也要有回归：hub 原表对"帮我把重试加上"一个词都不命中
  assert.deepEqual(findIntentHits('帮我把重试加上', HUB_INTENT_WORDS), [])
  assert.deepEqual(findIntentHits('帮我把重试加上', DEFAULT_TRIAGE_CONFIG.intent_words), ['帮'])
})

test('resolveTriageConfig 用部分配置补齐默认值（只写 intent_words 也不会炸）', () => {
  const cfg = resolveTriageConfig({ intent_words: ['整一个'] })
  assert.equal(cfg.min_substance_chars, 4)
  assert.equal(cfg.require_intent, true)
  const v = triageMessage({ text: '@bot 整一个导出功能', directAddress: true, config: cfg })
  assert.equal(v.kind, 'requirement', v.reason)
  // null / undefined 直接拿默认值
  assert.equal(resolveTriageConfig(null), DEFAULT_TRIAGE_CONFIG)
  assert.equal(resolveTriageConfig(undefined), DEFAULT_TRIAGE_CONFIG)
})

test('@ 与不 @ 只改解释文案，不改判据（放宽发生在 extract，不在分诊）', () => {
  const addressed = triage('@_user_1 支付重试这块', true)
  const inGroup = triage('支付重试这块', false)
  assert.equal(addressed.kind, 'status')
  assert.equal(inGroup.kind, 'status')
  assert.match(addressed.reason, /@ 只代表要我回应/)
  assert.match(inGroup.reason, /没有发现表达诉求的词/)
})

test('忽略原因落盘：非需求消息被标上 ignored_reason，同一原因不重复改写', () => {
  const batch = [msg('m1', 'human:chen', '111'), msg('m2', 'human:chen', '123123')]
  const verdict = triage(batch[0].text)
  const marked = markIgnored(batch, verdict.reason)
  assert.equal(marked.length, 2)
  for (const m of marked) assert.equal(m.ignored_reason, verdict.reason)
  // 已经是同一原因的那条原样返回（同一对象引用）→ 调用方据此跳过重复写库
  const again = markIgnored(marked, verdict.reason)
  assert.equal(again[0], marked[0])
  assert.notEqual(again[0], batch[0], '第一次标记必须产出新对象，不能就地改输入')
})

test('群里没 @ 机器人的消息必须标成忽略 + 原因（否则会被之后的新需求当正文吞掉）', () => {
  // hub 修过的真 bug：不标的话它一直留在"未消费"集合里，
  // 而取上下文拿的就是未消费消息 → 之后任何新需求都会把它吞进正文
  const junk = [msg('m1', 'human:wang', '总结一下'), msg('m2', 'human:wang', '1221')]
  const marked = markIgnored(junk, IGNORED_NO_MENTION)
  assert.equal(IGNORED_NO_MENTION, '群里未 @ 机器人，不进需求', '原因字符串逐字来自 hub')
  assert.deepEqual(marked.map((m) => m.ignored_reason), [IGNORED_NO_MENTION, IGNORED_NO_MENTION])
  // 原文还在（ignored_reason 是"看过、不处理"，不是"删掉"）
  assert.deepEqual(marked.map((m) => m.text), ['总结一下', '1221'])
  // 输入批次没有被就地改
  assert.deepEqual(junk.map((m) => m.ignored_reason), [null, null])
})

test('分诊是纯函数：不改配置、不改输入批次', () => {
  assert.equal(Object.isFrozen(DEFAULT_TRIAGE_CONFIG), true)
  const before = JSON.stringify(DEFAULT_TRIAGE_CONFIG)
  triage('@_user_1 支付超时要支持重试三次')
  triage('@_user_1 111')
  assert.equal(JSON.stringify(DEFAULT_TRIAGE_CONFIG), before)

  const batch = [msg('m1', 'human:chen'), msg('m2', 'human:chen')]
  const snapshot = JSON.stringify(batch)
  selectContextMessages(batch, batch[1], 6)
  assert.equal(JSON.stringify(batch), snapshot, 'selectContextMessages 只读输入')
})
