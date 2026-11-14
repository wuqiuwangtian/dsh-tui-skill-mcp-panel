import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSkills } from '../../lib/types/domain/skills/filter.js'
const row = (id, name, status, scope = 'workspace', extra = {}) => ({ id, name, status, scope, description: '中文 fixture', rank: scope === 'workspace' ? 100 : 400, effective: status === 'enabled', providerOrder: 0, ...extra })
const rows = [row('on', 'alpha', 'enabled'), row('shadow', 'alpha', 'enabled', 'global', { effective: false, shadowedBy: 'on' }), row('off', 'beta', 'disabled'), row('bad', 'broken', 'invalid')]
const scan = { projectRoot: '/project/a', instances: rows }
const options = { scope: 'all', status: 'all', query: '', groups: {} }
const ids = (opts = {}, value = scan) => filterSkills(value, { ...options, ...opts }).map(row => row.id)

test('status includes enabled shadowed instances and keeps disabled/invalid distinct', () => {
  assert.deepEqual(ids({ status: 'enabled' }), ['on', 'shadow'])
  assert.deepEqual(ids({ status: 'disabled' }), ['off'])
  assert.deepEqual(ids({ status: 'invalid' }), ['bad'])
  assert.deepEqual(ids(), ['on', 'shadow', 'off', 'bad'])
})
test('scope, case-insensitive name/description query and status intersect', () => {
  assert.deepEqual(ids({ scope: 'global', status: 'enabled', query: ' ALPHA ' }), ['shadow'])
  assert.deepEqual(ids({ scope: 'workspace', status: 'disabled', query: '中文' }), ['off'])
  assert.deepEqual(ids({ status: 'disabled', query: 'alpha' }), [])
  assert.deepEqual(ids({ status: 'invalid', query: 'BROKEN' }), ['bad'])
})
test('group membership uses exact global/project scope and does not leak same-name members', () => {
  const groups = { a: { name: 'A', scopes: { '/project/a': ['alpha', 'beta'], global: [] } } }
  assert.deepEqual(ids({ groups, groupId: 'a', status: 'enabled' }), ['on'])
  assert.deepEqual(ids({ groups, groupId: 'a', query: 'beta', status: 'disabled' }), ['off'])
  assert.deepEqual(ids({ groups, groupId: 'a' }, { ...scan, projectRoot: '/project/b' }), [])
  assert.deepEqual(ids({ groups, groupId: 'missing' }), [])
})
test('all preserves existing name/effective/rank/provider order without mutating scan or groups', () => {
  const value = { projectRoot: '/p', instances: [row('z','z','enabled'), row('late','same','enabled','workspace',{ effective:false,rank:200,providerOrder:3 }), row('early','same','enabled','workspace',{ effective:false,rank:200,providerOrder:2 }), row('winner','same','enabled','global',{rank:400}), row('rank','same','enabled','workspace',{effective:false,rank:100})] }
  const before = structuredClone(value)
  assert.deepEqual(ids({}, value), ['winner','rank','early','late','z'])
  assert.deepEqual(value, before)
})
test('missing scan and unsupported status fail closed', () => {
  assert.deepEqual(filterSkills(undefined, options), [])
  assert.deepEqual(ids({ status: 'unexpected' }), [])
})
