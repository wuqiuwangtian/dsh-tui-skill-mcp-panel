import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagerRuntime } from '../../lib/types/host/manager-runtime.js'
import { addManagedMcp, editManagedMcp, managedMcpEntries } from '../../lib/types/domain/mcp/managed.js'
import { mcpGroupIds } from '../../lib/types/domain/mcp/groups.js'
import { parsePatchText, MCP_MODULE, upsertManagedToggle } from '../../lib/types/domain/mcp/patch.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-conflict-runtime-')), previousCwd = process.cwd()
  const env = { DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'),
    SKILL_MCP_PANEL_HOME: join(root, 'panel'), SKILL_MCP_PANEL_DUMP: join(root, 'dump.json'),
    DSH_BUNDLED_SKILL_DIR: undefined }
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const project = join(root, 'project'), patchPath = join(root, 'profile.yml')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(patchPath, addManagedMcp('- insert:\n    - id: existing\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: {serverName: existing, transport: stdio, command: node}\n', 'managed', {
    serverName: 'local', transport: 'stdio', command: 'node', env: { TOKEN: 'private-fixture-secret' },
  }))
  process.chdir(project)
  let currentPath = patchPath
  const ctx = { get: name => name === 'configEditor' ? { documentPath: currentPath } : name === 'loader' ? {
    entries: () => parsePatchText(readFileSync(patchPath, 'utf8')).rows.filter(row => row.name === MCP_MODULE).map(row => ({
      options: { id: row.id, name: row.name, config: row.config }, disabled: row.disabled === true,
      fiber: row.disabled === true ? undefined : { state: 2 },
    })),
  } : undefined }
  const runtime = new ManagerRuntime(ctx)
  t.after(async () => {
    runtime.dispose(); process.chdir(previousCwd)
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true, force: true })
  })
  await runtime.refresh('conflict-test')
  const change = async () => { const text = await readFile(patchPath, 'utf8') + '# external\n'; await writeFile(patchPath, text); return text }
  return { root, ctx, runtime, patchPath, change, switchPath: path => { currentPath = path } }
}

test('runtime confirmations are bound to the pending operation, latest preview, profile and lifecycle', async t => {
  const fx = await fixture(t), r = fx.runtime, session = await r.openMcpForm('managed')
  const config = { ...session.config, args: ['draft.js'] }, latest = await fx.change()
  await r.saveMcpForm(session, config)
  const first = r.snapshot().mcp.conflict
  assert.ok(first)
  const preview1 = await r.previewMcpConflict(first.token), preview2 = await r.previewMcpConflict(first.token)
  assert.ok(preview1 && preview2)
  await r.commitMcpConflict(first.token, preview1.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest, 'replaced preview is invalid')
  r.cancelMcpConflict(first.token)
  await r.saveMcpForm(session, config)
  const second = r.snapshot().mcp.conflict
  assert.notEqual(first.token, second.token)
  r.cancelMcpConflict(first.token)
  assert.equal(r.snapshot().mcp.conflict.token, second.token, 'old cancellation cannot erase new operation')
  const next = await r.previewMcpConflict(second.token)
  fx.switchPath(join(fx.root, 'another-profile.yml'))
  await r.commitMcpConflict(second.token, next.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest, 'profile switch invalidates confirmation')
  fx.switchPath(fx.patchPath)
  await r.refreshMcp()
  await r.commitMcpConflict(second.token, next.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest, 'refresh discards pending intent')
  await r.saveMcpForm(session, config)
  const pending = r.snapshot().mcp.conflict, last = await r.previewMcpConflict(pending.token)
  r.dispose()
  await r.commitMcpConflict(pending.token, last.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest, 'disposed runtime cannot retry')
})

test('runtime rejects a changed confirmation and exposes no private draft in conflict state or dump', async t => {
  const fx = await fixture(t), r = fx.runtime, session = await r.openMcpForm('managed')
  await fx.change()
  await r.saveMcpForm(session, { ...session.config, env: { TOKEN: 'private-draft-secret' } })
  const pending = r.snapshot().mcp.conflict, preview = await r.previewMcpConflict(pending.token)
  assert.ok(!JSON.stringify(pending).includes('private-draft-secret'))
  assert.ok(!JSON.stringify(preview).includes('private-draft-secret'))
  const latest = await fx.change()
  await r.commitMcpConflict(pending.token, preview.confirmation)
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'conflict')
  assert.notEqual(r.snapshot().mcp.conflict.token, pending.token)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  await r.dumpNow()
  const dump = await readFile(join(fx.root, 'dump.json'), 'utf8')
  assert.ok(!dump.includes('private-draft-secret') && !dump.includes('private-fixture-secret'))
})

test('runtime retries immutable draft, existing-row toggle and latest managed deletion with durable undo', async t => {
  const fx = await fixture(t), r = fx.runtime, session = await r.openMcpForm('managed')
  const draft = { ...session.config, env: { TOKEN: 'original-draft-secret' } }
  const beforeSave = await fx.change()
  await r.saveMcpForm(session, draft)
  draft.env.TOKEN = 'mutated-after-conflict'
  let pending = r.snapshot().mcp.conflict, preview = await r.previewMcpConflict(pending.token)
  await r.commitMcpConflict(pending.token, preview.confirmation)
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'applied')
  assert.equal(managedMcpEntries(await readFile(fx.patchPath, 'utf8'))[0].config.env.TOKEN, 'original-draft-secret')
  assert.equal(await readFile(r.snapshot().mcp.lastAction.backupPath, 'utf8'), beforeSave)
  const beforeToggle = await fx.change()
  await r.toggleMcp('existing')
  pending = r.snapshot().mcp.conflict; preview = await r.previewMcpConflict(pending.token)
  assert.equal(preview.operation, '停用')
  await r.commitMcpConflict(pending.token, preview.confirmation)
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'applied')
  assert.equal(parsePatchText(await readFile(fx.patchPath, 'utf8')).rows.find(row => row.id === 'existing').disabled, true)
  assert.equal(await readFile(r.snapshot().mcp.lastAction.backupPath, 'utf8'), beforeToggle)
  const beforeDelete = await fx.change()
  await r.deleteMcp('managed')
  pending = r.snapshot().mcp.conflict; preview = await r.previewMcpConflict(pending.token)
  assert.equal(preview.operation, '删除')
  await r.commitMcpConflict(pending.token, preview.confirmation)
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'applied')
  assert.equal(await readFile(r.snapshot().mcp.lastAction.backupPath, 'utf8'), beforeDelete)
  await r.undoMcpDelete()
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'applied')
  assert.equal(await readFile(fx.patchPath, 'utf8'), beforeDelete)
})

test('MCP rename reports a metadata failure when private config becomes damaged after opening the form', async t => {
  const fx = await fixture(t), r = fx.runtime
  await r.createMcpGroup('Retained group', [{ serverName: 'local', entryId: 'managed' }])
  const session = await r.openMcpForm('managed'), broken = '{"version":1,"mcpGroups":'
  const configPath = join(fx.root, 'panel', 'config.json')
  await writeFile(configPath, broken)
  await r.saveMcpForm(session, { ...session.config, serverName: 'renamed' })
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'applied')
  assert.match(r.snapshot().mcp.lastAction.detail ?? '', /分组更名同步失败/u)
  assert.match(r.snapshot().configWarning ?? '', /分组/u)
  assert.equal(await readFile(configPath, 'utf8'), broken, 'damaged private config is preserved')
  assert.equal(managedMcpEntries(await readFile(fx.patchPath, 'utf8'))[0].serverName, 'renamed')
})

test('restore merge confirmations expire on re-preview, external changes, refresh, profile switch and dispose', async t => {
  const fx = await fixture(t), r = fx.runtime
  await r.deleteMcp('managed')
  await fx.change()
  await r.undoMcpDelete()
  const first = r.snapshot().mcp.restoreConflict
  assert.ok(first)
  const p1 = await r.previewMcpRestore(first.token), p2 = await r.previewMcpRestore(first.token)
  const latest = await readFile(fx.patchPath, 'utf8')
  await r.commitMcpRestore(first.token, p1.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  const changed = await fx.change()
  await r.commitMcpRestore(first.token, p2.confirmation)
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'conflict')
  assert.equal(await readFile(fx.patchPath, 'utf8'), changed)
  await r.undoMcpDelete()
  const second = r.snapshot().mcp.restoreConflict, next = await r.previewMcpRestore(second.token)
  r.cancelMcpRestore(first.token)
  assert.equal(r.snapshot().mcp.restoreConflict.token, second.token)
  fx.switchPath(join(fx.root, 'another-profile.yml'))
  await r.commitMcpRestore(second.token, next.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), changed)
  fx.switchPath(fx.patchPath)
  await r.refreshMcp()
  await r.commitMcpRestore(second.token, next.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), changed)
  await r.undoMcpDelete()
  const third = r.snapshot().mcp.restoreConflict, final = await r.previewMcpRestore(third.token)
  r.dispose()
  await r.commitMcpRestore(third.token, final.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), changed)
})

test('restore merge keeps private group references; external rename never guesses membership by entryId alone', async t => {
  const fx = await fixture(t), r = fx.runtime
  await r.createMcpGroup('Keep group', [{ serverName: 'local', entryId: 'managed' }])
  const configPath = join(fx.root, 'panel', 'config.json'), metadata = await readFile(configPath, 'utf8')
  await r.deleteMcp('managed')
  const latest = await fx.change()
  await r.undoMcpDelete()
  let offer = r.snapshot().mcp.restoreConflict
  r.cancelMcpRestore(offer.token)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  await r.undoMcpDelete()
  offer = r.snapshot().mcp.restoreConflict
  const preview = await r.previewMcpRestore(offer.token)
  assert.ok(!JSON.stringify(preview).includes('private-fixture-secret'))
  await r.commitMcpRestore(offer.token, preview.confirmation)
  assert.equal(r.snapshot().mcp.lastAction.outcome, 'applied')
  assert.equal(await readFile(r.snapshot().mcp.lastAction.backupPath, 'utf8'), latest)
  assert.equal(await readFile(configPath, 'utf8'), metadata)
  const groups = r.mcpGroupsForCurrentProfile()
  assert.equal(mcpGroupIds(groups, fx.patchPath, { serverName: 'local', entryId: 'managed' }).length, 1)
  const restored = await readFile(fx.patchPath, 'utf8'), row = managedMcpEntries(restored)[0]
  await writeFile(fx.patchPath, editManagedMcp(restored, row.id, row.serverName, { ...row.config, serverName: 'external-name' }))
  await r.refreshMcp()
  assert.equal(mcpGroupIds(r.mcpGroupsForCurrentProfile(), fx.patchPath, { serverName: 'external-name', entryId: 'managed' }).length, 0)
  assert.equal(await readFile(configPath, 'utf8'), metadata, 'external rename does not rewrite or delete old references')
  await r.dumpNow()
  assert.ok(!(await readFile(join(fx.root, 'dump.json'), 'utf8')).includes('private-fixture-secret'))
})

test('group repair confirmation is explicit, one-shot, profile-bound and invalidated by refresh, mutation and disposal', async t => {
  const fx = await fixture(t), r = fx.runtime
  const old = { serverName: 'old-name', entryId: 'managed' }, current = { serverName: 'local', entryId: 'managed' }
  await r.createMcpGroup('Repair tools', [old])
  const configPath = join(fx.root, 'panel', 'config.json'), original = await readFile(configPath, 'utf8')
  const preview = async () => { await r.previewMcpGroupRepair(old, current); assert.ok(r.snapshot().mcp.groupRepair); return structuredClone(r.snapshot().mcp.groupRepair) }
  const cancelledPreview = r.previewMcpGroupRepair(old, current)
  r.cancelMcpGroupRepair()
  await cancelledPreview
  assert.equal(r.snapshot().mcp.groupRepair, undefined, 'closing the scene while preview starts cannot create a late pending plan')
  let view = await preview()
  r.cancelMcpGroupRepair(view.token)
  await r.commitMcpGroupRepair(view.token, view.confirmation)
  assert.equal(await readFile(configPath, 'utf8'), original)
  const first = await preview(); view = await preview()
  r.cancelMcpGroupRepair(first.token)
  assert.equal(r.snapshot().mcp.groupRepair.token, view.token)
  await r.commitMcpGroupRepair(first.token, first.confirmation)
  assert.equal(await readFile(configPath, 'utf8'), original)
  fx.switchPath(join(fx.root, 'other-profile.yml'))
  await r.commitMcpGroupRepair(view.token, view.confirmation)
  assert.equal(await readFile(configPath, 'utf8'), original)
  fx.switchPath(fx.patchPath)
  await r.refreshMcp()
  await r.commitMcpGroupRepair(view.token, view.confirmation)
  assert.equal(await readFile(configPath, 'utf8'), original)
  view = await preview()
  await r.renameMcpGroup(Object.keys(r.mcpGroupsForCurrentProfile())[0], 'Changed')
  const changed = await readFile(configPath, 'utf8')
  await r.commitMcpGroupRepair(view.token, view.confirmation)
  assert.equal(await readFile(configPath, 'utf8'), changed)
  view = await preview()
  await r.commitMcpGroupRepair(view.token, 'wrong-confirmation')
  assert.equal(await readFile(configPath, 'utf8'), changed)
  r.dispose()
  await r.commitMcpGroupRepair(view.token, view.confirmation)
  assert.equal(await readFile(configPath, 'utf8'), changed)
})

test('group repair keeps secret-bearing row data private, backs up current config and never modifies MCP files', async t => {
  const fx = await fixture(t), r = fx.runtime
  const old = { serverName: 'old-name', entryId: 'managed' }, current = r.snapshot().mcp.rows.find(row => row.entryId === 'managed')
  await r.createMcpGroup('Repair tools', [old])
  const configPath = join(fx.root, 'panel', 'config.json'), config = await readFile(configPath, 'utf8'), patch = await readFile(fx.patchPath, 'utf8')
  await r.previewMcpGroupRepair(old, current)
  const view = structuredClone(r.snapshot().mcp.groupRepair)
  assert.ok(!JSON.stringify(view).includes('private-fixture-secret'))
  // Mutating exposed UI metadata cannot alter the private plan or confirmation.
  r.snapshot().mcp.groupRepair.after.serverName = 'tampered'
  r.snapshot().mcp.groupRepair.confirmation = 'tampered'
  const backup = await r.commitMcpGroupRepair(view.token, view.confirmation)
  assert.equal(await readFile(backup, 'utf8'), config)
  assert.equal(await readFile(fx.patchPath, 'utf8'), patch)
  assert.equal(mcpGroupIds(r.mcpGroupsForCurrentProfile(), fx.patchPath, current).length, 1)
  const repaired = await readFile(configPath, 'utf8')
  await r.commitMcpGroupRepair(view.token, view.confirmation)
  assert.equal(await readFile(configPath, 'utf8'), repaired)
  await r.dumpNow()
  assert.ok(!(await readFile(join(fx.root, 'dump.json'), 'utf8')).includes('private-fixture-secret'))
})

async function legacyFixture(fx) {
  const text = upsertManagedToggle(await readFile(fx.patchPath, 'utf8'), 'existing', true).text + '\n'
  await writeFile(fx.patchPath, text)
  await fx.runtime.refreshMcp()
  return { ...fx.runtime.snapshot().mcp, targets: [{ id: 'existing', serverName: 'existing', disabled: true }] }
}

test('migration conflicts retain immutable original targets and save latest bytes without claiming connection readiness', async t => {
  const fx = await fixture(t), r = fx.runtime, expected = await legacyFixture(fx)
  const latest = await fx.change()
  await r.migrateMcpToggles(expected)
  expected.targets[0].disabled = false
  const offer = r.snapshot().mcp.conflict
  assert.equal(offer.action, 'migrate')
  const preview = await r.previewMcpConflict(offer.token)
  assert.deepEqual(preview.migrationTargets, [{ id: 'existing', serverName: 'existing', disabled: true }])
  assert.ok(!JSON.stringify(preview).includes('private-fixture-secret'))
  preview.migrationTargets[0].disabled = false
  const result = await r.commitMcpConflict(offer.token, preview.confirmation)
  assert.equal(result.outcome, 'saved')
  assert.equal(await readFile(result.backupPath, 'utf8'), latest)
  const saved = await readFile(fx.patchPath, 'utf8')
  assert.ok(saved.endsWith('# external\n'))
  assert.equal(parsePatchText(saved).toggles.length, 0)
  assert.equal(parsePatchText(saved).rows.find(row => row.id === 'existing').disabled, true)
  assert.equal(r.snapshot().mcp.lastMigration.outcome, 'saved')
  assert.ok(!r.snapshot().statusMessage.text.includes('已生效'))
  await r.dumpNow()
  assert.ok(!(await readFile(join(fx.root, 'dump.json'), 'utf8')).includes('private-fixture-secret'))
})

test('migration retry confirmations expire on replacement, cancel, refresh, profile switch and disposal', async t => {
  const fx = await fixture(t), r = fx.runtime, expected = await legacyFixture(fx), latest = await fx.change()
  await r.migrateMcpToggles(expected)
  const offer = r.snapshot().mcp.conflict, first = await r.previewMcpConflict(offer.token), second = await r.previewMcpConflict(offer.token)
  await r.commitMcpConflict(offer.token, first.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  fx.switchPath(join(fx.root, 'other.yml'))
  await r.commitMcpConflict(offer.token, second.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  fx.switchPath(fx.patchPath)
  r.cancelMcpConflict(offer.token)
  await r.commitMcpConflict(offer.token, second.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  await r.migrateMcpToggles(expected)
  let next = r.snapshot().mcp.conflict, preview = await r.previewMcpConflict(next.token)
  await r.refreshMcp()
  await r.commitMcpConflict(next.token, preview.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
  await r.migrateMcpToggles(expected)
  next = r.snapshot().mcp.conflict; preview = await r.previewMcpConflict(next.token)
  r.dispose()
  await r.commitMcpConflict(next.token, preview.confirmation)
  assert.equal(await readFile(fx.patchPath, 'utf8'), latest)
})

test('migration retry reoffers a fresh conflict on another edit and refuses changed batch semantics', async t => {
  const fx = await fixture(t), r = fx.runtime, expected = await legacyFixture(fx)
  await fx.change(); await r.migrateMcpToggles(expected)
  const offer = r.snapshot().mcp.conflict, preview = await r.previewMcpConflict(offer.token)
  const newest = await fx.change()
  await r.commitMcpConflict(offer.token, preview.confirmation)
  assert.equal(r.snapshot().mcp.lastMigration.outcome, 'conflict')
  const replacement = r.snapshot().mcp.conflict
  assert.notEqual(replacement.token, offer.token)
  r.cancelMcpConflict(offer.token)
  assert.equal(r.snapshot().mcp.conflict.token, replacement.token)
  assert.equal(await readFile(fx.patchPath, 'utf8'), newest)
  const changed = upsertManagedToggle(newest, 'existing', false).text
  await writeFile(fx.patchPath, changed)
  assert.equal(await r.previewMcpConflict(replacement.token), undefined)
  assert.match(r.snapshot().statusMessage.text, /重新确认整批/u)
  assert.equal(await readFile(fx.patchPath, 'utf8'), changed)
})


test('an unavailable loader cannot confirm disk-only disable or deletion', async t => {
  const { ctx, runtime, patchPath } = await fixture(t)
  const get = ctx.get
  let unavailable = true
  ctx.get = name => unavailable && name === 'loader' ? undefined : get(name)
  await runtime.refreshMcp()
  assert.equal(runtime.snapshot().mcp.loaderComplete, false)
  assert.equal(runtime.snapshot().mcp.rows.find(row => row.id === 'existing').diskOnly, true)
  await runtime.toggleMcp('existing')
  assert.equal(runtime.snapshot().mcp.lastAction.outcome, 'timeout')
  assert.equal(parsePatchText(await readFile(patchPath, 'utf8')).rows.find(row => row.id === 'existing').disabled, true)

  const removing = runtime.deleteMcp('managed')
  try {
    // Await a completed post-save poll with the target absent on disk.
    for (let poll = 0; poll < 100; poll++) {
      if (!runtime.snapshot().mcp.rows.some(row => row.id === 'managed')) break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.ok(!runtime.snapshot().mcp.rows.some(row => row.id === 'managed'))
    assert.equal(runtime.snapshot().mcp.lastAction.outcome, 'saved')
  } finally {
    unavailable = false
    await removing
  }
  assert.equal(runtime.snapshot().mcp.lastAction.outcome, 'applied')
  assert.equal(runtime.snapshot().mcp.rows.find(row => row.id === 'existing').diskOnly, false)
})
