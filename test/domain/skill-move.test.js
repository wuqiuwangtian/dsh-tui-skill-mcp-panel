import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanSkills } from '../../lib/types/domain/skills/index.js'
import { moveEntity } from '../../lib/types/domain/skills/move.js'
import { deleteSkills, listTrash, undoTrash, cleanupTrash } from '../../lib/types/domain/skills/write.js'

const doc = name => `---\nname: ${name}\ndescription: move fixture\n---\nBody.\n`
const exists = path => fs.lstat(path).then(() => true, () => false)
async function fixture(t, crossDevice = false) {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill-move-'))
  let sourceRoot = root
  t.after(async () => {
    if (sourceRoot !== root) await fs.rm(sourceRoot, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  })
  if (crossDevice) {
    try {
      sourceRoot = await fs.mkdtemp('/dev/shm/skill-move-')
      if ((await fs.stat(sourceRoot)).dev === (await fs.stat(root)).dev) { t.skip('requires two writable devices'); return }
    } catch { t.skip('requires writable /dev/shm and tmpdir on different devices'); return }
  }
  const project = join(sourceRoot, 'project'), panel = join(root, 'panel'), skills = join(project, '.dsh/skills')
  const alpha = join(skills, 'alpha')
  await fs.mkdir(join(project, '.git'), { recursive: true })
  await fs.mkdir(join(alpha, 'empty'), { recursive: true })
  await fs.writeFile(join(alpha, 'SKILL.md'), doc('alpha'))
  const binary = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 251))
  await fs.writeFile(join(alpha, 'run.bin'), binary, { mode: 0o751 })
  await fs.symlink('run.bin', join(alpha, 'relative-link'))
  await fs.symlink(join(root, 'external.txt'), join(alpha, 'external-link'))
  await fs.writeFile(join(root, 'external.txt'), 'outside must stay unchanged')
  await fs.writeFile(join(skills, 'beta.md.disabled'), doc('beta'))
  const scan = () => scanSkills({ cwd: project, dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), bundledDir: join(root, 'bundled') })
  return { root, project, panel, skills, alpha, binary, scan, rows: (await scan()).instances }
}

async function assertAlpha(path, fx) {
  assert.equal(await fs.readFile(join(path, 'SKILL.md'), 'utf8'), doc('alpha'))
  assert.deepEqual(await fs.readFile(join(path, 'run.bin')), fx.binary)
  assert.equal((await fs.stat(join(path, 'run.bin'))).mode & 0o777, 0o751)
  assert.deepEqual(await fs.readdir(join(path, 'empty')), [])
  assert.equal(await fs.readlink(join(path, 'relative-link')), 'run.bin')
  assert.equal(await fs.readlink(join(path, 'external-link')), join(fx.root, 'external.txt'))
  assert.equal(await fs.readFile(join(fx.root, 'external.txt'), 'utf8'), 'outside must stay unchanged')
}

async function mocked(t, name, fn, body) {
  const original = fs[name]
  const mock = t.mock.method(fs, name, (...args) => fn(original, ...args))
  syncBuiltinESMExports()
  try { return await body() } finally { mock.mock.restore(); syncBuiltinESMExports() }
}

test('real cross-device delete and undo preserve directory assets, modes, empty dirs, links and disabled files', async t => {
  const fx = await fixture(t, true); if (!fx) return
  const result = await deleteSkills(fx.rows, { panelHome: fx.panel })
  assert.equal(result.deleted.length, 2); assert.deepEqual(result.failed, [])
  const entry = result.batch.entries.find(entry => entry.name === 'alpha')
  await assertAlpha(entry.trashPath, fx)
  assert.equal(await exists(fx.alpha), false)
  const undo = await undoTrash(fx.panel)
  assert.deepEqual(undo.restored.sort(), ['alpha', 'beta']); assert.deepEqual(undo.failed, [])
  await assertAlpha(fx.alpha, fx)
  assert.equal(await fs.readFile(join(fx.skills, 'beta.md.disabled'), 'utf8'), doc('beta'))
  assert.deepEqual(await listTrash(fx.panel), [])
})

test('cross-device move of a root symlink preserves the literal link and never copies or deletes its target', async t => {
  const fx = await fixture(t, true); if (!fx) return
  const source = join(fx.skills, 'root-link'), destination = join(fx.root, 'link-copy')
  await fs.symlink(fx.alpha, source)
  await moveEntity(source, destination)
  assert.equal(await fs.readlink(destination), fx.alpha)
  assert.equal(await exists(source), false)
  await assertAlpha(fx.alpha, fx)
})

test('cross-device copy ENOSPC aborts without removing source or keeping an ordinary deletion batch', async t => {
  const fx = await fixture(t, true); if (!fx) return
  await mocked(t, 'copyFile', async () => { throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' }) }, async () => {
    const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /ENOSPC/u)
  })
  await assertAlpha(fx.alpha, fx)
  assert.deepEqual(await listTrash(fx.panel), [])
})

test('corrupt copied bytes fail verification before source removal', async t => {
  const fx = await fixture(t, true); if (!fx) return
  await mocked(t, 'copyFile', async (original, from, to, flags) => {
    await original(from, to, flags)
    if (from.endsWith('run.bin')) await fs.writeFile(to, 'corrupt')
  }, async () => {
    const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /副本校验失败/u)
  })
  await assertAlpha(fx.alpha, fx)
})

test('source changes during copying are preserved and stop publication', async t => {
  const fx = await fixture(t, true); if (!fx) return
  const beta = fx.rows.find(row => row.name === 'beta')
  await mocked(t, 'copyFile', async (original, from, to, flags) => {
    await original(from, to, flags)
    if (from === beta.skillFile) await fs.writeFile(from, doc('external-replacement'))
  }, async () => {
    const result = await deleteSkills([beta], { panelHome: fx.panel })
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /源数据在复制期间发生变化/u)
  })
  assert.equal(await fs.readFile(beta.skillFile, 'utf8'), doc('external-replacement'))
  assert.deepEqual(await listTrash(fx.panel), [])
})

test('partial source removal failure rolls the complete entity back before discarding its copy', async t => {
  const fx = await fixture(t, true); if (!fx) return
  await mocked(t, 'rm', async (original, path, options) => {
    if (path === fx.alpha) {
      await original(join(fx.alpha, 'run.bin'))
      throw Object.assign(new Error('injected partial remove EIO'), { code: 'EIO' })
    }
    return original(path, options)
  }, async () => {
    const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /已回滚到原位置/u)
  })
  await assertAlpha(fx.alpha, fx)
  assert.deepEqual(await listTrash(fx.panel), [])
})

test('failed rollback retains the verified copy and a durable recovery flag excluded from retention', async t => {
  const fx = await fixture(t, true); if (!fx) return
  await mocked(t, 'rm', async (original, path, options) => {
    if (path === fx.alpha) { await original(join(fx.alpha, 'run.bin')); throw new Error('injected partial removal') }
    return original(path, options)
  }, async () => mocked(t, 'copyFile', async (original, from, to, flags) => {
    if (to === join(fx.alpha, 'run.bin')) throw new Error('injected rollback ENOSPC')
    return original(from, to, flags)
  }, async () => {
    const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /恢复副本已保留/u)
  }))
  const batches = await listTrash(fx.panel)
  assert.equal(batches.length, 1); assert.equal(batches[0].entries[0].recoveryPending, true)
  await assertAlpha(batches[0].entries[0].trashPath, fx)
  assert.equal(await cleanupTrash(fx.panel, { maxBatches: 0, retentionDays: 0 }), 0)
  const conflict = await undoTrash(fx.panel)
  assert.equal(conflict.conflicts.length, 1)
  // Preserve the partial source as a separate fixture before retrying recovery.
  await fs.rename(fx.alpha, join(fx.skills, 'partial-source'))
  assert.deepEqual((await undoTrash(fx.panel)).restored, ['alpha'])
  await assertAlpha(fx.alpha, fx)
})

test('permission-related rename failure uses the same verified fallback without forcing permissions', async t => {
  const fx = await fixture(t), destination = join(fx.root, 'moved-alpha')
  await mocked(t, 'rename', async (original, from, to) => {
    if (from === fx.alpha) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' })
    return original(from, to)
  }, async () => moveEntity(fx.alpha, destination))
  await assertAlpha(destination, fx)
  assert.equal(await exists(fx.alpha), false)
})

test('unrelated rename failure refuses the move without attempting a copy', async t => {
  const fx = await fixture(t), destination = join(fx.root, 'moved-alpha')
  await mocked(t, 'rename', async () => { throw Object.assign(new Error('injected EIO'), { code: 'EIO' }) }, async () => {
    await assert.rejects(moveEntity(fx.alpha, destination), /EIO/u)
  })
  await assertAlpha(fx.alpha, fx)
  assert.equal(await exists(destination), false)
})

test('undo treats a dangling symlink as an occupied destination and leaves both sides untouched', async t => {
  const fx = await fixture(t)
  const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
  await fs.symlink(join(fx.root, 'missing-target'), fx.alpha)
  const undo = await undoTrash(fx.panel)
  assert.equal(undo.conflicts.length, 1); assert.deepEqual(undo.restored, [])
  assert.equal(await fs.readlink(fx.alpha), join(fx.root, 'missing-target'))
  await assertAlpha(result.batch.entries[0].trashPath, fx)
})

test('partial undo success never removes a conflicting sibling directory from the same scope', async t => {
  const fx = await fixture(t)
  await fs.mkdir(join(fx.skills, 'gamma')); await fs.writeFile(join(fx.skills, 'gamma/SKILL.md'), doc('gamma'))
  const result = await deleteSkills((await fx.scan()).instances.filter(row => ['alpha', 'gamma'].includes(row.name)), { panelHome: fx.panel })
  await fs.mkdir(fx.alpha); await fs.writeFile(join(fx.alpha, 'SKILL.md'), doc('replacement'))
  const undo = await undoTrash(fx.panel)
  assert.deepEqual(undo.restored, ['gamma']); assert.equal(undo.conflicts.length, 1)
  const remaining = (await listTrash(fx.panel))[0]
  assert.equal(remaining.entries.length, 1)
  await assertAlpha(remaining.entries[0].trashPath, fx)
  assert.equal(await fs.readFile(join(fx.alpha, 'SKILL.md'), 'utf8'), doc('replacement'))
  assert.equal(await fs.readFile(join(fx.skills, 'gamma/SKILL.md'), 'utf8'), doc('gamma'))
  assert.equal(remaining.batchId, result.batchId)
})

test('undo journal failure aborts before moving any entity', async t => {
  const fx = await fixture(t)
  const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
  await mocked(t, 'writeFile', async (original, path, ...args) => {
    if (String(path).includes('manifest.json.tmp-')) throw new Error('injected journal ENOSPC')
    return original(path, ...args)
  }, async () => {
    const undo = await undoTrash(fx.panel)
    assert.deepEqual(undo.restored, []); assert.match(undo.failed[0].error, /未移动文件/u)
  })
  await assertAlpha(result.batch.entries[0].trashPath, fx)
  assert.equal(await exists(fx.alpha), false)
})

test('a destination created during copying is preserved and source is not removed', async t => {
  const fx = await fixture(t, true); if (!fx) return
  const source = join(fx.skills, 'beta.md.disabled'), destination = join(fx.root, 'restore-target.md')
  await mocked(t, 'copyFile', async (original, from, to, flags) => {
    await original(from, to, flags)
    await fs.writeFile(destination, 'external target')
  }, async () => assert.rejects(moveEntity(source, destination), /目标已存在/u))
  assert.equal(await fs.readFile(source, 'utf8'), doc('beta'))
  assert.equal(await fs.readFile(destination, 'utf8'), 'external target')
})

test('rollback never overwrites a source file that changed after partial removal', async t => {
  const fx = await fixture(t, true); if (!fx) return
  await mocked(t, 'rm', async (original, path, options) => {
    if (path === fx.alpha) {
      await original(join(fx.alpha, 'run.bin'))
      await fs.writeFile(join(fx.alpha, 'SKILL.md'), doc('new-external-data'))
      throw new Error('injected partial removal and external change')
    }
    return original(path, options)
  }, async () => {
    const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
    assert.match(result.failed[0].error, /未覆盖/u)
  })
  assert.equal(await fs.readFile(join(fx.alpha, 'SKILL.md'), 'utf8'), doc('new-external-data'))
  const entry = (await listTrash(fx.panel))[0].entries[0]
  assert.equal(entry.recoveryPending, true)
  await assertAlpha(entry.trashPath, fx)
})

test('restore staging is nested and never discovered as an enabled skill before publication', async t => {
  const fx = await fixture(t, true); if (!fx) return
  await deleteSkills(fx.rows, { panelHome: fx.panel })
  let observed = false
  await mocked(t, 'copyFile', async (original, from, to, flags) => {
    await original(from, to, flags)
    if (from.startsWith(fx.panel) && from.endsWith('SKILL.md')) {
      const rows = (await fx.scan()).instances
      assert.equal(rows.filter(row => row.name === 'alpha').length, 0)
      assert(to.includes('/entity/SKILL.md'))
      observed = true
    }
  }, async () => {
    const result = await undoTrash(fx.panel)
    assert.deepEqual(result.failed, [])
  })
  assert(observed)
  await assertAlpha(fx.alpha, fx)
})

test('failed post-restore manifest update keeps the durable pending journal out of retention', async t => {
  const fx = await fixture(t)
  await deleteSkills(fx.rows.filter(row => ['alpha', 'beta'].includes(row.name)), { panelHome: fx.panel })
  await fs.writeFile(join(fx.skills, 'beta.md.disabled'), doc('occupied'))
  await mocked(t, 'writeFile', async (original, path, ...args) => {
    if (String(path).includes('manifest.json.tmp-') && await exists(fx.alpha)) throw new Error('injected final manifest failure')
    return original(path, ...args)
  }, async () => {
    const result = await undoTrash(fx.panel)
    assert.deepEqual(result.restored, ['alpha'])
    assert.match(result.failed[0].error, /清单更新失败/u)
  })
  await assertAlpha(fx.alpha, fx)
  assert((await listTrash(fx.panel))[0].entries.every(entry => entry.recoveryPending))
  assert.equal(await cleanupTrash(fx.panel, { maxBatches: 0 }), 0)
})

test('partial copy cleanup failure reports that the source was restored and retains the pending journal', async t => {
  const fx = await fixture(t, true); if (!fx) return
  await mocked(t, 'rm', async (original, path, options) => {
    if (path === fx.alpha) throw new Error('injected source removal failure')
    if (String(path).includes('/workspace/alpha')) {
      await original(join(path, 'run.bin'))
      throw new Error('injected partial copy cleanup failure')
    }
    return original(path, options)
  }, async () => {
    const result = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
    assert.deepEqual(result.deleted, [])
    assert.match(result.failed[0].error, /源数据已恢复，移动副本清理未完成/u)
  })
  await assertAlpha(fx.alpha, fx)
  assert.equal((await listTrash(fx.panel))[0].entries[0].recoveryPending, true)
  assert.equal(await cleanupTrash(fx.panel, { maxBatches: 0 }), 0)
})

test('interrupted undo never retries an unverified partial trash entity after the restored destination is moved away', async t => {
  const fx = await fixture(t, true); if (!fx) return
  const deleted = await deleteSkills([fx.rows.find(row => row.name === 'alpha')], { panelHome: fx.panel })
  const trashPath = deleted.batch.entries[0].trashPath
  await mocked(t, 'rm', async (original, path, options) => {
    if (path === trashPath) { await original(join(path, 'run.bin')); throw new Error('injected partial trash removal') }
    return original(path, options)
  }, async () => mocked(t, 'copyFile', async (original, from, to, flags) => {
    if (to === join(trashPath, 'run.bin')) throw new Error('injected trash rollback ENOSPC')
    return original(from, to, flags)
  }, async () => {
    const result = await undoTrash(fx.panel)
    assert.deepEqual(result.restored, []); assert.match(result.failed[0].error, /恢复副本已保留/u)
  }))
  await assertAlpha(fx.alpha, fx)
  const retained = (await listTrash(fx.panel))[0].entries[0]
  assert.equal(retained.recoveryDirection, 'restore'); assert.equal(retained.recoveryPending, true)
  const saved = join(fx.skills, 'saved-complete-alpha')
  await fs.rename(fx.alpha, saved)
  const retry = await undoTrash(fx.panel)
  assert.deepEqual(retry.restored, []); assert.match(retry.failed[0].error, /可能不完整，未自动恢复/u)
  assert.equal(await exists(fx.alpha), false)
  await assertAlpha(saved, fx)
  assert.equal(await cleanupTrash(fx.panel, { maxBatches: 0 }), 0)
})
