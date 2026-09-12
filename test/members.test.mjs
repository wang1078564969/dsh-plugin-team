/*
 * The member table: several people, roles assigned ON the person, and the domain
 * map the ledger has always read derived from it.
 *
 * The compatibility tests matter most here. Every existing installation has the
 * old map shape, and a shape change that silently emptied "who owns the
 * requirement domain" would lock those people out of confirming their own work.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_KINDS,
  describeMember,
  domainOwners,
  MEMBER_ROLES,
  memberProblems,
  normalizeMember,
  resolveMembers,
} from '../lib/members.js'

test('a member row is normalized with every field the workbench models', () => {
  const member = normalizeMember({ key: 'human:wang', name: '王梦凡', openId: 'ou_wang', role: 'owner', domains: ['pm'], canApprove: ['merge'], active: true })
  assert.deepEqual(member, {
    key: 'human:wang',
    name: '王梦凡',
    openId: 'ou_wang',
    role: 'owner',
    domains: ['pm'],
    projects: [],
    canApprove: ['merge'],
    delegate: null,
    active: true,
  })
  assert.deepEqual(MEMBER_ROLES, ['owner', 'member', 'observer'])
  assert.ok(APPROVAL_KINDS.includes('acceptance'))
})

test('an unknown role falls back to member instead of inventing one', () => {
  assert.equal(normalizeMember({ key: 'human:a', role: 'admin' }).role, 'member')
})

test('the legacy domain map becomes a table: one row per person, several domains on it', () => {
  const resolved = resolveMembers({
    members: { pm: ['human:wang'], requirement: ['human:wang', 'human:zhou'], development: [] },
  })
  assert.deepEqual(
    resolved.list.map((one) => one.key),
    ['human:wang', 'human:zhou'],
  )
  // ONE row with TWO domains — the whole point of moving roles onto the person.
  assert.deepEqual(resolved.byKey.get('human:wang').domains, ['pm', 'requirement'])
  assert.equal(resolved.legacyShape, true)
  // And the map the ledger reads is unchanged, including the empty domain.
  assert.deepEqual(domainOwners(resolved, 'requirement'), ['human:wang', 'human:zhou'])
  assert.deepEqual(domainOwners(resolved, 'development'), [])
})

test('a member row\'s own domains merge into the map: a row edited in the console counts', () => {
  const resolved = resolveMembers({
    members: [{ key: 'human:wang', domains: ['pm'] }, { key: 'human:zhou', domains: ['development'] }],
    domains: { pm: ['human:other'] },
  })
  assert.deepEqual(domainOwners(resolved, 'pm'), ['human:other', 'human:wang'], 'a union, never an override')
  assert.deepEqual(domainOwners(resolved, 'development'), ['human:zhou'])
})

test('open_id mappings already in feishu.senders fill in the row, so nobody types it twice', () => {
  const resolved = resolveMembers({
    members: [{ key: 'human:wang' }, { key: 'human:zhou' }],
    senders: { ou_wang: 'human:wang', ou_someone: 'human:zhou' },
  })
  assert.equal(resolved.byKey.get('human:wang').openId, 'ou_wang')
  assert.equal(resolved.byKey.get('human:zhou').openId, 'ou_someone')
  assert.equal(resolved.byOpenId.get('ou_wang').key, 'human:wang')
})

test('a duplicate key keeps the first row: a stable answer beats a coin flip', () => {
  const resolved = resolveMembers({ members: [{ key: 'human:a', name: '第一个' }, { key: 'human:a', name: '第二个' }] })
  assert.equal(resolved.byKey.get('human:a').name, '第一个')
})

test('memberProblems: the key is an error (the ledger writes gates against it), the rest are warnings', () => {
  const rows = [
    normalizeMember({ key: 'wang', name: '王' }),
    normalizeMember({ key: 'human:b', name: 'human:b' }),
    normalizeMember({ key: 'human:c', name: '丙', openId: 'not-an-open-id', active: false, delegate: 'human:ghost' }),
  ]
  const first = memberProblems(rows[0], { members: rows })
  assert.equal(first[0].level, 'error', 'a key the state machine cannot match is not a nitpick')
  assert.equal(first[0].field, 'key')
  assert.equal(first.slice(1).every((one) => one.level === 'warn'), true, 'the rest of the row is advice')

  const second = memberProblems(rows[1], { members: rows })
  assert.equal(second.some((one) => one.field === 'name' && one.level === 'warn'), true)
  assert.equal(second.some((one) => one.field === 'openId' && one.level === 'warn'), true, 'no open_id → button presses cannot be attributed')

  const third = memberProblems(rows[2], { members: rows })
  const fields = third.map((one) => one.field)
  assert.ok(fields.includes('openId'), 'a value that does not look like an open_id is worth saying')
  assert.ok(fields.includes('delegate'), 'a delegate who is not in the table will not answer either')
})

test('a malformed key is reported, and an empty one stops the row', () => {
  const empty = memberProblems(normalizeMember({}), { members: [] })
  assert.equal(empty[0].field, 'key')
  assert.match(empty[0].message, /成员键/)
  const duplicate = memberProblems(normalizeMember({ key: 'human:a' }), { members: [normalizeMember({ key: 'human:a' }), normalizeMember({ key: 'human:a' })] })
  assert.equal(duplicate.some((one) => /重复/.test(one.message)), true)
})

test('describeMember shows the roles, the binding and whether the person is active', () => {
  const line = describeMember(normalizeMember({ key: 'human:wang', name: '王梦凡', domains: ['pm'], active: false }))
  assert.match(line, /王梦凡（human:wang · member · pm · 未绑定 open_id · 停用）/)
})
