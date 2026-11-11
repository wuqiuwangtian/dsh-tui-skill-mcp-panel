/** Compare live scoped catalogs, command registration and panel scan; no refresh/mutation. */
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
const [directory, phase] = process.argv.slice(2)
const phases = ['initial','local-off','local-on','shared-off','shared-on','flat-off','flat-on','global-off','global-on','bundled-ro']
assert.ok(directory && phases.includes(phase), 'usage: node scripts/record-skill-sync.mjs <isolated probe root> <phase>')
const root = await realpath(directory)
assert.ok(basename(root).startsWith('skill-mcp-real-tui-'))
const probe = JSON.parse(await readFile(join(root, 'skill-sync-probe.json'), 'utf8'))
assert.equal(probe.root, root)
const all = ['sync-bundled','sync-flat','sync-global','sync-human-only','sync-local','sync-model-only','sync-shared']
const absent = { 'local-off':'sync-local', 'flat-off':'sync-flat', 'global-off':'sync-global' }[phase]
const expected = all.filter(name=>name!==absent)
let result, lastError
const deadline = Date.now() + 8000
while (Date.now() < deadline) {
  try {
    const catalog = JSON.parse(await readFile(join(root, 'skill-sync.json'), 'utf8'))
    process.kill(catalog.pid, 0)
    const panel = JSON.parse(await readFile(join(root, 'dump.json'), 'utf8'))
    assert.equal(panel.pid, catalog.pid, 'same live TUI process')
    assert.equal(catalog.agents.length, 1, 'one actual idle agent')
    const agent = catalog.agents[0]
    assert.equal(agent.cwd, probe.project)
    assert.equal(agent.status, 'idle', 'no generated turn')
    assert.equal(agent.complete, true)
    assert.equal(agent.skillToolPresent, true)
    assert.deepEqual(agent.skills.map(s=>s.name).sort(), expected)
    assert.deepEqual(agent.modelEligible.sort(), expected.filter(n=>n!=='sync-human-only'))
    assert.deepEqual(agent.userEligible.sort(), expected.filter(n=>n!=='sync-model-only'))
    assert.deepEqual(agent.registeredCommands.sort(), agent.userEligible)
    const rows = panel.scan.instances.filter(s=>s.name.startsWith('sync-'))
    const effective = rows.filter(s=>s.status==='enabled'&&s.effective)
    assert.deepEqual(effective.map(s=>s.name).sort(), expected, 'panel effective set equals agent neutral catalog')
    for (const skill of agent.skills) {
      const row = effective.find(s=>s.name===skill.name)
      assert.equal(row.path, skill.path, 'same winning physical file')
      assert.equal(row.source, skill.source)
      assert.equal(row.modelInvocable !== false, skill.invocation.modelInvocable)
      assert.equal(row.userInvocable !== false, skill.invocation.userInvocable)
    }
    assert.ok(rows.some(r=>r.name==='sync-invalid'&&r.status==='invalid'))
    assert.ok(!rows.some(r=>r.name==='sync-hidden'))
    assert.equal(agent.definitions['sync-local']?.body ?? null, absent==='sync-local'?null:'LOCAL-BODY')
    assert.equal(agent.definitions['sync-flat']?.body ?? null, absent==='sync-flat'?null:'FLAT-BODY')
    assert.equal(agent.definitions['sync-shared'].body, phase==='shared-off'?'GLOBAL-FALLBACK':'WORKSPACE-WINNER')
    const workspaceShared = rows.find(r=>r.name==='sync-shared'&&r.source==='project-dsh')
    const globalShared = rows.find(r=>r.name==='sync-shared'&&r.source==='user-dsh')
    assert.equal(workspaceShared.status, phase==='shared-off'?'disabled':'enabled')
    assert.equal(globalShared.effective, phase==='shared-off')
    for (const [name, parent, flat] of [['sync-local',join(probe.project,'.dsh/skills'),false],['sync-flat',join(probe.project,'.dsh/skills'),true],['sync-global',join(root,'dsh/skills'),false]]) {
      const file = flat ? join(parent,`${name}.md`) : join(parent,name,'SKILL.md')
      assert.equal(existsSync(file), name!==absent)
      assert.equal(existsSync(file+'.disabled'), name===absent)
    }
    assert.ok(existsSync(join(probe.bundled,'sync-bundled/SKILL.md')))
    assert.ok(!existsSync(join(probe.bundled,'sync-bundled/SKILL.md.disabled')))
    result = { phase, capturedAt:new Date().toISOString(), catalog, panel:{ pid:panel.pid, scannedAt:panel.scan.scannedAt, rows } }
    break
  } catch (error) { lastError = error; await sleep(200) }
}
if (!result) throw lastError
await mkdir(join(root,'sync-snapshots'),{recursive:true})
await writeFile(join(root,'sync-snapshots',phase+'.json'),JSON.stringify(result,null,2)+'\n')
console.log(`${phase} OK: panel = agent catalog (${expected.length} sync skills); model/user policy + commands + physical paths agree`)
