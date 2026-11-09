import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findProjectRoot, scanSkills } from '../../lib/types/domain/skills/index.js'

const skill = (name, description = `desc of ${name}`, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skill-mcp-panel-'))
  const project = join(root, 'project')
  const home = join(root, 'home')
  const agents = join(root, 'agents')
  const bundled = join(root, 'bundled')
  const custom = join(root, 'custom')
  const write = async (path, content) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, 'sub', 'deep'), { recursive: true })

  // project .dsh/skills
  await write(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), skill('alpha', 'project alpha'))
  await write(join(project, '.dsh', 'skills', 'beta.md'), skill('beta'))
  await write(join(project, '.dsh', 'skills', 'gamma', 'SKILL.md.disabled'), skill('gamma'))
  await write(join(project, '.dsh', 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\nbody')
  await write(join(project, '.dsh', 'skills', 'delta.md.disabled'), skill('delta'))
  await write(join(project, '.dsh', 'skills', 'weird-file.md'), skill('from-frontmatter'))
  await write(join(project, '.dsh', 'skills', 'mismatch-dir', 'SKILL.md'), skill('mismatch-name'))
  await write(join(project, '.dsh', 'skills', '.system', 'hidden', 'SKILL.md'), skill('project-system'))
  await write(join(project, '.dsh', 'skills', 'not-a-skill.txt'), 'ignored')

  // project .agents/skills: same name alpha -> shadowed by project-dsh (rank 100)
  await write(join(project, '.agents', 'skills', 'alpha', 'SKILL.md'), skill('alpha', 'agents alpha'))

  // user root: .system must be skipped entirely
  await write(join(home, 'skills', 'userone', 'SKILL.md'), skill('userone'))
  await write(join(home, 'skills', '.system', 'viewer', 'SKILL.md'), skill('user-system'))

  // user agents root
  await write(join(agents, 'skills', 'agentone.md'), skill('agentone'))

  // bundled root
  await write(join(bundled, 'bundledone', 'SKILL.md'), skill('bundledone'))

  // custom root
  await write(join(custom, 'customone', 'SKILL.md'), skill('customone'))

  const options = {
    cwd: join(project, 'sub', 'deep'),
    dshHome: home,
    agentsHome: agents,
    bundledDir: bundled,
    customDirs: [custom],
    now: () => new Date('2026-11-08T00:00:00.000Z'),
  }
  return { root, project, home, agents, bundled, custom, options }
}

test('scanSkills mirrors kernel roots, forms, statuses and shadowing', async () => {
  const fx = await fixture()
  try {
    const result = await scanSkills(fx.options)
    assert.equal(result.projectRoot, fx.project)
    assert.equal(result.scannedAt, '2026-11-08T00:00:00.000Z')

    const byName = new Map(
      result.instances
        .filter((instance) => instance.name !== 'alpha')
        .map((instance) => [instance.name, instance]),
    )
    // Directory bundle name comes from frontmatter, not the dir name.
    const projectAlpha = result.instances.find(
      (instance) => instance.name === 'alpha' && instance.source === 'project-dsh',
    )
    assert.ok(projectAlpha)
    assert.equal(projectAlpha.effective, true)
    const agentsAlpha = result.instances.find(
      (instance) => instance.name === 'alpha' && instance.source === 'project-agents',
    )
    assert.ok(agentsAlpha)
    assert.equal(agentsAlpha.effective, false)
    assert.equal(agentsAlpha.shadowedBy, projectAlpha.id)

    assert.equal(byName.get('beta')?.form, 'file')
    assert.equal(byName.get('from-frontmatter')?.form, 'file')
    assert.equal(byName.get('gamma')?.status, 'disabled')
    assert.equal(byName.get('delta')?.status, 'disabled')
    assert.equal(byName.get('broken')?.status, 'invalid')
    assert.match(byName.get('broken')?.invalidReason ?? '', /requires name and description/u)
    assert.equal(byName.get('mismatch-name')?.effective, true)

    // .system is skipped only for the user-dsh root; project one-level scan ignores it anyway.
    assert.equal(byName.has('user-system'), false)
    assert.equal(byName.has('project-system'), false)

    assert.equal(byName.get('userone')?.source, 'user-dsh')
    assert.equal(byName.get('agentone')?.source, 'user-agents')
    assert.equal(byName.get('bundledone')?.source, 'bundled')
    assert.equal(byName.get('bundledone')?.rank, 600)
    assert.equal(byName.get('customone')?.source, 'custom')

    const effectiveNames = result.instances
      .filter((instance) => instance.effective)
      .map((instance) => instance.name)
      .sort()
    assert.deepEqual(effectiveNames, ['agentone', 'alpha', 'beta', 'bundledone', 'customone', 'from-frontmatter', 'mismatch-name', 'userone'])

    const sources = new Set(result.instances.map((instance) => instance.source))
    for (const source of ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled']) {
      assert.ok(sources.has(source), source)
    }

    // Rank ordering of roots.
    assert.deepEqual(
      result.roots.map((root) => root.rank),
      [100, 200, 300, 400, 500, 600],
    )
    assert.ok(result.warnings.some((warning) => warning.includes('目录名与 frontmatter name')))
    assert.ok(result.warnings.some((warning) => warning.includes('没有 SKILL.md')) === false)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('missing roots are reported but do not fail the scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-mcp-panel-empty-'))
  try {
    const result = await scanSkills({
      cwd: root,
      dshHome: join(root, 'nohome'),
      agentsHome: join(root, 'noagents'),
      bundledDir: join(root, 'nobundled'),
      now: () => new Date('2026-11-08T00:00:00.000Z'),
    })
    assert.equal(result.projectRoot, root)
    assert.equal(result.instances.length, 0)
    assert.ok(result.roots.every((scanRoot) => scanRoot.exists === false))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findProjectRoot walks up to the nearest .git and falls back to cwd', async () => {
  const fx = await fixture()
  try {
    assert.equal(findProjectRoot(join(fx.project, 'sub', 'deep')), fx.project)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
  const lonely = await mkdtemp(join(tmpdir(), 'skill-mcp-panel-lonely-'))
  try {
    assert.equal(findProjectRoot(join(lonely, 'nested', 'dir')), join(lonely, 'nested', 'dir'))
  } finally {
    await rm(lonely, { recursive: true, force: true })
  }
})
