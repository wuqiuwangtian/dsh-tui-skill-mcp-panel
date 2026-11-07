/**
 * M0/M1 probe scene (temporary): a full-screen diagnostic view that exercises
 * the `tuiScenes` seam and lets the operator trigger the Q8/Q9 probes from the
 * keyboard. It is deliberately dependency-free beyond the injected `React`/`ui`
 * kit and writes its findings to a JSON report file.
 */
import type { ComponentType } from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import type { ProbeRuntime } from '../host/probe-runtime.js'

const KEY_HINTS = 'd confirm(i) · e confirm(owner) · s select · i input · t toast · x toggle MCP · w report · r resample · q close'

export function createProbeScene(probe: ProbeRuntime): ComponentType<TuiSceneProps> {
  return function ProbeScene({ React, ui, close }: TuiSceneProps): ReturnType<typeof ui.Box> {
    const { Box, Text, useInput, useTerminalSize } = ui
    const { columns, rows } = useTerminalSize()
    const [, forceRender] = React.useReducer((value: number) => value + 1, 0)

    React.useEffect(() => {
      probe.record('scene-mount', probe.sceneId)
      const unsubscribe = probe.subscribe(forceRender)
      return () => {
        unsubscribe()
        probe.record('scene-unmount', probe.sceneId)
      }
    }, [])
    React.useEffect(
      () => () => {
        probe.cancelPendingDialogs()
      },
      [],
    )

    useInput((input, key) => {
      if (key.ctrl || key.meta) return
      const text = input.replace(/[\r\n]+/gu, '')
      const char = text.length >= 1 ? text[0]?.toLowerCase() ?? '' : ''
      if (key.escape || char === 'q') {
        close()
        return
      }
      if (char === 'd') void probe.runDialog('confirm', 'scene', 'implicit')
      else if (char === 'e') void probe.runDialog('confirm', 'scene', 'explicit')
      else if (char === 's') void probe.runDialog('select', 'scene')
      else if (char === 'i') void probe.runDialog('input', 'scene')
      else if (char === 't') probe.showToast('scene')
      else if (char === 'x') void probe.toggleFirstMcp()
      else if (char === 'w') void probe.writeReport('manual')
      else if (char === 'r') {
        probe.sampleNow()
        forceRender()
      }
    })

    const snapshot = probe.snapshot()
    const present = snapshot.capabilities.filter((capability) => capability.present).map((capability) => capability.name)
    const missing = snapshot.capabilities.filter((capability) => !capability.present).map((capability) => capability.name)
    const paths = snapshot.documentPaths
    const inventory = snapshot.pluginInventory as { count?: number; topModules?: [string, number][] }
    const skills = snapshot.skillsProbe
    const dialogLines = snapshot.dialogs.map(
      (dialog) =>
        `${dialog.kind}/${dialog.where}: ${dialog.error ?? JSON.stringify(dialog.result)} (${dialog.elapsedMs ?? '…'}ms)`,
    )
    const timelineLines = snapshot.timeline.map((event) => {
      const time = new Date(event.at).toISOString().slice(11, 23)
      const detail = event.detail === undefined ? '' : ` ${JSON.stringify(event.detail).slice(0, 96)}`
      return `${time} ${event.kind}${detail}`
    })

    const visiblePathLines = Math.max(2, Math.min(8, Math.floor((rows - 20) / 2)))

    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Text bold color="subtle">
          skill-mcp probe · M0 verification · {columns}x{rows}
        </Text>
        <Text wrap="truncate">
          scene={snapshot.sceneId} · report={snapshot.reportPath}
        </Text>
        <Text wrap="truncate" dimColor>
          services: {present.join(', ')}
        </Text>
        <Text wrap="truncate" dimColor>
          missing: {missing.length === 0 ? '(none)' : missing.join(', ')}
        </Text>
        <Text wrap="truncate">
          patch(settings)={String(paths['settings.documentPath'])} · patch(configEditor)=
          {String(paths['configEditor.documentPath'])}
        </Text>
        <Text wrap="truncate">home patch={String(paths.homePatch)}</Text>
        <Text wrap="truncate">plugins={inventory.count ?? '?'} · top={JSON.stringify(inventory.topModules ?? [])}</Text>
        <Text wrap="truncate">skills probe={JSON.stringify(skills).slice(0, 240)}</Text>

        <Text bold color="subtle">
          MCP rows ({snapshot.mcpRows.length})
        </Text>
        {snapshot.mcpRows.length === 0 ? (
          <Text dimColor>(none in loader — append a row to the profile patch to test HMR)</Text>
        ) : (
          snapshot.mcpRows.map((row, index) => (
            <Text key={`mcp-${index}`} wrap="truncate">
              {row.entryId ?? '?'} · enabled={String(row.enabled)} · {row.fiberPhase ?? '?'}
            </Text>
          ))
        )}

        <Text bold color="subtle">
          Dialogs ({dialogLines.length})
        </Text>
        {dialogLines.length === 0 ? <Text dimColor>(press d/s/i; they time out after 8s)</Text> : null}
        {dialogLines.slice(-3).map((line, index) => (
          <Text key={`dialog-${index}`} wrap="truncate">
            {line}
          </Text>
        ))}

        <Text bold color="subtle">
          Timeline (tail)
        </Text>
        {timelineLines.slice(-visiblePathLines).map((line, index) => (
          <Text key={`event-${index}`} wrap="truncate" dimColor>
            {line}
          </Text>
        ))}

        <Box flexGrow={1} />
        <Text wrap="truncate" bold>
          {KEY_HINTS}
        </Text>
      </Box>
    )
  }
}
