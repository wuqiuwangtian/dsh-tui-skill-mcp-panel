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
  loadPanelConfig,
  panelHome,
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
  latestTrash?: TrashBatch
  config: PanelConfig
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
        ...(loaded.warning === undefined ? { groupsWarning: undefined } : { groupsWarning: loaded.warning }),
      })
    } catch (error) {
      this.patchState({ groupsWarning: error instanceof Error ? error.message : String(error) })
    }
    try {
      const [batches, config] = await Promise.all([listTrash(this.panelHomePath), loadPanelConfig(this.panelHomePath)])
      if (this.disposed) return
      this.patchState({ latestTrash: batches[0], config })
    } catch (error) {
      this.patchState({ groupsWarning: error instanceof Error ? error.message : String(error) })
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
    const readLayer = async (path: string, label: string): Promise<PatchRow[]> => {
      let text: string
      try {
        const snapshot = await readPatchSnapshot(path)
        text = snapshot.text
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
    const rows = buildMcpRows({ loaderRows, profileRows, homeRows })
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
        ...(this.state.mcp.togglingId === undefined ? {} : { togglingId: this.state.mcp.togglingId }),
        ...(this.state.mcp.lastAction === undefined ? {} : { lastAction: this.state.mcp.lastAction }),
      },
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

  // ── groups (shared groups.json v1) ────────────────────────────────────────
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
    await saveGroups(this.groupsFilePath(), groups)
    this.patchState({ groups, groupsWarning: undefined })
  }

  private groupFailure(error: unknown): void {
    this.setStatus(`分组操作失败：${error instanceof Error ? error.message : String(error)}`, 'error')
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
