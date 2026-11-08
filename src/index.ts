/**
 * dsh-tui-skill-mcp-panel — Cordis plugin entry.
 *
 * M1: full-screen manager scene (skills read-only list/detail + diagnostics)
 * behind `/skill-mcp`. The scene registers through `tuiScenes`; the command runs
 * through `dsh-commands`; every seam is soft-probed so a missing host row
 * degrades to "the command returns a readable error" instead of failing boot.
 *
 * @module dsh-tui-skill-mcp-panel
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ManagerRuntime } from './host/manager-runtime.js'
import { registerManagerCommands, registerManagerScene } from './host/register.js'

export const name = 'dsh-tui-skill-mcp-panel'

/** Every key has a default; a missing value must never fail boot. */
export type Config = {
  /** Scene id registered on `tuiScenes` (kebab-case, globally unique). */
  sceneId?: string
  /** Slash-command name that opens the scene (avoid built-in `skills`/`mcp`). */
  commandName?: string
}

export const Config: Schemastery<Config> = z.object({
  sceneId: z.string().default('skill-mcp-panel'),
  commandName: z.string().default('skill-mcp'),
})

/** Register the scene, the entry command and the manager runtime. */
export function apply(ctx: Context, config: Config = {}): void {
  const sceneId = config.sceneId ?? 'skill-mcp-panel'
  const commandName = config.commandName ?? 'skill-mcp'
  const runtime = new ManagerRuntime(ctx)
  ctx.effect(() => () => runtime.dispose())
  registerManagerScene(ctx, runtime, sceneId)
  registerManagerCommands(ctx, runtime, sceneId, commandName)
}
