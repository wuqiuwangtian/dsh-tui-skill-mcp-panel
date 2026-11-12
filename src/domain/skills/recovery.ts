/** Explicit, snapshot-bound recovery choices for a single conflicting skill. */
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { backupsRoot, trashRoot } from '../store.js'
import { withPatchLock } from '../mcp/write.js'
import { parseSkillDocument } from './frontmatter.js'
import { copyEntityVerified, entityExists, entityFingerprint, moveEntity, MoveRecoveryError } from './move.js'
import { readTrashBatch, writeTrashManifest, type TrashBatch, type TrashEntry } from './write.js'

export type SkillRecoveryChoice = { kind: 'replace' } | { kind: 'scope'; scope: 'global' | 'workspace'; rootPath: string }
export interface SkillRecoverySession {
  panelHome: string
  batchId: string
  entry: TrashEntry
  choice: SkillRecoveryChoice
  destination: string
  backupDir?: string
  journalFingerprint: string
  trashFingerprint: string
  destinationFingerprint?: string
  destinationContent?: string
}
export interface SkillRecoveryResult {
  destination: string
  backupPath?: string
  warnings: string[]
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const manifestPath = (home: string, id: string): string => join(trashRoot(home), id, 'manifest.json')

async function directoryChain(path: string): Promise<void> {
  let current = resolve(path)
  while (true) {
    if (basename(current) === '.system') throw new Error('不能恢复到 .system 子树')
    try {
      if (!(await lstat(current)).isDirectory()) throw new Error(`路径必须是普通目录，不能经过符号链接：${current}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

function validateEntry(home: string, batchId: string, entry: TrashEntry): void {
  if (!/^\d{8}T\d{6}Z-[a-z0-9]{1,6}$/u.test(batchId) || entry.source === 'bundled') throw new Error('无效或只读的恢复记录')
  if (entry.recoveryPending) throw new Error(`此记录存在中断恢复状态，请保留并检查 ${entry.trashPath}、${entry.recoveryDestination ?? entry.entityPath}${entry.recoveryBackupPath ? ` 与备份 ${entry.recoveryBackupPath}` : ''}`)
  if (!['global', 'workspace'].includes(entry.scope) || !isAbsolute(entry.rootPath) || !isAbsolute(entry.entityPath)) throw new Error('恢复记录的作用域或根路径无效')
  if (dirname(entry.entityPath) !== entry.rootPath || basename(entry.entityPath) === '.system') throw new Error('恢复实体必须是技能根的直接子项')
  if (entry.form === 'directory' ? dirname(entry.originalPath) !== entry.entityPath || !['SKILL.md', 'SKILL.md.disabled'].includes(basename(entry.originalPath))
    : entry.originalPath !== entry.entityPath || !/\.md(?:\.disabled)?$/u.test(entry.entityPath)) throw new Error('恢复记录的技能文件路径无效')
  const within = relative(join(trashRoot(home), batchId), entry.trashPath)
  if (!isAbsolute(entry.trashPath) || within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('回收站路径超出当前批次')
  const parts = within.split(sep)
  if (parts[0] !== entry.scope || parts.length !== (entry.form === 'directory' ? 2 : 3) ||
    parts[1] === '.system' || (entry.form === 'file' && parts[2] !== basename(entry.originalPath))) throw new Error('回收站实体结构无效')
}

async function readBatch(home: string, batchId: string): Promise<TrashBatch> {
  const path = manifestPath(home, batchId)
  await directoryChain(dirname(path))
  if (!(await lstat(path)).isFile()) throw new Error('恢复清单必须是普通文件')
  return readTrashBatch(home, batchId)
}

async function checkName(root: string, name: string): Promise<void> {
  let entries
  try { entries = await readdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  for (const item of entries) {
    if (item === '.system') continue
    const path = join(root, item), info = await stat(path).catch(() => undefined)
    const candidates = info?.isDirectory() ? [join(path, 'SKILL.md'), join(path, 'SKILL.md.disabled')]
      : /\.md(?:\.disabled)?$/u.test(item) ? [path] : []
    for (const candidate of candidates) {
      let text: string
      try { text = await readFile(candidate, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      const parsed = parseSkillDocument(text)
      if (parsed.ok && parsed.frontmatter.name === name) throw new Error(`目标根已有同名技能 ${name}，未覆盖：${candidate}`)
    }
  }
}

export async function openSkillRecovery(home: string, batchId: string, entryId: string, choice: SkillRecoveryChoice): Promise<SkillRecoverySession> {
  home = resolve(home)
  if (!/^\d{8}T\d{6}Z-[a-z0-9]{1,6}$/u.test(batchId)) throw new Error('无效恢复批次')
  const before = digest(await readFile(manifestPath(home, batchId)))
  const batch = await readBatch(home, batchId)
  const entry = batch.entries.find((item) => item.entryId === entryId)
  if (!entry) throw new Error('恢复条目已变化，请重新按 u')
  validateEntry(home, batchId, entry)
  await directoryChain(entry.rootPath)
  await directoryChain(dirname(entry.trashPath))
  const root = choice.kind === 'scope' ? resolve(choice.rootPath) : entry.rootPath
  if (choice.kind === 'scope' && (choice.scope === entry.scope || root === entry.rootPath)) throw new Error('请选择另一个作用域')
  await directoryChain(root)
  const destination = join(root, basename(entry.entityPath))
  const destinationFingerprint = await entityFingerprint(destination)
  if (choice.kind === 'replace' && destinationFingerprint === undefined) throw new Error('占用对象已消失，请重新按 u 普通恢复')
  if (choice.kind === 'scope') {
    if (destinationFingerprint !== undefined) throw new Error(`目标已存在，未覆盖：${destination}`)
    await checkName(root, entry.name)
  }
  const trashFingerprint = await entityFingerprint(entry.trashPath)
  if (!trashFingerprint) throw new Error('回收站实体不存在，请保留清单并检查数据')
  if (before !== digest(await readFile(manifestPath(home, batchId)))) throw new Error('恢复清单已变化，请重新按 u')
  return { panelHome: home, batchId, entry, choice: choice.kind === 'scope' ? { ...choice, rootPath: root } : choice,
    destination, journalFingerprint: before, trashFingerprint, destinationFingerprint,
    ...(choice.kind === 'replace' ? { destinationContent: await entityFingerprint(destination, false),
      backupDir: join(backupsRoot(home), 'skills', `restore-${Date.now()}-${randomUUID()}`) } : {}),
  }
}

async function validateSession(session: SkillRecoverySession): Promise<TrashBatch> {
  const { panelHome: home, batchId, entry } = session
  validateEntry(home, batchId, entry)
  const batch = await readBatch(home, batchId)
  if (digest(await readFile(manifestPath(home, batchId))) !== session.journalFingerprint ||
    JSON.stringify(batch.entries.find((item) => item.entryId === entry.entryId)) !== JSON.stringify(entry)) throw new Error('恢复清单已变化，请重新按 u')
  await validateEntities(session)
  return batch
}

async function validateEntities(session: SkillRecoverySession): Promise<void> {
  const { entry, destination, choice } = session
  if ((choice.kind === 'replace' && (!session.backupDir || session.destinationFingerprint === undefined || session.destinationContent === undefined)) ||
    (choice.kind === 'scope' && session.backupDir !== undefined)) throw new Error('恢复会话缺少有效备份或目标快照，请重新选择')
  const root = choice.kind === 'scope' ? resolve(choice.rootPath) : entry.rootPath
  if (destination !== join(root, basename(entry.entityPath)) ||
    (choice.kind === 'scope' && (!['global', 'workspace'].includes(choice.scope) || choice.scope === entry.scope || root === entry.rootPath))) throw new Error('恢复目标或作用域已变化，请重新选择')
  await directoryChain(entry.rootPath)
  await directoryChain(dirname(entry.trashPath))
  await directoryChain(dirname(session.destination))
  if (await entityFingerprint(entry.trashPath) !== session.trashFingerprint ||
    await entityFingerprint(session.destination) !== session.destinationFingerprint) throw new Error('恢复源或目标已变化，请重新按 u；未覆盖外部改动')
  if (session.choice.kind === 'scope') await checkName(session.choice.rootPath, entry.name)
}

export async function commitSkillRecovery(session: SkillRecoverySession): Promise<SkillRecoveryResult> {
  validateEntry(session.panelHome, session.batchId, session.entry)
  await directoryChain(dirname(manifestPath(session.panelHome, session.batchId)))
  return withPatchLock(manifestPath(session.panelHome, session.batchId), async () => {
    let batch = await validateSession(session)
    const { entry, destination, backupDir } = session
    const backupPath = backupDir === undefined ? undefined : join(backupDir, 'entity')
    const displaced = backupDir === undefined ? undefined : join(backupDir, 'displaced')
    if (backupDir !== undefined) {
      const expectedParent = join(backupsRoot(session.panelHome), 'skills')
      if (dirname(backupDir) !== expectedParent || !basename(backupDir).startsWith('restore-')) throw new Error('备份路径不属于技能备份目录')
      await directoryChain(expectedParent)
      await mkdir(expectedParent, { recursive: true, mode: 0o700 })
      await mkdir(backupDir, { mode: 0o700 })
      await copyEntityVerified(destination, backupPath!)
      if (await entityFingerprint(backupPath!, false) !== session.destinationContent) throw new Error(`备份校验失败，原对象保留；备份位于 ${backupDir}`)
      await writeFile(join(backupDir, 'manifest.json'), `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), batchId: session.batchId,
        entryId: entry.entryId, originalPath: destination, backupPath, displacedPath: displaced, contentFingerprint: session.destinationContent }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      batch = await validateSession(session)
    }
    const batchDir = dirname(manifestPath(session.panelHome, session.batchId))
    const pending = { ...entry, recoveryPending: true, recoveryDirection: 'restore' as const, recoveryDestination: destination,
      ...(backupDir === undefined ? {} : { recoveryBackupPath: backupDir }) }
    const intent = { ...batch, entries: batch.entries.map((item) => item.entryId === entry.entryId ? pending : item) }
    await writeTrashManifest(batchDir, intent)
    const intentFingerprint = digest(await readFile(manifestPath(session.panelHome, session.batchId)))
    let displacedDone = false
    try {
      await validateEntities(session)
      if (backupPath !== undefined && await entityFingerprint(backupPath, false) !== session.destinationContent) throw new Error(`覆盖前备份已变化，未开始替换：${backupPath}`)
      if (displaced !== undefined) { await moveEntity(destination, displaced); displacedDone = true }
      await mkdir(dirname(destination), { recursive: true })
      await moveEntity(entry.trashPath, destination)
    } catch (error) {
      let rollbackSafe = !(error instanceof MoveRecoveryError)
      if (displacedDone) {
        try {
          if (await entityExists(destination)) throw new Error('恢复位置存在数据，未强制回滚覆盖')
          await moveEntity(displaced!, destination)
        } catch { rollbackSafe = false }
      }
      if (rollbackSafe && digest(await readFile(manifestPath(session.panelHome, session.batchId))) === intentFingerprint) {
        await writeTrashManifest(batchDir, batch).catch(() => undefined)
      }
      throw new Error(`恢复失败：${message(error)}${backupDir ? `；覆盖前备份保留于 ${backupDir}` : ''}。保留回收站，检查后重试`)
    }
    const result: SkillRecoveryResult = { destination, backupPath, warnings: [] }
    try {
      if (digest(await readFile(manifestPath(session.panelHome, session.batchId))) !== intentFingerprint) throw new Error('恢复清单被外部修改')
      const remaining = batch.entries.filter((item) => item.entryId !== entry.entryId)
      if (remaining.length === 0) await rm(batchDir, { recursive: true })
      else await writeTrashManifest(batchDir, { ...batch, entries: remaining })
    } catch (error) { result.warnings.push(`文件已恢复，清单更新失败；保留记录供检查：${message(error)}`) }
    if (displaced !== undefined) {
      try {
        if (await entityFingerprint(backupPath!, false) !== session.destinationContent || await entityFingerprint(displaced, false) !== session.destinationContent) throw new Error('备份或暂存对象发生变化')
        await rm(displaced, { recursive: true })
      } catch (error) { result.warnings.push(`覆盖前暂存保留于 ${displaced}：${message(error)}`) }
    }
    return result
  }, { resourceName: '技能恢复清单' })
}
