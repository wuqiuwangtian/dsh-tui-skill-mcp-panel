import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addManagedMcp } from '../../lib/types/domain/mcp/managed.js'
import { mcpMemberKey, repairMcpMember, unmatchedMcpMembers } from '../../lib/types/domain/mcp/groups.js'
import { prepareMcpGroupRepair, commitMcpGroupRepair } from '../../lib/types/domain/mcp/group-repair.js'

const before = { serverName: 'old-name', entryId: 'same-id' }, after = { ...before, serverName: 'new-name' }
const other = { serverName: 'other', entryId: 'other-id' }
const group = (profilePath, name, members) => ({ profilePath, name, members: members.map(mcpMemberKey) })
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-group-repair-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'panel'), patchPath = join(root, 'profile.yml'), homePatchPath = join(root, 'home.yml')
  await mkdir(home)
  const profile = addManagedMcp('# untouched YAML bytes\n', after.entryId, { serverName: after.serverName, transport: 'stdio', command: 'node', env: { TOKEN: 'private-mcp-value' } })
  const global = '# untouched home bytes\n'
  await writeFile(patchPath, profile)
  await writeFile(homePatchPath, global)
  const raw = { version: 1, lastTab: 'mcp', future: { secret: 'private-preference-value' }, mcpGroups: {
    a: { ...group(patchPath, 'Tools', [before, other, after]), future: { keep: true } },
    b: group(patchPath, 'Second', [before]),
    foreign: { ...group(join(root, 'foreign.yml'), 'Tools', [before]), future: 17 },
    invalid: { name: 'unbound', members: ['legacy-opaque'] },
  } }
  const configPath = join(home, 'config.json'), bytes = ` ${JSON.stringify(raw)}\n\n`
  await writeFile(configPath, bytes, { mode: 0o640 })
  const backupRoot = join(root, 'backups'), files = { patchPath, homePatchPath }
  const prepare = () => prepareMcpGroupRepair(home, files, before, after)
  const commit = plan => commitMcpGroupRepair(home, plan, backupRoot)
  return { root, home, files, profile, global, raw, configPath, bytes, backupRoot, prepare, commit }
}

test('missing references are grouped per profile, retained with zero rows, never inferred by id', () => {
  const path = '/profile.yml', groups = { a: group(path, 'A', [before, after]), b: group(path, 'B', [before]), foreign: group('/foreign.yml', 'F', [before]) }
  assert.deepEqual(unmatchedMcpMembers(groups, path, [after]), [{ ...before, key: mcpMemberKey(before), groupIds: ['a', 'b'] }])
  assert.equal(unmatchedMcpMembers(groups, path, []).length, 2)
  const result = repairMcpMember(groups, path, before, after, [after])
  assert.deepEqual(result.a.members, [mcpMemberKey(after)])
  assert.deepEqual(result.b.members, [mcpMemberKey(after)])
  assert.deepEqual(result.foreign, groups.foreign)
  assert.deepEqual(groups.a.members, [mcpMemberKey(before), mcpMemberKey(after)])
  for (const rows of [[], [before, after], [after, { ...after, serverName: 'duplicate' }]]) assert.throws(() => repairMcpMember(groups, path, before, after, rows))
  assert.throws(() => repairMcpMember(groups, path, before, other, [other]), /同 entryId/u)
})

test('preview is read-only; confirmed repair backs up exact bytes and preserves unrelated data and both YAML layers', async t => {
  const fx = await fixture(t), plan = await fx.prepare()
  assert.equal(await readFile(fx.configPath, 'utf8'), fx.bytes)
  await assert.rejects(stat(fx.backupRoot), { code: 'ENOENT' })
  assert.ok(!JSON.stringify(plan).includes('private-'))
  assert.deepEqual(plan.groups.map(g => g.id), ['a', 'b'])
  const result = await fx.commit(plan), raw = JSON.parse(await readFile(fx.configPath, 'utf8'))
  assert.equal(await readFile(result.backupPath, 'utf8'), fx.bytes)
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600)
  assert.equal((await stat(join(result.backupPath, '..'))).mode & 0o777, 0o700)
  assert.equal((await stat(fx.configPath)).mode & 0o777, 0o640)
  assert.deepEqual(raw.mcpGroups.a.members, [mcpMemberKey(after), mcpMemberKey(other)])
  assert.deepEqual(raw.mcpGroups.b.members, [mcpMemberKey(after)])
  for (const key of ['foreign', 'invalid']) assert.deepEqual(raw.mcpGroups[key], fx.raw.mcpGroups[key])
  assert.deepEqual(raw.future, fx.raw.future)
  assert.deepEqual(raw.mcpGroups.a.future, { keep: true })
  assert.equal(result.warning.includes('1 个'), true)
  assert.equal(await readFile(fx.files.patchPath, 'utf8'), fx.profile)
  assert.equal(await readFile(fx.files.homePatchPath, 'utf8'), fx.global)
  const repaired = await readFile(fx.configPath, 'utf8')
  await assert.rejects(fx.commit(plan), /变化/u)
  assert.equal(await readFile(fx.configPath, 'utf8'), repaired)
})

test('changes to profile, home or config invalidate preview without any metadata write', async t => {
  for (const key of ['patchPath', 'homePatchPath', 'configPath']) {
    const fx = await fixture(t), plan = await fx.prepare(), path = fx.files[key] ?? fx[key]
    const previous = await readFile(path, 'utf8')
    await writeFile(path, previous + (key === 'configPath' ? ' ' : '# external edit\n'))
    const config = await readFile(fx.configPath)
    await assert.rejects(fx.commit(plan), /变化/u)
    assert.deepEqual(await readFile(fx.configPath), config)
    await assert.rejects(stat(fx.backupRoot), { code: 'ENOENT' })
  }
})

test('home overrides, foreign overrides, duplicate definitions and duplicate names are rejected', async t => {
  const cases = [
    ['homePatchPath', '- id: same-id\n  disabled: true\n'],
    ['patchPath', '- id: same-id\n  disabled: true\n'],
    ['patchPath', addManagedMcp('', after.entryId, { serverName: 'duplicate', transport: 'stdio', command: 'node' })],
    ['patchPath', addManagedMcp('', 'other-id', { serverName: after.serverName, transport: 'stdio', command: 'node' })],
  ]
  for (const [key, extra] of cases) {
    const fx = await fixture(t)
    await writeFile(fx.files[key], (await readFile(fx.files[key], 'utf8')) + extra)
    await assert.rejects(fx.prepare(), /唯一确认/u)
    assert.equal(await readFile(fx.configPath, 'utf8'), fx.bytes)
  }
})

test('corrupt/future/invalid UTF-8/symlink configs and malformed YAML remain untouched', async t => {
  for (const bad of ['{"secret":"hidden"', '{"version":99}', '{"version":1,"mcpGroups":[]}', Buffer.from([0x7b,0x7d,0xff])]) {
    const fx = await fixture(t)
    await writeFile(fx.configPath, bad)
    const bytes = await readFile(fx.configPath)
    await assert.rejects(fx.prepare())
    assert.deepEqual(await readFile(fx.configPath), bytes)
  }
  const fx = await fixture(t), dest = join(fx.root, 'linked-config.json')
  await writeFile(dest, fx.bytes); await rm(fx.configPath); await symlink(dest, fx.configPath)
  await assert.rejects(fx.prepare(), /普通文件/u)
  assert.equal(await readFile(dest, 'utf8'), fx.bytes)
  await rm(fx.configPath); await writeFile(fx.configPath, fx.bytes)
  await writeFile(fx.files.patchPath, '- invalid: [\n')
  await assert.rejects(fx.prepare(), /YAML/u)
})

test('backup failure stops the write and releases the config lock', async t => {
  const fx = await fixture(t), plan = await fx.prepare()
  await writeFile(fx.backupRoot, 'not a directory')
  await assert.rejects(fx.commit(plan), /备份失败/u)
  assert.equal(await readFile(fx.configPath, 'utf8'), fx.bytes)
  await assert.rejects(stat(`${fx.configPath}.panel.lock`), { code: 'ENOENT' })
  await rm(fx.backupRoot)
  const result = await fx.commit(plan)
  assert.equal(await readFile(result.backupPath, 'utf8'), fx.bytes)
})

test('an unwritable config directory cannot silently succeed after creating a backup', async t => {
  const fx = await fixture(t), plan = await fx.prepare()
  await chmod(fx.home, 0o500)
  try {
    await assert.rejects(fx.commit(plan))
    assert.equal(await readFile(fx.configPath, 'utf8'), fx.bytes)
  } finally { await chmod(fx.home, 0o700) }
})
