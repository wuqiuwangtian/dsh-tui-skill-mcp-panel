/** Isolated FR-2 probe: real public workspace listing + persistent tab. No model turn. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/prepare-tui-probe.mjs'), ...process.argv.slice(2)], { encoding: 'utf8' }))
const other = join(probe.root, 'other-project-其他工作区'), child = join(other, 'subdirectory')
await mkdir(join(other, '.git'), { recursive: true })
await mkdir(join(other, '.dsh/skills'), { recursive: true })
await mkdir(child)
await writeFile(join(other, '.dsh/skills/other-only.md'), '---\nname: other-only\ndescription: Other workspace fixture\n---\nOther body.\n')
const panel = join(probe.root, 'panel')
await mkdir(panel)
await writeFile(join(panel, 'config.json'), JSON.stringify({ version: 1, lastTab: 'diagnostics', trashRetentionDays: 7, mcpGroups: {}, future: { sentinel: 'preserve' } }, null, 2) + '\n', { mode: 0o600 })
const observer = join(probe.root, 'view-state-observer.mjs')
await writeFile(observer, `import fs from 'node:fs/promises'
export const name = 'view-state-probe-observer'
export function apply(ctx) {
  ctx.inject(['workspaceRegistry'], async scope => {
    const registry = scope.get('workspaceRegistry')
    await registry.create(${JSON.stringify(child)}, 'Other workspace')
    await fs.writeFile(${JSON.stringify(join(probe.root, 'workspace-registration.json'))}, JSON.stringify({ registered: true, cwd: process.cwd(), workspaces: registry.list().map(row => ({ path: row.path, title: row.title })) }))
  })
}
`)
const patch = join(probe.profile, 'cordis.patch.yml')
await writeFile(patch, await readFile(patch, 'utf8') + `\n- insert:\n    - id: view-state-probe-observer\n      name: ${JSON.stringify(observer)}\n`)
console.log(JSON.stringify({ ...probe, other, child, config: join(panel, 'config.json') }, null, 2))
