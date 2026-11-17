/** Confirmed repair of display metadata only; MCP files are read, never written. */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configFile, loadPanelDocument, updateMcpGroups } from '../store.js'
import { MCP_MODULE, parsePatchText } from './patch.js'
import { mcpGroupIds, repairMcpMember, type McpIdentity } from './groups.js'
import { patchFingerprint, readPatchSnapshot } from './write.js'

interface RepairFiles { patchPath: string; homePatchPath: string }
export interface McpGroupRepairPlan {
  files: RepairFiles
  profileFingerprint: string
  homeFingerprint: string
  documentFingerprint: string
  before: McpIdentity
  after: McpIdentity
  groups: { id: string; name: string }[]
}

async function readContext(home: string, files: RepairFiles) {
  const [profile, global, document] = await Promise.all([
    readPatchSnapshot(files.patchPath), readPatchSnapshot(files.homePatchPath), loadPanelDocument(home),
  ])
  if (!document.writable) throw new Error(document.warning ?? '分组配置不可写，请先修复 config.json')
  const info = await lstat(configFile(home))
  if (!info.isFile()) throw new Error('config.json 必须是普通文件；符号链接请手工编辑')
  const bytes = await readFile(configFile(home))
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new Error('config.json 不是有效 UTF-8，请先修复原文件')
  if (patchFingerprint(bytes.toString('utf8')) !== document.fingerprint) throw new Error('分组配置已变化，请重新预览')
  const profilePatch = parsePatchText(profile.text), homePatch = parsePatchText(global.text)
  if (!profilePatch.ok || !homePatch.ok) throw new Error('profile/home patch YAML 非法，无法确认身份；未修复')
  // Inspect on-disk definitions, independently of loader readiness. Keep even
  // shadowed identities present: absence in the UI alone cannot justify repair.
  const rows = [...profilePatch.rows, ...homePatch.rows].flatMap(row =>
    row.id !== undefined && typeof row.config?.serverName === 'string' &&
    (row.name === MCP_MODULE || row.name === undefined) ? [{ entryId: row.id, serverName: row.config.serverName }] : [])
  return { profile, global, document, profileRows: profilePatch.rows, homeRows: homePatch.rows, rows }
}

function assertTarget(context: Awaited<ReturnType<typeof readContext>>, target: McpIdentity): void {
  const definitions = context.profileRows.filter(row => row.id === target.entryId && row.name === MCP_MODULE)
  const related = context.profileRows.filter(row => row.id === target.entryId)
  if (definitions.length !== 1 || related.length !== 1 || definitions[0]?.config?.serverName !== target.serverName ||
      context.homeRows.some(row => row.id === target.entryId) ||
      context.rows.filter(row => row.serverName === target.serverName).length !== 1) {
    throw new Error('修复目标必须是当前 profile 中可唯一确认的服务器，不能有 home 覆盖/重复/外来覆盖')
  }
}

export async function prepareMcpGroupRepair(home: string, files: RepairFiles, before: McpIdentity, after: McpIdentity): Promise<McpGroupRepairPlan> {
  before = { serverName: before.serverName, entryId: before.entryId }
  after = { serverName: after.serverName, entryId: after.entryId }
  const context = await readContext(home, files)
  assertTarget(context, after)
  repairMcpMember(context.document.config.mcpGroups, files.patchPath, before, after, context.rows)
  return { files: { patchPath: files.patchPath, homePatchPath: files.homePatchPath }, before, after,
    profileFingerprint: context.profile.fingerprint, homeFingerprint: context.global.fingerprint,
    documentFingerprint: context.document.fingerprint,
    groups: mcpGroupIds(context.document.config.mcpGroups, files.patchPath, before).map(id => ({ id, name: context.document.config.mcpGroups[id]!.name })) }
}

export async function commitMcpGroupRepair(home: string, plan: McpGroupRepairPlan, backupRoot: string) {
  const check = async () => {
    const current = await readContext(home, plan.files)
    if (current.profile.fingerprint !== plan.profileFingerprint || current.global.fingerprint !== plan.homeFingerprint ||
        current.document.fingerprint !== plan.documentFingerprint) throw new Error('文件已变化，请重新预览修复；未覆盖外部改动')
    assertTarget(current, plan.after)
    const ids = mcpGroupIds(current.document.config.mcpGroups, plan.files.patchPath, plan.before).sort()
    if (JSON.stringify(ids) !== JSON.stringify(plan.groups.map(group => group.id).sort()) || ids.length === 0) throw new Error('旧引用所属分组已变化，请重新预览')
    repairMcpMember(current.document.config.mcpGroups, plan.files.patchPath, plan.before, plan.after, current.rows)
    return current
  }
  const context = await check()
  const result = await updateMcpGroups(home, plan.files.patchPath,
    groups => repairMcpMember(groups, plan.files.patchPath, plan.before, plan.after, context.rows), undefined,
    { expectedDocument: plan.documentFingerprint, backupRoot: join(backupRoot, 'mcp-group-repair'), validate: async () => { await check() } })
  return { config: result.config, warning: result.warning, backupPath: result.backupPath }
}
