/** Isolated PTY experiment: Node's cached raw flag versus actual termios state. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root=await mkdtemp(join(tmpdir(),'tty-raw-cache-'))
const child=join(root,'child.mjs'),resultPath=join(root,'result.json')
await writeFile(child, `import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
const input=process.stdin
if(!input.isTTY)throw Error('child requires its isolated PTY')
const python="import termios,json; a=termios.tcgetattr(0); print(json.dumps({'canonical':bool(a[3]&termios.ICANON),'echo':bool(a[3]&termios.ECHO)}))"
const state=()=>({...JSON.parse(execFileSync('python3',['-c',python],{stdio:[0,'pipe','pipe'],encoding:'utf8'})),cachedRaw:input.isRaw})
input.setRawMode(true)
const initial=state()
execFileSync('python3',['-c','import termios; a=termios.tcgetattr(0); a[3]|=termios.ICANON|termios.ECHO; termios.tcsetattr(0,termios.TCSANOW,a)'],{stdio:[0,'pipe','pipe']})
const externallyReset=state()
input.setRawMode(true)
const repeatedTrue=state()
input.setRawMode(false); input.setRawMode(true)
const forcedTransition=state()
fs.writeFileSync(process.argv[2],JSON.stringify({node:process.version,libuv:process.versions.uv,initial,externallyReset,repeatedTrue,forcedTransition}))
input.setRawMode(false)
`)
const controller=`import os,pty,subprocess,sys,select,time,json
master,slave=pty.openpty()
env=os.environ.copy()
for key in ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','TUI_TRACE_LOG']:env.pop(key,None)
proc=subprocess.Popen([sys.argv[1],sys.argv[2],sys.argv[3]],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
os.close(slave)
deadline=time.monotonic()+15
output=b''
try:
 while proc.poll() is None and time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.2)
  if ready:
   try:output+=os.read(master,8192)
   except OSError:break
 if proc.poll() is None and time.monotonic()>=deadline:proc.kill()
 code=proc.wait(timeout=3)
 if code:raise RuntimeError('PTY child failed: '+output.decode(errors='replace'))
finally:
 if proc.poll() is None:proc.kill();proc.wait()
 os.close(master)
`
try {
  execFileSync('python3',['-c',controller,process.execPath,child,resultPath],{encoding:'utf8',timeout:20_000})
  const result=JSON.parse(await readFile(resultPath,'utf8'))
  assert.equal(result.initial.canonical,false)
  assert.equal(result.externallyReset.canonical,true)
  assert.equal(result.externallyReset.cachedRaw,true)
  assert.equal(result.forcedTransition.canonical,false)
  assert.equal(result.forcedTransition.echo,false)
  console.log(JSON.stringify({...result,repeatedTrueRecovered:!result.repeatedTrue.canonical,
    scope:'isolated Node/libuv recovery behavior; does not identify who reset the previous DSH terminal'},null,2))
} finally { await rm(root,{recursive:true,force:true}) }
