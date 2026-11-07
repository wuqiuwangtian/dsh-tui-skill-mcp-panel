/**
 * Minimal structural views of the host seams this plugin consumes.
 *
 * Deliberate: the plugin never imports `@deepseek-ai/dsh-*` runtime modules and
 * never takes a hard dependency on host-internal service classes. Every seam is
 * probed with `ctx.get(name, false)` and only the small documented method
 * surface is relied on; a missing service degrades to "nothing happens".
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Read a service without requiring it.
 *
 * `ctx.get()` returns a caller-bound traceable proxy, so the service callbacks
 * created from these proxies report the plugin activation as the caller — the
 * host's activation guards (e.g. `tuiScenes.open`) therefore accept them.
 */
export function getService<T>(ctx: Context, name: string): T | undefined {
  try {
    const get = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get
    if (typeof get !== 'function') return undefined
    return (get.call(ctx, name, false) as T | undefined) ?? undefined
  } catch {
    return undefined
  }
}

/** Human-readable member list of a service instance (methods, getters, fields). */
export function describeService(value: object): string[] {
  const members = new Set<string>()
  let current: object | null = value
  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor' || members.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor === undefined) continue
      if (typeof descriptor.get === 'function') members.add(key)
      else if (typeof descriptor.value === 'function') members.add(`${key}()`)
      else members.add(key)
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return [...members].sort()
}

export interface CommandResultLike {
  kind: 'success' | 'error'
  text?: string
}

export interface CommandsLike {
  register(definition: {
    name: string
    description?: string
    handler: (invocation?: unknown) => CommandResultLike | Promise<CommandResultLike>
  }): () => void
}

export interface TuiSceneServiceLike {
  register(
    descriptor: { id: string; title?: string; component: unknown },
    identity?: unknown,
  ): () => void
  open(id: string): boolean
  close(): void
}

export interface TuiDialogRequestLike {
  title: string
  message?: string
  placeholder?: string
  initial?: string
  options?: { id: string; label: string; description?: string }[]
  signal?: AbortSignal
  timeoutMs?: number
}

export interface TuiDialogServiceLike {
  select(request: TuiDialogRequestLike): Promise<string | undefined>
  confirm(request: TuiDialogRequestLike): Promise<boolean>
  input(request: TuiDialogRequestLike): Promise<string | undefined>
}

export interface TuiToastServiceLike {
  show(
    text: string | number | boolean,
    options?: { color?: 'success' | 'warning' | 'error'; timeoutMs?: number },
  ): boolean
}

export interface PluginInfoLike {
  entryId?: string
  patchId?: string
  moduleName?: string
  enabled?: boolean
  fiberPhase?: string
  diagnostic?: unknown
}

export interface PluginManagerLike {
  listPlugins(): PluginInfoLike[]
  setPluginEnabled(entryId: string, enabled: boolean): unknown
}

export interface SkillRegistryLike {
  snapshot?: (...args: unknown[]) => unknown
  list?: (...args: unknown[]) => unknown
  get?: (name: string) => unknown
}

export interface LoaderEntryLike {
  options?: { id?: string; name?: string; disabled?: unknown }
  disabled?: unknown
}

export interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

export interface DocumentPathLike {
  readonly documentPath?: string
}

export type ConfigEditorLike = DocumentPathLike
export type SettingsLike = DocumentPathLike
