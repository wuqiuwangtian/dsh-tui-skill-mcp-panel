/** Exercise the installed web 2.3.7 API only on an isolated temporary DSH home. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GroupsConflictError, loadGroups, saveGroups, setGroupMembership } from '../lib/types/domain/groups.js'

if (!process.argv[2]) throw new Error('usage: node scripts/skill-groups-interop.mjs <installed dsh-skill-mcp-panel package directory>')
const webRoot = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(webRoot, 'package.json'), 'utf8'))
assert.equal(manifest.name, 'dsh-skill-mcp-panel')
assert.equal(manifest.version, '2.3.7', 'review a changed web baseline before claiming interoperability')
const webFile = join(webRoot, 'lib/groups.js')
const web = await import(pathToFileURL(webFile).href)
const root = await mkdtemp(join(tmpdir(), 'skill-groups-web-'))
try {
  const home = join(root, 'dsh')
  const file = web.groupsFile(home)
  const id = await web.upsertGroup(home, undefined, 'Shared', 'global', ['web-a'])
  let loaded = await loadGroups(file)
  const options = { expectedFingerprint: loaded.fingerprint, backupRoot: join(root, 'panel-backups') }
  await saveGroups(file, setGroupMembership(loaded.groups, id, '/fixture-workspace', 'tui-a', true), options)
  assert.deepEqual((await web.loadGroups(home))[id].scopes['/fixture-workspace'], ['tui-a'])

  loaded = await loadGroups(file)
  await web.upsertGroup(home, id, 'Shared', 'global', ['web-a', 'web-b'])
  const external = await readFile(file, 'utf8')
  await assert.rejects(saveGroups(file, setGroupMembership(loaded.groups, id, 'global', 'tui-b', true), {
    ...options, expectedFingerprint: loaded.fingerprint,
  }), GroupsConflictError)
  assert.equal(await readFile(file, 'utf8'), external)
  loaded = await loadGroups(file)
  const saved = await saveGroups(file, setGroupMembership(loaded.groups, id, 'global', 'tui-b', true), {
    ...options, expectedFingerprint: loaded.fingerprint,
  })
  assert.equal(await readFile(saved.backupPath, 'utf8'), external)
  assert.deepEqual((await web.loadGroups(home))[id].scopes.global, ['web-a', 'web-b', 'tui-b'])

  // Verify the limit, rather than claiming a one-sided lock controls web writes:
  // the old web save API can still submit its stale data AFTER the TUI commit.
  const staleWeb = await web.loadGroups(home)
  loaded = await loadGroups(file)
  await saveGroups(file, setGroupMembership(loaded.groups, id, 'global', 'tui-later', true), {
    ...options, expectedFingerprint: loaded.fingerprint,
  })
  await web.saveGroups(home, staleWeb)
  const lateOverwriteObserved = !(await loadGroups(file)).groups[id].scopes.global.includes('tui-later')
  assert.equal(lateOverwriteObserved, true)
  console.log(JSON.stringify({ check: 'skill-groups-web-interop', ok: true, version: manifest.version,
    webGroupsSha256: createHash('sha256').update(await readFile(webFile)).digest('hex'),
    verified: ['v1 format read by both implementations', 'workspace and global members survive sequential changes',
      'stale TUI write after a real web write is refused', 'refresh/retry preserves web members', 'exact prewrite backup'],
    boundary: { lateWebOverwriteObserved: lateOverwriteObserved, fullSimultaneousWebTuiProtection: false,
      reason: 'web 2.3.7 groups.js does not honor groups.json.panel.lock or compare snapshots' },
    isolation: 'all writes and backups under temporary home; no installed package or real ~/.dsh data changed',
  }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
