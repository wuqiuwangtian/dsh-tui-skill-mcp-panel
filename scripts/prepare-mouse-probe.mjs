/** Long-list mouse fixtures for the real TTY probe; all data stays in /tmp. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const host = process.argv[2]
assert.ok(host, 'usage: node scripts/prepare-mouse-probe.mjs <CLI-installed dsh-tui directory>')
const base = dirname(fileURLToPath(import.meta.url))
const probe = JSON.parse(execFileSync(process.execPath, [join(base, 'prepare-tui-probe.mjs'), host], { encoding: 'utf8' }))
const body = Array.from({ length: 100 }, (_, i) => `MOUSE-BODY-${String(i).padStart(3, '0')} 中文🧭`).join('\n')
for (let i = 0; i < 40; i++) {
  const name = `mouse-${String(i).padStart(3, '0')}`, dir = join(probe.project, '.dsh/skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Mouse fixture ${i}\n---\n${body}\n`)
}
const global = join(probe.root, 'dsh/skills/mouse-global')
await mkdir(global, { recursive: true })
await writeFile(join(global, 'SKILL.md'), '---\nname: mouse-global\ndescription: Global fixture\n---\nGlobal fixture.\n')
const groups = join(probe.root, 'dsh/skills/.system/skill-viewer')
await mkdir(groups, { recursive: true })
await writeFile(join(groups, 'groups.json'), JSON.stringify({ version: 1,
  groups: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`group-${i}`, { name: `Mouse group ${String(i).padStart(3, '0')}`, scopes: { global: [] } }])) }, null, 2) + '\n')
const patchPath = join(probe.profile, 'cordis.patch.yml')
let patch = await readFile(patchPath, 'utf8')
patch = patch.replaceAll('          PANEL_TEST_TOKEN:', Array.from({ length: 80 }, (_, i) =>
  `          MOUSE_ENV_${String(i).padStart(3, '0')}: fixture-hidden-value`).join('\n') + '\n          PANEL_TEST_TOKEN:')
for (let i = 0; i < 30; i++) {
  const name = `mouse-mcp-${String(i).padStart(3, '0')}`
  patch += `\n- insert:\n    - id: ${name}\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: true\n      config:\n        serverName: ${name}\n        transport: stdio\n        command: node\n        args: []\n`
}
await writeFile(patchPath, patch)
await writeFile(join(probe.root, 'mouse-probe.json'), JSON.stringify(probe, null, 2) + '\n')
console.log(JSON.stringify(probe, null, 2))
