import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { inspectTrashCleanup, runTrashCleanup } from '../../lib/types/domain/skills/retention.js'
import { cleanupPendingDir, cleanupPendingPath, cleanupRecordPath } from '../../lib/types/domain/skills/trash-lock.js'
import { deleteSkills, listTrash, readTrashBatch, undoTrash, writeTrashManifest } from '../../lib/types/domain/skills/write.js'
import { openSkillRecovery } from '../../lib/types/domain/skills/recovery.js'
import { ManagerRuntime } from '../../lib/types/host/manager-runtime.js'

const NOW = new Date('2026-11-13T12:00:00Z'), DAY = 86400000
const doc = name => `---\nname: ${name}\ndescription: Retention fixture\n---\nFixture.\n`
const exists = path => fs.lstat(path).then(() => true, () => false)
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill-retention-')), panel = join(root, 'panel'), project = join(root, 'project')
  const cwd = process.cwd(), keys = ['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR', 'DSH_PROFILE_DIR', 'SKILL_MCP_PANEL_HOME', 'SKILL_MCP_PANEL_DUMP']
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]])), runtimes = []
  let index = 0
  t.after(async () => {
    for (const runtime of runtimes) runtime.dispose()
    process.chdir(cwd)
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] }
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.mkdir(join(project, '.git'), { recursive: true }); await fs.mkdir(join(project, '.dsh/skills'), { recursive: true }); await fs.mkdir(panel)
  const batch = async (date, flat = false) => {
    const n = ++index, id = `${date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-x${n.toString(36)}`
    const dir = join(panel, 'trash', id), name = `skill-${n}`, rootPath = join(project, '.dsh/skills')
    const entityPath = join(rootPath, flat ? `${name}.md.disabled` : name)
    const trashPath = flat ? join(dir, 'workspace', name, `${name}.md.disabled`) : join(dir, 'workspace', name)
    await fs.mkdir(flat ? join(dir, 'workspace', name) : trashPath, { recursive: true })
    await fs.writeFile(flat ? trashPath : join(trashPath, 'SKILL.md'), doc(name))
    const data = { batchId: id, createdAt: date.toISOString(), entries: [{ entryId: `entry-${n}`, name, source: 'project-dsh', scope: 'workspace', scopeKey: 'workspace', form: flat ? 'file' : 'directory', rootPath,
      originalPath: flat ? entityPath : join(entityPath, 'SKILL.md'), entityPath, trashPath }] }
    await writeTrashManifest(dir, data)
    return { id, dir, manifest: join(dir, 'manifest.json'), data, entry: data.entries[0] }
  }
  const start = () => {
    process.env.DSH_HOME = join(root, 'home'); process.env.DSH_AGENTS_HOME = join(root, 'agents'); process.env.DSH_BUNDLED_SKILL_DIR = join(root, 'bundled')
    process.env.DSH_PROFILE_DIR = join(root, 'profile'); process.env.SKILL_MCP_PANEL_HOME = panel; delete process.env.SKILL_MCP_PANEL_DUMP
    process.chdir(project)
    const runtime = new ManagerRuntime({ get: () => undefined }); runtimes.push(runtime); return runtime
  }
  return { root, panel, project, batch, start, run: options => runTrashCleanup(panel, { now: () => NOW, ...options }) }
}
async function mocked(t, name, fn, body) {
  const original = fs[name], mock = t.mock.method(fs, name, (...args) => fn(original, ...args))
  syncBuiltinESMExports()
  try { return await body() } finally { mock.mock.restore(); syncBuiltinESMExports() }
}

test('age uses deletion time, includes exactly seven days, and persists the pre-delete plan', async t => {
  const fx = await fixture(t), expired = await fx.batch(new Date(+NOW - 7 * DAY)), fresh = await fx.batch(new Date(+NOW - 7 * DAY + 1), true)
  await fs.utimes(expired.dir, NOW, NOW); await fs.utimes(fresh.dir, new Date(0), new Date(0))
  let observed = false
  const { report } = await fx.run({ onPlanned: async plan => {
    observed = true; assert.equal(plan.phase, 'planned'); assert.deepEqual(plan.removed, [])
    assert(await exists(expired.dir)); assert(await exists(fresh.dir))
    const saved = JSON.parse(await fs.readFile(cleanupRecordPath(fx.panel), 'utf8'))
    assert.equal(saved.phase, 'planned'); assert.deepEqual(saved.plan.candidates.map(item => item.batchId), [expired.id])
    assert.equal((await fs.stat(cleanupRecordPath(fx.panel))).mode & 0o777, 0o600)
  } })
  assert(observed); assert.deepEqual(report.removed, [expired.id]); assert.deepEqual(report.failed, [])
  assert(await exists(fresh.dir)); assert.equal(report.remainingNormal, 1)
})

test('count keeps the newest 100 by precise createdAt, not random suffix ordering', async t => {
  const fx = await fixture(t), batches = []
  for (let i = 0; i < 101; i++) batches.push(await fx.batch(new Date(+NOW - 100 + i)))
  const { report } = await fx.run()
  assert.deepEqual(report.removed, [batches[0].id]); assert.equal(report.plan.candidates[0].reason, 'excess')
  assert.equal(report.remainingNormal, 100)
  for (const item of batches.slice(1)) assert(await exists(item.dir))
})

test('MCP, unknown/corrupt/linked/future/pending/unregistered data do not enter the retention budget', async t => {
  const fx = await fixture(t), old = new Date(+NOW - 8 * DAY), protectedItems = []
  const mcp = join(fx.panel, 'trash/mcp'); await fs.mkdir(mcp, { recursive: true }); await fs.writeFile(join(mcp, 'keep.json'), 'MCP journal bytes')
  for (const kind of ['corrupt', 'version', 'pending', 'extra', 'outside', 'bundled', 'future', 'linked']) {
    const item = await fx.batch(kind === 'future' ? new Date(+NOW + DAY) : old); protectedItems.push(item)
    if (kind === 'corrupt') await fs.writeFile(item.manifest, '{private-invalid-json')
    if (kind === 'version') { item.data.version = 999; await fs.writeFile(item.manifest, JSON.stringify(item.data)) }
    if (kind === 'pending') { item.entry.recoveryPending = true; await writeTrashManifest(item.dir, item.data) }
    if (kind === 'extra') await fs.writeFile(join(item.dir, 'unregistered.txt'), 'keep unknown payload')
    if (kind === 'outside') { item.entry.trashPath = join(fx.root, 'outside'); await writeTrashManifest(item.dir, item.data) }
    if (kind === 'bundled') { item.entry.source = 'bundled'; await writeTrashManifest(item.dir, item.data) }
    if (kind === 'linked') {
      const outside = join(fx.root, 'linked-data'); await fs.mkdir(outside); await fs.writeFile(join(outside, 'keep'), 'linked bytes')
      await fs.rm(item.dir, { recursive: true }); await fs.symlink(outside, item.dir)
    }
  }
  const normal = await fx.batch(old)
  const { report } = await fx.run({ maxBatches: 0 })
  assert.deepEqual(report.removed, [normal.id]); assert.equal(report.plan.protected.length, protectedItems.length + 1)
  for (const item of protectedItems) assert(await exists(item.dir))
  assert.equal(await fs.readFile(join(mcp, 'keep.json'), 'utf8'), 'MCP journal bytes')
  assert.equal(await fs.readFile(join(fx.root, 'linked-data/keep'), 'utf8'), 'linked bytes')
  assert(!JSON.stringify(report).includes('private-invalid-json'))
})

test('planned batches changed by an external writer are skipped without creating a cleanup intent', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY))
  const { report } = await fx.run({ onPlanned: async () => { item.entry.recoveryPending = true; await writeTrashManifest(item.dir, item.data) } })
  assert.deepEqual(report.removed, []); assert.equal(report.skipped.length, 1)
  assert.equal(await exists(cleanupPendingPath(fx.panel, item.id)), false); assert(await exists(item.dir))
})

test('failure to persist the pre-removal audit prevents every destructive step', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY))
  await mocked(t, 'writeFile', async (original, path, ...args) => {
    if (String(path).includes('trash-cleanup.json.tmp-')) throw new Error('injected audit ENOSPC')
    return original(path, ...args)
  }, async () => {
    const { report } = await fx.run(); assert.equal(report.phase, 'blocked'); assert.deepEqual(report.removed, [])
  })
  assert(await exists(item.dir)); assert.equal(await exists(cleanupPendingDir(fx.panel)), false)
})

test('corrupt, unknown-version or linked cleanup audit stays unchanged and blocks automatic deletion', async t => {
  for (const kind of ['corrupt', 'version', 'link']) await t.test(kind, async t => {
    const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY)), record = cleanupRecordPath(fx.panel)
    if (kind === 'link') { await fs.writeFile(join(fx.root, 'outside.json'), 'outside secret'); await fs.symlink(join(fx.root, 'outside.json'), record) }
    else await fs.writeFile(record, kind === 'corrupt' ? '{sensitive-invalid-json' : '{"version":999}')
    const before = await fs.readFile(record), { report } = await fx.run()
    assert.equal(report.phase, 'blocked'); assert(await exists(item.dir)); assert.deepEqual(await fs.readFile(record), before)
    assert(!JSON.stringify(report).includes('sensitive-invalid-json'))
  })
})

test('partial rm failure leaves an outside intent; subsequent cleanup and undo refuse the damaged entity', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY))
  await mocked(t, 'rm', async (original, path, options) => {
    if (path === item.dir) { await original(join(item.entry.trashPath, 'SKILL.md')); throw new Error('injected partial EIO') }
    return original(path, options)
  }, async () => {
    const { report } = await fx.run(); assert.equal(report.failed.length, 1); assert.deepEqual(report.removed, [])
  })
  const marker = cleanupPendingPath(fx.panel, item.id)
  assert(await exists(marker)); assert.equal((await fs.stat(marker)).mode & 0o777, 0o600)
  assert.deepEqual((await fx.run()).report.removed, [])
  await assert.rejects(readTrashBatch(fx.panel, item.id), /清理中断/u)
  await assert.rejects(undoTrash(fx.panel), /清理中断/u)
  await assert.rejects(openSkillRecovery(fx.panel, item.id, item.entry.entryId, { kind: 'replace' }), /清理中断/u)
})

test('partially written intent is conservative even when its JSON is invalid', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY)), marker = cleanupPendingPath(fx.panel, item.id)
  await mocked(t, 'writeFile', async (original, path, ...args) => {
    if (path === marker) { await original(path, ''); throw new Error('injected intent ENOSPC') }
    return original(path, ...args)
  }, async () => { assert.equal((await fx.run()).report.failed.length, 1) })
  assert(await exists(join(item.entry.trashPath, 'SKILL.md'))); assert(await exists(marker))
  assert.equal((await fx.run()).report.plan.protected[0].batchId, item.id)
})

test('final audit write failure preserves the pre-plan and reports actual removed data honestly', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY))
  await mocked(t, 'rename', async (original, from, to) => {
    if (to === cleanupRecordPath(fx.panel) && !await exists(item.dir)) throw new Error('injected final audit failure')
    return original(from, to)
  }, async () => {
    const { report } = await fx.run(); assert.deepEqual(report.removed, [item.id]); assert.equal(report.failed.length, 1)
  })
  assert.equal(JSON.parse(await fs.readFile(cleanupRecordPath(fx.panel), 'utf8')).phase, 'planned')
  assert.equal(await exists(cleanupPendingPath(fx.panel, item.id)), false)
})

test('dispose/cancellation and changed policy after preview do not remove planned batches', async t => {
  for (const kind of ['cancel', 'policy']) await t.test(kind, async t => {
    const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY)); let stop = false
    const { report } = await fx.run({ cancelled: () => kind === 'cancel' && stop, policyUnchanged: async () => kind !== 'policy' || !stop,
      onPlanned: async () => { stop = true } })
    assert(await exists(item.dir)); assert.equal(report.skipped.length, 1); assert.deepEqual(report.removed, [])
    assert.equal(await exists(cleanupPendingPath(fx.panel, item.id)), false)
  })
})

test('a policy change during intent creation clears only its own unused intent and preserves the batch', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY)); let changed = false
  await mocked(t, 'writeFile', async (original, path, ...args) => {
    const result = await original(path, ...args); if (path === cleanupPendingPath(fx.panel, item.id)) changed = true; return result
  }, async () => {
    const { report } = await fx.run({ policyUnchanged: async () => !changed }); assert.equal(report.skipped.length, 1)
  })
  assert(await exists(item.dir)); assert.equal(await exists(cleanupPendingPath(fx.panel, item.id)), false)
})

test('new deletions wait for cleanup and are never added to its frozen removal plan', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY)), source = join(fx.project, '.dsh/skills/new.md')
  await fs.writeFile(source, doc('new'))
  let entered, release; const ready = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const sweep = fx.run({ maxBatches: 0, onPlanned: async () => { entered(); await held } }); await ready
  const deletion = deleteSkills([{ id: 'new', name: 'new', source: 'project-dsh', scope: 'workspace', status: 'enabled', form: 'file', rootPath: join(fx.project, '.dsh/skills'), skillFile: source }], { panelHome: fx.panel })
  await sleep(30); assert(await exists(source)); release()
  assert.deepEqual((await sweep).report.removed, [item.id])
  const removed = await deletion; assert.equal(removed.deleted.length, 1); assert(await exists(removed.batch.entries[0].trashPath))
})

test('successful entity-link cleanup never follows or removes its external target', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY)), outside = join(fx.root, 'outside')
  await fs.mkdir(outside); await fs.writeFile(join(outside, 'keep.txt'), 'outside bytes')
  await fs.rm(item.entry.trashPath, { recursive: true }); await fs.symlink(outside, item.entry.trashPath)
  assert.deepEqual((await fx.run()).report.removed, [item.id])
  assert.equal(await fs.readFile(join(outside, 'keep.txt'), 'utf8'), 'outside bytes')
})

test('last persisted execution is retained when the next startup has no work', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(+NOW - 8 * DAY)); await fx.run()
  const bytes = await fs.readFile(cleanupRecordPath(fx.panel)), next = await fx.run()
  assert.equal(next.report.plan.candidates.length, 0); assert.deepEqual(next.previous.removed, [item.id])
  assert.deepEqual(await fs.readFile(cleanupRecordPath(fx.panel)), bytes)
})

test('runtime startup publishes the pre-delete snapshot then removes only expired skill batches', async t => {
  const fx = await fixture(t), old = await fx.batch(new Date(Date.now() - 8 * DAY)), fresh = await fx.batch(new Date())
  const runtime = fx.start(); let observed = false; const snapshots = []
  runtime.subscribe(() => {
    if (!observed && runtime.snapshot().trashCleanup?.phase === 'planned') {
      observed = true; snapshots.push({ exists: existsSync(old.dir), phase: JSON.parse(readFileSync(cleanupRecordPath(fx.panel), 'utf8')).phase })
    }
  })
  await runtime.ensureFresh()
  assert(observed); assert.deepEqual(snapshots, [{ exists: true, phase: 'planned' }]); assert.equal(await exists(old.dir), false); assert(await exists(fresh.dir))
  assert.equal(runtime.snapshot().trashCleanup.trigger, 'startup'); assert.deepEqual(runtime.snapshot().lastTrashCleanup.removed, [old.id])
  runtime.dispose(); const again = fx.start(); await again.ensureFresh()
  assert.deepEqual(again.snapshot().lastTrashCleanup.removed, [old.id])
})

test('runtime deletion cleans after adding a batch and finishes with 100 normal batches', async t => {
  const fx = await fixture(t), now = Date.now(), batches = []
  for (let i = 0; i < 100; i++) batches.push(await fx.batch(new Date(now - 10000 + i)))
  const source = join(fx.project, '.dsh/skills/new.md'); await fs.writeFile(source, doc('new'))
  const runtime = fx.start(); await runtime.ensureFresh()
  const row = runtime.snapshot().scan.instances.find(row => row.name === 'new'); await runtime.deleteSkillInstances([row])
  const report = runtime.snapshot().trashCleanup
  assert.equal(report.trigger, 'after-delete'); assert.deepEqual(report.removed, [batches[0].id]); assert.equal(report.remainingNormal, 100)
  assert.equal((await listTrash(fx.panel)).length, 100); assert(runtime.snapshot().statusMessage.text.includes('可按 u 撤销'))
})

test('invalid configuration never falls back to a shorter destructive retention policy', async t => {
  for (const raw of ['{broken', '{"version":999}', '{"version":1,"trashRetentionDays":"90"}', '{"version":1,"trashRetentionDays":0}']) await t.test(raw, async t => {
    const fx = await fixture(t), item = await fx.batch(new Date(Date.now() - 8 * DAY)), path = join(fx.panel, 'config.json')
    await fs.writeFile(path, raw); const runtime = fx.start(); await runtime.ensureFresh()
    assert.equal(runtime.snapshot().trashCleanup.phase, 'blocked'); assert(await exists(item.dir)); assert.equal(await fs.readFile(path, 'utf8'), raw)
  })
})

test('an external config change at the published startup plan stops removal', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(Date.now() - 8 * DAY)), path = join(fx.panel, 'config.json')
  await fs.writeFile(path, '{"version":1,"trashRetentionDays":7}')
  const runtime = fx.start(); let changed = false
  runtime.subscribe(() => { if (!changed && runtime.snapshot().trashCleanup?.phase === 'planned') { changed = true; writeFileSync(path, '{"version":1,"trashRetentionDays":90,"retain":true}') } })
  await runtime.ensureFresh()
  assert(changed); assert(await exists(item.dir)); assert.equal(runtime.snapshot().trashCleanup.skipped.length, 1)
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).retain, true)
})

test('disposing the runtime from its pre-cleanup snapshot cancels all unstarted removals', async t => {
  const fx = await fixture(t), item = await fx.batch(new Date(Date.now() - 8 * DAY)), runtime = fx.start()
  runtime.subscribe(() => { if (runtime.snapshot().trashCleanup?.phase === 'planned') runtime.dispose() })
  await runtime.ensureFresh()
  assert(await exists(item.dir)); assert.equal(JSON.parse(await fs.readFile(cleanupRecordPath(fx.panel), 'utf8')).skipped.length, 1)
})
