/** Actual installed/candidate web text editors; no user configuration writes. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePatchText } from '../lib/types/domain/mcp/patch.js'

assert(process.argv[2]&&process.argv[3],'usage: node scripts/check-web-compat-candidate.mjs <web 2.3.7 or 2.3.12 source> <isolated same-version candidate>')
const installed=resolve(process.argv[2]),candidate=resolve(process.argv[3])
const version=JSON.parse(await readFile(join(installed,'package.json'),'utf8')).version
assert(['2.3.7','2.3.12'].includes(version))
assert.equal(JSON.parse(await readFile(join(candidate,'package.json'),'utf8')).version,version)
const original=await import(pathToFileURL(join(installed,'lib/patch-editor.js')).href)
const patched=await import(pathToFileURL(join(candidate,'lib/patch-editor.js')).href)
const sentinel='# next entry comment must survive\n- id: other\n  config: { keep: [1, 2] }\n'
const configs=[
  {kind:'stdio-flow',text:`        {\n          serverName: alpha,\n          transport: stdio,\n          command: node,\n          env: { TOKEN: !!js 'process.env.TOKEN' },\n          args: [\n            fixture.mjs\n          ]\n        }\n`},
  {kind:'http-nested-flow',text:`        {\n          serverName: alpha,\n          transport: streamable-http,\n          url: 'https://example.invalid/mcp',\n          headers: {\n            Authorization: !!js 'process.env.TOKEN'\n          }\n        }\n`},
  {kind:'ordinary-block',text:`        serverName: alpha\n        transport: stdio\n        command: node\n        args: [fixture.mjs]\n        future:\n          expression: !!js 'process.env.FUTURE'\n`},
]
const observations=[]
let reproduced=0
for(const config of configs)for(const crlf of [false,true]){
  let text=`# keep header\n- insert:\n    - id: mcp-alpha\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n${config.text}${sentinel}`
  if(crlf)text=text.replaceAll('\n','\r\n')
  const eol=crlf?'\r\n':'\n',tail=sentinel.replaceAll('\n',eol)
  const locator={id:'mcp-alpha',serverName:'alpha'},row=patched.listMcpPatchRows(text)[0]
  const oldOff=original.setEntryDisabledInText(text,locator,true)
  if(config.kind.includes('flow')){assert.equal(parsePatchText(oldOff).ok,false);reproduced++}
  const off=patched.setEntryDisabledInText(text,locator,true)
  assert(parsePatchText(off).ok)
  assert.equal(patched.listMcpPatchRows(off)[0].disabled,true)
  assert(off.endsWith(tail))
  const on=patched.setEntryDisabledInText(off,locator,false)
  assert.equal(on,text,'toggle restores source including flow delimiters and comments')
  const edited=patched.replaceMcpEntryWithRowInText(text,locator,{...row,config:{...row.config,futureAdded:true}})
  assert(parsePatchText(edited).ok);assert(edited.endsWith(tail))
  const editedConfig=patched.listMcpPatchRows(edited)[0].config
  for(const key of ['env','headers','future'])assert.deepEqual(editedConfig[key],row.config[key])
  assert.equal(editedConfig.futureAdded,true)
  const removed=patched.removeMcpEntryInText(text,locator)
  assert(parsePatchText(removed).ok);assert(removed.endsWith(tail));assert.equal(patched.listMcpPatchRows(removed).length,0)
  observations.push({kind:config.kind,eol:crlf?'CRLF':'LF',toggle:'pass',edit:'pass',delete:'pass',unrelatedBytes:'preserved',expressions:'preserved'})
}
console.log(JSON.stringify({installedVersion:version,baselineFlowFailures:reproduced,cases:observations,
  scope:'actual web editor modules; full browser contract checked separately'},null,2))
