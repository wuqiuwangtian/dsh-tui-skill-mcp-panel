/** Plugin-private storage paths and config (JSON) handling. */
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { groupsForMcpProfile, mcpProfileKey, parseMcpGroups, type McpGroups } from './mcp/groups.js'
import { patchFingerprint, readPatchSnapshot, withPatchLock } from './mcp/write.js'

export const PANEL_DIR_NAME = 'skill-mcp-panel'
export const CONFIG_VERSION = 1
export const PANEL_TABS = ['skills', 'mcp', 'groups', 'diagnostics'] as const
export type PanelTab = (typeof PANEL_TABS)[number]
export function isPanelTab(value: unknown): value is PanelTab { return PANEL_TABS.includes(value as PanelTab) }

/** Root under `~/.dsh-tui` (or `$SKILL_MCP_PANEL_HOME` for tests). */
export function panelHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SKILL_MCP_PANEL_HOME?.trim()
  if (override !== undefined && override.length > 0) return override
  const dshTuiHome = env.DSH_TUI_HOME?.trim() || join(homedir(), '.dsh-tui')
  return join(dshTuiHome, PANEL_DIR_NAME)
}

export function trashRoot(home: string): string {
  return join(home, 'trash')
}

export function backupsRoot(home: string): string {
  return join(home, 'backups')
}

export function configFile(home: string): string {
  return join(home, 'config.json')
}

/** Shared with the web panel: `$DSH_HOME/skills/.system/skill-viewer/groups.json`. */
export function groupsFile(dshHome: string): string {
  return join(dshHome, 'skills', '.system', 'skill-viewer', 'groups.json')
}

export interface PanelConfig {
  version: number
  lastTab?: PanelTab
  /** Trash retention: delete entries older than this many days. */
  trashRetentionDays: number
  /** MCP groups (serverName + entryId); owned by this plugin, never written to groups.json. */
  mcpGroups: McpGroups
}

export const DEFAULT_CONFIG: PanelConfig = {
  version: CONFIG_VERSION,
  trashRetentionDays: 7,
  mcpGroups: {},
}

interface PanelDocument { config: PanelConfig; raw: Record<string, unknown>; fingerprint: string; warning?: string; writable: boolean }

export async function loadPanelDocument(home: string): Promise<PanelDocument> {
  const snapshot = await readPatchSnapshot(configFile(home))
  const fallback = { ...DEFAULT_CONFIG, mcpGroups: {} }
  if (snapshot.fingerprint === 'missing') return { config: fallback, raw: {}, fingerprint: snapshot.fingerprint, writable: true }
  try {
    const parsed = JSON.parse(snapshot.text) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      if (record.version !== undefined && record.version !== CONFIG_VERSION) return { config: fallback, raw: record, fingerprint: snapshot.fingerprint, writable: false, warning: '插件配置版本不受支持，未修改文件；请使用匹配版本或手工迁移' }
      const days = record.trashRetentionDays
      const retention = typeof days === 'number' && Number.isFinite(days) && days >= 1 && days <= 90 ? Math.floor(days) : 7
      const parsedGroups = parseMcpGroups(record.mcpGroups)
      const validContainer = record.mcpGroups === undefined || (record.mcpGroups !== null && typeof record.mcpGroups === 'object' && !Array.isArray(record.mcpGroups))
      return { config: { version: CONFIG_VERSION, lastTab: isPanelTab(record.lastTab) ? record.lastTab : 'skills', trashRetentionDays: retention, mcpGroups: parsedGroups.groups }, raw: record,
        fingerprint: snapshot.fingerprint, warning: parsedGroups.warning, writable: validContainer }
    }
  } catch { /* Do not include raw JSON in errors: unrelated preferences may contain secrets. */ }
  return { config: fallback, raw: {}, fingerprint: snapshot.fingerprint, writable: false,
    warning: '插件配置损坏，已回退只读默认值；原文件保留，请修复或备份后重命名 config.json' }
}

/** Only this preference changes; merge fresh raw data under the same lock as MCP groups. */
export async function updateLastTab(home: string, tab: PanelTab): Promise<void> {
  if (!isPanelTab(tab)) throw new Error('未知页签，未保存')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await withPatchLock(configFile(home), async () => {
    const current = await loadPanelDocument(home)
    if (!current.writable) throw new Error(current.warning ?? '插件配置不可写，请手工修复')
    if (current.raw.lastTab === tab) return
    await writePanelDocument(home, { ...current.raw, version: CONFIG_VERSION, lastTab: tab }, current.fingerprint)
  }, { resourceName: 'config.json' })
}

/** Compatibility wrapper; detailed callers also expose warnings. */
export async function loadPanelConfig(home: string): Promise<PanelConfig> { return (await loadPanelDocument(home)).config }

async function writePanelDocument(home: string, raw: Record<string, unknown>, fingerprint: string): Promise<void> {
  const target = configFile(home)
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (info !== undefined && !info.isFile()) throw new Error('config.json 必须是普通文件；符号链接请手工编辑')
  const tmp = `${target}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, `${JSON.stringify(raw, undefined, 2)}\n`, { encoding: 'utf8', mode: info === undefined ? 0o600 : info.mode & 0o777, flag: 'wx' })
    if (info !== undefined) await chmod(tmp, info.mode & 0o777)
    if ((await readPatchSnapshot(target)).fingerprint !== fingerprint) throw new Error('插件配置已被外部修改，请刷新后重试；未覆盖文件')
    await rename(tmp, target)
  } finally { await rm(tmp, { force: true }) }
}

function sameProfile(left: McpGroups, right: McpGroups, profile: string): boolean {
  const canonical = (groups: McpGroups) => Object.entries(groupsForMcpProfile(groups, profile)).sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => [id, group.name, [...group.members].sort()])
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/** Re-read/merge under one private-config lock; foreign profiles and unknown fields survive. */
export async function updateMcpGroups(home: string, profile: string, mutate: (groups: McpGroups) => McpGroups, expected?: McpGroups): Promise<PanelDocument> {
  profile = mcpProfileKey(profile)
  await mkdir(home, { recursive: true, mode: 0o700 })
  return withPatchLock(configFile(home), async () => {
    const current = await loadPanelDocument(home)
    if (!current.writable) throw new Error(current.warning ?? '插件配置不可写，请手工修复')
    if (expected !== undefined && !sameProfile(current.config.mcpGroups, expected, profile)) throw new Error('当前 profile 的 MCP 分组已被修改，请刷新后重试；未覆盖外部改动')
    const groups = mutate(structuredClone(current.config.mcpGroups))
    // A mutation of one profile must not alter another profile's namespace.
    for (const [id, group] of Object.entries(current.config.mcpGroups)) {
      if (group.profilePath !== profile && JSON.stringify(groups[id]) !== JSON.stringify(group)) throw new Error('拒绝跨 profile 修改分组')
    }
    for (const [id, group] of Object.entries(groups)) {
      if (group.profilePath !== profile && JSON.stringify(current.config.mcpGroups[id]) !== JSON.stringify(group)) throw new Error('拒绝跨 profile 新增分组')
    }
    const rawGroups = Object.assign(Object.create(null) as Record<string, unknown>, current.raw.mcpGroups)
    for (const id of Object.keys(current.config.mcpGroups)) if (groups[id] === undefined) delete rawGroups[id]
    for (const [id, group] of Object.entries(groups)) {
      if (group.profilePath === profile && JSON.stringify(group) !== JSON.stringify(current.config.mcpGroups[id])) {
        rawGroups[id] = { ...(rawGroups[id] as Record<string, unknown> | undefined), ...group }
      }
    }
    const raw = { ...current.raw, version: CONFIG_VERSION, mcpGroups: rawGroups }
    await writePanelDocument(home, raw, current.fingerprint)
    return { config: { ...current.config, mcpGroups: groups }, raw, fingerprint: patchFingerprint(`${JSON.stringify(raw, undefined, 2)}\n`), warning: current.warning, writable: true }
  }, { resourceName: 'config.json' })
}
