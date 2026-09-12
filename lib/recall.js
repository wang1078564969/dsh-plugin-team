/*
 * 回忆：回答"这件事我们以前怎么定的"。
 *
 * 设计 07 §0.2/§0.3 的结论很明确，这个模块就是那条结论的落点：**分两类，各有各的家**。
 *
 *   · **情景记忆**（谁在哪个会话里说了什么、当时怎么决定的）→ **DSH 自己的会话历史**。
 *     `ctx.sessionQuery` 已经提供跨会话全文检索（`dsh-session-query` + FTS5），
 *     自建一套只会更差；
 *   · **沉淀知识**（约定、术语、踩过的坑、ADR）→ **工作区文件**（`workspace/docs/`），
 *     因为要人能读、能改、能 diff、能跨机器共享。载体就是 `lib/docs.js`。
 *
 * 所以这个模块不建库、不写索引，只做三件事：把一次提问分发给这两个来源 + 台账，
 * 把结果统一成"每条都带出处、都标出可能过期"的形状。
 *
 * 两条对 agent 很重要的诚实性：
 *   1. **过期的照样返回**，带 `stale: true` 与最后确认时间 —— "不知道"比"知道过期的"更糟
 *      （设计 07 §1.3 的原话）；
 *   2. **查不到就说查不到**：`sessionQuery` 没挂载时 `sessions` 是 `null` 并且给出原因，
 *      而不是一个空数组假装"历史上什么都没有"。
 */

/** 台账里能匹配上的对象（需求/任务/决策）："这件事在我们自己的台账里叫什么"。 */
function ledgerHits(store, query, limit) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '' || store === null || typeof store.all !== 'function') return []
  const out = []
  for (const kind of ['requirement', 'task', 'decision']) {
    for (const doc of store.all(kind)) {
      const haystack = [doc.id, doc.title, doc.problem, doc.proposal, doc.body, doc.state].filter((one) => typeof one === 'string').join(' ').toLowerCase()
      if (!haystack.includes(needle)) continue
      out.push({
        kind,
        id: doc.id,
        title: typeof doc.title === 'string' && doc.title !== '' ? doc.title : kind === 'decision' ? String(doc.decision ?? '') : '',
        state: doc.state ?? doc.status ?? null,
        at: doc.updated_at ?? doc.created_at ?? null,
      })
    }
  }
  return out.slice(0, Number.isFinite(limit) ? limit : 10)
}

export function createRecall(deps) {
  const docs = deps.docs ?? null
  // 会话检索是**可选服务**：headless / 没装 sqlite 后端的 profile 里它不存在。
  const query$ = typeof deps.sessionQuery === 'function' ? deps.sessionQuery : () => null
  const store = deps.store ?? null

  /**
   * @param {string} query 自然语言问题或关键词
   * @param {{limit?: number, types?: string[]}} [options]
   * @returns {Promise<{ok: boolean, query: string, docs: object[], sessions: object[]|null,
   *   ledger: object[], notes: string[]}>}
   */
  async function recall(query, options = {}) {
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 10
    const text = String(query ?? '').trim()
    const notes = []
    const docsHits = docs === null ? [] : docs.search(text, { limit, ...(options.types === undefined ? {} : { types: options.types }) })
    if (docsHits.some((hit) => hit.stale)) {
      notes.push('有命中来自 stale/superseded 的文档：它可能已经被新版本取代，用之前先看 `status` 与 `updated`。')
    }
    if (docs !== null && docsHits.length === 0) {
      notes.push('工作区的文档库里没有命中（docs/ 下没有匹配的 id、标题或正文）。')
    }

    const engine = query$()
    let sessions = null
    if (engine === null || engine === undefined) {
      notes.push('会话历史检索不可用（这个 profile 没有 sessionQuery 服务）：情景记忆这一半这次没查。')
    } else if (typeof engine.searchSessions !== 'function') {
      notes.push('sessionQuery 服务在，但没有 searchSessions：情景记忆这一半这次没查。')
    } else {
      try {
        const page = await engine.searchSessions({ query: text, limit })
        sessions = (Array.isArray(page?.items) ? page.items : []).map((item) => ({
          id: item?.header?.id ?? null,
          live: item?.live === true,
          persisted: item?.persisted === true,
          at: Number.isFinite(item?.header?.createdAt) ? new Date(item.header.createdAt).toISOString() : null,
          cwd: typeof item?.header?.cwd === 'string' ? item.header.cwd : null,
          snippet: typeof item?.bestMatch?.snippet === 'string' ? item.bestMatch.snippet : '',
        }))
        if (sessions.length === 0) notes.push('会话历史里也没有命中。')
      } catch (error) {
        sessions = null
        notes.push('会话检索失败（不影响文档与台账的结果）：' + String(error && error.message ? error.message : error))
      }
    }

    const ledger = ledgerHits(store, text, limit)
    if (ledger.length > 0) {
      notes.push('台账里有 ' + String(ledger.length) + ' 个同名/相关的对象：那才是权威状态，文档与记忆只是说明。')
    }
    return { ok: true, query: text, docs: docsHits, sessions, ledger, notes }
  }

  return { recall }
}
