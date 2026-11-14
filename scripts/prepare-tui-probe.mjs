/** Prepare an isolated real-DSH/TTY probe; never start it or touch normal prefs. */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[3] ?? '--mode=fullscreen'
if (!['--mode=fullscreen', '--mode=inline'].includes(mode)) throw new Error('Usage: prepare-tui-probe.mjs <installed-host-directory> [--mode=fullscreen|--mode=inline]')
const fullscreen = mode === '--mode=fullscreen'
const require = createRequire(import.meta.url)
// Pass the actual CLI-installed host to reuse its kernel peer links.
// The development peer dependency is sufficient only for headless rendering.
const hostDir = process.argv[2] === undefined
  ? dirname(require.resolve('@deepseek-harness-tui/dsh-tui/package.json'))
  : resolve(process.argv[2])
const cli = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const root = await mkdtemp(join(tmpdir(), 'skill-mcp-real-tui-'))
const profile = join(root, 'dsh', 'profiles', 'panel-verification')
const project = join(root, 'project')
const userDir = join(root, 'user')
await mkdir(join(profile, 'node_modules', '@deepseek-harness-tui'), { recursive: true })
await mkdir(join(project, '.dsh', 'skills', 'probe-skill'), { recursive: true })
await mkdir(join(userDir, '.dsh-tui'), { recursive: true })
await symlink(hostDir, join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'))
await symlink(repo, join(profile, 'node_modules', 'dsh-tui-skill-mcp-panel'))
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-panel-verification', private: true,
  dependencies: { '@deepseek-harness-tui/dsh-tui': '0.19.0', 'dsh-tui-skill-mcp-panel': `link:${repo}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui', 'dsh-tui-skill-mcp-panel'] } },
}, null, 2))
const row = (id, disabled) => `- insert:\n    - id: ${id}\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: ${disabled}\n      config:\n        serverName: ${id}\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(join(repo, 'test', 'fixtures', 'mcp-stdio-server.mjs'))}]\n        env:\n          PANEL_TEST_TOKEN: !!js '"fixture-token-not-a-secret"'\n`
await writeFile(join(profile, 'cordis.patch.yml'), `# Isolated real-TUI fixture\n- id: dsh-tui\n  config:\n    backend: dsh\n    fullscreen: ${fullscreen}\n    lang: zh\n${row('mcp-probe', 'true')}${row('mcp-expr', '!!js true')}`)
await writeFile(join(root, 'dsh', 'cordis.patch.yml'), row('mcp-home', 'true'))
await writeFile(join(project, '.dsh', 'skills', 'probe-skill', 'SKILL.md'), '---\nname: probe-skill\ndescription: Isolated real-TUI verification skill\n---\nLocal verification fixture.\n')
execFileSync('git', ['init', '-q', project])
await writeFile(join(userDir, '.dsh-tui', 'onboarding.json'), '{"completed":true,"version":1}\n')
// Seed the isolated host preference too: persisted values override the patch.
await writeFile(join(userDir, '.dsh-tui', 'settings.json'), JSON.stringify({ version: 1, values: { fullscreen } }, null, 2) + '\n')
// Host 0.19 clears pre-migration inline preferences once. Model a deliberate
// post-migration choice in this owned test home; never change real preferences.
await writeFile(join(userDir, '.dsh-tui', 'migrations.json'), JSON.stringify({ 'fullscreen-factory-default': new Date().toISOString() }, null, 2) + '\n')
// dsh-tui 0.19 ignores DSH_TUI_HOME. Redirect only this Node process's os.homedir,
// without changing HOME or any real host preference. The actual CLI/UI still run.
await writeFile(join(root, 'test-home.mjs'), `import os from 'node:os'\nimport { syncBuiltinESMExports } from 'node:module'\nos.homedir = () => ${JSON.stringify(userDir)}\nsyncBuiltinESMExports()\n`)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const variables = {
  DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'),
  SKILL_MCP_PANEL_HOME: join(root, 'panel'), SKILL_MCP_PANEL_DUMP: join(root, 'dump.json'),
  SKILL_MCP_PANEL_RENDER_DUMP: join(root, 'render.txt'), TERM: 'xterm-256color',
}
const launcher = join(root, 'run.sh')
await writeFile(launcher, `#!/bin/sh\nset -eu\nunset DSH_PROFILE DSH_PROFILE_DIR DSH_SESSION_ID DSH_BUNDLED_SKILL_DIR DSH_TUI_BACKEND_HANDOFF DSH_TUI_HOST_ENTRY_PATH\ncd ${quote(project)}\n${Object.entries(variables).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')}\nexec ${quote(process.execPath)} --import ${quote(join(root, 'test-home.mjs'))} ${quote(cli)} --profile panel-verification "$@"\n`)
await chmod(launcher, 0o700)
console.log(JSON.stringify({ root, launcher, profile, project, hostDir, mode: fullscreen ? 'fullscreen' : 'inline' }, null, 2))
