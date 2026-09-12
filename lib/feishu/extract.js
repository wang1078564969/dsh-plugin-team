/*
 * 来源：hub/src/runtime/extract.ts（431 行）—— 逐字移植：extractRequirement /
 *   isPureSmalltalk / isNoise / isQuestion / splitCriteriaSegments / collectCriteria /
 *   deriveTitle / splitProblemProposal / derivePriority / collectRepos / findDuplicate /
 *   prefixOverlap / similarity / decideAsk，以及全部私有常量（INTENT_WORDS /
 *   CRITERIA_WORDS / NOISE_PATTERNS / QUESTION_PATTERNS / PRIORITY_PATTERNS /
 *   STOPWORDS / splitSentences / normalize / clamp01）。
 *   另加一个导出 decideIngestAsk：hub 把「信息不足才追问」的最后一道闸门
 *   （`hopeless`）写在 pipeline.ts:505-517，不在 extract.ts 里；不搬过来，
 *   「只有置信度 < 0.4 才追问一次」这条规则就只活在上层，无法离线测试。
 *
 * 改了什么：
 *   1. TS → 纯 ESM JavaScript，零依赖。RequirementDraft / ExtractionResult /
 *      ExtractionFallback / ExtractorOptions / AskPolicy / AskDecision 改成
 *      JSDoc @typedef；返回结构一个字段没动。
 *   2. `extractRequirement` 保持**同步**，`opts.fallback` 与 hub 一样
 *      **接受但不调用**（hub 里也从未调用，见下面「没能保住」一节）。
 *   3. 新增 decideIngestAsk(result, policy, { directAddress })，逐字复刻
 *      pipeline.ts:511-513 的闸门 + decideAsk，纯函数、只返回决策结构，
 *      **不发送任何消息**（录入阶段不追问）。
 *   4. `stripMentions` 用 hub/src/feishu/events.ts:208-214 那一版（extract.ts
 *      本来就是 import 它），**不是** triage.js 那一版——见下面「显式保留的差异」。
 *
 * 显式保留的差异（是 hub 的行为，不是移植走样，但它会咬人）：
 *   - hub 里有两份 `stripMentions`。extract.ts 用的是 events.ts 那版：
 *     只去 `@_user_\d+` 与 `@_all`，**不去 `@张三` 这类真实姓名**。
 *     于是 `@张三 支付要支持重试` 抽出来的标题会带上前缀 `@张三`。
 *     这里逐字保留（否则会改变 hub 的抽取结果）。上层如果拿到的是原始
 *     飞书文本（姓名没被渲染成占位符），应当先用 triage.js 的 stripMentions
 *     清洗再送进来。
 *   - extract.ts 的诉求词表是**内置常量**，不可配置；triage 的 `intent_words`
 *     才是配置项。两者在 hub 里就是不对称的，保留原样（改它会改动抽取判据）。
 *
 * 没能保住的语义（显式列出，绝不静默丢弃）：
 *   - **`ExtractionFallback`（LLM 兜底）只有接口，没有调用点**。hub 声明了
 *     `ExtractionFallback` / `ExtractorOptions.fallback`，但 `extractRequirement`
 *     从头到尾没读过 `opts.fallback`——它是同步函数，规则判不出来就返回 `draft: null`。
 *     这里保持同一契约：字段照旧接受、照旧不调用。没有替它发明"规则失败就 await
 *     兜底"的行为，因为那会改变 `null` 的含义、`confidence` 的取值与调用方的
 *     异步边界。真正的接线留给上层（`draft === null` 时自行决定要不要调兜底）。
 *   - TS 类型只剩 JSDoc，编译期检查没了。
 *   - `splitSentences` 与 hub 一样不导出（只在 deriveTitle / splitProblemProposal 内部用）。
 *   - **时间维度不在这个模块**：「同一诉求短时间内反复出现」里的"短时间内"不是
 *     `findDuplicate` 的判据（它只比文本），而是 hub pipeline 挂靠逻辑里的
 *     "最近 2 小时内还有活动"（pipeline.ts:625-640）。那块需要 Requirement 对象形状
 *     与一个时钟，纯函数层给不了，未移植；`findDuplicate` 保留的是文本判据本身。
 */

/* ------------------------------------------------------------------ *
 * 提取结果
 * ------------------------------------------------------------------ */

/**
 * 抽出来的需求草稿。
 *
 * @typedef {object} RequirementDraft
 * @property {string} title
 * @property {string} problem
 * @property {string} proposal
 * @property {string[]} acceptance_criteria
 * @property {'P0'|'P1'|'P2'|'P3'} priority
 * @property {string[]} repos 从消息里认出来的仓库/项目线索
 * @property {string|null} requester 提交人（第一个说话的人）
 * @property {string[]} excerpts 用到的消息（可回溯）
 * @property {string[]} source_message_ids
 */

/**
 * 一次提取的结论。
 *
 * @typedef {object} ExtractionResult
 * @property {RequirementDraft|null} draft 判为需求时为 draft，否则为 null
 * @property {string} reason 判定理由，日志与调试用
 * @property {Array<'title'|'acceptance_criteria'|'owner'>} missing 缺哪些必填项（用来决定要不要追问）
 * @property {number} confidence
 */

/**
 * LLM 兜底接口：规则判不出来时调用。
 *
 * **hub 只声明、从未调用**（extractRequirement 是同步函数）。这里保留同一契约，
 * 接线留给上层——见文件头「没能保住的语义」。
 *
 * @typedef {object} ExtractionFallback
 * @property {(input: {messages: Array<object>, hint?: string}) => Promise<RequirementDraft|null>} extract
 */

/**
 * @typedef {object} ExtractorOptions
 * @property {string[]} [knownRepos] 已知的仓库名，用于从消息里识别归属
 * @property {Map<string,string>} [defaultOwner] 项目名 → 默认负责人（用于补归属）
 * @property {ExtractionFallback} [fallback] LLM 兜底，可选（**不会**被 extractRequirement 调用）
 * @property {boolean} [directAddress]
 *   这条消息**直接 @ 了机器人**。
 *
 *   这是最强的意图信号：人特意 @ 你，就是让你处理这件事。
 *   所以此时**跳过"诉求词"这道判据**——用固定词表去否决一条直接提问，
 *   结果是"我 @ 了它，它说没发现诉求词"，那是纯粹的挫败。
 *
 *   固定词表的正确用途是另一件事：**没 @ 机器人时**，判断群里这句话
 *   值不值得当成需求（也就是 `groupRequireMention: false` 的场景）。
 */

/* ------------------------------------------------------------------ *
 * 规则的判据（全部可解释）
 * ------------------------------------------------------------------ */

/** 表达诉求的词：出现即可能是需求。内置、不可配置（hub 原样）。 */
const INTENT_WORDS = [
  '要', '需要', '应该', '希望', '支持', '新增', '增加', '加个', '加一个',
  '修复', '修一下', '优化', '改成', '实现', '做一个', '能不能', '可否',
  '要求', '必须', '不能', '别再', '麻烦',
]

/** 验收标准的信号词 */
const CRITERIA_WORDS = ['验收', '标准', '要求', '必须', '不能', '不准', '至少', '不超过', '不允许', '必须能']

/** 明确的非需求：聊天噪音 */
const NOISE_PATTERNS = [
  /^(好|好的|收到|ok|OK|Ok|嗯|嗯嗯|谢谢|多谢|辛苦|赞|👍|哈哈+|在吗|早上好|晚安)[!！。~\s]*$/,
  /^(?:\?|？)+$/,
  /^@_user_\d+$/,
]

/** 追问类：不是需求，是提问 */
const QUESTION_PATTERNS = [/[?？]$/, /^(怎么|如何|为什么|为啥|什么时候|谁|哪个|是否)/]

const PRIORITY_PATTERNS = [
  { re: /\bP0\b|紧急|线上(故障|事故)|挂了|崩了/, p: 'P0' },
  { re: /\bP1\b|尽快|高优/, p: 'P1' },
  { re: /\bP3\b|有空|不急|以后再说/, p: 'P3' },
]

/* ------------------------------------------------------------------ *
 * 提取
 * ------------------------------------------------------------------ */

/**
 * 需求提取：**从一批群消息里抽出需求**。
 *
 * 设计文档：team-agent-architecture/02-bots-and-requirements.md §3
 *
 * 为什么是"一批"而不是"一条"：群聊的语义本来就是一段对话，
 * 单条消息往往只有半句话（"支付又挂了" + "重试三次还是失败"）。
 * 挑哪几条进这一批是 selectContextMessages 的事（见 triage.js）。
 *
 * 为什么规则优先、LLM 可插拔：
 *   ① 规则版可以**完全离线测试**，也能在没有模型预算时降级运行
 *   ② 提取的判据是可解释的——出问题时能说清"为什么判定这是需求"
 *   ③ LLM 只在规则判不出来时兜底，成本可控（接口是 ExtractionFallback，
 *      但 hub 与这里都没有在规则路径里调用它）
 *
 * @param {Array<{text: string, message_id: string, sender_principal: string|null}>} messages
 * @param {ExtractorOptions} [opts]
 * @returns {ExtractionResult}
 */
export function extractRequirement(messages, opts = {}) {
  const usable = messages.filter((m) => m.text.trim() !== '')
  if (usable.length === 0) {
    return { draft: null, reason: '这一批消息里没有可用文本', missing: [], confidence: 0 }
  }

  const last = usable[usable.length - 1]
  const cleaned = usable.map((m) => stripMentions(m.text)).filter((t) => t !== '')
  if (cleaned.length === 0) {
    return { draft: null, reason: '去掉 @ 之后没有正文', missing: [], confidence: 0 }
  }

  /**
   * **直接 @ 了机器人 = 人明确要求处理**。
   *
   * 此时判据大幅放宽：既不用噪音词拦，也不用诉求词拦。
   * 只有"去掉 @ 之后确实没内容"（纯 @、单字寒暄）才不算。
   *
   * 为什么敢放宽：后面还有一道道门——需求对象落在 `draft` 要人确认、
   * 任务要人接受才开始、写操作有准入。**判错一条的代价是"多一张待确认的卡"，
   * 而不是"系统乱动"**。反过来，漏掉一条的代价是人觉得"@ 了也没用"。
   */
  const direct = opts.directAddress === true
  const substantive = direct
    ? cleaned.filter((t) => t.trim().length >= 2 && !isPureSmalltalk(t))
    : cleaned.filter((t) => !isNoise(t) && !isQuestion(t))

  if (substantive.length === 0) {
    return {
      draft: null,
      reason: direct ? '去掉 @ 之后只有寒暄，没有可处理的内容' : cleaned.some(isQuestion) ? '看起来是提问，不是需求' : '看起来是聊天噪音',
      missing: [],
      confidence: 0,
    }
  }

  // 没 @ 机器人的时候才用诉求词判断"这句话值不值得当成需求"
  const intentHits = direct
    ? substantive
    : substantive.filter((t) => INTENT_WORDS.some((w) => t.includes(w)))
  if (intentHits.length === 0) {
    return {
      draft: null,
      reason: '没有发现表达诉求的词（要/需要/修复/支持…）',
      missing: [],
      confidence: 0.2,
    }
  }

  const criteria = collectCriteria(substantive)
  const repos = collectRepos(substantive, opts.knownRepos ?? [])
  const title = deriveTitle(intentHits[0])
  const body = splitProblemProposal(intentHits)

  const draft = {
    title,
    problem: body.problem,
    proposal: body.proposal,
    acceptance_criteria: criteria,
    priority: derivePriority(substantive),
    repos,
    requester: last.sender_principal,
    excerpts: substantive.slice(0, 3),
    source_message_ids: usable.map((m) => m.message_id),
  }

  const missing = []
  if (draft.title === '') missing.push('title')
  if (draft.acceptance_criteria.length === 0) missing.push('acceptance_criteria')
  if (opts.defaultOwner !== undefined && draft.repos.length === 0 && opts.defaultOwner.size > 0) {
    missing.push('owner')
  }

  const confidence = clamp01(
    0.4 +
      Math.min(0.2, intentHits.length * 0.1) +
      (draft.acceptance_criteria.length > 0 ? 0.25 : 0) +
      (draft.repos.length > 0 ? 0.15 : 0) +
      // 直接 @ 的，至少不因为"没有诉求词"而被压低置信度
      (direct ? 0.15 : 0),
  )

  return {
    draft,
    reason: direct
      ? `直接 @ 机器人；验收标准 ${draft.acceptance_criteria.length} 条`
      : `命中诉求词 ${intentHits.length} 条，验收标准 ${draft.acceptance_criteria.length} 条`,
    missing,
    confidence,
  }
}

/**
 * 去掉 @ 提及——**events.ts 那一版**。
 *
 * hub 的 extract.ts 是 `import { stripMentions } from '../feishu/events.ts'`，
 * 它只去 `@_user_\d+` 与 `@_all`，保留 `@张三`。triage.ts 里另有一版更激进的
 * （`@[^\s@]+` 全去）。这里逐字保留 extract 用的这一版，所以结果与 hub 一致；
 * 两者不同这件事本身写在文件头。
 *
 * @param {string} text
 * @returns {string}
 */
function stripMentions(text) {
  return text
    .replace(/@_user_\d+/g, '')
    .replace(/@_all/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 纯寒暄/致谢类。**即使 @ 了机器人也不算可处理的内容。**
 *
 * 与 `isNoise` 的区别：这个更窄——只覆盖"@ 了我也确实没事"的那几句，
 * 不包含"在吗""?"这类可能是开场白的短句（那些走正常提取，
 * 提取不出来会追问，比直接无视友好）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isPureSmalltalk(text) {
  const t = text.trim()
  if (t === '') return true
  return /^(?:谢谢|多谢|感谢|辛苦(?:了)?|好的|好|收到|嗯+|ok|OK|Ok|👌|👍|🙏|在吗|你好|hi|hello|哈+)[!！。~\s]*$/.test(t)
}

/**
 * 明确的聊天噪音。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isNoise(text) {
  const t = text.trim()
  if (t === '') return true
  return NOISE_PATTERNS.some((re) => re.test(t))
}

/**
 * 是不是提问（不是需求）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isQuestion(text) {
  const t = text.trim()
  if (!QUESTION_PATTERNS.some((re) => re.test(t))) return false
  // "能不能加个重试？"是需求，不是提问——带诉求词的问句归需求
  return !INTENT_WORDS.some((w) => t.includes(w))
}

/**
 * 验收标准的切分。
 *
 * 比通用分句更激进：判据词（必须/不能/至少…）常常紧跟在逗号后面，
 * 整句丢进去会把"支付要支持重试"和"必须重试 3 次"混成一条。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitCriteriaSegments(text) {
  return text
    .split(/[。；;\n]|(?<=[a-zA-Z0-9])\s*[,，]\s*|[,，](?=\s*(?:必须|不能|不准|不允许|至少|不超过|要求|验收|标准))/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 验收标准：包含信号词的整段。最多 8 条，避免卡片被撑爆。
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function collectCriteria(lines) {
  const out = []
  for (const line of lines) {
    for (const sentence of splitCriteriaSegments(line)) {
      if (CRITERIA_WORDS.some((w) => sentence.includes(w))) {
        const cleaned = sentence.trim()
        if (cleaned.length >= 4 && !out.includes(cleaned)) out.push(cleaned)
      }
    }
  }
  return out.slice(0, 8)
}

/**
 * 通用分句（hub 的私有函数，未导出）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return text
    .split(/[。；;\n]|(?<=[a-zA-Z0-9])\s*[,，]\s*/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 标题：取第一句诉求，压到 40 字以内。
 *
 * @param {string} text
 * @returns {string}
 */
export function deriveTitle(text) {
  const first = splitSentences(text)[0] ?? text
  const cleaned = first
    .replace(/^[，,、\s]+/, '')
    .replace(/[。.!！?？]+$/, '')
    .trim()
  return cleaned.length <= 40 ? cleaned : cleaned.slice(0, 39) + '…'
}

/**
 * 拆成"问题"与"方案"。
 *
 * 判据：带"应该/建议/改成/可以"的句子偏方案，带"失败/挂/慢/错/不能"的偏问题。
 * 判不出来时宁可都放进问题——**不要把方案塞进问题里当成既成事实**。
 *
 * @param {string[]} lines
 * @returns {{problem: string, proposal: string}}
 */
export function splitProblemProposal(lines) {
  const problems = []
  const proposals = []
  for (const line of lines) {
    for (const s of splitSentences(line)) {
      if (/应该|建议|可以|改成|不如|最好是|方案|做法/.test(s)) proposals.push(s)
      else if (/失败|挂|慢|错|报错|不能|没法|丢|崩|异常|问题/.test(s)) problems.push(s)
      else problems.push(s)
    }
  }
  return {
    problem: problems.slice(0, 2).join('；'),
    proposal: proposals.slice(0, 2).join('；'),
  }
}

/**
 * 优先级：P0 紧急 / P1 尽快 / P3 不急，其余 P2。
 *
 * @param {string[]} lines
 * @returns {'P0'|'P1'|'P2'|'P3'}
 */
export function derivePriority(lines) {
  const joined = lines.join(' ')
  for (const { re, p } of PRIORITY_PATTERNS) {
    if (re.test(joined)) return p
  }
  return 'P2'
}

/**
 * 仓库只在已知清单里识别，不猜。
 *
 * @param {string[]} lines
 * @param {string[]} known
 * @returns {string[]}
 */
export function collectRepos(lines, known) {
  const joined = lines.join(' ')
  const out = []
  for (const repo of known) {
    if (repo !== '' && joined.includes(repo) && !out.includes(repo)) out.push(repo)
  }
  return out
}

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  return Math.max(0, Math.min(1, n))
}

/* ------------------------------------------------------------------ *
 * 重复识别（防重复建单）
 * ------------------------------------------------------------------ */

/** 中文常见虚词，比对前先剔掉，避免"要能/另外/必须"把相似度抬起来 */
const STOPWORDS = /(另外|还有|顺便|另外要|要能|能够|可以|必须|需要|应该|希望|支持|一下|一个|这个|那个|并且|而且|同时|以及|的话|我们|你们|他们)/g

/**
 * 疑似重复：**前缀命中 + 加权相似度 + 同一仓库**。
 *
 * 设计文档 02 §5.7：同一需求被多个群讨论是常态，命中时应当合并到已有需求卡
 * 而不是新建——否则开发群会出现三张一模一样的卡，然后三个人做同一件事。
 *
 * 为什么不是单纯 Jaccard：中文里同一件事的两次说法往往"前半句相同、后半句加料"，
 * 二元组 Jaccard 会被后半句稀释。前缀命中是个很强的信号，单独给权重。
 *
 * 「短时间内反复出现」里的时间窗口**不在这里**（hub 放在 pipeline 的挂靠逻辑里，
 * 见文件头）：本函数只回答"这条草稿像不像已有某条"。
 *
 * @param {RequirementDraft} draft
 * @param {Array<{id: string, title: string, repos?: string[]}>} existing
 * @param {number} [threshold]
 * @returns {{id: string, score: number}|null}
 */
export function findDuplicate(draft, existing, threshold = 0.6) {
  let best = null
  for (const req of existing) {
    const grams = similarity(draft.title, req.title)
    const prefix = prefixOverlap(draft.title, req.title)
    const repoBonus =
      draft.repos.length > 0 && (req.repos ?? []).some((r) => draft.repos.includes(r)) ? 0.1 : 0
    const total = Math.min(1, Math.max(grams, prefix) + repoBonus)
    if (total >= threshold && (best === null || total > best.score)) best = { id: req.id, score: total }
  }
  return best
}

/**
 * 公共前缀占比：前 12 个字符里有 8 个相同就认为在说同一件事。
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [window]
 * @param {number} [need]
 * @returns {number}
 */
export function prefixOverlap(a, b, window = 12, need = 8) {
  const x = normalize(a)
  const y = normalize(b)
  const n = Math.min(window, x.length, y.length)
  if (n === 0) return 0
  let same = 0
  for (let i = 0; i < n; i += 1) if (x[i] === y[i]) same += 1
  return same >= need ? Math.min(1, same / n + 0.25) : 0
}

/**
 * 比对前的归一化：剔虚词、去标点空白、转小写（hub 的私有函数）。
 *
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return s.replace(STOPWORDS, '').replace(/[\s，,。.、!！?？:：;；]/g, '').toLowerCase()
}

/**
 * 字符二元组 Jaccard：中文也适用，比词切分稳。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const grams = (s) => {
    const t = s.replace(/\s+/g, '').toLowerCase()
    const out = new Set()
    if (t.length < 2) {
      if (t !== '') out.add(t)
      return out
    }
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter += 1
  return inter / (ga.size + gb.size - inter)
}

/* ------------------------------------------------------------------ *
 * 追问决策（"主动追问，默认只追一次"）
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} AskPolicy
 * @property {number} askedCount 这个群/话题已经追问过几次
 * @property {boolean} passive 是否被动模式（不再主动追问）
 */

/**
 * @typedef {object} AskDecision
 * @property {boolean} shouldAsk
 * @property {string|null} question
 * @property {string} reason
 */

/**
 * 决定要不要追问、问什么。
 *
 * 已拍板："需求机器人主动追问，默认只追一次，之后转被动"。
 * 追问必须**具体**——"能说详细点吗"这种问法等于没问。
 *
 * 这是**策略**，不是动作：只返回结构，不发送任何消息。
 *
 * @param {ExtractionResult} result
 * @param {AskPolicy} policy
 * @returns {AskDecision}
 */
export function decideAsk(result, policy) {
  if (policy.passive) {
    return { shouldAsk: false, question: null, reason: '已转被动模式，只在被 @ 时继续澄清' }
  }
  if (policy.askedCount >= 1) {
    return { shouldAsk: false, question: null, reason: '本轮已追问过一次，转被动' }
  }
  if (result.draft === null) {
    return { shouldAsk: false, question: null, reason: '还没判定成需求，不追问' }
  }
  if (result.missing.length === 0) {
    return { shouldAsk: false, question: null, reason: '信息齐全，直接建单' }
  }

  const asks = []
  if (result.missing.includes('title')) asks.push('这件事用一句话怎么描述？')
  if (result.missing.includes('acceptance_criteria')) {
    asks.push('**怎样算做完？**（验收标准，例如"重试 3 次都失败后给出换支付方式的入口"）')
  }
  if (result.missing.includes('owner')) asks.push('这属于哪个项目/仓库？')

  return {
    shouldAsk: true,
    question: `我理解这是一条需求：**${result.draft.title}**\n\n还需要补充：\n${asks.map((a) => `- ${a}`).join('\n')}`,
    reason: `缺 ${result.missing.join('/')}`,
  }
}

/**
 * 录入阶段的追问闸门：**只有信息明显不足才追问一次**。
 *
 * 复刻 hub pipeline.ts:505-517：
 *
 *     const ask = decideAsk(result, { askedCount, passive: askedCount >= 1 })
 *     const hopeless = directAddress
 *       ? result.draft.title.trim() === ''
 *       : result.draft.title.trim() === '' || result.confidence < 0.4
 *
 * 也就是说，**"缺验收标准"本身不足以拦住建单**（hub 的注释：那是常态，需求对象
 * 本身就是 draft 状态，缺什么由需求负责人在确认环节补；在录入阶段就把人拦住问东问西，
 * 是把机器人自己的整理成本转嫁给提需求的人）。人 @ 了你就是想让你干活，不是想先
 * 回答一张问卷，所以直接 @ 的情况下只有"连标题都抽不出来"才追问。
 *
 * 仍然只返回决策结构，**不发送任何消息**：发不发、怎么发是上层的事，
 * 追问额度（askedCount / passive）也由上层记。
 *
 * @param {ExtractionResult} result
 * @param {AskPolicy} policy
 * @param {{directAddress?: boolean}} [opts]
 * @returns {AskDecision}
 */
export function decideIngestAsk(result, policy, opts = {}) {
  const ask = decideAsk(result, policy)
  if (!ask.shouldAsk || ask.question === null) return ask

  const title = result.draft === null ? '' : result.draft.title.trim()
  const hopeless =
    opts.directAddress === true ? title === '' : title === '' || result.confidence < 0.4
  if (!hopeless) {
    return {
      shouldAsk: false,
      question: null,
      reason: '信息不全但不足以拦下建单：录入阶段不追问，缺什么标在卡上让人在确认环节补',
    }
  }
  return ask
}
