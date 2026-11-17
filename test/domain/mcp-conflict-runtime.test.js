import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagerRuntime } from '../../lib/types/host/manager-runtime.js'
import { addManagedMcp, managedMcpEntries } from '../../lib/types/domain/mcp/managed.js'
import { parsePatchText, MCP_MODULE } from '../../lib/types/domain/mcp/patch.js'

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
  return { root, runtime, patchPath, change, switchPath: path => { currentPath = path } }
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
