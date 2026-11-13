/** Read-only skill text: bounded preview and sparse, cell-wrapped disk paging. */
import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { charWidth } from '../../shared/format.js'

const CHUNK_BYTES = 32 * 1024
export const PREVIEW_BYTES = 16 * 1024
const MAX_CHECKPOINTS = 4096
interface Checkpoint { row: number; offset: number; skipLF: boolean }
type Identity = string
function identity(info: Awaited<ReturnType<typeof stat>>): Identity {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted() }

async function openNormal(path: string): Promise<{ handle: FileHandle; token: Identity; size: number }> {
  const before = await stat(path)
  if (!before.isFile()) throw new Error('技能文件必须是普通文件，未读取设备或目录')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || identity(info) !== identity(before)) throw new Error('技能文件已变化，请刷新列表后重试')
    return { handle, token: identity(info), size: info.size }
  } catch (error) { await handle.close(); throw error }
}

export async function readSkillPreview(path: string): Promise<{ content: string; truncated: boolean }> {
  const { handle, token, size } = await openNormal(path)
  try {
    const buffer = Buffer.alloc(Math.min(size, PREVIEW_BYTES))
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (identity(await handle.stat()) !== token || identity(await stat(path)) !== token) throw new Error('技能文件已变化，请刷新列表后重试')
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    return { content: decoder.decode(buffer.subarray(0, length), { stream: size > length }), truncated: size > length }
  } finally { await handle.close() }
}

export interface SkillTextPage { offset: number; totalRows: number; lines: string[] }

export class SkillTextReader {
  private readonly checkpoints: Checkpoint[] = [{ row: 0, offset: 0, skipLF: false }]
  private closed = false
  private readonly checkpointBytes: number
  totalRows = 0
  private constructor(readonly path: string, readonly width: number, private readonly handle: FileHandle,
    private readonly token: Identity, readonly bytes: number) {
    this.checkpointBytes = Math.max(CHUNK_BYTES, Math.ceil(bytes / MAX_CHECKPOINTS))
  }

  static async create(path: string, width: number, options: { signal?: AbortSignal; progress?: (bytes: number, total: number) => void } = {}): Promise<SkillTextReader> {
    if (!Number.isFinite(width)) throw new Error('全文宽度必须是有限数值')
    const file = await openNormal(path)
    const reader = new SkillTextReader(path, Math.max(2, Math.floor(width)), file.handle, file.token, file.size)
    try {
      aborted(options.signal)
      await reader.walk(reader.checkpoints[0]!, false, (row, next) => {
        reader.totalRows = row + 1
        if (next.offset - reader.checkpoints[reader.checkpoints.length - 1]!.offset >= reader.checkpointBytes) reader.checkpoints.push(next)
        return false
      }, options)
      await reader.verify()
      return reader
    } catch (error) { await reader.close(); throw error }
  }

  private async verify(): Promise<void> {
    if (this.closed) throw new Error('全文读取已关闭')
    if (identity(await this.handle.stat()) !== this.token || identity(await stat(this.path)) !== this.token) {
      throw new Error('技能文件已变化；按 r 重新读取，或关闭后刷新列表')
    }
  }

  /** Fixed-size decoding and sparse row checkpoints avoid retaining the file or all wrapped rows. */
  private async walk(start: Checkpoint, collect: boolean, emit: (row: number, next: Checkpoint, text: string) => boolean,
    options: { signal?: AbortSignal; progress?: (bytes: number, total: number) => void }): Promise<void> {
    const buffer = Buffer.alloc(CHUNK_BYTES)
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let readAt = start.offset, byteAt = start.offset, row = start.row, cells = 0, text = '', skipLF = start.skipLF
    const finish = (offset: number, nextSkipLF: boolean): boolean => {
      const stop = emit(row, { row: row + 1, offset, skipLF: nextSkipLF }, text)
      row++; cells = 0; text = ''; return stop
    }
    while (true) {
      aborted(options.signal)
      if (this.closed) throw new Error('全文读取已关闭')
      const { bytesRead } = await this.handle.read(buffer, 0, Math.min(buffer.length, Math.max(0, this.bytes - readAt)), readAt)
      const decoded = decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead > 0 })
      for (const char of decoded) {
        const at = byteAt
        byteAt += Buffer.byteLength(char)
        if (skipLF) { skipLF = false; if (char === '\n') continue }
        if (char === '\r' || char === '\n') {
          skipLF = char === '\r'
          if (finish(byteAt, skipLF)) return
          continue
        }
        const code = char.codePointAt(0)!
        if (char !== '\t' && (code < 0x20 || (code >= 0x7f && code < 0xa0))) continue
        const visible = char === '\t' ? ' ' : char
        const size = charWidth(visible)
        if (cells + size > this.width && cells > 0 && finish(at, false)) return
        if (collect) text += visible
        cells += size
      }
      readAt += bytesRead
      if (!bytesRead) { finish(byteAt, false); return }
      options.progress?.(readAt, this.bytes)
      await setImmediate(undefined, options.signal === undefined ? {} : { signal: options.signal })
    }
  }

  async page(offset: number, rows: number, signal?: AbortSignal): Promise<SkillTextPage> {
    if (!Number.isFinite(offset) || !Number.isFinite(rows)) throw new Error('全文页码与行数必须是有限数值')
    await this.verify()
    aborted(signal)
    rows = Math.max(1, Math.floor(rows))
    offset = Math.max(0, Math.min(Math.floor(offset), Math.max(0, this.totalRows - rows)))
    let low = 0, high = this.checkpoints.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (this.checkpoints[middle]!.row <= offset) low = middle
      else high = middle - 1
    }
    const start = this.checkpoints[low]!
    const lines: string[] = []
    await this.walk(start, true, (row, _next, text) => {
      if (row >= offset) lines.push(text)
      return lines.length >= rows
    }, { ...(signal === undefined ? {} : { signal }) })
    await this.verify()
    return { offset, totalRows: this.totalRows, lines }
  }

  async close(): Promise<void> { if (!this.closed) { this.closed = true; await this.handle.close() } }
}
