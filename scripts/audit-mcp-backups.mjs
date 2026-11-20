// Offline, read-only inventory of MCP YAML backups and v1 undo references.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const batchName = new RegExp('^' + uuid + '$', 'u')
const backupName = new RegExp('^[0-9]+-' + uuid + '$', 'u')
const otherNamespaces = new Set(['skill-groups', 'skills', 'mcp-group-repair'])

async function directory(path, optional = false) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('unexpected directory type')
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (optional && error.code === 'ENOENT') return []
    throw error
  }
}

async function readRegular(path, consume) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error('unexpected file type')
    return await consume(file)
  } finally {
    await file.close()
  }
}

async function inventory(home) {
  if (!isAbsolute(home) || await realpath(home) !== resolve(home) || !(await lstat(home)).isDirectory()) {
    throw new Error('expected an absolute physical panel directory')
  }
  const entries = await directory(home)
  if (!entries.some(entry => ['backups', 'trash', 'config.json'].includes(entry.name))) throw new Error('unrecognized panel directory')
  const backupRoot = join(home, 'backups')
  const backups = new Map()
  const references = new Map()
  const issues = []
  let unknownBackups = 0
  let bytes = 0
  for (const entry of await directory(backupRoot, true)) {
    if (otherNamespaces.has(entry.name) && entry.isDirectory()) continue
    if (!backupName.test(entry.name)) {
      unknownBackups++
      issues.push({ issue: 'unknown-backup-entry' })
      continue
    }
    try {
      if (!entry.isDirectory()) throw new Error('not a directory')
      const path = join(backupRoot, entry.name, 'cordis.patch.yml')
      const info = await lstat(path)
      if (!info.isFile()) throw new Error('not a file')
      backups.set(path, info.size)
      bytes += info.size
    } catch {
      unknownBackups++
      issues.push({ backup: entry.name, issue: 'unreadable-backup' })
    }
  }

  const trash = join(home, 'trash')
  const trashEntries = await directory(trash, true)
  const batches = trashEntries.some(entry => entry.name === 'mcp') ? await directory(join(trash, 'mcp')) : []
  const profiles = new Set()
  let unknownRecords = 0
  for (const entry of batches) {
    try {
      if (!batchName.test(entry.name) || !entry.isDirectory()) throw new Error('unknown batch')
      const journal = await readRegular(join(trash, 'mcp', entry.name, 'manifest.json'), file => file.readFile('utf8'))
      const row = JSON.parse(journal)
      if (row?.version !== 1 || row.batchId !== entry.name || !isAbsolute(row.patchPath) ||
          !isAbsolute(row.backupPath) || typeof row.beforeFingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(row.beforeFingerprint)) throw new Error('unknown reference')
      const parts = relative(backupRoot, row.backupPath).split(sep)
      if (parts.length !== 2 || !backupName.test(parts[0]) || parts[1] !== 'cordis.patch.yml') throw new Error('unknown location')
      const path = join(backupRoot, ...parts)
      if (path !== row.backupPath) throw new Error('noncanonical reference')
      profiles.add(row.patchPath)
      const group = references.get(path) ?? []
      group.push({ batch: entry.name, fingerprint: row.beforeFingerprint })
      references.set(path, group)
    } catch {
      unknownRecords++
      issues.push({ ...(batchName.test(entry.name) ? { batch: entry.name } : {}), issue: 'unknown-journal' })
    }
  }

  let matched = 0
  for (const [path, group] of references) {
    let actual
    let issue
    try {
      if (!(await lstat(dirname(path))).isDirectory()) throw new Error('unexpected parent')
      actual = await readRegular(path, async file => {
        const hash = createHash('sha256').update('file\0')
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
        return hash.digest('hex')
      })
    } catch (error) {
      issue = error.code === 'ENOENT' ? 'missing-source' : 'unreadable-source'
    }
    for (const row of group) {
      if (actual === row.fingerprint) matched++
      else issues.push({ batch: row.batch, issue: issue ?? 'changed-source' })
    }
  }
  let withoutKnownReference = 0
  let withoutKnownReferenceBytes = 0
  for (const [path, size] of backups) {
    if (!references.has(path)) { withoutKnownReference++; withoutKnownReferenceBytes += size }
  }
  return { yamlBackups: backups.size, yamlBytes: bytes, unknownBackupEntries: unknownBackups,
    journalEntries: batches.length, profilesWithReadableReferences: profiles.size, unknownJournalEntries: unknownRecords,
    distinctReferencedPaths: references.size, matchingSourceRecords: matched,
    withoutKnownReference, withoutKnownReferenceBytes, issues }
}

try {
  if (process.argv.length !== 3) throw new Error('expected one directory')
  const report = await inventory(process.argv[2])
  console.log(JSON.stringify(report, null, 2))
  if (report.issues.length) process.exitCode = 2
} catch {
  console.error('Cannot complete inventory. Supply one absolute physical panel directory with readable backups and trash directories.')
  process.exitCode = 1
}
