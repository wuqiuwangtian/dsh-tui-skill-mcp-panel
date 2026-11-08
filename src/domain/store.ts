/** Plugin-private storage paths and config (JSON) handling. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PANEL_DIR_NAME = 'skill-mcp-panel'
export const CONFIG_VERSION = 1

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
  /** Trash retention: delete entries older than this many days. */
  trashRetentionDays: number
  /** MCP groups (serverName + entryId); owned by this plugin, never written to groups.json. */
  mcpGroups: Record<string, { name: string; members: string[] }>
}

export const DEFAULT_CONFIG: PanelConfig = {
  version: CONFIG_VERSION,
  trashRetentionDays: 7,
  mcpGroups: {},
}

/** Read plugin config; missing/corrupt file falls back to defaults (never throws). */
export async function loadPanelConfig(home: string): Promise<PanelConfig> {
  try {
    const parsed = JSON.parse(await readFile(configFile(home), 'utf8')) as unknown
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const days = record.trashRetentionDays
      const retention = typeof days === 'number' && Number.isFinite(days) && days >= 1 && days <= 90 ? Math.floor(days) : 7
      const mcpGroups =
        record.mcpGroups !== null && typeof record.mcpGroups === 'object' && !Array.isArray(record.mcpGroups)
          ? (record.mcpGroups as PanelConfig['mcpGroups'])
          : {}
      return { version: CONFIG_VERSION, trashRetentionDays: retention, mcpGroups: { ...mcpGroups } }
    }
  } catch {
    // missing/corrupt → defaults
  }
  return { ...DEFAULT_CONFIG, mcpGroups: {} }
}

/** Atomic config write (temp file + rename). */
export async function savePanelConfig(home: string, config: PanelConfig): Promise<void> {
  await mkdir(home, { recursive: true })
  const target = configFile(home)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(config, undefined, 2)}\n`, 'utf8')
  await rename(tmp, target)
}
