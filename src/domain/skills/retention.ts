/** Plan, audit and apply retention only to verified skill trash batches. */
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { trashRoot } from '../store.js'
import { withPatchLock } from '../mcp/write.js'
import { readTrashBatch, type TrashBatch } from './trash-manifest.js'
import { assertTrashDirectory, cleanupPendingDir, cleanupPendingPath, cleanupRecordPath, withSkillTrashLock } from './trash-lock.js'

export interface TrashRetentionBatch { batchId: string; createdAt: string; entries: number; token: string; reason?: 'expired' | 'excess' }
export interface TrashRetentionNotice { batchId: string; reason: string }
export interface TrashCleanupPlan {
  plannedAt: string
  retentionDays: number
  maxBatches: number
  normal: TrashRetentionBatch[]
  candidates: TrashRetentionBatch[]
  protected: TrashRetentionNotice[]
  pendingRecords: string[]
  warnings: string[]
}
export interface TrashCleanupReport {
  version: 1
  trigger: string
  phase: 'planned' | 'finished' | 'blocked'
  plan: TrashCleanupPlan
  removed: string[]
  skipped: TrashRetentionNotice[]
  failed: TrashRetentionNotice[]
  recordPath: string
  remainingNormal?: number
  remainingProtected?: number
}
export interface TrashCleanupOptions {
  retentionDays?: number
  maxBatches?: number
  now?: () => Date
  trigger?: string
  disabledReason?: string
  cancelled?: () => boolean
  onPlanned?: (report: TrashCleanupReport) => Promise<void>
  policyUnchanged?: () => Promise<boolean>
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

/** Payload roots can contain links/assets; namespace and flat wrappers cannot contain unknown siblings. */
async function batchToken(home: string, batch: TrashBatch): Promise<string> {
  const dir = join(trashRoot(home), batch.batchId), info = await lstat(dir)
  const scopes = new Map<string, Map<string, Set<string> | undefined>>()
  const payloads: unknown[] = []
  for (const entry of batch.entries) {
    if (entry.recoveryPending || entry.recoveryDirection !== undefined || entry.recoveryBackupPath !== undefined || entry.recoveryDestination !== undefined) throw new Error('待恢复记录，保留')
    if (entry.source === 'bundled' || entry.scopeKey !== entry.scope || entry.name.length === 0 ||
      !isAbsolute(entry.rootPath) || dirname(entry.entityPath) !== entry.rootPath || entry.entityPath.split(sep).includes('.system')) throw new Error('技能身份或根路径不可信，保留')
    if (entry.form === 'directory' ? dirname(entry.originalPath) !== entry.entityPath || !['SKILL.md', 'SKILL.md.disabled'].includes(basename(entry.originalPath))
      : entry.originalPath !== entry.entityPath || !/\.md(?:\.disabled)?$/u.test(entry.entityPath)) throw new Error('技能文件身份不可信，保留')
    const rel = relative(dir, entry.trashPath), parts = rel.split(sep)
    if (!isAbsolute(entry.trashPath) || isAbsolute(rel) || parts[0] !== entry.scope || parts.includes('..') || parts.includes('.system') ||
      parts.length !== (entry.form === 'directory' ? 2 : 3) || (entry.form === 'file' && parts[2] !== basename(entry.originalPath))) throw new Error('实体不属于当前回收站批次，保留')
    const scope = scopes.get(entry.scope) ?? new Map<string, Set<string> | undefined>()
    scope.set(parts[1]!, entry.form === 'directory' ? undefined : new Set([parts[2]!]))
    scopes.set(entry.scope, scope)
    const payload = await lstat(entry.trashPath)
    if (!payload.isSymbolicLink() && !(entry.form === 'directory' ? payload.isDirectory() : payload.isFile())) throw new Error('实体缺失或类型变化，保留')
    payloads.push([entry.trashPath, payload.dev, payload.ino, payload.mode, payload.size, payload.mtimeMs, payload.ctimeMs])
  }
  for (const name of await readdir(dir)) {
    if (name === 'manifest.json') continue
    if (name === 'manifest.json.panel.lock') {
      if (!(await lstat(join(dir, name))).isFile()) throw new Error('批次锁不是普通文件，保留')
      continue
    }
    if (!scopes.has(name)) throw new Error(`存在未登记内容 ${name}，保留`)
  }
  for (const [scope, entities] of scopes) {
    const scopeDir = join(dir, scope)
    if (!(await lstat(scopeDir)).isDirectory()) throw new Error('作用域目录为链接或类型异常，保留')
    for (const name of await readdir(scopeDir)) if (!entities.has(name)) throw new Error(`存在未登记实体 ${name}，保留`)
    for (const [name, files] of entities) {
      if (files === undefined) continue
      const wrapper = join(scopeDir, name)
      if (!(await lstat(wrapper)).isDirectory()) throw new Error('平铺文件容器为链接，保留')
      for (const file of await readdir(wrapper)) if (!files.has(file)) throw new Error(`存在未登记文件 ${file}，保留`)
    }
  }
  const manifest = await readFile(join(dir, 'manifest.json')), manifestInfo = await lstat(join(dir, 'manifest.json'))
  return hash(JSON.stringify([info.dev, info.ino, manifestInfo.dev, manifestInfo.ino, hash(manifest), payloads]))
}

export async function inspectTrashCleanup(home: string, options: TrashCleanupOptions = {}): Promise<TrashCleanupPlan> {
  home = resolve(home)
  const now = options.now?.() ?? new Date(), days = options.retentionDays ?? 7, max = options.maxBatches ?? 100
  if (!Number.isFinite(days) || days < 0 || !Number.isInteger(max) || max < 0) throw new Error('回收站保留策略无效')
  const plan: TrashCleanupPlan = { plannedAt: now.toISOString(), retentionDays: days, maxBatches: max, normal: [], candidates: [], protected: [], pendingRecords: [], warnings: [] }
  try {
    await assertTrashDirectory(home)
    if (await exists(cleanupPendingDir(home))) {
      await assertTrashDirectory(cleanupPendingDir(home))
      plan.pendingRecords = (await readdir(cleanupPendingDir(home))).sort()
    }
    const root = trashRoot(home)
    if (!await exists(root)) return plan
    if (!(await lstat(root)).isDirectory()) { plan.warnings.push('回收站根为链接或非目录，未清理'); return plan }
    for (const name of (await readdir(root)).sort()) {
      try {
        if (!/^\d{8}T\d{6}Z-[a-z0-9]{1,6}$/u.test(name)) throw new Error(name === 'mcp' ? 'MCP 命名空间，保留' : '未知或独立命名空间，保留')
        if (await exists(cleanupPendingPath(home, name))) throw new Error('清理中断标记存在，保留并检查')
        const batch = await readTrashBatch(home, name)
        const date = new Date(batch.createdAt)
        if (stamp(date) !== name.split('-')[0] || date.getTime() > now.getTime()) throw new Error('删除时间与批次身份不符或位于未来，保留')
        plan.normal.push({ batchId: name, createdAt: batch.createdAt, entries: batch.entries.length, token: await batchToken(home, batch) })
      } catch (error) { plan.protected.push({ batchId: name, reason: errorText(error) }) }
    }
    plan.normal.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.batchId.localeCompare(a.batchId))
    plan.normal.forEach((batch, index) => {
      const expired = now.getTime() - Date.parse(batch.createdAt) >= days * 86400000
      if (expired || index >= max) plan.candidates.push({ ...batch, reason: expired ? 'expired' : 'excess' })
    })
    plan.candidates.reverse() // Oldest first; count and time refer to deletion timestamps, never mtime.
  } catch (error) { plan.warnings.push(errorText(error)) }
  return plan
}

async function readReport(home: string): Promise<TrashCleanupReport | undefined> {
  const path = cleanupRecordPath(home)
  if (!await exists(path)) return undefined
  if (!(await lstat(path)).isFile()) throw new Error(`清理记录不是普通文件，保留原文：${path}`)
  let value: Partial<TrashCleanupReport>
  try { value = JSON.parse(await readFile(path, 'utf8')) as Partial<TrashCleanupReport> }
  catch { throw new Error(`清理记录 JSON 损坏，原文保留：${path}`) }
  const notices = (items: unknown): boolean => Array.isArray(items) && items.every(item => item !== null && typeof item === 'object' && typeof item.batchId === 'string' && typeof item.reason === 'string')
  if (value === null || value.version !== 1 || !['planned', 'finished', 'blocked'].includes(value.phase ?? '') || typeof value.trigger !== 'string' || typeof value.recordPath !== 'string' ||
    !value.plan || typeof value.plan.plannedAt !== 'string' || !Number.isFinite(value.plan.retentionDays) || !Number.isInteger(value.plan.maxBatches) ||
    !Array.isArray(value.plan.normal) || !Array.isArray(value.plan.candidates) ||
    ![...value.plan.normal, ...value.plan.candidates].every(item => item && typeof item.batchId === 'string' && typeof item.createdAt === 'string' && typeof item.token === 'string' && typeof item.entries === 'number') ||
    !notices(value.plan.protected) || !Array.isArray(value.plan.pendingRecords) || !value.plan.pendingRecords.every(item => typeof item === 'string') ||
    !Array.isArray(value.plan.warnings) || !value.plan.warnings.every(item => typeof item === 'string') ||
    !Array.isArray(value.removed) || !value.removed.every(item => typeof item === 'string') || !notices(value.skipped) || !notices(value.failed)) throw new Error(`清理记录损坏或版本不支持，未覆盖：${path}`)
  return value as TrashCleanupReport
}

async function saveReport(home: string, report: TrashCleanupReport): Promise<void> {
  await readReport(home) // Preserve unknown versions, corrupt files and links instead of replacing them.
  const temp = `${cleanupRecordPath(home)}.tmp-${randomUUID()}`
  try {
    await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, cleanupRecordPath(home))
  } finally { await rm(temp, { force: true }).catch(() => undefined) }
}

export async function runTrashCleanup(home: string, options: TrashCleanupOptions = {}): Promise<{ report: TrashCleanupReport; previous?: TrashCleanupReport }> {
  home = resolve(home)
  const empty: TrashCleanupPlan = { plannedAt: new Date().toISOString(), retentionDays: options.retentionDays ?? 7, maxBatches: options.maxBatches ?? 100,
    normal: [], candidates: [], protected: [], pendingRecords: [], warnings: [] }
  const report: TrashCleanupReport = { version: 1, trigger: options.trigger ?? 'manual-api', phase: 'planned', plan: empty, removed: [], skipped: [], failed: [], recordPath: cleanupRecordPath(home) }
  let previous: TrashCleanupReport | undefined
  try {
    return await withSkillTrashLock(home, async () => {
      report.plan = await inspectTrashCleanup(home, options)
      previous = await readReport(home)
      if (options.disabledReason || report.plan.warnings.length) throw new Error(options.disabledReason ?? report.plan.warnings.join('；'))
      if (options.policyUnchanged && !await options.policyUnchanged()) throw new Error('插件配置已变化，未开始清理')
      if (report.plan.candidates.length === 0) {
        report.phase = 'finished'; report.remainingNormal = report.plan.normal.length; report.remainingProtected = report.plan.protected.length
        return { report, previous }
      }
      await saveReport(home, report) // Durable pre-removal snapshot, before any destructive work.
      await options.onPlanned?.(report)
      const freshPlan = await inspectTrashCleanup(home, options)
      const eligible = new Map(freshPlan.candidates.map(item => [item.batchId, item]))
      for (const candidate of report.plan.candidates) {
        if (options.cancelled?.()) { report.skipped.push({ batchId: candidate.batchId, reason: '面板已卸载，未开始清理' }); continue }
        const dir = join(trashRoot(home), candidate.batchId), marker = cleanupPendingPath(home, candidate.batchId)
        try {
          await withPatchLock(join(dir, 'manifest.json'), async () => {
            if (options.policyUnchanged && !await options.policyUnchanged()) { report.skipped.push({ batchId: candidate.batchId, reason: '插件配置已变化，保留' }); return }
            const current = eligible.get(candidate.batchId)
            // Root lock freezes cooperating writers. Recheck only this batch
            // under its lock, avoiding a quadratic rescan of the entire trash.
            if (!current || current.token !== candidate.token || await batchToken(home, await readTrashBatch(home, candidate.batchId)) !== candidate.token) {
              report.skipped.push({ batchId: candidate.batchId, reason: '计划后身份/内容/策略已变化，保留' }); return
            }
            await assertTrashDirectory(cleanupPendingDir(home))
            await mkdir(cleanupPendingDir(home), { recursive: true, mode: 0o700 })
            const intent = `${JSON.stringify({ version: 1, batchId: candidate.batchId, plannedAt: report.plan.plannedAt, reason: candidate.reason, token: candidate.token })}\n`
            await writeFile(marker, intent, { flag: 'wx', mode: 0o600 })
            if (options.cancelled?.() || (options.policyUnchanged && !await options.policyUnchanged())) { await rm(marker); report.skipped.push({ batchId: candidate.batchId, reason: '面板已卸载或配置已变化，未开始清理' }); return }
            await rm(dir, { recursive: true })
            report.removed.push(candidate.batchId)
            // Only our exact intent is disposable; unexpected metadata remains available.
            if (await readFile(marker, 'utf8') !== intent) throw new Error(`清理标记已变化，保留：${marker}`)
            await rm(marker)
          }, { resourceName: '技能清理批次' })
        } catch (error) { report.failed.push({ batchId: candidate.batchId, reason: errorText(error) }) }
      }
      report.phase = 'finished'
      const remaining = await inspectTrashCleanup(home, options)
      report.remainingNormal = remaining.normal.length
      report.remainingProtected = remaining.protected.length
      try { await saveReport(home, report) } catch (error) { report.failed.push({ batchId: '(清理记录)', reason: `执行结果未能持久化：${errorText(error)}` }) }
      return { report, previous }
    })
  } catch (error) {
    report.phase = 'blocked'
    report.plan.warnings.push(errorText(error))
    return { report, previous }
  }
}

/** Backward-compatible count API; callers needing failures/preview should use runTrashCleanup. */
export async function cleanupTrash(home: string, options: TrashCleanupOptions = {}): Promise<number> {
  return (await runTrashCleanup(home, options)).report.removed.length
}
