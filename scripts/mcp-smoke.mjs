/**
 * Headless MCP smoke (dev-only): real ManagerRuntime + fake loader/configEditor,
 * toggles a profile-patch MCP row by writing/removing the managed block, waits
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
      fiber: { state: state.phase },
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

  const originalText = await readFile(profilePatch, 'utf8')
  // toggle alpha off: loader flips after a short delay (simulated HMR)
  setTimeout(() => { loaderState['mcp-alpha'].disabled = true }, 700)
  await runtime.toggleMcp('mcp-alpha')
  const afterDisable = runtime.snapshot().mcp
  const disabledText = await readFile(profilePatch, 'utf8')
  check('managed block written', disabledText.includes('mcp-toggle:begin') && disabledText.includes('- id: mcp-alpha'))
  check('outside bytes preserved', disabledText.startsWith('# test profile patch'))
  check('toggle outcome applied', afterDisable.lastAction?.outcome === 'applied', JSON.stringify(afterDisable.lastAction))
  check('row disabled after toggle', afterDisable.rows.find((row) => row.id === 'mcp-alpha')?.enabled === false)
  const backupRoot = join(panel, 'backups')
  check('backup created', existsSync(backupRoot))

  // toggle alpha back on
  setTimeout(() => { loaderState['mcp-alpha'].disabled = false }, 700)
  await runtime.toggleMcp('mcp-alpha')
  const afterEnable = runtime.snapshot().mcp
  const enabledText = await readFile(profilePatch, 'utf8')
  check('managed block removed', !enabledText.includes('mcp-toggle:begin'))
  check('file restored exactly', enabledText === originalText)
  check('toggle back applied', afterEnable.rows.find((row) => row.id === 'mcp-alpha')?.enabled === true)

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
  console.log('mcp-smoke OK: list layers / mask / !!js / managed toggle / HMR wait / home read-only')
}
