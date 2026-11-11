/** Isolated real-agent catalog observer. Does not dispatch a turn or invoke a skill. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const hostDir = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'usage: node scripts/prepare-skill-sync-probe.mjs <CLI-installed host directory>')
assert.equal(JSON.parse(await readFile(join(hostDir, 'package.json'), 'utf8')).version, '0.19.0')
const cli = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const req = createRequire(cli)
const skillModule = req.resolve('@deepseek-ai/dsh-skill')
const probe = JSON.parse(execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'prepare-tui-probe.mjs'), hostDir], { encoding: 'utf8' }))
const { root, profile, project } = probe
const skill = async (parent, name, description, body, extra = '', flat = false) => {
  const dir = flat ? parent : join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, flat ? `${name}.md` : 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`)
}
const workspace = join(project, '.dsh/skills'), globalRoot = join(root, 'dsh/skills')
await skill(workspace, 'sync-local', 'Workspace only', 'LOCAL-BODY')
await skill(workspace, 'sync-flat', 'Flat skill', 'FLAT-BODY', '', true)
await skill(workspace, 'sync-shared', 'Workspace winner', 'WORKSPACE-WINNER')
await skill(globalRoot, 'sync-shared', 'Global fallback', 'GLOBAL-FALLBACK')
await skill(globalRoot, 'sync-global', 'Global only', 'GLOBAL-BODY')
await skill(workspace, 'sync-human-only', 'Human invocation only', 'HUMAN-BODY', 'disable-model-invocation: true\n')
await skill(workspace, 'sync-model-only', 'Model invocation only', 'MODEL-BODY', 'user-invocable: false\n')
await mkdir(join(workspace, 'sync-invalid'), { recursive: true })
await writeFile(join(workspace, 'sync-invalid/SKILL.md'), '---\nname: sync-invalid\n---\nInvalid missing description.\n')
await skill(join(workspace, '.system'), 'sync-hidden', 'Hidden system child', 'HIDDEN-BODY')
const bundled = join(root, 'bundled-skills')
await skill(bundled, 'sync-bundled', 'Read-only bundled fixture', 'BUNDLED-BODY')
const launcher = await readFile(probe.launcher, 'utf8')
await writeFile(probe.launcher, launcher.replace("export TERM=", `export DSH_BUNDLED_SKILL_DIR='${bundled}'\nexport TERM=`))
const observer = join(root, 'skill-sync-observer.mjs')
await writeFile(observer, `import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { serviceForAgent } from ${JSON.stringify(pathToFileURL(join(hostDir, 'lib/types/dsh-adapter/presets.js')).href)}
import { isModelInvocable, isUserInvocable } from ${JSON.stringify(pathToFileURL(skillModule).href)}
export const name = 'skill-sync-observer'
export function apply(ctx) {
  let running = false, stopped = false, last = ''
  const loaded = new Map()
  const prefix = row => row.name.startsWith('sync-')
  const sample = async () => {
    if (running || stopped) return
    running = true
    try {
      const agents = ctx.get('agents', false), commands = ctx.get('commands', false)
      const hostSkills = ctx.get('skills', false)
      const host = hostSkills ? await hostSkills.snapshot({ cwd:${JSON.stringify(project)}, signal:AbortSignal.timeout(2000) }) : undefined
      const views = []
      for (const agent of agents?.list() ?? []) {
        const cwd = await ctx.get('workingDirectory').ensure(agent, AbortSignal.timeout(2000))
        const registry = serviceForAgent(ctx, agent, 'skills')
        const tools = serviceForAgent(ctx, agent, 'tools')
        const options = { scope:agent, cwd, signal:AbortSignal.timeout(2000) }
        const snapshot = await registry.snapshot(options)
        const skills = snapshot.skills.filter(prefix).map(s => ({ name:s.name, description:s.description, path:s.path, source:s.source, invocation:s.invocation }))
        // Do not probe a disappeared old locator: get() can invalidate a stale
        // catalog itself. Load bodies only AFTER snapshot reports a new catalog.
        const signature = JSON.stringify(skills)
        if (loaded.get(agent.id)?.signature !== signature) {
          const definitions = {}
          for (const key of ['sync-local','sync-flat','sync-shared']) {
            const value = skills.some(s=>s.name===key) ? await registry.get(key, { ...options, signal:AbortSignal.timeout(2000) }) : undefined
            definitions[key] = value ? { path:value.path, source:value.source, contentSha256:createHash('sha256').update(value.content).digest('hex'), body:value.content.trim() } : null
          }
          loaded.set(agent.id,{signature,definitions})
        }
        const definitions = loaded.get(agent.id).definitions
        views.push({ id:agent.id, status:agent.status, cwd, complete:snapshot.complete, skillToolPresent:Boolean(tools?.get('skill',agent)), skills, definitions,
          modelEligible: snapshot.skills.filter(prefix).filter(isModelInvocable).map(s=>s.name),
          userEligible: snapshot.skills.filter(prefix).filter(isUserInvocable).map(s=>s.name),
          registeredCommands: commands?.list(agent).filter(prefix).map(c=>c.name) ?? [] })
      }
      const value = { pid:process.pid, bundledRoot:process.env.DSH_BUNDLED_SKILL_DIR, host:{ complete:host?.complete, count:host?.skills.length }, agents:views }
      const serialized = JSON.stringify(value)
      if (!stopped && serialized !== last) {
        last = serialized
        const entry = { at:new Date().toISOString(), ...value }
        fs.writeFileSync(${JSON.stringify(join(root, 'skill-sync.tmp'))}, JSON.stringify(entry,null,2))
        fs.renameSync(${JSON.stringify(join(root, 'skill-sync.tmp'))},${JSON.stringify(join(root, 'skill-sync.json'))})
        fs.appendFileSync(${JSON.stringify(join(root, 'skill-sync.jsonl'))},JSON.stringify(entry)+'\\n')
      }
    } catch(error) { if(!stopped) fs.writeFileSync(${JSON.stringify(join(root, 'skill-sync-error.json'))},JSON.stringify({at:new Date().toISOString(),error:String(error)})) }
    finally { running = false }
  }
  ctx.effect(() => { const timer=setInterval(()=>void sample(),250); void sample(); return () => { stopped=true; clearInterval(timer) } })
}
`)
const patchPath = join(profile, 'cordis.patch.yml')
await writeFile(patchPath, await readFile(patchPath, 'utf8') + `\n- insert:\n    - id: skill-sync-observer\n      name: ${JSON.stringify(observer)}\n`)
await writeFile(join(root, 'skill-sync-probe.json'), JSON.stringify({ ...probe, bundled }, null, 2) + '\n')
console.log(JSON.stringify({ ...probe, bundled }, null, 2))
