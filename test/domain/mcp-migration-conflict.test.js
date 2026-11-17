import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareMcpConflict } from '../../lib/types/domain/mcp/conflict.js'
import { parsePatchText, upsertManagedToggle } from '../../lib/types/domain/mcp/patch.js'
import { buildMcpMigration, readPatchSnapshot, saveMcpMigration, PatchConflictError } from '../../lib/types/domain/mcp/write.js'

const SOURCE = `# keep original bytes\n- insert:\n    - id: alpha\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: false # original comment\n      config: {serverName: alpha, transport: stdio, command: node, env: {TOKEN: !!js process.env.PRIVATE_TOKEN}, future: [1, 2]}\n    - id: beta\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: true\n      config: {serverName: beta, transport: stdio, command: node}\n`
const TARGETS = [{ id: 'alpha', serverName: 'alpha', disabled: true }, { id: 'beta', serverName: 'beta', disabled: false }]
const LEGACY = upsertManagedToggle(upsertManagedToggle(SOURCE, 'alpha', true).text, 'beta', false).text + '\n'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-migration-conflict-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const patchPath = join(root, 'profile.yml'), homePatchPath = join(root, 'home.yml'), backupRoot = join(root, 'backups')
  await writeFile(patchPath, LEGACY, { mode: 0o640 })
  const input = { patchPath, homePatchPath, backupRoot, targets: structuredClone(TARGETS),
    expectedProfile: (await readPatchSnapshot(patchPath)).fingerprint, expectedHome: 'missing' }
  const preview = () => prepareMcpConflict({ kind: 'migrate', input })
  return { root, input, preview }
}

test('migration retry previews only the original batch and backs up latest bytes while retaining other content', async t => {
  const fx = await fixture(t), latest = LEGACY.replace('command: node', 'command: changed-node') + '# external bytes\n'
  await writeFile(fx.input.patchPath, latest)
  await assert.rejects(saveMcpMigration(fx.input), PatchConflictError)
  const plan = await fx.preview()
  assert.deepEqual(plan.intent.input.targets, TARGETS)
  assert.ok(!JSON.stringify(plan).includes('PRIVATE_TOKEN'))
  assert.equal(await readFile(fx.input.patchPath, 'utf8'), latest)
  await assert.rejects(stat(fx.input.backupRoot), { code: 'ENOENT' })
  const result = await saveMcpMigration(plan.intent.input), saved = await readFile(fx.input.patchPath, 'utf8')
  assert.equal(await readFile(result.backupPath, 'utf8'), latest)
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600)
  assert.equal((await stat(fx.input.patchPath)).mode & 0o777, 0o640)
  assert.equal(saved, buildMcpMigration(latest, '', TARGETS).text)
  assert.ok(saved.includes('command: changed-node'))
  assert.ok(saved.includes('!!js process.env.PRIVATE_TOKEN'))
  assert.ok(saved.endsWith('# external bytes\n'))
  const parsed = parsePatchText(saved)
  assert.equal(parsed.toggles.length, 0)
  assert.equal(parsed.rows.find(row => row.id === 'alpha').disabled, true)
  assert.equal(parsed.rows.find(row => row.id === 'beta').disabled ?? false, false)
})

test('batch additions, removals, saved-state changes and renamed identities require a new full review', async t => {
  const additions = `${LEGACY}- insert:\n    - id: gamma\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: {serverName: gamma, transport: stdio, command: node}\n`
  const cases = [upsertManagedToggle(additions, 'gamma', true).text,
    upsertManagedToggle(SOURCE, 'alpha', true).text,
    upsertManagedToggle(LEGACY, 'alpha', false).text,
    LEGACY.replace('serverName: alpha', 'serverName: renamed')]
  for (const latest of cases) {
    const fx = await fixture(t)
    await writeFile(fx.input.patchPath, latest)
    await assert.rejects(fx.preview(), /重新加载.*重新确认整批/u)
    assert.equal(await readFile(fx.input.patchPath, 'utf8'), latest)
    await assert.rejects(stat(fx.input.backupRoot), { code: 'ENOENT' })
  }
})

test('home control, duplicate definitions, foreign overrides, expressions and invalid YAML never gain migration access', async t => {
  for (const [layer, extra] of [['homePatchPath', '- id: alpha\n  disabled: true\n'],
    ['patchPath', '- id: alpha\n  disabled: false\n'],
    ['patchPath', '- insert:\n    - id: alpha\n      name: other\n'],
    ['patchPath', '- invalid: [\n']]) {
    const fx = await fixture(t)
    await writeFile(fx.input[layer], (layer === 'patchPath' ? LEGACY : '') + extra)
    const latest = await readFile(fx.input.patchPath, 'utf8')
    await assert.rejects(fx.preview())
    assert.equal(await readFile(fx.input.patchPath, 'utf8'), latest)
  }
  const fx = await fixture(t), expression = LEGACY.replace('disabled: false # original', 'disabled: !!js false # original')
  await writeFile(fx.input.patchPath, expression)
  await assert.rejects(fx.preview(), /表达式|普通布尔/u)
  assert.equal(await readFile(fx.input.patchPath, 'utf8'), expression)
})

test('either layer changing after preview still invalidates migration and leaves latest files untouched', async t => {
  for (const layer of ['patchPath', 'homePatchPath']) {
    const fx = await fixture(t), plan = await fx.preview()
    await writeFile(fx.input[layer], (layer === 'patchPath' ? LEGACY : '') + '# after preview\n')
    await assert.rejects(saveMcpMigration(plan.intent.input), PatchConflictError)
    assert.equal(await readFile(fx.input.patchPath, 'utf8'), layer === 'patchPath' ? LEGACY + '# after preview\n' : LEGACY)
    await assert.rejects(stat(fx.input.backupRoot), { code: 'ENOENT' })
  }
})

test('backup failure refuses the complete batch and a consumed batch cannot be migrated twice', async t => {
  const fx = await fixture(t), plan = await fx.preview()
  await writeFile(fx.input.backupRoot, 'not a directory')
  await assert.rejects(saveMcpMigration(plan.intent.input), /备份失败/u)
  assert.equal(await readFile(fx.input.patchPath, 'utf8'), LEGACY)
  await rm(fx.input.backupRoot)
  await saveMcpMigration(plan.intent.input)
  const saved = await readFile(fx.input.patchPath, 'utf8')
  await assert.rejects(fx.preview(), /重新确认整批/u)
  await assert.rejects(saveMcpMigration(plan.intent.input), PatchConflictError)
  assert.equal(await readFile(fx.input.patchPath, 'utf8'), saved)
})
