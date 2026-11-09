/** Edit only this panel's inserted MCP rows, retaining every unrelated byte. */
import { isMap, isSeq, parseDocument, stringify } from 'yaml'
import { JS_TAG, MCP_MODULE, parsePatchText } from './patch.js'
import { isRecord, validateMcpConfig, type McpConfig } from './model.js'

export const MCP_BLOCK_BEGIN = '# >>> dsh-tui-skill-mcp-panel:mcp:begin'
export const MCP_BLOCK_END = '# <<< dsh-tui-skill-mcp-panel:mcp:end'

interface Block { start: number; bodyStart: number; end: number; endAfter: number }
export interface ManagedMcpEntry {
  id: string
  serverName: string
  config: McpConfig
  raw: Record<string, unknown>
  start: number
  end: number
  containerStart: number
  containerEnd: number
  siblings: number
}

function blockOf(text: string): Block | undefined {
  const markers = [...text.matchAll(/^# (?:>>>|<<<) dsh-tui-skill-mcp-panel:mcp:(?:begin|end)(?=\r?$)/gm)]
  if (markers.length === 0) return undefined
  const [begin, end] = markers
  if (markers.length !== 2 || begin?.[0] !== MCP_BLOCK_BEGIN || end?.[0] !== MCP_BLOCK_END) throw new Error('MCP 受管块标记损坏或重复，请手工修复')
  return { start: begin.index, bodyStart: begin.index + begin[0].length, end: end.index, endAfter: end.index + end[0].length }
}

function lineStart(text: string, offset: number): number { return text.lastIndexOf('\n', offset) + 1 }

export function managedMcpEntries(text: string): ManagedMcpEntry[] {
  const parsed = parsePatchText(text)
  if (!parsed.ok) throw new Error('patch YAML 非法，请修复后重试')
  const block = blockOf(text)
  if (block === undefined) return []
  const document = parseDocument(text, { customTags: [JS_TAG] })
  if (document.warnings.length > 0) throw new Error('patch 含不支持的 YAML 标签；为保留原文，请手工编辑')
  if (!isSeq(document.contents)) throw new Error('patch 必须是 YAML 数组')
  const entries: ManagedMcpEntry[] = []
  for (const top of document.contents.items) {
    if (!isMap(top) || top.range == null) continue
    const list = top.get('insert', true)
    if (!isSeq(list)) continue
    for (const item of list.items) {
      if (!isMap(item) || item.range == null || item.range[0] < block.bodyStart || item.range[2] > block.end) continue
      const raw = item.toJSON() as unknown
      if (!isRecord(raw) || raw.name !== MCP_MODULE || typeof raw.id !== 'string' || !isRecord(raw.config) || typeof raw.config.serverName !== 'string') continue
      if (Object.keys(top.toJSON() as object).length !== 1) throw new Error('受管 insert 容器含其他字段，请手工编辑')
      const start = lineStart(text, item.range[0])
      const containerStart = lineStart(text, top.range[0])
      if (!/^    - /u.test(text.slice(start, item.range[0])) || !/^- /u.test(text.slice(containerStart, top.range[0]))) {
        throw new Error('受管行缩进不受支持，请手工编辑')
      }
      entries.push({ id: raw.id, serverName: raw.config.serverName, config: raw.config, raw,
        start, end: item.range[2], containerStart, containerEnd: top.range[2], siblings: list.items.length })
    }
  }
  return entries
}

export function findManagedMcp(text: string, id: string, serverName: string): ManagedMcpEntry {
  const entries = managedMcpEntries(text).filter((entry) => entry.id === id)
  if (entries.length !== 1 || entries[0]?.serverName !== serverName) throw new Error('仅能编辑/删除本面板受管行；目标可能已变化，请刷新')
  if (parsePatchText(text).rows.filter((row) => row.id === id && !row.override).length !== 1) throw new Error('目标行 id 重复，请手工修复后重试')
  // A later override could hide data or cause a resurrected entry on deletion.
  if (parsePatchText(text).rows.some((row) => row.id === id && row.override && row.config !== undefined)) {
    throw new Error('目标另有 config 覆盖，请手工合并后重试')
  }
  return entries[0]
}

function encode(value: unknown, eol: string): string {
  return stringify(value, { customTags: [JS_TAG], lineWidth: 0 }).replaceAll('\n', eol)
}

function validateCandidate(text: string): string {
  if (!parsePatchText(text).ok) throw new Error('候选 YAML 校验失败，未修改文件')
  return text
}

export function addManagedMcp(text: string, id: string, config: McpConfig): string {
  validateMcpConfig(config)
  const block = blockOf(text)
  const document = parseDocument(text, { customTags: [JS_TAG] })
  if (document.errors.length > 0 || (document.contents !== null && !isSeq(document.contents))) throw new Error('patch YAML 非法')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const row = encode([{ insert: [{ id, name: MCP_MODULE, config }] }], eol)
  if (block !== undefined) {
    const prefix = text.slice(0, block.end)
    return validateCandidate(`${prefix}${prefix.endsWith('\n') ? '' : eol}${row}${text.slice(block.end)}`)
  }
  const managed = `${MCP_BLOCK_BEGIN}${eol}${row}${MCP_BLOCK_END}`
  // Prefixing keeps all existing overrides (including mcp-toggle) after inserts.
  if (isSeq(document.contents) && document.contents.items.length === 0 && document.contents.range != null) {
    const range = document.contents.range
    return validateCandidate(`${text.slice(0, range[0])}${managed}${text.slice(range[1])}`)
  }
  return validateCandidate(`${managed}${eol}${text}`)
}

export function editManagedMcp(text: string, id: string, serverName: string, config: McpConfig): string {
  validateMcpConfig(config)
  const entry = findManagedMcp(text, id, serverName)
  if (JSON.stringify(entry.config) === JSON.stringify(config)) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const raw = { ...entry.raw, config }
  const row = encode([raw], eol).trimEnd().split(eol).map((line) => `    ${line}`).join(eol) + eol
  return validateCandidate(`${text.slice(0, entry.start)}${row}${text.slice(entry.end)}`)
}

export function deleteManagedMcp(text: string, id: string, serverName: string): { text: string; removed: string; offset: number } {
  const entry = findManagedMcp(text, id, serverName)
  const start = entry.siblings === 1 ? entry.containerStart : entry.start
  const end = entry.siblings === 1 ? entry.containerEnd : entry.end
  let next = `${text.slice(0, start)}${text.slice(end)}`
  const block = blockOf(next)
  if (block !== undefined && next.slice(block.bodyStart, block.end).trim().length === 0) {
    const after = next.slice(block.endAfter)
    const eol = next.includes('\r\n') ? '\r\n' : '\n'
    next = `${next.slice(0, block.start)}${after.startsWith(eol) ? after.slice(eol.length) : after}`
  }
  return { text: validateCandidate(next), removed: text.slice(start, end), offset: start }
}
