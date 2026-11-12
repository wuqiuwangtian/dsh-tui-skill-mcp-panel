/** Filesystem-only moves with a verified cross-device fallback. Never follow links. */
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

interface TreeEntry {
  path: string
  kind: 'directory' | 'file' | 'link'
  mode: number
  content?: string
}

export class MoveRecoveryError extends Error {
  constructor(source: string, destination: string, cause: unknown, sourceRestored = false) {
    super(`${sourceRestored ? '源数据已恢复，移动副本清理未完成' : '移动未完成，恢复副本已保留'}：${destination}；原位置：${source}。请勿清理副本，检查后重试恢复：${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'MoveRecoveryError'
  }
}

/** lstat matters: even a dangling link occupies a destination. */
export async function entityExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function describe(path: string, relative: string): Promise<TreeEntry> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return { path: relative, kind: 'link', mode: 0, content: await readlink(path) }
  const mode = info.mode & 0o777
  if (info.isDirectory()) return { path: relative, kind: 'directory', mode }
  if (!info.isFile()) throw new Error(`不支持跨设备移动的文件类型：${path}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const after = await lstat(path)
  if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) {
    throw new Error(`文件在校验期间发生变化，请刷新后重试：${path}`)
  }
  return { path: relative, kind: 'file', mode, content: hash.digest('hex') }
}

async function snapshot(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []
  const visit = async (relative: string): Promise<void> => {
    const full = join(root, relative)
    const entry = await describe(full, relative)
    entries.push(entry)
    if (entry.kind === 'directory') {
      for (const name of (await readdir(full)).sort()) await visit(join(relative, name))
    }
  }
  await visit('')
  return entries
}

function same(left: TreeEntry[], right: TreeEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Semantic tree digest, optionally bound to the current root entity identity. */
export async function entityFingerprint(path: string, includeIdentity = true): Promise<string | undefined> {
  if (!await entityExists(path)) return undefined
  const info = await lstat(path)
  const tree = await snapshot(path)
  return createHash('sha256').update(JSON.stringify({ tree,
    ...(includeIdentity ? { dev: info.dev, ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs } : {}),
  })).digest('hex')
}

/** Copy only absent nodes; also used to roll back a partially removed source. */
async function copyMissing(source: string, destination: string, entries: TreeEntry[]): Promise<void> {
  for (const entry of entries) {
    const from = join(source, entry.path), to = join(destination, entry.path)
    if (await entityExists(to)) {
      if (!same([entry], [await describe(to, entry.path)])) throw new Error(`恢复位置已有不同内容，未覆盖：${to}`)
      continue
    }
    if (entry.kind === 'directory') await mkdir(to, { mode: 0o700 })
    else if (entry.kind === 'link') await symlink(entry.content!, to)
    else await copyFile(from, to, constants.COPYFILE_EXCL)
  }
  // Apply directory permissions last so readonly bundles remain copyable.
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== 'link') await chmod(join(destination, entry.path), entry.mode)
  }
}

async function publishCopy(source: string, destination: string, entries: TreeEntry[]): Promise<void> {
  if (await entityExists(destination)) throw new Error(`目标已存在，未覆盖：${destination}`)
  // The provider only scans one directory level. Nest the copied entity so a
  // restore's staging tree never appears as a live skill before verification.
  const stagingDir = join(dirname(destination), `.skill-move-${randomUUID()}`)
  await mkdir(stagingDir, { mode: 0o700 })
  const staging = join(stagingDir, 'entity')
  try {
    await copyMissing(source, staging, entries)
    if (!same(entries, await snapshot(staging))) throw new Error('移动副本校验失败，源数据保留')
    if (!same(entries, await snapshot(source))) throw new Error('源数据在复制期间发生变化，请刷新后重试')
    if (await entityExists(destination)) throw new Error(`目标已存在，未覆盖：${destination}`)
    await rename(staging, destination)
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Verified backup copy; source is never removed. */
export async function copyEntityVerified(source: string, destination: string): Promise<void> {
  await publishCopy(source, destination, await snapshot(source))
}

export async function moveEntity(source: string, destination: string): Promise<void> {
  if (await entityExists(destination)) throw new Error(`目标已存在，未覆盖：${destination}`)
  try { await rename(source, destination); return } catch (error) {
    if (!['EXDEV', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  const entries = await snapshot(source)
  await publishCopy(source, destination, entries)
  try {
    await rm(source, { recursive: true })
  } catch (removeError) {
    try {
      if (!same(entries, await snapshot(destination))) throw new Error('恢复副本发生变化')
      await copyMissing(destination, source, entries)
      if (!same(entries, await snapshot(source))) throw new Error('源数据回滚校验失败')
    } catch (rollbackError) { throw new MoveRecoveryError(source, destination, rollbackError) }
    try { await rm(destination, { recursive: true }) } catch (cleanupError) {
      throw new MoveRecoveryError(source, destination, cleanupError, true)
    }
    throw new Error(`移除源数据失败，已回滚到原位置：${removeError instanceof Error ? removeError.message : String(removeError)}`)
  }
}
