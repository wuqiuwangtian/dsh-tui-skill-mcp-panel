/**
 * Headless Ink render smoke test for the manager scene (dev-only).
 *
 * Why: the sandboxed terminal used for real-machine probes cannot reliably
 * capture a long-running TUI frame, but the scene risk we need to rule out is
 * "the component throws / renders nothing under the host's React 19 + ui kit".
 * This script mounts the real compiled scene with a stub runtime through the
 * host's own `renderSync` and asserts the rendered text contains the expected
 * list/detail content. It is NOT a substitute for the manual TTY walkthrough.
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createManagerScene } from '../lib/types/ui/ManagerScene.js'
import { scanSkills } from '../lib/types/domain/skills/index.js'

const require = createRequire(import.meta.url)
const dshTuiManifest = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const dshTuiDir = dirname(dshTuiManifest)
const uiFile = join(dshTuiDir, 'lib', 'types', 'ui.js')
const requireFromHost = createRequire(uiFile)
const React = requireFromHost('react')
const ui = await import(pathToFileURL(uiFile).href)

class FakeStdout extends EventEmitter {
  constructor(columns, rows) {
    super()
    this.isTTY = true
    this.columns = columns
    this.rows = rows
    this.chunks = []
  }

  write(chunk) {
    this.chunks.push(String(chunk))
    return true
  }

  getColorDepth() {
    return 8
  }

  hasColors() {
    return true
  }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super()
    this.isTTY = true
  }

  setRawMode() {}
  ref() {}
  unref() {}
  read() {
    return null
  }
  setEncoding() {}
  pause() {}
  resume() {}
}

class StubRuntime {
  constructor(scan) {
    this.scan = scan
    this.listeners = new Set()
    this.state = {
      status: 'ready',
      scan,
      refreshing: false,
      refreshReason: 'smoke',
      services: [],
      paths: { homePatch: join(process.env.DSH_HOME ?? '', 'cordis.patch.yml') },
      detail: { status: 'idle' },
    }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot() {
    return this.state
  }

  notify() {
    for (const listener of this.listeners) listener()
  }

  async ensureFresh() {}

  async refresh(reason) {
    this.state = { ...this.state, refreshReason: reason }
    this.notify()
  }

  async loadDetail(instance) {
    try {
      const content = readFileSync(instance.skillFile, 'utf8')
      this.state = { ...this.state, detail: { id: instance.id, status: 'ready', content } }
    } catch (error) {
      this.state = { ...this.state, detail: { id: instance.id, status: 'error', error: String(error) } }
    }
    this.notify()
  }

  async dumpNow() {}

  writeRenderFrame() {}
}

const stripAnsi = (text) =>
  text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
    .replace(/\x1b\][^\x07]*\x07/gu, '')
    .replace(/\r/gu, '')

async function renderAt(columns) {
  const stdout = new FakeStdout(columns, 40)
  const stdin = new FakeStdin()
  const scan = await scanSkills({ cwd: process.cwd() })
  const runtime = new StubRuntime(scan)
  const Component = createManagerScene(runtime, 'skill-mcp-panel')
  const element = React.createElement(Component, {
    React,
    ui,
    channel: {},
    close: () => {},
  })
  const instance = ui.renderSync(element, {
    stdout,
    stdin,
    stderr: stdout,
    patchConsole: false,
    exitOnCtrlC: false,
    terminalImages: false,
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  instance.unmount()
  await new Promise((resolve) => setTimeout(resolve, 50))
  return stripAnsi(stdout.chunks.join(''))
}

const failures = []
const squash = (text) => text.replace(/\s+/gu, '')
const assertContains = (label, text, needles) => {
  const haystack = squash(text)
  for (const needle of needles) {
    if (!haystack.includes(squash(needle))) failures.push(`${label}: missing ${JSON.stringify(needle)}`)
  }
}

const frameWide = await renderAt(160)
assertContains('wide', frameWide, [
  'Skill / MCP manager',
  'Skills 技能',
  'Diagnostics 诊断',
  '技能列表',
  '详情',
  'alpha',
  'beta',
  'software-delivery-workflow',
  'project/.dsh',
  '共 ',
])

const frameNarrow = await renderAt(58)
assertContains('narrow', frameNarrow, ['Skill / MCP manager', '技能', '诊断', 'alpha', '技能列表'])

if (failures.length > 0) {
  console.error('render-smoke FAILED')
  for (const failure of failures) console.error(` - ${failure}`)
  console.error('--- wide frame (tail) ---')
  console.error(frameWide.slice(-5000))
  console.error('--- narrow frame (tail) ---')
  console.error(frameNarrow.slice(-3000))
  process.exit(1)
}
console.log(`render-smoke OK: wide=${frameWide.length} chars, narrow=${frameNarrow.length} chars`)
