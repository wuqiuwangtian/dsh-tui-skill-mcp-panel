/** Isolated FR-3 real-TUI fixture: long paths, huge line and tail beyond 400 lines. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = JSON.parse(execFileSync(process.execPath, [join(repo, 'scripts/prepare-tui-probe.mjs'), ...process.argv.slice(2)], { encoding: 'utf8' }))
const parent = join(probe.root, '长路径 空格-'.repeat(8), '中文目录-'.repeat(8))
await mkdir(parent, { recursive: true })
const project = join(parent, 'project-PATH-END')
await rename(probe.project, project)
const entity = join(project, '.dsh/skills', '技能路径-'.repeat(8) + 'ENTITY-END')
await rename(join(project, '.dsh/skills/probe-skill'), entity)
const skillFile = join(entity, 'SKILL.md')
const body = '---\nname: probe-skill\ndescription: Read-only text fixture\n---\n' + '中文😀'.repeat(18000) + 'LONG-LINE-END\n' +
  Array.from({ length: 900 }, (_, i) => `text-line-${String(i).padStart(4, '0')} 中文😀`).join('\n') + '\nFULL-FILE-END'
await writeFile(skillFile, body)
await writeFile(join(probe.root, 'original-skill.md'), body)
await writeFile(probe.launcher, (await readFile(probe.launcher, 'utf8')).replaceAll(probe.project, project))
console.log(JSON.stringify({ ...probe, project, skillFile, original: join(probe.root, 'original-skill.md'), bytes: Buffer.byteLength(body),
  sha256: createHash('sha256').update(body).digest('hex') }, null, 2))
