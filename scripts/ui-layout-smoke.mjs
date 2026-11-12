/** Adversarial viewport/interaction checks using the installed host React/UI, no user files. */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { createManagerScene } from '../lib/types/ui/ManagerScene.js'
const require = createRequire(import.meta.url)
const host = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const React = createRequire(host)('react')
const ui = await import(pathToFileURL(join(dirname(host), 'lib/types/ui.js')).href)
const { Terminal } = require('@xterm/headless')
const { Unicode11Addon } = require('@xterm/addon-unicode11')
const failures = []
const results = []
const dump = process.env.LAYOUT_SMOKE_DUMP
if (dump) await mkdir(dump, { recursive: true })
const word = '长字段中文🧭'.repeat(12)
const body = Array.from({ length: 80 }, (_, i) => `BODY-${String(i).padStart(3, '0')} ${i === 79 ? 'BODY-END' : word}`).join('\n')
const profile = '/fixture/profile/cordis.patch.yml'
const secret = 'layout-private-token-do-not-show'

class Runtime {
  listeners = new Set()
  calls = []
  constructor() {
    const instances = Array.from({ length: 60 }, (_, i) => ({ id: `s-${i}`, name: `skill-${String(i === 1 ? 0 : i).padStart(3, '0')}`, description: word,
      source: i === 59 ? 'bundled' : i === 1 ? 'user-dsh' : 'project-dsh', rank: 100, providerOrder: i, scope: i === 59 || i === 1 ? 'global' : 'workspace', form: i === 2 ? 'file' : 'directory', status: i === 2 ? 'disabled' : 'enabled', effective: true,
      locatorDir: `/fixture/${i === 1 ? 'global' : 'project'}/${word}/entity-${i}`,
      path: `/fixture/${i === 1 ? 'global' : 'project'}/${word}/entity-${i}/SKILL.md`, rootPath: '/fixture/project/.dsh/skills',
      skillFile: i === 2 ? `/fixture/project/${word}/flat.md.disabled` : `/fixture/${i === 1 ? 'global' : 'project'}/${word}/entity-${i}/SKILL.md`, bodyPreview: body }))
    this.state = { status: 'ready', refreshing: false, busy: false, refreshReason: 'layout-fixture', services: [], groupsWritable: false,
      paths: { homePatch: '/fixture/dsh/cordis.patch.yml', panelHome: '/fixture/panel', skillGroupsFile: '/fixture/groups.json' },
      detail: { status: 'idle' }, groups: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`g-${i}`, { name: `group-${String(i).padStart(3, '0')} ${word}`, scopes: { global: [] } }])),
      config: { version: 1, trashRetentionDays: 7, mcpGroups: {} },
      scan: { scannedAt: '2026-11-09', cwd: '/fixture/project', projectRoot: '/fixture/project', dshHome: '/fixture/dsh', agentsHome: '/fixture/agents', roots: [], instances,
        warnings: Array.from({ length: 30 }, (_, i) => `warning-${i} ${word}`) },
      mcp: { profilePatchPath: profile, rows: Array.from({ length: 60 }, (_, i) => ({ id: `m-${i}`, entryId: `m-${i}`, serverName: `server-${String(i).padStart(3, '0')}`,
        transport: 'stdio', layer: i === 59 ? 'home' : 'profile', enabled: true, targetable: i !== 59, managed: i === 0,
        notes: Array.from({ length: 12 }, (_, j) => `note-${j} ${word}`),
        editReadOnlyReason: '只读行 · 请在所属配置中检查',
        config: { serverName: `server-${String(i).padStart(3, '0')}`, transport: 'stdio', command: `node-${word}`, args: ['--flag'], env: { TOKEN: secret }, headers: { Authorization: secret },
          cwd: 'MCP-DETAIL-END', future: 'unknown-not-shown' },
      })), errors: [`file error ${word}`, `second error ${word}`], warnings: [word] },
    }
  }
  snapshot() { return this.state }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  notify() { for (const fn of this.listeners) fn() }
  async ensureFresh() {}
  async loadDetail(row) { this.state.detail = { id: row.id, status: 'ready', content: body }; this.notify() }
  groupIdsFor() { return [] }
  writeRenderFrame() {}
  setStatus(text, tone = 'info') { this.state.statusMessage = { text, tone, at: Date.now() }; this.notify() }
  async openMcpForm(id) { if (id !== undefined && !this.state.mcp.rows.find((row) => row.id === id)?.managed) { this.setStatus('只读行，仅可查看详情', 'warning'); return undefined } return { id, serverName: 'server-000', config: { ...this.state.mcp.rows[0].config }, patchPath: profile } }
  async refresh() {}
  async refreshMcp() {}
  async dumpNow() {}
  async toggleSkills() { this.calls.push('toggle') }
  async deleteSkillInstances() { this.calls.push('delete') }
  async undoLastDelete() {}
  async undoMcpDelete() {}
  async toggleMcp() { this.calls.push('toggle-mcp') }
  async deleteMcp() { this.calls.push('delete-mcp') }
}
class Output extends EventEmitter {
  isTTY = true
  chunks = []
  constructor(columns, rows) { super(); this.columns = columns; this.rows = rows }
  write(value) { this.chunks.push(String(value)); return true }
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
const sizes = process.argv[2] ? [process.argv[2].split('x').map(Number)] : [[40, 16], [58, 20], [64, 24], [72, 24], [92, 24], [93, 24], [110, 30], [160, 40]]
for (const [columns, rows] of sizes) {
  const runtime = new Runtime()
  const stdout = new Output(columns, rows)
  const stdin = new Input()
  const term = new Terminal({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  let consumed = 0
  const Component = createManagerScene(runtime, 'layout-fixture')
  const app = ui.renderSync(React.createElement(Component, { React, ui, channel: {}, close() {} }), { stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
  const press = async (chars) => { stdin.push(chars); await sleep(65) }
  const screen = async () => {
    await sleep(35)
    const output = stdout.chunks.slice(consumed).join(''); consumed = stdout.chunks.length
    await new Promise((done) => term.write(output, done))
    return Array.from({ length: stdout.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n')
  }
  const check = async (label, condition, header = true) => {
    const text = await screen()
    const pass = condition(text) && (!header || text.includes('Skill / MCP manager'))
    results.push({ viewport: `${stdout.columns}x${stdout.rows}`, label, pass })
    if (!pass) failures.push(`${columns}x${rows} ${label}`)
    if (dump) await writeFile(join(dump, `${columns}x${rows}-${label.replace(/[^a-z0-9-]/gi, '-')}.txt`), text)
    if (text.includes(secret)) failures.push(`${columns}x${rows} secret leaked in ${label}`)
  }
  try {
    await sleep(120)
    await check('skills-header-footer', (s) => s.includes('启停') && (s.includes('g分组') || s.includes('g 分组')))
    await press('\x1b[F'); await check('last-skill-reachable', (s) => s.includes('skill-059'))
    await press('\r'); await press('\x1b[F')
    await check('skill-detail-end', (s) => s.includes('BODY-END'))
    const loadedDetail = runtime.state.detail
    runtime.state.detail = { ...loadedDetail, status: 'error', error: `READ-ERROR ${word}` }; runtime.notify()
    await check('detail-error-clamps-offset', (s) => s.includes('读取失败') && s.includes('READ-ERROR'))
    runtime.state.detail = { ...loadedDetail, content: Array.from({ length: 450 }, (_, i) => `large-line-${i}`).join('\n') }; runtime.notify()
    await sleep(80)
    await press('\x1b[F')
    await check('large-body-preview-disclosed', (s) => s.includes('仅预览前400行'))
    runtime.state.detail = loadedDetail; runtime.notify()
    await press('\x1b')
    await press('?'); await press('\x1b[F')
    await check('help-last-page-footer', (s) => s.includes('迁移/复制') && s.includes('关闭帮助'))
    await press('\x1b')
    await press('3'); await press('\x1b[F')
    await check('last-group-reachable', (s) => s.includes('group-059'))
    await press('\x1b[H'); await press('\x1b[A'); await press('a')
    await check('group-actions-from-tabs', (s) => s.includes('分组名称'))
    await press('\x1b')
    await press('g') // no-op in groups
    await press('1'); await press('g'); await press('\x1b[F')
    await check('group-picker-footer', (s) => s.includes('新建分组') && s.includes('Esc'))
    await press('\x1b')
    await press('1'); await press('\x1b[H')
    for (let i = 0; i < 10; i++) { await press('v'); await press('\x1b[B') }
    await press('d')
    await check('batch-confirm-buttons', (s) => s.includes('[y 确认]') && s.includes('取消') && s.includes('删除技能'))
    // Read every body row through real paging; retain offsets to avoid duplicate
    // overlap on the last page. Joining wrapped rows must recover the full paths.
    const confirmationRows = new Map()
    let previousFirst = 0
    for (let page = 0; page < 1000; page++) {
      const text = await screen(), lines = text.split('\n')
      const titleAt = lines.findIndex(line => line.includes('删除技能'))
      const pagerAt = lines.findIndex(line => line.includes('[首]'))
      const range = lines[pagerAt]?.match(/(\d+)(?:-(\d+))?\/(\d+)/u)
      if (titleAt < 0 || !range) throw new Error(`missing confirmation pager at ${columns}x${rows}`)
      const first = Number(range[1]), total = Number(range[3])
      if (first === previousFirst) break // PgDn clamps when the final page is reached.
      previousFirst = first
      lines.slice(titleAt + 1, pagerAt).forEach((line, index) => confirmationRows.set(first + index, line.replace(/[│\s]/gu, '')))
      if (Number(range[2]) === total) break
      await press('\x1b[6~')
    }
    const allConfirmation = [...confirmationRows].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join('')
    const expectedTargets = runtime.state.scan.instances.slice(0, 10)
    const identity = allConfirmation.includes('作用域：全局') && allConfirmation.includes('作用域：工作区') && allConfirmation.includes('来源：user/~/.dsh')
    await check('batch-confirm-all-identities-and-full-paths', () => identity && expectedTargets.every(row =>
      allConfirmation.includes(row.name) && allConfirmation.includes(row.skillFile) && (row.form === 'file' || allConfirmation.includes(row.locatorDir))))
    await check('batch-confirm-flat-disabled-entity', () => allConfirmation.includes('删除文件：') && allConfirmation.includes('flat.md.disabled'))
    await press('\x1b[H')
    await check('batch-confirm-home', s => s.includes('将移入回收站') && s.includes('共 10 个'))
    await press('\x1b[F')
    await check('batch-confirm-end', s => s.replace(/[│\s]/gu, '').includes('entity-9/SKILL.md'))
    await press('\x1b')
    await check('batch-confirm-cancel-no-delete', () => !runtime.calls.includes('delete'))
    await press('d')
    await check('batch-confirm-reopen-starts-at-top', s => s.includes('将移入回收站'))
    await press('\x1b'); await press('x')
    await press('2'); await press('\x1b[H'); await press('i'); await press('\x1b[F')
    await check('mcp-detail-end', (s) => s.includes('MCP-DETAIL-END'))
    await press('\x1b'); await press('2'); await press('/'); await press('no-such-server'); await press('\r')
    await check('filtered-empty-mcp', (s) => s.includes('没有匹配的 MCP') && (s.includes('x清除') || s.includes('x 清除')))
    await press('x'); await press('\x1b[H'); await press('\r'); await press('\x1b[B'); await press('\x1b[B'); await press('\r')
    await press('\x1b[200~TAIL-INPUT-END\x1b[201~')
    await check('long-input-tail', (s) => s.includes('TAIL-INPUT-END') && s.includes('提交'))
    await press('\x15'); await press('UTF-🧭'); await press('\x7f'); await press('B')
    await check('unicode-backspace', (s) => s.includes('UTF-B') && !s.includes('\ufffd'))
    stdout.columns = 20; stdout.rows = 8; term.resize(20, 8); stdout.emit('resize'); await sleep(150)
    const beforeCalls = runtime.calls.length
    await press('x'); await press('d'); await press(' ')
    await check('too-small-safeguard', (s) => s.includes('40×16') && runtime.calls.length === beforeCalls, false)
    stdout.columns = columns; stdout.rows = rows; term.resize(columns, rows); stdout.emit('resize'); await sleep(150)
    await check('resize-preserves-draft', (s) => s.includes('UTF-B') && !s.includes('UTF-Bx'))
    await press('\x1b'); await press('\x1b[B'); await press('\r'); await press('\x15'); await press('not-json'); await press('\r')
    await check('invalid-args-keeps-input', (s) => s.includes('MCP args') && s.includes('提交') && runtime.calls.length === 0)
    await press('\x1b'); await press('\x1b')
    await press('2'); await press('\x1b[F'); await press('\r'); await press('d')
    await check('readonly-no-confirm', (s) => s.includes('只读') && !s.includes('[y 确认]') && !s.includes('编辑 MCP'))
    await press('4')
    for (let i = 0; i < 12; i++) await press('\x1b[6~')
    await check('diagnostics-clamped-end', (s) => s.includes('说明 Notes') || s.includes('只覆盖文件来源'))
    runtime.state.scan.instances = []; runtime.state.groups = {}; runtime.state.mcp.rows = []
    runtime.state.status = 'error'; runtime.state.error = 'SCAN-ERROR-END'; runtime.state.statusMessage = undefined
    runtime.notify(); await press('1')
    await check('error-empty-skills', (s) => s.includes('SCAN-ERROR-END') && s.includes('没有任何技能'))
    await press('2')
    await check('error-empty-mcp', (s) => s.includes('没有 MCP 行') && s.includes('SCAN-ERROR-END') && (s.includes('home只读') || s.includes('home 全局')))
    await press('3')
    await check('error-empty-groups', (s) => s.includes('还没有') && s.includes('SCAN-ERROR-END'))
  } finally { app.unmount(); term.dispose() }
}
if (dump) await writeFile(join(dump, 'results.json'), JSON.stringify(results, null, 2) + '\n')
if (failures.length) { console.error(`ui-layout-smoke FAILED (${failures.length}/${results.length})\n${failures.join('\n')}`); process.exitCode = 1 }
else console.log(`ui-layout-smoke OK: ${results.length} viewport/interaction assertions across ${sizes.length} sizes`)
