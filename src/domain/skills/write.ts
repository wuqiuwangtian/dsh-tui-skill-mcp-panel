/**
 * Domain write operations for skills: enable/disable (`.disabled` rename),
 * soft delete to a trash directory (manifest + undo), and add/import from a
 * local path. Pure filesystem work (no Cordis, no React); every mutation
 * re-validates the target immediately before touching disk and returns
 * per-item results so batch callers can report partial success.
 */
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseSkillDocument } from './frontmatter.js'
import { entityExists, moveEntity, MoveRecoveryError } from './move.js'
import type { SkillInstance, SkillStatus } from './types.js'
import { trashRoot } from '../store.js'
import { withPatchLock } from '../mcp/write.js'
import { withSkillTrashLock } from './trash-lock.js'
import { listTrash, readTrashBatch, writeTrashManifest, type TrashBatch, type TrashEntry } from './trash-manifest.js'
export { listTrash, readTrashBatch, writeTrashManifest } from './trash-manifest.js'
export type { TrashBatch, TrashEntry } from './trash-manifest.js'
export { cleanupTrash } from './retention.js'

export interface SkillWriteResult {
  ok: boolean
  error?: string
  from?: string
  to?: string
  newStatus?: SkillStatus
}

export interface DeleteResult {
  batchId?: string
  deleted: string[]
  failed: { id: string; error: string }[]
  batch?: TrashBatch
}

export interface UndoResult {
  batchId?: string
  restored: string[]
  conflicts: string[]
  conflictEntries?: TrashEntry[]
  failed: { id: string; error: string }[]
}

export interface AddSkillResult {
  ok: boolean
  name?: string
  form?: 'directory' | 'file'
  destPath?: string
  error?: string
  warnings?: string[]
}

const MAX_FILES = 200
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_SKILL_MD_BYTES = 1024 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^[.]+$/u, '_')
  return cleaned.length === 0 ? '_' : cleaned.slice(0, 64)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

function compactTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
}

/** Target path for an enable/disable toggle, mirroring the web panel convention. */
export function toggleTargetPath(instance: SkillInstance): { from: string; to: string; newStatus: SkillStatus } | { error: string } {
  if (instance.source === 'bundled') return { error: 'bundled（随包）技能只读，不能启停' }
  if (instance.status === 'invalid') return { error: '技能文件无效，无法启停' }
  const from = instance.skillFile
  if (instance.status === 'enabled') {
    return { from, to: `${from}.disabled`, newStatus: 'disabled' }
  }
  if (!from.endsWith('.disabled')) return { error: '无法识别的停用文件名' }
  return { from, to: from.slice(0, -'.disabled'.length), newStatus: 'enabled' }
}

/** Enable/disable one skill instance (`SKILL.md` ↔ `SKILL.md.disabled`, `<name>.md` ↔ `.md.disabled`). */
export async function toggleSkill(instance: SkillInstance): Promise<SkillWriteResult> {
  const target = toggleTargetPath(instance)
  if ('error' in target) return { ok: false, error: target.error }
  try {
    const raw = await readFile(target.from, 'utf8')
    const parsed = parseSkillDocument(raw)
    if (!parsed.ok) return { ok: false, error: `技能文件无效：${parsed.reason}` }
    if (parsed.frontmatter.name !== instance.name) {
      return { ok: false, error: `技能文件已变化（当前 name=${parsed.frontmatter.name}），请刷新后重试` }
    }
    if (await pathExists(target.to)) return { ok: false, error: `目标文件已存在：${target.to}` }
    await rename(target.from, target.to)
    return { ok: true, from: target.from, to: target.to, newStatus: target.newStatus }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** Move one skill entity into `trash/<batchId>/<scopeKey>/<name>[-n]/`. */
async function moveToTrash(
  instance: SkillInstance,
  batchDir: string,
  entryIndex: number,
  now: Date,
  beforeMove: (entry: TrashEntry) => Promise<void>,
): Promise<TrashEntry> {
  const parsed = parseSkillDocument(await readFile(instance.skillFile, 'utf8'))
  if (instance.status === 'invalid') {
    if (parsed.ok) throw new Error('技能文件已变为有效，请刷新后重试')
  } else {
    if (!parsed.ok) throw new Error(`技能文件已变化：${parsed.reason}，请刷新后重试`)
    if (parsed.frontmatter.name !== instance.name) throw new Error(`技能文件已变化（当前 name=${parsed.frontmatter.name}），请刷新后重试`)
  }
  const scopeKey = instance.scope === 'global' ? 'global' : 'workspace'
  const baseName = sanitizeSegment(instance.name)
  const entityName = entryIndex === 0 ? baseName : `${baseName}-${entryIndex + 1}`
  const entityDir = join(batchDir, scopeKey, entityName)
  const trashPath = instance.form === 'directory' ? entityDir : join(entityDir, basename(instance.skillFile))
  await mkdir(dirname(trashPath), { recursive: true })
  const entry: TrashEntry = {
    entryId: `${now.getTime()}-${entryIndex}`,
    name: instance.name,
    source: instance.source,
    scope: instance.scope,
    scopeKey,
    form: instance.form,
    rootPath: instance.rootPath,
    originalPath: instance.skillFile,
    entityPath: instance.form === 'directory' ? instance.locatorDir : instance.skillFile,
    trashPath,
  }
  // Persist recovery metadata before moving anything away from its source.
  await beforeMove(entry)
  await moveEntity(entry.entityPath, trashPath)
  return entry
}

/** Soft-delete skills into a timestamped trash batch with a manifest. */
export async function deleteSkills(
  instances: SkillInstance[],
  options: { panelHome: string; now?: () => Date },
): Promise<DeleteResult> {
  options = { ...options, panelHome: resolve(options.panelHome) }
  return withSkillTrashLock(options.panelHome, () => deleteSkillsUnlocked(instances, options))
}

async function deleteSkillsUnlocked(instances: SkillInstance[], options: { panelHome: string; now?: () => Date }): Promise<DeleteResult> {
  const now = options.now?.() ?? new Date()
  const batchId = `${compactTimestamp(now)}-${randomSuffix()}`
  const batchDir = join(trashRoot(options.panelHome), batchId)
  const deleted: string[] = []
  const failed: { id: string; error: string }[] = []
  const entries: TrashEntry[] = []
  let ownsBatch = false
  let index = 0
  for (const instance of instances) {
    let pending: TrashEntry | undefined
    if (instance.source === 'bundled') {
      failed.push({ id: instance.id, error: 'bundled（随包）技能只读，不能删除' })
      continue
    }
    if (instance.status === 'invalid' && !(await pathExists(instance.skillFile))) {
      failed.push({ id: instance.id, error: '技能文件不存在，可能已被外部修改' })
      continue
    }
    try {
      if (!ownsBatch) {
        await mkdir(trashRoot(options.panelHome), { recursive: true, mode: 0o700 })
        await mkdir(batchDir, { mode: 0o700 })
        ownsBatch = true
      }
      const entry = await moveToTrash(instance, batchDir, index, now, async (next) => {
        pending = { ...next, recoveryPending: true, recoveryDirection: 'delete' }
        await writeTrashManifest(batchDir, { batchId, createdAt: now.toISOString(), entries: [...entries, pending] })
      })
      index += 1
      entries.push(entry)
      deleted.push(instance.id)
    } catch (error) {
      if (error instanceof MoveRecoveryError && pending !== undefined) {
        entries.push(pending)
        index += 1
      }
      failed.push({ id: instance.id, error: errorMessage(error) })
    }
  }
  if (entries.length === 0) {
    if (ownsBatch) await rm(batchDir, { recursive: true, force: true }).catch(() => undefined)
    return { deleted, failed }
  }
  const batch: TrashBatch = { batchId, createdAt: now.toISOString(), entries }
  try {
    await writeTrashManifest(batchDir, batch)
  } catch (error) {
    failed.push({ id: batchId, error: `更新回收站清单失败，已保留写前恢复日志：${errorMessage(error)}` })
  }
  return { batchId, deleted, failed, batch }
}

/** Restore a trash batch (latest when `batchId` is omitted). Conflicts are skipped, not overwritten. */
export async function undoTrash(panelHome: string, batchId?: string): Promise<UndoResult> {
  const batches = await listTrash(panelHome)
  const target = batchId === undefined ? batches[0] : batches.find((batch) => batch.batchId === batchId)
  if (target === undefined) return { restored: [], conflicts: [], failed: [] }
  return withSkillTrashLock(panelHome, () => withPatchLock(join(trashRoot(panelHome), target.batchId, 'manifest.json'), async () => {
    const current = await readTrashBatch(panelHome, target.batchId)
    return undoTrashBatch(panelHome, current)
  }, { resourceName: '技能恢复清单' }))
}

async function undoTrashBatch(panelHome: string, target: TrashBatch | undefined): Promise<UndoResult> {
  const result: UndoResult = { restored: [], conflicts: [], failed: [] }
  if (target === undefined) return result
  result.batchId = target.batchId
  const batchDir = join(trashRoot(panelHome), target.batchId)
  try {
    await writeTrashManifest(batchDir, { ...target, entries: target.entries.map((entry) => ({ ...entry, recoveryPending: true, recoveryDirection: 'restore' })) })
  } catch (error) {
    result.failed.push({ id: target.batchId, error: `写入恢复日志失败，未移动文件：${errorMessage(error)}` })
    return result
  }
  const remaining: TrashEntry[] = []
  for (const entry of target.entries) {
    const destination = entry.form === 'directory' ? entry.entityPath : entry.originalPath
    try {
      if (await entityExists(destination)) {
        result.conflicts.push(`${entry.name}（${destination} 已存在）`)
        result.conflictEntries ??= []
        result.conflictEntries.push(entry)
        remaining.push(entry)
        continue
      }
      if (entry.recoveryPending === true && entry.recoveryDirection === 'restore') {
        throw new Error(`此前撤销中断，回收站实体可能不完整，未自动恢复。请保留并检查原位置 ${destination} 与回收站 ${entry.trashPath}`)
      }
      await mkdir(dirname(destination), { recursive: true })
      await moveEntity(entry.trashPath, destination)
      result.restored.push(entry.name)
    } catch (error) {
      result.failed.push({ id: entry.entryId, error: errorMessage(error) })
      remaining.push(error instanceof MoveRecoveryError ? { ...entry, recoveryPending: true, recoveryDirection: 'restore' } : entry)
    }
  }
  try {
    if (remaining.length === 0) {
      await rm(batchDir, { recursive: true, force: true })
    } else {
      await writeTrashManifest(batchDir, { ...target, entries: remaining })
    }
  } catch (error) {
    result.failed.push({ id: target.batchId, error: `恢复文件已保留，但回收站清单更新失败：${errorMessage(error)}` })
  }
  return result
}

async function existingNamesInRoot(rootPath: string): Promise<Set<string>> {
  const names = new Set<string>()
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (entry.name === '.system') continue
    const full = join(rootPath, entry.name)
    let file: string | undefined
    if (entry.isDirectory()) {
      const enabled = join(full, 'SKILL.md')
      const disabled = join(full, 'SKILL.md.disabled')
      file = (await pathExists(enabled)) ? enabled : (await pathExists(disabled)) ? disabled : undefined
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.md.disabled'))) {
      file = full
    }
    if (file === undefined) continue
    try {
      const parsed = parseSkillDocument(await readFile(file, 'utf8'))
      if (parsed.ok) names.add(parsed.frontmatter.name)
    } catch {
      // ignore unreadable entries
    }
  }
  return names
}

async function directoryStats(path: string): Promise<{ files: number; bytes: number; skillMdBytes: number }> {
  const result = { files: 0, bytes: 0, skillMdBytes: 0 }
  const stack: string[] = [path]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      const info = await lstat(full)
      if (info.isSymbolicLink()) throw new Error('技能目录包含符号链接，已拒绝导入（避免路径逃逸）')
      if (info.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!info.isFile()) throw new Error(`技能目录包含不支持的文件类型：${full}`)
      result.files += 1
      result.bytes += info.size
      if (entry.name === 'SKILL.md') result.skillMdBytes = info.size
      if (result.files > MAX_FILES) throw new Error(`技能文件数超过上限（${MAX_FILES}）`)
      if (result.bytes > MAX_TOTAL_BYTES) throw new Error('技能总大小超过上限（8 MiB）')
      if (result.skillMdBytes > MAX_SKILL_MD_BYTES) throw new Error('SKILL.md 超过 1 MiB 上限')
    }
  }
  return result
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) throw new Error('技能目录包含符号链接，已拒绝导入')
    if (info.isDirectory()) await copyDirectory(from, to)
    else if (info.isFile()) await copyFile(from, to)
    else throw new Error(`不支持的文件类型：${from}`)
  }
}

/** Validate and copy a local skill (`.md` file or directory bundle) into a discovery root. */
export async function addSkill(options: {
  sourcePath: string
  targetRoot: string
  now?: () => Date
}): Promise<AddSkillResult> {
  const warnings: string[] = []
  try {
    if (!isAbsolute(options.sourcePath)) return { ok: false, error: '源路径必须是绝对路径' }
    const source = resolve(options.sourcePath)
    let info
    try {
      info = await lstat(source)
    } catch {
      return { ok: false, error: `源路径不存在：${source}` }
    }
    if (info.isSymbolicLink()) return { ok: false, error: '源路径是符号链接，已拒绝' }

    const root = resolve(options.targetRoot)
    await mkdir(root, { recursive: true })

    let form: 'directory' | 'file'
    let skillMd: string
    let skillSourceDir: string | undefined
    if (info.isDirectory()) {
      form = 'directory'
      skillSourceDir = source
      skillMd = join(source, 'SKILL.md')
      if (!(await pathExists(skillMd))) {
        return { ok: false, error: '目录束缺少顶层 SKILL.md（停用状态的 .disabled 源请先启用）' }
      }
    } else if (info.isFile() && source.endsWith('.md')) {
      form = 'file'
      skillMd = source
    } else {
      return { ok: false, error: '只支持 .md 文件或包含顶层 SKILL.md 的技能目录' }
    }

    const skillInfo = await stat(skillMd)
    if (skillInfo.size > MAX_SKILL_MD_BYTES) return { ok: false, error: 'SKILL.md 超过 1 MiB 上限' }
    const parsed = parseSkillDocument(await readFile(skillMd, 'utf8'))
    if (!parsed.ok) return { ok: false, error: `frontmatter 校验失败：${parsed.reason}` }
    const name = parsed.frontmatter.name
    if (form === 'directory') {
      await directoryStats(source)
      if (basename(source) !== name) {
        warnings.push(`源目录名 "${basename(source)}" 与技能名 "${name}" 不同，导入后目录名将使用技能名`)
      }
    }

    const existing = await existingNamesInRoot(root)
    if (existing.has(name)) return { ok: false, error: `目标作用域已存在同名技能：${name}` }

    const destination = form === 'directory' ? join(root, name) : join(root, `${name}.md`)
    if (await pathExists(destination)) return { ok: false, error: `目标路径已存在：${destination}` }

    const temp = join(root, `.${sanitizeSegment(name)}.tmp-${randomSuffix()}`)
    try {
      if (form === 'directory') await copyDirectory(source, temp)
      else await copyFile(source, temp)
      await rename(temp, destination)
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, error: errorMessage(error) }
    }
    return { ok: true, name, form, destPath: destination, ...(warnings.length > 0 ? { warnings } : {}) }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
