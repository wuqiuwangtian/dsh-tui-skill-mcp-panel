/** Real scene/runtime on isolated files: combined skill filters and visible-only batch writes. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createManagerScene } from '../lib/types/ui/ManagerScene.js'
import { ManagerRuntime } from '../lib/types/host/manager-runtime.js'

const require = createRequire(import.meta.url), host = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const React = createRequire(host)('react'), ui = await import(pathToFileURL(join(dirname(host), 'lib/types/ui.js')).href)
const columns = Number(process.argv[2] ?? 120), root = await fs.mkdtemp(join(tmpdir(), 'skill-filter-ui-'))
const project = join(root, 'project'), home = join(root, 'home'), panel = join(root, 'panel'), skillRoot = join(project, '.dsh/skills')
const originalCwd = process.cwd()
const env = { DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_BUNDLED_SKILL_DIR: join(root, 'bundled'), DSH_PROFILE_DIR: join(root, 'profile'), SKILL_MCP_PANEL_HOME: panel, SKILL_MCP_PANEL_DUMP: join(root, 'dump.json'), SKILL_MCP_PANEL_RENDER_DUMP: join(root, 'render.txt') }
const beforeEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
for (const [key,value] of Object.entries(env)) process.env[key] = value
await fs.mkdir(join(project, '.git'), { recursive: true }); await fs.mkdir(skillRoot, { recursive: true }); await fs.mkdir(join(home, 'skills'), { recursive: true }); await fs.mkdir(panel)
const doc = name => `---\nname: ${name}\ndescription: Skill status fixture\n---\nBody.\n`
const on = join(skillRoot, 'status-on.md'), off = join(skillRoot, 'status-off.md.disabled'), two = join(skillRoot, 'status-two.md'), bad = join(skillRoot, 'status-bad.md'), global = join(home, 'skills/status-on.md')
await fs.writeFile(on, doc('status-on')); await fs.writeFile(off, doc('status-off')); await fs.writeFile(two, doc('status-two'))
const badBytes = '---\nname: status-bad\n---\nMissing description.\n'
await fs.writeFile(bad, badBytes); await fs.writeFile(global, doc('status-on'))
const configPath = join(panel, 'config.json')
await fs.writeFile(configPath, '{"version":1,"future":{"keep":true}}\n')
process.chdir(project)
class Output extends EventEmitter {
  isTTY = true; chunks = []
  constructor() { super(); this.columns = columns; this.rows = 28 }
  write(chunk) { this.chunks.push(String(chunk)); return true }
  getColorDepth() { return 8 }
  hasColors() { return true }
}
class Input extends Readable {
  isTTY = true
  constructor() { super({ read() {} }) }
  setRawMode() {}; ref() {}; unref() {}
}
const runtime = new ManagerRuntime({ get: () => undefined })
await runtime.ensureFresh()
let frame = '', checks = 0
runtime.writeRenderFrame = (_reason, text) => { frame = text }
const stdout = new Output(), stdin = new Input(), Component = createManagerScene(runtime, 'filter-fixture')
const app = ui.renderSync(React.createElement(Component, { React, ui, channel: {}, close() {} }), { stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
const check = (condition, label) => { assert.ok(condition, `${label}\n${frame.slice(0, 1500)}`); checks++ }
const press = async chars => { stdin.push(chars); await sleep(90) }
const wait = async (fn, label) => { const end = Date.now() + 4000; while (!await fn() && Date.now() < end) await sleep(25); check(await fn(), label) }
const visible = () => (frame.match(/list\(\d+\):\n([\s\S]*?)\nselected=/u)?.[1] ?? '').split('\n').filter(Boolean).map(line => line.split(' ')[1])
const exists = path => fs.stat(path).then(() => true, () => false)
const choose = async index => { await press('f'); await press('\x1b[H'); for (let i = 0; i < index; i++) await press('\x1b[B'); await press('\r') }
const search = async text => { await press('/'); stdin.push(text); await sleep(100); await press('\r') }
try {
  await sleep(180)
  check(visible().length === 5, 'default all states and both scopes')
  const preferenceBytes = await fs.readFile(configPath)
  const originalFiles = await Promise.all([on,off,two,bad,global].map(path => fs.readFile(path)))
  await press('v'); await press('f'); await press('\x1b')
  check(frame.includes('skillStatus=all') && frame.includes('marked=1'), 'cancel keeps status and batch mark')
  await choose(2)
  check(JSON.stringify(visible()) === JSON.stringify(['status-off']) && frame.includes('marked=0'), 'disabled filter clears old mark and shows exact match')
  await search('status-on')
  check(visible().length === 0 && frame.includes('skillStatus=disabled'), 'search and state intersect')
  await press('d'); await press(' ')
  check(frame.includes('modal=-'), 'empty state never opens destructive confirmation')
  await press('x')
  check(frame.includes('skillStatus=all') && frame.includes('query=""') && visible().length === 5, 'x clears status and search')
  const afterFiles = await Promise.all([on,off,two,bad,global].map(path => fs.readFile(path)))
  check(afterFiles.every((bytes,index) => bytes.equals(originalFiles[index])), 'filtering and empty actions preserve all skill bytes')

  check((await fs.readFile(configPath)).equals(preferenceBytes), 'filtering does not persist or rewrite preferences')
  const rows = runtime.snapshot().scan.instances
  await runtime.createGroup('Status group', rows.filter(row => row.scope === 'workspace' && ['status-on','status-off'].includes(row.name)))
  const groupPath = join(home, 'skills/.system/skill-viewer/groups.json'), groupBytes = await fs.readFile(groupPath)
  await press('3'); await press('\x1b[H'); await press('\r')
  check(JSON.stringify(visible()) === JSON.stringify(['status-off','status-on']), 'group excludes same-name global instance')
  await choose(2); await search('status-off')
  if (columns >= 90) {
    await press('\x1b[D'); await press('\x1b[H'); await press('\x1b[B'); await press('\x1b[B'); await press('\r')
  } else { await press('\x1b[D'); await press('\x1b[B'); await press('\x1b[C') }
  check(frame.includes('scope=workspace') && JSON.stringify(visible()) === JSON.stringify(['status-off']), 'scope, group, search and status combine')
  await press('x')
  check(frame.includes('scope=workspace') && frame.includes('skillStatus=all') && frame.includes('groupFilter=-') && visible().length === 4, 'x retains workspace and clears other filters')
  check((await fs.readFile(groupPath)).equals(groupBytes), 'filtering never writes group metadata')

  await choose(1); await press('\x1b[H'); await press('v'); await press('\x1b[B'); await press('v')
  check(frame.includes('marked=2'), 'two enabled visible rows marked')
  await choose(2); await press('d'); await press('y')
  await wait(async () => !await exists(off), 'delete acts on newly selected disabled row only')
  check(await exists(on) && await exists(two) && await exists(global), 'previous enabled marks and global twin survive delete')
  await press('u'); await wait(() => exists(off), 'undo restores disabled row under active filter')

  await press('x'); await choose(1); await press('\x1b[H'); await press('v'); await press('\x1b[B'); await press('v')
  await fs.rename(on, `${on}.disabled`); await runtime.refresh('external-filter-status'); await sleep(120)
  check(JSON.stringify(visible()) === JSON.stringify(['status-two']) && frame.includes('marked=2'), 'external change hides old marked row without selecting it for action')
  await press(' '); await wait(() => exists(`${two}.disabled`), 'batch toggle acts only on still-visible marked row')
  check(await exists(`${on}.disabled`) && await exists(off) && await exists(global), 'hidden/external/global instances remain untouched')
  check(visible().length === 0, 'enabled filter updates after toggle')
  const trashBefore = await fs.readdir(join(panel, 'trash'))
  await press('d'); await press(' ')
  check(JSON.stringify(await fs.readdir(join(panel, 'trash'))) === JSON.stringify(trashBefore), 'empty filtered writes create no batch')
  await choose(3)
  check(JSON.stringify(visible()) === JSON.stringify(['status-bad']), 'invalid state is selectable')
  await press(' ')
  check(await fs.readFile(bad, 'utf8') === badBytes && !await exists(`${bad}.disabled`), 'invalid enable remains safely refused')
  await press('2')
  check(frame.includes('mcpView') && frame.includes('status=all'), 'MCP filters remain independent')
  await press('1')
  check(frame.includes('skillStatus=invalid'), 'skill state survives tab changes')
  await press('x'); await sleep(100)
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  check(config.future.keep && !Object.hasOwn(config, 'skillStatus'), 'filter state is not persisted and unknown preferences survive')
} finally {
  app.unmount(); runtime.dispose(); process.chdir(originalCwd)
  for (const [key,value] of Object.entries(beforeEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await fs.rm(root, { recursive: true, force: true })
}
console.log(`skill-filter-smoke OK (${columns} cols): ${checks} assertions; status/search/scope/group, visible-only writes, invalid and empty safety`)
