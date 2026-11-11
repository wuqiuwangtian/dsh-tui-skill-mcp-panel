/**
 * MCP patch handling: parse profile/home `cordis.patch.yml` (YAML with `!!js`
 * expressions), identify `@deepseek-ai/dsh-mcp-client` rows, and maintain our
 * legacy "disabled override" block. New toggles edit the definition's boolean
 * field in toggle.ts; the old writer remains for legacy fixtures/recovery.
 *
 * Write policy (ADR-0001): patch text editing is the primary enable/disable
 * path; the official `pluginManager` inventory cannot address rows inserted by
 * a profile patch. Legacy blocks must be migrated, not appended by new toggles.
 */
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
export const TOGGLE_BLOCK_BEGIN = '# >>> dsh-tui-skill-mcp-panel:mcp-toggle:begin'
export const TOGGLE_BLOCK_END = '# <<< dsh-tui-skill-mcp-panel:mcp-toggle:end'
export const MANAGED_BLOCK_VERSION = 1

export interface JsValue {
  __js: string
}

const JS_VALUE_MARK = Symbol.for('dsh-tui-skill-mcp-panel:yaml-js-value')

/** Non-enumerable provenance keeps ordinary `{ __js: ... }` mappings as data. */
export function jsValue(expression: string): JsValue {
  return Object.defineProperty({ __js: expression }, JS_VALUE_MARK, { value: true })
}

export const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  identify: (value: unknown): boolean => isJsValue(value),
  resolve: (value: string): JsValue => jsValue(value),
  stringify: (node: { value: unknown }): string => isJsValue(node.value) ? JSON.stringify(node.value.__js) : '""',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isJsValue(value: unknown): value is JsValue {
  return isRecord(value) && typeof value.__js === 'string' && Object.getOwnPropertyDescriptor(value, JS_VALUE_MARK)?.value === true
}

export interface PatchRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
  disabled?: boolean | JsValue
  /** False for rows inside an `insert:` list, true for row overrides. */
  override: boolean
  order: number
}

export interface ToggleRow {
  id: string
  disabled: boolean
}

export interface ParsedPatch {
  ok: boolean
  rows: PatchRow[]
  toggles: ToggleRow[]
  error?: string
}

function normalizeDisabled(value: unknown): boolean | JsValue | undefined {
  if (typeof value === 'boolean') return value
  if (isJsValue(value)) return value
  return undefined
}

interface ManagedBlock {
  before: string
  rows: ToggleRow[]
  body: string
  after: string
  items: { id?: string; disabled?: boolean; start: number; end: number; owned: boolean }[]
}

/** Standalone markers only. Ambiguous/damaged blocks must never be rewritten. */
function readManagedBlock(text: string): ManagedBlock | undefined {
  const markers = [...text.matchAll(/^# (?:>>>|<<<) dsh-tui-skill-mcp-panel:mcp-toggle:(?:begin|end)(?=\r?$)/gm)]
  if (markers.length === 0) return undefined
  const [begin, end] = markers
  if (markers.length !== 2 || begin?.[0].trimEnd() !== TOGGLE_BLOCK_BEGIN || end?.[0].trimEnd() !== TOGGLE_BLOCK_END) {
    throw new Error('MCP 受管块标记损坏或重复，请手工修复后重试')
  }
  const body = text.slice(begin.index + begin[0].length, end.index)
  const document = parseDocument(body, { customTags: [JS_TAG] })
  if (document.errors.length > 0 || (document.contents !== null && !isSeq(document.contents))) {
    throw new Error('MCP 受管块不是合法 YAML 数组，未修改文件')
  }
  const items: ManagedBlock['items'] = []
  if (isSeq(document.contents)) {
    for (const item of document.contents.items) {
      if (item === null || typeof item !== 'object' || !('range' in item) || item.range == null) {
        throw new Error('MCP 受管块包含无法安全定位的行，未修改文件')
      }
      const start = body.lastIndexOf('\n', item.range[0]) + 1
      if (!/^-\s/u.test(body.slice(start, item.range[0]))) {
        throw new Error('MCP 受管块必须使用顶层列表，未修改文件')
      }
      const raw = item.toJSON() as unknown
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined
      const disabled = isRecord(raw) && typeof raw.disabled === 'boolean' ? raw.disabled : undefined
      const owned = isRecord(raw) && Object.keys(raw).length === 2 && id !== undefined && disabled !== undefined
      items.push({ id, disabled, start, end: item.range[2], owned })
    }
  }
  return {
    before: text.slice(0, begin.index),
    body,
    after: text.slice(end.index + end[0].length),
    rows: items.filter((item) => item.owned).map((item) => ({ id: item.id!, disabled: item.disabled! })),
    items,
  }
}

/** Lenient read for diagnostics; writes use the strict reader above. */
export function extractManagedBlock(
  text: string,
): { before: string; rows: ToggleRow[]; after: string } | undefined {
  try {
    return readManagedBlock(text)
  } catch {
    const begin = text.indexOf(TOGGLE_BLOCK_BEGIN)
    const end = text.indexOf(TOGGLE_BLOCK_END, begin)
    if (begin < 0 || end < 0) return undefined
    return { before: text.slice(0, begin), rows: [], after: text.slice(end + TOGGLE_BLOCK_END.length) }
  }
}

/** Parse a patch text (missing/empty → empty array) and detect MCP rows + our block. */
export function parsePatchText(text: string): ParsedPatch {
  const source = text.trim().length === 0 ? '[]' : text
  let document
  try {
    document = parseDocument(source, { customTags: [JS_TAG] })
  } catch (error) {
    return { ok: false, rows: [], toggles: [], error: 'YAML 解析失败，请检查文件语法' }
  }
  const firstError = document.errors[0]
  if (firstError !== undefined) return { ok: false, rows: [], toggles: [], error: `YAML 解析失败（${firstError.code}）；请手工检查语法` }
  let data: unknown
  try {
    data = document.contents === null ? [] : document.toJS()
  } catch (error) {
    return { ok: false, rows: [], toggles: [], error: 'YAML 转换失败，请检查别名或文件结构' }
  }
  if (!Array.isArray(data)) {
    return { ok: false, rows: [], toggles: [], error: 'patch 文件必须是 YAML 数组' }
  }
  const rows: PatchRow[] = []
  data.forEach((item, order) => {
    if (!isRecord(item)) return
    if (Array.isArray(item.insert)) {
      for (const raw of item.insert) {
        if (!isRecord(raw)) continue
        rows.push({
          ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
          ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
          ...(isRecord(raw.config) ? { config: raw.config } : {}),
          ...(normalizeDisabled(raw.disabled) === undefined
            ? {}
            : { disabled: normalizeDisabled(raw.disabled) as boolean | JsValue }),
          override: false,
          order,
        })
      }
      return
    }
    rows.push({
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(isRecord(item.config) ? { config: item.config } : {}),
      ...(normalizeDisabled(item.disabled) === undefined
        ? {}
        : { disabled: normalizeDisabled(item.disabled) as boolean | JsValue }),
      override: true,
      order,
    })
  })
  const toggles = extractManagedBlock(text)?.rows ?? []
  return { ok: true, rows, toggles }
}

/** Validate a candidate patch text (used before every write). */
export function validatePatchText(text: string): { ok: true } | { ok: false; error: string } {
  const parsed = parsePatchText(text)
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error ?? 'unknown parse error' }
}

/**
 * Set the desired disabled state without editing the user's original row.
 * A false override enables originally-disabled rows. Returning to the original
 * state removes our override. Foreign items and bytes outside the block survive.
 */
export function upsertManagedToggle(
  text: string,
  id: string,
  disabled: boolean,
): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  try {
    if (id.length === 0 || /[\r\n\0]/u.test(id)) throw new Error('MCP 行 id 非法')
    const original = validatePatchText(text)
    if (!original.ok) throw new Error('原 patch YAML 非法，未修改文件')
    const existing = readManagedBlock(text)
    const baseline = parsePatchText(existing === undefined ? text : `${existing.before}${existing.after}`)
    let baselineDisabled: boolean | JsValue = false
    for (const row of baseline.rows) {
      if (row.id === id && row.disabled !== undefined) baselineDisabled = row.disabled
    }
    if (isJsValue(baselineDisabled)) throw new Error('disabled 由 !!js 表达式控制，请手工编辑')
    const targets = existing?.items.filter((item) => item.id === id) ?? []
    if (targets.length > 1 || targets.some((item) => !item.owned)) {
      throw new Error('MCP 受管块中目标行重复或含外来字段，请手工修复')
    }
    const target = targets[0]
    const needsOverride = disabled !== baselineDisabled
    if ((!needsOverride && target === undefined) || (needsOverride && target?.disabled === disabled)) {
      let currentDisabled: boolean | JsValue = false
      for (const row of parsePatchText(text).rows) {
        if (row.id === id && row.disabled !== undefined) currentDisabled = row.disabled
      }
      if (currentDisabled !== disabled) throw new Error('目标行被受管块之后的配置覆盖，请手工编辑或刷新')
      return { ok: true, text, changed: false }
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const rendered = `- id: ${JSON.stringify(id)}${eol}  disabled: ${disabled}${eol}`
    let next: string
    if (existing === undefined) {
      next = `${text}${text.length === 0 ? '' : eol}${TOGGLE_BLOCK_BEGIN}${eol}${rendered}${TOGGLE_BLOCK_END}`
    } else {
      let body = existing.body
      if (target !== undefined) {
        body = `${body.slice(0, target.start)}${needsOverride ? rendered : ''}${body.slice(target.end)}`
      } else {
        body = `${body}${body.endsWith('\n') ? '' : eol}${rendered}`
      }
      if (body.trim().length === 0) {
        const before = existing.after.length === 0 && existing.before.endsWith(eol)
          ? existing.before.slice(0, -eol.length)
          : existing.before
        next = `${before}${existing.after}`
      } else {
        next = `${existing.before}${TOGGLE_BLOCK_BEGIN}${body}${TOGGLE_BLOCK_END}${existing.after}`
      }
    }

    const validation = validatePatchText(next)
    if (!validation.ok) throw new Error('写入后 YAML 校验失败，未修改文件')
    let effectiveDisabled: boolean | JsValue = false
    for (const row of parsePatchText(next).rows) {
      if (row.id === id && row.disabled !== undefined) effectiveDisabled = row.disabled
    }
    if (effectiveDisabled !== disabled) throw new Error('目标行被受管块之后的配置覆盖，请手工编辑或刷新')
    return { ok: true, text: next, changed: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read our managed toggles from a patch text (convenience for diagnostics/tests). */
export function readManagedToggles(text: string): ToggleRow[] {
  return extractManagedBlock(text)?.rows ?? []
}

/** Strict inventory for explicit migration; diagnostics may use the lenient reader. */
export function legacyMcpToggles(text: string): ToggleRow[] {
  return readManagedBlock(text)?.rows ?? []
}

/** Remove only an unambiguous legacy two-field row, retaining foreign bytes. */
export function removeLegacyMcpToggle(text: string, id: string): string {
  const block = readManagedBlock(text)
  if (block === undefined) return text
  const targets = block.items.filter((item) => item.id === id)
  if (targets.length === 0) return text
  if (targets.length !== 1 || !targets[0]!.owned) throw new Error('旧启停覆盖重复或含外来字段，请手工合并')
  const target = targets[0]!
  const doc = parseDocument(block.body, { customTags: [JS_TAG] })
  if (doc.warnings.length > 0 || !isSeq(doc.contents)) throw new Error('旧启停覆盖含不支持的 YAML，未修改文件')
  const node = doc.contents.items.find((item) => item?.range?.[2] === target.end)
  // Comments attached to a removed row must not silently disappear. Unusual
  // hand-edited legacy rows are left for explicit manual merging instead.
  if (!isMap(node) || node.anchor || node.flow || node.comment || node.items.some((pair) =>
    !isScalar(pair.key) || !isScalar(pair.value) || pair.key.comment || pair.key.commentBefore || pair.value.comment ||
    pair.value.commentBefore || pair.key.anchor || pair.value.anchor || pair.value.tag)) {
    throw new Error('旧启停覆盖含注释、别名或特殊格式，请手工合并；原文件保留')
  }
  const body = block.body.slice(0, target.start) + block.body.slice(target.end)
  if (body.trim().length > 0) return `${block.before}${TOGGLE_BLOCK_BEGIN}${body}${TOGGLE_BLOCK_END}${block.after}`
  return block.before + block.after
}

export interface LoaderMcpRow {
  id: string
  config?: Record<string, unknown>
  disabled: boolean
  phase?: string
}

export interface McpRowView {
  id: string
  entryId: string
  serverName: string
  transport: string
  enabled: boolean
  layer: 'profile' | 'home' | 'bundle'
  /** True when this row can be toggled by editing the profile patch. */
  targetable: boolean
  readOnlyReason?: string
  overriddenByHome: boolean
  disabledExpression?: string
  phase?: string
  config?: Record<string, unknown>
  notes: string[]
  /** CRUD is deliberately limited to this panel's inserts. Toggle is separate. */
  managed?: boolean
  editReadOnlyReason?: string
}

function lastRowFor(rows: PatchRow[], id: string): PatchRow | undefined {
  return [...rows].reverse().find((row) => row.id === id)
}

function disabledFor(rows: PatchRow[], id: string): PatchRow['disabled'] {
  return [...rows].reverse().find((row) => row.id === id && row.disabled !== undefined)?.disabled
}

/** Combine loader runtime rows with profile/home patches into the panel model. */
export function buildMcpRows(input: {
  loaderRows: LoaderMcpRow[]
  profileRows: PatchRow[]
  homeRows: PatchRow[]
}): McpRowView[] {
  const views = input.loaderRows.map<McpRowView>((loaderRow) => {
    const profileRow = lastRowFor(input.profileRows, loaderRow.id)
    const homeRow = lastRowFor(input.homeRows, loaderRow.id)
    const layer: McpRowView['layer'] = homeRow !== undefined ? 'home' : profileRow !== undefined ? 'profile' : 'bundle'
    const config = loaderRow.config ?? homeRow?.config ?? profileRow?.config
    const disabledValue = disabledFor(input.homeRows, loaderRow.id) ?? disabledFor(input.profileRows, loaderRow.id)
    const disabledExpression = isJsValue(disabledValue) ? disabledValue.__js : undefined
    const notes: string[] = []
    let readOnlyReason: string | undefined
    if (layer === 'home') {
      readOnlyReason = 'home 层（跨 profile 全局层）只读；请手工编辑 ~/.dsh/cordis.patch.yml'
      notes.push('home 层覆盖同名 profile 行')
    } else if (layer === 'bundle') {
      readOnlyReason = '该行来自 bundle/其他来源，本面板不管理'
    } else if (disabledExpression !== undefined) {
      readOnlyReason = 'disabled 由 !!js 表达式控制，不提供布尔开关'
      notes.push(`!!js ${disabledExpression}`)
    }
    if (layer === 'home' && homeRow?.disabled === true) notes.push('home 层已停用')
    return {
      id: loaderRow.id,
      entryId: loaderRow.id,
      serverName:
        typeof config?.serverName === 'string' && config.serverName.length > 0 ? config.serverName : loaderRow.id,
      transport: typeof config?.transport === 'string' ? config.transport : 'unknown',
      enabled: !loaderRow.disabled,
      layer,
      targetable: layer === 'profile' && disabledExpression === undefined,
      ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
      overriddenByHome: layer === 'home',
      ...(disabledExpression === undefined ? {} : { disabledExpression }),
      ...(loaderRow.phase === undefined ? {} : { phase: loaderRow.phase }),
      ...(config === undefined ? {} : { config }),
      notes,
    }
  })
  return views.sort(
    (left, right) =>
      left.serverName.localeCompare(right.serverName) || left.id.localeCompare(right.id),
  )
}

const MASK = '***'

/** One-line, credential-free summary of MCP config fields. */
export function describeMcpConfig(config: Record<string, unknown> | undefined): string[] {
  if (config === undefined) return ['（无配置信息：该行可能由 bundle 提供）']
  const lines: string[] = []
  const scalar = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : isJsValue(value)
        ? '!!js（表达式，已隐藏）'
        : undefined
  const transport = scalar(config.transport)
  if (transport !== undefined) lines.push(`transport ${transport}`)
  const serverName = scalar(config.serverName)
  if (serverName !== undefined) lines.push(`serverName ${serverName}`)
  const command = scalar(config.command)
  if (command !== undefined) lines.push(`command ${command}`)
  if (Array.isArray(config.args)) {
    const args = config.args.map((arg) => (typeof arg === 'string' ? arg : MASK))
    lines.push(`args ${args.join(' ')}`)
  }
  const cwd = scalar(config.cwd)
  if (cwd !== undefined) lines.push(`cwd ${cwd}`)
  const url = scalar(config.url)
  if (url !== undefined) lines.push(`url ${url}`)
  if (isRecord(config.env)) lines.push(`env keys ${Object.keys(config.env).join(', ') || '(none)'}（值已隐藏）`)
  if (isRecord(config.headers)) {
    lines.push(`headers keys ${Object.keys(config.headers).join(', ') || '(none)'}（值已隐藏）`)
  }
  for (const key of ['toolCallTimeoutMs', 'failOnStartupError']) {
    const value = scalar(config[key])
    if (value !== undefined) lines.push(`${key} ${value}`)
  }
  return lines
}

/** Replace env/header values with masks (used in detail text). */
export function maskSecretConfig(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (config === undefined) return undefined
  const guarded = ['env', 'headers']
  const next: Record<string, unknown> = { ...config }
  for (const key of guarded) {
    const value = config[key]
    if (isRecord(value)) {
      next[key] = Object.fromEntries(Object.keys(value).map((name) => [name, MASK]))
    }
  }
  return next
}

/** A failed backup is a failed write, never permission to continue without recovery. */
export async function backupPatchFile(patchPath: string, backupDir: string): Promise<string> {
  const target = join(backupDir, 'cordis.patch.yml')
  await mkdir(backupDir, { recursive: true, mode: 0o700 })
  await copyFile(patchPath, target)
  await chmod(target, 0o600)
  return target
}

/** Atomic patch write (same directory temp file + rename). */
export async function writePatchFileAtomic(
  patchPath: string,
  text: string,
  beforeCommit?: () => Promise<unknown>,
): Promise<void> {
  await mkdir(dirname(patchPath), { recursive: true })
  const info = await stat(patchPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  const tmp = `${patchPath}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: info === undefined ? 0o600 : info.mode & 0o777 })
    // chmod avoids narrowing an existing file's permissions through the process umask.
    if (info !== undefined) await chmod(tmp, info.mode & 0o777)
    await beforeCommit?.()
    await rename(tmp, patchPath)
  } finally {
    await rm(tmp, { force: true })
  }
}
