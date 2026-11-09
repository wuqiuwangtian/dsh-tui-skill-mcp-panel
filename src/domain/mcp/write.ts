/** Cooperative web-panel lock + optimistic conflict checks for MCP patch writes. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MCP_MODULE, backupPatchFile, parsePatchText, upsertManagedToggle, writePatchFileAtomic } from './patch.js'

export interface PatchSnapshot {
  text: string
  fingerprint: string
}

export function patchFingerprint(text: string): string {
  return createHash('sha256').update(`file\0${text}`).digest('hex')
}

export class PatchConflictError extends Error {
  constructor() {
    super('配置文件已变化，请按 r 重新加载后重试；未覆盖外部改动')
    this.name = 'PatchConflictError'
  }
}

export async function readPatchSnapshot(path: string): Promise<PatchSnapshot> {
  try {
    const text = await readFile(path, 'utf8')
    return { text, fingerprint: patchFingerprint(text) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { text: '', fingerprint: 'missing' }
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Same name and pid/newline/timestamp format as web 2.3.7. Hold only during I/O. */
export async function withPatchLock<T>(
  patchPath: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lockPath = `${patchPath}.panel.lock`
  const started = Date.now()
  const token = `${process.pid}\n${Date.now()}\n${randomUUID()}\n`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (handle === undefined) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        const owner = Number((await readFile(lockPath, 'utf8')).split('\n')[0])
        if (Date.now() - info.mtimeMs > (options.staleMs ?? 30_000) && !isAlive(owner)) {
          const current = await stat(lockPath)
          if (current.ino === info.ino && current.mtimeMs === info.mtimeMs) await rm(lockPath)
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError
      }
      if (Date.now() - started >= (options.timeoutMs ?? 5000)) {
        throw new Error('等待 cordis.patch.yml 写锁超时，请稍后重试（其他面板可能正在写入）')
      }
      await delay(options.pollMs ?? 50)
    }
  }
  try {
    await handle.writeFile(token, 'utf8')
    return await operation()
  } finally {
    try {
      // Compare inodes while our descriptor is open, so it cannot be reused.
      const held = await handle.stat()
      const current = await lstat(lockPath).catch(() => undefined)
      if (current?.ino === held.ino && current.dev === held.dev) await rm(lockPath, { force: true })
    } finally {
      await handle.close()
    }
  }
}

export interface TogglePatchInput {
  patchPath: string
  homePatchPath: string
  expectedProfile: string
  expectedHome: string
  id: string
  serverName: string
  disabled: boolean
  backupRoot: string
}

/** Refuse stale snapshots, damaged YAML/blocks, changed identity and missing backups. */
export async function saveMcpToggle(input: TogglePatchInput): Promise<{ changed: boolean; backupPath?: string }> {
  return withPatchLock(input.patchPath, async () => {
    const checkSnapshots = async (): Promise<[PatchSnapshot, PatchSnapshot]> => {
      const snapshots = await Promise.all([readPatchSnapshot(input.patchPath), readPatchSnapshot(input.homePatchPath)])
      if (snapshots[0].fingerprint !== input.expectedProfile || snapshots[1].fingerprint !== input.expectedHome) {
        throw new PatchConflictError()
      }
      return snapshots
    }
    const [profile, home] = await checkSnapshots()
    const info = await lstat(input.patchPath)
    if (!info.isFile()) throw new Error('profile patch 必须是普通文件；符号链接请手工编辑')
    const profilePatch = parsePatchText(profile.text)
    const homePatch = parsePatchText(home.text)
    if (!profilePatch.ok || !homePatch.ok) throw new Error('profile/home patch YAML 非法，请修复后重试')
    if (homePatch.rows.some((row) => row.id === input.id)) throw new PatchConflictError()
    const targetRows = profilePatch.rows.filter((row) => row.id === input.id)
    if (targetRows.length === 0) throw new PatchConflictError()
    const moduleName = [...targetRows].reverse().find((row) => row.name !== undefined)?.name
    if (moduleName !== undefined && moduleName !== MCP_MODULE) throw new PatchConflictError()
    const config = [...targetRows].reverse().find((row) => row.config !== undefined)?.config
    if (typeof config?.serverName === 'string' && config.serverName !== input.serverName) throw new PatchConflictError()
    const next = upsertManagedToggle(profile.text, input.id, input.disabled)
    if (!next.ok) throw new Error(next.error)
    if (!next.changed) return { changed: false }

    let backupPath: string
    try {
      backupPath = await backupPatchFile(input.patchPath, join(input.backupRoot, `${Date.now()}-${randomUUID()}`))
      if (await readFile(backupPath, 'utf8') !== profile.text) throw new PatchConflictError()
    } catch (error) {
      if (error instanceof PatchConflictError) throw error
      throw new Error('MCP 备份失败，已停止写入；请检查备份目录权限或磁盘空间')
    }
    // Catch non-cooperating editors changing either layer while we made the backup.
    await writePatchFileAtomic(input.patchPath, next.text, checkSnapshots)
    return { changed: true, backupPath }
  })
}
