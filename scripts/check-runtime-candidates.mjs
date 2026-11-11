/** Actual candidate bridge/App methods in one owned PTY, plus bounded-log checks. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { drainMcpStderr, STDERR_LIMITS } from './candidates/mcp-stderr.mjs'

assert(process.argv[2], 'usage: node scripts/check-runtime-candidates.mjs <runtime-candidates.json>')
const probe = JSON.parse(await readFile(process.argv[2], 'utf8'))
const inside = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }
const probeRoot = await realpath(probe.root)
assert(inside(await realpath(tmpdir()), probeRoot) && basename(probeRoot).startsWith('skill-mcp-real-tui-'), 'check requires an isolated prepared temporary root')
for (const kind of ['mcp', 'host']) {
  assert(inside(probeRoot, await realpath(probe.copies[kind])), 'candidate must live inside the isolated root')
  assert(inside(probeRoot, await realpath(join(probe.copies[kind], probe.files[kind]))), 'candidate entry must not alias installed source')
}
const report = [], stream = new PassThrough()
const finish = drainMcpStderr(stream, line => report.push(line), ['secret-fixture-value'])
stream.write(Buffer.from('start secret-fixture-')); stream.write(Buffer.from('value\n\x1b[31mred\x1b[0m\n'))
const unicode = Buffer.from('中文\n'); stream.write(unicode.subarray(0, 2)); stream.write(unicode.subarray(2))
stream.write(Buffer.from('x'.repeat(2 * 1024 * 1024) + '\n'))
stream.write(Buffer.from('small\n'.repeat(10000)))
stream.write(Buffer.from('tail-without-newline')); finish(); finish()
assert.equal(report[0], 'start [redacted]'); assert.equal(report[1], 'red'); assert.equal(report[2], '中文')
assert(report.includes('[stderr line exceeds limit]'))
assert(report.at(-1).includes('suppressed'))
assert(report.length <= STDERR_LIMITS.lines + 1)
assert(Buffer.byteLength(report.slice(0, -1).join('')) <= STDERR_LIMITS.logBytes)
assert.equal(stream.listenerCount('data'), 0); assert(stream.destroyed)
const tail = [], partial = new PassThrough(); const closePartial = drainMcpStderr(partial, line => tail.push(line))
partial.write('startup failure without newline'); closePartial(); assert.deepEqual(tail, ['startup failure without newline'])
const broken = new PassThrough(); const closeBroken = drainMcpStderr(broken, () => { throw Error('logger unavailable') })
broken.write('still drained\n'); closeBroken()

const root = await mkdtemp(join(tmpdir(), 'runtime-candidate-check-'))
const instrumented = join(probe.copies.mcp, 'lib/tty-probe-exports.mjs')
await writeFile(instrumented, await readFile(join(probe.copies.mcp, probe.files.mcp), 'utf8') + '\nexport { createTransport, startConnection };\n', { flag: 'wx' })
const fixture = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/mcp-stdio-server.mjs'), 'utf8')
const fixturePath = join(root, 'diagnostic-fixture.mjs')
await writeFile(fixturePath, `await new Promise(resolve => process.stderr.write('startup '+process.env.PANEL_TEST_TOKEN+'\\n'+'x'.repeat(2*1024*1024)+'\\n',resolve))\n` + fixture.replace("result = { content: [{ type: 'text', text: 'panel-local-fixture OK' }] }", "result = { content: [{ type: 'text', text: 'panel-local-fixture OK' }] }; setTimeout(() => process.exit(0), 80).unref()"))
const child = join(root, 'child.mjs'), resultPath = join(root, 'result.json')
await writeFile(child, `import assert from 'node:assert/strict'
import fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {createTransport,startConnection} from ${JSON.stringify(pathToFileURL(instrumented).href)}
import App from ${JSON.stringify(pathToFileURL(join(probe.copies.host, probe.files.host)).href)}
const mode=()=>{const code="import termios,json;a=termios.tcgetattr(0);print(json.dumps({'canonical':bool(a[3]&termios.ICANON),'echo':bool(a[3]&termios.ECHO)}))";return JSON.parse(execFileSync('python3',['-c',code],{stdio:[0,'pipe','pipe'],encoding:'utf8'}))}
const logs=[],tools=new Map(),ctx={logger:Object.fromEntries(['info','warn','error'].map(level=>[level,text=>logs.push({level,text})])),tools:{register(definition){assert(!tools.has(definition.name));tools.set(definition.name,definition);return()=>tools.delete(definition.name)}}}
const config={serverName:'tty-test',transport:'stdio',command:process.execPath,args:[${JSON.stringify(fixturePath)}],env:{PANEL_TEST_TOKEN:'secret-fixture-value'},toolCallTimeoutMs:5000,maxInstructionBytes:32768}
const policy={enabled:true,initialDelayMs:10,maxDelayMs:30,maxAttempts:3}
const wait=async(test)=>{const deadline=Date.now()+8000;while(!test()){assert(Date.now()<deadline,'reconnect timeout');await new Promise(resolve=>setTimeout(resolve,20))}}
const results=[]
try{
 assert.equal(mode().canonical,true)
 for(let cycle=0;cycle<3;cycle++){
  const connection=startConnection(ctx,config,policy)
  try{
   const ready=await connection.ready;assert(!ready.error,String(ready.error));assert.equal(tools.size,1)
   process.stdin.setRawMode(true)
   const original=tools.values().next().value
   await original.execute({}, {signal:new AbortController().signal})
   await wait(()=>tools.size===1&&tools.values().next().value!==original)
   assert.equal(mode().canonical,false)
  }finally{await connection.dispose()}
  assert.equal(tools.size,0);assert.deepEqual(mode(),{canonical:false,echo:false})
  results.push({cycle,autoReconnect:true,afterDispose:mode()})
 }
 assert(logs.some(x=>x.text.includes('startup [redacted]')))
 assert(!logs.some(x=>x.text.includes('secret-fixture-value')))
 assert(logs.some(x=>x.text.includes('line exceeds limit')))
 const failure=startConnection(ctx,{...config,args:['--input-type=module','-e',"process.stderr.write('early startup error without newline');process.exit(7)"]},{...policy,enabled:false})
 await failure.ready;await failure.dispose();assert(logs.some(x=>x.text.includes('early startup error without newline')))
 assert.equal(tools.size,0)
 const http=createTransport({transport:'streamable-http',url:'http://127.0.0.1:1/mcp',headers:{}},()=>{})
 assert.equal(http.constructor.name,'StreamableHTTPClientTransport')
 const app=new App({stdin:process.stdin,stdout:process.stdout,ownsStdin:()=>true})
 app.rawModeEnabledCount=1
 execFileSync('python3',['-c','import termios;a=termios.tcgetattr(0);a[3]|=termios.ICANON|termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,a)'],{stdio:[0,'pipe','pipe']})
 assert.equal(mode().canonical,true);assert.equal(process.stdin.isRaw,true)
 app.reassertRawMode();assert.deepEqual(mode(),{canonical:false,echo:false})
 const guards=[]
 for(const key of ['not-owner','shutdown','zero-count','not-tty']){
  const calls=[],input={isTTY:key!=='not-tty',setRawMode:value=>calls.push(value)}
  const instance=new App({stdin:input,stdout:process.stdout,ownsStdin:()=>key!=='not-owner'})
  instance.rawModeEnabledCount=key==='zero-count'?0:1;instance.shutdownDetached=key==='shutdown'
  instance.reassertRawMode();assert.deepEqual(calls,[]);guards.push(key)
 }
 process.stdin.setRawMode(false);assert.equal(mode().canonical,true)
 fs.writeFileSync(process.argv[2],JSON.stringify({cycles:results,logEvents:logs.length,knownSecretRedacted:true,earlyStartupError:true,httpUnchanged:true,hostExternalResetRecovered:true,ownershipGuards:guards,normalExitMode:mode()}))
}finally{process.stdin.setRawMode(false)}
`)
const controller = `import os,pty,subprocess,select,signal,time,sys
master,slave=pty.openpty()
env=os.environ.copy()
for key in ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','TUI_TRACE_LOG']:env.pop(key,None)
proc=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env=env)
os.close(slave)
output=b'';deadline=time.monotonic()+45
try:
 while proc.poll() is None and time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.1)
  if ready:
   try:output=(output+os.read(master,8192))[-32768:]
   except OSError:break
 if proc.poll() is None and time.monotonic()>=deadline:os.killpg(proc.pid,signal.SIGKILL)
 code=proc.wait(timeout=3)
 if code:raise RuntimeError('candidate probe failed: '+output.decode(errors='replace'))
finally:
 if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
 os.close(master)
`
try {
  execFileSync('python3', ['-c', controller, process.execPath, child, resultPath], { timeout: 50000 })
  console.log(JSON.stringify({ boundedDiagnostics: { passed: true, ...STDERR_LIMITS, emittedEvents: report.length }, runtime: JSON.parse(await readFile(resultPath, 'utf8')), scope: 'actual candidate methods; synthetic registry/logger in owned PTY; full host UI checked separately' }, null, 2))
} finally { await rm(root, { recursive: true, force: true }); await rm(instrumented, { force: true }) }
