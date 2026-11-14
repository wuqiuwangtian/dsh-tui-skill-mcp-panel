/** Local performance observation, not a portable CI gate or physical-SSD certification. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createManagerScene } from '../lib/types/ui/ManagerScene.js'
import { ManagerRuntime } from '../lib/types/host/manager-runtime.js'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const reportPath = process.argv[2] === undefined ? undefined : resolve(process.argv[2])
const cache = join(repo, 'node_modules/.cache')
await fs.mkdir(cache, { recursive: true })
const root = await fs.mkdtemp(join(cache, 'skill-performance-'))
const project = join(root, 'project'), home = join(root, 'home'), agents = join(root, 'agents'), panel = join(root, 'panel')
const originalCwd = process.cwd()
const env = { DSH_HOME: home, DSH_AGENTS_HOME: agents, DSH_BUNDLED_SKILL_DIR: join(root, 'bundled'), DSH_PROFILE_DIR: join(root, 'profile'), SKILL_MCP_PANEL_HOME: panel, SKILL_MCP_PANEL_DUMP: undefined, SKILL_MCP_PANEL_RENDER_DUMP: undefined }
const beforeEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
const require = createRequire(import.meta.url), host = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const React = createRequire(host)('react'), ui = await import(pathToFileURL(join(dirname(host), 'lib/types/ui.js')).href)
const { Terminal } = require('@xterm/headless'), { Unicode11Addon } = require('@xterm/addon-unicode11')
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)]
const stats = values => ({ samples: values.length, minMs: Math.min(...values), medianMs: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: Math.max(...values) })
const command = (name, args) => { try { return execFileSync(name, args, { encoding:'utf8' }).trim() } catch { return 'unavailable' } }
const fixtureFiles = [], body = '正文 performance fixture.\n'.repeat(320)
const groups = Object.fromEntries(Array.from({ length:20 }, (_,i) => [`g-${i}`, { name:`Group ${i}`, scopes:{ [project]:[], global:[] } }]))
let fixtureBytes = 0
class Input extends Readable {
  isTTY = true
  constructor() { super({ read() {} }) }
  setRawMode() {}; ref() {}; unref() {}
}
class Output extends EventEmitter {
  isTTY = true
  frame = ''; pending; outputBytes = 0
  constructor(columns) {
    super(); this.columns = columns; this.rows = 30
    this.term = new Terminal({ cols:columns, rows:30, scrollback:0, allowProposedApi:true })
    this.term.loadAddon(new Unicode11Addon()); this.term.unicode.activeVersion = '11'
  }
  screen() { return Array.from({ length:this.rows }, (_,i) => this.term.buffer.active.getLine(this.term.buffer.active.viewportY+i)?.translateToString(true) ?? '').join('\n') }
  write(chunk) {
    const text = String(chunk); this.outputBytes += Buffer.byteLength(text)
    this.term.write(text, () => {
      if (this.pending?.matches(this.frame, this.screen())) this.finish()
    })
    return true
  }
  getColorDepth() { return 8 }
  hasColors() { return true }
  finish() {
    const task = this.pending
    if (!task) return
    clearTimeout(task.timer); this.pending = undefined
    task.resolve({ observedMs:performance.now()-task.started })
  }
  waitFor(matches, action) {
    assert.equal(this.pending, undefined)
    return new Promise((resolve, reject) => {
      const started = performance.now()
      this.pending = { matches, started, resolve, timer:setTimeout(() => { this.pending=undefined; reject(new Error(`Timed out waiting for frame\n${this.frame.slice(0,400)}\n${this.screen()}`)) }, 15000) }
      action()
    })
  }
}
const trials = []
try {
  for (const [key,value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await fs.mkdir(join(project,'.git'), { recursive:true })
  for (let i=0; i<1000; i++) {
    const base = i<500 ? join(project,'.dsh/skills') : i<600 ? join(project,'.agents/skills') : i<900 ? join(home,'skills') : join(agents,'skills')
    const name = `skill-${String(i).padStart(4,'0')}`, disabled = i%5===0, directory = i%2===0
    const parent = directory ? join(base,name) : base
    await fs.mkdir(parent,{recursive:true})
    const path = join(parent, `${directory?'SKILL':name}.md${disabled?'.disabled':''}`)
    const raw = `---\nname: ${name}\ndescription: 中文检索 perf fixture ${i}\n---\n${body}`
    await fs.writeFile(path,raw); fixtureBytes += Buffer.byteLength(raw); fixtureFiles.push({path,raw})
    groups[`g-${i%20}`].scopes[i<600?project:'global'].push(name)
  }
  const groupPath = join(home,'skills/.system/skill-viewer/groups.json')
  await fs.mkdir(dirname(groupPath), {recursive:true}); await fs.writeFile(groupPath,JSON.stringify({version:1,groups})+'\n')
  const groupBefore = await fs.readFile(groupPath)
  process.chdir(project)
  for (const columns of [58,120]) for (let trial=0; trial<3; trial++) {
    const stdout = new Output(columns), stdin = new Input()
    let runtime, app, warmOutput
    const timer = setInterval(() => {}, 1000) // Keep custom streams alive; not part of the timing metric.
    try {
      let scanReadyMs, runtimeStarted
      const cold = await stdout.waitFor((f,s) => f.includes('list(1000):') && s.includes('技能列表') && s.includes('1000项') && s.includes('skill-000'), () => {
        const started = performance.now()
        runtimeStarted = started
        runtime = new ManagerRuntime({ get:() => undefined })
        const unsubscribe = runtime.subscribe(() => { if (scanReadyMs===undefined && runtime.snapshot().scan?.instances.length===1000) { scanReadyMs=performance.now()-started; unsubscribe() } })
        runtime.writeRenderFrame = (_reason, frame) => { stdout.frame = frame }
        const Component = createManagerScene(runtime,'performance-fixture')
        app = ui.renderSync(React.createElement(Component,{React,ui,channel:{},close(){}}),{stdout,stdin,stderr:stdout,patchConsole:false,exitOnCtrlC:false,terminalImages:false})
      })
      await runtime.ensureFresh()
      const startupReadyMs = performance.now()-runtimeStarted
      await sleep(100)
      assert.equal(runtime.snapshot().scan.instances.length,1000)
      const perKey = []
      const press = chars => { stdin.push(chars) }
      for (const target of ['skill-0999','中文','zz','skill-0000','中文','zz']) {
        await stdout.waitFor((f,s) => f.includes('query=""') && f.includes('list(1000):') && s.includes('1000'), () => press('x'))
        await stdout.waitFor((f,s) => f.includes('search=true') && s.includes('搜索:'), () => press('/'))
        let query = ''
        for (const char of Array.from(target)) {
          query += char
          const value = query, expected = fixtureFiles.filter(({raw}) => raw.split('---\n')[1].toLowerCase().includes(value.toLowerCase())).length
          const latency = await stdout.waitFor((f,s) => f.includes(`query=${JSON.stringify(value)} `) && f.includes(`list(${expected}):`) && s.includes(`· ${expected}项`) && s.includes(`搜索: ${value}▌`), () => press(char))
          perKey.push({ query:value, matches:expected, ...latency })
        }
        await stdout.waitFor((f) => f.includes('search=false'), () => press('\r'))
        await sleep(25)
      }
      await stdout.waitFor((f,s) => f.includes('query=""') && f.includes('list(1000):') && s.includes('1000'), () => press('x'))
      warmOutput = new Output(columns)
      const warmInput = new Input()
      const warm = await warmOutput.waitFor((f,s) => f.includes('list(1000):') && s.includes('技能列表') && s.includes('1000项'), () => {
        app.unmount()
        runtime.writeRenderFrame = (_reason, frame) => { warmOutput.frame = frame }
        const Component = createManagerScene(runtime,'performance-fixture')
        app = ui.renderSync(React.createElement(Component,{React,ui,channel:{},close(){}}),{stdout:warmOutput,stdin:warmInput,stderr:warmOutput,patchConsole:false,exitOnCtrlC:false,terminalImages:false})
      })
      trials.push({columns,trial:trial+1,scanReadyMs,startupReadyMs,coldOpen:cold,warmOpen:warm,perKey,searchObserved:stats(perKey.map(x=>x.observedMs))})
    } finally { clearInterval(timer); app?.unmount(); runtime?.dispose(); await sleep(20); stdout.term.dispose(); warmOutput?.term.dispose() }
  }
  for (const {path,raw} of fixtureFiles) assert.equal(await fs.readFile(path,'utf8'),raw)
  assert.ok((await fs.readFile(groupPath)).equals(groupBefore))
  const cold = stats(trials.map(x=>x.coldOpen.observedMs)), warm = stats(trials.map(x=>x.warmOpen.observedMs)), search = stats(trials.flatMap(x=>x.perKey.map(k=>k.observedMs)))
  const report = { date:new Date().toISOString(), baseline:command('git',['-C',repo,'rev-parse','--short','HEAD']),environment:{node:process.versions.node,host:JSON.parse(await fs.readFile(host,'utf8')).version,platform:process.platform,release:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem(),filesystem:command('findmnt',['-T',root,'-n','-o','TARGET,SOURCE,FSTYPE']),physicalSSD:'unverified; virtual block device does not establish physical medium'},fixture:{skills:1000,bytes:fixtureBytes,bodyBytes:Buffer.byteLength(body),directory:500,flat:500,workspace:600,global:400,enabled:800,disabled:200,groups:20,all1000SkillFilesAndGroupBytesPreserved:true},method:{coldOpen:'before constructing a fresh runtime -> 1000-row scan committed and actual terminal output parsed; excludes CLI/host startup, metadata/cleanup completion and fixture preparation',warmOpen:'unmount/remount scene with same runtime and fresh output emulator (includes unmount cost)',search:'real stdin one Unicode codepoint at a time -> exact query, expected result count and visible search cursor confirmed from real host ANSI output',observedMs:'includes input scheduling, React, renderer, output and terminal emulator callback; conservative local upper bound',cache:'OS cache not dropped; files just created and reused across trials; first runtime is not disk-cold',renderer:'real installed host UI/React with custom streams and headless xterm, not real CLI/PTY or physical display',debug:'no disk dump; existing verification frame captured in memory',renderIO:'static audit required separately; selected preview reads asynchronously after commit'},coldOpenObserved:cold,warmOpenObserved:warm,searchObserved:search,localThresholds:{coldOpenUnder1s:cold.maxMs<1000,warmOpenUnder1s:warm.maxMs<1000,everySearchKeyUnder100ms:search.maxMs<100},trials,limits:['Local observation only; not physical SSD or disk-cold certification','No full user manual acceptance or model requests','Input pacing waits for each completed key; burst backlog and physical terminal transport not measured'] }
  if (reportPath) await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({fixture:report.fixture,environment:report.environment,coldOpenObserved:cold,warmOpenObserved:warm,searchObserved:search,localThresholds:report.localThresholds,reportPath},null,2))
  if (!Object.values(report.localThresholds).every(Boolean)) process.exitCode = 1
} finally {
  process.chdir(originalCwd)
  for (const [key,value] of Object.entries(beforeEnv)) { if (value===undefined) delete process.env[key]; else process.env[key]=value }
  await fs.rm(root,{recursive:true,force:true})
}
