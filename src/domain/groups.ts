/**
 * Skill groups — shared display metadata, byte-compatible with the web panel
 * (`dsh-skill-mcp-panel` 2.3.7) at `$DSH_HOME/skills/.system/skill-viewer/groups.json`:
 *
 *   { "version": 1, "groups": {
 *       "<groupId>": { "name": "组名", "scopes": { "global": ["a"], "<projectRoot>": ["b"] } } } }
 *
 * Members are `(scope, skillName)` pairs; the same name in global and workspace
 * can belong to different groups. Corrupt files are backed up and treated as empty.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const GROUPS_VERSION = 1

export interface SkillGroup {
  name: string
  /** scope key → skill names. `global` or the project root path. */
  scopes: Record<string, string[]>
}

export type SkillGroups = Record<string, SkillGroup>

export interface LoadGroupsResult {
  groups: SkillGroups
  /** Present when the file existed but was corrupt (backed up, treated as empty). */
  warning?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse the on-disk JSON shape into groups; unknown/invalid entries are dropped. */
export function parseGroupsPayload(parsed: unknown): SkillGroups {
  if (!isRecord(parsed) || !isRecord(parsed.groups)) return {}
  const groups: SkillGroups = {}
  for (const [id, raw] of Object.entries(parsed.groups)) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.trim().length === 0) continue
    const scopes: Record<string, string[]> = {}
    if (isRecord(raw.scopes)) {
      for (const [scope, names] of Object.entries(raw.scopes)) {
        if (Array.isArray(names)) scopes[scope] = names.filter((name): name is string => typeof name === 'string')
      }
    }
    groups[id] = { name: raw.name, scopes }
  }
  return groups
}

/** Read groups; missing file → empty; corrupt file → backup + empty + warning. */
export async function loadGroups(filePath: string): Promise<LoadGroupsResult> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return { groups: {} }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return { groups: parseGroupsPayload(parsed) }
  } catch (error) {
    const backup = `${filePath}.corrupt-${Date.now()}`
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await rename(filePath, backup)
    } catch {
      // backup is best-effort; the fallback is still an empty config
    }
    return {
      groups: {},
      warning: `分组文件损坏，已备份并回退空配置：${backup}（${error instanceof Error ? error.message : String(error)}）`,
    }
  }
}

/** Atomic write (temp file + rename), same shape/version as the web panel. */
export async function saveGroups(filePath: string, groups: SkillGroups): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify({ version: GROUPS_VERSION, groups }, undefined, 2)}\n`, 'utf8')
  await rename(tmp, filePath)
}

/** Group ids containing `(scopeKey, skillName)`. */
export function groupIdsForSkill(groups: SkillGroups, scopeKey: string, skillName: string): string[] {
  return Object.entries(groups)
    .filter(([, group]) => (group.scopes[scopeKey] ?? []).includes(skillName))
    .map(([id]) => id)
}

/** Pure create/update: unique case-insensitive name; empty `names` removes the scope. */
export function upsertGroup(
  groups: SkillGroups,
  id: string | undefined,
  name: string,
  scopeKey: string,
  names: string[],
): { groups: SkillGroups; id: string } {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('分组名称不能为空')
  for (const [existingId, group] of Object.entries(groups)) {
    if (existingId !== id && group.name.toLowerCase() === trimmed.toLowerCase()) {
      throw new Error(`分组名 "${trimmed}" 已存在`)
    }
  }
  const next: SkillGroups = { ...groups }
  const targetId = id ?? `g-${Math.random().toString(36).slice(2, 10)}`
  const existing = next[targetId] ?? { name: trimmed, scopes: {} }
  const scopes = { ...existing.scopes }
  const unique = [...new Set(names.filter((entry) => entry.length > 0))]
  if (unique.length === 0) delete scopes[scopeKey]
  else scopes[scopeKey] = unique
  next[targetId] = { name: trimmed, scopes }
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
  if (group === undefined) throw new Error(`分组不存在：${id}`)
  const names = new Set(group.scopes[scopeKey] ?? [])
  if (member) names.add(skillName)
  else names.delete(skillName)
  return upsertGroup(groups, id, group.name, scopeKey, [...names]).groups
}

/** Total member count across scopes. */
export function groupMemberCount(group: SkillGroup): number {
  return Object.values(group.scopes).reduce((sum, names) => sum + names.length, 0)
}
