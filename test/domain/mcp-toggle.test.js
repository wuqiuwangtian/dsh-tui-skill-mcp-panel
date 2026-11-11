import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editMcpDisabled, migrateLegacyMcpToggles } from '../../lib/types/domain/mcp/toggle.js'
import { parsePatchText, TOGGLE_BLOCK_BEGIN as BEGIN, TOGGLE_BLOCK_END as END } from '../../lib/types/domain/mcp/patch.js'

const identity = { id: 'mcp-a', serverName: 'alpha' }
const source = `# keep header\n- insert:\n    - id: mcp-a\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: alpha\n        command: node\n        env: { TOKEN: !!js process.env.TOKEN } # keep expression\n- id: unrelated\n  config: { raw: 'unchanged' }\n`
const legacy = (body) => `${BEGIN}\n${body}${END}\n`
const toggle = (text, disabled) => editMcpDisabled(text, identity, disabled).text

test('ordinary toggles change only disabled and restore a missing key exactly', () => {
  const off = toggle(source, true)
  assert.equal(off, source.replace("      name:", "      disabled: true\n      name:"))
  assert.equal(toggle(off, false), source)
  assert.equal(editMcpDisabled(source, identity, false).changed, false)
  assert(!off.includes(BEGIN))
})

test('boolean edits retain inline comments, quotes, expressions and CRLF bytes', () => {
  const text = source.replace('      config:', '      disabled: true # keep switch comment\n      config:').replaceAll('\n', '\r\n')
  const on = toggle(text, false)
  assert.equal(on, text.replace('disabled: true', 'disabled: false'))
  assert.equal(toggle(on, true), text)
})

test('flow mappings with existing boolean fields support exact scalar changes', () => {
  const text = `- { id: mcp-a, name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: {serverName: alpha} }\n`
  assert.equal(toggle(text, false), text.replace('disabled: true', 'disabled: false'))
  assert.throws(() => toggle(text.replace('disabled: true, ', ''), true), /内联 YAML/u)
})

test('top-level named MCP definitions are targeted without rewriting other fields', () => {
  const text = `- id: mcp-a\n  name: '@deepseek-ai/dsh-mcp-client'\n  disabled: true\n  config: {serverName: alpha}\n`
  assert.equal(toggle(text, false), text.replace('  disabled: true\n', ''))
})

test('target toggle migrates only its old override and retains all foreign block bytes', () => {
  const foreign = '# preserve foreign comment\n- id: foreign\n  config: { untouched: true }\n- id: mcp-b\n  disabled: true\n'
  const original = source + legacy('- id: mcp-a\n  disabled: false\n' + foreign)
  const off = toggle(original, true)
  assert.equal(off, toggle(source, true) + legacy(foreign))
  assert.equal(parsePatchText(off).rows.filter(r=>r.id==='mcp-a').length,1)
  const crlf = original.replaceAll('\n','\r\n')
  assert.equal(toggle(crlf,true),off.replaceAll('\n','\r\n'))
})

test('migration preserves all saved states; foreign rows and comments remain verbatim', () => {
  const b = source.replaceAll('mcp-a','mcp-b').replaceAll('alpha','beta')
  const original = source + b + legacy('# keep standalone comment\n- id: mcp-a\n  disabled: true\n- id: mcp-b\n  disabled: false\n- id: foreign\n  config: {keep: 42}\n')
  const migrated = migrateLegacyMcpToggles(original)
  assert.deepEqual(migrated.ids,['mcp-a','mcp-b'])
  const rows = parsePatchText(migrated.text).rows
  assert.equal(rows.find(r=>r.id==='mcp-a').disabled,true)
  assert.equal(rows.find(r=>r.id==='mcp-b').disabled,undefined)
  assert(migrated.text.includes('# keep standalone comment\n- id: foreign\n  config: {keep: 42}\n'))
  assert.equal(migrateLegacyMcpToggles(migrated.text).changed,false)
})

test('expressions, aliases, anchors and nonboolean disabled values are never edited', () => {
  for (const field of ['!!js true', '"true"', '1', 'null', '&switch true', '*switch', '!!bool true']) {
    const text = source.replace('      config:', `      disabled: ${field}\n      config:`)
    assert.throws(()=>toggle(text,false),undefined,field)
  }
  const anchored = source.replace('- id: mcp-a', '- &server\n      id: mcp-a')
  assert.throws(()=>toggle(anchored,true))
  const aliased = source.replace('      config:', '      disabled: &switch true\n      config:') + '- id: external\n  disabled: *switch\n'
  assert.throws(()=>toggle(aliased,false),/普通布尔值/u)
})

test('duplicate identities, foreign overrides, wrong modules and missing names refuse edits', () => {
  for (const text of [source+source, source+'- id: mcp-a\n  disabled: false\n',
    source.replace('- insert:', '- id: mcp-a\n  disabled: false\n  insert:'),
    source+'- id: mcp-a\n  config: {command: other}\n',
    source.replace('@deepseek-ai/dsh-mcp-client','another-plugin'),
    source.replace('serverName: alpha','serverName: other'),
    source.replace('serverName: alpha','')]) assert.throws(()=>toggle(text,true))
})

test('damaged/duplicate legacy rows and manually decorated target overrides refuse migration', () => {
  for (const text of [source+BEGIN, source+legacy('- id: mcp-a\n  disabled: true\n- id: mcp-a\n  disabled: false\n'),
    source+legacy('- id: mcp-a # preserve this comment\n  disabled: true\n'),
    source+legacy('- id: mcp-a\n  # keep between keys\n  disabled: true\n'),
    source+legacy('- id: missing\n  disabled: false\n')]) assert.throws(()=>migrateLegacyMcpToggles(text))
})

test('batch migration leaves non-owned rows intact; targeted toggles refuse touching them', () => {
  const text=source+legacy('- id: mcp-a\n  disabled: true\n  config: {}\n')
  assert.equal(migrateLegacyMcpToggles(text).text,text)
  assert.throws(()=>toggle(text,false),/外来字段/u)
})

test('a legacy false override cannot bypass expression-readonly or duplicate checks', () => {
  const original = source.replace('      config:', '      disabled: !!js process.env.OFF\n      config:')
  assert.throws(()=>toggle(original+legacy('- id: mcp-a\n  disabled: false\n'),false),/普通布尔值/u)
  assert.throws(()=>toggle(source+source+legacy('- id: mcp-a\n  disabled: false\n'),true),/重复/u)
})

test('unknown YAML tags are rejected without including raw user expressions in errors', () => {
  const text=source.replace('command: node','command: !secret do-not-leak')
  assert.throws(()=>toggle(text,true),error=>!error.message.includes('do-not-leak'))
})
