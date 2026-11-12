/** Feed real SGR pointer reports through the host renderer; no direct handler calls. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
import { createManagerScene } from '../lib/types/ui/ManagerScene.js'
import { cellWidth } from '../lib/types/shared/format.js'

const require = createRequire(import.meta.url)
const host = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const React = createRequire(host)('react')
const ui = await import(pathToFileURL(join(dirname(host), 'lib/types/ui.js')).href)
const { Terminal } = require('@xterm/headless')
const { Unicode11Addon } = require('@xterm/addon-unicode11')
const body = Array.from({ length: 100 }, (_, i) => `MOUSE-BODY-${String(i).padStart(3, '0')} 中文🧭`).join('\n')
const profile = '/fixture/cordis.patch.yml'
class Runtime {
  listeners = new Set()
  calls = []
  state = {
    status: 'ready', busy: false, services: [], groupsWritable: true,
    paths: { homePatch: '/fixture/home/cordis.patch.yml', panelHome: '/fixture/panel', skillGroupsFile: '/fixture/groups.json' },
    detail: { status: 'idle' }, config: { version: 1, mcpGroups: {} },
    groups: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`g${i}`, { name: `Mouse group ${String(i).padStart(3, '0')}`, scopes: { global: [] } }])),
    scan: { scannedAt: 'mouse-fixture', cwd: '/fixture/project', projectRoot: '/fixture/project', dshHome: '/fixture/home', agentsHome: '/fixture/agents', roots: [], warnings: [],
      instances: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `mouse-${String(i).padStart(3, '0')}`, description: 'Mouse fixture',
        scope: 'workspace', source: 'project-dsh', rank: 100, providerOrder: i, form: 'directory', status: 'enabled', effective: true,
        locatorDir: `/fixture/project/.dsh/skills/mouse-${i}`, rootPath: '/fixture/project/.dsh/skills', path: `/fixture/project/.dsh/skills/mouse-${i}/SKILL.md`, skillFile: '/fixture/SKILL.md' })) },
    mcp: { profilePatchPath: profile, warnings: [], errors: [], rows: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, entryId: `m${i}`, serverName: `mc-${String(i).padStart(3, '0')}`,
      layer: 'profile', transport: 'stdio', enabled: false, targetable: true, managed: i === 0, notes: [],
      config: { serverName: `mc-${String(i).padStart(3, '0')}`, transport: 'stdio', command: 'node', args: [],
        env: Object.fromEntries(Array.from({ length: 80 }, (_, j) => [`MOUSE_ENV_${String(j).padStart(3, '0')}`, 'never-show-this-value'])) } })) },
  }
  snapshot() { return this.state }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  notify() { for (const fn of this.listeners) fn() }
  async ensureFresh() {}
  async loadDetail(row) { this.state.detail = { id: row.id, status: 'ready', content: body }; this.notify() }
  writeRenderFrame() {}
  groupIdsFor() { return [] }
  setStatus(text) { this.state.statusMessage = { text, at: Date.now() }; this.notify() }
  async refresh() { this.calls.push('refresh') }
  async refreshMcp() { this.calls.push('refresh-mcp') }
  async toggleSkills(rows) {
    this.calls.push(`toggle:${rows[0].id}`)
    // The real scan ID changes with SKILL.md -> SKILL.md.disabled.
    this.state.scan.instances = this.state.scan.instances.map(row => rows.includes(row)
      ? { ...row, id: row.id + '.disabled', path: row.path + '.disabled', status: 'disabled', effective: false } : row)
    this.notify()
  }
  async deleteSkillInstances(rows) { this.calls.push(`delete:${rows[0].id}`) }
  async undoLastDelete() { this.calls.push('undo') }
  async setGroupMembershipForInstances(id) { this.calls.push(`membership:${id}`) }
  async createGroup(name) { this.calls.push(`create-group:${name}`) }
  async openMcpForm(id) { return { id, config: { serverName: 'new-server', transport: 'stdio', command: 'node', args: [] }, patchPath: profile } }
}
class Output extends EventEmitter {
  isTTY = true; chunks = []
  constructor(columns, rows) { super(); this.columns = columns; this.rows = rows }
  write(value) { this.chunks.push(String(value)); return true }
  getColorDepth() { return 8 }
  hasColors() { return true }
}
class Input extends Readable {
  isTTY = true
  constructor() { super({ read() {} }) }
  setRawMode() {}; ref() {}; unref() {}
}
let checks = 0
const results = []
for (const [columns, rows] of [[40, 16], [58, 22], [116, 33]]) {
  const runtime = new Runtime(), stdout = new Output(columns, rows), stdin = new Input()
  const term = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 })
  term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'
  const Component = createManagerScene(runtime, 'mouse-fixture')
  const app = ui.renderSync(React.createElement(ui.AlternateScreen, { mouseTracking: true }, React.createElement(Component, { React, ui, channel: {}, close() {} })),
    { stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
  let consumed = 0
  const screen = async () => {
    await sleep(55)
    const raw = stdout.chunks.slice(consumed).join(''); consumed = stdout.chunks.length
    await new Promise(done => term.write(raw, done))
    const lines = Array.from({ length: rows }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')
    assert.ok(!lines.join('\n').includes('never-show-this-value'), 'pointer path must stay masked')
    return lines
  }
  const press = async chars => { stdin.push(chars); await sleep(85) }
  const anchor = async (text, fromRow = 0) => {
    const lines = await screen(), y = lines.findIndex((line, row) => row >= fromRow && line.includes(text))
    assert.ok(y >= 0, `${columns}x${rows}: missing pointer target ${text}\n${lines.join('\n')}`)
    return { x: cellWidth(lines[y].slice(0, lines[y].indexOf(text))) + 1, y: y + 1 }
  }
  const click = async (text, fromRow = 0) => { const { x, y } = await anchor(text, fromRow); await press(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`) }
  const wheel = async (text, down = true) => { const { x, y } = await anchor(text); await press(`\x1b[<${down ? 65 : 64};${x};${y}M`) }
  const passed = label => { checks++; results.push({ viewport: `${columns}x${rows}`, label, pass: true }) }
  const check = async (label, condition) => { const lines = await screen(); assert.ok(condition(lines.join('\n')), `${columns}x${rows}: ${label}\n${lines.join('\n')}`); passed(label) }
  try {
    await click('mouse-001')
    await check('row click selects the skill and opens narrow detail', s => s.includes('详情') && (columns >= 72 || !s.includes('技能列表')))
    if (columns < 72) {
      await check('narrow detail has mouse return', s => s.includes('←返回'))
      await click('←返回')
      await check('return restores list', s => s.includes('技能列表'))
    }
    await wheel('技能列表')
    await check('list wheel advances selection', s => /❯.*mouse-002/u.test(s))
    await click('mouse-002')
    await wheel('详情')
    await check('detail wheel scrolls text', s => s.includes('↕2/'))
    if (columns < 72) await click('←返回')
    await click(columns < 110 ? '␣启停' : '空格 启停')
    assert.deepEqual(runtime.calls, ['toggle:s2']); passed('toggle targets selected skill')
    await check('toggle preserves the selected logical skill after scan ID changes', s => /❯.*mouse-002/u.test(s))
    await click(columns < 110 ? 'd删除' : 'd 删除')
    const beforeWheel = (await screen()).join('\n'), range = beforeWheel.match(/(\d+)(?:-(\d+))?\/(\d+)/u)
    const canScroll = Number(range?.[3]) > rows - 9
    await wheel('删除技能')
    await check('confirmation wheel respects bounds without deleting', s => s.includes('将移入回收站') === !canScroll && !runtime.calls.some(c => c.startsWith('delete:')))
    await click('[末]')
    await check('confirmation last page shows file path', s => s.replace(/[│\s]/gu, '').includes('/fixture/SKILL.md'))
    await click('n / Esc 取消')
    assert.ok(!runtime.calls.some(c => c.startsWith('delete:'))); passed('delete cancellation makes no delete call')
    await click(columns < 110 ? 'd删除' : 'd 删除')
    await click('y 确认')
    assert.ok(runtime.calls.includes('delete:s2.disabled')); passed('delete confirmation targets selected skill')
    await click(columns < 110 ? 'u撤销' : 'u 撤销')
    assert.ok(runtime.calls.includes('undo')); passed('undo button invokes undo')
    await click(columns < 110 ? 'g分组' : 'g 分组')
    await wheel('Mouse group 000')
    await check('picker wheel moves active item', s => /❯.*Mouse group 001/u.test(s))
    await click('Mouse group 002')
    assert.ok(runtime.calls.includes('membership:g2')); passed('picker row applies chosen group')
    await click('[?')
    await wheel('快捷键')
    await check('help wheel advances page', s => !s.includes('快捷键 Keys') && s.includes('关闭帮助'))
    await click('[末]')
    await check('help last page', s => s.includes('迁移/复制'))
    await click('关闭帮助')
    await click('MCP', 1)
    await wheel('筛选:')
    await check('MCP wheel advances row', s => /❯.*mc-001/u.test(s))
    await click(columns < 110 ? 'i详情' : 'i 详情')
    await wheel('MCP 详情')
    await click('[末]')
    await check('info last page is readable and masked', s => s.replace(/[│\s]/gu, '').includes('MOUSE_ENV_079') && s.includes('值已隐藏'))
    await click('Enter/Esc 关闭')
    await click(columns < 110 ? 'a新增' : 'a 新增')
    await click('serverName')
    await press('\x15'); await press('mouse-input')
    await click('Enter 提交')
    await check('input submit returns to field list', s => s.includes('mouse-input') && !s.includes('[Enter 提交]'))
    await click('command')
    await press('DO-NOT-SAVE')
    await click('Esc 取消')
    await check('input cancellation keeps original field', s => !s.includes('DO-NOT-SAVE'))
    await click('Esc 取消')
    await check('field-list cancellation closes the form', s => !s.includes('新增 MCP') && s.includes('筛选:'))
    await click(columns < 72 ? '分组' : 'Groups 分组')
    await wheel('Mouse group 000')
    await check('group wheel advances selected row', s => /❯.*Mouse group 001/u.test(s))
    await click(columns < 110 ? 'a新建' : 'a 新建')
    await press('mouse-created'); await click('Enter 提交')
    assert.ok(runtime.calls.includes('create-group:mouse-created')); passed('input submit invokes group creation')
  } finally { app.unmount(); term.dispose() }
}
if (process.env.MOUSE_SMOKE_REPORT) await writeFile(process.env.MOUSE_SMOKE_REPORT, JSON.stringify(results, null, 2) + '\n')
console.log(`ui-mouse-smoke OK: ${checks} assertions across 3 sizes (SGR click/release + wheel)`)
