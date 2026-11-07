/**
 * M0/M1 real-machine probe runtime (temporary code, removed once the M0 open
 * questions in docs/需求文档.md §12 are answered and recorded).
 *
 * It answers, inside a live dsh-TUI session:
 * - Q7: is a host-level `ctx.skills` usable, or must the panel scan disk?
 * - Q8: are `tuiDialogs` / `tuiToast` visible/usable while a plugin scene owns
 *   the screen?
 * - Q9: is `ctx.pluginManager` callable from a plugin (list + setPluginEnabled)?
 * - Q11: how long does a profile-patch write take to show up in the loader
 *   (HMR latency)?
 *
 * Results are streamed to a JSON report file so a headless driver can inspect
 * them without parsing terminal frames.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  describeService,
  getService,
  type CommandsLike,
  type ConfigEditorLike,
  type LoaderLike,
  type PluginInfoLike,
  type PluginManagerLike,
  type SettingsLike,
  type SkillRegistryLike,
  type TuiDialogServiceLike,
  type TuiSceneServiceLike,
  type TuiToastServiceLike,
} from '../shared/seams.js'
import type {
  DialogProbeResult,
  McpRowSnapshot,
  ProbeCapability,
  ProbeReport,
  TimelineEvent,
} from '../shared/report.js'

/** Services probed at activation; names are stable host service ids. */
const PROBE_SERVICE_NAMES = [
  'tuiScenes',
  'tuiDialogs',
  'tuiToast',
  'tuiStatus',
  'tuiShortcuts',
  'tuiWorkspaces',
  'tuiCommandTrees',
  'tuiPanels',
  'tuiSettingsSections',
  'tuiPluginHost',
  'tuiPrompt',
  'tuiExtensions',
  'tuiRenderers',
  'commands',
  'pluginManager',
  'configEditor',
  'settings',
  'skills',
  'loader',
  'tools',
] as const

const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const POLL_INTERVAL_MS = 500

export interface ProbeRuntimeOptions {
  sceneId: string
  commandName: string
}

function toJson(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, inner: unknown) => {
        if (typeof inner === 'bigint') return String(inner)
        if (typeof inner === 'function') return '[function]'
        if (inner instanceof Error) return { name: inner.name, message: inner.message }
        return inner
      }),
    ) as unknown
  } catch {
    return String(value)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export class ProbeRuntime {
  readonly startedAt = Date.now()
  readonly sceneId: string
  readonly commandName: string
  readonly reportPath: string
  readonly dshHome: string
  capabilities: ProbeCapability[] = []
  readonly documentPaths: Record<string, unknown> = {}
  readonly dialogs: DialogProbeResult[] = []

  private readonly ctx: Context
  private readonly timeline: TimelineEvent[] = []
  private readonly toasts: TimelineEvent[] = []
  private readonly sceneOpens: TimelineEvent[] = []
  private readonly listeners = new Set<() => void>()
  private readonly pendingDialogs = new Set<AbortController>()
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private mcpSignature = ''
  private mcpRows: McpRowSnapshot[] = []
  private pluginInventory: Record<string, unknown> = {}
  private loaderSummary: Record<string, unknown> = {}
  private skillsProbe: Record<string, unknown> = {}
  private sceneService: TuiSceneServiceLike | undefined
  private dialogProxy: TuiDialogServiceLike | undefined
  private toastProxy: TuiToastServiceLike | undefined
  private dialogOwnerCtx: Context | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(ctx: Context, options: ProbeRuntimeOptions) {
    this.ctx = ctx
    this.sceneId = options.sceneId
    this.commandName = options.commandName
    this.dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.reportPath =
      process.env.SKILL_MCP_PROBE_REPORT ??
      join(tmpdir(), 'dsh-tui-skill-mcp-panel', 'probe-report.json')
    this.refreshCapabilities()
    this.scanDocumentPaths()
    this.scanSkills()
    // Capture host seam proxies from inject child contexts: traceable service
    // proxies report the context they were read from as the caller, and the
    // dialog/toast guards resolve ownership from it.
    ctx.inject(['tuiDialogs'], (serviceCtx) => {
      this.dialogOwnerCtx = serviceCtx
      this.dialogProxy = getService<TuiDialogServiceLike>(serviceCtx, 'tuiDialogs')
      this.record('dialogs-proxy-ready')
    })
    ctx.inject(['tuiToast'], (serviceCtx) => {
      this.toastProxy = getService<TuiToastServiceLike>(serviceCtx, 'tuiToast')
      this.record('toast-proxy-ready')
    })
    this.record('activation', { sceneId: this.sceneId, dshHome: this.dshHome })
    this.startPolling()
    void this.writeReport('activation')
  }

  // ── observation ────────────────────────────────────────────────────────────

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): {
    capabilities: ProbeCapability[]
    documentPaths: Record<string, unknown>
    pluginInventory: Record<string, unknown>
    loaderSummary: Record<string, unknown>
    skillsProbe: Record<string, unknown>
    mcpRows: McpRowSnapshot[]
    timeline: TimelineEvent[]
    dialogs: DialogProbeResult[]
    reportPath: string
    sceneId: string
  } {
    return {
      capabilities: this.capabilities,
      documentPaths: this.documentPaths,
      pluginInventory: this.pluginInventory,
      loaderSummary: this.loaderSummary,
      skillsProbe: this.skillsProbe,
      mcpRows: [...this.mcpRows],
      timeline: this.timeline.slice(-14),
      dialogs: this.dialogs.slice(-3),
      reportPath: this.reportPath,
      sceneId: this.sceneId,
    }
  }

  record(kind: string, detail?: unknown): void {
    const event: TimelineEvent = { at: Date.now(), iso: new Date().toISOString(), kind }
    if (detail !== undefined) event.detail = toJson(detail)
    this.timeline.push(event)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A broken listener must never take the probe down.
      }
    }
  }

  recordError(where: string, error: unknown): void {
    this.record('error', { where, error: errorMessage(error) })
  }

  /** Rescan the seam services; records a timeline event when the set changes. */
  private refreshCapabilities(): void {
    const before = this.presentNames().join(',')
    const next: ProbeCapability[] = []
    for (const name of PROBE_SERVICE_NAMES) {
      const service = getService<object>(this.ctx, name)
      if (service === undefined) {
        next.push({ name, present: false })
        continue
      }
      let members: string[] = []
      try {
        members = describeService(service)
      } catch {
        members = ['[unreadable]']
      }
      next.push({ name, present: true, members })
    }
    this.capabilities = next
    const after = this.presentNames().join(',')
    if (before !== after) {
      this.record('capability-change', { present: this.presentNames() })
      void this.writeReport('capability-change')
    }
  }

  presentNames(): string[] {
    return this.capabilities.filter((capability) => capability.present).map((capability) => capability.name)
  }

  /** Loader rows as composed by the host (works without pluginManager). */
  private loaderEntries(): { id?: string; name?: string; disabled?: boolean }[] {
    const loader = getService<LoaderLike>(this.ctx, 'loader')
    if (loader === undefined) return []
    try {
      const rows: { id?: string; name?: string; disabled?: boolean }[] = []
      for (const entry of loader.entries()) {
        const options = entry?.options
        rows.push({
          id: typeof options?.id === 'string' ? options.id : undefined,
          name: typeof options?.name === 'string' ? options.name : undefined,
          disabled: Boolean(entry?.disabled ?? options?.disabled),
        })
      }
      return rows
    } catch (error) {
      this.recordError('loader.entries', error)
      return []
    }
  }

  private scanDocumentPaths(): void {
    const settings = getService<SettingsLike>(this.ctx, 'settings')
    const configEditor = getService<ConfigEditorLike>(this.ctx, 'configEditor')
    const read = (label: string, service: SettingsLike | ConfigEditorLike | undefined): void => {
      if (service === undefined) {
        this.documentPaths[label] = null
        return
      }
      try {
        this.documentPaths[label] = service.documentPath ?? null
      } catch (error) {
        this.documentPaths[label] = { error: errorMessage(error) }
      }
    }
    read('settings.documentPath', settings)
    read('configEditor.documentPath', configEditor)
    this.documentPaths['homePatch'] = join(this.dshHome, 'cordis.patch.yml')
  }

  private scanSkills(): void {
    const skills = getService<SkillRegistryLike>(this.ctx, 'skills')
    if (skills === undefined) {
      this.skillsProbe = { present: false }
      return
    }
    const result: Record<string, unknown> = { present: true, members: describeService(skills) }
    for (const method of ['snapshot', 'list'] as const) {
      const fn = skills[method]
      if (typeof fn !== 'function') {
        result[method] = { available: false }
        continue
      }
      try {
        const value = fn.call(skills)
        const settled = value as { then?: unknown } | undefined
        if (settled !== undefined && typeof settled.then === 'function') {
          void Promise.resolve(value).then(
            (resolved) => {
              result[method] = this.summarizeSkills(resolved)
              this.record(`skills.${method}`, result[method])
            },
            (error: unknown) => {
              result[method] = { error: errorMessage(error) }
              this.record(`skills.${method}.error`, result[method])
            },
          )
        } else {
          result[method] = this.summarizeSkills(value)
        }
      } catch (error) {
        result[method] = { error: errorMessage(error) }
      }
    }
    this.skillsProbe = result
  }

  private summarizeSkills(value: unknown): Record<string, unknown> {
    if (Array.isArray(value)) {
      const names = value
        .map((item) => (typeof item === 'string' ? item : (item as { name?: unknown })?.name))
        .filter((name): name is string => typeof name === 'string')
      return { kind: 'array', count: value.length, names: names.slice(0, 50) }
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const entries = Object.keys(record)
      const skills = Array.isArray(record.skills) ? record.skills : undefined
      const names = skills
        ?.map((item) => (item as { name?: unknown })?.name)
        .filter((name): name is string => typeof name === 'string')
      return {
        kind: 'object',
        keys: entries.slice(0, 50),
        count: entries.length,
        ...(skills === undefined ? {} : { skillsCount: skills.length, names: names?.slice(0, 50) }),
      }
    }
    return { kind: typeof value, value: toJson(value) }
  }

  // ── plugin manager / MCP inventory ────────────────────────────────────────

  private listPlugins(): PluginInfoLike[] {
    const pluginManager = getService<PluginManagerLike>(this.ctx, 'pluginManager')
    if (pluginManager === undefined) return []
    try {
      const plugins = pluginManager.listPlugins()
      return Array.isArray(plugins) ? plugins : []
    } catch (error) {
      this.recordError('pluginManager.listPlugins', error)
      return []
    }
  }

  sampleNow(): void {
    this.refreshCapabilities()
    const plugins = this.listPlugins()
    const loaderEntries = this.loaderEntries()
    const pluginManagerById = new Map(plugins.map((plugin) => [plugin.entryId, plugin]))

    // MCP rows come from the loader tree (always available once composed) and
    // are enriched with pluginManager runtime state when that seam exists.
    const loaderMcp = loaderEntries.filter((entry) => entry.name === MCP_MODULE)
    const merged: McpRowSnapshot[] = loaderMcp.map((entry) => {
      const runtime = entry.id === undefined ? undefined : pluginManagerById.get(entry.id)
      return {
        entryId: entry.id,
        patchId: runtime?.patchId,
        moduleName: entry.name,
        enabled: runtime?.enabled ?? !entry.disabled,
        fiberPhase: runtime?.fiberPhase,
      }
    })
    for (const plugin of plugins) {
      if (plugin.moduleName !== MCP_MODULE) continue
      if (merged.some((row) => row.entryId === plugin.entryId)) continue
      merged.push({
        entryId: plugin.entryId,
        patchId: plugin.patchId,
        moduleName: plugin.moduleName,
        enabled: plugin.enabled,
        fiberPhase: plugin.fiberPhase,
      })
    }

    const byModule: Record<string, number> = {}
    for (const entry of loaderEntries) {
      const moduleName = entry.name ?? 'unknown'
      byModule[moduleName] = (byModule[moduleName] ?? 0) + 1
    }
    this.pluginInventory = {
      loaderEntries: loaderEntries.length,
      pluginManagerEntries: plugins.length,
      byModule,
      topModules: Object.entries(byModule)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20),
    }
    this.loaderSummary = {
      count: loaderEntries.length,
      mcp: loaderMcp,
      probeRow: loaderEntries.find((entry) => entry.name === 'dsh-tui-skill-mcp-panel'),
    }
    this.mcpRows = merged
    const signature = JSON.stringify(merged.map((row) => [row.entryId, row.enabled, row.fiberPhase]))
    if (signature === this.mcpSignature) return
    this.mcpSignature = signature
    this.record('mcp-change', { rows: merged, loader: this.loaderSummary })
    void this.writeReport('mcp-change')
  }

  startPolling(): void {
    if (this.pollTimer !== undefined) return
    this.sampleNow()
    this.pollTimer = setInterval(() => {
      try {
        this.sampleNow()
      } catch (error) {
        this.recordError('poll', error)
      }
    }, POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
  }

  stopPolling(): void {
    if (this.pollTimer === undefined) return
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  // ── scene / command entry points ──────────────────────────────────────────

  setSceneService(service: TuiSceneServiceLike | undefined): void {
    this.sceneService = service
  }

  openScene(): { kind: 'success' | 'error'; text?: string } {
    if (this.sceneService === undefined) {
      this.record('scene-open-unavailable', this.sceneId)
      return { kind: 'error', text: 'tuiScenes is unavailable in this host' }
    }
    let opened = false
    try {
      opened = this.sceneService.open(this.sceneId)
    } catch (error) {
      this.recordError('tuiScenes.open', error)
      return { kind: 'error', text: errorMessage(error) }
    }
    this.record(opened ? 'scene-open' : 'scene-open-missing', this.sceneId)
    if (opened) this.sceneOpens.push({ at: Date.now(), iso: new Date().toISOString(), kind: 'open' })
    void this.writeReport('scene-open')
    return opened ? { kind: 'success' } : { kind: 'error', text: `scene ${this.sceneId} is not registered` }
  }

  // ── Q8: dialogs / toast ───────────────────────────────────────────────────

  async runDialog(
    kind: DialogProbeResult['kind'],
    where: DialogProbeResult['where'],
    mode: 'implicit' | 'explicit' = 'implicit',
  ): Promise<void> {
    const dialogs = this.dialogProxy ?? getService<TuiDialogServiceLike>(this.ctx, 'tuiDialogs')
    const entry: DialogProbeResult = { kind, where, startedAt: Date.now() }
    this.dialogs.push(entry)
    if (dialogs === undefined) {
      entry.error = 'tuiDialogs service unavailable'
      this.record('dialog-unavailable', { kind, where })
      return
    }
    const controller = new AbortController()
    this.pendingDialogs.add(controller)
    this.record('dialog-start', { kind, where, mode })
    const request = {
      title: `PROBE ${kind.toUpperCase()} (${where})`,
      message: 'M0 probe: is this visible while the scene owns the screen?',
      placeholder: 'PROBE-INPUT',
      options: [
        { id: 'probe-a', label: 'PROBE-OPTION-A' },
        { id: 'probe-b', label: 'PROBE-OPTION-B' },
      ],
      signal: controller.signal,
      timeoutMs: 8000,
    }
    try {
      const call = (dialogs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[kind]
      if (typeof call !== 'function') throw new Error(`tuiDialogs.${kind} is not callable`)
      const result = mode === 'explicit' ? await call(this.dialogOwnerCtx, request) : await call(request)
      entry.result = toJson(result)
      entry.settledAt = Date.now()
      entry.elapsedMs = entry.settledAt - entry.startedAt
      this.record('dialog-settled', { kind, where, mode, elapsedMs: entry.elapsedMs, result: entry.result })
    } catch (error) {
      entry.error = errorMessage(error)
      this.recordError(`tuiDialogs.${kind}`, error)
    } finally {
      this.pendingDialogs.delete(controller)
      void this.writeReport(`dialog-${kind}`)
    }
  }

  cancelPendingDialogs(): void {
    for (const controller of this.pendingDialogs) {
      try {
        controller.abort()
      } catch {
        // ignore
      }
    }
    this.pendingDialogs.clear()
  }

  showToast(where: 'scene' | 'command'): void {
    const toast = this.toastProxy ?? getService<TuiToastServiceLike>(this.ctx, 'tuiToast')
    if (toast === undefined) {
      this.record('toast-unavailable', { where })
      return
    }
    const text = `PROBE-TOAST-${where.toUpperCase()}-${Date.now() % 100000}`
    try {
      const delivered = toast.show(text, { color: 'warning', timeoutMs: 8000 })
      this.toasts.push({ at: Date.now(), iso: new Date().toISOString(), kind: 'toast', detail: { where, text, delivered } })
      this.record('toast', { where, text, delivered })
    } catch (error) {
      this.recordError('tuiToast.show', error)
    }
    void this.writeReport(`toast-${where}`)
  }

  // ── Q9: pluginManager ─────────────────────────────────────────────────────

  async toggleFirstMcp(): Promise<void> {
    const pluginManager = getService<PluginManagerLike>(this.ctx, 'pluginManager')
    if (pluginManager === undefined) {
      this.record('plugin-manager-unavailable')
      return
    }
    this.sampleNow()
    const target = this.mcpRows[0]
    if (target?.entryId === undefined) {
      this.record('toggle-skipped', { reason: 'no MCP row in the loader', rows: this.mcpRows })
      return
    }
    const next = target.enabled === false
    const startedAt = Date.now()
    try {
      const result = await pluginManager.setPluginEnabled(target.entryId, next)
      this.record('set-enabled', {
        entryId: target.entryId,
        enabled: next,
        elapsedMs: Date.now() - startedAt,
        result: toJson(result),
      })
    } catch (error) {
      this.recordError('pluginManager.setPluginEnabled', error)
    }
    setTimeout(() => {
      this.sampleNow()
      this.record('post-toggle-sample', { rows: this.mcpRows })
      void this.writeReport('post-toggle')
    }, 1500)
  }

  // ── report ────────────────────────────────────────────────────────────────

  buildReport(reason: string): ProbeReport {
    return {
      generatedAt: new Date().toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      reason,
      pid: process.pid,
      node: process.version,
      term: process.env.TERM,
      cwd: process.cwd(),
      dshHome: this.dshHome,
      sceneId: this.sceneId,
      reportPath: this.reportPath,
      capabilities: this.capabilities,
      documentPaths: this.documentPaths,
      pluginInventory: this.pluginInventory,
      loaderSummary: this.loaderSummary,
      skillsProbe: this.skillsProbe,
      mcpRows: this.mcpRows,
      timeline: this.timeline,
      dialogs: this.dialogs,
      toasts: this.toasts,
      sceneOpens: this.sceneOpens,
    }
  }

  writeReport(reason: string): Promise<void> {
    const report = this.buildReport(reason)
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await mkdir(dirname(this.reportPath), { recursive: true })
          await writeFile(this.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
        } catch (error) {
          this.recordError('writeReport', error)
        }
      })
    return this.writeChain
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPendingDialogs()
    this.stopPolling()
    this.record('dispose')
    void this.writeReport('dispose')
    this.listeners.clear()
  }

  /** Kept for command registration helpers. */
  get commandsAvailable(): boolean {
    return getService<CommandsLike>(this.ctx, 'commands') !== undefined
  }
}
