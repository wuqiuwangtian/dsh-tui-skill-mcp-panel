/**
 * Headless interaction smoke test (dev-only): render the real manager scene
 * against a REAL ManagerRuntime on a temporary skill tree, then drive it with
 * stdin chunks and assert the filesystem + screens. Covers M2 write paths
 * (toggle / delete+undo / add / groups) without a real TTY.
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repo = process.cwd()
const require = createRequire(import.meta.url)
const { Terminal: XtermTerminal } = require('@xterm/headless')
const dshTuiManifest = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const dshTuiDir = dirname(dshTuiManifest)
const requireFromHost = createRequire(dshTuiManifest)
const React = requireFromHost('react')
const ui = await import(pathToFileURL(join(dshTuiDir, 'lib', 'types', 'ui.js')).href)
const { createManagerScene } = await import(pathToFileURL(join(repo, 'lib', 'types', 'ui', 'ManagerScene.js')).href)
const { ManagerRuntime } = await import(pathToFileURL(join(repo, 'lib', 'types', 'host', 'manager-runtime.js')).href)
const { scanSkills } = await import(pathToFileURL(join(repo, 'lib/types/domain/skills/index.js')).href)
const { deleteSkills } = await import(pathToFileURL(join(repo, 'lib/types/domain/skills/write.js')).href)

const SKILL = (name) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n\nBody.\n`

const root = await mkdtemp(join(tmpdir(), 'skill-mcp-ui-'))
const project = join(root, 'project')
const home = join(root, 'home')
const panel = join(root, 'panel')
const source = join(root, 'source')
await mkdir(join(project, '.git'), { recursive: true })
await mkdir(join(project, '.dsh', 'skills', 'alpha'), { recursive: true })
await writeFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL('alpha'))
await writeFile(join(project, '.dsh', 'skills', 'beta.md'), SKILL('beta'))
await mkdir(source, { recursive: true })
await writeFile(join(source, 'gamma.md'), SKILL('gamma'))

process.env.DSH_HOME = home
process.env.SKILL_MCP_PANEL_HOME = panel
process.chdir(project)

const retentionSource = join(project, '.dsh/skills/retention-old.md')
await writeFile(retentionSource, SKILL('retention-old'))
const retentionRow = (await scanSkills({ cwd: project, dshHome: home, agentsHome: join(root, 'agents'), bundledDir: join(root, 'bundled') })).instances.find(row => row.name === 'retention-old')
const oldTrash = await deleteSkills([retentionRow], { panelHome: panel, now: () => new Date(Date.now() - 8 * 86400000) })

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
  getColorDepth() { return 8 }
  hasColors() { return true }
}

class FakeStdin extends Readable {
  constructor() {
    super({ read() {} })
    this.isTTY = true
  }
  setRawMode() {}
  ref() {}
  unref() {}
}

const stdout = new FakeStdout(160, 40)
const stdin = new FakeStdin()
stdin.setEncoding('utf8')
const otherProject = join(root, 'other-project'), otherChild = join(otherProject, 'sub')
await mkdir(join(otherProject, '.git'), { recursive: true }); await mkdir(otherChild)
await mkdir(join(otherProject, '.dsh/skills'), { recursive: true })
await writeFile(join(otherProject, '.dsh/skills/other-only.md'), SKILL('other-only'))
const runtimeContext = { get: name => name === 'tuiWorkspaces' ? { listRegistry: async () => [{ path: otherChild, title: 'Other project' }] } : undefined }
const runtime = new ManagerRuntime(runtimeContext)
await runtime.refresh('interaction-test')
await runtime.ensureFresh()

const Component = createManagerScene(runtime, 'skill-mcp-panel')
const instance = ui.renderSync(React.createElement(Component, { React, ui, channel: {}, close() {} }), {
  stdout,
  stdin,
  stderr: stdout,
  patchConsole: false,
  exitOnCtrlC: false,
  terminalImages: false,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}
const screenText = async () => {
  const raw = stdout.chunks.join('')
  const term = new XtermTerminal({ cols: 160, rows: 40, allowProposedApi: true, scrollback: 0 })
  await new Promise((resolve) => term.write(raw, resolve))
  const buffer = term.buffer.active
  const lines = []
  for (let y = 0; y < 40; y += 1) lines.push((buffer.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/u, ''))
  term.dispose()
  return lines.join('\n')
}
const press = async (key) => {
  stdin.push(key)
  await sleep(140)
}
const pressText = async (text) => {
  for (const char of text) await press(char)
  await sleep(100)
}

try {
  await sleep(200)
  let screen = await screenText()
  check('initial renders list', screen.includes('技能列表') && screen.includes('alpha'), screen.slice(0, 400))
  check('startup removes only expired fixture', !existsSync(join(panel, 'trash', oldTrash.batchId)) && runtime.snapshot().lastTrashCleanup.removed.includes(oldTrash.batchId))
  const auditPath = join(panel, 'trash-cleanup.json'), auditBytes = await readFile(auditPath)
  await press('4'); await press('c'); await press('\x1b[F')
  screen = await screenText()
  check('diagnostics cleanup history contains pre-plan and result', screen.includes('清理前快照') && screen.includes(oldTrash.batchId) && screen.includes('已清理'))
  check('viewing cleanup records is read only', (await readFile(auditPath)).equals(auditBytes))
  await press('\r'); await press('1')

  await press(' ')
  await sleep(200)
  check('space disables alpha', existsSync(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md.disabled')))
  screen = await screenText()
  check('screen shows 停用', screen.includes('停用'), screen.slice(0, 400))

  await press(' ')
  await sleep(200)
  check('space re-enables alpha', existsSync(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md')))

  // mark (v) + batch toggle
  await press('v')
  await press(' ')
  await sleep(200)
  check('batch toggle via v+space', existsSync(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md.disabled')))
  await press(' ')
  await sleep(200)

  // delete + undo
  await press('d')
  screen = await screenText()
  check('delete opens confirm modal', screen.includes('删除技能') && screen.includes('[y 确认]'), screen.slice(0, 300))
  check('confirm identifies directory and scope', screen.includes('作用域：工作区') && screen.includes(`删除目录：${join(project, '.dsh', 'skills', 'alpha')}`))
  await press('\x1b')
  check('cancel leaves skill bytes unchanged', await readFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), 'utf8') === SKILL('alpha'))
  check('cancel creates no trash batch', (await readdir(join(panel, 'trash'))).length === 0)
  await press('d')
  await press('y')
  await sleep(300)
  check('delete removes alpha dir', !existsSync(join(project, '.dsh', 'skills', 'alpha')))
  const trashEntries = existsSync(panel) ? (await import('node:fs/promises')).readdir(join(panel, 'trash')) : []
  check('trash batch created', (await trashEntries).length > 0)
  await press('u')
  await sleep(400)
  check('undo restores alpha', existsSync(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md')))

  // Conflict recovery uses the real scene/runtime and temporary filesystem.
  const alphaDir = join(project, '.dsh', 'skills', 'alpha')
  const conflict = async () => {
    await press('1'); await press('\x1b[H'); await press('d'); await press('y'); await sleep(180)
    await mkdir(alphaDir, { recursive: true }); await writeFile(join(alphaDir, 'SKILL.md'), SKILL('replacement'))
    await press('u'); await sleep(150)
  }
  await conflict()
  screen = await screenText()
  check('conflict defaults to cancel', screen.includes('恢复冲突') && /❯\s*取消/u.test(screen))
  const conflictManifest = join(panel, 'trash', runtime.snapshot().latestTrash.batchId, 'manifest.json')
  const conflictBytes = await readFile(conflictManifest)
  await press('\r')
  check('cancel preserves occupant and trash journal', await readFile(join(alphaDir, 'SKILL.md'), 'utf8') === SKILL('replacement') && (await readFile(conflictManifest)).equals(conflictBytes))
  check('cancel does not create skill backups', !existsSync(join(panel, 'backups', 'skills')))
  await press('u'); await press('\x1b[B'); await press('\r'); await sleep(150)
  check('replace preview shows paths and backup plan', (await screenText()).includes('确认恢复技能') && (await screenText()).includes('覆盖前备份：'))
  await press('n')
  check('declining preview returns to choices without backup', (await screenText()).includes('恢复冲突') && !existsSync(join(panel, 'backups', 'skills')))
  await press('\x1b')
  await press('u'); await press('\x1b[B'); await press('\r'); await sleep(150)
  await writeFile(join(alphaDir, 'SKILL.md'), SKILL('outside-new'))
  await press('y'); await sleep(200)
  check('stale recovery preview fails visibly without replacing data', (await screenText()).includes('恢复未完成') && (await screenText()).includes('已变化') && await readFile(join(alphaDir, 'SKILL.md'), 'utf8') === SKILL('outside-new'))
  await press('\r')
  await press('u'); await press('\x1b[B'); await press('\r'); await sleep(150); await press('y'); await sleep(250)
  check('confirmed replace restores original skill', await readFile(join(alphaDir, 'SKILL.md'), 'utf8') === SKILL('alpha'))
  const backupDirs = await readdir(join(panel, 'backups', 'skills'))
  check('replace saves exact external occupant backup', backupDirs.length === 1 && await readFile(join(panel, 'backups', 'skills', backupDirs[0], 'entity', 'SKILL.md'), 'utf8') === SKILL('outside-new'))
  check('result shows backup location', (await screenText()).includes('恢复结果') && (await screenText()).includes('覆盖前备份：'))
  await press('\r')
  await conflict()
  await press('\x1b[B'); await press('\x1b[B'); await press('\r'); await sleep(150)
  check('alternate-scope preview names global destination', (await screenText()).includes(join(home, 'skills', 'alpha')))
  await press('y'); await sleep(250)
  check('alternate scope restores without overwriting occupant', await readFile(join(home, 'skills', 'alpha', 'SKILL.md'), 'utf8') === SKILL('alpha') && await readFile(join(alphaDir, 'SKILL.md'), 'utf8') === SKILL('replacement'))
  await press('\r')
  // Reset only these fixture skills so later existing group scenarios stay unchanged.
  await rm(alphaDir, { recursive: true }); await rename(join(home, 'skills', 'alpha'), alphaDir)
  await runtime.refresh('after-recovery-scenarios')

  // add via a -> path -> scope
  await press('a')
  screen = await screenText()
  check('add modal asks path', screen.includes('本地绝对路径'), screen.slice(0, 300))
  await pressText(join(source, 'gamma.md'))
  await press('\r')
  await sleep(200)
  screen = await screenText()
  check('add modal asks scope', screen.includes('添加到哪个作用域'), screen.slice(0, 300))
  await press('\r')
  await sleep(500)
  check('add copied gamma file', existsSync(join(project, '.dsh', 'skills', 'gamma.md')))
  screen = await screenText()
  check('screen shows gamma', screen.includes('gamma'), screen.slice(0, 400))

  // group: g -> new -> name
  await press('g')
  await sleep(200)
  screen = await screenText()
  check('group modal opens', screen.includes('新建分组') || screen.includes('分组（'), screen.slice(0, 300))
  await press('\r') // choose the first option (＋ 新建分组… when no groups exist)
  await sleep(200)
  screen = await screenText()
  check('group name input opens', screen.includes('分组名称'), screen.slice(0, 300))
  await pressText('交互测试')
  await press('\r')
  await sleep(400)
  const groupsPath = join(home, 'skills', '.system', 'skill-viewer', 'groups.json')
  check('groups.json written', existsSync(groupsPath))
  if (existsSync(groupsPath)) {
    const groups = JSON.parse(await readFile(groupsPath, 'utf8'))
    check('groups.json has group', Object.values(groups.groups).some((group) => group.name === '交互测试'), JSON.stringify(groups))
  }

  // groups page: Tab twice (skills -> mcp -> groups)
  await press('\t')
  await press('\t')
  await sleep(250)
  screen = await screenText()
  check('groups tab renders', screen.includes('分组 Groups'), screen.slice(0, 300))
  // direct horizontal arrow from group content switches tab (same as mcp/diagnostics)
  await press('\x1b[D') // left from body -> previous tab (mcp)
  await sleep(200)
  screen = await screenText()
  check('left from group body switches tab', screen.includes('MCP') && !screen.includes('分组 Groups'), screen.slice(0, 300))
  await press('\t') // back to groups
  await sleep(200)

  // focus traversal: up from first group reaches the tab bar, then left switches tab
  await press('\x1b[B') // down arrow: ensure list focus (if already body, stays)
  await press('\x1b[A') // up arrow at top group -> tabs
  await sleep(200)
  await press('\x1b[D') // left: previous tab (mcp)
  await sleep(200)
  screen = await screenText()
  check('up reaches tab bar and left switches tab', screen.includes('MCP') && !screen.includes('分组 Groups'), screen.slice(0, 300))

  // back to groups (Tab twice from mcp -> groups)
  await press('\t')
  await sleep(200)

  // Esc cancels create-group input and delete confirm
  await press('a')
  await sleep(200)
  check('create group modal open', (await screenText()).includes('分组名称'))
  await press('\x1b')
  await sleep(200)
  screen = await screenText()
  check('esc cancels create group', !screen.includes('分组名称') && screen.includes('分组 Groups'), screen.slice(0, 300))
  await press('d')
  await sleep(200)
  check('delete group confirm open', (await screenText()).includes('删除分组'))
  await press('\x1b')
  await sleep(200)
  screen = await screenText()
  check('esc cancels delete group', !screen.includes('删除分组') && screen.includes('分组 Groups'), screen.slice(0, 300))

  // r opens rename (regression: r must not be swallowed by refresh)
  await press('r')
  await sleep(200)
  screen = await screenText()
  check('r opens rename group', screen.includes('重命名分组') && screen.includes('分组名称'), screen.slice(0, 300))
  await press('\x1b')
  await sleep(200)

  await press('a')
  await sleep(200)
  check('group page create input', (await screenText()).includes('分组名称'))
  await pressText('第二组')
  await press('\r')
  await sleep(300)
  const groups2 = JSON.parse(await readFile(groupsPath, 'utf8'))
  check('second group created', Object.values(groups2.groups).some((group) => group.name === '第二组'), JSON.stringify(groups2))

  // A web/editor write invalidates the shared snapshot; UI must show a conflict.
  const beforeExternal = JSON.parse(await readFile(groupsPath, 'utf8'))
  const originalId = Object.keys(beforeExternal.groups)[0]
  const external = { ...beforeExternal, extra: { retain: true }, groups: { ...beforeExternal.groups,
    web: { name: 'Web external', scopes: { global: ['web-added'] } } } }
  const externalText = `${JSON.stringify(external, null, 2)}\n`
  await writeFile(groupsPath, externalText)
  await press('a'); await pressText('stale-create'); await press('\r')
  await sleep(200)
  check('stale group create displays refresh conflict', (await screenText()).includes('按 R 刷新'))
  check('stale create leaves external bytes unchanged', await readFile(groupsPath, 'utf8') === externalText)
  await press('R'); await sleep(350)
  check('refresh loads external group', runtime.snapshot().groups.web?.name === 'Web external')
  await press('a'); await pressText('after-refresh'); await press('\r'); await sleep(200)
  const savedGroups = JSON.parse(await readFile(groupsPath, 'utf8'))
  check('retry preserves external member and unknown metadata', savedGroups.groups.web.scopes.global.includes('web-added') && savedGroups.extra.retain)
  check('retry writes desired group', Object.values(savedGroups.groups).some((group) => group.name === 'after-refresh'))
  check('write records exact backup', await readFile(runtime.snapshot().groupsBackupPath, 'utf8') === externalText)

  // Two stale runtimes cannot clobber one another; retry uses a fresh snapshot.
  const concurrent = new ManagerRuntime({ get: () => undefined })
  try {
    await concurrent.refresh('shared-group-concurrency')
    await concurrent.ensureFresh()
    await runtime.renameGroup(originalId, 'runtime-new-name')
    const firstWrite = await readFile(groupsPath, 'utf8')
    await concurrent.deleteGroupById(originalId)
    check('other runtime stale delete rejected', concurrent.snapshot().statusMessage.text.includes('按 R 刷新'))
    check('stale delete preserves first runtime write', await readFile(groupsPath, 'utf8') === firstWrite)
    await concurrent.refresh('retry-delete')
    await concurrent.deleteGroupById(originalId)
    check('refreshed delete only removes its target', JSON.parse(await readFile(groupsPath, 'utf8')).groups.web.name === 'Web external')
    await runtime.refresh('reload-after-delete')
  } finally { concurrent.dispose() }

  // MCP tab renders (this runtime has no profile patch → empty state)
  await press('\t') // groups -> diagnostics
  await press('\t') // diagnostics -> skills
  await press('\t') // skills -> mcp
  await sleep(250)
  screen = await screenText()
  check('mcp tab renders', screen.includes('MCP servers') && screen.includes('没有 MCP 行'), screen.slice(0, 400))
  // P0 FR-2: actual runtime writes tab preference and browses the registered git root.
  const currentAlpha = join(project, '.dsh/skills/alpha', existsSync(join(project, '.dsh/skills/alpha/SKILL.md')) ? 'SKILL.md' : 'SKILL.md.disabled')
  const currentAlphaBytes = await readFile(currentAlpha)
  await press('1'); await press('v'); await press('o')
  screen = await screenText()
  check('workspace picker uses public known list', screen.includes('Other project'))
  await press('\x1b[B'); await press('\r'); await press('n')
  check('workspace cancel retains current scan', runtime.snapshot().scan.projectRoot === project)
  await press('o'); await press('\x1b[B'); await press('\r'); await press('y')
  screen = await screenText()
  check('workspace target root and list change', runtime.snapshot().scan.projectRoot === otherProject && screen.includes('other-only') && screen.includes('其他工作区'))
  check('workspace switch keeps process cwd', process.cwd() === project)
  await press('/'); await pressText('other-only'); await press('\r'); await press(' ')
  check('new workspace action targets only new root', existsSync(join(otherProject, '.dsh/skills/other-only.md.disabled')) && (await readFile(currentAlpha)).equals(currentAlphaBytes))
  await press('o'); await press('\x1b[H'); await press('\r'); await press('y')
  check('return current workspace', runtime.snapshot().scan.projectRoot === project)
  await press('4'); await runtime.rememberTab('diagnostics')
  check('tab persisted to private config', JSON.parse(await readFile(join(panel, 'config.json'), 'utf8')).lastTab === 'diagnostics')
  const coldView = new ManagerRuntime(runtimeContext)
  try { await coldView.ensureFresh(); check('cold runtime restores last tab', coldView.snapshot().activeTab === 'diagnostics') } finally { coldView.dispose() }
} finally {
  try { instance.unmount() } catch {}
  try { runtime.dispose() } catch {}
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  if (failures.length > 0) {
    console.error('ui-interaction-smoke FAILED')
    for (const failure of failures) console.error(` - ${failure}`)
    const screen = await screenText().catch(() => '')
    console.error('--- last screen (tail) ---')
    console.error(screen.slice(-4000))
    process.exit(1)
  }
  console.log('ui-interaction-smoke OK: toggle / delete+undo / add / groups / stale conflict+refresh / multi-runtime / exact backup')
}
