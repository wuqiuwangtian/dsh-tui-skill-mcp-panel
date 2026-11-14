/** Isolated real-TUI skill status/group/search fixture; no real user data or model turn. */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/prepare-tui-probe.mjs'), ...process.argv.slice(2)], { encoding: 'utf8' }))
const root = join(probe.project, '.dsh/skills'), homeSkills = join(probe.root, 'dsh/skills'), panel = join(probe.root, 'panel')
const doc = name => `---\nname: ${name}\ndescription: Skill filter fixture\n---\nBody.\n`
const enabled = join(root, 'filter-enabled.md'), disabled = join(root, 'filter-disabled.md.disabled'), invalid = join(root, 'filter-invalid.md'), global = join(homeSkills, 'filter-enabled.md')
await mkdir(homeSkills, { recursive: true }); await mkdir(panel)
await writeFile(enabled, doc('filter-enabled')); await writeFile(disabled, doc('filter-disabled'))
await writeFile(invalid, '---\nname: filter-invalid\n---\nMissing description.\n')
await writeFile(global, doc('filter-enabled'))
const groupDir = join(homeSkills, '.system/skill-viewer'), groupFile = join(groupDir, 'groups.json')
await mkdir(groupDir, { recursive: true })
await writeFile(groupFile, JSON.stringify({ version: 1, sentinel: 'preserve', groups: { fixture: { name: 'Filter fixture', scopes: { [probe.project]: ['filter-enabled','filter-disabled','filter-invalid'], global: [] } } } }, null, 2) + '\n')
const config = join(panel, 'config.json')
await writeFile(config, JSON.stringify({ version: 1, trashRetentionDays: 7, lastTab: 'skills', future: { keep: true } }, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ ...probe, enabled, disabled, invalid, global, groupFile, config }, null, 2))
