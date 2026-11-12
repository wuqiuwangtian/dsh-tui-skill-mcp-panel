import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { addManagedMcp, deleteManagedMcp, editManagedMcp, managedMcpEntries, MCP_BLOCK_BEGIN, MCP_BLOCK_END } from '../../lib/types/domain/mcp/managed.js'
import { configChanges, environmentReference, fieldDisplay, patchMcpField, validateMcpConfig } from '../../lib/types/domain/mcp/model.js'
import { isJsValue, jsValue, parsePatchText, upsertManagedToggle } from '../../lib/types/domain/mcp/patch.js'
import { deleteMcpEntry, listMcpDeletions, openMcpEditor, restoreMcpEntry, saveMcpEditor } from '../../lib/types/domain/mcp/crud.js'
import { PatchConflictError, readPatchSnapshot } from '../../lib/types/domain/mcp/write.js'
import { cleanupTrash } from '../../lib/types/domain/skills/write.js'

const ORIGINAL = '# retain exactly\n- insert:\n    - id: existing\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: {serverName: existing, transport: stdio, command: node}\n'
const CONFIG = { serverName: 'local', transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: jsValue('process.env.TOKEN') }, future: { nested: jsValue('process.env.FUTURE') } }

async function fixture(t, text = ORIGINAL) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-crud-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const patchPath = join(root, 'profile', 'cordis.patch.yml')
  const homePatchPath = join(root, 'home.yml')
  const backupRoot = join(root, 'backups')
  const trashDir = join(root, 'trash', 'mcp')
  await mkdir(join(root, 'profile'))
  if (text !== undefined) await writeFile(patchPath, text, { mode: 0o640 })
  const files = async () => ({ patchPath, homePatchPath, expectedProfile: (await readPatchSnapshot(patchPath)).fingerprint, expectedHome: (await readPatchSnapshot(homePatchPath)).fingerprint })
  const open = async (target) => openMcpEditor(await files(), target)
  return { root, patchPath, homePatchPath, backupRoot, trashDir, files, open }
}

test('form validation and reference conversion preserve data without evaluating expressions', () => {
  const ref = environmentReference('Bearer ${TOKEN}-${OTHER}')
  assert.equal(ref.__js, '"Bearer " + (process.env.TOKEN ?? "") + "-" + (process.env.OTHER ?? "")')
  assert.equal(environmentReference('literal " + dangerous()'), 'literal " + dangerous()')
  let config = patchMcpField(CONFIG, 'env', 'NEW=${NEW_TOKEN}\n-TOKEN')
  assert.equal(config.env.TOKEN, undefined)
  assert.ok(config.env.NEW.__js.includes('process.env.NEW_TOKEN'))
  assert.equal(fieldDisplay(config, 'env').includes('NEW_TOKEN'), false)
  config = patchMcpField(config, 'env', '')
  assert.ok(config.env.NEW)
  assert.deepEqual(patchMcpField(config, 'env', '!').env, {})
  assert.deepEqual(config.future, CONFIG.future)
  assert.deepEqual(configChanges(CONFIG, { ...CONFIG, command: 'other', env: {} }), ['command', 'env'])
  assert.throws(() => validateMcpConfig({ ...CONFIG, serverName: 'bad name' }), /serverName/u)
  assert.throws(() => patchMcpField(CONFIG, 'args', 'not-json'), /JSON/u)
  assert.throws(() => validateMcpConfig({ serverName: 'http', transport: 'streamable-http', url: 'file:///etc/passwd' }), /HTTP/u)
  assert.throws(() => validateMcpConfig({ ...CONFIG, headers: { X: 'bad\r\nheader' } }), /换行/u)
  const invalid = parsePatchText('- secret-token: "do-not-expose-this [')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.includes('do-not-expose-this'), false)
})

test('add/edit/delete preserve external bytes, unknown keys, expressions and CRLF', () => {
  const original = ORIGINAL.replaceAll('\n', '\r\n')
  const added = addManagedMcp(original, 'mcp-local', CONFIG)
  assert.ok(added.endsWith(original))
  assert.equal(added.replaceAll('\r\n', '').includes('\n'), false)
  const edited = editManagedMcp(added, 'mcp-local', 'local', { ...CONFIG, command: 'other' })
  const row = managedMcpEntries(edited)[0]
  assert.deepEqual(row.config.future, CONFIG.future)
  assert.deepEqual(row.config.env, CONFIG.env)
  assert.equal(row.config.command, 'other')
  assert.ok(edited.endsWith(original))
  assert.equal(deleteManagedMcp(edited, 'mcp-local', 'local').text, original)
})

test('foreign top-level rows and insert siblings inside the block survive editing and deletion', () => {
  const foreign = '    # unrelated sibling\n    - id: foreign\n      name: other-module\n      config: {keep: " exact "}\n'
  let text = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG)
  text = text.replace(MCP_BLOCK_END, `${foreign}${MCP_BLOCK_END}`)
  const edited = editManagedMcp(text, 'mcp-local', 'local', { ...CONFIG, cwd: '/tmp' })
  assert.ok(edited.includes(foreign))
  const deleted = deleteManagedMcp(edited, 'mcp-local', 'local').text
  assert.ok(deleted.includes(foreign))
  assert.ok(deleted.endsWith(ORIGINAL))
  assert.equal(parsePatchText(deleted).rows.find((row) => row.id === 'foreign').config.keep, ' exact ')
})

test('empty profiles work; damaged markers and non-managed user rows refuse mutation', () => {
  for (const text of ['', '# only comments\n', '[]\n']) {
    const added = addManagedMcp(text, 'mcp-local', CONFIG)
    assert.equal(managedMcpEntries(added).length, 1)
    assert.equal(parsePatchText(deleteManagedMcp(added, 'mcp-local', 'local').text).ok, true)
  }
  assert.throws(() => editManagedMcp(ORIGINAL, 'existing', 'existing', CONFIG), /仅能编辑/u)
  assert.throws(() => addManagedMcp(`${ORIGINAL}${MCP_BLOCK_BEGIN}\n`, 'mcp-local', CONFIG), /标记/u)
  const unsupported = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG).replace('serverName: local', 'serverName: local\n        tagged: !future value')
  assert.throws(() => editManagedMcp(unsupported, 'mcp-local', 'local', { ...CONFIG, cwd: '/tmp' }), /标签/u)
})

test('literal __js maps never become executable tags while real tagged values retain provenance', () => {
  const config = { ...CONFIG, literal: { __js: 'mustRemainData()' }, args: [jsValue('process.env.ARG')] }
  const added = addManagedMcp(ORIGINAL, 'mcp-local', config)
  const row = managedMcpEntries(added)[0]
  assert.equal(isJsValue(row.config.literal), false)
  assert.deepEqual(row.config.literal, { __js: 'mustRemainData()' })
  assert.equal(isJsValue(row.config.env.TOKEN), true)
  assert.equal(isJsValue(row.config.args[0]), true)
  assert.deepEqual(patchMcpField(row.config, 'args', '').args, config.args)
  assert.equal(isJsValue(managedMcpEntries(editManagedMcp(added, 'mcp-local', 'local', { ...row.config, cwd: '/tmp' }))[0].config.literal), false)
  validateMcpConfig({ ...CONFIG, transport: jsValue('process.env.TRANSPORT') })
})

test('duplicate insert identity and expression-controlled overrides refuse editing', async (t) => {
  const added = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG)
  const duplicate = `${added}- insert:\n    - id: mcp-local\n      name: other\n`
  assert.throws(() => editManagedMcp(duplicate, 'mcp-local', 'local', { ...CONFIG, cwd: '/tmp' }), /id 重复/u)
  const fx = await fixture(t, `${added}- id: mcp-local\n  disabled: !!js true\n`)
  await assert.rejects(fx.open({ id: 'mcp-local', serverName: 'local' }), /表达式/u)
})

test('create supports an absent profile patch with a private empty-baseline backup', async (t) => {
  const fx = await fixture(t)
  await rm(fx.patchPath)
  const session = await fx.open()
  const result = await saveMcpEditor({ session, config: CONFIG, backupRoot: fx.backupRoot })
  assert.equal(await readFile(result.backupPath, 'utf8'), '')
  assert.equal((await stat(fx.patchPath)).mode & 0o777, 0o600)
  assert.equal(managedMcpEntries(await readFile(fx.patchPath, 'utf8')).length, 1)
})

test('guarded add allocates unique ids, refuses duplicate names, and keeps backups private', async (t) => {
  const fx = await fixture(t, `${ORIGINAL}- id: mcp-local\n  disabled: true\n`)
  const session = await fx.open()
  const result = await saveMcpEditor({ session, config: CONFIG, backupRoot: fx.backupRoot })
  assert.equal(result.value.id, 'mcp-local-2')
  assert.equal(await readFile(result.backupPath, 'utf8'), `${ORIGINAL}- id: mcp-local\n  disabled: true\n`)
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600)
  await assert.rejects(saveMcpEditor({ session: await fx.open(), config: CONFIG, backupRoot: fx.backupRoot }), /serverName 已存在/u)
  await assert.rejects(saveMcpEditor({ session: await fx.open(), config: { ...CONFIG, serverName: 'active' }, backupRoot: fx.backupRoot, runtimeNames: ['active'] }), /活跃实例/u)
})

test('guarded edit reads unevaluated source and preserves unknown row/config properties', async (t) => {
  const text = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG).replace('      config:', '      optional: true\n      config:')
  const fx = await fixture(t, text)
  const session = await fx.open({ id: 'mcp-local', serverName: 'local' })
  assert.deepEqual(session.config.env, CONFIG.env)
  await saveMcpEditor({ session, config: { ...session.config, args: ['new.js'] }, backupRoot: fx.backupRoot })
  const rows = managedMcpEntries(await readFile(fx.patchPath, 'utf8'))
  assert.equal(rows[0].raw.optional, true)
  assert.deepEqual(rows[0].config.future, CONFIG.future)
  assert.deepEqual(rows[0].config.env, CONFIG.env)
  await assert.rejects(fx.open({ id: 'existing', serverName: 'existing' }), /仅能编辑/u)
})

test('soft delete removes its toggle, journals private source, and undo restores exact bytes across sessions', async (t) => {
  const withManaged = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG)
  const disabled = upsertManagedToggle(withManaged, 'mcp-local', true)
  const fx = await fixture(t, disabled.text)
  const session = await fx.open({ id: 'mcp-local', serverName: 'local' })
  const removed = await deleteMcpEntry({ session, backupRoot: fx.backupRoot, trashDir: fx.trashDir })
  assert.equal(await readFile(fx.patchPath, 'utf8'), ORIGINAL)
  const deletions = await listMcpDeletions(fx.trashDir, fx.patchPath)
  assert.equal(deletions.length, 1)
  assert.equal(deletions[0].batchId, removed.value.batchId)
  assert.equal((await stat(join(fx.trashDir, removed.value.batchId, 'manifest.json'))).mode & 0o777, 0o600)
  assert.equal('removed' in deletions[0], false)
  await restoreMcpEntry({ files: await fx.files(), backupRoot: fx.backupRoot, trashDir: fx.trashDir, batchId: removed.value.batchId })
  assert.equal(await readFile(fx.patchPath, 'utf8'), disabled.text)
  assert.equal((await listMcpDeletions(fx.trashDir, fx.patchPath)).length, 0)
  const corruptDir = join(fx.trashDir, '00000000-0000-0000-0000-000000000000')
  await mkdir(corruptDir)
  await writeFile(join(corruptDir, 'manifest.json'), 'broken')
  const warnings = []
  assert.equal((await listMcpDeletions(fx.trashDir, fx.patchPath, (warning) => warnings.push(warning))).length, 0)
  assert.equal(warnings.length, 1)
  assert.equal(await readFile(join(corruptDir, 'manifest.json'), 'utf8'), 'broken')
})

test('stale form, home overrides and external edits after deletion never overwrite user data', async (t) => {
  const original = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG)
  const fx = await fixture(t, original)
  const session = await fx.open({ id: 'mcp-local', serverName: 'local' })
  await writeFile(fx.homePatchPath, '# edited after opening the form\n')
  await assert.rejects(saveMcpEditor({ session, config: { ...CONFIG, cwd: '/tmp' }, backupRoot: fx.backupRoot }), PatchConflictError)
  await rm(fx.homePatchPath)
  await writeFile(fx.patchPath, `${original}# external\n`)
  await assert.rejects(saveMcpEditor({ session, config: CONFIG, backupRoot: fx.backupRoot }), PatchConflictError)
  await writeFile(fx.patchPath, original)
  const deleted = await deleteMcpEntry({ session, backupRoot: fx.backupRoot, trashDir: fx.trashDir })
  await writeFile(fx.patchPath, `${ORIGINAL}# after delete\n`)
  await assert.rejects(restoreMcpEntry({ files: await fx.files(), backupRoot: fx.backupRoot, trashDir: fx.trashDir, batchId: deleted.value.batchId }), PatchConflictError)
  assert.equal(await readFile(fx.patchPath, 'utf8'), `${ORIGINAL}# after delete\n`)
  await writeFile(fx.homePatchPath, '- id: mcp-local\n  disabled: true\n')
  await assert.rejects(fx.open({ id: 'mcp-local', serverName: 'local' }), /home/u)
})

test('backup or trash journal failures abort deletion without damaging the source', async (t) => {
  const original = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG)
  const fx = await fixture(t, original)
  const session = await fx.open({ id: 'mcp-local', serverName: 'local' })
  await writeFile(fx.backupRoot, 'not a directory')
  await assert.rejects(deleteMcpEntry({ session, backupRoot: fx.backupRoot, trashDir: fx.trashDir }), /备份失败/u)
  await rm(fx.backupRoot)
  await mkdir(dirname(fx.trashDir), { recursive: true })
  await writeFile(fx.trashDir, 'not a directory')
  await assert.rejects(deleteMcpEntry({ session, backupRoot: fx.backupRoot, trashDir: fx.trashDir }), /清单写入失败/u)
  assert.equal(await readFile(fx.patchPath, 'utf8'), original)
})

test('skill retention never removes MCP deletion journals or prevents MCP undo', async (t) => {
  const original = addManagedMcp(ORIGINAL, 'mcp-local', CONFIG)
  const fx = await fixture(t, original)
  const session = await fx.open({ id: 'mcp-local', serverName: 'local' })
  const removed = await deleteMcpEntry({ session, backupRoot: fx.backupRoot, trashDir: fx.trashDir })
  const manifest = join(fx.trashDir, removed.value.batchId, 'manifest.json')
  const bytes = await readFile(manifest)
  const old = new Date('2020-01-01T00:00:00Z')
  await utimes(fx.trashDir, old, old)
  assert.equal(await cleanupTrash(fx.root, { retentionDays: 7 }), 0)
  assert.equal(await cleanupTrash(fx.root, { maxBatches: 0 }), 0)
  assert.deepEqual(await readFile(manifest), bytes)
  assert.equal((await listMcpDeletions(fx.trashDir, fx.patchPath)).length, 1)
  await restoreMcpEntry({ files: await fx.files(), backupRoot: fx.backupRoot, trashDir: fx.trashDir, batchId: removed.value.batchId })
  assert.equal(await readFile(fx.patchPath, 'utf8'), original)
})
