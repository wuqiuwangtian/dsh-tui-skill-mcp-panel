/** One lock order for cooperating trash writers: root, then batch manifest. */
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withPatchLock } from '../mcp/write.js'

export const cleanupRecordPath = (home: string): string => join(home, 'trash-cleanup.json')
export const cleanupPendingDir = (home: string): string => join(home, 'trash-cleanup-pending')
export const cleanupPendingPath = (home: string, id: string): string => join(cleanupPendingDir(home), `${id}.json`)

export async function assertTrashDirectory(path: string): Promise<void> {
  let at = resolve(path)
  while (true) {
    try { if (!(await lstat(at)).isDirectory()) throw new Error(`回收站路径必须是普通目录，不能经过链接：${at}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(at)
    if (parent === at) return
    at = parent
  }
}

export async function withSkillTrashLock<T>(home: string, operation: () => Promise<T>): Promise<T> {
  await assertTrashDirectory(home)
  await mkdir(home, { recursive: true, mode: 0o700 })
  return withPatchLock(join(home, 'trash'), operation, { resourceName: '技能回收站' })
}
