/** Host wiring: register the manager scene and the `/skill-mcp` command. */
import type { Context } from '@deepseek-ai/cordis'
import { getService, type CommandsLike, type TuiSceneServiceLike } from '../shared/seams.js'
import type { ManagerRuntime } from './manager-runtime.js'
import { createManagerScene } from '../ui/ManagerScene.js'

/**
 * `ctx.inject` waits for the seam (TUI services appear ~1s after activation).
 * The scene proxy is captured there: traceable service proxies report the
 * context they were read from as the caller, and the host requires a live,
 * non-root plugin activation for register/open.
 */
export function registerManagerScene(ctx: Context, runtime: ManagerRuntime, sceneId: string): void {
  ctx.inject(['tuiScenes'], (sceneCtx) => {
    const scenes = getService<TuiSceneServiceLike>(sceneCtx, 'tuiScenes')
    if (scenes === undefined) {
      runtime.reportSceneError('tuiScenes service is unavailable')
      return
    }
    runtime.setSceneService(scenes)
    try {
      const component = createManagerScene(runtime, sceneId)
      const dispose = scenes.register({
        id: sceneId,
        title: 'Skill / MCP manager',
        component: component as never,
      })
      // Injection scopes are disposed when their service disappears, even if
      // the panel activation stays live. Never retain a handler/proxy from it.
      sceneCtx.effect(() => () => {
        runtime.setSceneService(undefined)
        dispose()
      })
    } catch (error) {
      runtime.reportSceneError(
        `tuiScenes.register failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}

/** Register the entry command. Commands run under dsh-commands and stay silent on success. */
export function registerManagerCommands(ctx: Context, runtime: ManagerRuntime, sceneId: string, commandName: string): void {
  ctx.inject(['commands'], (commandCtx) => {
    const commands = getService<CommandsLike>(commandCtx, 'commands')
    if (commands === undefined) {
      runtime.reportSceneError('commands service is unavailable')
      return
    }
    const disposers: (() => void)[] = []
    try {
      disposers.push(
        commands.register({
          name: commandName,
          description: 'Open the Skill & MCP manager',
          handler: () => runtime.openScene(sceneId),
        }),
      )
    } catch (error) {
      runtime.reportSceneError(
        `commands.register failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    commandCtx.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose()
    })
  })
}
