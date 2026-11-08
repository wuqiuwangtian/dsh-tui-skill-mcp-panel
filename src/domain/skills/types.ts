/** Domain types for skill discovery, mirroring the DSH kernel's file provider. */

export type SkillSource =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents'
  | 'bundled'

export type SkillScope = 'workspace' | 'global'

export type SkillStatus = 'enabled' | 'disabled' | 'invalid'

export type SkillForm = 'directory' | 'file'

/** One discovery root (rank decides precedence inside a single scope layer). */
export interface SkillRoot {
  source: SkillSource
  rank: number
  /** Resolved root directory. */
  path: string
  scope: SkillScope
  exists: boolean
  skipSystem: boolean
  /** Bundled roots are conceptually read-only (upgrades overwrite them). */
  writable: boolean
}

/** One discovered skill entity on disk (enabled, disabled or present-but-unusable). */
export interface SkillInstance {
  /** `${source}:${locatorPath}` — stable enough for UI selection. */
  id: string
  /** Kernel skill name (frontmatter `name`) or a best-effort fallback for invalid entries. */
  name: string
  description: string
  source: SkillSource
  rank: number
  scope: SkillScope
  form: SkillForm
  status: SkillStatus
  /** Frontmatter file actually read (`SKILL.md`, `<name>.md` or its `.disabled` sibling). */
  skillFile: string
  /** Directory bundle dir, or the root directory for flat files. */
  locatorDir: string
  rootPath: string
  /** Realpath of `skillFile` when it exists. */
  path: string
  /** Discovery order inside the provider list (root order, then entry-name order). */
  providerOrder: number
  /** True only for the kernel-visible winner of a name. */
  effective: boolean
  /** Set on a valid-but-shadowed instance: id of the winning instance. */
  shadowedBy?: string
  invalidReason?: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  modelInvocable?: boolean
  userInvocable?: boolean
  /** Sanitized-later preview of the body (frontmatter stripped). */
  bodyPreview?: string
}

export interface SkillScanResult {
  scannedAt: string
  cwd: string
  projectRoot: string
  dshHome: string
  agentsHome: string
  roots: SkillRoot[]
  instances: SkillInstance[]
  warnings: string[]
}

export interface SkillScanOptions {
  cwd?: string
  dshHome?: string
  agentsHome?: string
  bundledDir?: string
  customDirs?: string[]
  /** Injected clock, for deterministic tests. */
  now?: () => Date
}
