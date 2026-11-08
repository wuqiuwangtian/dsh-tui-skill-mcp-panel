/**
 * Frontmatter parsing/validation that mirrors `@deepseek-ai/dsh-skill-filesystem`
 * (0.2.2-rc.1) line for line: same `yaml` parser, same name grammar, same
 * invocation-policy booleans and the same reasons the kernel silently drops a
 * skill. The panel reuses these reasons so "file exists but unusable" is visible.
 */
import { parse as parseYaml } from 'yaml'

/** Kernel grammar: `dsh-skill` SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export const LEGACY_INVOCATION_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  modelInvocable: boolean
  userInvocable: boolean
  /** The parsed YAML mapping, for the detail pane (keys beyond the modeled ones are kept). */
  raw: Record<string, unknown>
}

export type FrontmatterParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; reason: string }

/** Split `---`-delimited frontmatter from the body, mirroring the kernel. */
export function splitFrontmatter(raw: string): { yaml: string; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      return {
        yaml: raw.slice(start, lineStart),
        body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalMetadata(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = data.metadata
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
      default:
        break
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function parseInvocationPolicy(data: Record<string, unknown>): {
  modelInvocable: boolean
  userInvocable: boolean
} {
  for (const [legacy, canonical] of LEGACY_INVOCATION_KEYS) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
    }
  }
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse + validate a skill document exactly like the kernel provider does. */
export function parseSkillDocument(raw: string): FrontmatterParseResult {
  const split = splitFrontmatter(raw)
  if (split === undefined) return { ok: false, reason: 'missing YAML frontmatter' }
  let parsed: unknown
  try {
    parsed = parseYaml(split.yaml)
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${errorMessage(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'missing YAML frontmatter' }
  }
  const data = parsed as Record<string, unknown>
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined || description === undefined) {
    return { ok: false, reason: 'frontmatter requires name and description' }
  }
  if (!isSkillName(name)) return { ok: false, reason: `invalid skill name "${name}"` }
  let invocation: { modelInvocable: boolean; userInvocable: boolean }
  try {
    invocation = parseInvocationPolicy(data)
  } catch (error) {
    return { ok: false, reason: `invalid invocation frontmatter: ${errorMessage(error)}` }
  }
  return {
    ok: true,
    body: split.body,
    frontmatter: {
      name,
      description,
      ...(optionalString(data, 'whenToUse') === undefined
        ? {}
        : { whenToUse: optionalString(data, 'whenToUse') as string }),
      ...(optionalMetadata(data) === undefined ? {} : { metadata: optionalMetadata(data) as Record<string, unknown> }),
      ...invocation,
      raw: data,
    },
  }
}
