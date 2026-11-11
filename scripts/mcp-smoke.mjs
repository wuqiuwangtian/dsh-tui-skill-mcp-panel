/**
 * Headless MCP smoke (dev-only): real ManagerRuntime + fake loader/configEditor,
 * toggles a profile-patch MCP definition by editing its disabled field, waits
 * for the loader state change (simulating HMR), and checks home-layer/!!js
 * rows stay read-only.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repo = process.cwd()
const { ManagerRuntime } = await import(pathToFileURL(join(repo, 'lib', 'types', 'host', 'manager-runtime.js')).href)
const { parsePatchText } = await import(pathToFileURL(join(repo, 'lib', 'types', 'domain', 'mcp', 'patch.js')).href)

const root = await mkdtemp(join(tmpdir(), 'mcp-smoke-'))
const project = join(root, 'project')
const home = join(root, 'home')
const panel = join(root, 'panel')
const profile = join(root, 'profiles', 'test')
await mkdir(join(project, '.git'), { recursive: true })
await mkdir(join(profile), { recursive: true })
await mkdir(join(home, 'skills'), { recursive: true })
const profilePatch = join(profile, 'cordis.patch.yml')
const homePatch = join(home, 'cordis.patch.yml')
await writeFile(
  profilePatch,
  `# test profile patch
- insert:
    - id: mcp-alpha
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: alpha
        command: node
        env:
          TOKEN: !!js process.env.TOKEN
- id: mcp-expr
  disabled: !!js process.env.OFF === "1"
- insert:
    - id: mcp-delta
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: delta
`,
  'utf8',
)
await writeFile(
  homePatch,
  `- insert:
    - id: mcp-beta
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: streamable-http
        serverName: beta
- id: mcp-delta
  config:
    transport: stdio
    serverName: delta-home
`,
  'utf8',
)
process.env.DSH_HOME = home
process.env.SKILL_MCP_PANEL_HOME = panel
process.env.SKILL_MCP_PANEL_DUMP = join(root, 'dump.json')
process.chdir(project)

const loaderState = {
  'mcp-alpha': { disabled: false, phase: 2, config: { transport: 'stdio', serverName: 'alpha', command: 'node', env: { TOKEN: 'secret' } } },
  'mcp-beta': { disabled: false, phase: 2, config: { transport: 'streamable-http', serverName: 'beta' } },
  'mcp-expr': { disabled: true, phase: 3, config: undefined },
  'mcp-delta': { disabled: false, phase: 2, config: { transport: 'stdio', serverName: 'delta' } },
}
const fakeLoader = {
  entries: () =>
    Object.entries(loaderState).map(([id, state]) => ({
      options: { id, name: '@deepseek-ai/dsh-mcp-client', ...(state.config === undefined ? {} : { config: state.config }) },
      get disabled() { return state.disabled },
      get fiber() { return state.disabled ? undefined : { state: state.phase } },
    })),
}
const ctx = {
  get(name) {
    if (name === 'loader') return fakeLoader
    if (name === 'configEditor') return { documentPath: profilePatch }
    return undefined
  },
}

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}
const runtime = new ManagerRuntime(ctx)
try {
  await runtime.refresh('mcp-smoke')
  let mcp = runtime.snapshot().mcp
  check('lists four MCP rows', mcp.rows.length === 4, JSON.stringify(mcp.rows.map((row) => row.id)))
  const alpha = mcp.rows.find((row) => row.id === 'mcp-alpha')
  const beta = mcp.rows.find((row) => row.id === 'mcp-beta')
  const expr = mcp.rows.find((row) => row.id === 'mcp-expr')
  check('alpha is profile layer + targetable', alpha?.layer === 'profile' && alpha?.targetable === true, JSON.stringify(alpha))
  check('alpha config masked in detail helper', alpha?.config?.env?.TOKEN === 'secret')
  check('beta is home layer + read-only', beta?.layer === 'home' && beta?.targetable === false && beta?.overriddenByHome === true)
  check('expr row blocked by !!js disabled', expr?.targetable === false && expr?.disabledExpression?.includes('process.env.OFF'), JSON.stringify(expr))
  const delta = mcp.rows.find((row) => row.id === 'mcp-delta')
  check('delta overridden by home layer', delta?.layer === 'home' && delta?.overriddenByHome === true, JSON.stringify(delta))
  check('profile patch path detected', mcp.profilePatchPath === profilePatch)
  check('home patch path detected', mcp.homePatchPath === homePatch)
  const dump = JSON.parse(await readFile(join(root, 'dump.json'), 'utf8'))
  check('debug dump masks env values', dump.mcp.rows.find((row) => row.id === 'mcp-alpha')?.config?.env?.TOKEN === '***')

  const originalText = await readFile(profilePatch, 'utf8')
  // toggle alpha off: loader flips after a short delay (simulated HMR)
  setTimeout(() => { loaderState['mcp-alpha'].disabled = true }, 700)
  await runtime.toggleMcp('mcp-alpha')
  const afterDisable = runtime.snapshot().mcp
  const disabledText = await readFile(profilePatch, 'utf8')
  check('definition disabled directly', parsePatchText(disabledText).rows.find((row) => row.id === 'mcp-alpha')?.disabled === true && parsePatchText(disabledText).toggles.length === 0)
  check('outside bytes preserved', disabledText.startsWith('# test profile patch'))
  check('toggle outcome applied', afterDisable.lastAction?.outcome === 'applied', JSON.stringify(afterDisable.lastAction))
  check('row disabled after toggle', afterDisable.rows.find((row) => row.id === 'mcp-alpha')?.enabled === false)
  const backupRoot = join(panel, 'backups')
  check('backup created', existsSync(backupRoot))

  // toggle alpha back on
  setTimeout(() => {
    loaderState['mcp-alpha'].disabled = false
    loaderState['mcp-alpha'].phase = 1
  }, 700)
  setTimeout(() => {
    check('loading is not applied', runtime.snapshot().mcp.lastAction?.outcome === 'saved')
    check('loading retains progress indicator', runtime.snapshot().mcp.togglingId === 'mcp-alpha')
  }, 1050)
  setTimeout(() => { loaderState['mcp-alpha'].phase = 2 }, 1400)
  await runtime.toggleMcp('mcp-alpha')
  const afterEnable = runtime.snapshot().mcp
  const enabledText = await readFile(profilePatch, 'utf8')
  check('managed block removed', !enabledText.includes('mcp-toggle:begin'))
  check('file restored exactly', enabledText === originalText)
  check('toggle back applied', afterEnable.rows.find((row) => row.id === 'mcp-alpha')?.enabled === true)

  // Originally-disabled definitions are edited directly; foreign overrides remain guarded.
  const originallyDisabled = originalText.replace('    - id: mcp-alpha\n', '    - id: mcp-alpha\n      disabled: true\n')
  await writeFile(profilePatch, originallyDisabled)
  loaderState['mcp-alpha'].disabled = true
  await runtime.refreshMcp()
  setTimeout(() => { loaderState['mcp-alpha'].disabled = false }, 700)
  await runtime.toggleMcp('mcp-alpha')
  check('originally disabled definition enabled directly', parsePatchText(await readFile(profilePatch, 'utf8')).rows.find((row) => row.id === 'mcp-alpha')?.disabled !== true && parsePatchText(await readFile(profilePatch, 'utf8')).toggles.length === 0)
  check('originally disabled row enables', runtime.snapshot().mcp.lastAction?.outcome === 'applied')
  setTimeout(() => { loaderState['mcp-alpha'].disabled = true }, 700)
  await runtime.toggleMcp('mcp-alpha')
  check('originally disabled row restores exact bytes', (await readFile(profilePatch, 'utf8')) === originallyDisabled)

  // A stale UI must not silently toggle a changed profile or home layer.
  const externalEdit = `${originallyDisabled}# changed by editor\n`
  await writeFile(profilePatch, externalEdit)
  await runtime.toggleMcp('mcp-alpha')
  check('external profile edit reports conflict', runtime.snapshot().mcp.lastAction?.outcome === 'conflict')
  check('external profile edit preserved', (await readFile(profilePatch, 'utf8')) === externalEdit)
  await runtime.refreshMcp()
  const homeText = await readFile(homePatch, 'utf8')
  await writeFile(homePatch, `${homeText}- id: mcp-alpha\n  disabled: true\n`)
  await runtime.toggleMcp('mcp-alpha')
  check('new home override reports conflict', runtime.snapshot().mcp.lastAction?.outcome === 'conflict')
  check('home conflict leaves profile untouched', (await readFile(profilePatch, 'utf8')) === externalEdit)
  await writeFile(homePatch, homeText)
  await runtime.refreshMcp()

  // Backups are mandatory: a broken destination must never produce a saved status.
  await rm(backupRoot, { recursive: true })
  await writeFile(backupRoot, 'not a directory')
  await runtime.toggleMcp('mcp-alpha')
  check('backup failure reports error', runtime.snapshot().mcp.lastAction?.outcome === 'error')
  check('backup failure leaves patch unchanged', (await readFile(profilePatch, 'utf8')) === externalEdit)
  await rm(backupRoot)

  // A failed activation is saved-but-failed, never a successful enable.
  setTimeout(() => {
    loaderState['mcp-alpha'].disabled = false
    loaderState['mcp-alpha'].phase = 3
  }, 700)
  await runtime.toggleMcp('mcp-alpha')
  check('failed fiber is not applied', runtime.snapshot().mcp.lastAction?.outcome === 'error')
  check('failed fiber has an actionable message', (runtime.snapshot().statusMessage?.text ?? '').includes('插件加载失败'))

  // read-only row refuses
  const before = await readFile(profilePatch, 'utf8')
  await runtime.toggleMcp('mcp-beta')
  check('home-layer toggle refused (file unchanged)', (await readFile(profilePatch, 'utf8')) === before)
  check('home-layer toggle message', (runtime.snapshot().statusMessage?.text ?? '').includes('home 层') || (runtime.snapshot().statusMessage?.text ?? '').includes('只读'))
} finally {
  runtime.dispose()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  if (failures.length > 0) {
    console.error('mcp-smoke FAILED')
    for (const failure of failures) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log('mcp-smoke OK: layers / mask / !!js / toggle both baselines / HMR / conflicts / mandatory backups / home read-only')
}
