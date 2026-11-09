/** Form values stay data: references become unevaluated YAML !!js scalars. */
import { isJsValue, jsValue, type JsValue } from './patch.js'

export type McpConfig = Record<string, unknown>
export type McpField = 'serverName' | 'transport' | 'command' | 'args' | 'cwd' | 'env' | 'url' | 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateMcpConfig(config: McpConfig): void {
  if (typeof config.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(config.serverName)) {
    throw new Error('serverName 必须为 1–32 个英文字母、数字、下划线或连字符')
  }
  const dynamicTransport = isJsValue(config.transport)
  if (!dynamicTransport && !['stdio', 'streamable-http'].includes(String(config.transport))) throw new Error('请选择 stdio 或 streamable-http')
  const required = config.transport === 'stdio' ? 'command' : 'url'
  if (!dynamicTransport && !isJsValue(config[required]) && (typeof config[required] !== 'string' || config[required].trim().length === 0)) {
    throw new Error(`${required} 不能为空`)
  }
  if (config.transport === 'streamable-http' && typeof config.url === 'string') {
    let url: URL
    try { url = new URL(config.url) } catch { throw new Error('url 必须是完整的 HTTP(S) 地址') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url 仅支持 HTTP(S)')
  }
  if (config.args !== undefined && !isJsValue(config.args) && (!Array.isArray(config.args) || config.args.some((v: unknown) => typeof v !== 'string' && !isJsValue(v)))) {
    throw new Error('args 必须是字符串数组（支持保留已有 !!js 参数）')
  }
  for (const key of ['env', 'headers'] as const) {
    const values = config[key]
    if (values === undefined || isJsValue(values)) continue
    if (!isRecord(values)) throw new Error(`${key} 必须是键值对象`)
    for (const [name, value] of Object.entries(values)) {
      const validName = key === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) : /^[A-Za-z0-9_-]+$/u.test(name)
      if (!validName || (typeof value !== 'string' && !isJsValue(value))) throw new Error(`${key} 的键名或值格式无效`)
      if (key === 'headers' && typeof value === 'string' && /[\r\n\0]/u.test(value)) throw new Error('headers 值不能包含换行或 NUL')
    }
  }
  const timeout = config.toolCallTimeoutMs
  if (timeout !== undefined && !isJsValue(timeout) && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0)) {
    throw new Error('toolCallTimeoutMs 必须是正整数毫秒数')
  }
  if (config.failOnStartupError !== undefined && !isJsValue(config.failOnStartupError) && typeof config.failOnStartupError !== 'boolean') {
    throw new Error('failOnStartupError 必须是 true 或 false')
  }
}

/** Literal segments are JSON-quoted, so input cannot inject JavaScript code. */
export function environmentReference(value: string): string | JsValue {
  const matches = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)]
  if (matches.length === 0) return value
  const parts: string[] = []
  let offset = 0
  for (const match of matches) {
    if (match.index > offset) parts.push(JSON.stringify(value.slice(offset, match.index)))
    parts.push(`(process.env.${match[1]} ?? "")`)
    offset = match.index + match[0].length
  }
  if (offset < value.length) parts.push(JSON.stringify(value.slice(offset)))
  return jsValue(parts.join(' + '))
}

/** Blank keeps secrets; ! clears; -KEY removes one key; other lines merge KEY=VALUE. */
export function patchSecretValues(current: unknown, input: string): unknown {
  if (input.trim().length === 0) return current
  if (input.trim() === '!') return {}
  const values: Record<string, unknown> = isRecord(current) && !isJsValue(current) ? { ...current } : {}
  for (const line of input.replaceAll('\r\n', '\n').split('\n').filter((v) => v.trim().length > 0)) {
    if (/^-[A-Za-z0-9_-]+$/u.test(line.trim())) { delete values[line.trim().slice(1)]; continue }
    const equal = line.indexOf('=')
    if (equal <= 0) throw new Error('每行请输入 KEY=VALUE；删除单个键用 -KEY，清空用 !')
    const name = line.slice(0, equal).trim()
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('该键名不可使用')
    values[name] = environmentReference(line.slice(equal + 1))
  }
  return values
}

export function patchMcpField(config: McpConfig, field: McpField, input: string): McpConfig {
  const next = { ...config }
  const trimmed = input.trim()
  if (field === 'env' || field === 'headers') {
    const values = patchSecretValues(config[field], input)
    if (values === undefined) delete next[field]
    else next[field] = values
  } else if (trimmed.length === 0 && isJsValue(config[field])) {
    return next
  } else if (field === 'args') {
    if (trimmed.length === 0 && Array.isArray(config.args) && config.args.some(isJsValue)) return next
    let args: unknown
    try { args = trimmed.length === 0 ? [] : JSON.parse(input) } catch { throw new Error('args 使用 JSON 字符串数组，例如 ["--port", "3000"]') }
    if (!Array.isArray(args) || args.some((v: unknown) => typeof v !== 'string' && !isJsValue(v))) throw new Error('args 必须是 JSON 字符串数组')
    next.args = args
  } else if (field === 'toolCallTimeoutMs') {
    if (trimmed.length === 0) delete next[field]
    else if (!/^[1-9][0-9]*$/u.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) throw new Error('超时须为正整数毫秒数')
    else next[field] = Number(trimmed)
  } else if (field === 'failOnStartupError') {
    if (trimmed.length === 0) delete next[field]
    else if (!['true', 'false'].includes(trimmed)) throw new Error('请输入 true 或 false')
    else next[field] = trimmed === 'true'
  } else if (trimmed.length === 0 && ['cwd', 'url'].includes(field)) {
    delete next[field]
  } else {
    next[field] = input.trim()
  }
  return next
}

export function configChanges(before: McpConfig, after: McpConfig): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort()
}

export function fieldDisplay(config: McpConfig, field: McpField): string {
  const value = config[field]
  if (value === undefined) return '(未设置)'
  if (field === 'env' || field === 'headers') {
    return isJsValue(value) ? '!!js（保留，已隐藏）' : `${Object.keys(isRecord(value) ? value : {}).join(', ') || '(无键)'}（值已隐藏）`
  }
  if (isJsValue(value)) return '!!js（保留）'
  return typeof value === 'string' ? value || '(空)' : JSON.stringify(value)
}

export function fieldInput(config: McpConfig, field: McpField): string {
  if (field === 'env' || field === 'headers' || isJsValue(config[field]) ||
      (field === 'args' && Array.isArray(config.args) && config.args.some(isJsValue))) return ''
  const value = config[field]
  return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
}
