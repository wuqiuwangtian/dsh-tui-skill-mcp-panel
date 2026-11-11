/** Compare a downloaded official web release, without installing into ~/.dsh. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flowEditorCandidate } from './web-compat-candidate.mjs'

const [hostArg,installedArg,releaseArg,variant]=process.argv.slice(2)
assert(hostArg&&installedArg&&releaseArg,'usage: node scripts/prepare-web-release-probe.mjs <CLI host> <installed web 2.3.7> <unpacked official web 2.3.12> [--flow-candidate]')
assert(variant===undefined||variant==='--flow-candidate','unsupported variant')
const source=await realpath(releaseArg),installed=await realpath(installedArg)
const manifest=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
assert.equal(manifest.name,'dsh-skill-mcp-panel');assert.equal(manifest.version,'2.3.12')
const prepare=join(dirname(fileURLToPath(import.meta.url)),'prepare-web-interop-probe.mjs')
const probe=JSON.parse(execFileSync(process.execPath,[prepare,resolve(hostArg),installed],{encoding:'utf8'}))
const cli=await realpath(execFileSync('which',['dsh'],{encoding:'utf8'}).trim())
const kernel=dirname(dirname(cli))
assert.equal(JSON.parse(await readFile(join(kernel,'package.json'),'utf8')).version,'0.2.2-rc.1')
const release=join(probe.root,'web-official-2.3.12')
await cp(source,release,{recursive:true,dereference:false,filter:path=>path!==join(source,'node_modules')})
for(const path of [release,join(release,'lib'),join(release,'lib/patch-editor.js')]){
  assert(!(await lstat(path)).isSymbolicLink(),'release files must not alias source files')
}
if(variant){
  const editorPath=join(release,'lib/patch-editor.js')
  await writeFile(editorPath,flowEditorCandidate(await readFile(editorPath,'utf8')))
}
const dependencies={}
for(const name of [...Object.keys(manifest.dependencies),...Object.keys(manifest.peerDependencies)]){
  const from=name==='@deepseek-ai/dsh'?kernel:name.startsWith('@deepseek-ai/')?join(kernel,'node_modules',name):join(dirname(installed),name)
  const resolved=await realpath(from),target=join(release,'node_modules',name)
  await mkdir(dirname(target),{recursive:true});await symlink(resolved,target)
  dependencies[name]=JSON.parse(await readFile(join(resolved,'package.json'),'utf8')).version
}
// All links and the copied package live in the newly prepared fixture.
await rm(join(probe.profile,'node_modules/dsh-skill-mcp-panel'))
await symlink(release,join(probe.profile,'node_modules/dsh-skill-mcp-panel'))
const pkgPath=join(probe.profile,'package.json'),pkg=JSON.parse(await readFile(pkgPath,'utf8'))
pkg.dependencies['dsh-skill-mcp-panel']=`link:${release}`
await writeFile(pkgPath,JSON.stringify(pkg,null,2)+'\n')
const result={...probe,release,version:manifest.version,variant:variant?'flow-only candidate':'official unmodified',dependencies,limits:'isolated copy; existing runtime dependencies linked read-only, not a fresh registry dependency install or real-profile update'}
await writeFile(join(probe.root,'web-release-probe.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
