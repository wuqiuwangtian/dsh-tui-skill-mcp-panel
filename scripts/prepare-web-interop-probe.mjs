/** Real web + TUI against one isolated loader/profile. Preparation only. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostDir = resolve(process.argv[2] ?? '')
const webDir = resolve(process.argv[3] ?? '')
assert.ok(process.argv[2] && process.argv[3], 'usage: node scripts/prepare-web-interop-probe.mjs <CLI-installed TUI host> <installed web panel>')
const version = async path => JSON.parse(await readFile(join(path, 'package.json'), 'utf8')).version
assert.ok(['0.19.0', '0.20.0'].includes(await version(hostDir)), 'review host internals before preparing web/TUI interop')
assert.equal(await version(webDir), '2.3.7')
const cli = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const require = createRequire(cli)
const webAppDir = dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
assert.ok(['0.2.2-rc.1', '0.2.2-rc.2'].includes(await version(webAppDir)), 'review a new web app before preparing interop')
const probe = JSON.parse(execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'prepare-tui-probe.mjs'), hostDir], { encoding: 'utf8' }))
const { root, profile } = probe
await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
await symlink(webAppDir, join(profile, 'node_modules/@deepseek-ai/dsh-web-app'))
await symlink(webDir, join(profile, 'node_modules/dsh-skill-mcp-panel'))
const packagePath = join(profile, 'package.json')
const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
Object.assign(pkg.dependencies, {
  '@deepseek-ai/dsh-web-app': `link:${webAppDir}`,
  'dsh-skill-mcp-panel': `link:${webDir}`,
})
// Both panel bundles use entry id "skill-mcp-panel". Keep the actual web
// bundle, then insert our plugin with a distinct loader id below.
pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-harness-tui/dsh-tui', 'dsh-skill-mcp-panel']
await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n')
const startup = join(root, 'web-startup.mjs')
await writeFile(startup, `import fs from 'node:fs'
export const name = 'interop-web-startup'
export function apply(ctx) {
  ctx.provide('webStartup', { host:'127.0.0.1', port:0, openBrowser:false, trustedHosts:[] })
  ctx.inject(['webServer', 'connection'], c => {
    const origin = c.get('webServer').getOrigin()
    fs.writeFileSync(${JSON.stringify(join(root, 'web-origin.txt'))}, origin)
    fs.writeFileSync(${JSON.stringify(join(root, 'web-auth-url.txt'))}, c.get('connection').authenticatedUrl(origin), { mode:0o600 })
  })
}
`)
const patchPath = join(profile, 'cordis.patch.yml')
await writeFile(patchPath, await readFile(patchPath, 'utf8') + `
# Test-only startup avoids competing web/TUI command-line parsers.
- id: web-startup
  disabled: true
- insert:
    - id: interop-web-startup
      name: ${JSON.stringify(startup)}
    - id: tui-panel-interop
      name: dsh-tui-skill-mcp-panel
`)
const skillDir = join(root, 'dsh/skills/interop-skill')
await mkdir(skillDir, { recursive: true })
await writeFile(join(skillDir, 'SKILL.md'), '---\nname: interop-skill\ndescription: Isolated global interop skill\n---\nINTEROP-BODY\n')
await writeFile(join(root, 'web-interop-probe.json'), JSON.stringify({ ...probe, webDir, webAppDir }, null, 2) + '\n')
console.log(JSON.stringify({ ...probe, webDir, webAppDir, browserLinkFile:join(root, 'web-auth-url.txt') }, null, 2))
