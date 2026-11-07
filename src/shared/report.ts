/** Shapes of the JSON report the M0/M1 real-machine probe writes to disk. */

export interface ProbeCapability {
  name: string
  present: boolean
  members?: string[]
  error?: string
}

export interface TimelineEvent {
  at: number
  iso: string
  kind: string
  detail?: unknown
}

export interface McpRowSnapshot {
  entryId?: string
  patchId?: string
  moduleName?: string
  enabled?: boolean
  fiberPhase?: string
}

export interface DialogProbeResult {
  kind: 'confirm' | 'select' | 'input'
  where: 'scene' | 'command'
  startedAt: number
  settledAt?: number
  elapsedMs?: number
  result?: unknown
  error?: string
}

export interface ProbeReport {
  generatedAt: string
  startedAt: string
  reason: string
  pid: number
  node: string
  term: string | undefined
  cwd: string
  dshHome: string
  sceneId: string
  reportPath: string
  capabilities: ProbeCapability[]
  documentPaths: Record<string, unknown>
  pluginInventory: Record<string, unknown>
  loaderSummary?: Record<string, unknown>
  skillsProbe: Record<string, unknown>
  mcpRows: McpRowSnapshot[]
  timeline: TimelineEvent[]
  dialogs: DialogProbeResult[]
  toasts: TimelineEvent[]
  sceneOpens: TimelineEvent[]
}
