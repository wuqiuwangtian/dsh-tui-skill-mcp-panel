import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/audit-mcp-backups.mjs', import.meta.url))
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 })

test('inventory counts unique backup paths across profiles and reports incomplete references', async t => {
  const home = await mkdtemp(join(tmpdir(), 'backup-inventory-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const source = 'fixture-private-header-value\n'
  const fingerprint = createHash('sha256').update('file\0' + source).digest('hex')
  const backupPath = () => join(home, 'backups', '123-' + randomUUID(), 'cordis.patch.yml')
  const perFile = async (path, content) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  const batch = async (path, profile = 'a', expected = fingerprint) => {
    const batchId = randomUUID()
    const journal = join(home, 'trash/mcp', batchId, 'manifest.json')
    await perFile(journal, JSON.stringify({ version: 1, batchId, patchPath: join(home, profile),
      backupPath: path, beforeFingerprint: expected, removed: source }))
    return journal
  }
  const referenced = backupPath(), extra = backupPath()
  await perFile(referenced, source)
  await perFile(extra, source)
  await batch(referenced)
  const journal = await batch(referenced, 'b')
  const before = await readFile(journal)
  await perFile(join(home, 'backups/skill-groups/sample/groups.json'), source)
  const clean = run(home)
  assert.equal(clean.status, 0, clean.stderr)
  const ok = JSON.parse(clean.stdout)
  assert.equal(ok.yamlBackups, 2)
  assert.equal(ok.yamlBytes, 2 * Buffer.byteLength(source))
  assert.equal(ok.profilesWithReadableReferences, 2)
  assert.equal(ok.distinctReferencedPaths, 1)
  assert.equal(ok.matchingSourceRecords, 2)
  assert.equal(ok.withoutKnownReference, 1)
  assert.equal(ok.withoutKnownReferenceBytes, Buffer.byteLength(source))
  await batch(backupPath())
  await batch(extra, 'c', '0'.repeat(64))
  await perFile(join(home, 'trash/mcp', randomUUID(), 'manifest.json'), '{broken')
  const linked = backupPath()
  await mkdir(dirname(linked), { recursive: true })
  await symlink(referenced, linked)
  await batch(linked)
  await mkdir(join(home, 'backups/unrecognized-private-name'))
  const bad = run(home)
  assert.equal(bad.status, 2, bad.stderr)
  const report = JSON.parse(bad.stdout)
  assert.deepEqual(report.issues.map(row => row.issue).sort(),
    ['changed-source', 'missing-source', 'unknown-backup-entry', 'unknown-journal', 'unreadable-backup', 'unreadable-source'])
  assert.equal(report.unknownBackupEntries, 2)
  assert.equal(report.unknownJournalEntries, 1)
  assert.equal(report.matchingSourceRecords, 2)
  assert.deepEqual(await readFile(journal), before)
  assert.equal(await readFile(referenced, 'utf8'), source)
  for (const output of [clean.stdout, bad.stdout]) {
    assert.ok(!output.includes(home))
    assert.ok(!output.includes('fixture-private-header-value'))
  }
})

test('inventory requires an explicit panel root and refuses a linked trash directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'backup-inventory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const args of [[], ['.'], [root]]) assert.equal(run(...args).status, 1)
  const target = join(root, 'elsewhere')
  await mkdir(target)
  await symlink(target, join(root, 'trash'))
  assert.equal(run(root).status, 1)
})
