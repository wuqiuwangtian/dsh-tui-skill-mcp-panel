import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPanelDocument, updateLastTab, updateMcpGroups } from '../../lib/types/domain/store.js'
import { upsertMcpGroup } from '../../lib/types/domain/mcp/groups.js'
import { readKnownWorkspaces } from '../../lib/types/host/workspaces.js'
import { ManagerRuntime } from '../../lib/types/host/manager-runtime.js'

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'panel-view-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
const skill = name => `---\nname: ${name}\ndescription: View fixture\n---\nbody\n`

test('last tab defaults safely, preserves unknown fields and all raw MCP records', async t => {
  const root = await fixture(t), target = join(root, 'config.json')
  assert.equal((await loadPanelDocument(root)).config.lastTab ?? 'skills', 'skills')
  const data = { version: 1, lastTab: 'future-tab', trashRetentionDays: 23, future: { keep: true }, mcpGroups: { legacy: { name: 'keep raw', future: 1 } } }
  await fs.writeFile(target, JSON.stringify(data))
  assert.equal((await loadPanelDocument(root)).config.lastTab, 'skills')
  await updateLastTab(root, 'diagnostics')
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { ...data, lastTab: 'diagnostics' })
  await assert.rejects(updateLastTab(root, 'invalid'), /未知页签/u)
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644, 'existing mode survives')
})

test('tab writes merge concurrent MCP edits and use a private mode for new config', async t => {
  const root = await fixture(t), profile = '/profiles/a/cordis.patch.yml'
  await Promise.all([
    updateLastTab(root, 'mcp'),
    updateMcpGroups(root, profile, groups => upsertMcpGroup(groups, profile, undefined, 'Keep').groups),
  ])
  const data = await loadPanelDocument(root)
  assert.equal(data.config.lastTab, 'mcp')
  assert.equal(Object.values(data.config.mcpGroups)[0].name, 'Keep')
  assert.equal((await fs.stat(join(root, 'config.json'))).mode & 0o777, 0o600)
  await assert.rejects(fs.stat(join(root, 'config.json.panel.lock')), { code: 'ENOENT' })
})

test('corrupt, future and linked config are never replaced for tab preferences', async t => {
  const root = await fixture(t), target = join(root, 'config.json')
  for (const data of ['{"secret":"DO-NOT-LEAK"', '{"version":99}', '{"version":1,"mcpGroups":[]}']) {
    await fs.writeFile(target, data)
    await assert.rejects(updateLastTab(root, 'groups'), error => !error.message.includes('DO-NOT-LEAK'))
    assert.equal(await fs.readFile(target, 'utf8'), data)
  }
  await fs.rm(target)
  const outside = join(root, 'outside.json')
  await fs.writeFile(outside, '{"version":1}')
  await fs.symlink(outside, target)
  await assert.rejects(updateLastTab(root, 'mcp'))
  assert.equal(await fs.readFile(outside, 'utf8'), '{"version":1}')
})

test('known workspace registry uses actual git roots, keeps missing entries, deduplicates paths', async t => {
  const root = await fixture(t), project = join(root, 'repo'), child = join(project, 'sub')
  await fs.mkdir(join(project, '.git'), { recursive: true }); await fs.mkdir(child)
  const result = await readKnownWorkspaces({ listRegistry: async () => [
    { path: child, title: 'Sub\x1btitle', present: true }, { path: child, title: 'Latest' },
    { path: join(root, 'missing'), title: 'Gone' }, { path: 'relative', title: 'Invalid' }, null,
  ] }, root)
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.entries[0], { cwd: child, label: 'Latest', projectRoot: project, present: true })
  assert.equal(result.entries[1].present, false)
  assert.match(result.warning, /2 条/u)
})

test('public target fallback excludes provider URIs; unavailable, denial and timeout degrade safely', async t => {
  const root = await fixture(t)
  const result = await readKnownWorkspaces({ list: async () => [
    { kind: 'local', cwd: root, label: 'Local' }, { kind: 'provider', cwd: 'ssh://host/private', label: 'Remote' },
  ] }, root)
  assert.equal(result.entries.length, 1)
  assert.match(result.warning, /非本地/u)
  for (const service of [undefined, {}, { listRegistry: async () => { throw new Error('DO-NOT-LEAK') } }, { listRegistry: async () => ({}) }, { listRegistry: () => new Promise(() => {}) }]) {
    const result = await readKnownWorkspaces(service, root)
    assert.deepEqual(result.entries, [])
    assert.ok(result.warning)
    assert.ok(!result.warning.includes('DO-NOT-LEAK'))
  }
})

async function runtimeFixture(t) {
  const root = await fixture(t), a = join(root, 'a'), b = join(root, 'b'), sub = join(b, 'sub'), panel = join(root, 'panel')
  for (const dir of [a, b]) {
    await fs.mkdir(join(dir, '.git'), { recursive: true }); await fs.mkdir(join(dir, '.dsh/skills'), { recursive: true })
    await fs.writeFile(join(dir, '.dsh/skills', 'same.md'), skill(dir === a ? 'alpha' : 'beta'))
  }
  await fs.mkdir(sub); await fs.mkdir(panel)
  const env = { DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_BUNDLED_SKILL_DIR: join(root, 'bundled'), DSH_PROFILE_DIR: join(root, 'profile'), SKILL_MCP_PANEL_HOME: panel, SKILL_MCP_PANEL_DUMP: undefined }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])), cwd = process.cwd(), runtimes = []
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  process.chdir(a)
  t.after(() => { for (const runtime of runtimes) runtime.dispose(); process.chdir(cwd); for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const start = () => { const runtime = new ManagerRuntime({ get: name => name === 'tuiWorkspaces' ? { listRegistry: async () => [{ path: sub, title: 'Other' }] } : undefined }); runtimes.push(runtime); return runtime }
  return { root, a, b, sub, panel, start }
}

test('runtime restores tab on cold start and saves rapid changes in order without refreshing stale MCP snapshots', async t => {
  const f = await runtimeFixture(t), target = join(f.panel, 'config.json')
  await fs.writeFile(target, JSON.stringify({ version: 1, lastTab: 'diagnostics', future: 'keep' }))
  const runtime = f.start(); await runtime.ensureFresh()
  assert.equal(runtime.snapshot().activeTab, 'diagnostics')
  await Promise.all(['mcp', 'groups', 'skills'].map(tab => runtime.rememberTab(tab)))
  assert.equal(runtime.snapshot().activeTab, 'skills')
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).lastTab, 'skills')
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).future, 'keep')
  await runtime.rememberTab('groups')
  const cold = f.start(); await cold.ensureFresh()
  assert.equal(cold.snapshot().activeTab, 'groups')
})

test('workspace browsing rescans git root, targets writes and groups there, preserves process cwd and rejects stale selections', async t => {
  const f = await runtimeFixture(t), runtime = f.start(); await runtime.ensureFresh()
  const old = runtime.snapshot().scan.instances.find(row => row.name === 'alpha')
  const mcp = JSON.stringify({ ...runtime.snapshot().mcp, loadedAt: undefined })
  assert.equal(await runtime.selectWorkspace(f.sub), true)
  assert.equal(process.cwd(), f.a)
  assert.equal(runtime.snapshot().scan.cwd, f.sub)
  assert.equal(runtime.snapshot().scan.projectRoot, f.b)
  assert.equal(JSON.stringify({ ...runtime.snapshot().mcp, loadedAt: undefined }), mcp)
  assert.equal(runtime.snapshot().scan.instances.some(row => row.name === 'alpha'), false)
  const row = runtime.snapshot().scan.instances.find(row => row.name === 'beta')
  assert.equal(runtime.scopeKeyFor(row), f.b)
  await runtime.toggleSkills([old]); assert.match(runtime.snapshot().statusMessage.text, /视图已变化/u)
  await runtime.deleteSkillInstances([old]); await fs.stat(old.skillFile)
  await runtime.createGroup('Other group', [row])
  assert.deepEqual(Object.values(runtime.snapshot().groups)[0].scopes[f.b], ['beta'])
  await runtime.createGroup('Stale group', [old]); assert.equal(Object.keys(runtime.snapshot().groups).length, 1)
  await runtime.toggleSkills([row]); await fs.stat(row.skillFile + '.disabled')
  assert.match(runtime.snapshot().statusMessage.text, /已保存到其他工作区/u)
  await fs.stat(old.skillFile)
  assert.equal(await runtime.selectWorkspace('/unregistered'), false)
  await fs.rm(f.sub, { recursive: true })
  assert.equal(await runtime.selectWorkspace(f.sub), false)
  assert.equal(await runtime.selectWorkspace(f.a), true)
  assert.equal(runtime.snapshot().scan.projectRoot, f.a)
})

test('live channel cwd replaces process cwd as current workspace without chdir', async t => {
  const f = await runtimeFixture(t), runtime = f.start(); await runtime.ensureFresh()
  await runtime.syncSessionCwd(f.sub)
  assert.equal(runtime.snapshot().workspaces.currentCwd, f.sub)
  assert.equal(runtime.snapshot().workspaces.currentProjectRoot, f.b)
  assert.equal(runtime.snapshot().scan.projectRoot, f.b)
  assert.equal(process.cwd(), f.a)
  await runtime.syncSessionCwd('ssh://remote/private')
  assert.equal(runtime.snapshot().scan.projectRoot, f.b)
  assert.match(runtime.snapshot().statusMessage.text, /不是可管理的本地目录/u)
})
