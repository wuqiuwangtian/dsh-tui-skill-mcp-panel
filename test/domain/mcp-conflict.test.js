import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareMcpConflict, copyMcpIntent } from '../../lib/types/domain/mcp/conflict.js'
import { addManagedMcp, editManagedMcp, managedMcpEntries } from '../../lib/types/domain/mcp/managed.js'
import { openMcpEditor, saveMcpEditor, deleteMcpEntry, restoreMcpEntry } from '../../lib/types/domain/mcp/crud.js'
import { jsValue, isJsValue, parsePatchText } from '../../lib/types/domain/mcp/patch.js'
import { readPatchSnapshot, saveMcpToggle, PatchConflictError } from '../../lib/types/domain/mcp/write.js'

const original = '# foreign bytes\n- insert:\n    - id: existing\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: { serverName: existing, transport: stdio, command: node }\n'
const config = { serverName: 'local', transport: 'stdio', command: 'node', args: ['old.js'],
  env: { TOKEN: jsValue('process.env.TOKEN'), KEEP: 'original', REMOVE: 'original' }, future: { __js: 'literal-data' } }

async function fixture(t, text = addManagedMcp(original, 'managed', config)) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-conflict-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const patchPath = join(root, 'cordis.patch.yml'), homePatchPath = join(root, 'home.yml')
  const backupRoot = join(root, 'backups'), trashDir = join(root, 'trash')
  await writeFile(patchPath, text)
  const files = async () => ({ patchPath, homePatchPath,
    expectedProfile: (await readPatchSnapshot(patchPath)).fingerprint, expectedHome: (await readPatchSnapshot(homePatchPath)).fingerprint })
  const open = async () => openMcpEditor(await files(), { id: 'managed', serverName: 'local' })
  return { root, patchPath, homePatchPath, backupRoot, trashDir, files, open }
}

test('conflict draft copying retains real !!js provenance and literal maps', () => {
  const copy = copyMcpIntent(config)
  assert.notEqual(copy, config)
  assert.ok(isJsValue(copy.env.TOKEN))
  assert.equal(isJsValue(copy.future), false)
  assert.deepEqual(copy, config)
  const alias = {}; alias.self = alias
  const aliasCopy = copyMcpIntent(alias)
  assert.equal(aliasCopy.self, aliasCopy, 'YAML alias graphs do not recurse forever while capturing intent')
})

test('preview is read-only; explicit retry changes draft keys and preserves latest foreign bytes and secret keys', async t => {
  const fx = await fixture(t), session = await fx.open()
  const draft = { ...session.config, args: ['new.js'], env: { TOKEN: jsValue('process.env.NEW_TOKEN'), KEEP: 'original' } }
  const latestConfig = { ...session.config, command: 'external-node', env: { TOKEN: 'external-secret', KEEP: 'external-keep', REMOVE: 'external-remove', ADDED: jsValue('process.env.ADDED') }, external: { value: 1 } }
  const latest = editManagedMcp(await readFile(fx.patchPath, 'utf8'), 'managed', 'local', latestConfig) + '# external tail\n'
  await writeFile(fx.patchPath, latest)
  await assert.rejects(saveMcpEditor({ session, config: draft, backupRoot: fx.backupRoot }), PatchConflictError)
  const plan = await prepareMcpConflict({ kind: 'save', session, config: draft })
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  await assert.rejects(stat(fx.backupRoot), { code: 'ENOENT' })
  const result = await saveMcpEditor({ ...plan.intent, backupRoot: fx.backupRoot })
  assert.equal(await readFile(result.backupPath, 'utf8'), latest)
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600)
  const saved = await readFile(fx.patchPath, 'utf8'), row = managedMcpEntries(saved)[0]
  assert.ok(saved.endsWith(original + '# external tail\n'))
  assert.equal(row.config.command, 'external-node')
  assert.deepEqual(row.config.args, ['new.js'])
  assert.equal(row.config.env.KEEP, 'external-keep')
  assert.equal(row.config.env.REMOVE, undefined)
  assert.ok(isJsValue(row.config.env.ADDED))
  assert.ok(isJsValue(row.config.env.TOKEN))
  assert.equal(row.config.env.TOKEN.__js, 'process.env.NEW_TOKEN')
  assert.deepEqual(row.config.external, { value: 1 })
  assert.equal(isJsValue(row.config.future), false)
})

test('adding a secret field preserves keys introduced externally; incompatible expression containers refuse merging', async t => {
  const initial = { serverName: 'local', transport: 'streamable-http', url: 'http://127.0.0.1/mcp' }
  const fx = await fixture(t, addManagedMcp(original, 'managed', initial)), session = await fx.open()
  const draft = { ...session.config, headers: { New: 'draft-secret' } }
  await writeFile(fx.patchPath, editManagedMcp(await readFile(fx.patchPath, 'utf8'), 'managed', 'local', { ...initial, headers: { External: jsValue('process.env.X') } }))
  const plan = await prepareMcpConflict({ kind: 'save', session, config: draft })
  assert.equal(plan.intent.config.headers.New, 'draft-secret')
  assert.ok(isJsValue(plan.intent.config.headers.External))
  await writeFile(fx.patchPath, editManagedMcp(await readFile(fx.patchPath, 'utf8'), 'managed', 'local', { ...initial, headers: jsValue('process.env.HEADERS') }))
  await assert.rejects(prepareMcpConflict({ kind: 'save', session, config: draft }), /结构已变化/u)
})

test('profile or home changes after preview refuse commit, including a second confirmed retry', async t => {
  const fx = await fixture(t), session = await fx.open(), draft = { ...session.config, args: ['new.js'] }
  for (const path of [fx.patchPath, fx.homePatchPath]) {
    const plan = await prepareMcpConflict({ kind: 'save', session, config: draft })
    const previous = await readFile(path, 'utf8').catch(() => '')
    await writeFile(path, previous + '# another edit\n')
    const current = await readFile(fx.patchPath, 'utf8')
    await assert.rejects(saveMcpEditor({ ...plan.intent, backupRoot: fx.backupRoot }), PatchConflictError)
    assert.equal(await readFile(fx.patchPath, 'utf8'), current)
  }
  const plan = await prepareMcpConflict({ kind: 'save', session, config: draft })
  await saveMcpEditor({ ...plan.intent, backupRoot: fx.backupRoot })
  await assert.rejects(saveMcpEditor({ ...plan.intent, backupRoot: fx.backupRoot }), PatchConflictError)
})

test('backup failure stops an explicit retry without damaging latest bytes', async t => {
  const fx = await fixture(t), session = await fx.open()
  await writeFile(fx.patchPath, (await readFile(fx.patchPath, 'utf8')) + '# external\n')
  const latest = await readFile(fx.patchPath, 'utf8')
  const plan = await prepareMcpConflict({ kind: 'save', session, config: { ...session.config, args: ['new.js'] } })
  await writeFile(fx.backupRoot, 'occupied')
  await assert.rejects(saveMcpEditor({ ...plan.intent, backupRoot: fx.backupRoot }), /备份失败/u)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
})

test('delete retry journals latest contents and undo restores the latest file, including external rows', async t => {
  const fx = await fixture(t), session = await fx.open()
  const latest = editManagedMcp(await readFile(fx.patchPath, 'utf8'), 'managed', 'local', { ...session.config, args: ['external.js'] }) + '# external\n'
  await writeFile(fx.patchPath, latest)
  const plan = await prepareMcpConflict({ kind: 'delete', session })
  const result = await deleteMcpEntry({ session: plan.intent.session, backupRoot: fx.backupRoot, trashDir: fx.trashDir })
  assert.equal(await readFile(result.backupPath, 'utf8'), latest)
  assert.equal(await readFile(fx.patchPath, 'utf8'), original + '# external\n')
  await restoreMcpEntry({ files: await fx.files(), backupRoot: fx.backupRoot, trashDir: fx.trashDir, batchId: result.value.batchId })
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
})

test('toggle retry retains the original requested state and changes only disabled in latest existing rows', async t => {
  const fx = await fixture(t, original)
  const input = { ...await fx.files(), id: 'existing', serverName: 'existing', disabled: true, backupRoot: fx.backupRoot }
  const latest = original.replace('command: node', 'command: external-node') + '# latest\n'
  await writeFile(fx.patchPath, latest)
  const plan = await prepareMcpConflict({ kind: 'toggle', input })
  await saveMcpToggle(plan.intent.input)
  const saved = await readFile(fx.patchPath, 'utf8')
  assert.ok(saved.includes('command: external-node'))
  assert.ok(saved.endsWith('# latest\n'))
  assert.equal(parsePatchText(saved).rows.find(row => row.id === 'existing').disabled, true)
})

test('identity changes, non-managed targets, duplicate identities and home overrides never gain write access', async t => {
  const fx = await fixture(t), session = await fx.open(), text = await readFile(fx.patchPath, 'utf8')
  for (const bad of [text.replace('serverName: local', 'serverName: renamed'), original, text + '- insert:\n    - id: managed\n      name: other\n']) {
    await writeFile(fx.patchPath, bad)
    await assert.rejects(prepareMcpConflict({ kind: 'delete', session }))
    assert.equal(await readFile(fx.patchPath, 'utf8'), bad)
  }
  await writeFile(fx.patchPath, text)
  await writeFile(fx.homePatchPath, '- id: managed\n  disabled: true\n')
  await assert.rejects(prepareMcpConflict({ kind: 'save', session, config: session.config }), /home/u)
  await assert.rejects(prepareMcpConflict({ kind: 'toggle', input: { ...await fx.files(), id: 'managed', serverName: 'local', disabled: false, backupRoot: fx.backupRoot } }), /home/u)
})

test('create retry preserves latest foreign changes, while duplicate names still refuse', async t => {
  const fx = await fixture(t, original), session = await openMcpEditor(await fx.files())
  await writeFile(fx.patchPath, original + '# latest addition\n')
  const plan = await prepareMcpConflict({ kind: 'save', session, config })
  await saveMcpEditor({ ...plan.intent, backupRoot: fx.backupRoot })
  assert.ok((await readFile(fx.patchPath, 'utf8')).endsWith(original + '# latest addition\n'))
  const duplicate = await prepareMcpConflict({ kind: 'save', session, config })
  await assert.rejects(saveMcpEditor({ ...duplicate.intent, backupRoot: fx.backupRoot }), /serverName 已存在/u)
})
