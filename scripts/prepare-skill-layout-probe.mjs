/** Isolated real-CLI layout fixture: same-name sources, disabled member and long group tree. */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = JSON.parse(execFileSync(process.execPath,[join(repo,'scripts/prepare-tui-probe.mjs'),...process.argv.slice(2)],{encoding:'utf8'}))
const skills = join(probe.project,'.dsh/skills'), global = join(probe.root,'dsh/skills'), panel = join(probe.root,'panel')
const doc = name => `---\nname: ${name}\ndescription: Layout 中文🧭 fixture\n---\n${Array.from({length:100},(_,i)=>`BODY-${String(i).padStart(3,'0')} 中文🧭 fixture`).join('\n')}\n`
await mkdir(global,{recursive:true});await mkdir(panel)
const alpha = join(skills,'layout-alpha.md'), beta = join(skills,'layout-beta.md.disabled'), twin = join(global,'layout-alpha.md')
await writeFile(alpha,doc('layout-alpha'));await writeFile(beta,doc('layout-beta'));await writeFile(twin,doc('layout-alpha'))
const groups = Object.fromEntries(Array.from({length:60},(_,i)=>[`g${i}`,{name:`Group ${String(i).padStart(2,'0')}${i===59?' 中文🧭'.repeat(10):''}`,scopes:{[probe.project]:i===0?['layout-alpha']:i===1||i===59?['layout-beta']:[],global:[]}}]))
const groupPath = join(global,'.system/skill-viewer/groups.json'), configPath = join(panel,'config.json')
await mkdir(dirname(groupPath),{recursive:true});await writeFile(groupPath,JSON.stringify({version:1,sentinel:'preserve',groups},null,2)+'\n')
await writeFile(configPath,JSON.stringify({version:1,trashRetentionDays:7,lastTab:'skills',future:{keep:true}},null,2)+'\n',{mode:0o600})
console.log(JSON.stringify({...probe,alpha,beta,twin,groupPath,configPath},null,2))
