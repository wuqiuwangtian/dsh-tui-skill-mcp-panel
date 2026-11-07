/**
 * dsh-tui-skill-mcp-panel — Cordis plugin entry.
 *
 * M0/M1 stage: this build only carries the real-machine probe (see
 * `./host/probe-runtime.ts`) plus the `tuiScenes` / `commands` wiring that the
 * final `/skill-mcp` scene will reuse. The probe code is temporary and is
 * replaced by the skill/MCP managers once docs/research/ covers Q7–Q11.
 *
 * @module dsh-tui-skill-mcp-panel
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ProbeRuntime } from './host/probe-runtime.js'
import { registerProbeCommands, registerProbeScene } from './host/register.js'

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

/** Register the scene, the commands and the (temporary) probe runtime. */
export function apply(ctx: Context, config: Config = {}): void {
  const sceneId = config.sceneId ?? 'skill-mcp-panel'
  const commandName = config.commandName ?? 'skill-mcp'
  const probe = new ProbeRuntime(ctx, { sceneId, commandName })
  ctx.effect(() => () => probe.dispose())
  registerProbeScene(ctx, probe)
  registerProbeCommands(ctx, probe)
}
