/** Rebase a confirmed operation onto fresh files; never restore a stale document. */
import { lstat } from 'node:fs/promises'
import { openMcpEditor, type McpEditSession } from './crud.js'
import { isRecord, validateMcpConfig, type McpConfig } from './model.js'
import { isJsValue, jsValue, parsePatchText } from './patch.js'
import { editMcpDisabled } from './toggle.js'
import { readPatchSnapshot, type TogglePatchInput } from './write.js'

export type McpWriteIntent =
  | { kind: 'save'; session: McpEditSession; config: McpConfig }
  | { kind: 'delete'; session: McpEditSession }
  | { kind: 'toggle'; input: TogglePatchInput }

export interface McpConflictPlan {
  intent: McpWriteIntent
  fields: string[]
  externalFields: string[]
}

/** structuredClone/JSON would erase the provenance of real !!js values. */
export function copyMcpIntent<T>(value: T): T {
  const seen = new WeakMap<object, unknown>()
  const copy = (item: unknown): unknown => {
    if (isJsValue(item)) return jsValue(item.__js)
    if (!isRecord(item) && !Array.isArray(item)) return item
    if (seen.has(item)) return seen.get(item)
    const result = Array.isArray(item) ? [] : {}
    seen.set(item, result)
    for (const [key, child] of Object.entries(item)) {
      Object.defineProperty(result, key, { value: copy(child), writable: true, enumerable: true, configurable: true })
    }
    return result
  }
  return copy(value) as T
}

function equal(left: unknown, right: unknown): boolean {
  if (isJsValue(left) !== isJsValue(right)) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

function changed(before: McpConfig, after: McpConfig): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !equal(before[key], after[key])).sort()
}

function mergeDraft(base: McpConfig, draft: McpConfig, latest: McpConfig): McpConfig {
  const next = copyMcpIntent(latest)
  for (const key of changed(base, draft)) {
    // A secret form edits individual keys. Preserve keys added by another editor.
    if ((key === 'env' || key === 'headers') && (base[key] === undefined || (isRecord(base[key]) && !isJsValue(base[key]))) &&
        isRecord(draft[key]) && !isJsValue(draft[key])) {
      if (latest[key] !== undefined && (!isRecord(latest[key]) || isJsValue(latest[key]))) {
        throw new Error(`${key} 的结构已变化，无法合并；请重新加载后编辑`)
      }
      const values = copyMcpIntent((latest[key] ?? {}) as McpConfig)
      for (const name of changed((base[key] ?? {}) as McpConfig, draft[key])) {
        if (Object.hasOwn(draft[key], name)) values[name] = copyMcpIntent(draft[key][name])
        else delete values[name]
      }
      next[key] = values
    } else if (Object.hasOwn(draft, key)) next[key] = copyMcpIntent(draft[key])
    else delete next[key]
  }
  validateMcpConfig(next)
  return next
}

/** Read-only preview; ordinary guarded writers must still check these hashes. */
export async function prepareMcpConflict(intent: McpWriteIntent): Promise<McpConflictPlan> {
  const files = intent.kind === 'toggle' ? intent.input : intent.session
  const info = await lstat(files.patchPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (info !== undefined && !info.isFile()) throw new Error('profile patch 必须是普通文件；符号链接请手工编辑')
  const [profile, home] = await Promise.all([readPatchSnapshot(files.patchPath), readPatchSnapshot(files.homePatchPath)])
  if (!parsePatchText(profile.text).ok || !parsePatchText(home.text).ok) throw new Error('profile/home patch YAML 非法，请修复后重试')
  const fresh = { patchPath: files.patchPath, homePatchPath: files.homePatchPath,
    expectedProfile: profile.fingerprint, expectedHome: home.fingerprint }
  if (intent.kind === 'toggle') {
    if (parsePatchText(home.text).rows.some(row => row.id === intent.input.id)) throw new Error('home 层控制目标，该行只读；请重新加载')
    editMcpDisabled(profile.text, intent.input, intent.input.disabled)
    return { intent: { kind: 'toggle', input: { ...intent.input, ...fresh } }, fields: ['disabled'], externalFields: [] }
  }
  const target = intent.session.id === undefined ? undefined : { id: intent.session.id, serverName: intent.session.serverName ?? '' }
  const session = await openMcpEditor(fresh, target)
  const externalFields = changed(intent.session.config, session.config)
  if (intent.kind === 'delete') return { intent: { kind: 'delete', session }, fields: ['删除目标行'], externalFields }
  const config = target === undefined ? copyMcpIntent(intent.config) : mergeDraft(intent.session.config, intent.config, session.config)
  return { intent: { kind: 'save', session, config }, fields: changed(intent.session.config, intent.config), externalFields }
}
