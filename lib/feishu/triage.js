/*
 * 来源：
 *   - hub/src/runtime/triage.ts（277 行）—— 逐字移植：stripMentions /
 *     hasSubstance / findIntentHits / triageMessage / selectContextMessages
 *     以及 STATUS_PATTERNS / ROLL_CALL_PATTERNS / compile()。
 *   - hub/src/config/schema.ts:174-235 的 triageSchema 默认值 → DEFAULT_TRIAGE_CONFIG
 *     （取值同 hub/team-hub/config/workflow.yaml:114-156 的 triage 节；
 *      hub/examples/example-config/workflow.yaml 里**没有** triage 节，所以
 *      生效值就是 schema 默认值。digest_only 不在 triageSchema 里，它属于
 *      bots[].bindings[].speak_policy，见 config/schema.ts:376-385。）
 *   - hub/src/runtime/pipeline.ts:1529-1534 的私有 #markIgnored，以及
 *     pipeline.ts:342「群里未 @ 机器人，不进需求」那处标记 → markIgnored() /
 *     IGNORED_NO_MENTION。
 *
 * 改了什么：
 *   1. TS → 纯 ESM JavaScript，零依赖。TriageKind / TriageVerdict / TriageInput
 *      改成 JSDoc @typedef（运行期形状与 hub 逐个字段一致：cleaned / intent_hits /
 *      kind / reason / has_intent / substantive）。
 *   2. triageSchema（zod）→ DEFAULT_TRIAGE_CONFIG 常量（冻结）。判据本身一个字没动。
 *   3. **唯一一处有意偏离 hub 的取值**：DEFAULT_TRIAGE_CONFIG.intent_words 在 hub 的
 *      32 个词之外多了 '帮'。原因见该常量上的注释；hub 原表原样保留为 HUB_INTENT_WORDS，
 *      要还原成一字不改的 hub 默认值，把 intent_words 换成 HUB_INTENT_WORDS 即可。
 *   4. 新增 markIgnored(messages, reason)：把 pipeline 里那个要写库的私有方法提成
 *      **纯函数**（只返回新对象，不落盘）。「非需求消息必须被标成忽略 + 原因」是分诊的
 *      收尾动作，少了它，没 @ 机器人的群消息会一直留在未消费集合里，被之后任何一个
 *      新需求当正文吞掉（hub 修过的真 bug，见 markIgnored 上的注释）。
 *   5. 新增 resolveTriageConfig(partial)：给上层用「部分配置」构造分诊输入时补默认值，
 *      避免 config.feishu.triage 只写了 intent_words 就崩在 smalltalk_patterns 上。
 *
 * 没能保住的语义（显式列出，绝不静默丢弃）：
 *   - **配置校验没了**。hub 在启动时 `triageSchema.parse(opts.triage ?? {})`
 *     （pipeline.ts:221）会把类型写错的配置当场拦下（`min_substance_chars: "4"`、
 *     `intent_words: "要"`、多了未声明的键）；这里只有常量工厂，没有校验，
 *     写错类型要到运行期才炸。仍然兜住的只有「非法正则」这一种：compile() 的
 *     try/catch 与 hub 一致，写错的正则被跳过而不是让整条消息处理挂掉。
 *   - TriageKind / TriageVerdict / TriageInput 只剩 JSDoc，编译期检查没了。
 *   - `reaction` 与 `min_confidence_for_card` 在 hub 里由 pipeline 消费
 *     （pipeline.ts:356-367 的表情表态；schema.ts:196-205 明说
 *     min_confidence_for_card 目前是个**假旋钮**，建单路径没有消费它）。
 *     本模块只保留字段、不做任何行为；`context_window` 也只作为默认值存在，
 *     真正读它的是 selectContextMessages 的**调用方**（hub: pipeline.ts:423）。
 *   - hub 里 `stripMentions` 有**两份不同实现**：triage.ts:56-62（连 `@张三`
 *     一起去掉）与 feishu/events.ts:208-214（只去 `@_user_\d+` / `@_all`，
 *     保留真实姓名）。extract.ts 用的是 events 那版。本文件导出的是 triage 那版；
 *     extract.js 内部用的是 events 那版（见 extract.js 头部说明）。
 *   - 时间维度不在这里：hub 的「2 小时内还有活动才挂靠」（pipeline.ts:625-640）
 *     属于 pipeline 的挂靠逻辑，不是分诊判据，没有移植。
 */

/* ------------------------------------------------------------------ *
 * 配置默认值（= hub triageSchema 的默认值）
 * ------------------------------------------------------------------ */

/**
 * hub 那份逐字的诉求词表（triageSchema 默认值 = team-hub/config/workflow.yaml:124-156）。
 *
 * 单独留一份是为了可追溯：DEFAULT_TRIAGE_CONFIG 在这 32 个词之外多了 '帮'，
 * 而这里的 32 个词与 hub 一字不差，方便对照与还原。
 */
export const HUB_INTENT_WORDS = Object.freeze([
  '要', '需要', '应该', '希望', '支持', '新增', '增加', '加个', '加一个',
  '修复', '修一下', '优化', '改成', '改一下', '换成', '去掉', '实现',
  '做一个', '能不能', '可否', '要求', '必须', '不能', '别再', '麻烦',
  '帮忙', '请', '排一下', '处理', '跟进', '上线', '发布',
])

/**
 * 分诊配置的默认值。字段与 hub 的 triageSchema 一一对应，取值逐字来自
 * hub 的部署配置（workflow.yaml 的 triage 节）与 triageSchema 默认值。
 *
 * **唯一一处有意偏离：intent_words 多了 '帮'。**
 *
 * 为什么：架构文档 02 §3 的补充判据是「被 @ 了不用固定词表卡人」，而 hub 原表里
 * 最常见的请求说法 `帮我把重试加上` **一个词都不命中**（原来只有 '帮忙'，没有 '帮'），
 * 于是一条直接 @ 机器人的请求会被判成 `status`（实测：hub 原样代码返回
 * `有内容但没有表达诉求（@ 只代表要我回应，不代表这是需求）`）。'帮' 只**放宽**
 * 不收紧，且 hub 分诊测试的 22 条文本里没有一条含 '帮'，所以不会改动任何既有判定。
 * 要回到与 hub 完全一致的默认值：`intent_words: HUB_INTENT_WORDS`。
 *
 * 注意这里没有、也不该有 digest 相关字段：`digest_only` 属于
 * bots[].bindings[].speak_policy（config/schema.ts:376-385），不是分诊配置。
 */
export const DEFAULT_TRIAGE_CONFIG = Object.freeze({
  /** 收到消息先回一个表情表态；留空 '' 关闭。**本模块不消费**（hub 由 pipeline 发）。 */
  reaction: 'Get',
  /**
   * 只要「实质内容 + 表达诉求」都成立才算需求。
   * 关掉就退回旧行为（@ 我即需求），不推荐：那正是把沟通当需求的根源。
   */
  require_intent: true,
  /** 实质内容的最低字数（去 @、去空白后的可见字符数）。 */
  min_substance_chars: 4,
  /**
   * 提取置信度低于它时不单独发卡。hub 的注释明说建单路径**还没有消费**这个值
   * （extractRequirement 的置信度下限是 0.4），留在这里是给降级成摘要那条路用的。
   */
  min_confidence_for_card: 0.45,
  /** 一次请求最多往回看几条消息；由 selectContextMessages 的调用方读取。 */
  context_window: 6,
  intent_words: Object.freeze([...HUB_INTENT_WORDS, '帮']),
  /** 明确的「这不是需求」：提问 */
  question_patterns: Object.freeze(['[?？]$', '^(怎么|如何|为什么|为啥|什么时候|谁|哪个|是否)']),
  /**
   * 明确的「这不是需求」：寒暄/应答。
   *
   * "啦/了/呀"这类语气词要带上：漏一个，"辛苦啦"就会掉进「够长但不匹配任何模式」
   * 的缝里，被当成 ping 去回执（这条注释是 hub 里就有的）。
   */
  smalltalk_patterns: Object.freeze([
    '^(好|好的|收到|ok|OK|Ok|嗯+|谢谢|多谢|感谢|辛苦(了|啦|呀)?|赞|👍|👌|🙏|在吗|你好|hi|hello|哈+|早|早上好|晚安|在不在|收到啦)[!！。~\\s]*$',
  ]),
})

/**
 * 用一份**可能不全**的配置覆盖默认值。
 *
 * hub 的配置永远是 zod 校验过的完整对象；这里上层可能只写了自己关心的那几项
 * （`{ feishu: { triage: { intent_words: [...] } } }`），少一项就会在
 * `cfg.smalltalk_patterns.some(...)` 上炸。这个函数只补默认值，不做校验——
 * 校验能力没能保住，见文件头。
 *
 * @param {Partial<typeof DEFAULT_TRIAGE_CONFIG>|null|undefined} partial
 * @returns {typeof DEFAULT_TRIAGE_CONFIG}
 */
export function resolveTriageConfig(partial) {
  if (partial === null || partial === undefined) return DEFAULT_TRIAGE_CONFIG
  return { ...DEFAULT_TRIAGE_CONFIG, ...partial }
}

/* ------------------------------------------------------------------ *
 * 分诊
 * ------------------------------------------------------------------ */

/**
 * 分诊结论的类别。
 *
 * @typedef {'ping'|'smalltalk'|'question'|'status'|'requirement'} TriageKind
 */

/**
 * 一条消息的分诊结论。
 *
 * @typedef {object} TriageVerdict
 * @property {TriageKind} kind
 *   ping：测试/空内容/噪音，回一声，什么都不产生；
 *   smalltalk：闲聊、寒暄、应答，静默；
 *   question：提问，回答，不建单；
 *   status：进度同步、结果通报，落记忆，不建单；
 *   requirement：**需求**，唯一会建单的一类。
 * @property {string} reason 人话解释，会写进消息的 ignored_reason 与日志
 * @property {string} cleaned 去掉 @ 之后的正文
 * @property {boolean} has_intent 是否表达了诉求（只有 requirement 才需要为 true）
 * @property {boolean} substantive 实质内容判定
 * @property {string[]} intent_hits 命中的诉求词，卡片上可以展示「我是因为这几个字才当需求的」
 */

/**
 * 去掉 @ 提及后剩下的正文。
 *
 * 这里是 triage.ts 那版（连 `@张三` 这类真实姓名一起去掉），
 * 与 feishu/events.ts 那版不同——extract.js 用的是 events 那版。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMentions(text) {
  return text
    .replace(/@_user_\d+/g, '')
    .replace(/@[^\s@]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 有没有**实质内容**。
 *
 * 这里挡的正是截图里那类消息。判定顺序是从「最确定不是内容」往下：
 *
 *   ① 空 / 太短（按配置的 min_substance_chars）
 *   ② **重复字符**："111"、"。。。"、"aaa"——人不会这样提需求，这是按键测试或手滑
 *   ③ **纯数字/纯符号**："123123"、"---"——没有语义
 *   ④ 只剩标点的（去标点后为空）
 *
 * 注意 ② 用的是「整串由同一个字符重复组成」，而不是「包含重复字符」：
 * "改三次" 里的"三"不重复，但 "333" 会命中——这正是想要的。
 *
 * @param {string} text
 * @param {number} minChars
 * @returns {boolean}
 */
export function hasSubstance(text, minChars) {
  const t = text.trim()
  if (t === '') return false

  // 计算可见字符数（不含空白；标点也算，但后面会被单独排除）
  const visible = t.replace(/\s/g, '')
  if (visible.length < minChars) return false

  // ② 整串是同一个字符的重复：111 / ... / aaa / 哈哈哈 都算
  if (/^(.)\1*$/u.test(visible)) return false

  // ③ 纯数字（含小数点、千分位、百分号这类装饰）
  if (/^[\d\s.,:%+\-/]+$/.test(visible)) return false

  // ④ 去掉标点/符号后没有内容
  const withoutPunct = visible.replace(/[\p{P}\p{S}]/gu, '')
  if (withoutPunct === '') return false

  return true
}

/**
 * 这一句像不像在提要求。
 *
 * 命中顺序跟随词表顺序（hub 也是这样），重复的词会重复计入——保持原样。
 *
 * @param {string} text
 * @param {string[]} intentWords
 * @returns {string[]}
 */
export function findIntentHits(text, intentWords) {
  const t = text.trim()
  const hits = []
  for (const w of intentWords) {
    if (w !== '' && t.includes(w)) hits.push(w)
  }
  return hits
}

/**
 * 进度同步 / 结果通报。
 *
 * 为什么单独一类而不是并进 smalltalk：这类消息**有信息量**，该进记忆
 * （"这个需求已经在做了"），只是不该建单。混进 smalltalk 会让这些信息被丢掉。
 *
 * 判定看的是**完成态**，不是"有没有出现上线/发布这类词"——那些词同时在诉求词表里。
 * 区别在时态：
 *   "支付重试已经上线了" = 报结果 → status
 *   "上线这个功能"       = 提要求 → requirement
 *
 * 判据是「句子以完成态收尾」：`了/啦` 结尾，或显式的"已经/刚刚"标记。
 * 不能锚在开头——中文的动词通常不在句首（"支付重试**已经上线了**"）。
 */
const STATUS_PATTERNS = [
  // 完成态收尾：改好了 / 上线了 / 做完了 / 发布了 / 跑通了
  /(好了|完了|通了|过了|上线了|发布了|部署了|合并了|提交了|修复了|搞定了|完成了|结束了|通过了)[!！。~\s]*$/,
  // 显式的完成标记 + 任意完成动词 + 收尾
  /(已|已经|刚|刚刚|正在)(完成|做完|搞定|提交|合并|上线|发布|部署|修好|修复|跑通|测试)/,
  /^(今天|明天|昨天|本周|下周)[:：]/,
  /^(进度|状态)[:：]/,
]

/** "在吗""谁能看下"这类开场白——不是需求，但也不是噪音，值得回一句 */
const ROLL_CALL_PATTERNS = [/^(在吗|在不在|有人吗|谁在|在不在线)[?？!！。~\s]*$/]

/**
 * 把配置里的字符串编译成正则。
 *
 * 配置里写错的正则跳过而不是让整条消息处理挂掉。
 *
 * @param {string[]} patterns
 * @returns {RegExp[]}
 */
function compile(patterns) {
  const out = []
  for (const p of patterns) {
    try {
      out.push(new RegExp(p))
    } catch {
      // 配置里写错的正则跳过而不是让整条消息处理挂掉
    }
  }
  return out
}

/**
 * @typedef {object} TriageInput
 * @property {string} text
 * @property {boolean} directAddress 这批里有没有直接 @ 机器人
 * @property {typeof DEFAULT_TRIAGE_CONFIG} config
 */

/**
 * 分诊一条消息。
 *
 * 返回的 `kind` 决定后续动作：
 *   ping / smalltalk → 不建单（ping 回一声，smalltalk 静默）
 *   question         → 回答，不建单
 *   status           → 落记忆，不建单
 *   requirement      → 进需求提取与建单
 *
 * 注意 `directAddress` 在这里**只改解释文案，不改判据**：hub 的立场是
 * 「@ 只决定要不要回应，不决定要不要建单」，所以被 @ 了同样要过诉求词这一关
 * （第 ⑦ 步）。真正「被 @ 了不用词表卡人」的放宽发生在 extract.js
 * （extractRequirement 的 directAddress 分支），见那边的注释与本文件头。
 *
 * @param {TriageInput} input
 * @returns {TriageVerdict}
 */
export function triageMessage(input) {
  const cfg = input.config
  const cleaned = stripMentions(input.text)
  const intentHits = findIntentHits(cleaned, cfg.intent_words)
  const base = { cleaned, intent_hits: intentHits }

  // ① 空内容（去掉 @ 就没了）：纯 @ 机器人
  if (cleaned === '') {
    return { ...base, kind: 'ping', reason: '只有 @ 没有正文', has_intent: false, substantive: false }
  }

  const smalltalk = compile(cfg.smalltalk_patterns)
  const questions = compile(cfg.question_patterns)

  /**
   * ② 点名的开场白："在吗""有人吗"。
   *
   * 放在寒暄**之前**：这类话的目的是确认机器人在不在，值得回一声；
   * 而寒暄表里的"在吗"只是被当成没内容。两者的处置不同（ping 回执 /
   * smalltalk 静默），所以更具体的这一类要先判。
   */
  if (ROLL_CALL_PATTERNS.some((re) => re.test(cleaned))) {
    return { ...base, kind: 'ping', reason: '点名确认是否在线', has_intent: false, substantive: false }
  }

  // ③ 寒暄/应答：即使 @ 了我也不算可处理内容
  if (smalltalk.some((re) => re.test(cleaned))) {
    return { ...base, kind: 'smalltalk', reason: '寒暄或应答', has_intent: false, substantive: false }
  }

  // ④ 实质内容闸门：这一步挡下 "111" / "123123" / "test"
  const substantive = hasSubstance(cleaned, cfg.min_substance_chars)
  if (!substantive) {
    return {
      ...base,
      kind: 'ping',
      reason: `内容过短或没有实际信息（${cleaned.length} 字）`,
      has_intent: intentHits.length > 0,
      substantive: false,
    }
  }

  /**
   * ⑤ 进度同步：**必须在诉求词判断之前**。
   *
   * "已经上线了"里的"上线"同时是诉求词，如果先按诉求词归需求，
   * 这类结果通报就永远到不了这里。区别在时态——见 STATUS_PATTERNS 的注释。
   */
  if (STATUS_PATTERNS.some((re) => re.test(cleaned))) {
    return { ...base, kind: 'status', reason: '看起来是进度同步，不是需求', has_intent: false, substantive: true }
  }

  // ⑥ 提问：带诉求词的问句归需求（"能不能加个重试？"是要东西）
  if (intentHits.length === 0 && questions.some((re) => re.test(cleaned))) {
    return { ...base, kind: 'question', reason: '看起来是提问，不是需求', has_intent: false, substantive: true }
  }

  /**
   * ⑦ 需求成立的两个条件：**有实质内容**（已过闸）+ **表达诉求**。
   *
   * 不再因为"@ 了我"就放宽到"只要有一句话就建单"——那正是把沟通当需求的根源。
   * @ 只决定**要不要回应**，不决定**要不要建单**。
   */
  if (cfg.require_intent && intentHits.length === 0) {
    return {
      ...base,
      kind: 'status',
      reason: input.directAddress
        ? '有内容但没有表达诉求（@ 只代表要我回应，不代表这是需求）'
        : '没有发现表达诉求的词',
      has_intent: false,
      substantive: true,
    }
  }

  return {
    ...base,
    kind: 'requirement',
    reason: intentHits.length > 0 ? `命中诉求词：${intentHits.slice(0, 3).join('、')}` : '直接指派的诉求',
    has_intent: true,
    substantive: true,
  }
}

/**
 * 从一批消息里挑出**真正属于本次请求**的那几条。
 *
 * 原先 `#processBatch` 拿的是"这个群最近 30 条未消费消息"，于是
 * 「111」「11」「@机器人 123123」被一起塞进需求正文。真正的规则是：
 *
 *   ① 从**触发消息**（就是刚到的这条）往回找
 *   ② 中间遇到不属于同一发件人的就停——别人插话说明话题换了
 *   ③ 最多回看 `context_window` 条
 *
 * 这样多条消息说同一件事仍然会被合起来，但无关的闲聊不会被吞进来。
 *
 * 纯函数：返回新数组，元素仍是原来的消息对象（调用方不要就地改它们）。
 *
 * @param {Array<{message_id: string, sender_principal: string|null}>} batch
 * @param {{message_id: string, sender_principal: string|null}} trigger
 * @param {number} window
 * @returns {Array<object>}
 */
export function selectContextMessages(batch, trigger, window) {
  const idx = batch.findIndex((m) => m.message_id === trigger.message_id)
  if (idx < 0) return [trigger]

  const out = [trigger]
  for (let i = idx - 1; i >= 0 && out.length < window; i -= 1) {
    const prev = batch[i]
    if (prev === undefined) break
    // 别人插过话 → 这里是另一个话题的边界
    if (prev.sender_principal !== trigger.sender_principal) break
    out.unshift(prev)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 非需求消息的落库形态（hub: pipeline.ts #markIgnored）
 * ------------------------------------------------------------------ */

/**
 * 群里没 @ 机器人时的忽略原因。
 *
 * hub 用它把「不响应 ≠ 没收到」落到库上（pipeline.ts:342）。逐字保留：
 * 这个字符串会被写进 `ignored_reason`，也是「漏单率」统计与人工翻账的依据。
 */
export const IGNORED_NO_MENTION = '群里未 @ 机器人，不进需求'

/**
 * 把「看过、不处理」写到消息上（**纯函数**：返回新数组，不写库）。
 *
 * hub 里这是 pipeline 的私有 `#markIgnored`（pipeline.ts:1529-1534）：它只写
 * `ignored_reason`，不写 `consumed_by`——前者是"看过、不处理"，后者是"被某条需求
 * 用掉了"。原文仍留在库里，要翻还能翻出来。
 *
 * 为什么必须做这一步：不标的话消息会一直留在"未消费"集合里，而取上下文时拿的就是
 * 未消费消息——于是**之后任何一个新需求都会把它当正文吞进去**。hub 的实际数据里
 * 出现过"一条需求攒了 11 条来源消息，大半是别人的闲聊与测试（总结一下/111/1221）"。
 *
 * 与 hub 一致的细节：`ignored_reason` 已经是同一个原因的消息**原样返回**（同一对象
 * 引用），调用方据此就知道"这一条不用再写一次"。
 *
 * @template {{ignored_reason?: string|null}} T
 * @param {T[]} messages
 * @param {string} reason
 * @returns {T[]}
 */
export function markIgnored(messages, reason) {
  const out = []
  for (const m of messages) {
    if (m.ignored_reason === reason) {
      out.push(m)
      continue
    }
    out.push({ ...m, ignored_reason: reason })
  }
  return out
}
