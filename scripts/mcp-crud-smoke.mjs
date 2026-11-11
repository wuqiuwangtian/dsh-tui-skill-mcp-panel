/** Real UI + ManagerRuntime on temporary files; stable fake loader recomposes after disk changes. */
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
import { MCP_MODULE, jsValue, parsePatchText, upsertManagedToggle } from '../lib/types/domain/mcp/patch.js'
import { editManagedMcp, managedMcpEntries } from '../lib/types/domain/mcp/managed.js'

const require = createRequire(import.meta.url)
const hostManifest = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const React = createRequire(hostManifest)('react')
const ui = await import(pathToFileURL(join(dirname(hostManifest), 'lib/types/ui.js')).href)
const { Terminal } = require('@xterm/headless')
const columns = Number(process.argv[2] ?? 120)
const rows = 40
const root = await mkdtemp(join(tmpdir(), 'mcp-crud-ui-'))
const home = join(root, 'dsh')
const project = join(root, 'project')
const patchPath = join(root, 'cordis.patch.yml')
const panel = join(root, 'panel')
await mkdir(join(project, '.git'), { recursive: true })
const original = `# user-owned bytes\n- insert:\n    - id: existing\n      name: '${MCP_MODULE}'\n      config: {serverName: existing, transport: stdio, command: node}\n`
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
  const parsed = parsePatchText(text)
  assert.equal(parsed.ok, true)
  const table = new Map()
  for (const row of parsed.rows) {
    if (row.id === undefined) continue
    table.set(row.id, { ...table.get(row.id), ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) })
  }
  entries = [...table.values()].filter((row) => row.name === MCP_MODULE).map((row) => ({
    options: { id: row.id, name: row.name, config: row.config }, disabled: row.disabled === true,
    fiber: row.disabled === true ? undefined : { state: 2 },
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
const applied = (action) => !runtime.snapshot().busy && runtime.snapshot().mcp.lastAction?.action === action && runtime.snapshot().mcp.lastAction?.outcome === 'applied'
const down = () => press('\x1b[B')
const enter = () => press('\r')
const clear = () => press('\x15')
const chooseFieldValue = async (text) => { await enter(); await clear(); await paste(text); await enter() }

try {
  await sleep(200)
  await press('2')
  await press('a')
  assert.ok((await screen()).includes('新增 MCP'))
  await chooseFieldValue('crud-test')
  await down(); await down()
  await chooseFieldValue(process.execPath)
  await down()
  await chooseFieldValue('["server.js"]')
  await down(); await down()
  await enter()
  await paste('SMOKE_TOKEN=${MCP_SMOKE_TOKEN}\nEXTRA=literal-private-value')
  assert.ok(!(await screen()).includes('literal-private-value'))
  await enter()
  assert.ok(!(await screen()).includes('MCP_SMOKE_TOKEN'))
  await down(); await down(); await down()
  await enter()
  assert.ok((await screen()).includes('变更字段'))
  assert.ok(!(await screen()).includes('literal-private-value'))
  await press('n')
  assert.ok((await screen()).includes('新增 MCP'))
  await enter(); await press('y')
  await waitFor(() => applied('create'), 'create through UI')
  const id = runtime.snapshot().mcp.lastAction.id
  assert.equal(id, 'mcp-crud-test')
  assert.equal(runtime.snapshot().mcp.rows.find((row) => row.id === id).managed, true)
  let text = await readFile(patchPath, 'utf8')
  let entry = managedMcpEntries(text)[0]
  assert.ok(entry.config.env.SMOKE_TOKEN.__js.includes('process.env.MCP_SMOKE_TOKEN'))
  const future = { nested: jsValue('process.env.FUTURE') }
  text = editManagedMcp(text, id, 'crud-test', { ...entry.config, future })
  await writeFile(patchPath, text)
  await waitFor(() => entries.find((row) => row.options.id === id)?.options.config.future !== undefined, 'external unknown key composed')
  await runtime.refreshMcp()
  await enter()
  await down(); await down(); await down()
  await chooseFieldValue('["server.js", "--edited"]')
  for (let count = 0; count < 5; count++) await down()
  await enter(); await press('y')
  assert.equal(runtime.snapshot().mcp.lastAction?.outcome, 'saved', 'edit waits for actual reload')
  await waitFor(() => applied('edit'), 'edit through UI')
  entry = managedMcpEntries(await readFile(patchPath, 'utf8'))[0]
  assert.deepEqual(entry.config.future, future)
  assert.ok(entry.config.env.SMOKE_TOKEN.__js.includes('MCP_SMOKE_TOKEN'))
  assert.deepEqual(entry.config.args, ['server.js', '--edited'])
  const beforeDelete = await readFile(patchPath, 'utf8')
  await press('d'); await press('\x1b')
  assert.equal(await readFile(patchPath, 'utf8'), beforeDelete)
  await press('d'); await press('y')
  await waitFor(() => applied('delete'), 'delete through UI')
  assert.equal(await readFile(patchPath, 'utf8'), original)
  assert.ok(runtime.snapshot().mcp.latestDeletion)
  await press('u')
  await waitFor(() => applied('restore'), 'restore through UI')
  assert.equal(await readFile(patchPath, 'utf8'), beforeDelete)
  await press('\x1b[F')
  await enter()
  assert.ok((runtime.snapshot().statusMessage?.text ?? '').includes('已有 profile 行仅支持启停'))
  await press('d')
  assert.equal(await readFile(patchPath, 'utf8'), beforeDelete)
  const dump = JSON.parse(await readFile(join(root, 'dump.json'), 'utf8'))
  assert.equal(dump.mcp.rows.find((row) => row.id === id).config.env.EXTRA, '***')
  const render = await readFile(join(root, 'render.txt'), 'utf8')
  assert.ok(!render.includes('literal-private-value'))

  // The second transport must expose its own fields and mask header input too.
  await press('a')
  await chooseFieldValue('crud-http')
  await down(); await enter(); await press('\x1b')
  assert.ok((await screen()).includes('新增 MCP'), 'Esc from transport returns to the form')
  await enter(); await down(); await enter()
  await down(); await chooseFieldValue('https://example.invalid/mcp')
  await down(); await enter(); await paste('Authorization=Bearer ${HTTP_TOKEN}'); await enter()
  for (let count = 0; count < 3; count++) await down()
  await enter(); await press('y')
  await waitFor(() => applied('create'), 'HTTP form create')
  const http = managedMcpEntries(await readFile(patchPath, 'utf8')).find((row) => row.serverName === 'crud-http')
  assert.equal(http.config.transport, 'streamable-http')
  assert.ok(http.config.headers.Authorization.__js.includes('process.env.HTTP_TOKEN'))
  const beforeHttpDelete = await readFile(patchPath, 'utf8')
  await press('\x1b[H'); await press('d'); await press('y')
  await waitFor(() => applied('delete'), 'HTTP delete')

  // The migration is an explicit UI action, and cancel must preserve bytes.
  let legacy = upsertManagedToggle(await readFile(patchPath, 'utf8'), 'existing', true).text
  await writeFile(patchPath, legacy)
  await waitFor(() => entries.find(row=>row.options.id==='existing')?.disabled === true, 'legacy configuration composed')
  await press('r')
  assert.equal(runtime.snapshot().mcp.legacyToggles.length,1)
  assert((await screen()).includes('旧启停配置'))
  await press('m')
  assert((await screen()).includes('迁移旧 MCP 启停配置'))
  await press('n')
  assert.equal(await readFile(patchPath,'utf8'),legacy)
  // Even a runtime refresh cannot silently widen an already-open preview.
  await press('m')
  legacy += '\n# external change while preview is open\n'
  await writeFile(patchPath,legacy)
  await runtime.refreshMcp()
  await press('y')
  assert.equal(await readFile(patchPath,'utf8'),legacy)
  assert.match(runtime.snapshot().statusMessage?.text??'',/已变化/u)
  await press('m'); await press('y')
  await waitFor(()=>!runtime.snapshot().busy && runtime.snapshot().mcp.legacyToggles?.length===0,'confirmed migration')
  const migrated = await readFile(patchPath,'utf8')
  assert.equal(parsePatchText(migrated).toggles.length,0)
  assert.equal(parsePatchText(migrated).rows.find(row=>row.id==='existing').disabled,true)
  assert.equal(managedMcpEntries(migrated).find(row=>row.id===id).serverName,'crud-test')
  await runtime.undoMcpDelete()
  assert.equal(await readFile(patchPath,'utf8'),migrated,'an old deletion snapshot cannot undo subsequent migration')
  assert.equal(runtime.snapshot().mcp.lastAction?.outcome,'conflict')

  // Restore the deletion snapshot as a fixture so cold undo keeps testing its
  // original conflict contract; migration itself correctly invalidates old undo.
  await writeFile(patchPath, beforeHttpDelete)
  await waitFor(()=>entries.some(row=>row.options.id===http.id),'restored HTTP fixture composed')
  await runtime.refreshMcp()
  await runtime.deleteMcp(http.id)
  await waitFor(()=>applied('delete'),'delete again after migration fixture')
  instance.unmount()
  // Recreate the runtime to prove that undo survives a closed/reopened session.
  const cold = new ManagerRuntime(ctx)
  try {
    await cold.refresh('cold-undo')
    assert.equal(cold.snapshot().mcp.latestDeletion.serverName, 'crud-http')
    await cold.undoMcpDelete()
    assert.equal(cold.snapshot().mcp.lastAction.outcome, 'applied')
    assert.equal(await readFile(patchPath, 'utf8'), beforeHttpDelete)
  } finally { cold.dispose() }
  console.log(`mcp-crud-smoke OK (${columns} cols): stdio+HTTP forms / masked refs / unknown fields / reload / delete+undo / cold recovery / existing-row boundary / migration confirm+cancel`)
} catch (error) {
  console.error((await screen()).slice(-4000))
  throw error
} finally {
  clearInterval(watch)
  clearTimeout(pending)
  instance.unmount()
  runtime.dispose()
  await sleep(100)
  await rm(root, { recursive: true, force: true })
}
