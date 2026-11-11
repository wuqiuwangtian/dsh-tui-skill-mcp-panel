/** Actual installed web editor/model vs guarded TUI writes; temporary files only. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { editMcpDisabled } from '../lib/types/domain/mcp/toggle.js'
import { addManagedMcp } from '../lib/types/domain/mcp/managed.js'
import { parsePatchText, upsertManagedToggle } from '../lib/types/domain/mcp/patch.js'
import { readPatchSnapshot, saveMcpMigration, saveMcpToggle } from '../lib/types/domain/mcp/write.js'

assert(process.argv[2], 'usage: node scripts/mcp-web-interop.mjs <installed web 2.3.7 directory>')
const webDir = resolve(process.argv[2])
assert.equal(JSON.parse(await readFile(join(webDir, 'package.json'), 'utf8')).version, '2.3.7')
const web = await import(pathToFileURL(join(webDir, 'lib/patch-editor.js')).href)
const { rowEnabled } = await import(pathToFileURL(join(webDir, 'lib/mcp/model.js')).href)
const root = await mkdtemp(join(tmpdir(), 'mcp-web-toggle-'))
const patchPath = join(root, 'cordis.patch.yml'), homePatchPath = join(root, 'home.yml')
const config = { serverName:'alpha', transport:'stdio', command:'node', args:['fixture.mjs'] }
const definition = `- insert:\n    - id: mcp-alpha\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: {serverName: alpha, transport: stdio, command: node}\n`
const sources = {
  original: '# original bytes\n' + definition,
  tuiOwned: addManagedMcp('# original bytes\n', 'mcp-alpha', config),
  webOwned: '# >>> dsh-skill-mcp-panel:mcp:begin\n' + definition + '# <<< dsh-skill-mcp-panel:mcp:end\n',
}
const observations = []
const inspect = (text, disabled, label) => {
  const named = web.listMcpPatchRows(text)
  assert.equal(named.length, 1, label)
  assert.equal(rowEnabled(named[0]), !disabled, label)
  const rows = parsePatchText(text).rows.filter(r=>r.id==='mcp-alpha')
  assert.equal(rows.length, 1, label)
  assert.equal(rows[0].disabled ?? false, disabled, label)
  observations.push(label)
}
try {
  for (const [kind, initial] of Object.entries(sources)) {
    await writeFile(patchPath, initial)
    const snapshot = async () => ({ patchPath, homePatchPath,
      expectedProfile:(await readPatchSnapshot(patchPath)).fingerprint,
      expectedHome:(await readPatchSnapshot(homePatchPath)).fingerprint, backupRoot:join(root,'backups') })
    const tui = async disabled => {
      await saveMcpToggle({ ...await snapshot(), id:'mcp-alpha', serverName:'alpha', disabled })
      const text = await readFile(patchPath,'utf8')
      inspect(text,disabled,`${kind}: TUI ${disabled?'off':'on'} -> web read`)
    }
    const browser = async disabled => {
      const text = web.setEntryDisabledInText(await readFile(patchPath,'utf8'), {id:'mcp-alpha',serverName:'alpha'}, disabled)
      await writeFile(patchPath,text)
      inspect(text,disabled,`${kind}: web ${disabled?'off':'on'} -> TUI read`)
    }
    await tui(true); await browser(false); await browser(true); await tui(false)
    // Existing dev builds need migration before handing control back to web.
    const legacy = upsertManagedToggle(initial,'mcp-alpha',true).text
    await writeFile(patchPath,legacy)
    const migration = await saveMcpMigration(await snapshot())
    assert.equal(await readFile(migration.backupPath,'utf8'),legacy)
    inspect(await readFile(patchPath,'utf8'),true,`${kind}: legacy migration -> web read`)
    await browser(false)
    const dangerous = initial + '- id: mcp-alpha\n  disabled: false\n'
    assert.throws(()=>editMcpDisabled(dangerous,{id:'mcp-alpha',serverName:'alpha'},true))
  }
  console.log(JSON.stringify({ webPanel:'2.3.7', checks:observations.length, observations,
    scope:'actual web editor/model + TUI guarded disk writer; not full UI/HMR acceptance' },null,2))
} finally { await rm(root,{recursive:true,force:true}) }
