import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { parsePatchText, writePatchFileAtomic, upsertManagedToggle } from '../../lib/types/domain/mcp/patch.js'
import { PatchConflictError, readPatchSnapshot, saveMcpMigration, saveMcpToggle, withPatchLock } from '../../lib/types/domain/mcp/write.js'

const PATCH = `# user-owned configuration\n- insert:\n    - id: mcp-alpha\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: alpha\n        transport: stdio\n        command: node\n        env:\n          TOKEN: !!js process.env.TOKEN\n`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const patchPath = join(root, 'cordis.patch.yml')
  const homePatchPath = join(root, 'home.yml')
  await writeFile(patchPath, PATCH, { mode: 0o640 })
  const input = {
    patchPath, homePatchPath,
    expectedProfile: (await readPatchSnapshot(patchPath)).fingerprint,
    expectedHome: (await readPatchSnapshot(homePatchPath)).fingerprint,
    id: 'mcp-alpha', serverName: 'alpha', disabled: true, backupRoot: join(root, 'backups'),
  }
  return { root, input }
}

test('guarded toggle backs up exact bytes, preserves permissions and releases the lock', async (t) => {
  const { input } = await fixture(t)
  const result = await saveMcpToggle(input)
  assert.equal(result.changed, true)
  assert.equal(await readFile(result.backupPath, 'utf8'), PATCH)
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600)
  assert.equal((await stat(input.patchPath)).mode & 0o777, 0o640)
  const saved = await readFile(input.patchPath, 'utf8')
  assert.equal(saved, PATCH.replace('      name:', '      disabled: true\n      name:'))
  assert.deepEqual(parsePatchText(saved).toggles, [])
  await assert.rejects(stat(`${input.patchPath}.panel.lock`), { code: 'ENOENT' })
  await saveMcpToggle({ ...input, disabled: false, expectedProfile: (await readPatchSnapshot(input.patchPath)).fingerprint })
  assert.equal(await readFile(input.patchPath, 'utf8'), PATCH)
})

test('explicit migration backs up the complete legacy file and preserves enabled state', async (t) => {
  const { input } = await fixture(t)
  const legacy = upsertManagedToggle(PATCH, 'mcp-alpha', true).text
  await writeFile(input.patchPath, legacy)
  const expectedProfile = (await readPatchSnapshot(input.patchPath)).fingerprint
  const result = await saveMcpMigration({...input,expectedProfile})
  assert.equal(await readFile(result.backupPath,'utf8'),legacy)
  const saved = parsePatchText(await readFile(input.patchPath,'utf8'))
  assert.deepEqual(saved.toggles,[])
  assert.equal(saved.rows.find(r=>r.id==='mcp-alpha').disabled,true)
})

test('migration is all-or-nothing for unsupported targets, home overrides and stale snapshots', async (t) => {
  for (const mode of ['missing','home','stale']) {
    const { input } = await fixture(t)
    let legacy = upsertManagedToggle(PATCH,'mcp-alpha',true).text
    if(mode==='missing') legacy=upsertManagedToggle(legacy,'missing',true).text
    await writeFile(input.patchPath,legacy)
    if(mode==='home') await writeFile(input.homePatchPath,'- id: mcp-alpha\n  disabled: true\n')
    const expectedProfile=(await readPatchSnapshot(input.patchPath)).fingerprint
    const expectedHome=(await readPatchSnapshot(input.homePatchPath)).fingerprint
    if(mode==='stale') await writeFile(input.patchPath,legacy+'# external\n')
    const before=await readFile(input.patchPath,'utf8')
    await assert.rejects(saveMcpMigration({...input,expectedProfile,expectedHome}))
    assert.equal(await readFile(input.patchPath,'utf8'),before)
    await assert.rejects(stat(input.backupRoot),{code:'ENOENT'})
  }
})

test('changed profile or home snapshots never overwrite an external edit', async (t) => {
  for (const layer of ['patchPath', 'homePatchPath']) {
    const { input } = await fixture(t)
    const external = layer === 'patchPath' ? `${PATCH}# external edit\n` : '- id: mcp-alpha\n  disabled: true\n'
    await writeFile(input[layer], external)
    await assert.rejects(saveMcpToggle(input), PatchConflictError)
    assert.equal(await readFile(input[layer], 'utf8'), external)
    if (layer === 'homePatchPath') assert.equal(await readFile(input.patchPath, 'utf8'), PATCH)
    await assert.rejects(stat(input.backupRoot), { code: 'ENOENT' })
  }
})

test('backup failure aborts the write and releases the lock', async (t) => {
  const { input } = await fixture(t)
  await writeFile(input.backupRoot, 'not a directory')
  await assert.rejects(saveMcpToggle(input), /备份失败/u)
  assert.equal(await readFile(input.patchPath, 'utf8'), PATCH)
  await assert.rejects(stat(`${input.patchPath}.panel.lock`), { code: 'ENOENT' })
})

test('concurrent writers serialize and the stale writer fails instead of losing an update', async (t) => {
  const { input } = await fixture(t)
  const results = await Promise.allSettled([saveMcpToggle(input), saveMcpToggle(input)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const failed = results.find((result) => result.status === 'rejected')
  assert.ok(failed.reason instanceof PatchConflictError)
  assert.equal((await readdir(input.backupRoot)).length, 1)
})

test('web-format live lock waits, times out without stealing, then succeeds after release', async (t) => {
  const { input } = await fixture(t)
  const lock = `${input.patchPath}.panel.lock`
  const token = `${process.pid}\n${Date.now()}\n`
  await writeFile(lock, token)
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  await assert.rejects(withPatchLock(input.patchPath, async () => assert.fail('must not run'), { timeoutMs: 20, pollMs: 5 }), /写锁超时/u)
  assert.equal(await readFile(lock, 'utf8'), token)
  const release = delay(30).then(() => rm(lock))
  const value = await withPatchLock(input.patchPath, async () => 'acquired')
  await release
  assert.equal(value, 'acquired')
})

test('old abandoned web-format locks are recovered and exceptions release our lock', async (t) => {
  const { input } = await fixture(t)
  const lock = `${input.patchPath}.panel.lock`
  await writeFile(lock, '0\n0\n')
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  await assert.rejects(withPatchLock(input.patchPath, async () => { throw new Error('test failure') }), /test failure/u)
  await assert.rejects(stat(lock), { code: 'ENOENT' })
})

test('releasing a lock never removes another writer\'s replacement lock', async (t) => {
  const { input } = await fixture(t)
  const lock = `${input.patchPath}.panel.lock`
  await withPatchLock(input.patchPath, async () => {
    await rm(lock)
    await writeFile(lock, 'replacement lock')
  })
  assert.equal(await readFile(lock, 'utf8'), 'replacement lock')
})

test('invalid home YAML and changed target identity cannot be written', async (t) => {
  const { input } = await fixture(t)
  await assert.rejects(saveMcpToggle({ ...input, serverName: 'different' }), PatchConflictError)
  await writeFile(input.homePatchPath, '- insert: [')
  const expectedHome = (await readPatchSnapshot(input.homePatchPath)).fingerprint
  await assert.rejects(saveMcpToggle({ ...input, expectedHome }), /YAML 非法/u)
  assert.equal(await readFile(input.patchPath, 'utf8'), PATCH)
})

test('a stale loader cannot make a non-MCP profile entry writable', async (t) => {
  const { input } = await fixture(t)
  const otherModule = PATCH.replace('@deepseek-ai/dsh-mcp-client', 'another-plugin')
  await writeFile(input.patchPath, otherModule)
  const expectedProfile = (await readPatchSnapshot(input.patchPath)).fingerprint
  await assert.rejects(saveMcpToggle({ ...input, expectedProfile }), PatchConflictError)
  assert.equal(await readFile(input.patchPath, 'utf8'), otherModule)
})

test('last-moment conflict cancels atomic replacement and cleans up the temporary file', async (t) => {
  const { root, input } = await fixture(t)
  const external = `${PATCH}# changed before commit\n`
  await assert.rejects(writePatchFileAtomic(input.patchPath, '[]', async () => {
    await writeFile(input.patchPath, external)
    throw new PatchConflictError()
  }), PatchConflictError)
  assert.equal(await readFile(input.patchPath, 'utf8'), external)
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp-')), [])
})
