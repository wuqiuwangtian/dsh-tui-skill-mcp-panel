/**
 * MCP patch handling: parse profile/home `cordis.patch.yml` (YAML with `!!js`
 * expressions), identify `@deepseek-ai/dsh-mcp-client` rows, and maintain our
 * own "disabled override" managed block without touching any other byte.
 *
 * Write policy (ADR-0001): patch text editing is the primary enable/disable
 * path; the official `pluginManager` inventory cannot address rows inserted by
 * a profile patch. Our block only ever contains `- id: …` / `disabled: true`
 * rows appended after the user's content, so composition order makes them win.
 */
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'

export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
export const TOGGLE_BLOCK_BEGIN = '# >>> dsh-tui-skill-mcp-panel:mcp-toggle:begin'
export const TOGGLE_BLOCK_END = '# <<< dsh-tui-skill-mcp-panel:mcp-toggle:end'
export const MANAGED_BLOCK_VERSION = 1

export interface JsValue {
  __js: string
}

const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string): JsValue => ({ __js: value }),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isJsValue(value: unknown): value is JsValue {
  return isRecord(value) && typeof value.__js === 'string'
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

/** Extract our managed toggle block from a patch text (lenient; malformed block ignored). */
export function extractManagedBlock(
  text: string,
): { before: string; rows: ToggleRow[]; after: string } | undefined {
  const begin = text.indexOf(TOGGLE_BLOCK_BEGIN)
  if (begin < 0) return undefined
  const end = text.indexOf(TOGGLE_BLOCK_END, begin)
  if (end < 0) return undefined
  const body = text.slice(begin + TOGGLE_BLOCK_BEGIN.length, end)
  const rows: ToggleRow[] = []
  try {
    const parsed = parseYaml(body) as unknown
    if (Array.isArray(parsed)) {
      for (const raw of parsed) {
        if (!isRecord(raw)) continue
        if (typeof raw.id !== 'string' || raw.id.length === 0) continue
        rows.push({ id: raw.id, disabled: raw.disabled === true })
      }
    }
  } catch {
    // malformed block → treat as empty; a later write rewrites it
  }
  return {
    before: text.slice(0, begin),
    rows,
    after: text.slice(end + TOGGLE_BLOCK_END.length),
  }
}

function renderManagedBlock(rows: ToggleRow[]): string {
  const lines = [TOGGLE_BLOCK_BEGIN]
  for (const row of rows) {
    lines.push(`- id: ${row.id}`, `  disabled: ${row.disabled ? 'true' : 'false'}`)
  }
  lines.push(TOGGLE_BLOCK_END)
  return `${lines.join('\n')}`
}

/** Parse a patch text (missing/empty → empty array) and detect MCP rows + our block. */
export function parsePatchText(text: string): ParsedPatch {
  const source = text.trim().length === 0 ? '[]' : text
  let document
  try {
    document = parseDocument(source, { customTags: [JS_TAG] })
  } catch (error) {
    return { ok: false, rows: [], toggles: [], error: error instanceof Error ? error.message : String(error) }
  }
  const firstError = document.errors[0]
  if (firstError !== undefined) return { ok: false, rows: [], toggles: [], error: firstError.message }
  let data: unknown
  try {
    data = document.toJS()
  } catch (error) {
    return { ok: false, rows: [], toggles: [], error: error instanceof Error ? error.message : String(error) }
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
 * Add/remove our `disabled: true` override for one row id. `disabled=true` adds
 * (or keeps) the row; `false` removes it. Bytes outside the managed block are
 * preserved verbatim; the result is validated as YAML before being returned.
 */
export function upsertManagedToggle(
  text: string,
  id: string,
  disabled: boolean,
): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const existing = extractManagedBlock(text)
  const current = existing?.rows ?? []
  const has = current.some((row) => row.id === id)
  if (disabled === has) return { ok: true, text, changed: false }

  const rows = disabled
    ? [...current.filter((row) => row.id !== id), { id, disabled: true }]
    : current.filter((row) => row.id !== id)

  let next: string
  if (existing !== undefined) {
    if (rows.length === 0) {
      // Removing the last toggle: drop the separator newline we added at insert
      // so a toggle on/off round-trip restores the exact original bytes.
      const trimmed = existing.after.trim().length === 0 && existing.before.endsWith('\n')
        ? existing.before.slice(0, -1)
        : existing.before
      next = `${trimmed}${existing.after}`
    } else {
      next = `${existing.before}${renderManagedBlock(rows)}${existing.after}`
    }
  } else if (rows.length > 0) {
    const prefix = text.length === 0 ? '' : `${text}\n`
    next = `${prefix}${renderManagedBlock(rows)}`
  } else {
    next = text
  }

  const validation = validatePatchText(next)
  if (!validation.ok) return { ok: false, error: `写入后 YAML 校验失败：${validation.error}` }
  return { ok: true, text: next, changed: true }
}

/** Read our managed toggles from a patch text (convenience for diagnostics/tests). */
export function readManagedToggles(text: string): ToggleRow[] {
  return extractManagedBlock(text)?.rows ?? []
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
}

function lastRowFor(rows: PatchRow[], id: string): PatchRow | undefined {
  return [...rows].reverse().find((row) => row.id === id)
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
    const config = loaderRow.config ?? profileRow?.config ?? homeRow?.config
    const disabledValue = homeRow?.disabled ?? profileRow?.disabled
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

/** Backup a patch file before a write; returns the backup path (or undefined on failure). */
export async function backupPatchFile(patchPath: string, backupDir: string): Promise<string | undefined> {
  if (!existsSync(patchPath)) return undefined
  const target = join(backupDir, 'cordis.patch.yml')
  try {
    await mkdir(backupDir, { recursive: true })
    await copyFile(patchPath, target)
    return target
  } catch {
    return undefined
  }
}

/** Atomic patch write (same directory temp file + rename). */
export async function writePatchFileAtomic(patchPath: string, text: string): Promise<void> {
  await mkdir(dirname(patchPath), { recursive: true })
  const tmp = `${patchPath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, patchPath)
}
