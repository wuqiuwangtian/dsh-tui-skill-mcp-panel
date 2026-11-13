/** Diagnostic provenance only: no package execution, PATH search or dependency-range fallback. */
import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface VersionInfo { value?: string; source: string; reason?: string }
export interface RuntimeVersions { plugin: VersionInfo; host: VersionInfo; kernel: VersionInfo; node: VersionInfo }
export interface HostVersionService { hostDescriptor(): unknown }
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
export function exactVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && EXACT_VERSION.test(value)
}
function unavailable(source: string, reason: string): VersionInfo { return { source, reason } }

async function manifest(path: string): Promise<Record<string, unknown>> {
  const info = await stat(path)
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('invalid manifest')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new Error('invalid manifest')
    const buffer = Buffer.alloc(64 * 1024 + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!result.bytesRead) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > 64 * 1024) throw new Error('oversized manifest')
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest')
    return value as Record<string, unknown>
  } finally { await handle.close() }
}

/** Stop at the first package boundary, including an invalid or unrelated package. */
async function enclosingPackage(entry: string): Promise<{ path: string; data: Record<string, unknown> }> {
  let dir = dirname(await realpath(entry))
  for (let depth = 0; depth < 16; depth++) {
    const path = join(dir, 'package.json')
    try { await stat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent; continue
    }
    return { path, data: await manifest(path) }
  }
  throw new Error('package boundary not found')
}

export async function collectVersions(options: {
  host?: HostVersionService
  pluginManifest?: string
  processEntry?: string
  nodeVersion?: string
} = {}): Promise<RuntimeVersions> {
  const result: RuntimeVersions = {
    plugin: unavailable('插件自身 package.json', '包身份或版本不可读'),
    host: unavailable('tuiPluginHost.hostDescriptor()', '公开版本服务不可用'),
    kernel: unavailable('当前 CLI 入口解析的 app-boot 包', '当前入口无法确认为 DSH CLI'),
    node: exactVersion(options.nodeVersion ?? process.versions.node) ? { value: options.nodeVersion ?? process.versions.node, source: 'process.versions.node' }
      : unavailable('process.versions.node', 'Node 版本不可读'),
  }
  try {
    const path = options.pluginManifest ?? fileURLToPath(new URL('../../../package.json', import.meta.url))
    const data = await manifest(path)
    if (data.name === 'dsh-tui-skill-mcp-panel' && exactVersion(data.version)) result.plugin = { value: data.version, source: path }
  } catch { /* Never echo raw JSON or provider errors in diagnostics. */ }
  try {
    if (options.host !== undefined) {
      const descriptor = options.host.hostDescriptor() as Record<string, unknown> | undefined
      if (descriptor !== null && typeof descriptor === 'object' && typeof descriptor.then === 'function') {
        void Promise.resolve(descriptor).catch(() => undefined)
      }
      if (descriptor?.hostId === 'dsh-tui' && exactVersion(descriptor.hostVersion) && descriptor.hostVersion !== '0.0.0') {
        result.host = { value: descriptor.hostVersion, source: 'tuiPluginHost.hostDescriptor().hostVersion' }
      } else result.host = unavailable('tuiPluginHost.hostDescriptor()', '宿主身份或精确版本无效')
    }
  } catch { result.host = unavailable('tuiPluginHost.hostDescriptor()', '公开版本服务拒绝或读取失败') }
  try {
    const entry = options.processEntry ?? process.argv[1]
    if (entry !== undefined && isAbsolute(entry)) {
      const actualEntry = await realpath(entry)
      const cli = await enclosingPackage(actualEntry)
      const bin = cli.data.bin as Record<string, unknown> | undefined
      if (cli.data.name === '@deepseek-ai/dsh' && typeof bin?.dsh === 'string' &&
        await realpath(resolve(dirname(cli.path), bin.dsh)) === actualEntry) {
        const library = await enclosingPackage(createRequire(actualEntry).resolve('@deepseek-ai/dsh-app-boot'))
        if (library.data.name === '@deepseek-ai/dsh-app-boot' && exactVersion(library.data.version)) {
          result.kernel = { value: library.data.version, source: library.path }
        } else result.kernel = unavailable('当前 CLI 入口解析的 app-boot 包', '运行库包身份或精确版本无效')
      }
    }
  } catch { result.kernel = unavailable('当前 CLI 入口解析的 app-boot 包', '入口或运行库元数据不可读') }
  return result
}
