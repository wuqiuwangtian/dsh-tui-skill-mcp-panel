/** Actual tgz + DSH CLI fixture. Reuses an installed host, never a source-linked panel. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expectedFiles, parsePackReport, validatePackList } from './release/tarball.mjs'

const hostDir = process.argv[2]
assert.ok(hostDir, 'usage: node scripts/prepare-install-probe.mjs <CLI-installed dsh-tui directory>')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/prepare-tui-probe.mjs'), resolve(hostDir)], { encoding: 'utf8' }))
const { root, profile } = fixture
const cli = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const cliRequire = createRequire(cli)
const baseDir = dirname(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))
const cordisDir = dirname(cliRequire.resolve('@deepseek-ai/cordis/package.json'))
const host = JSON.parse(await readFile(join(hostDir, 'package.json'), 'utf8'))
assert.equal(host.version, '0.19.0', 'observer is pinned to host 0.19.0 internals')
// Keep the already-installed host and kernel read-only. Only the panel and its
// package dependencies are installed by the real CLI into this temporary profile.
await rm(join(profile, 'node_modules/dsh-tui-skill-mcp-panel'))
const pkgPath = join(profile, 'package.json')
const profilePkg = JSON.parse(await readFile(pkgPath, 'utf8'))
profilePkg.dependencies = {
  '@deepseek-ai/dsh-base': `link:${baseDir}`,
  '@deepseek-ai/cordis': `link:${cordisDir}`,
  '@deepseek-harness-tui/dsh-tui': `link:${resolve(hostDir)}`,
}
profilePkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']
await writeFile(pkgPath, JSON.stringify(profilePkg, null, 2) + '\n')
const disabledSkill = join(fixture.project, '.dsh/skills/retained-disabled')
await mkdir(disabledSkill, { recursive: true })
await writeFile(join(disabledSkill, 'SKILL.md.disabled'), '---\nname: retained-disabled\ndescription: State retained across panel uninstall\n---\nRetain these exact bytes.\n')
const groupsDir = join(root, 'dsh/skills/.system/skill-viewer')
await mkdir(groupsDir, { recursive: true })
await writeFile(join(groupsDir, 'groups.json'), JSON.stringify({ version: 1, groups: { retained: { name: 'Retained group', scopes: { global: [] } } } }, null, 2) + '\n')
const pack = parsePackReport(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: repo, encoding: 'utf8' }))
validatePackList(pack, await expectedFiles(repo), JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')))
const archive = join(root, pack.filename)
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
// No observer imports/executes the panel. The observer lives outside the npm
// artifact and only records global registrations, loader state and package lists.
const observer = join(root, 'observer.mjs')
await writeFile(observer, `import fs from 'node:fs'
import { getHostSceneRuntime } from ${JSON.stringify(pathToFileURL(join(resolve(hostDir), 'lib/types/dsh-adapter/scenes.js')).href)}
export const name = 'package-lifecycle-observer'
export function apply(ctx) {
  const output = ${JSON.stringify(join(root, 'lifecycle.json'))}
  const agentKey = {}
  let last = ''
  const take = () => {
    try {
      const scenes = ctx.get('tuiScenes', false)
      const commands = ctx.get('commands', false)
      const loader = ctx.get('loader', false)
      const value = {
        pid: process.pid,
        servicesReady: Boolean(scenes && commands && loader),
        command: commands?.find(agentKey, 'skill-mcp') !== undefined,
        scenes: scenes ? getHostSceneRuntime(scenes)?.list().map(s => s.id) : [],
        active: scenes?.active?.id,
        rows: loader ? [...loader.entries()].filter(e => e.options?.id === 'skill-mcp-panel').map(e => ({ id:e.options.id, disabled:e.disabled, optionDisabled:e.options.disabled, state:e.fiber?.state })) : [],
      }
      const next = JSON.stringify(value)
      if (next !== last) { last = next; fs.writeFileSync(output, JSON.stringify({ at:new Date().toISOString(), ...value },null,2)); fs.appendFileSync(${JSON.stringify(join(root, 'lifecycle.jsonl'))}, JSON.stringify({ at:new Date().toISOString(), ...value })+'\\n') }
    } catch (e) { fs.writeFileSync(output, JSON.stringify({ error:String(e) })) }
  }
  ctx.effect(() => { const timer=setInterval(take,250); take(); return () => clearInterval(timer) })
}
`)
const patchPath = join(profile, 'cordis.patch.yml')
await writeFile(patchPath, await readFile(patchPath, 'utf8') + `\n- insert:\n    - id: package-lifecycle-observer\n      name: ${JSON.stringify(observer)}\n`)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const run = await readFile(fixture.launcher, 'utf8')
const finalLine = `exec ${quote(process.execPath)} --import ${quote(join(root, 'test-home.mjs'))} ${quote(cli)} --profile panel-verification "$@"`
assert.ok(run.includes(finalLine), 'known isolated launcher')
const manage = join(root, 'manage.sh')
await writeFile(manage, run.replace(finalLine, `exec ${quote(process.execPath)} --import ${quote(join(root, 'test-home.mjs'))} ${quote(cli)} plugin --profile panel-verification "$@"`))
await chmod(manage, 0o700)
const report = { ...fixture, manage, archive, sha256, fileCount: pack.files.length,
  limits: 'Installed host/kernel reused via link; actual panel tgz and its dependencies use the DSH CLI; not a clean full-host registry install.' }
await writeFile(join(root, 'probe.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
