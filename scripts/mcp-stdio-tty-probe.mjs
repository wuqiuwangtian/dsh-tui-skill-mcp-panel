/** Real kernel MCP SDK + fixture in separate PTYs: startup order and stderr. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'

const cli=await realpath(execFileSync('which',['dsh'],{encoding:'utf8'}).trim()),req=createRequire(cli)
const modules=Object.fromEntries(['@modelcontextprotocol/client','@modelcontextprotocol/client/stdio','@deepseek-ai/dsh-subprocess'].map(name=>[name,pathToFileURL(req.resolve(name)).href]))
const root=await mkdtemp(join(tmpdir(),'mcp-stdio-tty-')),child=join(root,'child.mjs')
const fixture=join(dirname(fileURLToPath(import.meta.url)),'../test/fixtures/mcp-stdio-server.mjs')
await writeFile(child,`import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {Client} from ${JSON.stringify(modules['@modelcontextprotocol/client'])}
import {StdioClientTransport} from ${JSON.stringify(modules['@modelcontextprotocol/client/stdio'])}
import {scrubbedParentEnv} from ${JSON.stringify(modules['@deepseek-ai/dsh-subprocess'])}
const [scenario,destination]=process.argv.slice(2),input=process.stdin
const query="import termios,json; a=termios.tcgetattr(0); print(json.dumps({'canonical':bool(a[3]&termios.ICANON),'echo':bool(a[3]&termios.ECHO)}))"
const state=()=>({...JSON.parse(execFileSync('python3',['-c',query],{stdio:[0,'pipe','pipe'],encoding:'utf8'})),cachedRaw:input.isRaw??false})
const initial=state()
if(scenario==='warm-inherit')input.setRawMode(true)
const transport=new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(fixture)}],env:{...scrubbedParentEnv(),TERM:'xterm-256color'},...(scenario==='cold-pipe'?{stderr:'pipe'}:{})})
let drainedBytes=0
transport.stderr?.on('data',chunk=>{drainedBytes+=chunk.length})
const client=new Client({name:'isolated-tty-parent',version:'1.0.0'})
try {
 await client.connect(transport)
 const tools=await client.listTools()
 input.setRawMode(true)
 const beforeClose=state()
 await client.close()
 const afterClose=state()
 fs.writeFileSync(destination,JSON.stringify({scenario,initial,beforeClose,afterClose,tools:tools.tools.map(t=>t.name),drainedBytes,node:process.version,libuv:process.versions.uv}))
} finally {await client.close().catch(()=>{});input.setRawMode(false)}
`)
const python=`import os,pty,select,subprocess,sys,time,signal
master,slave=pty.openpty()
env=os.environ.copy()
for key in ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','TUI_TRACE_LOG']:env.pop(key,None)
proc=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env=env)
os.close(slave)
deadline=time.monotonic()+20
output=b''
try:
 while proc.poll() is None and time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.1)
  if ready:
   try:output+=os.read(master,8192)
   except OSError:break
 if proc.poll() is None and time.monotonic()>=deadline:os.killpg(proc.pid,signal.SIGKILL)
 code=proc.wait(timeout=3)
 if code:raise RuntimeError('MCP PTY child failed: '+output.decode(errors='replace'))
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
 os.close(master)
`
try {
 const results=[]
 for(const scenario of ['cold-inherit','warm-inherit','cold-pipe']){
  const file=join(root,scenario+'.json')
  execFileSync('python3',['-c',python,process.execPath,child,scenario,file],{encoding:'utf8',timeout:25_000})
  const result=JSON.parse(await readFile(file,'utf8'))
  assert.deepEqual(result.tools,['ping']);assert.equal(result.beforeClose.canonical,false)
  assert.equal(result.beforeClose.echo,false)
  if(scenario!=='cold-inherit'){
   assert.equal(result.afterClose.canonical,false)
   assert.equal(result.afterClose.echo,false)
  }
  results.push(result)
 }
 console.log(JSON.stringify({results,scope:'real MCP protocol, three owned PTYs; pipe stderr is drained in this experiment, production logging policy is not implemented'},null,2))
} finally {await rm(root,{recursive:true,force:true})}
