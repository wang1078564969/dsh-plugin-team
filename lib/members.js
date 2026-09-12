/*
 * The member table: WHO the humans are, and which roles each of them holds.
 *
 * WHY A TABLE AND NOT A DOMAIN→PEOPLE MAP. The ledger's first config was
 * `members: { pm: [...], development: [...] }` — a domain-to-principals map, which
 * answers exactly one question ("who owns this domain") and cannot answer any of
 * the others a team layer needs: which Feishu `open_id` is this person (so a
 * button press can be attributed), what may they approve, who covers them while
 * they are away, are they active at all. The workbench models this as
 * `access.users[key] = memberSchema` with `role` (owner/member/observer),
 * `domains`, `projects`, `can_approve`, `delegate`, `active` — one row per person,
 * roles assigned ON the person.
 *
 * BACKWARD COMPATIBILITY IS A HARD REQUIREMENT. Existing installations have the
 * map (this plugin wrote one). So `resolveMembers` accepts BOTH shapes and always
 * produces the same three things: the list, the index by key/open_id, and the
 * derived domain map the ledger's existing consumers (tools.js) keep reading.
 * A shape change that silently emptied "who owns the requirement domain" would
 * lock every listed person out of confirming requirements.
 */

/** What a person is in this team. Mirrors the workbench's memberSchema.role. */
export const MEMBER_ROLES = ['owner', 'member', 'observer']

/** What a person may approve (workbench: can_approve). */
export const APPROVAL_KINDS = ['merge', 'deploy', 'config', 'credentials', 'requirement', 'acceptance']

/** Domains a role can be assigned in. Kept open-ended: these are just strings. */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  if (value.length === 0) return []
  return value.map((one) => String(one)).filter((one) => one !== '')
}

function boolOf(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * One person, normalized. `key` is the principal the ledger already uses
 * (`human:wangmengfan`) — it stays the identity, because task objects in the
 * store reference it and renaming it would orphan them.
 */
export function normalizeMember(raw, fallbackKey) {
  const source = isPlainObject(raw) ? raw : {}
  const key = String(pick(source.key, source.id, fallbackKey) ?? '')
  const role = String(pick(source.role, 'member'))
  return {
    key,
    name: String(pick(source.name, source.displayName, source.display_name, key) ?? ''),
    /** Feishu `open_id`: the only way a button press can be attributed to a person. */
    openId: String(pick(source.openId, source.open_id, source.feishu_open_id) ?? ''),
    role: MEMBER_ROLES.includes(role) ? role : 'member',
    /** The roles this person holds — `pm`, `requirement`, `development`, … */
    domains: stringList(pick(source.domains, source.domain, [])),
    projects: stringList(source.projects),
    canApprove: stringList(pick(source.canApprove, source.can_approve, [])),
    /** Who covers them while they are away; a principal, or null. */
    delegate: pick(source.delegate) ?? null,
    active: boolOf(source.active, true),
  }
}

/**
 * Resolve the member table from any accepted source shape.
 *
 * @param {object} input
 * @param {unknown} input.members the `members` value from the file/row: array (new) or object (legacy map)
 * @param {unknown} [input.domains] an explicit `domains` map, which wins over the legacy map
 * @param {object} [input.senders] open_id → principal, used to FILL IN open_id on rows a human listed by key
 * @returns {{list: object[], byKey: Map<string, object>, byOpenId: Map<string, object>, domains: object, legacyShape: boolean}}
 */
export function resolveMembers(input) {
  const raw = input?.members
  const senders = isPlainObject(input?.senders) ? input.senders : {}
  const byOpenIdFromSenders = new Map()
  for (const [openId, principal] of Object.entries(senders)) byOpenIdFromSenders.set(String(openId), String(principal))

  let list = []
  let legacyMap = {}
  let legacyShape = false

  if (Array.isArray(raw)) {
    list = raw.map((one) => normalizeMember(one))
  } else if (isPlainObject(raw)) {
    /*
     * The old shape. Every value is a list of principals, and each principal in a
     * domain becomes a member row holding that domain. One person in two domains
     * is ONE row with two domains — which is the whole point of the table.
     */
    legacyShape = true
    legacyMap = raw
    const byKey = new Map()
    for (const [domain, principals] of Object.entries(raw)) {
      const entries = Array.isArray(principals) ? principals : []
      for (const principal of entries) {
        const key = String(principal)
        if (key === '') continue
        const existing = byKey.get(key) ?? normalizeMember({ key, domains: [] })
        if (!existing.domains.includes(domain)) existing.domains.push(domain)
        byKey.set(key, existing)
      }
    }
    list = [...byKey.values()]
  }

  // An open_id someone already mapped in `feishu.senders` is knowledge we have;
  // writing it onto the row saves the operator from typing it twice, and the
  // reverse direction (row → senders) is handled by the settings projection.
  for (const member of list) {
    if (member.openId === '') {
      for (const [openId, principal] of byOpenIdFromSenders) {
        if (principal === member.key) {
          member.openId = openId
          break
        }
      }
    }
  }

  const domains = { ...legacyMap }
  const explicitDomains = isPlainObject(input?.domains) ? input.domains : null
  if (explicitDomains !== null) {
    for (const [domain, principals] of Object.entries(explicitDomains)) {
      domains[domain] = Array.isArray(principals) ? principals.map((one) => String(one)) : []
    }
  }
  /*
   * Members' own domain assignments are merged into the map LAST, so a row edited
   * on the 成员 page is reflected in what the ledger asks. A domain listed in both
   * places is a union, never an override: dropping a principal because two sources
   * disagreed is how an owner disappears without an error.
   */
  for (const member of list) {
    for (const domain of member.domains) {
      const current = Array.isArray(domains[domain]) ? domains[domain].map((one) => String(one)) : []
      if (!current.includes(member.key)) current.push(member.key)
      domains[domain] = current
    }
  }

  const byKey = new Map()
  const byOpenId = new Map()
  for (const member of list) {
    // First row wins a duplicate key: the console refuses to create one, and a
    // hand-edited file that did gets a stable answer rather than a coin flip.
    if (!byKey.has(member.key)) byKey.set(member.key, member)
    if (member.openId !== '' && !byOpenId.has(member.openId)) byOpenId.set(member.openId, member)
  }

  return { list, byKey, byOpenId, domains, legacyShape }
}

/** The people who hold a domain, as principals the ledger understands. */
export function domainOwners(resolved, domain) {
  const owners = resolved?.domains?.[domain]
  return Array.isArray(owners) ? owners.map((one) => String(one)) : []
}

/**
 * Problems a human should fix, per row.
 *
 * `key` problems are errors: the key is the identity tasks and gates are written
 * against, so a row without one is invisible to the state machine. Everything
 * else is a warning — an unlisted `open_id` only means this person's button
 * presses cannot be attributed, which is exactly what the 接入自检 page reports.
 */
export function memberProblems(member, context) {
  const list = Array.isArray(context?.members) ? context.members : []
  const out = []
  const bad = (field, message) => out.push({ field, message, level: 'error' })
  const warn = (field, message) => out.push({ field, message, level: 'warn' })

  if (typeof member.key !== 'string' || member.key.trim() === '') {
    bad('key', '缺少成员键（形如 human:wangmengfan）：台账里的负责人、验收人都是按它记录的')
    return out
  }
  if (!/^(human|bot):\S+$/.test(member.key)) {
    // An ERROR, not a warning: the ledger writes tasks, gates and leases against
    // this string. A key the state machine cannot match is a person who is listed
    // and still cannot confirm anything.
    bad('key', '成员键必须形如 human:<名字> 或 bot:<名字>（台账按它记录负责人、指派与验收人）')
  } else if (!/^(human|bot):[A-Za-z0-9_.-]+$/.test(member.key)) {
    warn('key', '成员键里中文字符较多：能用，但建议写成 human:<拼音或英文名>，卡片上更清楚')
  }
  if (list.filter((one) => one.key === member.key).length > 1) bad('key', '成员键重复：' + member.key)
  if (member.name === member.key) warn('name', '没有填姓名：卡片上 @ 人只能用成员键')
  if (member.openId === '') {
    warn('openId', '没有填飞书 open_id：这个人按键确认时无法确认身份，状态变更会被拒绝')
  } else if (!/^ou_/.test(member.openId) && !/^on_/.test(member.openId)) {
    warn('openId', 'open_id 一般以 ou_ 开头，当前值看起来不像')
  }
  if (member.domains.length === 0 && member.role === 'member') {
    warn('domains', '没有分配角色域：这个人在业务上不拥有任何域，只能在群里说话')
  }
  if (member.active === false && member.delegate === null) {
    warn('active', '已停用又没有代理：分配给他的活会卡住（租约会超时升级）')
  }
  if (member.active === false && member.delegate !== null && !list.some((one) => one.key === member.delegate)) {
    warn('delegate', '代理 ' + member.delegate + ' 不在成员表里')
  }
  return out
}

/** One-line description for the member list. */
export function describeMember(member) {
  const roles = member.domains.length === 0 ? '无角色域' : member.domains.join('/')
  const flags = [member.role, roles]
  if (member.openId === '') flags.push('未绑定 open_id')
  if (member.active === false) flags.push('停用')
  return member.name + '（' + member.key + ' · ' + flags.join(' · ') + '）'
}
