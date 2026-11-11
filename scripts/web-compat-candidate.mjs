/** Test-only upstream proposal. Never patch the installed source package. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, lstat, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'web 2.3.7 source does not match the reviewed patch')
  return text.replace(before, after)
}

export function candidateSources({ client, editor }) {
  client = replaceOnce(client,
    'setEnabledMcp: (serverName, enabled, entryId) => callMcp("setEnabled", { serverName, enabled, entryId }),',
    `setEnabledMcp: async (serverName, enabled, entryId) => {
                    const result = await callMcp("setEnabled", { serverName, enabled, entryId });
                    if (result?.server === null || typeof result?.server?.serverName !== "string")
                        throw new Error("mcpManager.setEnabled returned an invalid server");
                    return result.server;
                },`)
  return { client, editor:flowEditorCandidate(editor) }
}

export function flowEditorCandidate(editor) {
  return replaceOnce(editor,
    `function nodeContentEndOf(node) {
    if (node === null || typeof node !== "object")
        return undefined;`,
    `function nodeContentEndOf(node) {
    if (node === null || typeof node !== "object")
        return undefined;
    // Flow collections include closing delimiters before range[1]. Comments
    // after the collection belong to range[2] and must remain outside the edit.
    if ((isSeq(node) || isMap(node)) && node.flow && typeof node.range?.[1] === "number")
        return node.range[1];`)
}

export async function prepareWebCandidate(hostDir, installedWebDir) {
  const source = await realpath(installedWebDir)
  assert.equal(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version, '2.3.7')
  const base = join(dirname(fileURLToPath(import.meta.url)), 'prepare-web-interop-probe.mjs')
  const probe = JSON.parse(execFileSync(process.execPath, [base, hostDir, source], { encoding:'utf8' }))
  const candidate = join(probe.root, 'web-candidate')
  await cp(source, candidate, { recursive:true, dereference:false, filter:path => path !== join(source, 'node_modules') })
  for (const path of [candidate, join(candidate, 'lib'), join(candidate, 'lib/client.js'), join(candidate, 'lib/patch-editor.js')]) {
    assert(!(await lstat(path)).isSymbolicLink(), 'candidate files must not alias installed sources')
  }
  await symlink(dirname(source), join(candidate, 'node_modules'))
  const names = { client:'lib/client.js', editor:'lib/patch-editor.js' }
  const original = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key,path]) => [key, await readFile(join(source,path),'utf8')])))
  const patched = candidateSources(original)
  for (const [key,path] of Object.entries(names)) await writeFile(join(candidate,path),patched[key])
  const link = join(probe.profile, 'node_modules/dsh-skill-mcp-panel')
  assert((await lstat(link)).isSymbolicLink())
  assert.equal(await realpath(link),source)
  await rm(link)
  await symlink(candidate,link)
  const pkgPath=join(probe.profile,'package.json'),pkg=JSON.parse(await readFile(pkgPath,'utf8'))
  pkg.dependencies['dsh-skill-mcp-panel']=`link:${candidate}`
  await writeFile(pkgPath,JSON.stringify(pkg,null,2)+'\n')
  const hashes=Object.fromEntries(Object.entries(original).map(([key,text])=>[key,createHash('sha256').update(text).digest('hex')]))
  const result={...probe,installedWebDir:source,candidate,installedSourceSha256:hashes,changes:['unwrap setEnabled result.server','include flow delimiters in edit spans'],scope:'isolated upstream candidate, not an installed update or release'}
  await writeFile(join(probe.root,'web-candidate.json'),JSON.stringify(result,null,2)+'\n')
  return result
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert(process.argv[2] && process.argv[3],'usage: node scripts/web-compat-candidate.mjs <CLI-installed host> <installed web 2.3.7>')
  console.log(JSON.stringify(await prepareWebCandidate(resolve(process.argv[2]),resolve(process.argv[3])),null,2))
}
