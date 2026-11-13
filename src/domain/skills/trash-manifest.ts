/** Shared private trash schema: strict mutation reads and compatible history listing. */
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { trashRoot } from '../store.js'
import { cleanupPendingPath } from './trash-lock.js'

export interface TrashEntry {
  entryId: string
  name: string
  source: string
  scope: string
  scopeKey: string
  form: 'directory' | 'file'
  rootPath: string
  /** Absolute path the skill occupied (for flat files) or its SKILL.md (for bundles). */
  originalPath: string
  /** Original bundle directory (directory form) or the original file (flat form). */
  entityPath: string
  /** Where the entity lives inside the trash batch. */
  trashPath: string
  /** Keep interrupted moves out of automatic retention until explicitly recovered. */
  recoveryPending?: boolean
  recoveryDirection?: 'delete' | 'restore'
  recoveryBackupPath?: string
  recoveryDestination?: string
}

export interface TrashBatch {
  batchId: string
  createdAt: string
  entries: TrashEntry[]
}

export async function writeTrashManifest(batchDir: string, batch: TrashBatch): Promise<void> {
  const temp = join(batchDir, `manifest.json.tmp-${randomUUID()}`)
  try {
    await writeFile(temp, `${JSON.stringify({ version: 1, ...batch }, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temp, join(batchDir, 'manifest.json'))
  } finally { await rm(temp, { force: true }).catch(() => undefined) }
}

/** Read every trash batch, newest first. Corrupt manifests are skipped. */
export async function listTrash(panelHome: string): Promise<TrashBatch[]> {
  const root = trashRoot(panelHome)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const batches: TrashBatch[] = []
  for (const name of names.sort((left, right) => right.localeCompare(left))) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object') continue
      const record = parsed as Record<string, unknown>
      if (!Array.isArray(record.entries)) continue
      const entries: TrashEntry[] = []
      for (const raw of record.entries) {
        if (raw === null || typeof raw !== 'object') continue
        const entry = raw as Record<string, unknown>
        if (
          typeof entry.entryId !== 'string' ||
          typeof entry.name !== 'string' ||
          typeof entry.form !== 'string' ||
          typeof entry.originalPath !== 'string' ||
          typeof entry.entityPath !== 'string' ||
          typeof entry.trashPath !== 'string'
        ) {
          continue
        }
        entries.push({
          entryId: entry.entryId,
          name: entry.name,
          source: typeof entry.source === 'string' ? entry.source : 'unknown',
          scope: typeof entry.scope === 'string' ? entry.scope : 'unknown',
          scopeKey: typeof entry.scopeKey === 'string' ? entry.scopeKey : 'unknown',
          form: entry.form === 'directory' ? 'directory' : 'file',
          rootPath: typeof entry.rootPath === 'string' ? entry.rootPath : '',
          originalPath: entry.originalPath,
          entityPath: entry.entityPath,
          trashPath: entry.trashPath,
          ...(entry.recoveryPending === true ? { recoveryPending: true } : {}),
          ...(entry.recoveryDirection === 'delete' || entry.recoveryDirection === 'restore' ? { recoveryDirection: entry.recoveryDirection } : {}),
          ...(typeof entry.recoveryBackupPath === 'string' ? { recoveryBackupPath: entry.recoveryBackupPath } : {}),
          ...(typeof entry.recoveryDestination === 'string' ? { recoveryDestination: entry.recoveryDestination } : {}),
        })
      }
      if (entries.length === 0) continue
      batches.push({
        batchId: typeof record.batchId === 'string' ? record.batchId : name,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        entries,
      })
    } catch {
      // corrupt manifest → skip batch (files stay untouched)
    }
  }
  return batches
}

/** Read a mutation-ready v1 batch without discarding unknown metadata or corrupt siblings. */
export async function readTrashBatch(home: string, batchId: string): Promise<TrashBatch> {
  if (!/^\d{8}T\d{6}Z-[a-z0-9]{1,6}$/u.test(batchId)) throw new Error('无效恢复批次')
  const batchDir = join(trashRoot(home), batchId)
  const path = join(batchDir, 'manifest.json')
  try {
    await lstat(cleanupPendingPath(home, batchId))
    throw new Error(`清理中断，实体可能不完整；请保留并检查 ${batchDir} 与 ${cleanupPendingPath(home, batchId)}`)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!(await lstat(trashRoot(home))).isDirectory() || !(await lstat(batchDir)).isDirectory() || !(await lstat(path)).isFile()) throw new Error('回收站和清单必须是普通目录/文件')
  let raw: unknown
  try { raw = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('恢复清单 JSON 损坏，原文保留') }
  if (raw === null || typeof raw !== 'object') throw new Error('恢复清单损坏，原文保留')
  const record = raw as Record<string, unknown>
  if (record.version !== 1 || record.batchId !== batchId || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
    !Array.isArray(record.entries) || record.entries.length === 0) throw new Error('恢复清单版本或结构无效，原文保留')
  const ids = new Set<string>(), trashPaths = new Set<string>(), entityPaths = new Set<string>()
  for (const item of record.entries as unknown[]) {
    if (item === null || typeof item !== 'object') throw new Error('恢复条目损坏，原文保留')
    const entry = item as Record<string, unknown>
    if (!['entryId', 'name', 'source', 'scope', 'scopeKey', 'rootPath', 'originalPath', 'entityPath', 'trashPath'].every(key => typeof entry[key] === 'string') ||
      !['directory', 'file'].includes(String(entry.form)) || !['global', 'workspace'].includes(String(entry.scope)) ||
      (entry.recoveryPending !== undefined && typeof entry.recoveryPending !== 'boolean') ||
      (entry.recoveryDirection !== undefined && !['delete', 'restore'].includes(String(entry.recoveryDirection))) ||
      ['recoveryBackupPath', 'recoveryDestination'].some(key => entry[key] !== undefined && typeof entry[key] !== 'string') ||
      ids.has(String(entry.entryId)) || trashPaths.has(String(entry.trashPath)) || entityPaths.has(String(entry.entityPath))) throw new Error('恢复条目损坏或身份/实体重复，原文保留')
    ids.add(String(entry.entryId))
    trashPaths.add(String(entry.trashPath)); entityPaths.add(String(entry.entityPath))
  }
  // Unlike the permissive history list, mutation must not skip malformed
  // siblings or drop unknown metadata when rewriting a private journal.
  return record as unknown as TrashBatch
}
