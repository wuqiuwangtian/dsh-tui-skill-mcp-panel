/** Rehearse a proposed change exclusively in a new disposable profile tree. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

assert(process.argv[2], 'usage: node scripts/rehearse-compat-rollout.mjs <review-plan.json>')
const plan = JSON.parse(await readFile(process.argv[2], 'utf8'))
assert.equal(plan.schema, 1, 'unsupported review plan schema')
const root = await realpath(plan.root), temporary = await realpath(tmpdir())
const inside = (base, path) => { const rel = relative(base, path); return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }
assert(inside(temporary, root) && basename(root).startsWith('panel-compat-rollout-'), 'only a prepared temporary review root is accepted')
assert.deepEqual(plan.files.map(item => item.relative).sort(), ['lib/client.js', 'lib/patch-editor.js'], 'only the two reviewed web file paths are supported')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
for (const path of [plan.vendorPayload, join(plan.vendorPayload, 'lib/index.js'), join(plan.vendorPayload, 'lib/panel-stderr-candidate.mjs'), ...plan.files.flatMap(item => [item.original, item.payload])]) assert(inside(root, await realpath(path)), 'payload must not alias installed sources')
assert.equal(sha(await readFile(join(plan.vendorPayload, 'lib/index.js'))), plan.payloadHashes.mcp, 'MCP payload changed')
assert.equal(sha(await readFile(join(plan.vendorPayload, 'lib/panel-stderr-candidate.mjs'))), plan.payloadHashes.stderrHelper, 'stderr helper payload changed')
const sandbox = await mkdtemp(join(root, 'rehearsal-')), profiles = join(sandbox, 'profiles')
const exists = async path => { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const sandboxOnly = async path => { assert(inside(sandbox, path), 'rehearsal cannot write real targets'); assert(inside(sandbox, await realpath(dirname(path))), 'rehearsal parent escapes sandbox') }
const atomic = async (path, bytes, mode) => {
  await sandboxOnly(path)
  const temp = path + '.rehearsal-new'
  try { await writeFile(temp, bytes, { flag: 'wx', mode }); await chmod(temp, mode); await rename(temp, path) } finally { await rm(temp, { force: true }) }
}
const fallback = join(profiles, 'node_modules/@deepseek-ai/dsh-mcp-client')
await mkdir(dirname(fallback), { recursive: true }); await symlink(plan.sourceMcp, fallback)
const links = []
for (const name of ['dsh-tui', 'web', 'control']) {
  const profile = join(profiles, name)
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true }); await writeFile(join(profile, 'package.json'), '{"private":true}\n')
  if (name !== 'control') links.push(join(profile, 'node_modules/@deepseek-ai/dsh-mcp-client'))
}
const files = []
for (const item of plan.files) {
  const path = join(profiles, 'web/node_modules/dsh-skill-mcp-panel', item.relative)
  await mkdir(dirname(path), { recursive: true }); await copyFile(item.original, path); await chmod(path, item.mode)
  files.push({ ...item, sandboxTarget: path })
}
// Each verification models a restarted process; Node caches prior resolutions.
const resolveMcp = name => execFileSync(process.execPath, ['--input-type=module', '-e', "import {createRequire} from 'node:module';process.stdout.write(createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-mcp-client'))", join(profiles, name, 'package.json')], { encoding: 'utf8' })
const originalEntry = join(plan.sourceMcp, 'lib/index.js'), patchedEntry = join(plan.vendorPayload, 'lib/index.js')
const assertOriginal = async () => {
  for (const item of files) { assert.equal(sha(await readFile(item.sandboxTarget)), item.beforeSha256); assert.equal((await lstat(item.sandboxTarget)).mode & 0o777, item.mode) }
  for (const link of links) assert.equal(await exists(link), false)
  for (const name of ['dsh-tui', 'web', 'control']) assert.equal(resolveMcp(name), originalEntry)
}
const preflight = async () => {
  for (const item of files) {
    await sandboxOnly(item.sandboxTarget); assert(!(await lstat(item.sandboxTarget)).isSymbolicLink())
    assert.equal(sha(await readFile(item.sandboxTarget)), item.beforeSha256, 'source drift; stop before writing')
    assert.equal(sha(await readFile(item.original)), item.beforeSha256, 'backup changed')
    assert.equal(sha(await readFile(item.payload)), item.afterSha256, 'payload changed')
  }
  for (const link of links) { await sandboxOnly(link); assert.equal(await exists(link), false, 'existing override; stop before writing') }
}
const apply = async failAfter => {
  await preflight()
  const completed = []
  try {
    for (const link of links) { await symlink(plan.vendorPayload, link); completed.push({ link }); if (completed.length === failAfter) throw Error('injected apply failure') }
    for (const item of files) { await atomic(item.sandboxTarget, await readFile(item.payload), item.mode); completed.push({ item }); if (completed.length === failAfter) throw Error('injected apply failure') }
    return completed
  } catch (error) { await restore(completed); throw error }
}
const restore = async completed => {
  // Validate the entire rollback set before replacing any changed user data.
  for (const { link, item } of completed) {
    if (link) assert.equal(await readlink(link), plan.vendorPayload, 'override changed; refuse rollback')
    else {
      assert.equal(sha(await readFile(item.sandboxTarget)), item.afterSha256, 'file changed; refuse rollback')
      assert.equal(sha(await readFile(item.original)), item.beforeSha256, 'backup changed; refuse rollback')
    }
  }
  for (const { link, item } of [...completed].reverse()) {
    if (link) { await sandboxOnly(link); await rm(link) }
    else await atomic(item.sandboxTarget, await readFile(item.original), item.mode)
  }
}
try {
  await assertOriginal()
  const completed = await apply()
  for (const name of ['dsh-tui', 'web']) assert.equal(resolveMcp(name), patchedEntry)
  assert.equal(resolveMcp('control'), originalEntry)
  for (const item of files) assert.equal(sha(await readFile(item.sandboxTarget)), item.afterSha256)
  await restore(completed); await assertOriginal()
  // Inject a failure after both links and the first file were changed.
  await assert.rejects(apply(3), /injected apply failure/); await assertOriginal()
  await atomic(files[1].sandboxTarget, Buffer.from('external edit'), files[1].mode)
  await assert.rejects(apply(), /source drift/)
  assert.equal(await exists(links[0]), false); assert.equal(sha(await readFile(files[0].sandboxTarget)), files[0].beforeSha256)
  await atomic(files[1].sandboxTarget, await readFile(files[1].original), files[1].mode)
  const again = await apply()
  await atomic(files[0].sandboxTarget, Buffer.from('post-apply external edit'), files[0].mode)
  await assert.rejects(restore(again), /refuse rollback/)
  assert.equal(await readlink(links[0]), plan.vendorPayload)
  assert.equal(sha(await readFile(files[1].sandboxTarget)), files[1].afterSha256)
  await atomic(files[0].sandboxTarget, await readFile(files[0].payload), files[0].mode)
  await restore(again); await assertOriginal()
  await symlink(plan.sourceMcp, links[1])
  await assert.rejects(apply(), /existing override/); assert.equal(await exists(links[0]), false); await rm(links[1])
  await assertOriginal()
  const final = await apply(), backup = await readFile(files[0].original)
  try {
    await writeFile(files[0].original, 'corrupted rehearsal backup')
    await assert.rejects(restore(final), /backup changed/)
    assert.equal(await readlink(links[0]), plan.vendorPayload)
    assert.equal(sha(await readFile(files[1].sandboxTarget)), files[1].afterSha256)
  } finally { await writeFile(files[0].original, backup) }
  await restore(final); await assertOriginal()
  const result = { successApplyRestore: true, twoProfilesResolveOverride: true, controlProfileUnchanged: true, partialFailureRestored: true, sourceDriftRejectedBeforeWrites: true, rollbackConflictRejectedBeforeWrites: true, existingOverrideRejectedBeforeWrites: true, corruptedBackupRejectedBeforeWrites: true, bytesAndModesRestored: true, realEnvironmentChanged: false, limit: 'filesystem and Node resolution rehearsal; not actual DSH loader or package-manager installation' }
  await writeFile(join(root, 'rehearsal-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await rm(sandbox, { recursive: true, force: true }) }
