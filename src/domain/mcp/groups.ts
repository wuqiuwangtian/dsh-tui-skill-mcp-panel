/** Display metadata: profile-scoped groups, with unambiguous serverName/entryId keys. */
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { McpRowView } from './patch.js'

export interface McpGroup { name: string; profilePath: string; members: string[] }
export type McpGroups = Record<string, McpGroup>
export type McpIdentity = Pick<McpRowView, 'serverName' | 'entryId'>
export type McpStatusFilter = 'all' | 'enabled' | 'disabled' | 'failed'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mcpProfileKey(path: string): string { return resolve(path) }
export function mcpMemberKey(row: McpIdentity): string { return JSON.stringify([row.serverName, row.entryId]) }

function validMember(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const pair: unknown = JSON.parse(value)
    return Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === 'string' && v.length > 0) && JSON.stringify(pair) === value
  } catch { return false }
}

function checkedName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('分组名称不能为空')
  if (Array.from(trimmed).length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) throw new Error('分组名称最多 80 字符，不能包含控制字符')
  return trimmed
}

/** Invalid/unbound records are excluded from the UI, never silently assigned to a profile. */
export function parseMcpGroups(value: unknown): { groups: McpGroups; warning?: string } {
  if (value === undefined) return { groups: {} }
  if (!record(value)) return { groups: {}, warning: 'mcpGroups 结构无效，原配置保留；请手工修复' }
  const groups: McpGroups = Object.create(null) as McpGroups
  let skipped = 0
  for (const [id, raw] of Object.entries(value)) {
    try {
      if (!record(raw) || typeof raw.name !== 'string' || typeof raw.profilePath !== 'string' || !isAbsolute(raw.profilePath) || !Array.isArray(raw.members) || !raw.members.every(validMember)) {
        skipped++; continue
      }
      const name = checkedName(raw.name)
      groups[id] = { name, profilePath: mcpProfileKey(raw.profilePath), members: [...new Set(raw.members)] }
    } catch { skipped++ }
  }
  return { groups, ...(skipped === 0 ? {} : { warning: `${skipped} 个 MCP 分组记录无效或未绑定 profile，已保留原文并隐藏；不会自动绑定当前 profile` }) }
}

export function groupsForMcpProfile(groups: McpGroups, path: string): McpGroups {
  const key = mcpProfileKey(path)
  return Object.fromEntries(Object.entries(groups).filter(([, group]) => group.profilePath === key))
}

export function upsertMcpGroup(groups: McpGroups, path: string, id: string | undefined, name: string, members?: string[]): { groups: McpGroups; id: string } {
  const profilePath = mcpProfileKey(path)
  const trimmed = checkedName(name)
  if (id !== undefined && groups[id]?.profilePath !== profilePath) throw new Error('该 MCP 分组不存在或属于其他 profile')
  for (const [key, group] of Object.entries(groups)) {
    if (key !== id && group.profilePath === profilePath && group.name.toLowerCase() === trimmed.toLowerCase()) throw new Error('当前 profile 已有同名 MCP 分组')
  }
  const key = id ?? `mcp-g-${randomUUID()}`
  const nextMembers = members ?? groups[key]?.members ?? []
  if (!nextMembers.every(validMember)) throw new Error('MCP 分组成员必须是 serverName + entryId 双键')
  return { id: key, groups: { ...groups, [key]: { name: trimmed, profilePath, members: [...new Set(nextMembers)] } } }
}

export function deleteMcpGroup(groups: McpGroups, path: string, id: string): McpGroups {
  if (groups[id]?.profilePath !== mcpProfileKey(path)) throw new Error('该 MCP 分组不存在或属于其他 profile')
  const next = { ...groups }
  delete next[id]
  return next
}

export function setMcpMembership(groups: McpGroups, path: string, id: string, row: McpIdentity, member: boolean): McpGroups {
  const group = groups[id]
  if (group?.profilePath !== mcpProfileKey(path)) throw new Error('该 MCP 分组不存在或属于其他 profile')
  const values = new Set(group.members)
  if (member) values.add(mcpMemberKey(row)); else values.delete(mcpMemberKey(row))
  return upsertMcpGroup(groups, path, id, group.name, [...values]).groups
}

export function mcpGroupIds(groups: McpGroups, path: string, row: McpIdentity): string[] {
  const member = mcpMemberKey(row)
  return Object.entries(groupsForMcpProfile(groups, path)).filter(([, group]) => group.members.includes(member)).map(([id]) => id)
}

/** Rename changes only identities in this profile; deleted references remain for undo. */
export function renameMcpMember(groups: McpGroups, path: string, before: McpIdentity, after: McpIdentity): McpGroups {
  const oldKey = mcpMemberKey(before)
  const newKey = mcpMemberKey(after)
  const next = { ...groups }
  for (const [id, group] of Object.entries(groupsForMcpProfile(groups, path))) {
    if (group.members.includes(oldKey)) next[id] = { ...group, members: [...new Set(group.members.map((key) => key === oldKey ? newKey : key))] }
  }
  return next
}

/** Search safe metadata only, never command/env/headers or evaluated credentials. */
export function filterMcpRows(rows: McpRowView[], options: { query: string; status: McpStatusFilter; groupId?: string; profilePath?: string; groups: McpGroups }): McpRowView[] {
  const groups = options.profilePath === undefined ? {} : groupsForMcpProfile(options.groups, options.profilePath)
  const tokens = options.query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  return rows.filter((row) => {
    if (options.status === 'enabled' && !row.enabled) return false
    if (options.status === 'disabled' && row.enabled) return false
    if (options.status === 'failed' && row.phase !== 'failed') return false
    const names = Object.entries(groups).filter(([, group]) => group.members.includes(mcpMemberKey(row)))
    if (options.groupId !== undefined && !names.some(([id]) => id === options.groupId)) return false
    const haystack = [row.serverName, row.entryId, row.transport, row.layer, ...names.map(([, group]) => group.name)].join(' ').toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}
