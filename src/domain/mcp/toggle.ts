/** Edit only a named MCP definition's boolean disabled field; never serialize YAML. */
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { JS_TAG, MCP_MODULE, legacyMcpToggles, parsePatchText, removeLegacyMcpToggle } from './patch.js'

export interface McpToggleIdentity { id: string; serverName: string }

export function editMcpDisabled(source: string, identity: McpToggleIdentity, disabled: boolean): { text: string; changed: boolean } {
  if (!identity.id || /[\r\n\0]/u.test(identity.id)) throw new Error('MCP 行 id 非法')
  const text = removeLegacyMcpToggle(source, identity.id)
  const doc = parseDocument(text, { customTags: [JS_TAG] })
  if (doc.errors.length || doc.warnings.length || !isSeq(doc.contents)) throw new Error('patch YAML 非法或含不支持的标签，未修改文件')
  const maps: YAMLMap[] = []
  for (const top of doc.contents.items) {
    if (!isMap(top)) continue
    maps.push(top)
    const insert = top.get('insert', true)
    if (isSeq(insert)) {
      for (const item of insert.items) if (isMap(item)) maps.push(item)
    }
  }
  // Resolve aliases only for duplicate detection, never for choosing edit ranges.
  const parsed = parsePatchText(text)
  const rows = parsed.rows.filter((row) => row.id === identity.id)
  if (!parsed.ok || rows.length !== 1) throw new Error('目标存在重复定义或外来覆盖，请手工合并后重试')
  const matches = maps.filter((map) => map.get('id') === identity.id)
  const map = matches[0]
  const config = map?.get('config', true)
  if (matches.length !== 1 || !map || map.anchor || map.get('name') !== MCP_MODULE ||
    !isMap(config) || config.get('serverName') !== identity.serverName ||
    !isScalar(map.get('id', true)) || !isScalar(map.get('name', true)) || !isScalar(config.get('serverName', true))) {
    throw new Error('MCP 定义无法唯一定位或使用别名，请刷新/手工检查')
  }
  const pair = map.items.find((pair) => isScalar(pair.key) && pair.key.value === 'disabled')
  let next = text
  if (pair) {
    const value = pair.value
    if (!isScalar(value) || typeof value.value !== 'boolean' || value.tag || value.anchor || !value.range ||
      !isScalar(pair.key) || !pair.key.range) throw new Error('disabled 不是普通布尔值（表达式/别名只读），未修改文件')
    if (value.value !== disabled) {
      const [start, end] = value.range
      const lineStart = text.lastIndexOf('\n', pair.key.range[0]) + 1
      const lineEndIndex = text.indexOf('\n', end)
      const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex + 1
      // Removing a standalone key restores default-enabled without discarding
      // comments. Inline/flow forms retain their layout and change the scalar.
      const standalone = !map.flow && /^[ \t]*$/u.test(text.slice(lineStart, pair.key.range[0])) &&
        /^[ \t\r\n]*$/u.test(text.slice(end, lineEnd))
      next = !disabled && standalone ? text.slice(0, lineStart) + text.slice(lineEnd) :
        text.slice(0, start) + String(disabled) + text.slice(end)
    }
  } else if (disabled) {
    if (map.flow) throw new Error('内联 YAML 缺少 disabled，无法安全插入；请手工展开后重试')
    const key = map.items.map((pair) => pair.key).find((key) => isScalar(key) && key.range &&
      /^[ \t]+$/u.test(text.slice(text.lastIndexOf('\n', key.range[0]) + 1, key.range[0])))
    if (!isScalar(key) || !key.range) throw new Error('无法安全定位 disabled 插入位置，请手工检查格式')
    const lineStart = text.lastIndexOf('\n', key.range[0]) + 1
    const indent = text.slice(lineStart, key.range[0])
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    next = text.slice(0, lineStart) + `${indent}disabled: true${eol}` + text.slice(lineStart)
  }
  const check = parsePatchText(next)
  const target = check.rows.filter((row) => row.id === identity.id)
  if (!check.ok || target.length !== 1 || (target[0]!.disabled ?? false) !== disabled) throw new Error('写入后启停状态校验失败，未修改文件')
  return { text: next, changed: next !== source }
}

/** Explicit migration preserves each legacy override's saved effective state. */
export function migrateLegacyMcpToggles(source: string): { text: string; changed: boolean; ids: string[] } {
  const toggles = legacyMcpToggles(source)
  let text = source
  for (const toggle of toggles) {
    const definitions = parsePatchText(text).rows.filter((row) => row.id === toggle.id && row.name === MCP_MODULE)
    const name = definitions[0]?.config?.serverName
    if (definitions.length !== 1 || typeof name !== 'string') throw new Error('旧启停覆盖没有唯一 MCP 定义，请手工合并')
    text = editMcpDisabled(text, { id: toggle.id, serverName: name }, toggle.disabled).text
  }
  return { text, changed: text !== source, ids: toggles.map((toggle) => toggle.id) }
}
