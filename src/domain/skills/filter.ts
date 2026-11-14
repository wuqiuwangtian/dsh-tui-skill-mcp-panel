/** Display-only skill filters. Enabled includes shadowed instances; no discovery/write semantics change. */
import type { SkillGroups } from '../groups.js'
import type { SkillInstance, SkillScanResult } from './types.js'

export const SKILL_STATUS_FILTERS = ['all', 'enabled', 'disabled', 'invalid'] as const
export type SkillStatusFilter = (typeof SKILL_STATUS_FILTERS)[number]
export interface SkillFilterOptions {
  scope: 'all' | 'workspace' | 'global'
  status: SkillStatusFilter
  query: string
  groupId?: string
  groups: SkillGroups
}

export function filterSkills(scan: SkillScanResult | undefined, options: SkillFilterOptions): SkillInstance[] {
  if (scan === undefined) return []
  const needle = options.query.trim().toLowerCase()
  return scan.instances.filter(instance => {
    if (options.scope !== 'all' && instance.scope !== options.scope) return false
    if (options.status !== 'all' && instance.status !== options.status) return false
    if (needle && !instance.name.toLowerCase().includes(needle) && !instance.description.toLowerCase().includes(needle)) return false
    if (options.groupId !== undefined) {
      const scope = instance.scope === 'global' ? 'global' : scan.projectRoot
      if (!(options.groups[options.groupId]?.scopes[scope] ?? []).includes(instance.name)) return false
    }
    return true
  }).sort((left, right) => left.name.localeCompare(right.name) || Number(right.effective) - Number(left.effective) ||
    left.rank - right.rank || left.providerOrder - right.providerOrder)
}
