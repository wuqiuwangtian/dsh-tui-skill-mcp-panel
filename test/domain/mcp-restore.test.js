import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addManagedMcp, deleteManagedMcp, findManagedMcp } from '../../lib/types/domain/mcp/managed.js'
import { deleteMcpEntry, openMcpEditor, restoreMcpEntry, prepareMcpRestore, mergeRestoreMcpEntry } from '../../lib/types/domain/mcp/crud.js'
import { jsValue, parsePatchText, upsertManagedToggle } from '../../lib/types/domain/mcp/patch.js'
import { readPatchSnapshot, PatchConflictError } from '../../lib/types/domain/mcp/write.js'

const FOREIGN = '# foreign bytes\n- insert:\n    - id: foreign\n      name: other\n      config: { keep: " exact " }\n'
const CONFIG = { serverName: 'local', transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: jsValue('process.env.RESTORE_TOKEN') }, future: { nested: 'private-fixture-value' } }
const target = { id: 'managed', serverName: 'local' }

async function fixture(t, source = addManagedMcp(FOREIGN, target.id, CONFIG)) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const patchPath = join(root, 'profile.yml'), homePatchPath = join(root, 'home.yml')
  const backupRoot = join(root, 'backups'), trashDir = join(root, 'trash')
  await writeFile(patchPath, source, { mode: 0o640 })
  const files = async () => ({ patchPath, homePatchPath, expectedProfile: (await readPatchSnapshot(patchPath)).fingerprint, expectedHome: (await readPatchSnapshot(homePatchPath)).fingerprint })
  const session = await openMcpEditor(await files(), target)
  const deleted = await deleteMcpEntry({ session, backupRoot, trashDir })
  const request = async () => ({ files: await files(), backupRoot, trashDir, batchId: deleted.value.batchId })
  const prepare = async () => prepareMcpRestore(await request())
  const commit = plan => mergeRestoreMcpEntry({ plan, backupRoot, trashDir })
  return { root, source, patchPath, homePatchPath, backupRoot, trashDir, deleted, files, request, prepare, commit,
    manifest: join(trashDir, deleted.value.batchId, 'manifest.json') }
}

test('strict undo still refuses external changes; explicit merge retains latest bytes and original raw row', async t => {
  const source = addManagedMcp(FOREIGN, target.id, CONFIG).replace('      config:', '      disabled: true # retain flag\n      optional: true\n      config:')
  const fx = await fixture(t, source)
  const current = addManagedMcp(await readFile(fx.patchPath, 'utf8'), 'new-server', { serverName: 'new-server', transport: 'stdio', command: 'new-node' }) + '# after deletion\n'
  await writeFile(fx.patchPath, current)
  await assert.rejects(restoreMcpEntry(await fx.request()), PatchConflictError)
  const backups = await readdir(fx.backupRoot), plan = await fx.prepare()
  assert.deepEqual(await readdir(fx.backupRoot), backups, 'preview does not create backups')
  assert.equal(await readFile(fx.patchPath, 'utf8'), current)
  assert.ok(!JSON.stringify(plan).includes('private-fixture-value'))
  assert.equal(plan.enabled, false)
  const result = await fx.commit(plan), merged = await readFile(fx.patchPath, 'utf8')
  assert.equal(await readFile(result.backupPath, 'utf8'), current)
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600)
  assert.equal((await stat(fx.patchPath)).mode & 0o777, 0o640)
  const before = findManagedMcp(source, target.id, target.serverName), after = findManagedMcp(merged, target.id, target.serverName)
  assert.equal(merged.slice(after.start, after.end), source.slice(before.start, before.end))
  assert.equal(deleteManagedMcp(merged, target.id, target.serverName).text, current)
  await assert.rejects(stat(fx.manifest), { code: 'ENOENT' })
})

test('merge recovery supports a newly empty root and CRLF source without reviving removed foreign rows', async t => {
  for (const current of ['[]\n# current empty\n', '# current comments only\n']) {
    const fx = await fixture(t, addManagedMcp(FOREIGN, target.id, CONFIG).replaceAll('\n', '\r\n'))
    await writeFile(fx.patchPath, current)
    await fx.commit(await fx.prepare())
    const merged = await readFile(fx.patchPath, 'utf8'), parsed = parsePatchText(merged)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.rows.length, 1)
    assert.equal(parsed.rows[0].id, target.id)
    assert.ok(merged.includes('# current'))
    assert.ok(merged.includes('\r\n'))
    assert.ok(!merged.includes('foreign bytes'))
  }
})

test('same id, same name and home collisions refuse merge and preserve current data', async t => {
  const fx = await fixture(t), clean = await readFile(fx.patchPath, 'utf8')
  const collisions = ['- id: managed\n  disabled: true\n', '- insert:\n    - id: different\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: {serverName: local, transport: stdio, command: other}\n']
  for (const layer of [fx.patchPath, fx.homePatchPath]) {
    for (const collision of collisions) {
      await writeFile(fx.patchPath, clean)
      await writeFile(layer, (layer === fx.patchPath ? clean : '') + collision)
      const before = await readFile(fx.patchPath, 'utf8')
      await assert.rejects(fx.prepare(), /同 id|同名|serverName/u)
      assert.equal(await readFile(fx.patchPath, 'utf8'), before)
      await rm(fx.homePatchPath, { force: true })
    }
  }
})

test('legacy target overrides remain strict-undo only; merge never resurrects old override blocks', async t => {
  const source = upsertManagedToggle(addManagedMcp(FOREIGN, target.id, CONFIG), target.id, true).text
  const fx = await fixture(t, source), current = await readFile(fx.patchPath, 'utf8')
  await writeFile(fx.patchPath, current + '# external\n')
  await assert.rejects(fx.prepare(), /另有启停/u)
  await writeFile(fx.patchPath, current)
  await restoreMcpEntry(await fx.request())
  assert.equal(await readFile(fx.patchPath, 'utf8'), source)
})

test('YAML anchors and aliases in an old row are not rebound to potentially changed current anchors', async t => {
  const source = addManagedMcp(FOREIGN, target.id, CONFIG).replace('        future:', '        future: &saved').replace('          nested: private-fixture-value', '          nested: private-fixture-value\n        alias: *saved')
  const fx = await fixture(t, source)
  await assert.rejects(fx.prepare(), /锚点或别名/u)
})

test('invalid YAML and damaged managed markers refuse merge without touching the record', async t => {
  const fx = await fixture(t), journal = await readFile(fx.manifest)
  for (const invalid of ['- broken: [\n', '# >>> dsh-tui-skill-mcp-panel:mcp:begin\n']) {
    await writeFile(fx.patchPath, invalid)
    await assert.rejects(fx.prepare())
    assert.equal(await readFile(fx.patchPath, 'utf8'), invalid)
    assert.deepEqual(await readFile(fx.manifest), journal)
  }
})

test('profile/home changes after preview invalidate merge confirmation', async t => {
  const fx = await fixture(t)
  for (const path of [fx.patchPath, fx.homePatchPath]) {
    const plan = await fx.prepare(), previous = await readFile(path, 'utf8').catch(() => '')
    await writeFile(path, previous + '# changed after preview\n')
    const before = await readFile(fx.patchPath, 'utf8')
    await assert.rejects(fx.commit(plan), PatchConflictError)
    assert.equal(await readFile(fx.patchPath, 'utf8'), before)
    assert.ok((await stat(fx.manifest)).isFile())
  }
})

test('changed journal, old backup or candidate fingerprint cannot be committed', async t => {
  const fx = await fixture(t), originalJournal = await readFile(fx.manifest, 'utf8'), plan = await fx.prepare()
  await writeFile(fx.manifest, originalJournal + '\n')
  await assert.rejects(fx.commit(plan), /已变化/u)
  await writeFile(fx.manifest, originalJournal)
  await assert.rejects(fx.commit({ ...plan, candidateFingerprint: 'changed' }), PatchConflictError)
  await writeFile(fx.deleted.backupPath, fx.source + '# source changed\n')
  await assert.rejects(fx.commit(plan), /备份内容已变化/u)
  assert.equal(await readFile(fx.patchPath, 'utf8'), FOREIGN)
})

test('journal identity/removal offsets must agree with the original backup', async t => {
  const fx = await fixture(t), journal = JSON.parse(await readFile(fx.manifest, 'utf8'))
  for (const change of [{ offset: -1 }, { offset: journal.offset + 1 }, { removed: 'changed' }, { afterFingerprint: 'changed' }]) {
    await writeFile(fx.manifest, JSON.stringify({ ...journal, ...change }))
    await assert.rejects(fx.prepare(), /损坏|不一致/u)
    assert.equal(await readFile(fx.patchPath, 'utf8'), FOREIGN)
  }
})

test('undo requires its recorded backup path even when another copy has identical bytes', async t => {
  const fx = await fixture(t)
  const plan = await fx.prepare()
  const journal = await readFile(fx.manifest)
  const stored = fx.deleted.backupPath
  const moved = join(fx.backupRoot, 'identical-copy.yml')
  await rename(stored, moved)
  const request = await fx.request()
  for (const attempt of [
    () => restoreMcpEntry(request),
    () => fx.prepare(),
    () => fx.commit(plan),
  ]) {
    await assert.rejects(attempt, { code: 'ENOENT', path: stored })
    assert.equal(await readFile(fx.patchPath, 'utf8'), FOREIGN)
    assert.deepEqual(await readFile(fx.manifest), journal)
  }
  await rename(moved, stored)
  const restored = await restoreMcpEntry(request)
  assert.equal(await readFile(fx.patchPath, 'utf8'), fx.source)
  assert.equal(await readFile(stored, 'utf8'), fx.source)
  assert.equal(await readFile(restored.backupPath, 'utf8'), FOREIGN)
  await assert.rejects(stat(fx.manifest), { code: 'ENOENT' })
})

test('merge backup failure keeps both current file and deletion source intact', async t => {
  if (process.getuid?.() === 0) return t.skip('requires normal-user directory permissions')
  const fx = await fixture(t), plan = await fx.prepare(), record = await readFile(fx.manifest)
  await chmod(fx.backupRoot, 0o500)
  try {
    await assert.rejects(fx.commit(plan), /备份失败/u)
    assert.equal(await readFile(fx.patchPath, 'utf8'), FOREIGN)
    assert.deepEqual(await readFile(fx.manifest), record)
  } finally { await chmod(fx.backupRoot, 0o700) }
})

test('successful restore with failed record cleanup remains saved with an explicit warning and original backup', async t => {
  if (process.getuid?.() === 0) return t.skip('requires normal-user directory permissions')
  const fx = await fixture(t), batchDir = join(fx.trashDir, fx.deleted.value.batchId)
  await chmod(batchDir, 0o500)
  try {
    const result = await restoreMcpEntry(await fx.request())
    assert.equal(await readFile(fx.patchPath, 'utf8'), fx.source)
    assert.match(result.warning, /已恢复.*清理未完成/u)
    assert.equal(await readFile(fx.deleted.backupPath, 'utf8'), fx.source)
    assert.ok((await stat(fx.manifest)).isFile())
  } finally { await chmod(batchDir, 0o700) }
})
