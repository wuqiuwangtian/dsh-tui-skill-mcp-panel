import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { scanSkills } from '../../lib/types/domain/skills/index.js'
import { deleteSkills, listTrash, undoTrash, cleanupTrash } from '../../lib/types/domain/skills/write.js'
import { openSkillRecovery, commitSkillRecovery } from '../../lib/types/domain/skills/recovery.js'

const doc = name => `---\nname: ${name}\ndescription: Recovery fixture\n---\nBody.\n`
const exists = path => fs.lstat(path).then(() => true, () => false)
async function fixture(t, { flat = false, global = false, crossDevice = false } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill-recovery-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let project = join(root, 'project')
  if (crossDevice) {
    try {
      project = await fs.mkdtemp('/dev/shm/skill-recovery-')
      t.after(() => fs.rm(project, { recursive: true, force: true }))
      if ((await fs.stat(project)).dev === (await fs.stat(root)).dev) { t.skip('requires different writable devices'); return }
    } catch { t.skip('requires writable /dev/shm on a different device'); return }
  }
  const home = join(root, 'home'), panel = join(root, 'panel')
  const projectSkills = join(project, '.dsh/skills'), globalSkills = join(home, 'skills')
  const sourceRoot = global ? globalSkills : projectSkills
  await fs.mkdir(join(project, '.git'), { recursive: true })
  await fs.mkdir(sourceRoot, { recursive: true })
  const entity = join(sourceRoot, flat ? 'alpha.md.disabled' : 'alpha')
  const skillFile = flat ? entity : join(entity, 'SKILL.md')
  if (!flat) { await fs.mkdir(entity); await fs.mkdir(join(entity, 'empty')) }
  await fs.writeFile(skillFile, doc('alpha'))
  if (!flat) await fs.writeFile(join(entity, 'run.sh'), '#!/bin/sh\nprintf fixture\n', { mode: 0o751 })
  const scan = () => scanSkills({ cwd: project, dshHome: home, agentsHome: join(root, 'agents'), bundledDir: join(root, 'bundled') })
  const original = (await scan()).instances.find(row => row.name === 'alpha')
  const deleted = await deleteSkills([original], { panelHome: panel })
  if (!flat) await fs.mkdir(entity)
  await fs.writeFile(skillFile, doc('occupying'))
  if (!flat) await fs.writeFile(join(entity, 'occupant.txt'), 'keep exact old data')
  const entry = deleted.batch.entries[0], batchId = deleted.batchId
  const manifest = join(panel, 'trash', batchId, 'manifest.json')
  const open = choice => openSkillRecovery(panel, batchId, entry.entryId, choice)
  return { root, project, home, panel, projectSkills, globalSkills, entity, skillFile, flat, entry, batchId, manifest, scan, open }
}
async function assertOriginalTrash(fx) {
  const file = fx.flat ? fx.entry.trashPath : join(fx.entry.trashPath, 'SKILL.md')
  assert.equal(await fs.readFile(file, 'utf8'), doc('alpha'))
}
async function mocked(t, name, fn, body) {
  const original = fs[name]
  const mock = t.mock.method(fs, name, (...args) => fn(original, ...args))
  syncBuiltinESMExports()
  try { return await body() } finally { mock.mock.restore(); syncBuiltinESMExports() }
}

test('replace recovery verifies a private backup and preserves directory content, modes and empty dirs', async t => {
  const fx = await fixture(t)
  const undo = await undoTrash(fx.panel)
  assert.equal(undo.conflictEntries[0].entryId, fx.entry.entryId)
  const session = await fx.open({ kind: 'replace' })
  const result = await commitSkillRecovery(session)
  assert.deepEqual(result.warnings, [])
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('alpha'))
  assert.equal((await fs.stat(join(fx.entity, 'run.sh'))).mode & 0o777, 0o751)
  assert.deepEqual(await fs.readdir(join(fx.entity, 'empty')), [])
  assert.equal(await fs.readFile(join(result.backupPath, 'SKILL.md'), 'utf8'), doc('occupying'))
  assert.equal(await fs.readFile(join(result.backupPath, 'occupant.txt'), 'utf8'), 'keep exact old data')
  const record = join(session.backupDir, 'manifest.json')
  assert.equal((await fs.stat(record)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(session.backupDir)).mode & 0o777, 0o700)
  assert.equal(JSON.parse(await fs.readFile(record, 'utf8')).originalPath, fx.entity)
  assert.deepEqual(await listTrash(fx.panel), [])
})

test('replace recovery preserves a disabled flat filename and exact occupying bytes in backup', async t => {
  const fx = await fixture(t, { flat: true })
  const result = await commitSkillRecovery(await fx.open({ kind: 'replace' }))
  assert.equal(result.destination, fx.entity)
  assert.equal(await fs.readFile(fx.entity, 'utf8'), doc('alpha'))
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), doc('occupying'))
})

test('workspace to global recovery leaves original occupant intact and creates no overwrite backup', async t => {
  const fx = await fixture(t)
  const result = await commitSkillRecovery(await fx.open({ kind: 'scope', scope: 'global', rootPath: fx.globalSkills }))
  assert.equal(result.backupPath, undefined)
  assert.equal(await fs.readFile(join(fx.globalSkills, 'alpha/SKILL.md'), 'utf8'), doc('alpha'))
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
  assert.deepEqual(await listTrash(fx.panel), [])
})

test('global disabled file can recover to the current workspace without overwriting either scope', async t => {
  const fx = await fixture(t, { flat: true, global: true })
  const result = await commitSkillRecovery(await fx.open({ kind: 'scope', scope: 'workspace', rootPath: fx.projectSkills }))
  assert.equal(result.destination, join(fx.projectSkills, 'alpha.md.disabled'))
  assert.equal(await fs.readFile(result.destination, 'utf8'), doc('alpha'))
  assert.equal(await fs.readFile(fx.entity, 'utf8'), doc('occupying'))
})

test('preparing then cancelling a choice does not create backups or change any source or journal bytes', async t => {
  const fx = await fixture(t), before = await fs.readFile(fx.manifest)
  const session = await fx.open({ kind: 'replace' })
  assert.equal(await exists(session.backupDir), false)
  assert.deepEqual(await fs.readFile(fx.manifest), before)
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
  await assertOriginalTrash(fx)
})

test('stale destination, trash or journal snapshots refuse commits before any backup or replacement', async t => {
  for (const changed of ['destination', 'trash', 'journal']) {
    await t.test(changed, async t => {
      const fx = await fixture(t), session = await fx.open({ kind: 'replace' })
      if (changed === 'destination') await fs.writeFile(fx.skillFile, doc('external'))
      else if (changed === 'trash') await fs.writeFile(join(fx.entry.trashPath, 'SKILL.md'), doc('external-trash'))
      else await fs.appendFile(fx.manifest, ' ')
      await assert.rejects(commitSkillRecovery(session), /已变化/u)
      assert.equal(await exists(session.backupDir), false)
      assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc(changed === 'destination' ? 'external' : 'occupying'))
    })
  }
})

test('new target entity or same-name skill created after preview refuses alternate-scope recovery', async t => {
  for (const path of ['alpha', 'different-directory']) {
    await t.test(path, async t => {
      const fx = await fixture(t), session = await fx.open({ kind: 'scope', scope: 'global', rootPath: fx.globalSkills })
      await fs.mkdir(join(fx.globalSkills, path), { recursive: true })
      await fs.writeFile(join(fx.globalSkills, path, 'SKILL.md'), doc('alpha'))
      await assert.rejects(commitSkillRecovery(session), /已变化|同名技能/u)
      await assertOriginalTrash(fx)
      assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
    })
  }
})

test('failed backup copy or backup journal does not move the occupying entity or trash', async t => {
  for (const failure of ['copyFile', 'writeFile']) {
    await t.test(failure, async t => {
      const fx = await fixture(t), session = await fx.open({ kind: 'replace' })
      await mocked(t, failure, async (original, from, ...args) => {
        if (failure === 'copyFile' || from === join(session.backupDir, 'manifest.json')) throw new Error('injected backup ENOSPC')
        return original(from, ...args)
      }, () => assert.rejects(commitSkillRecovery(session), /ENOSPC/u))
      assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
      assert.equal((await listTrash(fx.panel))[0].entries[0].recoveryPending, undefined)
      await assertOriginalTrash(fx)
    })
  }
})

test('failed recovery intent leaves both original entities intact and keeps the verified backup', async t => {
  const fx = await fixture(t), session = await fx.open({ kind: 'replace' })
  await mocked(t, 'writeFile', async (original, path, ...args) => {
    if (String(path).includes('manifest.json.tmp-')) throw new Error('injected intent failure')
    return original(path, ...args)
  }, () => assert.rejects(commitSkillRecovery(session), /intent failure/u))
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
  assert.equal(await fs.readFile(join(session.backupDir, 'entity/SKILL.md'), 'utf8'), doc('occupying'))
  await assertOriginalTrash(fx)
})

test('destination changes after backup or intent are preserved and stop displacement', async t => {
  for (const phase of ['backup', 'intent']) {
    await t.test(phase, async t => {
      const fx = await fixture(t), session = await fx.open({ kind: 'replace' }); let injected = false
      await mocked(t, phase === 'backup' ? 'writeFile' : 'rename', async (original, from, to, ...args) => {
        const value = await original(from, to, ...args)
        if (!injected && (phase === 'backup' ? from === join(session.backupDir, 'manifest.json') : to === fx.manifest)) {
          injected = true; await fs.writeFile(fx.skillFile, doc('new-external'))
        }
        return value
      }, () => assert.rejects(commitSkillRecovery(session), /已变化/u))
      assert(injected)
      assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('new-external'))
      await assertOriginalTrash(fx)
    })
  }
})

test('restore failure after displacement rolls occupying data back and leaves trash retryable', async t => {
  const fx = await fixture(t), session = await fx.open({ kind: 'replace' })
  await mocked(t, 'rename', async (original, from, to) => {
    if (from === fx.entry.trashPath) throw Object.assign(new Error('injected restore EIO'), { code: 'EIO' })
    return original(from, to)
  }, () => assert.rejects(commitSkillRecovery(session), /EIO/u))
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
  await assertOriginalTrash(fx)
  assert.equal((await listTrash(fx.panel))[0].entries[0].recoveryPending, undefined)
  await commitSkillRecovery(await fx.open({ kind: 'replace' }))
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('alpha'))
})

test('failed rollback preserves backup, displaced data, trash and a durable pending record', async t => {
  const fx = await fixture(t), session = await fx.open({ kind: 'replace' })
  await mocked(t, 'rename', async (original, from, to) => {
    if (from === fx.entry.trashPath || from === join(session.backupDir, 'displaced')) throw Object.assign(new Error('injected move EIO'), { code: 'EIO' })
    return original(from, to)
  }, () => assert.rejects(commitSkillRecovery(session), /备份保留于/u))
  assert.equal(await exists(fx.entity), false)
  assert.equal(await fs.readFile(join(session.backupDir, 'entity/SKILL.md'), 'utf8'), doc('occupying'))
  assert.equal(await fs.readFile(join(session.backupDir, 'displaced/SKILL.md'), 'utf8'), doc('occupying'))
  await assertOriginalTrash(fx)
  const entry = (await listTrash(fx.panel))[0].entries[0]
  assert.equal(entry.recoveryPending, true); assert.equal(entry.recoveryBackupPath, session.backupDir)
  assert.equal(await cleanupTrash(fx.panel, { maxBatches: 0 }), 0)
  await assert.rejects(fx.open({ kind: 'replace' }), /中断恢复状态/u)
})

test('final journal cleanup failure reports restored files and retains intent and backup', async t => {
  const fx = await fixture(t), session = await fx.open({ kind: 'replace' })
  let result
  await mocked(t, 'rm', async (original, path, options) => {
    if (path === dirname(fx.manifest)) throw new Error('injected final journal cleanup failure')
    return original(path, options)
  }, async () => { result = await commitSkillRecovery(session) })
  assert.equal(result.warnings.length, 1)
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('alpha'))
  assert.equal(await fs.readFile(join(result.backupPath, 'SKILL.md'), 'utf8'), doc('occupying'))
  assert.equal((await listTrash(fx.panel))[0].entries[0].recoveryPending, true)
  assert.equal(await cleanupTrash(fx.panel, { maxBatches: 0 }), 0)
})

test('symlink occupant backup keeps the link and does not modify its external target', async t => {
  const fx = await fixture(t, { flat: true })
  const outside = join(fx.root, 'outside.md'); await fs.writeFile(outside, 'external literal bytes')
  await fs.rm(fx.entity); await fs.symlink(outside, fx.entity)
  const result = await commitSkillRecovery(await fx.open({ kind: 'replace' }))
  assert.equal(await fs.readlink(result.backupPath), outside)
  assert.equal(await fs.readFile(outside, 'utf8'), 'external literal bytes')
  assert.equal(await fs.readFile(fx.entity, 'utf8'), doc('alpha'))
})

test('system, same-scope, linked roots and malformed trash paths are rejected', async t => {
  const fx = await fixture(t)
  await assert.rejects(fx.open({ kind: 'scope', scope: 'global', rootPath: join(fx.globalSkills, '.system') }), /\.system/u)
  await assert.rejects(fx.open({ kind: 'scope', scope: 'workspace', rootPath: fx.globalSkills }), /另一个作用域/u)
  await fs.mkdir(fx.globalSkills, { recursive: true }); await fs.symlink(fx.globalSkills, join(fx.root, 'linked'))
  await assert.rejects(fx.open({ kind: 'scope', scope: 'global', rootPath: join(fx.root, 'linked') }), /符号链接/u)
  const raw = JSON.parse(await fs.readFile(fx.manifest, 'utf8')); raw.entries[0].trashPath = fx.manifest
  await fs.writeFile(fx.manifest, JSON.stringify(raw))
  await assert.rejects(fx.open({ kind: 'replace' }), /结构无效/u)
})

test('linked backup root is refused before copying or displacing any data', async t => {
  const fx = await fixture(t), outside = join(fx.root, 'outside')
  await fs.mkdir(outside); await fs.symlink(outside, join(fx.panel, 'backups'))
  await assert.rejects(commitSkillRecovery(await fx.open({ kind: 'replace' })), /符号链接/u)
  assert.deepEqual(await fs.readdir(outside), [])
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
  await assertOriginalTrash(fx)
})

test('two competing recovery sessions cannot both replace the same entry', async t => {
  const fx = await fixture(t), one = await fx.open({ kind: 'replace' }), two = await fx.open({ kind: 'replace' })
  const results = await Promise.allSettled([commitSkillRecovery(one), commitSkillRecovery(two)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('alpha'))
  assert.equal((await fs.readdir(join(fx.panel, 'backups/skills'))).length, 1)
})

test('replacement also verifies backup and restores correctly across real devices', async t => {
  const fx = await fixture(t, { crossDevice: true }); if (!fx) return
  const session = await fx.open({ kind: 'replace' }), result = await commitSkillRecovery(session)
  assert.deepEqual(result.warnings, [])
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('alpha'))
  assert.equal((await fs.stat(join(fx.entity, 'run.sh'))).mode & 0o777, 0o751)
  assert.equal(await fs.readFile(join(result.backupPath, 'occupant.txt'), 'utf8'), 'keep exact old data')
  assert.deepEqual(await listTrash(fx.panel), [])
})

test('backup corruption after intent is detected before displacing the occupant', async t => {
  const fx = await fixture(t), session = await fx.open({ kind: 'replace' }); let injected = false
  await mocked(t, 'rename', async (original, from, to) => {
    const result = await original(from, to)
    if (!injected && to === fx.manifest) { injected = true; await fs.writeFile(join(session.backupDir, 'entity/occupant.txt'), 'changed backup') }
    return result
  }, () => assert.rejects(commitSkillRecovery(session), /备份已变化/u))
  assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
  assert.equal(await fs.readFile(join(fx.entity, 'occupant.txt'), 'utf8'), 'keep exact old data')
  await assertOriginalTrash(fx)
})

test('single-entry recovery preserves other directory entries in the same trash batch', async t => {
  const fx = await fixture(t)
  // Put alpha back, then delete alpha and gamma together to form a fresh batch.
  await fs.rm(fx.entity, { recursive: true }); await undoTrash(fx.panel)
  const gamma = join(fx.projectSkills, 'gamma'); await fs.mkdir(gamma); await fs.writeFile(join(gamma, 'SKILL.md'), doc('gamma'))
  const batch = await deleteSkills((await fx.scan()).instances.filter(row => ['alpha', 'gamma'].includes(row.name)), { panelHome: fx.panel })
  await fs.mkdir(fx.entity); await fs.writeFile(fx.skillFile, doc('occupying'))
  const alpha = batch.batch.entries.find(entry => entry.name === 'alpha')
  await commitSkillRecovery(await openSkillRecovery(fx.panel, batch.batchId, alpha.entryId, { kind: 'replace' }))
  const remaining = (await listTrash(fx.panel))[0]
  assert.equal(remaining.entries.length, 1); assert.equal(remaining.entries[0].name, 'gamma')
  assert.equal(await fs.readFile(join(remaining.entries[0].trashPath, 'SKILL.md'), 'utf8'), doc('gamma'))
  assert.deepEqual((await undoTrash(fx.panel)).restored, ['gamma'])
})

test('malformed siblings, duplicate IDs or unknown journal versions refuse recovery without rewriting data', async t => {
  for (const kind of ['malformed', 'duplicate', 'trash-alias', 'version']) {
    await t.test(kind, async t => {
      const fx = await fixture(t), raw = JSON.parse(await fs.readFile(fx.manifest, 'utf8'))
      if (kind === 'malformed') raw.entries.push(null)
      else if (kind === 'duplicate') raw.entries.push({ ...raw.entries[0] })
      else if (kind === 'trash-alias') raw.entries.push({ ...raw.entries[0], entryId: 'different-id' })
      else raw.version = 999
      const bytes = JSON.stringify(raw); await fs.writeFile(fx.manifest, bytes)
      await assert.rejects(fx.open({ kind: 'replace' }), /损坏|身份重复|版本/u)
      assert.equal(await fs.readFile(fx.manifest, 'utf8'), bytes)
      assert.equal(await fs.readFile(fx.skillFile, 'utf8'), doc('occupying'))
      await assertOriginalTrash(fx)
    })
  }
})

test('recovering one entry preserves unknown journal and sibling metadata', async t => {
  const fx = await fixture(t), raw = JSON.parse(await fs.readFile(fx.manifest, 'utf8'))
  raw.notes = { retain: ['future-metadata'] }
  const siblingPath = join(dirname(fx.manifest), 'workspace', 'beta')
  await fs.mkdir(siblingPath); await fs.writeFile(join(siblingPath, 'SKILL.md'), doc('beta'))
  raw.entries.push({ ...raw.entries[0], entryId: 'unprocessed-sibling', name: 'beta', extra: { retain: true },
    trashPath: siblingPath, entityPath: join(fx.projectSkills, 'beta'), originalPath: join(fx.projectSkills, 'beta/SKILL.md') })
  await fs.writeFile(fx.manifest, JSON.stringify(raw))
  // Runtime's initial ordinary undo must also preserve unknown fields before opening choices.
  await fs.mkdir(join(fx.projectSkills, 'beta')); await fs.writeFile(join(fx.projectSkills, 'beta/SKILL.md'), doc('occupied-beta'))
  await undoTrash(fx.panel)
  await commitSkillRecovery(await fx.open({ kind: 'replace' }))
  const saved = JSON.parse(await fs.readFile(fx.manifest, 'utf8'))
  assert.deepEqual(saved.notes, raw.notes)
  assert.equal(saved.entries[0].entryId, 'unprocessed-sibling')
  assert.deepEqual(saved.entries[0].extra, { retain: true })
})
