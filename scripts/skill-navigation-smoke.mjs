/** Real runtime + host hit-testing: design breakpoints, group navigation and visible-only writes. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createManagerScene } from '../lib/types/ui/ManagerScene.js'
import { ManagerRuntime } from '../lib/types/host/manager-runtime.js'
import { cellWidth } from '../lib/types/shared/format.js'
const require = createRequire(import.meta.url), host = require.resolve('@deepseek-harness-tui/dsh-tui/package.json')
const React = createRequire(host)('react'), ui = await import(pathToFileURL(join(dirname(host),'lib/types/ui.js')).href)
const { Terminal } = require('@xterm/headless'), { Unicode11Addon } = require('@xterm/addon-unicode11')
class Input extends Readable {
  isTTY = true
  constructor() { super({read(){}}) }
  setRawMode() {}; ref() {}; unref() {}
}
class Output extends EventEmitter {
  isTTY = true; chunks = []; rows = 24
  constructor(columns) { super(); this.columns = columns }
  write(value) { this.chunks.push(String(value)); return true }
  getColorDepth() { return 8 }
  hasColors() { return true }
}
const results = []
for (const columns of [64,90,110]) {
  const root = await fs.mkdtemp(join(tmpdir(),'skill-navigation-')), project = join(root,'project'), home = join(root,'home'), panel = join(root,'panel')
  const env = { DSH_HOME:home, DSH_AGENTS_HOME:join(root,'agents'), DSH_BUNDLED_SKILL_DIR:join(root,'bundled'), DSH_PROFILE_DIR:join(root,'profile'), SKILL_MCP_PANEL_HOME:panel, SKILL_MCP_PANEL_DUMP:undefined, SKILL_MCP_PANEL_RENDER_DUMP:undefined }
  const originalCwd = process.cwd(), beforeEnv = Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]))
  const stdout = new Output(columns), stdin = new Input(), term = new Terminal({cols:columns,rows:stdout.rows,scrollback:0,allowProposedApi:true})
  term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'
  let runtime, app, frame = '', consumed = 0, closed = false
  const check = (ok,label) => { assert.ok(ok,`${columns}: ${label}\n${frame.slice(0,1600)}`); results.push({columns,label,pass:true}) }
  const press = async chars => { stdin.push(chars); await sleep(85) }
  const screen = async () => {
    await sleep(40)
    const raw = stdout.chunks.slice(consumed).join(''); consumed = stdout.chunks.length
    await new Promise(done=>term.write(raw,done))
    return Array.from({length:stdout.rows},(_,y)=>term.buffer.active.getLine(y)?.translateToString(true)??'').join('\n')
  }
  const click = async needle => {
    const lines = (await screen()).split('\n'), y = lines.findIndex(line=>line.includes(needle))
    assert.ok(y>=0,`Missing pointer target ${needle}\n${lines.join('\n')}`)
    const x = cellWidth(lines[y].slice(0,lines[y].indexOf(needle)))+1
    await press(`\x1b[<0;${x};${y+1}M\x1b[<0;${x};${y+1}m`)
  }
  const resize = async (cols,rows=24) => { stdout.columns=cols; stdout.rows=rows; term.resize(cols,rows); stdout.emit('resize'); await sleep(120) }
  const chooseGroup = async index => { await press('b'); await press('\x1b[H'); for(let i=0;i<index;i++)await press('\x1b[B'); await press('\r') }
  const allScopes = async () => {
    if(frame.includes('focus=scope'))await press('\x1b[C')
    else if(frame.includes('focus=detail'))await press('\x1b')
    if(stdout.columns>=90){await press('\x1b[D');await press('\x1b[H');await press('\x1b[B');await press('\r')}
    else {await click('全部(');await press('\x1b[C')}
  }
  const exists = path => fs.stat(path).then(()=>true,()=>false)
  const wait = async (fn,label) => {const end=Date.now()+4000;while(!await fn()&&Date.now()<end)await sleep(25);check(await fn(),label)}
  try {
    for(const [k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v}
    const skills = join(project,'.dsh/skills'), global = join(home,'skills')
    await fs.mkdir(join(project,'.git'),{recursive:true});await fs.mkdir(skills,{recursive:true});await fs.mkdir(global,{recursive:true});await fs.mkdir(panel)
    const doc = name => `---\nname: ${name}\ndescription: Navigation 中文🧭 fixture\n---\n${'BODY navigation.\n'.repeat(100)}`
    const alpha = join(skills,'nav-alpha.md'), beta = join(skills,'nav-beta.md.disabled'), twin = join(global,'nav-alpha.md'), outside = join(global,'nav-outside.md')
    const files = [alpha,beta,twin,outside]
    await fs.writeFile(alpha,doc('nav-alpha'));await fs.writeFile(beta,doc('nav-beta'));await fs.writeFile(twin,doc('nav-alpha'));await fs.writeFile(outside,doc('nav-outside'))
    const originals = await Promise.all(files.map(f=>fs.readFile(f)))
    const groups = Object.fromEntries(Array.from({length:60},(_,i)=>[`g${i}`,{name:`Group ${String(i).padStart(2,'0')}${i===59?' 中文🧭'.repeat(10):''}`,scopes:{[project]:i===0?['nav-alpha']:i===1||i===59?['nav-beta']:[],global:i===2?['nav-alpha']:[]}}]))
    const groupPath = join(global,'.system/skill-viewer/groups.json')
    await fs.mkdir(dirname(groupPath),{recursive:true});await fs.writeFile(groupPath,JSON.stringify({version:1,sentinel:'preserve',groups})+'\n')
    let expectedGroupBytes = await fs.readFile(groupPath)
    const configPath = join(panel,'config.json');await fs.writeFile(configPath,'{"version":1,"future":{"keep":true}}\n')
    process.chdir(project);runtime = new ManagerRuntime({get:()=>undefined});await runtime.ensureFresh()
    runtime.writeRenderFrame = (_reason,text) => {frame=text}
    const Component = createManagerScene(runtime,'navigation-fixture')
    app = ui.renderSync(React.createElement(ui.AlternateScreen,{mouseTracking:true},React.createElement(Component,{React,ui,channel:{},close(){closed=true}})),{stdout,stdin,stderr:stdout,patchConsole:false,exitOnCtrlC:false,terminalImages:false})
    await sleep(180)
    check(frame.includes('list(4):')&&frame.includes(`layout=${columns<90?'dual':'tree'}`),'correct initial layout and instances')
    check((await screen()).includes(columns<90?'[b 分组:全部]':'作用域 / 分组'),'group entry is visible')
    const configBytes = await fs.readFile(configPath)
    if(columns>=90){
      await press('\x1b[D');await press('\x1b[H');await press('\r')
      check(frame.includes('scopeExpanded=false')&&frame.includes('list(4):'),'scope tree folds without filtering')
      await press('\r');await press('\x1b[B');await press('\x1b[B')
      check(frame.includes('scope=all')&&frame.includes('nav=scope:workspace'),'moving scope cursor does not apply')
      await press('d');await press(' ');await press('v');await press('g')
      check(frame.includes('modal=-')&&frame.includes('marked=0')&&await exists(alpha)&&await exists(beta),'left tree cannot target skills with keyboard writes or marks')
      await click(columns<110?'[d删除]':'[d 删除]');await click(columns<110?'[v标记]':'[v 标记]')
      check(frame.includes('modal=-')&&frame.includes('marked=0')&&frame.includes('focus=scope'),'left tree pointer actions obey same target boundary')
      await press('\r');check(frame.includes('scope=workspace')&&frame.includes('list(2):'),'Enter applies scope and returns list')
      await press('\x1b[D');await press('\x1b[F')
      check(frame.includes('nav=group:g59')&&(await screen()).includes('Group 59'),'last long group reachable by End')
      await press('\r');check(frame.includes('groupFilter=g59')&&frame.includes('list(1):'),'last group filters exact workspace member')
      await press('\x1b[D');await press('\x1b[H');for(let i=0;i<4;i++)await press('\x1b[B');await press('\r')
      check(frame.includes('groupsExpanded=false')&&frame.includes('groupFilter=g59'),'fold keeps applied group')
      await press('\r');check(frame.includes('groupsExpanded=true'),'group tree reopens')
      await press('x');await allScopes()
    }
    await chooseGroup(1)
    check(frame.includes('groupFilter=g0')&&frame.includes('list(1):')&&frame.includes('project/.dsh'),'group quick picker excludes same-name global twin')
    await press('/');await press('alpha');await press('\r');await press('f');await press('\x1b[H');await press('\x1b[B');await press('\x1b[B');await press('\r')
    check(frame.includes('query="alpha"')&&frame.includes('groupFilter=g0')&&frame.includes('list(0):'),'query/status/group intersect')
    await press('d');await press(' ');check(frame.includes('modal=-')&&await exists(alpha)&&await exists(beta),'empty filtered actions do not write')
    await press('x');await chooseGroup(1)
    if(columns>=90){await press('\x1b[D');await press('\x1b[H');await press('\x1b[B');await press('\x1b[B');await press('\r')}
    else {await press('\x1b[D');await press('\x1b[B');await press('\x1b[C')}
    await press('/');await press('alpha');await press('\r');await press('f');await press('\x1b[H');await press('\x1b[B');await press('\r');await press('v')
    check(frame.includes('scope=workspace')&&frame.includes('query="alpha"')&&frame.includes('skillStatus=enabled')&&frame.includes('groupFilter=g0')&&frame.includes('marked=1'),'all four filters combine with marked visible member')
    await press('\x1b[D');await resize(40,16);check(frame.includes('screen=40x16')&&(await screen()).includes('[b 分组:'),'tree/dual to minimum keeps group entry')
    await press('d');await press(' ');await press('v');await press('g')
    check(frame.includes('focus=scope')&&frame.includes('modal=-')&&frame.includes('marked=1')&&await exists(alpha)&&!await exists(`${alpha}.disabled`),'resized filter focus cannot become a hidden skill target')
    await press('\x1b[C')
    await press('b');await press('\x1b');check(frame.includes('groupFilter=g0')&&frame.includes('marked=1'),'minimum picker cancel retains filter and mark')
    await press('\r');check((await screen()).includes('列表 › 详情'),'single-pane breadcrumb shows return path')
    await resize(64);check((await screen()).includes('技能列表')&&(await screen()).includes('详情'),'resize to 64 keeps both panes')
    await resize(90);check((await screen()).includes('作用域 / 分组')&&frame.includes('groupFilter=g0')&&frame.includes('marked=1'),'resize to 90 restores tree and state')
    await press('\x1b');await resize(columns);await press('x');await allScopes();await press('\x1b[C');await press('\x1b')
    check(frame.includes('scope=all')&&frame.includes('groupFilter=-')&&frame.includes('marked=0'),'clear and scope return restore all')
    check((await fs.readFile(configPath)).equals(configBytes),'group navigation does not persist preferences')
    check((await fs.readFile(groupPath)).equals(expectedGroupBytes),'group navigation never rewrites shared metadata')
    if(columns>=90){
      await click('▾ 分组 [b]');check(frame.includes('groupsExpanded=false'),'pointer folds group section')
      await sleep(550) // Same-cell clicks inside the host's 500ms selection window are multi-clicks.
      await click('▸ 分组 [b]');await click('Group 00')
      check(frame.includes('groupFilter=g0')&&frame.includes('focus=list'),'pointer row applies group and keeps list focus')
      await press('x');await allScopes()
    } else {
      await click('[b 分组:');await click('Group 00')
      check(frame.includes('groupFilter=g0')&&frame.includes('focus=list'),'pointer chip applies group')
      await press('x');await allScopes();await press('\x1b[C');await press('\x1b')
    }
    await press('\x1b[H');await press('v');await press('\x1b[B');await press('v');check(frame.includes('marked=2'),'two same-name sources marked')
    await press('b');await press('\x1b');check(frame.includes('marked=2'),'group picker cancel preserves marks')
    await chooseGroup(2);check(frame.includes('marked=0')&&frame.includes('groupFilter=g1')&&frame.includes('selected=nav-beta'),'new group clears hidden old marks')
    await press('d');await press('y');await wait(async()=>!await exists(beta),'delete acts only on visible new group')
    check(await exists(alpha)&&await exists(twin)&&await exists(outside),'old marked sources and outside group survive')
    await press('u');await wait(()=>exists(beta),'undo restores grouped disabled skill')
    const finalBytes = await Promise.all(files.map(f=>fs.readFile(f)));check(finalBytes.every((b,i)=>b.equals(originals[i])),'all skill bytes restored after explicit delete/undo')
    await chooseGroup(60);delete groups.g59
    expectedGroupBytes = Buffer.from(JSON.stringify({version:1,sentinel:'preserve',groups})+'\n');await fs.writeFile(groupPath,expectedGroupBytes);await runtime.refresh('external-group-deleted');await sleep(120)
    check(frame.includes('groupFilter=-')&&frame.includes('list(4):'),'external removal of active group clears stale filter')
    await press('2');check(frame.includes('mcpView query="" status=all group=-'),'MCP filtering remains independent')
    await press('1');check(frame.includes('scope=all'),'tab return keeps skill scope')
    check((await fs.readFile(groupPath)).equals(expectedGroupBytes),'external group edit preserved exactly')
    const config = JSON.parse(await fs.readFile(configPath,'utf8'));check(config.future.keep&&!Object.hasOwn(config,'skillNavId'),'unknown config retained; navigation is scene-only')
    check(!closed,'navigation never accidentally closes scene')
  } finally {
    app?.unmount();runtime?.dispose();term.dispose();process.chdir(originalCwd)
    for(const [k,v]of Object.entries(beforeEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v}
    await fs.rm(root,{recursive:true,force:true})
  }
}
if(process.env.SKILL_NAVIGATION_REPORT)await fs.writeFile(process.env.SKILL_NAVIGATION_REPORT,JSON.stringify(results,null,2)+'\n')
console.log(`skill-navigation-smoke OK: ${results.length} assertions across 64/90/110 columns; tree/chip/pointer/resize, exact groups, visible-only writes`)
