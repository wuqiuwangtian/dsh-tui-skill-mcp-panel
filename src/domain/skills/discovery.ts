/**
 * Skill discovery on disk, mirroring `@deepseek-ai/dsh-skill-filesystem`
 * (0.2.2-rc.1): same roots/ranks, same one-level scan, same `.system` skip,
 * same frontmatter rules (via `./frontmatter.ts`), same shadowing order.
 *
 * This is intentionally a pure-ish domain module: no React, no Cordis services,
 * filesystem paths are injected — unit tests build a temporary tree.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseSkillDocument } from './frontmatter.js'
import type {
  SkillForm,
  SkillInstance,
  SkillRoot,
  SkillScanOptions,
  SkillScanResult,
  SkillSource,
  SkillStatus,
} from './types.js'

/** Rank table from `dsh-skill-filesystem/lib/index.js:20-24` (smaller wins). */
export const SKILL_RANKS: Record<SkillSource, number> = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
}

const SOURCE_SCOPE: Record<SkillSource, 'workspace' | 'global'> = {
  'project-dsh': 'workspace',
  'project-agents': 'workspace',
  custom: 'global',
  'user-dsh': 'global',
  'user-agents': 'global',
  bundled: 'global',
}

function envPath(name: string): string | undefined {
  const raw = process.env[name]
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > 0 ? resolve(value) : undefined
}

function createRoot(source: SkillSource, path: string, skipSystem: boolean, writable: boolean): SkillRoot {
  return {
    source,
    rank: SKILL_RANKS[source],
    path,
    scope: SOURCE_SCOPE[source],
    exists: false,
    skipSystem,
    writable,
  }
}

/** Kernel rule: nearest ancestor containing `.git`; otherwise the cwd itself. */
export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd)
  let current = start
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

export function resolveSkillHomes(options: SkillScanOptions = {}): {
  cwd: string
  projectRoot: string
  dshHome: string
  agentsHome: string
  bundledDir: string | undefined
} {
  const cwd = resolve(options.cwd ?? process.cwd())
  const dshHome = options.dshHome ?? envPath('DSH_HOME') ?? join(homedir(), '.dsh')
  const agentsHome = options.agentsHome ?? envPath('DSH_AGENTS_HOME') ?? join(homedir(), '.agents')
  const bundledDir = options.bundledDir ?? envPath('DSH_BUNDLED_SKILL_DIR')
  return { cwd, projectRoot: findProjectRoot(cwd), dshHome, agentsHome, bundledDir }
}

/** Build every discovery root in kernel order (project → custom → user → bundled). */
export function buildSkillRoots(options: SkillScanOptions = {}): SkillRoot[] {
  const { projectRoot, dshHome, agentsHome, bundledDir } = resolveSkillHomes(options)
  const roots: SkillRoot[] = [
    createRoot('project-dsh', join(projectRoot, '.dsh/skills'), false, true),
    createRoot('project-agents', join(projectRoot, '.agents/skills'), false, true),
    ...(options.customDirs ?? []).map((dir) => createRoot('custom', resolve(dir), false, true)),
    createRoot('user-dsh', join(dshHome, 'skills'), true, true),
    createRoot('user-agents', join(agentsHome, 'skills'), false, true),
  ]
  if (bundledDir !== undefined) roots.push(createRoot('bundled', bundledDir, false, false))
  return roots
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

type EntryKind = 'directory' | 'file'

interface RootEntry {
  name: string
  path: string
  kind: EntryKind
}

async function listRootEntries(
  root: SkillRoot,
  warnings: string[],
): Promise<RootEntry[]> {
  let dirents
  try {
    dirents = await readdir(root.path, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warnings.push(`无法读取技能根 ${root.path}：${(error as Error).message}`)
    }
    return []
  }
  const entries: RootEntry[] = []
  for (const dirent of dirents) {
    if (root.skipSystem && dirent.name === '.system') continue
    let kind: EntryKind | undefined
    if (dirent.isDirectory()) kind = 'directory'
    else if (dirent.isFile()) kind = 'file'
    else if (dirent.isSymbolicLink()) {
      // Kernel follows symlinks via stat(); mirror that (ENOENT symlinks are skipped).
      try {
        const info = await stat(join(root.path, dirent.name))
        kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
      } catch {
        warnings.push(`无法跟随符号链接 ${join(root.path, dirent.name)}`)
      }
    }
    if (kind !== undefined) entries.push({ name: dirent.name, path: join(root.path, dirent.name), kind })
  }
  return entries
}

function flatFallbackName(fileName: string): string {
  return fileName.replace(/\.md(?:\.disabled)?$/u, '')
}

interface CreateInstanceInput {
  root: SkillRoot
  form: SkillForm
  status: SkillStatus
  skillFile: string
  locatorDir: string
  fallbackName: string
  providerOrder: number
  warnings: string[]
}

async function createInstance(input: CreateInstanceInput): Promise<SkillInstance> {
  const { root, form, status, skillFile, locatorDir, fallbackName, providerOrder, warnings } = input
  const instance: SkillInstance = {
    id: `${root.source}:${skillFile}`,
    name: fallbackName,
    description: '',
    source: root.source,
    rank: root.rank,
    scope: root.scope,
    form,
    status,
    skillFile,
    locatorDir,
    rootPath: root.path,
    path: skillFile,
    providerOrder,
    effective: false,
  }

  let raw: string
  try {
    raw = await readFile(skillFile, 'utf8')
  } catch (error) {
    instance.status = 'invalid'
    instance.invalidReason = `无法读取技能文件：${(error as Error).message}`
    return instance
  }
  instance.path = await realpathOr(skillFile)

  const parsed = parseSkillDocument(raw)
  if (!parsed.ok) {
    instance.status = 'invalid'
    instance.invalidReason = parsed.reason
    return instance
  }

  instance.name = parsed.frontmatter.name
  instance.description = parsed.frontmatter.description
  instance.whenToUse = parsed.frontmatter.whenToUse
  instance.metadata = parsed.frontmatter.metadata
  instance.modelInvocable = parsed.frontmatter.modelInvocable
  instance.userInvocable = parsed.frontmatter.userInvocable
  instance.bodyPreview = parsed.body.slice(0, 4000)
  if (status === 'disabled') instance.status = 'disabled'

  if (form === 'directory' && fallbackName !== parsed.frontmatter.name) {
    warnings.push(
      `目录束 ${locatorDir} 的目录名与 frontmatter name "${parsed.frontmatter.name}" 不一致（内核按 frontmatter）`,
    )
  }
  return instance
}

/** Scan every root and resolve effective/shadowed instances. */
export async function scanSkills(options: SkillScanOptions = {}): Promise<SkillScanResult> {
  const homes = resolveSkillHomes(options)
  const roots = buildSkillRoots(options)
  const warnings: string[] = []
  const instances: SkillInstance[] = []
  let providerOrder = 0

  for (const root of roots) {
    root.exists = await pathExists(root.path)
    if (!root.exists) continue
    const entries = await listRootEntries(root, warnings)
    // Kernel sorts root entries by name before producing provider candidates.
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (entry.kind === 'directory') {
        const enabledFile = join(entry.path, 'SKILL.md')
        const disabledFile = join(entry.path, 'SKILL.md.disabled')
        const hasEnabled = await pathExists(enabledFile)
        const hasDisabled = await pathExists(disabledFile)
        if (hasEnabled) {
          instances.push(
            await createInstance({
              root,
              form: 'directory',
              status: 'enabled',
              skillFile: enabledFile,
              locatorDir: entry.path,
              fallbackName: entry.name,
              providerOrder: providerOrder++,
              warnings,
            }),
          )
          if (hasDisabled) {
            warnings.push(`目录束 ${entry.path} 同时存在 SKILL.md 与 SKILL.md.disabled（内核只读 SKILL.md）`)
          }
        } else if (hasDisabled) {
          instances.push(
            await createInstance({
              root,
              form: 'directory',
              status: 'disabled',
              skillFile: disabledFile,
              locatorDir: entry.path,
              fallbackName: entry.name,
              providerOrder: providerOrder++,
              warnings,
            }),
          )
        }
        continue
      }

      if (entry.name.endsWith('.md')) {
        instances.push(
          await createInstance({
            root,
            form: 'file',
            status: 'enabled',
            skillFile: entry.path,
            locatorDir: root.path,
            fallbackName: flatFallbackName(entry.name),
            providerOrder: providerOrder++,
            warnings,
          }),
        )
      } else if (entry.name.endsWith('.md.disabled')) {
        instances.push(
          await createInstance({
            root,
            form: 'file',
            status: 'disabled',
            skillFile: entry.path,
            locatorDir: root.path,
            fallbackName: flatFallbackName(entry.name),
            providerOrder: providerOrder++,
            warnings,
          }),
        )
      }
    }
  }

  // Shadowing: lowest rank wins, then provider order (kernel compareIndexedCandidates).
  const winners = new Map<string, SkillInstance>()
  const candidates = instances
    .filter((instance) => instance.status === 'enabled')
    .sort((left, right) => left.rank - right.rank || left.providerOrder - right.providerOrder)
  for (const candidate of candidates) {
    const winner = winners.get(candidate.name)
    if (winner === undefined) {
      winners.set(candidate.name, candidate)
      candidate.effective = true
    } else {
      candidate.shadowedBy = winner.id
    }
  }

  const now = options.now?.() ?? new Date()
  return {
    scannedAt: now.toISOString(),
    cwd: homes.cwd,
    projectRoot: homes.projectRoot,
    dshHome: homes.dshHome,
    agentsHome: homes.agentsHome,
    roots,
    instances,
    warnings,
  }
}
