import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  deleteGroup,
  groupIdsForSkill,
  groupMemberCount,
  loadGroups,
  parseGroupsPayload,
  saveGroups,
  setGroupMembership,
  upsertGroup,
} from '../../lib/types/domain/groups.js'

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'skill-groups-'))
  return { dir, file: join(dir, 'skills', '.system', 'skill-viewer', 'groups.json') }
}

test('groups round-trip keeps the web-panel v1 shape', async () => {
  const { dir, file } = await tempFile()
  try {
    const upserted = upsertGroup({}, undefined, '前端', 'global', ['alpha', 'beta'])
    assert.equal((await saveGroups(file, upserted.groups)), undefined)
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.deepEqual(raw.groups[upserted.id], { name: '前端', scopes: { global: ['alpha', 'beta'] } })

    const loaded = await loadGroups(file)
    assert.equal(loaded.warning, undefined)
    assert.deepEqual(loaded.groups, upserted.groups)

    const byScope = upsertGroup(loaded.groups, upserted.id, '前端', '/repo/project', ['gamma'])
    assert.deepEqual(byScope.groups[upserted.id].scopes, {
      global: ['alpha', 'beta'],
      '/repo/project': ['gamma'],
    })
    assert.equal(groupMemberCount(byScope.groups[upserted.id]), 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upsertGroup rejects empty/duplicate names and supports rename', async () => {
  const { dir, file } = await tempFile()
  try {
    assert.throws(() => upsertGroup({}, undefined, '   ', 'global', []), /不能为空/u)
    const first = upsertGroup({}, undefined, '组A', 'global', ['alpha'])
    assert.throws(() => upsertGroup(first.groups, undefined, '组a', 'global', []), /已存在/u)
    const renamed = upsertGroup(first.groups, first.id, '组B', 'global', ['alpha'])
    assert.equal(renamed.groups[first.id].name, '组B')
    assert.equal(renamed.id, first.id)
    // removing the last scope member drops the scope entry but keeps the group
    const emptied = upsertGroup(renamed.groups, first.id, '组B', 'global', [])
    assert.deepEqual(emptied.groups[first.id].scopes, {})
    assert.equal(deleteGroup(emptied.groups, first.id)[first.id], undefined)
    await saveGroups(file, emptied.groups)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('setGroupMembership and groupIdsForSkill track (scope, name) pairs', async () => {
  const { dir } = await tempFile()
  try {
    const created = upsertGroup({}, undefined, '组', 'global', ['alpha'])
    let groups = created.groups
    groups = setGroupMembership(groups, created.id, 'global', 'beta', true)
    groups = setGroupMembership(groups, created.id, 'global', 'alpha', false)
    assert.deepEqual(groups[created.id].scopes.global, ['beta'])
    assert.deepEqual(groupIdsForSkill(groups, 'global', 'beta'), [created.id])
    assert.deepEqual(groupIdsForSkill(groups, 'global', 'alpha'), [])
    assert.deepEqual(groupIdsForSkill(groups, '/repo', 'beta'), [])
    assert.throws(() => setGroupMembership(groups, 'missing', 'global', 'x', true), /分组不存在/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('corrupt groups file is backed up and treated as empty', async () => {
  const { dir, file } = await tempFile()
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')
    const loaded = await loadGroups(file)
    assert.deepEqual(loaded.groups, {})
    assert.match(loaded.warning ?? '', /损坏/u)
    const entries = await readdir(dirname(file))
    assert.equal(entries.some((name) => name.includes('.corrupt-')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseGroupsPayload drops malformed groups and members', () => {
  const parsed = parseGroupsPayload({
    version: 1,
    groups: {
      a: { name: 'A', scopes: { global: ['x', 1, 'y'], bad: 'no' } },
      b: { name: '', scopes: {} },
      c: null,
      d: { scopes: { global: ['x'] } },
    },
  })
  assert.deepEqual(parsed, { a: { name: 'A', scopes: { global: ['x', 'y'] } } })
})
