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

export interface DocumentPathLike {
  readonly documentPath?: string
}

export interface LoaderEntryLike {
  options?: {
    id?: string
    name?: string
    config?: unknown
    disabled?: unknown
  }
  disabled?: boolean
  fiber?: { state?: number }
}

export interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}
