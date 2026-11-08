import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanSkills } from '../../lib/types/domain/skills/index.js'
import {
  addSkill,
  cleanupTrash,
  deleteSkills,
  listTrash,
  toggleSkill,
  toggleTargetPath,
  undoTrash,
} from '../../lib/types/domain/skills/write.js'
import { trashRoot } from '../../lib/types/domain/store.js'

const skillDoc = (name, description = `desc ${name}`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skill-write-'))
  const project = join(root, 'project')
  const home = join(root, 'home')
  const agents = join(root, 'agents')
  const custom = join(root, 'custom')
  const panelHome = join(root, 'panel')
  await mkdir(join(project, '.git'), { recursive: true })
  const write = async (path, content) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  await write(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), skillDoc('alpha'))
  await write(join(project, '.dsh', 'skills', 'beta.md'), skillDoc('beta'))
  const scan = () =>
    scanSkills({
      cwd: project,
      dshHome: home,
      agentsHome: agents,
      customDirs: [custom],
      now: () => new Date('2026-11-08T00:00:00.000Z'),
    })
  const find = async (name, source = 'project-dsh') => {
    const result = await scan()
    const instance = result.instances.find((entry) => entry.name === name && entry.source === source)
    assert.ok(instance, `instance ${name}/${source}`)
    return instance
  }
  return { root, project, home, agents, custom, panelHome, write, scan, find }
}

test('toggleSkill flips directory bundles and flat files, refuses bundled', async () => {
  const fx = await fixture()
  try {
    const alpha = await fx.find('alpha')
    assert.deepEqual(toggleTargetPath(alpha), {
      from: join(fx.project, '.dsh', 'skills', 'alpha', 'SKILL.md'),
      to: join(fx.project, '.dsh', 'skills', 'alpha', 'SKILL.md.disabled'),
      newStatus: 'disabled',
    })
    const disabled = await toggleSkill(alpha)
    assert.equal(disabled.ok, true)
    assert.equal(disabled.newStatus, 'disabled')
    let now = await fx.find('alpha')
    assert.equal(now.status, 'disabled')
    const enabled = await toggleSkill(now)
    assert.equal(enabled.ok, true)
    assert.equal((await fx.find('alpha')).status, 'enabled')

    const beta = await fx.find('beta')
    assert.equal((await toggleSkill(beta)).ok, true)
    assert.equal((await fx.find('beta')).status, 'disabled')

    const bundled = { ...beta, source: 'bundled', id: 'bundled:beta' }
    const refused = await toggleSkill(bundled)
    assert.equal(refused.ok, false)
    assert.match(refused.error, /只读/)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('toggleSkill refuses when the target file already exists', async () => {
  const fx = await fixture()
  try {
    await fx.write(join(fx.project, '.dsh', 'skills', 'alpha', 'SKILL.md.disabled'), skillDoc('alpha'))
    const alpha = await fx.find('alpha')
    const result = await toggleSkill(alpha)
    assert.equal(result.ok, false)
    assert.match(result.error, /目标文件已存在/)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('deleteSkills moves entities into a trash batch; undo restores them', async () => {
  const fx = await fixture()
  try {
    const alpha = await fx.find('alpha')
    const beta = await fx.find('beta')
    const result = await deleteSkills([alpha, beta], { panelHome: fx.panelHome })
    assert.equal(result.deleted.length, 2)
    assert.equal(result.failed.length, 0)
    assert.ok(result.batchId)
    await assert.rejects(stat(join(fx.project, '.dsh', 'skills', 'alpha', 'SKILL.md')))
    await assert.rejects(stat(join(fx.project, '.dsh', 'skills', 'beta.md')))
    const manifest = JSON.parse(
      await readFile(join(trashRoot(fx.panelHome), result.batchId, 'manifest.json'), 'utf8'),
    )
    assert.equal(manifest.entries.length, 2)

    const batches = await listTrash(fx.panelHome)
    assert.equal(batches.length, 1)
    assert.equal(batches[0].batchId, result.batchId)

    const undone = await undoTrash(fx.panelHome)
    assert.deepEqual(undone.restored.sort(), ['alpha', 'beta'])
    assert.equal(undone.conflicts.length, 0)
    assert.ok(await stat(join(fx.project, '.dsh', 'skills', 'alpha', 'SKILL.md')))
    assert.ok(await stat(join(fx.project, '.dsh', 'skills', 'beta.md')))
    assert.deepEqual(await listTrash(fx.panelHome), [])
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('undoTrash reports conflicts and keeps the conflicting entry in the trash', async () => {
  const fx = await fixture()
  try {
    const alpha = await fx.find('alpha')
    const deleted = await deleteSkills([alpha], { panelHome: fx.panelHome })
    await fx.write(join(fx.project, '.dsh', 'skills', 'alpha', 'SKILL.md'), skillDoc('alpha'))
    const undone = await undoTrash(fx.panelHome)
    assert.equal(undone.restored.length, 0)
    assert.equal(undone.conflicts.length, 1)
    const batches = await listTrash(fx.panelHome)
    assert.equal(batches.length, 1)
    assert.equal(batches[0].entries.length, 1)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('deleteSkills refuses bundled skills and reports the rest', async () => {
  const fx = await fixture()
  try {
    const alpha = await fx.find('alpha')
    const bundled = { ...alpha, id: 'bundled:x', source: 'bundled' }
    const result = await deleteSkills([bundled, alpha], { panelHome: fx.panelHome })
    assert.equal(result.deleted.length, 1)
    assert.equal(result.failed.length, 1)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('cleanupTrash drops old batches and excess batches', async () => {
  const fx = await fixture()
  try {
    const alpha = await fx.find('alpha')
    const beta = await fx.find('beta')
    const first = await deleteSkills([alpha], { panelHome: fx.panelHome, now: () => new Date('2026-01-01T00:00:00.000Z') })
    const second = await deleteSkills([beta], { panelHome: fx.panelHome, now: () => new Date('2026-01-02T00:00:00.000Z') })
    assert.ok(first.batchId && second.batchId)
    // Make both batches old, then retention should drop them.
    const old = new Date('2026-01-01T00:00:00.000Z')
    await utimes(join(trashRoot(fx.panelHome), first.batchId), old, old)
    await utimes(join(trashRoot(fx.panelHome), second.batchId), old, old)
    const removedOld = await cleanupTrash(fx.panelHome, {
      retentionDays: 7,
      maxBatches: 100,
      now: () => new Date('2026-11-08T00:00:00.000Z'),
    })
    assert.equal(removedOld, 2)
    assert.deepEqual(await listTrash(fx.panelHome), [])

    await fx.write(join(fx.project, '.dsh', 'skills', 'alpha', 'SKILL.md'), skillDoc('alpha'))
    const third = await deleteSkills([await fx.find('alpha')], { panelHome: fx.panelHome })
    assert.ok(third.batchId)
    const removedExcess = await cleanupTrash(fx.panelHome, { retentionDays: 90, maxBatches: 0 })
    assert.equal(removedExcess, 1)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('addSkill imports flat files and directory bundles into the target root', async () => {
  const fx = await fixture()
  try {
    const sourceFile = join(fx.root, 'incoming', 'gamma.md')
    await fx.write(sourceFile, skillDoc('gamma', 'flat import'))
    const fileResult = await addSkill({ sourcePath: sourceFile, targetRoot: fx.custom })
    assert.equal(fileResult.ok, true, fileResult.error)
    assert.equal(fileResult.form, 'file')
    assert.equal(fileResult.destPath, join(fx.custom, 'gamma.md'))
    assert.ok(await stat(join(fx.custom, 'gamma.md')))

    const sourceDir = join(fx.root, 'incoming-dir', 'bundle-dir')
    await fx.write(join(sourceDir, 'SKILL.md'), skillDoc('delta', 'dir import'))
    await fx.write(join(sourceDir, 'references', 'notes.md'), 'notes')
    const dirResult = await addSkill({ sourcePath: sourceDir, targetRoot: fx.custom })
    assert.equal(dirResult.ok, true, dirResult.error)
    assert.equal(dirResult.form, 'directory')
    assert.equal(dirResult.destPath, join(fx.custom, 'delta'))
    assert.deepEqual(dirResult.warnings?.[0]?.includes('目录名'), true)

    const scanned = await fx.scan()
    const names = scanned.instances.filter((entry) => entry.source === 'custom').map((entry) => entry.name)
    assert.deepEqual(names.sort(), ['delta', 'gamma'])
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('addSkill validates frontmatter, duplicates, paths and size limits', async () => {
  const fx = await fixture()
  try {
    const invalid = join(fx.root, 'bad.md')
    await fx.write(invalid, '---\nname: bad\n---\nbody')
    assert.equal((await addSkill({ sourcePath: invalid, targetRoot: fx.custom })).ok, false)

    const duplicate = join(fx.root, 'alpha-copy.md')
    await fx.write(duplicate, skillDoc('alpha'))
    const dupResult = await addSkill({ sourcePath: duplicate, targetRoot: fx.custom })
    // custom root is empty; duplicate appears after first import
    assert.equal(dupResult.ok, true, dupResult.error)
    const again = await addSkill({ sourcePath: duplicate, targetRoot: fx.custom })
    assert.equal(again.ok, false)
    assert.match(again.error, /已存在同名技能/)

    const relative = await addSkill({ sourcePath: 'relative/path.md', targetRoot: fx.custom })
    assert.equal(relative.ok, false)
    assert.match(relative.error, /绝对路径/)

    const huge = join(fx.root, 'huge.md')
    await fx.write(huge, `---\nname: huge\ndescription: d\n---\n${'x'.repeat(1024 * 1024 + 10)}`)
    const hugeResult = await addSkill({ sourcePath: huge, targetRoot: fx.custom })
    assert.equal(hugeResult.ok, false)
    assert.match(hugeResult.error, /1 MiB/)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})
