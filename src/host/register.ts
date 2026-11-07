/** Host wiring: register the probe scene and the `/skill-mcp*` commands. */
import type { Context } from '@deepseek-ai/cordis'
import { getService, type CommandsLike, type TuiSceneServiceLike } from '../shared/seams.js'
import type { ProbeRuntime } from './probe-runtime.js'
import { createProbeScene } from '../ui/ProbeScene.js'

/**
 * Register the full-screen scene on the `tuiScenes` seam.
 *
 * `ctx.inject` waits for the service and re-runs if it is replaced. The scene
 * proxy is captured there because traceable service proxies report the context
 * they were read from as the caller — the host requires a live, non-root plugin
 * activation for register/open.
 */
export function registerProbeScene(ctx: Context, probe: ProbeRuntime): void {
  ctx.inject(['tuiScenes'], (sceneCtx) => {
    const scenes = getService<TuiSceneServiceLike>(sceneCtx, 'tuiScenes')
    if (scenes === undefined) {
      probe.record('scene-service-unavailable')
      return
    }
    probe.setSceneService(scenes)
    try {
      const component = createProbeScene(probe)
      const dispose = scenes.register({
        id: probe.sceneId,
        title: 'Skill / MCP manager (probe)',
        component: component as never,
      })
      ctx.effect(() => () => dispose())
      probe.record('scene-registered', probe.sceneId)
    } catch (error) {
      probe.recordError('tuiScenes.register', error)
    }
  })
}

/** Register the entry command plus two control commands used to isolate Q8. */
export function registerProbeCommands(ctx: Context, probe: ProbeRuntime): void {
  ctx.inject(['commands'], (commandCtx) => {
    const commands = getService<CommandsLike>(commandCtx, 'commands')
    if (commands === undefined) {
      probe.record('commands-unavailable')
      return
    }
    const disposers: (() => void)[] = []
    try {
      disposers.push(
        commands.register({
          name: probe.commandName,
          description: 'Open the Skill & MCP manager',
          handler: () => probe.openScene(),
        }),
      )
      disposers.push(
        commands.register({
          name: `${probe.commandName}-probe-dialog`,
          description: 'M0 probe: confirm dialog outside the scene (visibility baseline)',
          handler: () => {
            void probe.runDialog('confirm', 'command')
            return { kind: 'success' as const }
          },
        }),
      )
      disposers.push(
        commands.register({
          name: `${probe.commandName}-probe-toast`,
          description: 'M0 probe: toast outside the scene (visibility baseline)',
          handler: () => {
            probe.showToast('command')
            return { kind: 'success' as const }
          },
        }),
      )
      probe.record('commands-registered', [probe.commandName, `${probe.commandName}-probe-dialog`, `${probe.commandName}-probe-toast`])
    } catch (error) {
      probe.recordError('commands.register', error)
    }
    ctx.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose()
    })
  })
}
