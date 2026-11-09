import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteMcpGroup, filterMcpRows, groupsForMcpProfile, mcpGroupIds, mcpMemberKey, parseMcpGroups, renameMcpMember, setMcpMembership, upsertMcpGroup } from '../../lib/types/domain/mcp/groups.js'
import { configFile, loadPanelDocument, updateMcpGroups } from '../../lib/types/domain/store.js'

const PROFILE_A = '/profiles/a/cordis.patch.yml'
const PROFILE_B = '/profiles/b/cordis.patch.yml'
const alpha = { id: 'entry-a', entryId: 'entry-a', serverName: 'alpha', transport: 'stdio', enabled: true, phase: 'active', layer: 'profile', targetable: true, overriddenByHome: false, notes: [] }
const sameName = { ...alpha, id: 'entry-b', entryId: 'entry-b', enabled: false, phase: 'disposed' }
const failed = { ...alpha, id: 'entry-c', entryId: 'entry-c', serverName: 'broken', enabled: true, phase: 'failed', transport: 'streamable-http', layer: 'home', targetable: false, config: { env: { TOKEN: 'must-not-be-searchable' } } }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-groups-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('profile groups isolate identical pairs and permit same names across profiles', () => {
  const a = upsertMcpGroup({}, PROFILE_A, undefined, '工具', [mcpMemberKey(alpha)])
  const b = upsertMcpGroup(a.groups, PROFILE_B, undefined, '工具', [mcpMemberKey(sameName)])
  assert.deepEqual(mcpGroupIds(b.groups, PROFILE_A, alpha), [a.id])
  assert.deepEqual(mcpGroupIds(b.groups, PROFILE_B, alpha), [])
  assert.deepEqual(mcpGroupIds(b.groups, PROFILE_A, sameName), [])
  assert.equal(Object.keys(groupsForMcpProfile(b.groups, PROFILE_A)).length, 1)
  assert.throws(() => upsertMcpGroup(b.groups, PROFILE_A, undefined, '工具'), /同名/u)
  assert.throws(() => deleteMcpGroup(b.groups, PROFILE_A, b.id), /其他 profile/u)
  assert.throws(() => upsertMcpGroup({}, PROFILE_A, undefined, '\n'), /不能为空/u)
  assert.throws(() => upsertMcpGroup({}, PROFILE_A, undefined, 'bad\x1bname'), /控制字符/u)
})

test('membership, rename and empty groups preserve double-key identity', () => {
  const a = upsertMcpGroup({}, PROFILE_A, undefined, 'A')
  let groups = setMcpMembership(a.groups, PROFILE_A, a.id, alpha, true)
  groups = setMcpMembership(groups, PROFILE_A, a.id, sameName, true)
  assert.equal(groups[a.id].members.length, 2)
  const b = upsertMcpGroup(groups, PROFILE_B, undefined, 'A', [mcpMemberKey(alpha)])
  groups = renameMcpMember(b.groups, PROFILE_A, alpha, { ...alpha, serverName: 'renamed' })
  assert.deepEqual(mcpGroupIds(groups, PROFILE_A, { ...alpha, serverName: 'renamed' }), [a.id])
  assert.deepEqual(mcpGroupIds(groups, PROFILE_B, alpha), [b.id])
  groups = setMcpMembership(groups, PROFILE_A, a.id, sameName, false)
  groups = setMcpMembership(groups, PROFILE_A, a.id, { ...alpha, serverName: 'renamed' }, false)
  assert.deepEqual(groups[a.id].members, [])
  assert.equal(groups[a.id].name, 'A')
})

test('metadata search combines status/group filters without indexing credentials', () => {
  const created = upsertMcpGroup({}, PROFILE_A, undefined, '知识库', [mcpMemberKey(alpha), mcpMemberKey(failed)])
  const opts = { profilePath: PROFILE_A, groups: created.groups, query: '', status: 'all' }
  const rows = [alpha, sameName, failed]
  assert.deepEqual(filterMcpRows(rows, { ...opts, query: '知识库 http', status: 'failed', groupId: created.id }), [failed])
  assert.deepEqual(filterMcpRows(rows, { ...opts, status: 'disabled' }), [sameName])
  assert.deepEqual(filterMcpRows(rows, { ...opts, query: 'entry-b ALPHA' }), [sameName])
  assert.deepEqual(filterMcpRows(rows, { ...opts, query: 'must-not-be-searchable' }), [])
  assert.deepEqual(filterMcpRows(rows, { ...opts, profilePath: PROFILE_B, groupId: created.id }), [])
})

test('invalid and legacy unbound records are hidden with warning, never guessed', () => {
  const parsed = parseMcpGroups({
    legacy: { name: 'old', members: ['opaque'] },
    good: { name: 'A', profilePath: PROFILE_A, members: [mcpMemberKey(alpha), mcpMemberKey(alpha)] },
    bad: { name: 'B', profilePath: PROFILE_A, members: ['alpha:entry-a'] },
  })
  assert.deepEqual(Object.keys(parsed.groups), ['good'])
  assert.deepEqual(parsed.groups.good.members, [mcpMemberKey(alpha)])
  assert.ok(parsed.warning.includes('2 个'))
})

test('private persistence keeps unknown settings, invalid records and other profile bytes as data', async (t) => {
  const dir = await fixture(t)
  const b = upsertMcpGroup({}, PROFILE_B, undefined, '  B  ', [mcpMemberKey(alpha)])
  const otherRaw = { ...b.groups[b.id], name: '  B  ', members: [mcpMemberKey(alpha), mcpMemberKey(alpha)], future: { keep: true } }
  const legacy = { name: 'unbound', members: ['legacy'] }
  await writeFile(configFile(dir), JSON.stringify({ version: 1, trashRetentionDays: 23, future: { secret: 'private-setting' }, mcpGroups: { [b.id]: otherRaw, legacy } }))
  const document = await loadPanelDocument(dir)
  assert.ok(document.warning)
  const result = await updateMcpGroups(dir, PROFILE_A, (groups) => upsertMcpGroup(groups, PROFILE_A, undefined, 'A', [mcpMemberKey(alpha)]).groups, document.config.mcpGroups)
  const raw = JSON.parse(await readFile(configFile(dir), 'utf8'))
  assert.deepEqual(raw.mcpGroups[b.id], otherRaw)
  assert.deepEqual(raw.mcpGroups.legacy, legacy)
  assert.deepEqual(raw.future, { secret: 'private-setting' })
  assert.equal(raw.trashRetentionDays, 23)
  assert.equal(Object.keys(groupsForMcpProfile(result.config.mcpGroups, PROFILE_A)).length, 1)
})

test('concurrent profiles merge; stale edits to the same profile are rejected', async (t) => {
  const dir = await fixture(t)
  const snapshot = (await loadPanelDocument(dir)).config.mcpGroups
  await Promise.all([
    updateMcpGroups(dir, PROFILE_A, (groups) => upsertMcpGroup(groups, PROFILE_A, undefined, 'same').groups, snapshot),
    updateMcpGroups(dir, PROFILE_B, (groups) => upsertMcpGroup(groups, PROFILE_B, undefined, 'same').groups, snapshot),
  ])
  const document = await loadPanelDocument(dir)
  assert.equal(Object.keys(document.config.mcpGroups).length, 2)
  assert.equal((await stat(configFile(dir))).mode & 0o777, 0o600)
  await assert.rejects(updateMcpGroups(dir, PROFILE_A, (groups) => upsertMcpGroup(groups, PROFILE_A, undefined, 'lost').groups, snapshot), /已被修改/u)
  assert.equal(Object.keys((await loadPanelDocument(dir)).config.mcpGroups).length, 2)
  await assert.rejects(stat(`${configFile(dir)}.panel.lock`), { code: 'ENOENT' })
})

test('corrupt/future config is read-only, and even an in-place cross-profile mutation is refused', async (t) => {
  const dir = await fixture(t)
  for (const bad of ['{"secret": "do-not-show"', '{"version":99}', '{"version":1,"mcpGroups":[]}']) {
    await writeFile(configFile(dir), bad)
    const document = await loadPanelDocument(dir)
    assert.equal(document.writable, false)
    assert.equal(document.warning.includes('do-not-show'), false)
    await assert.rejects(updateMcpGroups(dir, PROFILE_A, (groups) => groups))
    assert.equal(await readFile(configFile(dir), 'utf8'), bad)
  }
  const b = upsertMcpGroup({}, PROFILE_B, undefined, 'B')
  await writeFile(configFile(dir), JSON.stringify({ version: 1, mcpGroups: b.groups }))
  const before = await readFile(configFile(dir), 'utf8')
  await assert.rejects(updateMcpGroups(dir, PROFILE_A, (groups) => { groups[b.id].name = 'illegal'; return groups }), /跨 profile/u)
  assert.equal(await readFile(configFile(dir), 'utf8'), before)
})
