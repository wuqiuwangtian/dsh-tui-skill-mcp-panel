/**
 * Skill groups — shared display metadata, v1-compatible with the web panel
 * (`dsh-skill-mcp-panel` 2.3.7) at `$DSH_HOME/skills/.system/skill-viewer/groups.json`:
 *
 *   { "version": 1, "groups": {
 *       "<groupId>": { "name": "组名", "scopes": { "global": ["a"], "<projectRoot>": ["b"] } } } }
 *
 * Members are `(scope, skillName)` pairs; the same name in global and workspace
 * can belong to different groups. Writes require a loaded snapshot; corruption
 * recovery preserves exact bytes and never renames the shared source during reads.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { withPatchLock } from './mcp/write.js'
import { writePatchFileAtomic } from './mcp/patch.js'
import { dirname, join } from 'node:path'

export const GROUPS_VERSION = 1

export interface SkillGroup {
  name: string
  /** scope key → skill names. `global` or the project root path. */
  scopes: Record<string, string[]>
}

export type SkillGroups = Record<string, SkillGroup>

export interface LoadGroupsResult {
  groups: SkillGroups
  fingerprint: string
  writable: boolean
  /** Present for corruption recovery or records hidden from the view. */
  warning?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse the on-disk JSON shape into groups; unknown/invalid entries are dropped. */
export function parseGroupsPayload(parsed: unknown): SkillGroups {
  if (!isRecord(parsed) || !isRecord(parsed.groups)) return {}
  const groups: SkillGroups = Object.create(null) as SkillGroups
  for (const [id, raw] of Object.entries(parsed.groups)) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.trim().length === 0) continue
    const scopes: Record<string, string[]> = Object.create(null) as Record<string, string[]>
    if (isRecord(raw.scopes)) {
      for (const [scope, names] of Object.entries(raw.scopes)) {
        if (Array.isArray(names)) scopes[scope] = names.filter((name): name is string => typeof name === 'string')
      }
    }
    groups[id] = { name: raw.name, scopes: Object.fromEntries(Object.entries(scopes)) }
  }
  return Object.fromEntries(Object.entries(groups))
}

export class GroupsConflictError extends Error {
  constructor(message = '共享技能分组文件已变化，请按 R 刷新后重试；未覆盖外部改动') {
    super(message)
    this.name = 'GroupsConflictError'
  }
}

interface GroupsDocument extends LoadGroupsResult {
  bytes: Buffer
  raw: Record<string, unknown>
  corrupt?: boolean
}

async function readGroupsDocument(filePath: string): Promise<GroupsDocument> {
  const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (info !== undefined && !info.isFile()) return { groups: {}, fingerprint: 'non-regular', writable: false, bytes: Buffer.alloc(0), raw: {},
    warning: '共享技能分组路径不是普通文件（含符号链接）；已只读，请手工检查 groups.json' }
  let bytes: Buffer
  try { bytes = await readFile(filePath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { groups: {}, fingerprint: 'missing', writable: true, bytes: Buffer.alloc(0), raw: {} }
  }
  const fingerprint = createHash('sha256').update('file\0').update(bytes).digest('hex')
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown } catch {
    return { groups: {}, fingerprint, writable: false, bytes, raw: {}, corrupt: true,
      warning: '共享技能分组文件损坏，回退空视图；原文件保留' }
  }
  if (!isRecord(parsed) || !isRecord(parsed.groups)) return { groups: {}, fingerprint, writable: false, bytes, raw: {},
    warning: '共享技能分组结构无效，原文件保留；请手工检查 groups.json 后刷新' }
  if (parsed.version !== undefined && parsed.version !== GROUPS_VERSION) return { groups: {}, fingerprint, writable: false, bytes, raw: parsed,
    warning: '共享技能分组版本不受支持，原文件保留；请使用匹配版本或手工迁移' }
  const groups = parseGroupsPayload(parsed)
  const invalid = Object.values(parsed.groups).some((raw) => !isRecord(raw) || typeof raw.name !== 'string' || !raw.name.trim()
    || !isRecord(raw.scopes) || Object.values(raw.scopes).some((names) => !Array.isArray(names) || names.some((name) => typeof name !== 'string')))
  return { groups, fingerprint, writable: true, bytes, raw: parsed,
    ...(invalid ? { warning: '部分共享技能分组记录无效，仅显示可识别部分；写入保留未编辑数据' } : {}) }
}

const view = (document: GroupsDocument): LoadGroupsResult => ({ groups: document.groups, fingerprint: document.fingerprint,
  writable: document.writable, ...(document.warning === undefined ? {} : { warning: document.warning }) })

/** Deterministic recovery copy: repeated refreshes do not multiply corrupt backups. */
async function backupCorrupt(filePath: string, document: GroupsDocument): Promise<string> {
  const backup = `${filePath}.corrupt-${document.fingerprint}`
  try { await writeFile(backup, document.bytes, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const info = await lstat(backup)
    if (!info.isFile() || !(await readFile(backup)).equals(document.bytes)) throw new Error('损坏分组备份不可用')
  }
  return backup
}

/** Missing → empty; malformed JSON → exact backup + empty view; read errors stay errors. */
export async function loadGroups(filePath: string): Promise<LoadGroupsResult> {
  const first = await readGroupsDocument(filePath)
  if (!first.corrupt) return view(first)
  return withPatchLock(filePath, async () => {
    // A lockless web writer may have repaired/replaced the source since the first read.
    const current = await readGroupsDocument(filePath)
    if (!current.corrupt) return view(current)
    try {
      const backup = await backupCorrupt(filePath, current)
      return { ...view(current), writable: true, warning: `共享技能分组文件损坏，已备份并回退空视图：${backup}；原文件保留，后续保存前仍会核对快照` }
    } catch {
      return { ...view(current), warning: '共享技能分组文件损坏且备份失败，已只读；原文件未修改，请检查目录权限后刷新' }
    }
  }, { resourceName: 'groups.json' })
}

/** Preserve foreign/unknown fields, including malformed records outside the edited keys. */
function mergeDocument(document: GroupsDocument, next: SkillGroups): Record<string, unknown> {
  const rawGroups = Object.assign(Object.create(null) as Record<string, unknown>, document.raw.groups)
  for (const id of Object.keys(document.groups)) if (!Object.hasOwn(next, id)) delete rawGroups[id]
  for (const [id, group] of Object.entries(next)) {
    const before = Object.hasOwn(document.groups, id) ? document.groups[id] : undefined
    if (JSON.stringify(before) === JSON.stringify(group)) continue
    const rawGroup = isRecord(rawGroups[id]) ? rawGroups[id] : {}
    if (before !== undefined && JSON.stringify(before.scopes) === JSON.stringify(group.scopes)) {
      // A rename must not normalize a missing/malformed scopes container.
      rawGroups[id] = { ...rawGroup, name: group.name }
      continue
    }
    const scopes = Object.assign(Object.create(null) as Record<string, unknown>, isRecord(rawGroup.scopes) ? rawGroup.scopes : {})
    for (const scope of Object.keys(before?.scopes ?? {})) if (!Object.hasOwn(group.scopes, scope)) delete scopes[scope]
    for (const [scope, members] of Object.entries(group.scopes)) {
      if (JSON.stringify(before?.scopes[scope]) !== JSON.stringify(members)) scopes[scope] = members
    }
    rawGroups[id] = { ...rawGroup, name: group.name, scopes }
  }
  return { ...document.raw, version: GROUPS_VERSION, groups: rawGroups }
}

export interface SaveGroupsOptions {
  expectedFingerprint: string
  backupRoot: string
  /** Optional additional precommit work, followed by the mandatory snapshot check. */
  beforeCommit?: () => Promise<void>
}

/** Cooperative writers serialize; stale snapshots and late lockless writes are refused. */
export async function saveGroups(filePath: string, groups: SkillGroups, options: SaveGroupsOptions): Promise<LoadGroupsResult & { changed: boolean; backupPath?: string }> {
  await mkdir(dirname(filePath), { recursive: true })
  return withPatchLock(filePath, async () => {
    const current = await readGroupsDocument(filePath)
    if (current.fingerprint !== options.expectedFingerprint) throw new GroupsConflictError()
    if (current.corrupt) await backupCorrupt(filePath, current)
    else if (!current.writable) throw new Error(current.warning)
    if (!current.corrupt && JSON.stringify(current.groups) === JSON.stringify(groups)) return { ...view(current), changed: false }
    if (JSON.stringify(parseGroupsPayload({ groups })) !== JSON.stringify(groups)) throw new Error('拟写入的技能分组数据无效；未修改文件')
    for (const [id, group] of Object.entries(groups)) if (!Object.hasOwn(current.groups, id) || current.groups[id]?.name !== group.name) checkedGroupName(group.name)
    const raw = mergeDocument(current, groups)
    const text = `${JSON.stringify(raw, undefined, 2)}\n`
    let backupPath: string | undefined
    if (current.fingerprint !== 'missing') {
      try {
        const backupDir = join(options.backupRoot, 'skill-groups', randomUUID())
        await mkdir(backupDir, { recursive: true, mode: 0o700 })
        backupPath = join(backupDir, 'groups.json')
        await writeFile(backupPath, current.bytes, { flag: 'wx', mode: 0o600 })
      } catch { throw new Error('共享技能分组备份失败，已停止写入；请检查备份目录权限或磁盘空间') }
    }
    await writePatchFileAtomic(filePath, text, async () => {
      await options.beforeCommit?.()
      const latest = await readGroupsDocument(filePath)
      if (latest.fingerprint !== current.fingerprint) throw new GroupsConflictError()
      if (!latest.corrupt && !latest.writable) throw new Error(latest.warning)
    })
    const saved = await readGroupsDocument(filePath)
    const fingerprint = createHash('sha256').update('file\0').update(text).digest('hex')
    if (saved.fingerprint !== fingerprint) throw new GroupsConflictError('共享技能分组保存后被再次修改，请按 R 刷新并检查备份；不要重复覆盖')
    return { ...view(saved), changed: true, backupPath }
  }, { resourceName: 'groups.json' })
}

/** Group ids containing `(scopeKey, skillName)`. */
export function groupIdsForSkill(groups: SkillGroups, scopeKey: string, skillName: string): string[] {
  return Object.entries(groups)
    .filter(([, group]) => (Object.hasOwn(group.scopes, scopeKey) ? group.scopes[scopeKey] ?? [] : []).includes(skillName))
    .map(([id]) => id)
}

function checkedGroupName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('分组名称不能为空')
  if (Array.from(trimmed).length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) throw new Error('分组名称最多 80 字符，不能包含控制字符')
  return trimmed
}

/** Pure create/update: unique case-insensitive name; empty `names` removes the scope. */
export function upsertGroup(
  groups: SkillGroups,
  id: string | undefined,
  name: string,
  scopeKey: string,
  names: string[],
): { groups: SkillGroups; id: string } {
  const trimmed = checkedGroupName(name)
  for (const [existingId, group] of Object.entries(groups)) {
    if (existingId !== id && group.name.toLowerCase() === trimmed.toLowerCase()) {
      throw new Error(`分组名 "${trimmed}" 已存在`)
    }
  }
  const next: SkillGroups = { ...groups }
  if (id !== undefined && !Object.hasOwn(groups, id)) throw new Error('分组已不存在，请刷新后重试')
  const targetId = id ?? `g-${randomUUID()}`
  const existing = next[targetId] ?? { name: trimmed, scopes: {} }
  const scopes = Object.assign(Object.create(null) as Record<string, string[]>, existing.scopes)
  const unique = [...new Set(names.filter((entry) => entry.length > 0))]
  if (unique.length === 0) delete scopes[scopeKey]
  else scopes[scopeKey] = unique
  next[targetId] = { name: trimmed, scopes: Object.fromEntries(Object.entries(scopes)) }
  return { groups: next, id: targetId }
}

export function deleteGroup(groups: SkillGroups, id: string): SkillGroups {
  if (groups[id] === undefined) return groups
  const next = { ...groups }
  delete next[id]
  return next
}

/** Add/remove a skill name from a group's scope list (no-op when already in desired state). */
export function setGroupMembership(
  groups: SkillGroups,
  id: string,
  scopeKey: string,
  skillName: string,
  member: boolean,
): SkillGroups {
  const group = groups[id]
  if (group === undefined || !Object.hasOwn(groups, id)) throw new Error(`分组不存在：${id}`)
  const names = new Set(Object.hasOwn(group.scopes, scopeKey) ? group.scopes[scopeKey] ?? [] : [])
  if (member) names.add(skillName)
  else names.delete(skillName)
  return upsertGroup(groups, id, group.name, scopeKey, [...names]).groups
}

/** Total member count across scopes. */
export function groupMemberCount(group: SkillGroup): number {
  return Object.values(group.scopes).reduce((sum, names) => sum + names.length, 0)
}
