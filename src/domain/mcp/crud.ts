/** Guarded CRUD for panel-owned MCP inserts, plus durable deletion recovery. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { addManagedMcp, deleteManagedMcp, editManagedMcp, findManagedMcp } from './managed.js'
import { isRecord, validateMcpConfig, type McpConfig } from './model.js'
import { backupPatchFile, extractManagedBlock, isJsValue, parsePatchText, upsertManagedToggle, writePatchFileAtomic } from './patch.js'
import { PatchConflictError, patchFingerprint, readPatchSnapshot, withPatchLock, type PatchSnapshot } from './write.js'

export interface McpEditSession {
  patchPath: string
  homePatchPath: string
  expectedProfile: string
  expectedHome: string
  id?: string
  serverName?: string
  config: McpConfig
}

type Files = Pick<McpEditSession, 'patchPath' | 'homePatchPath' | 'expectedProfile' | 'expectedHome'>
interface WriteFiles extends Files { backupRoot: string }

async function snapshots(input: Files): Promise<[PatchSnapshot, PatchSnapshot]> {
  const pair = await Promise.all([readPatchSnapshot(input.patchPath), readPatchSnapshot(input.homePatchPath)])
  if (pair[0].fingerprint !== input.expectedProfile || pair[1].fingerprint !== input.expectedHome) throw new PatchConflictError()
  if (pair.some((snapshot) => !parsePatchText(snapshot.text).ok)) throw new Error('profile/home patch YAML 非法，请修复后重试')
  return pair
}

export async function openMcpEditor(input: Files, target?: { id: string; serverName: string }): Promise<McpEditSession> {
  const [profile, home] = await snapshots(input)
  if (target === undefined) return { ...input, config: { serverName: '', transport: 'stdio', command: '', args: [] } }
  if (parsePatchText(home.text).rows.some((row) => row.id === target.id)) throw new Error('home 全局层只读')
  const row = findManagedMcp(profile.text, target.id, target.serverName)
  const disabled = [...parsePatchText(profile.text).rows].reverse().find((entry) => entry.id === target.id && entry.disabled !== undefined)?.disabled
  if (isJsValue(disabled)) throw new Error('disabled 由 !!js 表达式控制，该行只读')
  return { ...input, ...target, config: row.config }
}

interface MutationResult<T> { changed: boolean; backupPath?: string; value: T }
async function transact<T>(
  input: WriteFiles,
  build: (profile: PatchSnapshot, home: PatchSnapshot) => { text: string; value: T },
  journal?: (before: PatchSnapshot, after: string, backupPath: string) => Promise<() => Promise<void>>,
): Promise<MutationResult<T>> {
  await mkdir(dirname(input.patchPath), { recursive: true })
  return withPatchLock(input.patchPath, async () => {
    const [profile, home] = await snapshots(input)
    const info = await lstat(input.patchPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (info !== undefined && !info.isFile()) throw new Error('profile patch 必须是普通文件；符号链接请手工编辑')
    const candidate = build(profile, home)
    if (!parsePatchText(candidate.text).ok) throw new Error('候选 YAML 校验失败，未修改文件')
    if (candidate.text === profile.text) return { changed: false, value: candidate.value }
    const backupDir = join(input.backupRoot, `${Date.now()}-${randomUUID()}`)
    let backupPath: string
    try {
      if (info === undefined) {
        await mkdir(backupDir, { recursive: true, mode: 0o700 })
        backupPath = join(backupDir, 'cordis.patch.yml')
        await writeFile(backupPath, '', { mode: 0o600, flag: 'wx' })
      } else {
        backupPath = await backupPatchFile(input.patchPath, backupDir)
      }
      if (await readFile(backupPath, 'utf8') !== profile.text) throw new PatchConflictError()
    } catch (error) {
      if (error instanceof PatchConflictError) throw error
      throw new Error('MCP 备份失败，已停止写入；请检查目录权限或磁盘空间')
    }
    const rollbackJournal = await journal?.(profile, candidate.text, backupPath)
    try {
      await writePatchFileAtomic(input.patchPath, candidate.text, () => snapshots(input))
    } catch (error) {
      await rollbackJournal?.()
      throw error
    }
    return { changed: true, backupPath, value: candidate.value }
  })
}

function assertUniqueName(profile: string, home: string, config: McpConfig, exceptId?: string, runtimeNames: string[] = []): void {
  validateMcpConfig(config)
  const rows = [...parsePatchText(profile).rows, ...parsePatchText(home).rows]
  if (runtimeNames.includes(config.serverName as string) || rows.some((row) => row.id !== exceptId && row.config?.serverName === config.serverName)) {
    throw new Error('serverName 已存在于 profile/home 或活跃实例中，请使用其他名称')
  }
}

export async function saveMcpEditor(input: {
  session: McpEditSession; config: McpConfig; backupRoot: string; runtimeNames?: string[]; runtimeIds?: string[]
}): Promise<MutationResult<{ id: string; serverName: string }>> {
  return transact({ ...input.session, backupRoot: input.backupRoot }, (profile, home) => {
    assertUniqueName(profile.text, home.text, input.config, input.session.id, input.runtimeNames)
    if (input.session.id !== undefined) {
      const id = input.session.id
      if (parsePatchText(home.text).rows.some((row) => row.id === id)) throw new Error('home 全局层只读')
      const text = editManagedMcp(profile.text, id, input.session.serverName ?? '', input.config)
      return { text, value: { id, serverName: input.config.serverName as string } }
    }
    const ids = new Set([...parsePatchText(profile.text).rows, ...parsePatchText(home.text).rows].map((row) => row.id))
    for (const id of input.runtimeIds ?? []) ids.add(id)
    const prefix = `mcp-${input.config.serverName as string}`
    let id = prefix
    for (let suffix = 2; ids.has(id); suffix++) id = `${prefix}-${suffix}`
    return { text: addManagedMcp(profile.text, id, input.config), value: { id, serverName: input.config.serverName as string } }
  })
}

export interface McpDeletionSummary { batchId: string; createdAt: string; id: string; serverName: string; patchPath: string }
interface DeletionRecord extends McpDeletionSummary {
  version: 1
  homeFingerprint: string
  beforeFingerprint: string
  afterFingerprint: string
  backupPath: string
  removed: string
  offset: number
}

export async function listMcpDeletions(trashDir: string, patchPath: string, reportWarning?: (message: string) => void): Promise<McpDeletionSummary[]> {
  const names = await readdir(trashDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return [] as string[]
  })
  const entries: McpDeletionSummary[] = []
  for (const name of names) {
    if (!/^[0-9a-f-]{36}$/u.test(name)) continue
    try {
      const record = await readDeletion(trashDir, name)
      if (record.patchPath === patchPath) entries.push({ batchId: name, createdAt: record.createdAt, id: record.id, serverName: record.serverName, patchPath })
    } catch {
      reportWarning?.(`MCP 删除清单 ${name} 无法读取；原文件保留，请检查回收站权限/清单与备份`)
    }
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function readDeletion(trashDir: string, batchId: string): Promise<DeletionRecord> {
  if (!/^[0-9a-f-]{36}$/u.test(batchId)) throw new Error('回收站批次无效')
  const raw = JSON.parse(await readFile(join(trashDir, batchId, 'manifest.json'), 'utf8')) as unknown
  if (!isRecord(raw) || raw.version !== 1 || raw.batchId !== batchId ||
      ['createdAt', 'id', 'serverName', 'patchPath', 'homeFingerprint', 'beforeFingerprint', 'afterFingerprint', 'backupPath', 'removed'].some((key) => typeof raw[key] !== 'string') || typeof raw.offset !== 'number') {
    throw new Error('MCP 回收站清单损坏，请手工检查备份')
  }
  return raw as unknown as DeletionRecord
}

export async function deleteMcpEntry(input: {
  session: McpEditSession; backupRoot: string; trashDir: string
}): Promise<MutationResult<McpDeletionSummary>> {
  const { session } = input
  const id = session.id
  if (id === undefined) throw new Error('请选择待删除的受管 MCP 行')
  const summary: McpDeletionSummary = { batchId: randomUUID(), createdAt: new Date().toISOString(), id,
    serverName: session.serverName ?? '', patchPath: session.patchPath }
  let removed = ''
  let offset = 0
  return transact({ ...session, backupRoot: input.backupRoot }, (profile, home) => {
    if (parsePatchText(home.text).rows.some((row) => row.id === id)) throw new Error('home 全局层只读')
    const result = deleteManagedMcp(profile.text, id, summary.serverName)
    removed = result.removed
    offset = result.offset
    let text = result.text
    if (extractManagedBlock(text)?.rows.some((row) => row.id === id)) {
      // Returning the override to its non-managed baseline removes only our row.
      const block = extractManagedBlock(text)!
      let baseline = false
      for (const row of parsePatchText(`${block.before}${block.after}`).rows) {
        if (row.id === id && row.disabled !== undefined) {
          if (isJsValue(row.disabled)) throw new Error('目标另有表达式覆盖，请手工编辑')
          baseline = row.disabled
        }
      }
      const cleared = upsertManagedToggle(text, id, baseline)
      if (!cleared.ok) throw new Error(cleared.error)
      text = cleared.text
    }
    return { text, value: summary }
  }, async (before, after, backupPath) => {
    const dir = join(input.trashDir, summary.batchId)
    const record: DeletionRecord = { ...summary, version: 1, homeFingerprint: session.expectedHome,
      beforeFingerprint: before.fingerprint, afterFingerprint: patchFingerprint(after), backupPath, removed, offset }
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(record, undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('MCP 回收站清单写入失败，已停止删除')
    }
    return () => rm(dir, { recursive: true, force: true })
  })
}

export async function restoreMcpEntry(input: {
  files: Files; backupRoot: string; trashDir: string; batchId: string
}): Promise<MutationResult<{ id: string; serverName: string }>> {
  const record = await readDeletion(input.trashDir, input.batchId)
  if (record.patchPath !== input.files.patchPath) throw new Error('该删除记录属于其他 profile')
  const backup = resolve(record.backupPath)
  if (!backup.startsWith(`${resolve(input.backupRoot)}${sep}`)) throw new Error('备份路径不在本插件目录中')
  const text = await readFile(backup, 'utf8')
  if (patchFingerprint(text) !== record.beforeFingerprint) throw new Error('备份内容已变化，请手工恢复')
  const result = await transact({ ...input.files, backupRoot: input.backupRoot,
    expectedProfile: record.afterFingerprint, expectedHome: record.homeFingerprint }, () => ({ text,
    value: { id: record.id, serverName: record.serverName } }))
  await rm(join(input.trashDir, input.batchId), { recursive: true, force: true })
  return result
}
