/** Hash retained data and assert real-host registrations for an isolated package probe. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const [probeRoot, phase, expected, compare] = process.argv.slice(2)
assert.ok(probeRoot && /^[a-z0-9-]+$/u.test(phase ?? '') && ['on', 'off', 'removed'].includes(expected),
  'usage: node scripts/install-probe-state.mjs <probe root> <phase> <on|off|removed> [baseline phase]')
const root = await realpath(probeRoot)
assert.ok(basename(root).startsWith('skill-mcp-real-tui-'), 'only an explicitly prepared isolated probe')
const probe = JSON.parse(await readFile(join(root, 'probe.json'), 'utf8'))
assert.equal(root, probe.root)
const pkg = JSON.parse(await readFile(join(probe.profile, 'package.json'), 'utf8'))
const lifecycle = JSON.parse(await readFile(join(root, 'lifecycle.json'), 'utf8'))
assert.equal(lifecycle.error, undefined, 'observer must succeed')
assert.ok(Number.isInteger(lifecycle.pid), 'observer records its real host process')
process.kill(lifecycle.pid, 0) // Read-only liveness check: reject snapshots from an exited host.
assert.equal(lifecycle.servicesReady, true, 'host services must be ready, including when no panel is installed')
assert.equal(lifecycle.command, expected === 'on', 'global command matches activation')
assert.equal(lifecycle.scenes.filter(id => id === 'skill-mcp-panel').length, expected === 'on' ? 1 : 0, 'one or no live scene registration')
assert.equal(lifecycle.rows.length, expected === 'on' ? 1 : 0, 'bundle row is composed only while enabled')
const installed = pkg.dependencies?.['dsh-tui-skill-mcp-panel'] !== undefined
assert.equal(installed, expected !== 'removed', 'package dependency matches removal level')
assert.equal(pkg.dsh.profile.bundles.includes('dsh-tui-skill-mcp-panel'), expected === 'on', 'composition list matches activation')
let installedPath
try { installedPath = await realpath(join(probe.profile, 'node_modules/dsh-tui-skill-mcp-panel')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
}
assert.equal(installedPath !== undefined, installed, 'top-level installed package matches dependency')
if (installedPath) assert.ok(installedPath.startsWith(probe.profile + '/'), 'panel comes from isolated install, never source checkout')
const files = {}
const hashFile = async (path, key) => {
  const bytes = await readFile(path)
  files[key] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const walk = async (path, prefix) => {
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink(), 'retained fixture data must not follow external links')
    if (entry.isDirectory()) await walk(join(path, entry.name), `${prefix}/${entry.name}`)
    else await hashFile(join(path, entry.name), `${prefix}/${entry.name}`)
  }
}
await walk(join(root, 'panel'), 'panel')
await walk(join(probe.project, '.dsh/skills'), 'project-skills')
await hashFile(join(root, 'dsh/skills/.system/skill-viewer/groups.json'), 'shared-skill-groups')
await hashFile(join(root, 'dsh/cordis.patch.yml'), 'home-patch')
await hashFile(join(probe.profile, 'cordis.patch.yml'), 'profile-patch')
assert.ok(Object.keys(files).some(key => key.startsWith('panel/trash/')), 'actual skill deletion has a trash record')
assert.ok(Object.keys(files).some(key => key.startsWith('panel/backups/skill-groups/')), 'actual group edit has a backup')
assert.ok(files['panel/config.json'], 'actual MCP grouping persists private config')
assert.ok(files['project-skills/retained-disabled/SKILL.md.disabled'], 'disabled skill remains disabled')
const snapshotDir = join(root, 'snapshots')
await mkdir(snapshotDir, { recursive: true })
if (compare) {
  assert.ok(/^[a-z0-9-]+$/u.test(compare))
  const baseline = JSON.parse(await readFile(join(snapshotDir, `${compare}.json`), 'utf8'))
  assert.deepEqual(files, baseline.files, 'all retained data must stay byte-identical')
}
const result = { phase, expected, lifecycle, installedPath, installSpec: pkg.dependencies?.['dsh-tui-skill-mcp-panel'],
  bundles: pkg.dsh.profile.bundles, files, comparedWith: compare ?? null }
await writeFile(join(snapshotDir, `${phase}.json`), JSON.stringify(result, null, 2) + '\n')
console.log(`${phase} OK: ${expected}; ${Object.keys(files).length} retained files${compare ? ` identical to ${compare}` : ''}`)
