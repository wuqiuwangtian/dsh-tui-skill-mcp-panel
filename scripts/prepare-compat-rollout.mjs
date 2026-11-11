/** Prepare a review bundle and rehearse rollback. Never apply to real profiles. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateSources } from './web-compat-candidate.mjs'
import { STDERR_LIMITS } from './candidates/mcp-stderr.mjs'

const [webArg] = process.argv.slice(2)
assert(webArg, 'usage: node scripts/prepare-compat-rollout.mjs <installed web 2.3.7>')
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const web = await realpath(webArg), webManifest = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'))
assert.equal(webManifest.name, 'dsh-skill-mcp-panel'); assert.equal(webManifest.version, '2.3.7')
assert.equal(web, await realpath(join(homedir(), '.dsh/profiles/web/node_modules/dsh-skill-mcp-panel')), 'review targets only the installed web profile')
for (const path of [web, join(web, 'lib'), join(web, 'lib/client.js'), join(web, 'lib/patch-editor.js')]) assert(!(await lstat(path)).isSymbolicLink(), 'web backport requires regular installed files')
const cli = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const kernel = dirname(dirname(cli)), mcp = await realpath(join(kernel, 'node_modules/@deepseek-ai/dsh-mcp-client'))
assert.equal(JSON.parse(await readFile(join(mcp, 'package.json'), 'utf8')).version, '0.2.2-rc.1')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'panel-compat-rollout-')), payload = join(root, 'payload')
const source = { mcp: await readFile(join(mcp, 'lib/index.js')), client: await readFile(join(web, 'lib/client.js')), editor: await readFile(join(web, 'lib/patch-editor.js')) }
const baseline = JSON.parse(await readFile(join(repo, 'docs/research/evidence/m5-runtime-candidates.json'), 'utf8'))
assert.equal(sha(source.mcp), baseline.sourceSha256.mcp, 'installed MCP source changed; requalify candidate')
const previousWeb = JSON.parse(await readFile(join(repo, 'docs/research/evidence/m5-interop-root-causes.json'), 'utf8'))
for (const [key, file] of [['client', 'client.js'], ['editor', 'patch-editor.js']]) assert.equal(sha(source[key]), previousWeb.installedWebUnchangedSha256[file], 'installed web source changed; requalify candidate')
const patched = candidateSources({ client: source.client.toString(), editor: source.editor.toString() })
const vendor = join(payload, 'mcp-client')
await cp(mcp, vendor, { recursive: true, dereference: false, filter: path => path !== join(mcp, 'node_modules') })
for (const path of [vendor, join(vendor, 'lib'), join(vendor, 'lib/index.js')]) assert(!(await lstat(path)).isSymbolicLink(), 'payload must not alias installed code')
assert.equal(sha(await readFile(join(vendor, 'lib/index.js'))), sha(source.mcp), 'copied MCP source differs from the pinned original')
execFileSync('git', ['apply', '--check', join(repo, 'docs/research/evidence/dsh-mcp-client-0.2.2-rc.1-stderr.patch')], { cwd: vendor })
execFileSync('git', ['apply', join(repo, 'docs/research/evidence/dsh-mcp-client-0.2.2-rc.1-stderr.patch')], { cwd: vendor })
assert.equal(await readFile(join(vendor, 'lib/panel-stderr-candidate.mjs'), 'utf8'), await readFile(join(repo, 'scripts/candidates/mcp-stderr.mjs'), 'utf8'))
await symlink(join(kernel, 'node_modules'), join(vendor, 'node_modules'))
const files = []
for (const [key, relative] of [['client', 'lib/client.js'], ['editor', 'lib/patch-editor.js']]) {
  const before = join(root, 'original-web', relative), after = join(payload, 'web-2.3.7', relative)
  await mkdir(dirname(before), { recursive: true }); await mkdir(dirname(after), { recursive: true })
  await writeFile(before, source[key]); await writeFile(after, patched[key])
  files.push({ relative, target: join(web, relative), original: before, payload: after, beforeSha256: sha(source[key]), afterSha256: sha(patched[key]), mode: (await lstat(join(web, relative))).mode & 0o777 })
}
const payloadHashes = { mcp: sha(await readFile(join(vendor, 'lib/index.js'))), stderrHelper: sha(await readFile(join(vendor, 'lib/panel-stderr-candidate.mjs'))), ...Object.fromEntries(files.map(item => [item.relative, item.afterSha256])) }
const id = sha(JSON.stringify(payloadHashes)).slice(0, 16)
const proposedStore = join(homedir(), '.local/share/dsh-panel-compat', id)
await assert.rejects(lstat(proposedStore), { code: 'ENOENT' }, 'proposed store already exists; review before reuse')
const profiles = [], retained = []
const hostPackage = join(homedir(), '.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui')
assert.equal(JSON.parse(await readFile(join(hostPackage, 'package.json'), 'utf8')).version, '0.19.0')
for (const rel of ['package.json', 'lib/types/ink/components/App.js']) {
  const path = join(hostPackage, rel)
  retained.push({ path, sha256: sha(await readFile(path)) })
}
for (const name of ['dsh-tui', 'web']) {
  const profile = join(homedir(), '.dsh/profiles', name)
  // An enclosing scope symlink would silently widen the write boundary.
  for (const rel of ['node_modules', 'node_modules/@deepseek-ai']) {
    const location = join(profile, rel), stat = await lstat(location)
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'profile module parent must be a real directory')
    assert.equal(await realpath(location), location, 'profile module parent escapes its declared path')
  }
  const link = join(profile, 'node_modules/@deepseek-ai/dsh-mcp-client')
  await assert.rejects(lstat(link), { code: 'ENOENT' }, 'profile already has an MCP override; plan requires review')
  profiles.push({ name, target: link, before: 'absent', proposedLinkTarget: join(proposedStore, 'mcp-client') })
  for (const rel of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const path = join(profile, rel)
    try { retained.push({ path, sha256: sha(await readFile(path)) }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
const plan = {
  schema: 1, id, root, state: 'review only; not approved or applied', preparedFrom: '6ce43d8 candidates',
  strategy: 'profile-local MCP override plus two pinned web 2.3.7 backports; temporary proposal',
  versions: { node: process.version, kernel: '0.2.2-rc.1', web: '2.3.7', host: '0.19.0' },
  policy: { level: 'warn (proposed)', ...STDERR_LIMITS, redaction: 'exact known config.env values only', overflow: 'continue draining; suppress excess diagnostics' },
  sourceMcp: mcp, vendorPayload: vendor, proposedStore, payloadHashes, profiles, files, retained,
  unchanged: ['global CLI MCP package', 'host code', 'profile package.json and lockfiles', 'profile/home YAML', 'skills and groups', 'panel runtime'],
  preconditions: ['stop both affected processes before file operations', 'recheck every source hash and absent target immediately before applying', 'private verified backups before first replacement'],
  lifetime: 'package-manager maintenance may remove profile-local overrides or overwrite backports; requalify after every update',
}
await writeFile(join(root, 'review-plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 })
execFileSync(process.execPath, [join(repo, 'scripts/rehearse-compat-rollout.mjs'), join(root, 'review-plan.json')], { stdio: ['ignore', 'pipe', 'pipe'] })
for (const [key, path] of [['mcp', join(mcp, 'lib/index.js')], ['client', join(web, 'lib/client.js')], ['editor', join(web, 'lib/patch-editor.js')]]) assert.equal(sha(await readFile(path)), sha(source[key]), 'installed source changed during preparation')
for (const item of retained) assert.equal(sha(await readFile(item.path)), item.sha256, 'profile data changed during preparation')
for (const item of profiles) await assert.rejects(lstat(item.target), { code: 'ENOENT' }, 'profile override changed during preparation')
console.log(JSON.stringify({ root, plan: join(root, 'review-plan.json'), rehearsal: join(root, 'rehearsal-result.json'), id, realEnvironmentChanged: false, scope: plan.state }, null, 2))
