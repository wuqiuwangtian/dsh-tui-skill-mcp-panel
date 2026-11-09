/** Real UI + ManagerRuntime on temporary files; profile groups, filters and lifecycle with a recomposing fake loader. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { ManagerRuntime } from '../lib/types/host/manager-runtime.js'
import { createManagerScene } from '../lib/types/ui/ManagerScene.js'
import { MCP_MODULE, parsePatchText } from '../lib/types/domain/mcp/patch.js'
import { addManagedMcp } from '../lib/types/domain/mcp/managed.js'
import { upsertMcpGroup } from '../lib/types/domain/mcp/groups.js'
import { updateMcpGroups } from '../lib/types/domain/store.js'

const require = createRequire(import.meta.url)
const hostManifest = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const React = createRequire(hostManifest)('react')
const ui = await import(pathToFileURL(join(dirname(hostManifest), 'lib/types/ui.js')).href)
const { Terminal } = require('@xterm/headless')
const columns = Number(process.argv[2] ?? 120)
const rows = 40
const root = await mkdtemp(join(tmpdir(), 'mcp-groups-ui-'))
const home = join(root, 'dsh')
const project = join(root, 'project')
const patchPath = join(root, 'cordis.patch.yml')
const panel = join(root, 'panel')
await mkdir(join(project, '.git'), { recursive: true })
const original = `# user-owned bytes\n- insert:\n    - id: entry-a\n      name: '${MCP_MODULE}'\n      config: {serverName: alpha, transport: stdio, command: node, env: {TOKEN: hidden-value}}\n    - id: entry-b\n      name: '${MCP_MODULE}'\n      disabled: true\n      config: {serverName: alpha, transport: stdio, command: node}\n`
const homeText = `- insert:\n    - id: entry-c\n      name: '${MCP_MODULE}'\n      config: {serverName: broken, transport: stdio, command: node}\n`
await mkdir(home, { recursive: true })
await writeFile(join(home, 'cordis.patch.yml'), homeText)
const shared = join(home, 'skills', '.system', 'skill-viewer', 'groups.json')
await mkdir(dirname(shared), { recursive: true })
const sharedText = '{"version":1,"groups":{}}\n'
await writeFile(shared, sharedText)
await mkdir(join(project, '.dsh', 'skills', 'local-skill'), { recursive: true })
await writeFile(join(project, '.dsh', 'skills', 'local-skill', 'SKILL.md'), '---\nname: local-skill\ndescription: fixture\n---\nbody\n')
await writeFile(patchPath, original)
process.env.DSH_HOME = home
process.env.DSH_AGENTS_HOME = join(root, 'agents')
process.env.SKILL_MCP_PANEL_HOME = panel
process.env.SKILL_MCP_PANEL_DUMP = join(root, 'dump.json')
process.env.SKILL_MCP_PANEL_RENDER_DUMP = join(root, 'render.txt')
delete process.env.DSH_BUNDLED_SKILL_DIR
process.chdir(project)

let entries = []
let seen = ''
let pending
let polling = false
const recompose = (text) => {
  const parsed = parsePatchText(`${text}\n${homeText}`)
  assert.equal(parsed.ok, true)
  const table = new Map()
  for (const row of parsed.rows) {
    if (row.id === undefined) continue
    table.set(row.id, { ...table.get(row.id), ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) })
  }
  entries = [...table.values()].filter((row) => row.name === MCP_MODULE).map((row) => ({
    options: { id: row.id, name: row.name, config: row.config }, disabled: row.disabled === true,
    fiber: row.disabled === true ? undefined : { state: row.id === 'entry-c' ? 3 : 2 },
  }))
}
recompose(original)
seen = original
const watch = setInterval(async () => {
  if (polling) return
  polling = true
  try {
    const text = await readFile(patchPath, 'utf8')
    if (text !== seen) {
      seen = text
      clearTimeout(pending)
      pending = setTimeout(() => recompose(text), 600)
    }
  } finally { polling = false }
}, 50)
const ctx = { get: (name) => name === 'loader' ? { entries: () => entries } : name === 'configEditor' ? { documentPath: patchPath } : undefined }
const runtime = new ManagerRuntime(ctx)
await runtime.refresh('crud-smoke')
class Output extends EventEmitter {
  isTTY = true
  columns = columns
  rows = rows
  chunks = []
  write(chunk) { this.chunks.push(String(chunk)); return true }
  getColorDepth() { return 8 }
  hasColors() { return true }
}
class Input extends Readable {
  isTTY = true
  constructor() { super({ read() {} }) }
  setRawMode() {}
  ref() {}
  unref() {}
}
const stdout = new Output()
const stdin = new Input()
const Component = createManagerScene(runtime, 'crud-smoke')
const instance = ui.renderSync(React.createElement(Component, { React, ui, channel: {}, close() {} }), {
  stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false, terminalImages: false,
})
const press = async (value) => { stdin.push(value); await sleep(100) }
const paste = async (value) => { await press(`\x1b[200~${value}\x1b[201~`) }
const screen = async () => {
  const term = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 })
  await new Promise((resolve) => term.write(stdout.chunks.join(''), resolve))
  const text = Array.from({ length: rows }, (_, index) => term.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n')
  term.dispose()
  return text
}
const waitFor = async (condition, label) => {
  const deadline = Date.now() + 7000
  while (!condition() && Date.now() < deadline) await sleep(50)
  assert.ok(condition(), `${label}: ${runtime.snapshot().statusMessage?.text ?? ''}`)
}
const down = () => press('\x1b[B')
const enter = () => press('\r')
const clear = () => press('\x15')

const frame = async () => { const text = await readFile(join(root, 'render.txt'), 'utf8'); return text.slice(text.lastIndexOf('=== frame ')) }
const view = async (needle) => assert.ok((await frame()).includes(needle), `expected frame: ${needle}`)
const idle = () => waitFor(() => !runtime.snapshot().busy, 'metadata operation finishes')
const filterOption = async (index) => { await press('f'); await press('\x1b[H'); for (let i = 0; i < index; i++) await down(); await enter() }

try {
  await sleep(200)
  await press('/'); await paste('local-skill'); await enter()
  await press('2')
  await press('g'); await enter(); await paste('Tools'); await enter(); await idle()
  const groups = () => runtime.mcpGroupsForCurrentProfile()
  const id = Object.keys(groups())[0]
  assert.deepEqual(groups()[id].members, ['["alpha","entry-a"]'])
  assert.ok((await screen()).includes('Tools'))
  await press('g'); await enter(); await idle()
  assert.deepEqual(groups()[id].members, [])
  await press('g'); await enter(); await idle()
  await down(); await press('g'); await enter(); await idle()
  assert.equal(groups()[id].members.length, 2, 'same server name uses distinct entryIds')
  await filterOption(2)
  await view('mcp(1): entry-b:off:profile')
  await filterOption(5)
  await view(`status=disabled group=${id}`)
  await press('/'); await paste('Tools entry-b'); await enter()
  await view('mcp(1): entry-b:off:profile')
  await press('x')
  await view('mcp(3):')
  await filterOption(3)
  await view('mcp(1): entry-c:on:home:ro')
  await press('x'); await press('/'); await paste('hidden-value'); await enter()
  await view('mcp(0):')
  assert.ok((await screen()).includes('没有匹配的 MCP'))
  await press('x'); await press('1')
  await view('query="local-skill"')
  await press('3'); await press('t')
  assert.ok((await screen()).includes('Tools'))
  await press('r'); await clear(); await paste('Renamed'); await enter(); await idle()
  assert.equal(groups()[id].name, 'Renamed')
  await enter()
  await view(`status=all group=${id}`)
  await view('mcp(2):')
  await press('x'); await press('3'); await press('a'); await paste('Empty'); await enter(); await idle()
  assert.equal(Object.keys(groups()).length, 2)
  await press('d'); await press('\x1b')
  assert.equal(Object.keys(groups()).length, 2)
  await press('d'); await press('y'); await idle()
  assert.equal(Object.keys(groups()).length, 1)
  // Group metadata never changes either YAML layer or the shared web skills schema.
  assert.equal(await readFile(patchPath, 'utf8'), original)
  assert.equal(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), homeText)
  assert.equal(await readFile(shared, 'utf8'), sharedText)

  const homeRow = runtime.snapshot().mcp.rows.find((row) => row.entryId === 'entry-c')
  assert.equal(homeRow.targetable, false)
  await runtime.createMcpGroup('Home-only', [homeRow])
  const homeGroupId = Object.keys(groups()).find((key) => groups()[key].name === 'Home-only')
  assert.deepEqual(groups()[homeGroupId].members, ['["broken","entry-c"]'])
  await runtime.deleteMcpGroup(homeGroupId)
  assert.equal(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), homeText)

  const ctxB = { get: (name) => name === 'configEditor' ? { documentPath: join(root, 'b.patch.yml') } : ctx.get(name) }
  await writeFile(join(root, 'b.patch.yml'), original)
  const other = new ManagerRuntime(ctxB)
  try {
    await other.refresh('other-profile')
    assert.deepEqual(other.mcpGroupsForCurrentProfile(), {})
    await other.createMcpGroup('Renamed', [{ serverName: 'alpha', entryId: 'entry-a' }])
    assert.equal(Object.keys(other.mcpGroupsForCurrentProfile()).length, 1)
    const oldName = Object.values(groups())[0].name
    await runtime.renameMcpGroup(Object.keys(groups())[0], 'A-only')
    assert.equal(Object.values(groups())[0].name, 'A-only', 'other-profile changes merge')
    await other.refreshMcp()
    assert.equal(Object.values(other.mcpGroupsForCurrentProfile())[0].name, oldName)
  } finally { other.dispose() }
  const cold = new ManagerRuntime(ctx)
  try {
    await cold.refresh('cold-groups')
    assert.equal(Object.values(cold.mcpGroupsForCurrentProfile())[0].name, 'A-only')
    await cold.renameMcpGroup(Object.keys(cold.mcpGroupsForCurrentProfile())[0], 'External')
    const bytes = await readFile(join(panel, 'config.json'), 'utf8')
    await runtime.createMcpGroup('stale')
    assert.ok(runtime.snapshot().statusMessage.text.includes('请刷新'))
    assert.equal(await readFile(join(panel, 'config.json'), 'utf8'), bytes)
    await runtime.refreshMcp()
    assert.equal(Object.values(groups())[0].name, 'External')
  } finally { cold.dispose() }

  // Runtime rename synchronizes membership; delete/undo keep the reference intact.
  const text = addManagedMcp(original, 'managed', { serverName: 'managed', transport: 'stdio', command: 'node' })
  await writeFile(patchPath, text)
  await waitFor(() => entries.some((entry) => entry.options.id === 'managed'), 'managed row composed')
  await runtime.refreshMcp()
  await runtime.createMcpGroup('Lifecycle', [{ serverName: 'managed', entryId: 'managed' }])
  const lifecycleId = Object.keys(groups()).find((key) => groups()[key].name === 'Lifecycle')
  const session = await runtime.openMcpForm('managed')
  await runtime.saveMcpForm(session, { ...session.config, serverName: 'managed-new' })
  assert.equal(runtime.snapshot().mcp.lastAction.outcome, 'applied')
  assert.deepEqual(groups()[lifecycleId].members, ['["managed-new","managed"]'])
  await runtime.deleteMcp('managed')
  assert.equal(runtime.snapshot().mcp.lastAction.outcome, 'applied')
  assert.deepEqual(groups()[lifecycleId].members, ['["managed-new","managed"]'])
  await runtime.undoMcpDelete()
  assert.equal(runtime.snapshot().mcp.lastAction.outcome, 'applied')
  assert.deepEqual(groups()[lifecycleId].members, ['["managed-new","managed"]'])
  await press('2')
  for (const label of ['g分组', 'f筛选', '/搜索', 'x清除']) {
    if (columns < 110) assert.ok((await screen()).includes(label), `narrow footer exposes ${label}`)
  }
  await updateMcpGroups(panel, patchPath, (groups) => {
    for (let i = 0; i < 45; i++) groups = upsertMcpGroup(groups, patchPath, undefined, `Page${String(i).padStart(2, '0')}`).groups
    return groups
  })
  await runtime.refreshMcp()
  await press('f'); await press('\x1b[F')
  assert.ok((await screen()).includes('Page44'), 'large group selector pages to the last option')
  await enter()
  await view('mcp(0):')
  await press('x')
  assert.ok(!(await frame()).includes('hidden-value'))
  console.log(`mcp-groups-smoke OK (${columns} cols): membership / search+filters / groups CRUD / profile isolation / stale conflict / cold reload / rename+delete+undo / no YAML or shared-schema metadata writes`)
} catch (error) {
  console.error((await screen()).slice(-4000))
  console.error((await frame()).slice(0, 1500))
  throw error
} finally {
  clearInterval(watch)
  clearTimeout(pending)
  instance.unmount()
  runtime.dispose()
  await sleep(100)
  await rm(root, { recursive: true, force: true })
}
