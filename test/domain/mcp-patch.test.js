import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  backupPatchFile,
  buildMcpRows,
  describeMcpConfig,
  extractManagedBlock,
  maskSecretConfig,
  parsePatchText,
  readManagedToggles,
  upsertManagedToggle,
  validatePatchText,
  writePatchFileAtomic,
  TOGGLE_BLOCK_BEGIN,
  TOGGLE_BLOCK_END,
  MCP_MODULE,
} from '../../lib/types/domain/mcp/patch.js'

const PATCH = `# profile patch for tests
- insert:
    - id: mcp-alpha
      name: "${MCP_MODULE}"
      config:
        transport: stdio
        serverName: alpha
        command: node
        args: ["server.js"]
        env:
          TOKEN: !!js process.env.TOKEN
    - id: mcp-beta
      name: "${MCP_MODULE}"
      config:
        transport: streamable-http
        serverName: beta
        url: https://example.invalid/mcp
        headers:
          Authorization: !!js "process.env.TOKEN"
- id: something-else
  config:
    x: 1
`

test('parsePatchText flattens insert/override rows and keeps !!js markers', () => {
  const parsed = parsePatchText(PATCH)
  assert.equal(parsed.ok, true, parsed.error)
  const ids = parsed.rows.map((row) => row.id)
  assert.deepEqual(ids, ['mcp-alpha', 'mcp-beta', 'something-else'])
  const alpha = parsed.rows[0]
  assert.equal(alpha.name, MCP_MODULE)
  assert.equal(alpha.override, false)
  assert.equal(alpha.config.transport, 'stdio')
  assert.deepEqual(alpha.config.env.TOKEN, { __js: 'process.env.TOKEN' })
  const beta = parsed.rows[1]
  assert.equal(beta.config.headers.Authorization.__js, 'process.env.TOKEN')
  const override = parsed.rows[2]
  assert.equal(override.override, true)
  assert.deepEqual(parsePatchText('').rows, [])
  assert.equal(parsePatchText('not-a-sequence').ok, false)
  assert.equal(parsePatchText('- insert: [').ok, false)
})

test('upsertManagedToggle adds/removes rows and preserves all other bytes', () => {
  const disabled = upsertManagedToggle(PATCH, 'mcp-alpha', true)
  assert.equal(disabled.ok, true, disabled.error)
  assert.equal(disabled.changed, true)
  assert.ok(disabled.text.startsWith(PATCH))
  assert.ok(disabled.text.includes(TOGGLE_BLOCK_BEGIN))
  assert.deepEqual(readManagedToggles(disabled.text), [{ id: 'mcp-alpha', disabled: true }])
  assert.equal(validatePatchText(disabled.text).ok, true)

  const again = upsertManagedToggle(disabled.text, 'mcp-alpha', true)
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)

  const second = upsertManagedToggle(disabled.text, 'mcp-beta', true)
  assert.equal(second.ok, true)
  assert.deepEqual(readManagedToggles(second.text), [
    { id: 'mcp-alpha', disabled: true },
    { id: 'mcp-beta', disabled: true },
  ])

  const enableAlpha = upsertManagedToggle(second.text, 'mcp-alpha', false)
  assert.equal(enableAlpha.ok, true)
  assert.deepEqual(readManagedToggles(enableAlpha.text), [{ id: 'mcp-beta', disabled: true }])

  const enableAll = upsertManagedToggle(enableAlpha.text, 'mcp-beta', false)
  assert.equal(enableAll.ok, true)
  assert.equal(extractManagedBlock(enableAll.text), undefined)
  assert.equal(enableAll.text, PATCH)
})

test('upsertManagedToggle keeps block in place when it exists', () => {
  const withBlock = upsertManagedToggle(PATCH, 'mcp-alpha', true)
  const middle = `- id: kept\n  config:\n    x: 1\n\n${withBlock.text}`
  const changed = upsertManagedToggle(middle, 'mcp-beta', true)
  assert.equal(changed.ok, true, changed.error)
  assert.ok(changed.text.startsWith('- id: kept'))
  assert.ok(changed.text.includes('- id: kept'))
  assert.deepEqual(readManagedToggles(changed.text).map((row) => row.id).sort(), ['mcp-alpha', 'mcp-beta'])
})

test('buildMcpRows combines loader state with profile/home layers', () => {
  const parsed = parsePatchText(PATCH)
  assert.equal(parsed.ok, true)
  const home = parsePatchText(`- insert:\n    - id: mcp-beta\n      name: "${MCP_MODULE}"\n      config:\n        transport: streamable-http\n        serverName: beta\n- id: mcp-broken\n  disabled: !!js process.env.OFF === "1"\n`)
  assert.equal(home.ok, true)
  const loaderRows = [
    { id: 'mcp-alpha', config: { transport: 'stdio', serverName: 'alpha', env: { TOKEN: 'secret' } }, disabled: false, phase: 'active' },
    { id: 'mcp-beta', config: { transport: 'streamable-http', serverName: 'beta' }, disabled: true, phase: 'disabled' },
    { id: 'mcp-broken', config: undefined, disabled: true, phase: 'disabled' },
    { id: 'mcp-bundle', config: undefined, disabled: false, phase: 'active' },
  ]
  const rows = buildMcpRows({ loaderRows, profileRows: parsed.rows, homeRows: home.rows })
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.equal(byId.get('mcp-alpha').layer, 'profile')
  assert.equal(byId.get('mcp-alpha').targetable, true)
  assert.equal(byId.get('mcp-alpha').enabled, true)
  assert.equal(byId.get('mcp-beta').layer, 'home')
  assert.equal(byId.get('mcp-beta').targetable, false)
  assert.match(byId.get('mcp-beta').readOnlyReason, /home 层/u)
  assert.equal(byId.get('mcp-broken').targetable, false)
  assert.equal(byId.get('mcp-broken').disabledExpression.includes('process.env.OFF'), true)
  assert.equal(byId.get('mcp-bundle').layer, 'bundle')
  assert.equal(byId.get('mcp-bundle').targetable, false)
  // sorted by serverName (fallback id)
  assert.deepEqual(rows.map((row) => row.id), ['mcp-alpha', 'mcp-beta', 'mcp-broken', 'mcp-bundle'])
})

test('config descriptions and masking never leak secret values', () => {
  const config = {
    transport: 'stdio',
    serverName: 'alpha',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: 'secret-value', OTHER: { __js: 'process.env.X' } },
    headers: { Authorization: 'Bearer secret' },
    toolCallTimeoutMs: 1000,
    failOnStartupError: false,
  }
  const lines = describeMcpConfig(config).join('\n')
  assert.match(lines, /transport stdio/u)
  assert.match(lines, /env keys TOKEN, OTHER/u)
  assert.equal(lines.includes('secret-value'), false)
  assert.equal(lines.includes('Bearer secret'), false)
  const masked = maskSecretConfig(config)
  assert.deepEqual(masked.env, { TOKEN: '***', OTHER: '***' })
  assert.deepEqual(masked.headers, { Authorization: '***' })
  assert.equal(masked.transport, 'stdio')
})

test('managed block extraction tolerates malformed content and patch files round-trip on disk', async () => {
  assert.equal(extractManagedBlock('no block here'), undefined)
  const malformed = `${TOGGLE_BLOCK_BEGIN}\n- not: [valid\n${TOGGLE_BLOCK_END}`
  assert.deepEqual(extractManagedBlock(malformed)?.rows, [])

  const dir = await mkdtemp(join(tmpdir(), 'mcp-patch-'))
  try {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, PATCH, 'utf8')
    const backup = await backupPatchFile(patchPath, join(dir, 'backups', '1'))
    assert.ok(backup)
    assert.equal(await readFile(backup, 'utf8'), PATCH)
    const next = upsertManagedToggle(await readFile(patchPath, 'utf8'), 'mcp-alpha', true)
    assert.equal(next.ok, true)
    await writePatchFileAtomic(patchPath, next.text)
    assert.equal(await readFile(patchPath, 'utf8'), next.text)
    const parsed = parsePatchText(await readFile(patchPath, 'utf8'))
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.toggles, [{ id: 'mcp-alpha', disabled: true }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
