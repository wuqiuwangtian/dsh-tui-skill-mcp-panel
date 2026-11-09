import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { GroupsConflictError, deleteGroup, loadGroups, saveGroups, setGroupMembership, upsertGroup } from '../../lib/types/domain/groups.js'
import { withPatchLock } from '../../lib/types/domain/mcp/write.js'

const BASE = '{"version":1,"groups":{"a":{"name":"A","scopes":{"global":["alpha"]}}}}\n'
const EXTERNAL = '{"version":1,"groups":{"web":{"name":"web","scopes":{"global":["external"]}}}}\n'
async function fixture(t, text = BASE) {
  const root = await mkdtemp(join(tmpdir(), 'groups-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'shared', 'groups.json')
  const backupRoot = join(root, 'private-backups')
  await mkdir(dirname(file), { recursive: true })
  if (text !== undefined) await writeFile(file, text)
  const snapshot = await loadGroups(file)
  return { root, file, snapshot, options: { expectedFingerprint: snapshot.fingerprint, backupRoot } }
}
const noLocksOrTemps = async (file) => assert.deepEqual((await readdir(dirname(file))).filter((name) => name.includes('.tmp-') || name.endsWith('.panel.lock')), [])

test('stale create, rename, delete and member changes never overwrite an external snapshot', async (t) => {
  const { file, snapshot, options } = await fixture(t)
  const candidates = [
    upsertGroup(snapshot.groups, undefined, 'New', 'global', []).groups,
    { ...snapshot.groups, a: { ...snapshot.groups.a, name: 'Renamed' } },
    deleteGroup(snapshot.groups, 'a'),
    setGroupMembership(snapshot.groups, 'a', 'global', 'beta', true),
  ]
  await writeFile(file, EXTERNAL)
  for (const next of candidates) await assert.rejects(saveGroups(file, next, options), GroupsConflictError)
  assert.equal(await readFile(file, 'utf8'), EXTERNAL)
  await noLocksOrTemps(file)
})

test('cooperative writers serialize; the loser refreshes and retries without losing either member', async (t) => {
  const { file, snapshot, options } = await fixture(t)
  const outcomes = await Promise.allSettled(['one', 'two'].map((name) => saveGroups(file,
    setGroupMembership(snapshot.groups, 'a', 'global', name, true), options)))
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1)
  assert.ok(outcomes.find((r) => r.status === 'rejected').reason instanceof GroupsConflictError)
  const latest = await loadGroups(file)
  const retry = ['one', 'two'].find((name) => !latest.groups.a.scopes.global.includes(name))
  await saveGroups(file, setGroupMembership(latest.groups, 'a', 'global', retry, true), { ...options, expectedFingerprint: latest.fingerprint })
  assert.deepEqual([...JSON.parse(await readFile(file, 'utf8')).groups.a.scopes.global].sort(), ['alpha', 'one', 'two'])
  await noLocksOrTemps(file)
})

test('independent Node processes sharing one snapshot cannot both report a successful stale save', async (t) => {
  const { file, options } = await fixture(t)
  const moduleUrl = new URL('../../lib/types/domain/groups.js', import.meta.url).href
  const worker = `import {saveGroups,GroupsConflictError} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(process.argv.at(-1));
    try { await saveGroups(input.file,{a:{name:'A',scopes:{global:['alpha',input.member]}}},input.options); console.log('saved'); }
    catch(error) { if(!(error instanceof GroupsConflictError))throw error;console.log('conflict'); }`
  const results = await Promise.all(['process-one', 'process-two'].map(async (member) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify({ file, options, member })])
    return stdout.trim()
  }))
  assert.deepEqual(results.sort(), ['conflict', 'saved'])
  assert.equal((await loadGroups(file)).groups.a.scopes.global.length, 2)
  await noLocksOrTemps(file)
})

test('targeted changes preserve unknown fields and malformed foreign records/scopes', async (t) => {
  const raw = { version: 1, future: { keep: true }, groups: {
    a: { name: 'A', future: 'retain', scopes: { global: ['alpha', 7, 'alpha'], '/other': ['other'], bad: { future: true } } },
    broken: null, b: { name: 'B', scopes: { global: ['untouched'] }, unknown: [1] },
    c: { name: 'C', scopes: 'legacy-container', future: 'keep' },
  } }
  const { file, snapshot, options } = await fixture(t, JSON.stringify(raw))
  assert.ok(snapshot.warning)
  const renamed = { ...snapshot.groups, a: { ...snapshot.groups.a, name: 'Renamed' }, c: { ...snapshot.groups.c, name: 'Renamed-C' } }
  const saved = await saveGroups(file, renamed, options)
  const after = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(after, { ...raw, groups: { ...raw.groups, a: { ...raw.groups.a, name: 'Renamed' }, c: { ...raw.groups.c, name: 'Renamed-C' } } })
  await saveGroups(file, setGroupMembership(saved.groups, 'a', 'global', 'beta', true), { ...options, expectedFingerprint: saved.fingerprint })
  const next = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(next.groups.a.scopes, { global: ['alpha', 'beta'], '/other': ['other'], bad: { future: true } })
  assert.deepEqual(next.groups.b, raw.groups.b)
  assert.equal(next.groups.broken, null)
})

test('backup failure aborts replacement and cleans up the lock', async (t) => {
  const { root, file, snapshot, options } = await fixture(t)
  const blocked = join(root, 'blocked')
  await writeFile(blocked, 'not a directory')
  await assert.rejects(saveGroups(file, deleteGroup(snapshot.groups, 'a'), { ...options, backupRoot: blocked }), /备份失败/u)
  assert.equal(await readFile(file, 'utf8'), BASE)
  await noLocksOrTemps(file)
})

test('lockless replacement during precommit is detected; exact backup survives and temp is removed', async (t) => {
  const { file, snapshot, options } = await fixture(t)
  await assert.rejects(saveGroups(file, deleteGroup(snapshot.groups, 'a'), {
    ...options, beforeCommit: () => writeFile(file, EXTERNAL),
  }), GroupsConflictError)
  assert.equal(await readFile(file, 'utf8'), EXTERNAL)
  const folders = await readdir(join(options.backupRoot, 'skill-groups'))
  assert.equal(await readFile(join(options.backupRoot, 'skill-groups', folders[0], 'groups.json'), 'utf8'), BASE)
  await noLocksOrTemps(file)
})

test('corrupt bytes stay in place; recovery backups are exact, private and idempotent', async (t) => {
  const bytes = Buffer.from([123, 34, 99, 114, 101, 100, 101, 110, 116, 105, 97, 108, 255])
  const { file, snapshot, options } = await fixture(t, bytes)
  assert.equal(snapshot.writable, true)
  assert.ok(snapshot.warning.includes('已备份'))
  assert.ok(!snapshot.warning.includes('credential'))
  assert.deepEqual(await readFile(file), bytes)
  await loadGroups(file)
  const backups = (await readdir(dirname(file))).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1)
  assert.deepEqual(await readFile(join(dirname(file), backups[0])), bytes)
  assert.equal((await stat(join(dirname(file), backups[0]))).mode & 0o777, 0o600)
  const created = upsertGroup({}, undefined, 'Recovered', 'global', [])
  await saveGroups(file, created.groups, options)
  assert.equal(Object.values((await loadGroups(file)).groups)[0].name, 'Recovered')
})

test('a corrupt backup collision leaves the source read-only and refuses repair writes', async (t) => {
  const { file, options } = await fixture(t)
  const bytes = Buffer.from('{"private-token"')
  await writeFile(file, bytes)
  const fingerprint = createHash('sha256').update('file\0').update(bytes).digest('hex')
  await writeFile(`${file}.corrupt-${fingerprint}`, 'untrusted wrong backup')
  const loaded = await loadGroups(file)
  assert.equal(loaded.writable, false)
  assert.ok(loaded.warning.includes('备份失败'))
  assert.ok(!loaded.warning.includes('private-token'))
  await assert.rejects(saveGroups(file, {}, { ...options, expectedFingerprint: fingerprint }), /备份/u)
  assert.deepEqual(await readFile(file), bytes)
})

test('corrupt recovery re-reads after waiting for the lock and does not move a repaired web file', async (t) => {
  const { file } = await fixture(t)
  let pending
  await withPatchLock(file, async () => {
    await writeFile(file, '{ broken')
    pending = loadGroups(file)
    await sleep(25)
    await writeFile(file, EXTERNAL)
  })
  const loaded = await pending
  assert.equal(loaded.groups.web.name, 'web')
  assert.equal(loaded.warning, undefined)
  assert.equal(await readFile(file, 'utf8'), EXTERNAL)
  assert.deepEqual((await readdir(dirname(file))).filter((name) => name.includes('.corrupt-')), [])
})

test('future versions, invalid containers and symlinks are read-only; read failures are not empty success', async (t) => {
  const { root, file, options } = await fixture(t)
  for (const raw of ['{"version":2,"groups":{}}', '{"version":1,"groups":[]}', '[]']) {
    await writeFile(file, raw)
    const loaded = await loadGroups(file)
    assert.equal(loaded.writable, false)
    await assert.rejects(saveGroups(file, {}, { ...options, expectedFingerprint: loaded.fingerprint }))
    assert.equal(await readFile(file, 'utf8'), raw)
  }
  const target = join(root, 'target.json')
  await writeFile(target, BASE)
  await rm(file)
  await symlink(target, file)
  const linked = await loadGroups(file)
  assert.equal(linked.writable, false)
  await assert.rejects(saveGroups(file, {}, { ...options, expectedFingerprint: linked.fingerprint }))
  assert.equal(await readFile(target, 'utf8'), BASE)
  await writeFile(join(root, 'blocked'), 'file')
  await assert.rejects(loadGroups(join(root, 'blocked', 'groups.json')), { code: 'ENOTDIR' })
})

test('new files and backups are private; existing permission bits survive a restrictive umask', async (t) => {
  const { file, snapshot, options } = await fixture(t)
  await chmod(file, 0o640)
  const previous = process.umask(0o077)
  try {
    const saved = await saveGroups(file, setGroupMembership(snapshot.groups, 'a', 'global', 'beta', true), options)
    assert.equal((await stat(file)).mode & 0o777, 0o640)
    assert.equal((await stat(saved.backupPath)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(saved.backupPath))).mode & 0o777, 0o700)
    const fresh = join(dirname(file), 'new.json')
    await saveGroups(fresh, snapshot.groups, { ...options, expectedFingerprint: 'missing' })
    assert.equal((await stat(fresh)).mode & 0o777, 0o600)
  } finally { process.umask(previous) }
})

test('a file created after a missing snapshot is not replaced, and ids remain data including __proto__', async (t) => {
  const { file, snapshot, options } = await fixture(t, '{"version":1,"groups":{"__proto__":{"name":"Own","scopes":{"global":["alpha"]}}}}')
  const next = setGroupMembership(snapshot.groups, '__proto__', 'global', 'beta', true)
  await saveGroups(file, next, options)
  assert.deepEqual((await loadGroups(file)).groups.__proto__.scopes.global, ['alpha', 'beta'])
  assert.equal(Object.prototype.scopes, undefined)
  await rm(file)
  const missing = await loadGroups(file)
  await assert.rejects(saveGroups(file, snapshot.groups, { ...options, expectedFingerprint: missing.fingerprint, beforeCommit: () => writeFile(file, EXTERNAL) }), GroupsConflictError)
  assert.equal(await readFile(file, 'utf8'), EXTERNAL)
})
