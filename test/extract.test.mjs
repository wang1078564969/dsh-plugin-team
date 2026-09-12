/*
 * 需求提取测试（node:test + node:assert/strict，零依赖）。
 *
 * 覆盖来源：
 *   - hub/test/extract.test.ts —— 21 例**全部移植**，标题逐字保留，便于对照。
 *   - 本次移植新增 —— @ 了但整句没有"诉求词"仍要收（对照没 @ 时的同一句话）、
 *     置信度 < 0.4 才追问一次（decideIngestAsk 闸门 + 规则路径的真实取值）、
 *     忽略原因落盘、重复识别（含仓库 0.1 加权与阈值行为）、
 *     extract 用的是 events.ts 那版 stripMentions（`@张三` 不会被去掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  collectCriteria,
  collectRepos,
  decideAsk,
  decideIngestAsk,
  derivePriority,
  deriveTitle,
  extractRequirement,
  findDuplicate,
  isNoise,
  isQuestion,
  prefixOverlap,
  similarity,
  splitProblemProposal,
} from '../lib/feishu/extract.js'
import { markIgnored, stripMentions } from '../lib/feishu/triage.js'

let seq = 0

/** 造一条入站消息（只填 extractRequirement 用得到的字段） */
function msg(text, opts = {}) {
  seq += 1
  const id = opts.id ?? `om_${seq}`
  return {
    message_id: id,
    dedupe_key: id,
    event_id: null,
    chat_id: 'oc_req_pay',
    chat_type: 'group',
    message_type: 'text',
    thread_id: null,
    sender_open_id: 'ou_chen_req',
    sender_principal: opts.sender ?? 'human:chen-req',
    mentions: [],
    text,
    raw_content: '',
    create_time: null,
    received_at: new Date('2026-02-03T10:00:00Z').toISOString(),
    consumed_by: [],
    ignored_reason: null,
  }
}

/** 造一条"已有需求"（findDuplicate 的 existing 形状） */
function existing(id, title, repos) {
  return repos === undefined ? { id, title } : { id, title, repos }
}

/* ------------------------------------------------------------------ *
 * hub/test/extract.test.ts —— 逐例移植（标题逐字保留）
 * ------------------------------------------------------------------ */

test('聊天噪音被识别：问候、确认、单表情都不算需求', () => {
  for (const t of ['好的', '收到', 'OK', '嗯嗯', '谢谢', '👍', '在吗', '?', '哈哈']) {
    assert.equal(isNoise(t), true, `"${t}" 应判为噪音`)
  }
  assert.equal(isNoise('支付失败要能自动重试'), false)
})

test('没 @ 时，提问与需求分开：带诉求词的问句归需求', () => {
  assert.equal(isQuestion('这个重试怎么配置？'), true)
  assert.equal(isQuestion('为什么失败了？'), true)
  // 带诉求词 → 是需求，不是提问
  assert.equal(isQuestion('能不能加个重试？'), false)
})

test('从一条完整消息里抽出标题、验收标准、优先级、仓库', () => {
  const r = extractRequirement([
    msg('@_user_1 pay-service 支付失败要能自动重试，必须重试 3 次，不能重复扣款。P1'),
  ], { knownRepos: ['pay-service'] })

  assert.ok(r.draft !== null)
  if (r.draft === null) return
  assert.ok(r.draft.title.includes('支付失败'), r.draft.title)
  assert.equal(r.draft.priority, 'P1')
  assert.deepEqual(r.draft.repos, ['pay-service'])
  assert.ok(r.draft.acceptance_criteria.length >= 2, '应抽出"必须重试 3 次""不能重复扣款"')
  assert.ok(r.confidence > 0.6, `置信度应偏高，实际 ${r.confidence}`)
})

test('紧急信号抬优先级：P0 / 线上挂了', () => {
  assert.equal(derivePriority(['线上支付挂了，要紧急修复']), 'P0')
  assert.equal(derivePriority(['这个不急，以后再说']), 'P3')
  assert.equal(derivePriority(['支持一下重试']), 'P2')
})

test('多天消息合并成一条需求（群聊是一段对话）', () => {
  const r = extractRequirement([
    msg('支付最近老是失败', { id: 'm1' }),
    msg('要能自动重试，必须重试三次', { id: 'm2' }),
  ])
  assert.ok(r.draft !== null)
  if (r.draft === null) return
  assert.equal(r.draft.source_message_ids.length, 2, '要能回溯到两条来源消息')
  assert.ok(r.draft.acceptance_criteria.some((c) => c.includes('三次')), JSON.stringify(r.draft.acceptance_criteria))
})

test('问题与方案分开：别把方案当成既成事实塞进问题里', () => {
  const { problem, proposal } = splitProblemProposal([
    '支付失败后用户直接流失了；应该加一个重试入口',
  ])
  assert.ok(problem.includes('流失'), problem)
  assert.ok(proposal.includes('重试'), proposal)
})

test('没 @ 机器人时，抽不出诉求词如实返回 null，不硬造需求', () => {
  const r = extractRequirement([msg('今天天气不错')], { directAddress: false })
  assert.equal(r.draft, null)
  assert.ok(r.reason.includes('诉求'), r.reason)
})

test('@ 了机器人时不受诉求词限制：人 @ 你就是让你处理', () => {
  const r = extractRequirement([msg('支付重试这块')], { directAddress: true })
  assert.ok(r.draft !== null, '不该被固定词表挡住')
  assert.ok(r.reason.includes('直接 @'), r.reason)
  assert.ok(r.confidence >= 0.4, `置信度不该被压低：${r.confidence}`)
})

test('@ 了机器人但只是寒暄 → 仍然不建单', () => {
  for (const t of ['谢谢', '辛苦了', '收到', '👍', '好的']) {
    const r = extractRequirement([msg(t)], { directAddress: true })
    assert.equal(r.draft, null, `"${t}" 不该被当成需求`)
    assert.ok(r.reason.includes('寒暄'), r.reason)
  }
})

test('@ 了机器人但去掉 @ 后没内容 → 不建单', () => {
  const r = extractRequirement([msg('@_user_1')], { directAddress: true })
  assert.equal(r.draft, null)
})

test('全是被 @ 占位符的消息不产生需求', () => {
  const r = extractRequirement([msg('@_user_1')])
  assert.equal(r.draft, null)
})

test('验收标准最多取 8 条，避免卡片被撑爆', () => {
  const many = Array.from({ length: 20 }, (_, i) => `必须满足条件 ${i}`).join('；')
  assert.ok(collectCriteria([many]).length <= 8)
})

test('标题过长时截断并加省略号', () => {
  const title = deriveTitle('支付失败要能自动重试'.repeat(6))
  assert.ok(title.length <= 40, `实际 ${title.length}`)
  assert.ok(title.endsWith('…'))
})

test('仓库只在已知清单里识别，不猜', () => {
  assert.deepEqual(collectRepos(['改了 pay-service 和 unknown-svc'], ['pay-service']), ['pay-service'])
  assert.deepEqual(collectRepos(['改了别的'], ['pay-service']), [])
})

test('同一件事的两种说法被识别为重复（前缀命中）', () => {
  const a = '支付失败要能自动重试，必须重试 3 次'
  const b = '支付失败要能自动重试，另外要记录埋点'
  assert.ok(prefixOverlap(a, b) > 0.6, '前缀命中应给高权重')
  const dup = findDuplicate(
    { title: a, problem: '', proposal: '', acceptance_criteria: [], priority: 'P2', repos: [], requester: null, excerpts: [], source_message_ids: [] },
    [{ id: 'req-1', title: b }],
  )
  assert.equal(dup?.id, 'req-1')
})

test('不相干的需求不会被误判为重复', () => {
  const dup = findDuplicate(
    { title: '支付失败要能自动重试', problem: '', proposal: '', acceptance_criteria: [], priority: 'P2', repos: [], requester: null, excerpts: [], source_message_ids: [] },
    [{ id: 'req-9', title: '客户端启动变慢需要优化' }],
  )
  assert.equal(dup, null)
})

test('虚词不影响相似度判定', () => {
  const a = '支付要支持重试'
  const b = '支付需要支持重试'
  assert.ok(similarity(a, b) > 0.5, '剔掉"需要"之后应该很像')
})

test('信息齐全时不追问', () => {
  const r = extractRequirement([msg('要支持重试，必须重试三次')])
  const ask = decideAsk(r, { askedCount: 0, passive: false })
  assert.equal(ask.shouldAsk, false)
  assert.ok(ask.reason.includes('齐全'))
})

test('缺验收标准且有追问额度时问一次，问题必须具体', () => {
  const ask = decideAsk(
    {
      draft: { title: '支付要支持重试', problem: '', proposal: '', acceptance_criteria: [], priority: 'P2', repos: [], requester: null, excerpts: [], source_message_ids: [] },
      reason: '缺验收标准',
      missing: ['acceptance_criteria'],
      confidence: 0.5,
    },
    { askedCount: 0, passive: false },
  )
  assert.equal(ask.shouldAsk, true)
  assert.ok(ask.question?.includes('怎样算做完'), '追问要具体到能回答')
})

test('已经问过一次就转被动，不重复打扰', () => {
  const ask = decideAsk(
    {
      draft: { title: 'x', problem: '', proposal: '', acceptance_criteria: [], priority: 'P2', repos: [], requester: null, excerpts: [], source_message_ids: [] },
      reason: '缺验收标准',
      missing: ['acceptance_criteria'],
      confidence: 0.5,
    },
    { askedCount: 1, passive: false },
  )
  assert.equal(ask.shouldAsk, false)
  assert.ok(ask.reason.includes('被动'))
})

test('还没判定成需求时不追问', () => {
  const ask = decideAsk({ draft: null, reason: '噪音', missing: [], confidence: 0 }, { askedCount: 0, passive: false })
  assert.equal(ask.shouldAsk, false)
})

/* ------------------------------------------------------------------ *
 * 本次移植新增
 * ------------------------------------------------------------------ */

test('@ 了但整句没有"诉求词"仍然要收（词表只用于没 @ 机器人的群）', () => {
  const text = '支付重试这块'
  const addressed = extractRequirement([msg(text)], { directAddress: true })
  assert.ok(addressed.draft !== null, '@ 了就是最强意图信号，不该被固定词表否决')
  assert.equal(addressed.draft.title, text)

  // 同一句话没 @ 机器人时，词表才用来判断"值不值得当需求"
  const inGroup = extractRequirement([msg(text)], { directAddress: false })
  assert.equal(inGroup.draft, null)
  assert.ok(inGroup.reason.includes('诉求'), inGroup.reason)
  assert.equal(inGroup.confidence, 0.2)
})

test('置信度 < 0.4 才追问一次：录入阶段不追问，追问只以决策结构返回', () => {
  const draft = (title) => ({ title, problem: '', proposal: '', acceptance_criteria: [], priority: 'P2', repos: [], requester: null, excerpts: [], source_message_ids: [] })
  const missingCriteria = { draft: draft('支付要支持重试'), reason: '缺验收标准', missing: ['acceptance_criteria'], confidence: 0.3 }

  // 没 @ 机器人 + 置信度 < 0.4 + 还没问过 → 这一次会追问（且只返回结构，不发消息）
  const ask = decideIngestAsk(missingCriteria, { askedCount: 0, passive: false }, { directAddress: false })
  assert.equal(ask.shouldAsk, true)
  assert.ok(ask.question.includes('怎样算做完'))
  assert.equal(ask.reason, '缺 acceptance_criteria')

  // 同样的缺失，但置信度够高（≥ 0.4）→ 录入阶段不拦人，缺什么标在卡上
  const enough = decideIngestAsk({ ...missingCriteria, confidence: 0.5 }, { askedCount: 0, passive: false }, { directAddress: false })
  assert.equal(enough.shouldAsk, false)
  assert.equal(enough.question, null)
  assert.ok(enough.reason.includes('录入阶段不追问'))

  // 直接 @ 的话，连"缺验收标准"都不追问（人 @ 你是想让你干活，不是想回答问卷）
  const addressed = decideIngestAsk(missingCriteria, { askedCount: 0, passive: false }, { directAddress: true })
  assert.equal(addressed.shouldAsk, false)

  // 追问额度只有一次：已经问过就转被动
  const twice = decideIngestAsk(missingCriteria, { askedCount: 1, passive: false }, { directAddress: false })
  assert.equal(twice.shouldAsk, false)
  assert.ok(twice.reason.includes('被动'))
})

test('规则路径不会产出「有 draft 但置信度 < 0.4」——那种情况只会是 draft === null', () => {
  // 置信度公式的下限就是 0.4（直接 @ 再多 0.15），所以 < 0.4 只可能出现在
  // 「判不成需求」的返回里；那时 decideAsk 本来就不追问，录入阶段也不会发消息。
  const noIntent = extractRequirement([msg('今天天气不错')], { directAddress: false })
  assert.equal(noIntent.draft, null)
  assert.ok(noIntent.confidence < 0.4, `实际 ${noIntent.confidence}`)
  const ask = decideIngestAsk(noIntent, { askedCount: 0, passive: false }, { directAddress: false })
  assert.equal(ask.shouldAsk, false)
  assert.ok(ask.reason.includes('还没判定成需求'))
})

test('忽略原因落盘：抽不出需求时把原因写成 ignored_reason（供上层落库）', () => {
  const batch = [msg('今天天气不错', { id: 'm1' }), msg('111', { id: 'm2' })]
  const r = extractRequirement(batch, { directAddress: false })
  assert.equal(r.draft, null)
  assert.ok(r.reason.length > 0)
  const marked = markIgnored(batch, r.reason)
  assert.deepEqual(marked.map((m) => m.ignored_reason), [r.reason, r.reason])
  assert.deepEqual(marked.map((m) => m.message_id), ['m1', 'm2'], '消息仍在，只是标了原因')
  assert.deepEqual(batch.map((m) => m.ignored_reason), [null, null], '输入批次不被就地改')
})

test('重复识别：同一诉求短时间内反复出现 → 命中已有需求，不新建', () => {
  // hub 的"短时间内"在 pipeline 的挂靠逻辑里（最近 2 小时还有活动），纯函数层
  // 只做文本判据；这里把窗口过滤显式写在测试里，模拟那一步。
  const now = Date.parse('2026-02-03T10:30:00Z')
  const windowMs = 2 * 3_600_000
  const open = [
    { id: 'req-100', title: '支付失败要能自动重试，必须重试 3 次', repos: ['pay-service'], updatedAt: now - 30 * 60_000 },
    { id: 'req-099', title: '客户端启动变慢需要优化', repos: ['app-client'], updatedAt: now - 20 * 3_600_000 },
  ]
  const inWindow = open.filter((r) => now - r.updatedAt <= windowMs)
  assert.deepEqual(inWindow.map((r) => r.id), ['req-100'], '陈年需求不参与挂靠')

  // 同一诉求被群里换个说法又说了一遍 → 每次都命中同一条已开需求
  for (const title of [
    '支付失败要能自动重试，另外要记录埋点',
    '支付失败要能自动重试，还要能手动触发',
  ]) {
    const dup = findDuplicate(
      { title, problem: '', proposal: '', acceptance_criteria: [], priority: 'P2', repos: ['pay-service'], requester: null, excerpts: [], source_message_ids: [] },
      inWindow.map((r) => ({ id: r.id, title: r.title, repos: r.repos })),
    )
    assert.equal(dup?.id, 'req-100', `"${title}" 应该并入 req-100，而不是新建`)
    assert.ok(dup.score >= 0.6, `分数 ${dup.score}`)
  }
})

test('重复识别的判据逐字保留：仓库命中加 0.1，阈值可调，取分数最高的一条', () => {
  const d = (title, repos) => ({ title, problem: '', proposal: '', acceptance_criteria: [], priority: 'P2', repos, requester: null, excerpts: [], source_message_ids: [] })

  // 文本相似度 0.5（无前缀命中）→ 不加权时低于默认阈值 0.6
  const draft = d('支付失败要能自动重试', ['pay-service'])
  assert.equal(similarity(draft.title, '订单支付失败自动重试'), 0.5)
  assert.equal(prefixOverlap(draft.title, '订单支付失败自动重试'), 0)
  assert.equal(findDuplicate(draft, [existing('req-1', '订单支付失败自动重试')]), null)

  // 同仓库 → +0.1 → 刚好过 0.6
  const withRepo = findDuplicate(draft, [existing('req-1', '订单支付失败自动重试', ['pay-service'])])
  assert.equal(withRepo?.id, 'req-1')
  assert.equal(withRepo.score, 0.6)

  // 阈值可调：抬高到 0.7 就不再算重复
  assert.equal(findDuplicate(draft, [existing('req-1', '订单支付失败自动重试', ['pay-service'])], 0.7), null)

  // 多条都命中时取分数最高的那条（prefixOverlap 命中直接给到 1）
  const best = findDuplicate(draft, [
    existing('req-1', '订单支付失败自动重试', ['pay-service']),
    existing('req-2', '支付失败要能自动重试功能', ['pay-service']),
  ])
  assert.equal(best?.id, 'req-2')
  assert.equal(best.score, 1)
})

test('extract 用的是 events.ts 那版 stripMentions：`@张三` 不会被去掉（与 triage 那版不同，逐字对齐 hub）', () => {
  // hub 的 extract.ts 从 feishu/events.ts 引入 stripMentions，只去 @_user_\d+ / @_all；
  // triage.ts 自己那份连真实姓名一起去。这个差异是 hub 的行为，这里显式钉住。
  assert.equal(stripMentions('@张三 支付要支持重试'), '支付要支持重试', 'triage 那版会去掉 @张三')
  const r = extractRequirement([msg('@张三 支付要支持重试')], { directAddress: true })
  assert.ok(r.draft !== null)
  assert.equal(r.draft.title, '@张三 支付要支持重试', 'extract 那版保留了姓名前缀（hub 原样行为）')
  // '要' 在诉求词表里，所以没 @ 时也照样能抽出草稿
  const inGroup = extractRequirement([msg('@张三 支付要支持重试')], { directAddress: false })
  assert.equal(inGroup.draft.title, '@张三 支付要支持重试')
})
