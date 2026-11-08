/**
 * Host-side state for the management scene: skill scan results, detail reads,
 * host capability diagnostics and an optional JSON dump (env
 * `SKILL_MCP_PANEL_DUMP`) used by real-machine verification.
 *
 * No React here; the scene subscribes to `snapshot()`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { scanSkills } from '../domain/skills/index.js'
import type { SkillInstance, SkillScanResult } from '../domain/skills/types.js'
import {
  describeService,
  getService,
  type CommandResultLike,
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
  sceneError?: string
  dumpPath?: string
  dumpMessage?: string
}

export class ManagerRuntime {
  readonly startedAt = Date.now()
  private readonly ctx: Context
  private readonly listeners = new Set<() => void>()
  private readonly dumpPath: string | undefined
  private readonly detailCache = new Map<string, string>()
  private sceneService: TuiSceneServiceLike | undefined
  private state: ManagerState
  private capabilityTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private scanStartedAt = 0

  constructor(ctx: Context) {
    this.ctx = ctx
    this.dumpPath = process.env.SKILL_MCP_PANEL_DUMP ?? undefined
    this.state = {
      status: 'loading',
      refreshing: true,
      services: [],
      paths: { homePatch: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cordis.patch.yml') },
      detail: { status: 'idle' },
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
        scan: this.state.scan,
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

  async dumpNow(): Promise<void> {
    await this.writeDump('manual')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.capabilityTimer !== undefined) clearTimeout(this.capabilityTimer)
    this.listeners.clear()
  }
}
