/**
 * Host-side state for the management scene: skill scan results, detail reads,
 * host capability diagnostics and an optional JSON dump (env
 * `SKILL_MCP_PANEL_DUMP`) used by real-machine verification.
 *
 * No React here; the scene subscribes to `snapshot()`.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { scanSkills } from '../domain/skills/index.js'
import type { SkillInstance, SkillScanResult } from '../domain/skills/types.js'
import {
  addSkill as addSkillOp,
  cleanupTrash,
  deleteSkills as deleteSkillsOp,
  listTrash,
  toggleSkill,
  undoTrash,
  type AddSkillResult,
  type TrashBatch,
} from '../domain/skills/write.js'
import {
  deleteGroup as deleteGroupOp,
  groupIdsForSkill,
  groupMemberCount,
  loadGroups,
  saveGroups,
  setGroupMembership,
  upsertGroup,
  type SkillGroups,
} from '../domain/groups.js'
import {
  backupsRoot,
  groupsFile,
  loadPanelDocument,
  panelHome,
  updateMcpGroups,
  type PanelConfig,
} from '../domain/store.js'
import {
  MCP_MODULE,
  buildMcpRows,
  maskSecretConfig,
  parsePatchText,
  type LoaderMcpRow,
  type McpRowView,
  type PatchRow,
} from '../domain/mcp/patch.js'
import { PatchConflictError, readPatchSnapshot, saveMcpToggle } from '../domain/mcp/write.js'
import { managedMcpEntries } from '../domain/mcp/managed.js'
import { deleteMcpEntry, listMcpDeletions, openMcpEditor, restoreMcpEntry, saveMcpEditor,
  type McpDeletionSummary, type McpEditSession } from '../domain/mcp/crud.js'
import type { McpConfig } from '../domain/mcp/model.js'
import { deleteMcpGroup, groupsForMcpProfile, mcpGroupIds, mcpMemberKey, mcpProfileKey, renameMcpMember, setMcpMembership, upsertMcpGroup,
  type McpGroups, type McpIdentity } from '../domain/mcp/groups.js'
import {
  describeService,
  getService,
  type CommandResultLike,
  type DocumentPathLike,
  type LoaderEntryLike,
  type LoaderLike,
  type TuiSceneServiceLike,
} from '../shared/seams.js'

const PROBED_SERVICES = [
  'tuiScenes',
  'tuiDialogs',
  'tuiToast',
  'tuiPanels',
  'tuiSettingsSections',
  'tuiWorkspaces',
  'tuiPluginHost',
  'commands',
  'pluginManager',
  'configEditor',
  'settings',
  'skills',
  'loader',
] as const

export interface ManagerServiceInfo {
  name: string
  present: boolean
  members: string[]
}

export interface ManagerPaths {
  skillGroupsFile?: string
  settingsDocument?: string
  configEditorDocument?: string
  homePatch: string
  panelHome: string
}

export type ManagerStatusTone = 'info' | 'success' | 'warning' | 'error'

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const FIBER_PHASE: Record<number, string> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
}

export interface McpToggleOutcome {
  outcome: 'saved' | 'applied' | 'timeout' | 'conflict' | 'error'
  id: string
  serverName?: string
  savedAt: number
  appliedAt?: number
  detail?: string
  backupPath?: string
  action?: 'create' | 'edit' | 'delete' | 'restore'
}

export interface McpPanelState {
  loadedAt?: string
  profilePatchPath?: string
  homePatchPath?: string
  profileFingerprint?: string
  homeFingerprint?: string
  rows: McpRowView[]
  errors: string[]
  warnings: string[]
  togglingId?: string
  lastAction?: McpToggleOutcome
  latestDeletion?: McpDeletionSummary
}

export interface ManagerStatusMessage {
  text: string
  tone: ManagerStatusTone
  at: number
}

export interface ManagerDetailState {
  id?: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  content?: string
  error?: string
}

export interface ManagerState {
  status: 'loading' | 'ready' | 'error'
  scan?: SkillScanResult
  error?: string
  refreshing: boolean
  refreshReason?: string
  services: ManagerServiceInfo[]
  paths: ManagerPaths
  detail: ManagerDetailState
  mcp: McpPanelState
  groups: SkillGroups
  groupsWarning?: string
  groupsFingerprint?: string
  groupsWritable?: boolean
  groupsBackupPath?: string
  latestTrash?: TrashBatch
  config: PanelConfig
  configWarning?: string
  statusMessage?: ManagerStatusMessage
  busy: boolean
  sceneError?: string
  dumpPath?: string
  dumpMessage?: string
}

export class ManagerRuntime {
  readonly startedAt = Date.now()
  private readonly ctx: Context
  private readonly listeners = new Set<() => void>()
  private readonly dumpPath: string | undefined
  private readonly renderDumpPath: string | undefined
  private renderFrames = 0
  private readonly detailCache = new Map<string, string>()
  private sceneService: TuiSceneServiceLike | undefined
  private readonly panelHomePath: string
  private state: ManagerState
  private capabilityTimer: ReturnType<typeof setTimeout> | undefined
  private statusTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private scanStartedAt = 0

  constructor(ctx: Context) {
    this.ctx = ctx
    this.dumpPath = process.env.SKILL_MCP_PANEL_DUMP ?? undefined
    this.renderDumpPath = process.env.SKILL_MCP_PANEL_RENDER_DUMP ?? undefined
    this.panelHomePath = panelHome()
    this.state = {
      status: 'loading',
      refreshing: true,
      services: [],
      paths: {
        skillGroupsFile: groupsFile(process.env.DSH_HOME ?? join(homedir(), '.dsh')),
        homePatch: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cordis.patch.yml'),
        panelHome: this.panelHomePath,
      },
      detail: { status: 'idle' },
      groups: {},
      mcp: { rows: [], errors: [], warnings: [] },
      config: { version: 1, trashRetentionDays: 7, mcpGroups: {} },
      busy: false,
      ...(this.dumpPath === undefined ? {} : { dumpPath: this.dumpPath }),
    }
    void this.refresh('activation')
    // TUI seam services appear ~1s after plugin activation (measured in M0 probe).
    this.capabilityTimer = setTimeout(() => {
      if (!this.disposed) this.captureCapabilities()
    }, 1500)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): ManagerState {
    return this.state
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A broken listener must not take the manager down.
      }
    }
  }

  private patchState(patch: Partial<ManagerState>): void {
    this.state = { ...this.state, ...patch }
    this.notify()
  }

  private captureCapabilities(): void {
    const services: ManagerServiceInfo[] = PROBED_SERVICES.map((name) => {
      const service = getService<object>(this.ctx, name)
      if (service === undefined) return { name, present: false, members: [] }
      let members: string[] = []
      try {
        members = describeService(service)
      } catch {
        members = ['[unreadable]']
      }
      return { name, present: true, members }
    })

    const readDocument = (name: string): string | undefined => {
      const service = getService<{ readonly documentPath?: string }>(this.ctx, name)
      if (service === undefined) return undefined
      try {
        const path = service.documentPath
        return typeof path === 'string' ? path : undefined
      } catch {
        return undefined
      }
    }

    this.patchState({
      services,
      paths: {
        skillGroupsFile: this.groupsFilePath(),
        ...(readDocument('settings') === undefined ? {} : { settingsDocument: readDocument('settings') as string }),
        ...(readDocument('configEditor') === undefined
          ? {}
          : { configEditorDocument: readDocument('configEditor') as string }),
        homePatch: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cordis.patch.yml'),
        panelHome: this.panelHomePath,
      },
    })
  }

  setSceneService(service: TuiSceneServiceLike | undefined): void {
    this.sceneService = service
  }

  /** Open the manager scene; the command handler returns the result verbatim. */
  openScene(sceneId: string): CommandResultLike {
    if (this.sceneService === undefined) {
      return { kind: 'error', text: 'tuiScenes is unavailable in this host' }
    }
    try {
      return this.sceneService.open(sceneId)
        ? { kind: 'success' }
        : { kind: 'error', text: `scene ${sceneId} is not registered` }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  reportSceneError(message: string): void {
    this.patchState({ sceneError: message })
  }

  async refresh(reason: string): Promise<void> {
    if (this.disposed) return
    this.scanStartedAt = Date.now()
    this.patchState({ status: this.state.scan === undefined ? 'loading' : this.state.status, refreshing: true, refreshReason: reason })
    try {
      const scan = await scanSkills({ cwd: process.cwd() })
      if (this.disposed) return
      this.captureCapabilities()
      this.patchState({ status: 'ready', scan, error: undefined, refreshing: false })
      await this.loadMetadata(scan.dshHome)
      await this.loadMcp()
      await this.writeDump(`refresh:${reason}`)
    } catch (error) {
      if (this.disposed) return
      this.patchState({
        status: 'error',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        refreshing: false,
      })
    }
  }

  /** Refresh when the last scan is older than `maxAgeMs` (scene mount). */
  async ensureFresh(maxAgeMs = 3000): Promise<void> {
    if (Date.now() - this.scanStartedAt > maxAgeMs) await this.refresh('scene-mount')
  }

  // ── metadata: groups / trash / config ─────────────────────────────────────
  private async loadMetadata(dshHome?: string): Promise<void> {
    const home = dshHome ?? this.state.scan?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    try {
      const loaded = await loadGroups(groupsFile(home))
      if (this.disposed) return
      this.patchState({
        groups: loaded.groups,
        groupsFingerprint: loaded.fingerprint,
        groupsWritable: loaded.writable,
        ...(loaded.warning === undefined ? { groupsWarning: undefined } : { groupsWarning: loaded.warning }),
      })
    } catch (error) {
      this.patchState({ groupsFingerprint: undefined, groupsWritable: false, groupsWarning: error instanceof Error ? error.message : String(error) })
    }
    try {
      const [batches, document] = await Promise.all([listTrash(this.panelHomePath), loadPanelDocument(this.panelHomePath)])
      if (this.disposed) return
      this.patchState({ latestTrash: batches[0], config: document.config, configWarning: document.warning })
    } catch (error) {
      this.patchState({ configWarning: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Show a transient status line (auto-clears). */
  setStatus(text: string, tone: ManagerStatusTone = 'info'): void {
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer)
    this.patchState({ statusMessage: { text, tone, at: Date.now() } })
    const timeout = tone === 'error' ? 20000 : tone === 'warning' ? 15000 : 10000
    this.statusTimer = setTimeout(() => {
      if (this.disposed) return
      this.patchState({ statusMessage: undefined })
    }, timeout)
    this.statusTimer.unref?.()
  }

  private async withBusy<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.state.busy) {
      this.setStatus('已有操作在进行中，请稍候…', 'warning')
      return undefined
    }
    this.patchState({ busy: true })
    try {
      return await operation()
    } finally {
      if (!this.disposed) this.patchState({ busy: false })
    }
  }

  // ── skill write operations (M2) ───────────────────────────────────────────
  /** Space / batch enable-disable. */
  async toggleSkills(instances: SkillInstance[]): Promise<void> {
    if (instances.length === 0) return
    await this.withBusy(async () => {
      const failures: string[] = []
      for (const instance of instances) {
        const result = await toggleSkill(instance)
        if (!result.ok) failures.push(`${instance.name}：${result.error ?? 'unknown'}`)
      }
      await this.refresh('toggle')
      if (failures.length === 0) {
        this.setStatus(`已切换 ${instances.length} 个技能（热加载中）`, 'success')
      } else {
        this.setStatus(
          `已切换 ${instances.length - failures.length}/${instances.length}；失败：${failures.slice(0, 3).join('；')}`,
          'warning',
        )
      }
    })
  }

  /** Delete selected skills into the trash (undoable). */
  async deleteSkillInstances(instances: SkillInstance[]): Promise<void> {
    if (instances.length === 0) return
    await this.withBusy(async () => {
      await cleanupTrash(this.panelHomePath, { retentionDays: this.state.config.trashRetentionDays })
      const result = await deleteSkillsOp(instances, { panelHome: this.panelHomePath })
      await this.refresh('delete')
      if (result.deleted.length === 0) {
        this.setStatus(
          `删除失败：${result.failed.map((entry) => entry.error).slice(0, 3).join('；') || 'unknown'}`,
          'error',
        )
        return
      }
      const suffix = result.failed.length > 0 ? `；失败 ${result.failed.length}：${result.failed[0]?.error ?? ''}` : ''
      this.setStatus(`已移入回收站 ${result.deleted.length} 个技能，可按 u 撤销${suffix}`, 'success')
    })
  }

  /** Undo the most recent trash batch. */
  async undoLastDelete(): Promise<void> {
    await this.withBusy(async () => {
      const result = await undoTrash(this.panelHomePath)
      await this.refresh('undo')
      if (result.batchId === undefined) {
        this.setStatus('回收站为空，没有可撤销的删除', 'info')
        return
      }
      if (result.restored.length === 0 && result.conflicts.length === 0 && result.failed.length === 0) {
        this.setStatus('没有恢复任何技能', 'warning')
        return
      }
      const parts = [`已恢复 ${result.restored.length} 个`]
      if (result.conflicts.length > 0) parts.push(`冲突 ${result.conflicts.length}（${result.conflicts[0] ?? ''}）`)
      if (result.failed.length > 0) parts.push(`失败 ${result.failed.length}`)
      this.setStatus(parts.join('；'), result.conflicts.length > 0 || result.failed.length > 0 ? 'warning' : 'success')
    })
  }

  /** Add/import a skill from a local absolute path into a discovery root. */
  async addSkillFromPath(sourcePath: string, targetScope: 'global' | 'workspace'): Promise<void> {
    await this.withBusy(async () => {
      const scan = this.state.scan
      const projectRoot = scan?.projectRoot ?? process.cwd()
      const dshHome = scan?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const targetRoot = targetScope === 'global' ? join(dshHome, 'skills') : join(projectRoot, '.dsh', 'skills')
      const result: AddSkillResult = await addSkillOp({ sourcePath, targetRoot })
      await this.refresh('add')
      if (!result.ok) {
        this.setStatus(`添加失败：${result.error ?? 'unknown'}`, 'error')
        return
      }
      const warnings = result.warnings !== undefined && result.warnings.length > 0 ? `（${result.warnings.join('；')}）` : ''
      this.setStatus(`已添加技能 ${result.name} → ${result.destPath}${warnings}`, warnings.length > 0 ? 'warning' : 'success')
    })
  }

  // ── MCP (profile patch + home layer + loader runtime state) ──────────────
  private dshHomePath(): string {
    return this.state.scan?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  }

  private mcpProfilePatchPath(): string | undefined {
    for (const name of ['configEditor', 'settings']) {
      const service = getService<DocumentPathLike>(this.ctx, name)
      if (service === undefined) continue
      try {
        const path = service.documentPath
        if (typeof path === 'string' && path.length > 0) return path
      } catch {
        // fall through
      }
    }
    return undefined
  }

  private readLoaderMcpRows(warnings: string[]): LoaderMcpRow[] {
    const loader = getService<LoaderLike>(this.ctx, 'loader')
    if (loader === undefined) {
      warnings.push('loader 服务不可用，无法读取 MCP 运行时状态')
      return []
    }
    const rows: LoaderMcpRow[] = []
    try {
      for (const entry of loader.entries()) {
        const options = (entry as LoaderEntryLike).options
        if (options?.name !== MCP_MODULE || typeof options.id !== 'string') continue
        let disabled = false
        try {
          disabled = (entry as LoaderEntryLike).disabled === true
        } catch {
          warnings.push(`无法求值 ${options.id} 的 disabled 表达式`)
        }
        const config = isRecordValue(options.config) ? options.config : undefined
        const state = (entry as LoaderEntryLike).fiber?.state
        rows.push({
          id: options.id,
          ...(config === undefined ? {} : { config }),
          disabled,
          ...(typeof state === 'number' && FIBER_PHASE[state] !== undefined ? { phase: FIBER_PHASE[state] } : {}),
        })
      }
    } catch (error) {
      warnings.push(`读取 loader 条目失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return rows
  }

  /** Re-read both patch layers + loader runtime rows into `state.mcp`. */
  async refreshMcp(): Promise<void> {
    try {
      const document = await loadPanelDocument(this.panelHomePath)
      if (!this.disposed) this.patchState({ config: document.config, configWarning: document.warning })
    } catch { this.patchState({ configWarning: '插件配置读取失败；请检查 config.json 权限或语法' }) }
    await this.loadMcp()
  }

  private async loadMcp(): Promise<void> {
    const errors: string[] = []
    const warnings: string[] = []
    const profilePatchPath = this.mcpProfilePatchPath()
    const homePatchPath = join(this.dshHomePath(), 'cordis.patch.yml')
    let profileRows: PatchRow[] = []
    let homeRows: PatchRow[] = []
    const fingerprints: Record<string, string> = {}
    const texts: Record<string, string> = {}
    const readLayer = async (path: string, label: string): Promise<PatchRow[]> => {
      let text: string
      try {
        const snapshot = await readPatchSnapshot(path)
        text = snapshot.text
        texts[path] = text
        fingerprints[path] = snapshot.fingerprint
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${label}读取失败：${error instanceof Error ? error.message : String(error)}`)
        return []
      }
      const parsed = parsePatchText(text)
      if (!parsed.ok) {
        errors.push(`${label}解析失败：${parsed.error ?? 'unknown'}`)
        return []
      }
      return parsed.rows
    }
    if (profilePatchPath === undefined) {
      errors.push('无法确定当前 profile 的 patch 路径（configEditor/settings 不可用）')
    } else {
      profileRows = await readLayer(profilePatchPath, 'profile patch ')
    }
    homeRows = await readLayer(homePatchPath, 'home patch ')
    const loaderRows = this.readLoaderMcpRows(warnings)
    let managedIds = new Set<string>()
    try { managedIds = new Set(managedMcpEntries(texts[profilePatchPath ?? ''] ?? '').map((row) => row.id)) }
    catch { warnings.push('MCP 受管块无法安全解析，编辑/删除已禁用；请手工检查标记与 YAML') }
    const rows = buildMcpRows({ loaderRows, profileRows, homeRows }).map((row) => ({
      ...row,
      managed: managedIds.has(row.id) && row.layer === 'profile' && row.targetable,
      editReadOnlyReason: row.layer !== 'profile' || !row.targetable ? row.readOnlyReason :
        managedIds.has(row.id) ? undefined : '已有 profile 行仅支持启停；编辑/删除仅限本面板新增的受管行',
    }))
    let latestDeletion: McpDeletionSummary | undefined
    if (profilePatchPath !== undefined) {
      try { latestDeletion = (await listMcpDeletions(this.mcpTrashDir(), profilePatchPath, (warning) => warnings.push(warning)))[0] }
      catch { warnings.push('MCP 回收站读取失败，请检查本插件存储目录') }
    }
    if (rows.length === 0 && errors.length === 0) warnings.push('当前 profile 与 home 层没有 MCP 行')
    this.patchState({
      mcp: {
        loadedAt: new Date().toISOString(),
        ...(profilePatchPath === undefined ? {} : { profilePatchPath }),
        homePatchPath,
        profileFingerprint: profilePatchPath === undefined ? undefined : fingerprints[profilePatchPath],
        homeFingerprint: fingerprints[homePatchPath],
        rows,
        errors,
        warnings,
        latestDeletion,
        ...(this.state.mcp.togglingId === undefined ? {} : { togglingId: this.state.mcp.togglingId }),
        ...(this.state.mcp.lastAction === undefined ? {} : { lastAction: this.state.mcp.lastAction }),
      },
    })
  }

  private mcpTrashDir(): string { return join(this.panelHomePath, 'trash', 'mcp') }

  private mcpFiles(): Pick<McpEditSession, 'patchPath' | 'homePatchPath' | 'expectedProfile' | 'expectedHome'> {
    const mcp = this.state.mcp
    if (mcp.profilePatchPath === undefined || mcp.homePatchPath === undefined || mcp.profileFingerprint === undefined || mcp.homeFingerprint === undefined) {
      throw new Error('配置快照不可用，请按 r 重新读取')
    }
    return { patchPath: mcp.profilePatchPath, homePatchPath: mcp.homePatchPath,
      expectedProfile: mcp.profileFingerprint, expectedHome: mcp.homeFingerprint }
  }

  async openMcpForm(id?: string): Promise<McpEditSession | undefined> {
    try {
      if (this.state.busy) throw new Error('已有操作在进行中，请稍候')
      const row = id === undefined ? undefined : this.state.mcp.rows.find((entry) => entry.id === id)
      if (id !== undefined && !row?.managed) throw new Error(row?.editReadOnlyReason ?? '仅能编辑本面板的受管行')
      return await openMcpEditor(this.mcpFiles(), row === undefined ? undefined : { id: row.id, serverName: row.serverName })
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : '无法打开 MCP 表单，请刷新', 'error')
      return undefined
    }
  }

  async saveMcpForm(session: McpEditSession, config: McpConfig): Promise<void> {
    const runtimeRows = this.state.mcp.rows.filter((row) => row.id !== session.id)
    await this.runMcpMutation(session.id === undefined ? 'create' : 'edit', session.id, async () => {
      const result = await saveMcpEditor({ session, config, backupRoot: backupsRoot(this.panelHomePath),
        runtimeNames: runtimeRows.filter((row) => row.enabled).map((row) => row.serverName), runtimeIds: runtimeRows.map((row) => row.id) })
      if (result.changed && session.id !== undefined && session.serverName !== undefined && session.serverName !== result.value.serverName) {
        try {
          const current = await loadPanelDocument(this.panelHomePath)
          const before = { serverName: session.serverName, entryId: session.id }
          if (mcpGroupIds(current.config.mcpGroups, session.patchPath, before).length > 0) {
            const document = await updateMcpGroups(this.panelHomePath, session.patchPath,
              (groups) => renameMcpMember(groups, session.patchPath, before, { serverName: result.value.serverName, entryId: session.id! }))
            this.patchState({ config: document.config, configWarning: document.warning })
          }
        } catch {
          const warning = '服务器配置已保存，但分组更名同步失败；请刷新并检查成员归属'
          this.patchState({ configWarning: warning })
          return { ...result, warning }
        }
      }
      return result
    })
  }

  async deleteMcp(id: string): Promise<void> {
    const session = await this.openMcpForm(id)
    if (session === undefined) return
    await this.runMcpMutation('delete', id, () => deleteMcpEntry({ session, backupRoot: backupsRoot(this.panelHomePath), trashDir: this.mcpTrashDir() }))
  }

  async undoMcpDelete(): Promise<void> {
    const latest = this.state.mcp.latestDeletion
    if (latest === undefined) { this.setStatus('没有可撤销的 MCP 删除', 'info'); return }
    await this.runMcpMutation('restore', latest.id, () => restoreMcpEntry({ files: this.mcpFiles(), backupRoot: backupsRoot(this.panelHomePath),
      trashDir: this.mcpTrashDir(), batchId: latest.batchId }))
  }

  private loaderRevision(id: string | undefined): { fiber?: unknown; options?: unknown; signature?: string } {
    if (id === undefined) return {}
    const loader = getService<LoaderLike>(this.ctx, 'loader')
    if (loader === undefined) return {}
    try {
      for (const entry of loader.entries()) {
        if (entry.options?.id !== id) continue
        let signature: string | undefined
        try { signature = JSON.stringify(entry.options.config) } catch { /* Reference change can still prove reload. */ }
        return { fiber: entry.fiber, options: entry.options, signature }
      }
    } catch { /* A missing/unready loader cannot crash the scene. */ }
    return {}
  }

  private async runMcpMutation(
    action: 'create' | 'edit' | 'delete' | 'restore', id: string | undefined,
    operation: () => Promise<{ changed: boolean; backupPath?: string; warning?: string; value: { id: string; serverName: string } }>,
  ): Promise<void> {
    await this.withBusy(async () => {
      const before = this.loaderRevision(id)
      const labels = { create: '新增', edit: '修改', delete: '删除', restore: '恢复' }
      let saved: McpToggleOutcome | undefined
      try {
        const result = await operation()
        if (!result.changed) { this.setStatus('配置未变化，无需保存', 'info'); return }
        const target = result.value
        saved = { outcome: 'saved', action, id: target.id, serverName: target.serverName, savedAt: Date.now(), backupPath: result.backupPath, detail: result.warning }
        this.patchState({ mcp: { ...this.state.mcp, togglingId: target.id, lastAction: saved } })
        this.setStatus(`已保存，热加载中…（${labels[action]} ${target.serverName}）`, 'info')
        const source = await readPatchSnapshot(this.mcpFiles().patchPath)
        let disabled = false
        for (const row of parsePatchText(source.text).rows) {
          if (row.id === target.id && typeof row.disabled === 'boolean') disabled = row.disabled
        }
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !this.disposed) {
          await new Promise((resolve) => setTimeout(resolve, 400))
          await this.loadMcp()
          const current = this.state.mcp.rows.find((row) => row.id === target.id)
          const after = this.loaderRevision(target.id)
          const revised = after.options !== before.options || after.fiber !== before.fiber || after.signature !== before.signature
          if (current?.enabled && current.phase === 'failed') throw new Error('配置已保存，但 MCP 插件加载失败；请检查诊断/宿主日志')
          const ready = action === 'delete' ? current === undefined : current !== undefined &&
            current.enabled === !disabled && (disabled ? current.phase === undefined || current.phase === 'disposed' : current.phase === 'active') &&
            (action !== 'edit' || revised)
          if (ready) {
            this.patchState({ mcp: { ...this.state.mcp, togglingId: undefined, lastAction: { ...saved, outcome: 'applied', appliedAt: Date.now() } } })
            this.setStatus(`已生效：${target.serverName} 已${labels[action]}${action === 'delete' ? '，可按 u 撤销' : ''}${result.warning === undefined ? '' : `；${result.warning}`}`, result.warning === undefined ? 'success' : 'warning')
            await this.writeDump(`mcp:${action}`)
            return
          }
        }
        this.patchState({ mcp: { ...this.state.mcp, togglingId: undefined, lastAction: { ...saved, outcome: 'timeout', detail: '10s 内未观察到运行时完成变更' } } })
        this.setStatus('配置已保存，但尚未观察到生效；请刷新并检查诊断/日志', 'warning')
      } catch (error) {
        const detail = error instanceof Error ? error.message : '未知错误，请刷新后重试'
        this.patchState({ mcp: { ...this.state.mcp, togglingId: undefined, lastAction: {
          ...(saved ?? { id: id ?? '(new)', savedAt: Date.now(), action }), outcome: error instanceof PatchConflictError ? 'conflict' : 'error', detail,
        } } })
        this.setStatus(`MCP ${labels[action]}失败：${detail}`, 'error')
      }
    })
  }

  /** Toggle one MCP row by writing/removing our disabled override in the profile patch. */
  async toggleMcp(id: string): Promise<void> {
    const row = this.state.mcp.rows.find((entry) => entry.id === id)
    if (row === undefined) {
      this.setStatus('MCP 行不存在，请按 r 刷新', 'error')
      return
    }
    if (!row.targetable) {
      this.setStatus(row.readOnlyReason ?? '该 MCP 行不可直接启停', 'warning')
      return
    }
    const profilePatchPath = this.mcpProfilePatchPath()
    if (profilePatchPath === undefined) {
      this.setStatus('无法确定当前 profile 的 patch 路径', 'error')
      return
    }
    const { profileFingerprint, homeFingerprint, homePatchPath } = this.state.mcp
    if (profileFingerprint === undefined || homeFingerprint === undefined || homePatchPath === undefined) {
      this.setStatus('配置快照不可用，请按 r 重新读取后重试', 'error')
      return
    }
    await this.withBusy(async () => {
      const desiredEnabled = !row.enabled
      try {
        const { backupPath } = await saveMcpToggle({
          patchPath: profilePatchPath,
          homePatchPath,
          expectedProfile: profileFingerprint,
          expectedHome: homeFingerprint,
          id: row.id,
          serverName: row.serverName,
          disabled: !desiredEnabled,
          backupRoot: backupsRoot(this.panelHomePath),
        })
        const savedAt = Date.now()
        this.patchState({
          mcp: {
            ...this.state.mcp,
            togglingId: id,
            lastAction: { outcome: 'saved', id, serverName: row.serverName, savedAt, ...(backupPath === undefined ? {} : { backupPath }) },
          },
        })
        this.setStatus(`已保存，热加载中…（${row.serverName} → ${desiredEnabled ? '启用' : '停用'}）`, 'info')

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !this.disposed) {
          await new Promise((resolve) => setTimeout(resolve, 400))
          await this.loadMcp()
          const current = this.state.mcp.rows.find((entry) => entry.id === id)
          if (desiredEnabled && current?.enabled && current.phase === 'failed') {
            throw new Error('配置已保存，但 MCP 插件加载失败；请检查诊断页/宿主日志')
          }
          const settled = desiredEnabled
            ? current?.phase === 'active'
            : current?.phase === undefined || current.phase === 'disposed'
          if (current !== undefined && current.enabled === desiredEnabled && settled) {
            this.patchState({
              mcp: {
                ...this.state.mcp,
                togglingId: undefined,
                lastAction: { outcome: 'applied', id, serverName: row.serverName, savedAt, appliedAt: Date.now(), ...(backupPath === undefined ? {} : { backupPath }) },
              },
            })
            this.setStatus(`已生效：${row.serverName} 已${desiredEnabled ? '启用' : '停用'}`, 'success')
            return
          }
        }
        this.patchState({
          mcp: {
            ...this.state.mcp,
            togglingId: undefined,
            lastAction: { outcome: 'timeout', id, serverName: row.serverName, savedAt, detail: '10s 内未观察到 loader 状态变化' },
          },
        })
        this.setStatus('已保存，但 10s 内未观察到生效；请检查诊断页/日志，可能被更高层覆盖或需要重启', 'warning')
      } catch (error) {
        this.patchState({
          mcp: {
            ...this.state.mcp,
            togglingId: undefined,
            lastAction: { outcome: error instanceof PatchConflictError ? 'conflict' : 'error', id, serverName: row.serverName, savedAt: Date.now(), detail: error instanceof Error ? error.message : String(error) },
          },
        })
        this.setStatus(`MCP 启停失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    })
  }

  // ── MCP groups: private display metadata, isolated by profile ─────────────
  mcpGroupsForCurrentProfile(): McpGroups {
    const path = this.state.mcp.profilePatchPath
    return path === undefined ? {} : groupsForMcpProfile(this.state.config.mcpGroups, path)
  }

  private async mutateMcpGroups(mutate: (groups: McpGroups, path: string) => McpGroups, message: string): Promise<void> {
    await this.withBusy(async () => {
      try {
        const path = this.state.mcp.profilePatchPath
        if (path === undefined) throw new Error('无法确定当前 profile，不能保存 MCP 分组')
        const document = await updateMcpGroups(this.panelHomePath, path, (groups) => mutate(groups, mcpProfileKey(path)), this.state.config.mcpGroups)
        this.patchState({ config: document.config, configWarning: document.warning })
        this.setStatus(message, 'success')
        await this.writeDump('mcp:groups')
      } catch (error) { this.setStatus(`MCP 分组操作失败：${error instanceof Error ? error.message : '请刷新后重试'}`, 'error') }
    })
  }

  async createMcpGroup(name: string, members: McpIdentity[] = []): Promise<void> {
    await this.mutateMcpGroups((groups, path) => upsertMcpGroup(groups, path, undefined, name, members.map(mcpMemberKey)).groups, '已创建 MCP 分组（仅显示层）')
  }

  async renameMcpGroup(id: string, name: string): Promise<void> {
    await this.mutateMcpGroups((groups, path) => upsertMcpGroup(groups, path, id, name).groups, '已重命名 MCP 分组')
  }

  async deleteMcpGroup(id: string): Promise<void> {
    await this.mutateMcpGroups((groups, path) => deleteMcpGroup(groups, path, id), '已删除 MCP 分组；服务器配置与连接未改变')
  }

  async setMcpGroupMembership(id: string, row: McpIdentity, member: boolean): Promise<void> {
    await this.mutateMcpGroups((groups, path) => setMcpMembership(groups, path, id, row, member), member ? '已加入 MCP 分组' : '已移出 MCP 分组')
  }

  // ── skill groups (shared groups.json v1) ──────────────────────────────────
  scopeKeyFor(instance: SkillInstance): string {
    if (instance.scope === 'global') return 'global'
    return this.state.scan?.projectRoot ?? 'workspace'
  }

  groupIdsFor(instance: SkillInstance): string[] {
    return groupIdsForSkill(this.state.groups, this.scopeKeyFor(instance), instance.name)
  }

  private groupsFilePath(): string {
    const dshHome = this.state.scan?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return groupsFile(dshHome)
  }

  private async persistGroups(groups: SkillGroups): Promise<void> {
    const expectedFingerprint = this.state.groupsFingerprint
    if (expectedFingerprint === undefined || this.state.groupsWritable !== true) throw new Error(this.state.groupsWarning ?? '技能分组状态未就绪，请按 R 刷新后重试')
    const saved = await saveGroups(this.groupsFilePath(), groups, { expectedFingerprint, backupRoot: backupsRoot(this.panelHomePath) })
    this.patchState({ groups: saved.groups, groupsFingerprint: saved.fingerprint, groupsWritable: saved.writable, groupsWarning: saved.warning,
      ...(saved.backupPath === undefined ? {} : { groupsBackupPath: saved.backupPath }) })
  }

  private groupFailure(error: unknown): void {
    this.setStatus(`分组操作失败：${error instanceof Error ? error.message : String(error)}；文件：${this.groupsFilePath()}`, 'error')
  }

  async createGroup(name: string, instances: SkillInstance[] = []): Promise<void> {
    await this.withBusy(async () => {
      try {
        let groups = this.state.groups
        const created = upsertGroup(groups, undefined, name, instances[0] === undefined ? 'global' : this.scopeKeyFor(instances[0]), [])
        groups = created.groups
        for (const instance of instances) {
          groups = setGroupMembership(groups, created.id, this.scopeKeyFor(instance), instance.name, true)
        }
        await this.persistGroups(groups)
        this.setStatus(`已创建分组 "${name}"${instances.length > 0 ? `，加入 ${instances.length} 个技能` : ''}`, 'success')
      } catch (error) {
        this.groupFailure(error)
      }
    })
  }

  async renameGroup(id: string, name: string): Promise<void> {
    await this.withBusy(async () => {
      const group = this.state.groups[id]
      if (group === undefined) {
        this.setStatus('分组不存在', 'error')
        return
      }
      const trimmed = name.trim()
      if (trimmed.length === 0) {
        this.setStatus('分组名称不能为空', 'error')
        return
      }
      const duplicate = Object.entries(this.state.groups).some(
        ([otherId, other]) => otherId !== id && other.name.toLowerCase() === trimmed.toLowerCase(),
      )
      if (duplicate) {
        this.setStatus(`分组名 "${trimmed}" 已存在`, 'error')
        return
      }
      try {
        await this.persistGroups({ ...this.state.groups, [id]: { ...group, name: trimmed } })
        this.setStatus(`已重命名为 "${trimmed}"`, 'success')
      } catch (error) {
        this.groupFailure(error)
      }
    })
  }

  async deleteGroupById(id: string): Promise<void> {
    await this.withBusy(async () => {
      try {
        await this.persistGroups(deleteGroupOp(this.state.groups, id))
        this.setStatus('已删除分组（技能本身未受影响）', 'success')
      } catch (error) {
        this.groupFailure(error)
      }
    })
  }

  /** Add/remove the given instances to a group (per instance scope key). */
  async setGroupMembershipForInstances(groupId: string, instances: SkillInstance[], member: boolean): Promise<void> {
    await this.withBusy(async () => {
      try {
        let groups = this.state.groups
        for (const instance of instances) {
          groups = setGroupMembership(groups, groupId, this.scopeKeyFor(instance), instance.name, member)
        }
        await this.persistGroups(groups)
        const groupName = this.state.groups[groupId]?.name ?? groupId
        this.setStatus(
          `已${member ? '加入' : '移出'}分组 "${groupName}"：${instances.length} 个技能`,
          'success',
        )
      } catch (error) {
        this.groupFailure(error)
      }
    })
  }

  findInstance(id: string): SkillInstance | undefined {
    return this.state.scan?.instances.find((instance) => instance.id === id)
  }

  async loadDetail(instance: SkillInstance): Promise<void> {
    if (this.state.detail.id === instance.id && this.state.detail.status !== 'error') {
      if (this.state.detail.status === 'ready') return
    }
    this.patchState({ detail: { id: instance.id, status: 'loading' } })
    const cached = this.detailCache.get(instance.id)
    if (cached !== undefined) {
      this.patchState({ detail: { id: instance.id, status: 'ready', content: cached } })
      return
    }
    try {
      const content = await readFile(instance.skillFile, 'utf8')
      if (this.disposed) return
      this.detailCache.set(instance.id, content)
      this.patchState({ detail: { id: instance.id, status: 'ready', content } })
    } catch (error) {
      if (this.disposed) return
      this.patchState({
        detail: {
          id: instance.id,
          status: 'error',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
      })
    }
  }

  /** Write the optional JSON dump (verification/debug); no-op without the env var. */
  async writeDump(reason: string): Promise<void> {
    if (this.dumpPath === undefined) return
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        reason,
        pid: process.pid,
        node: process.version,
        cwd: process.cwd(),
        env: {
          dshHome: process.env.DSH_HOME ?? null,
          agentsHome: process.env.DSH_AGENTS_HOME ?? null,
          bundledDir: process.env.DSH_BUNDLED_SKILL_DIR ?? null,
        },
        services: this.state.services.map((service) => ({
          name: service.name,
          present: service.present,
          members: service.members,
        })),
        paths: this.state.paths,
        sceneError: this.state.sceneError ?? null,
        scan: this.state.scan,
        mcpGroups: this.mcpGroupsForCurrentProfile(),
        configWarning: this.state.configWarning,
        skillGroups: { fingerprint: this.state.groupsFingerprint, writable: this.state.groupsWritable, warning: this.state.groupsWarning, backupPath: this.state.groupsBackupPath },
        mcp: {
          ...this.state.mcp,
          rows: this.state.mcp.rows.map((row) => ({ ...row, config: maskSecretConfig(row.config) })),
        },
      }
      await mkdir(dirname(this.dumpPath), { recursive: true })
      await writeFile(this.dumpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      this.patchState({ dumpMessage: `已写入 ${this.dumpPath}` })
    } catch (error) {
      this.patchState({
        dumpMessage: `写入失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /**
   * Login-free UI evidence: append what the scene actually rendered to
   * `SKILL_MCP_PANEL_RENDER_DUMP` (verification/debug only; no env, no I/O).
   */
  writeRenderFrame(reason: string, text: string): void {
    if (this.renderDumpPath === undefined) return
    this.renderFrames += 1
    const header = `\n=== frame ${this.renderFrames} @ ${new Date().toISOString()} ${reason} ===\n`
    void appendFile(this.renderDumpPath, `${header}${text}\n`, 'utf8').catch(() => undefined)
  }

  async dumpNow(): Promise<void> {
    await this.writeDump('manual')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.capabilityTimer !== undefined) clearTimeout(this.capabilityTimer)
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer)
    this.listeners.clear()
  }
}
