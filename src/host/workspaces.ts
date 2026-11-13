/** Public, read-only workspace seam. Never accesses the host-only facade or ledger files. */
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { findProjectRoot } from '../domain/skills/discovery.js'

export interface KnownWorkspace { cwd: string; label: string; projectRoot: string; present: boolean }
export interface WorkspaceState {
  currentCwd: string
  currentProjectRoot: string
  selectedCwd: string
  entries: KnownWorkspace[]
  warning?: string
}
interface WorkspaceService {
  listRegistry?: () => Promise<unknown>
  list?: (cwd: string, signal?: AbortSignal) => Promise<unknown>
}

export async function readKnownWorkspaces(service: WorkspaceService | undefined, cwd: string): Promise<Pick<WorkspaceState, 'entries' | 'warning'>> {
  if (service === undefined) return { entries: [], warning: 'tuiWorkspaces 不可用；仍可管理当前工作区与全局技能' }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const registry = typeof service.listRegistry === 'function'
    if (!registry && typeof service.list !== 'function') throw new Error('missing listing method')
    const rows = await Promise.race([
      Promise.resolve().then(() => registry ? service.listRegistry!() : service.list!(cwd, controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, 1500) }),
    ])
    if (!Array.isArray(rows)) throw new Error('invalid workspace list')
    const entries = new Map<string, KnownWorkspace>()
    let ignored = 0
    for (const row of rows) {
      if (row === null || typeof row !== 'object') { ignored++; continue }
      const path: unknown = registry ? row.path : row.kind === 'local' ? row.cwd : undefined
      const label: unknown = registry ? row.title : row.label
      if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path)) { ignored++; continue }
      const normalized = resolve(path)
      const present = await stat(normalized).then(info => info.isDirectory(), () => false)
      entries.set(normalized, { cwd: normalized, label: typeof label === 'string' ? label.replace(/[\x00-\x1f\x7f]/gu, ' ') : normalized,
        projectRoot: findProjectRoot(normalized), present })
    }
    return { entries: [...entries.values()], ...(ignored ? { warning: `已忽略 ${ignored} 条非本地或无效工作区；只管理本机目录` } : {}) }
  } catch {
    // Do not expose arbitrary provider errors, which may contain credentials.
    return { entries: [], warning: '无法读取已知工作区（服务拒绝、异常或超时）；仍可管理当前工作区与全局技能' }
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
