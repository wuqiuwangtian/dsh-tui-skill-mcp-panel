/**
 * Full-screen manager: skill writes, panel-owned MCP CRUD, and diagnostics.
 *
 * Interaction model:
 * - keyboard is primary and sufficient: ↑/↓ select, ←/→ switch scope,
 *   Tab switches pages, Enter opens detail on narrow terminals;
 * - mouse is additive where the host routes events (fullscreen): click tabs /
 *   scope / rows, wheel scrolls the list, detail or diagnostics pane.
 * Host dialogs/toasts remain unusable from plugin scenes (docs/research/05).
 */
import type { ComponentType, ReactNode } from 'react'
import { basename, dirname, isAbsolute } from 'node:path'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { groupMemberCount } from '../domain/groups.js'
import { describeMcpConfig, type McpRowView } from '../domain/mcp/patch.js'
import { configChanges, fieldDisplay, fieldInput, patchMcpField, validateMcpConfig, type McpConfig, type McpField } from '../domain/mcp/model.js'
import type { McpEditSession } from '../domain/mcp/crud.js'
import { filterMcpRows, groupsForMcpProfile, mcpGroupIds, mcpMemberKey, type McpStatusFilter } from '../domain/mcp/groups.js'
import { splitFrontmatter } from '../domain/skills/frontmatter.js'
import type { SkillInstance, SkillScanResult, SkillSource, SkillStatus } from '../domain/skills/types.js'
import type { ManagerRuntime, ManagerState } from '../host/manager-runtime.js'
import { cellWidth, firstLines, inputTail, oneLine, padToWidth, truncateToWidth, wrapTextLines } from '../shared/format.js'

const SKILL_ACTIONS = [
  ['toggle', '空格 启停', '␣启停'], ['mark', 'v 标记', 'v标记'], ['delete', 'd 删除', 'd删除'],
  ['undo', 'u 撤销', 'u撤销'], ['create', 'a 添加', 'a添加'], ['group', 'g 分组', 'g分组'],
  ['search', '/ 搜索', '/搜索'], ['clear', 'x 清除', 'x清除'], ['refresh', 'r 刷新', 'r刷新'], ['help', '? 帮助', '?'],
] as const
const GROUP_ACTIONS = [
  ['create', 'a 新建', 'a新建'], ['rename', 'r 重命名', 'r改名'], ['delete', 'd 删除', 'd删除'],
  ['filter', '↵ 过滤', '↵过滤'], ['clear', 'x 清除', 'x清除'], ['kind', 't 技能/MCP', 't切换'], ['refresh', 'R 刷新', 'R刷新'], ['help', '? 帮助', '?'],
] as const
const DIAG_ACTIONS = [['refresh', 'r 刷新', 'r刷新'], ['help', '? 帮助', '?']] as const

const MCP_STATUSES: Record<McpStatusFilter, string> = { all: '全部', enabled: '启用', disabled: '停用', failed: '失败' }
const MCP_ACTIONS = [
  ['toggle', '空格 启停', '␣启停'], ['create', 'a 新增', 'a新增'], ['edit', '↵ 编辑', '↵编辑'],
  ['delete', 'd 删除', 'd删除'], ['undo', 'u 撤销', 'u撤销'], ['group', 'g 分组', 'g分组'],
  ['filter', 'f 筛选', 'f筛选'], ['search', '/ 搜索', '/搜索'], ['clear', 'x 清除', 'x清除'],
  ['detail', 'i 详情', 'i详情'],
  ['refresh', 'r 刷新', 'r刷新'], ['help', '? 帮助', '?'],
] as const

function packActions<T extends { label: string }>(items: T[], width: number): T[][] {
  const lines: T[][] = [[]]
  let cells = 0
  for (const item of items) {
    const size = cellWidth(`[${item.label}] `)
    if (cells > 0 && cells + size > width) { lines.push([]); cells = 0 }
    lines[lines.length - 1]!.push(item)
    cells += size
  }
  return lines
}

interface NavigationKey { upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean }
function textOffset(key: NavigationKey, char: string, current: number, total: number, pageRows: number): number | undefined {
  const max = Math.max(0, total - pageRows)
  const at = Math.min(current, max)
  if (key.home) return 0
  if (key.end) return max
  if (key.upArrow || char === 'k') return Math.max(0, at - 1)
  if (key.downArrow || char === 'j') return Math.min(max, at + 1)
  if (key.pageUp) return Math.max(0, at - pageRows)
  if (key.pageDown) return Math.min(max, at + pageRows)
  return undefined
}

const displayLine = (text: string, width: number): string => truncateToWidth(text.replace(/[\r\n\t]/gu, ' '), width)

const TABS = ['skills', 'mcp', 'groups', 'diagnostics'] as const
type Tab = (typeof TABS)[number]

const TAB_LABELS: Record<Tab, string> = {
  skills: 'Skills 技能',
  mcp: 'MCP',
  groups: 'Groups 分组',
  diagnostics: 'Diagnostics 诊断',
}

const TAB_LABELS_NARROW: Record<Tab, string> = {
  skills: '技能',
  mcp: 'MCP',
  groups: '分组',
  diagnostics: '诊断',
}

const SCOPE_FILTERS = ['all', 'workspace', 'global'] as const
type ScopeFilter = (typeof SCOPE_FILTERS)[number]

const SCOPE_LABELS: Record<ScopeFilter, string> = {
  all: '全部',
  workspace: '工作区',
  global: '全局',
}

const SOURCE_LABELS: Record<SkillSource, string> = {
  'project-dsh': 'project/.dsh',
  'project-agents': 'project/.agents',
  custom: 'custom',
  'user-dsh': 'user/~/.dsh',
  'user-agents': 'user/~/.agents',
  bundled: 'bundled',
}

const STATUS_LABELS: Record<SkillStatus, string> = {
  enabled: '启用',
  disabled: '停用',
  invalid: '无效',
}

const STATUS_GLYPHS: Record<SkillStatus, string> = {
  enabled: '●',
  disabled: '○',
  invalid: '!',
}

const HELP_LINES = [
  '快捷键 Keys（键盘足够用，鼠标是额外增强）',
  '  ↑/↓ / j k          当前区域选择 / 滚动',
  '  ←/→ / h l          跨区域移动焦点；页签栏上切换页签',
  '                      （内容区没有左右相邻区域时——分组/MCP/诊断——直接切页签）',
  '  Tab / Shift+Tab     切换页签；数字 1-4 直达',
  '  Enter              进入详情；分组页应用分组过滤',
  '  空格               启用/停用选中技能（有标记时批量）',
  '  v                  标记/取消标记当前技能（批量操作用）',
  '  d                  删除选中/标记技能（回收站，可撤销）',
  '  u                  撤销最近一次删除',
  '  a                  添加技能（本地路径导入）',
  '  g                  把选中/标记技能加入或移出分组',
  '  x                  清除分组过滤 / 清除标记',
  '  MCP 页              ↑/↓ 选择 · 空格 启停（仅改 disabled）· r 重新读取 · m 迁移旧启停配置',
  '                     a 新增 · Enter 编辑 · d 删除 · u 撤销（仅本面板受管行）',
  '                     home/表达式行只读；已有 profile 行仅支持启停',
  '                     g 加入/移出分组 · f 状态/分组筛选 · / 搜索元数据 · x 清除 MCP 过滤',
  '                     i 完整详情（只读、敏感值隐藏）；详情内 ↑/↓、PgUp/PgDn、Home/End',
  '  分组页             t 切换技能/MCP · a 新建 · r 重命名 · d 删除组 · Enter 过滤',
  '  MCP 表单           逐字段 Enter 编辑；args 使用 JSON 数组；Ctrl+U 清空当前输入',
  '                     env/headers 每行 KEY=VALUE；Shift+Enter 换行；留空保留、-KEY 删除、! 清空',
  '  /                  搜索（Enter/Esc 退出搜索）',
  '  Home / End         列表首尾；详情/帮助首尾；PgUp/PgDn 翻页',
  '  r                  重新扫描磁盘',
  '  ?                  本帮助',
  '  Esc / q            返回 / 关闭（搜索、帮助、详情、标记逐层退出）',
  '',
  '鼠标（仅 fullscreen 布局下）',
  '  点击页签/作用域/技能行切换与选择；滚轮滚动列表、详情与诊断页。',
  '  底部动作条 [启停]/[删除]/[添加]/[分组]… 可直接点击；确认/输入模态的按钮也可点击，',
  '  鼠标与键盘的操作范围一致（输入文字仍用键盘）。',
  '',
  '已知限制 Limits',
  '  · MCP 没有工作区级配置：只有当前 profile + home 全局层。',
  '  · 技能只发现一层：<root>/<name>/SKILL.md 或 <root>/<name>.md。',
  '  · 场景内不使用宿主对话框/toast（实测不可用），确认与输入均为自绘。',
  '  · 迁移/复制、zip 导入为 P1；MCP 分组按 profile 隔离，只改显示层。',
]


const MCP_SCOPE_NOTICE = '无工作区级配置 · 当前 profile 可写 · home 全局层只读'

const GROUPS_PLACEHOLDER_LINES = [
  '分组是显示层元数据，不写技能目录。',
  '技能分组与 web 版共享 groups.json（v1），MCP 分组存本插件配置。',
  'M1 先落地技能只读列表/详情。',
]

interface SceneUi {
  Box: TuiSceneProps['ui']['Box']
  Text: TuiSceneProps['ui']['Text']
  useInput: TuiSceneProps['ui']['useInput']
  useTerminalSize: TuiSceneProps['ui']['useTerminalSize']
}

interface WheelLike {
  deltaY: number
}

interface ClickLike {
  stopImmediatePropagation(): void
}

function statusFlags(instance: SkillInstance): string {
  const flags: string[] = []
  if (instance.status === 'disabled') flags.push('停用')
  else if (instance.status === 'invalid') flags.push('无效')
  else if (instance.effective) flags.push('生效')
  else if (instance.shadowedBy !== undefined) flags.push('被遮蔽')
  if (instance.modelInvocable === false) flags.push('模型不可调用')
  if (instance.userInvocable === false) flags.push('用户不可调用')
  return flags.join(' ')
}

function sortInstances(instances: SkillInstance[]): SkillInstance[] {
  return [...instances].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      Number(right.effective) - Number(left.effective) ||
      left.rank - right.rank ||
      left.providerOrder - right.providerOrder,
  )
}

function filterInstances(scan: SkillScanResult | undefined, scope: ScopeFilter, query: string): SkillInstance[] {
  if (scan === undefined) return []
  const needle = query.trim().toLowerCase()
  return sortInstances(
    scan.instances.filter((instance) => {
      if (scope !== 'all' && instance.scope !== scope) return false
      if (needle.length === 0) return true
      return (
        instance.name.toLowerCase().includes(needle) ||
        instance.description.toLowerCase().includes(needle)
      )
    }),
  )
}

function counts(scan: SkillScanResult | undefined): {
  total: number
  enabled: number
  disabled: number
  invalid: number
  shadowed: number
  workspace: number
  global: number
} {
  const instances = scan?.instances ?? []
  return {
    total: instances.length,
    enabled: instances.filter((instance) => instance.status === 'enabled').length,
    disabled: instances.filter((instance) => instance.status === 'disabled').length,
    invalid: instances.filter((instance) => instance.status === 'invalid').length,
    shadowed: instances.filter((instance) => instance.shadowedBy !== undefined).length,
    workspace: instances.filter((instance) => instance.scope === 'workspace').length,
    global: instances.filter((instance) => instance.scope === 'global').length,
  }
}

function diagnosticLines(state: ManagerState, width: number): string[] {
  const scan = state.scan
  const lines: string[] = []
  const push = (line: string): void => {
    lines.push(displayLine(line, width))
  }
  push('宿主能力 Host seams')
  const present = state.services.filter((service) => service.present).map((service) => service.name)
  const missing = state.services.filter((service) => !service.present).map((service) => service.name)
  push(`  present: ${present.join(', ') || '(none)'}`)
  push(`  missing: ${missing.join(', ') || '(none)'}`)
  push('')
  push('路径 Paths')
  push(`  cwd: ${scan?.cwd ?? process.cwd()}`)
  push(`  DSH_HOME: ${scan?.dshHome ?? process.env.DSH_HOME ?? '(default)'}`)
  push(`  AGENTS_HOME: ${scan?.agentsHome ?? process.env.DSH_AGENTS_HOME ?? '(default)'}`)
  push(`  projectRoot: ${scan?.projectRoot ?? '(pending)'}`)
  push(`  settings patch: ${state.paths.settingsDocument ?? '(unavailable)'}`)
  push(`  configEditor patch: ${state.paths.configEditorDocument ?? '(unavailable)'}`)
  push(`  home patch: ${state.paths.homePatch}`)
  push(`  dump: ${state.dumpPath ?? '(set SKILL_MCP_PANEL_DUMP to enable)'}`)
  if (state.sceneError !== undefined) push(`  scene error: ${state.sceneError}`)
  if (state.dumpMessage !== undefined) push(`  dump message: ${state.dumpMessage}`)
  push('')
  push('共享技能分组（groups.json v1）')
  push(`  文件：${state.paths.skillGroupsFile ?? '(unknown)'}`)
  push(`  写入状态：${state.groupsWritable === true ? '可写（快照保护）' : '只读或未就绪'}`)
  if (state.groupsWarning !== undefined) push(`  警告：${state.groupsWarning}`)
  if (state.groupsBackupPath !== undefined) push(`  上次写前备份：${state.groupsBackupPath}`)
  push('  web 2.3.7 不使用分组锁；外部变化时按 R 刷新，不强制覆盖')
  push('')
  push('MCP（当前 profile patch + home 层 + loader）')
  push(`  profile patch: ${state.mcp.profilePatchPath ?? '(unknown)'}`)
  push(`  home patch: ${state.mcp.homePatchPath ?? '(unknown)'}`)
  push(`  rows: ${state.mcp.rows.length} · 读取于 ${state.mcp.loadedAt ?? '(pending)'}`)
  if (state.configWarning !== undefined) push(`  显示配置警告：${state.configWarning}`)
  push(`  当前 profile 的 MCP 分组：${state.mcp.profilePatchPath === undefined ? 0 : Object.keys(groupsForMcpProfile(state.config.mcpGroups, state.mcp.profilePatchPath)).length}`)
  if (state.mcp.latestDeletion !== undefined) push(`  可撤销 MCP 删除：${state.mcp.latestDeletion.serverName} · ${state.mcp.latestDeletion.createdAt}（MCP 页 u）`)
  for (const error of state.mcp.errors) push(`  错误：${error}`)
  for (const warning of state.mcp.warnings) push(`  警告：${warning}`)
  if (state.mcp.lastAction !== undefined) {
    const action = state.mcp.lastAction
    push(
      `  最近 MCP 操作：${action.outcome} ${action.serverName ?? action.id}${action.detail === undefined ? '' : `（${action.detail}）`}`,
    )
  }
  push('')
  push('发现根 Discovery roots（rank 小者优先）')
  for (const root of scan?.roots ?? []) {
    push(`  [${root.rank}] ${root.source} ${root.scope} ${root.exists ? '存在' : '缺失'} ${root.path}`)
  }
  if (scan === undefined) push('  (扫描中…)')
  push('')
  if (scan !== undefined) {
    const summary = counts(scan)
    push(
      `统计 total=${summary.total} enabled=${summary.enabled} disabled=${summary.disabled} invalid=${summary.invalid} shadowed=${summary.shadowed} workspace=${summary.workspace} global=${summary.global}`,
    )
    push(`扫描时间 ${scan.scannedAt} · 原因 ${state.refreshReason ?? '-'}`)
    push('')
  }
  const warnings = scan?.warnings ?? []
  push(`警告 Warnings (${warnings.length})`)
  for (const warning of warnings.slice(0, 20)) push(`  · ${warning}`)
  if (warnings.length > 20) push(`  … 共 ${warnings.length} 条，完整内容见 JSON dump`)
  push('')
  push('说明 Notes')
  push('  · MCP 没有工作区级配置：只有当前 profile + home 全局层（M3 实现）。')
  push('  · 技能发现规则与 DSH 内核一致；本页结果由插件自行扫盘，非 ctx.skills。')
  push('  · customSkillDirs 无法从宿主层读取，当前按未配置处理（未列出的自定义根会被漏掉）。')
  push('  · 只覆盖文件来源；运行期注册（runtime/agent scope）的技能不在扫盘结果内。')
  return lines
}

function skillDetailLines(instance: SkillInstance | undefined, state: ManagerState, width: number): string[] {
  if (instance === undefined) {
    return ['（未选择技能）', '', '用 ↑/↓ 选择左侧列表中的技能。']
  }
  const lines: string[] = []
  const push = (line: string): void => {
    lines.push(displayLine(line, width))
  }
  push(
    `状态 ${STATUS_LABELS[instance.status]} · 来源 ${SOURCE_LABELS[instance.source]} · rank ${instance.rank} · ${instance.scope === 'workspace' ? '工作区' : '全局'}`,
  )
  if (instance.shadowedBy !== undefined) push(`被遮蔽 by ${instance.shadowedBy}`)
  push(`形态 ${instance.form === 'directory' ? '目录束' : '平铺 .md'} · ${instance.effective ? '内核可见' : '内核不可见'}`)
  push(`文件 ${instance.path}`)
  push(`根 ${instance.rootPath}`)
  if (instance.modelInvocable === false) push('模型不可调用（disable-model-invocation）')
  if (instance.userInvocable === false) push('用户不可调用（user-invocable: false）')
  if (instance.invalidReason !== undefined) push(`无效原因 ${instance.invalidReason}`)
  if (instance.whenToUse !== undefined && instance.whenToUse.length > 0) {
    push(`whenToUse ${oneLine(instance.whenToUse, width - 12)}`)
  }
  push(`description ${oneLine(instance.description, width - 13)}`)
  const metadataKeys = instance.metadata === undefined ? [] : Object.keys(instance.metadata)
  if (metadataKeys.length > 0) push(`metadata keys ${metadataKeys.join(', ')}`)
  push('')
  push('正文 Body（只读）')
  const content = state.detail.id === instance.id ? state.detail.content : undefined
  if (state.detail.id === instance.id && state.detail.status === 'loading' && content === undefined) {
    push('  (读取中…)')
    return lines
  }
  if (state.detail.id === instance.id && state.detail.status === 'error') {
    push(`  读取失败：${state.detail.error ?? 'unknown'}`)
    return lines
  }
  const raw = content ?? instance.bodyPreview ?? ''
  const split = splitFrontmatter(raw)
  const body = split?.body ?? raw
  const preview = firstLines(body, 401)
  for (const line of preview.slice(0, 400)) push(`  ${line}`)
  if (preview.length > 400) push('（仅预览前400行；完整正文请查看技能文件）')
  return lines
}


type FocusArea = 'tabs' | 'scope' | 'list' | 'detail' | 'body'

const HELP_HINTS = '? 帮助'

type Modal =
  | { kind: 'confirm'; title: string; message: string[]; danger?: boolean; onConfirm: () => void; onCancel?: () => void }
  | { kind: 'input'; title: string; label: string; value: string; hint?: string; secret?: boolean; multiline?: boolean; preserveWhitespace?: boolean; validate?: (value: string) => string | undefined; onSubmit: (value: string) => void; onCancel?: () => void }
  | { kind: 'select'; title: string; options: { id: string; label: string; hint?: string }[]; index: number; onSubmit: (id: string) => void; onCancel?: () => void }
  | { kind: 'info'; title: string; lines: string[] }

function mcpDetailLines(row: McpRowView | undefined, width: number): string[] {
  if (row === undefined) {
    return ['（未选择 MCP 行）', '', '按 a 新增 MCP；仅本面板受管行支持编辑/删除，已有 profile 行可启停。']
  }
  const lines: string[] = []
  const push = (line: string): void => {
    lines.push(displayLine(line, width))
  }
  push(`id ${row.id} · entryId ${row.entryId} · 层 ${row.layer}`)
  push(
    `serverName ${row.serverName} · transport ${row.transport} · ${row.enabled ? '启用' : '停用'}${row.phase === undefined ? '' : ` · ${row.phase}`}`,
  )
  if (row.overriddenByHome) push('home 层覆盖同名 profile 行（只读）')
  if (row.disabledExpression !== undefined) push(`disabled 表达式 !!js ${row.disabledExpression}`)
  if (row.readOnlyReason !== undefined) push(`只读：${row.readOnlyReason}`)
  if (row.managed) push('本面板受管行：Enter 编辑 · d 删除 · u 撤销')
  else if (row.editReadOnlyReason !== undefined) push(row.editReadOnlyReason)
  for (const note of row.notes) push(`· ${note}`)
  push('')
  push('配置（敏感值已脱敏）')
  for (const line of describeMcpConfig(row.config)) push(`  ${line}`)
  return lines
}

export function createManagerScene(runtime: ManagerRuntime, sceneId: string): ComponentType<TuiSceneProps> {
  return function ManagerScene({ React, ui, close }: TuiSceneProps): ReturnType<typeof ui.Box> {
    const sceneUi = ui as unknown as SceneUi
    const { Box, Text, useInput, useTerminalSize } = sceneUi
    const { columns, rows } = useTerminalSize()
    const tooSmall = columns < 40 || rows < 16
    const [, forceRender] = React.useReducer((value: number) => value + 1, 0)
    const [tab, setTab] = React.useState<Tab>('skills')
    const [scope, setScope] = React.useState<ScopeFilter>('all')
    const [query, setQuery] = React.useState('')
    const [searchMode, setSearchMode] = React.useState(false)
    const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined)
    const previousSelected = React.useRef<SkillInstance | undefined>(undefined)
    const [helpOpen, setHelpOpen] = React.useState(false)
    const [helpOffset, setHelpOffset] = React.useState(0)
    const [modalOffset, setModalOffset] = React.useState(0)
    const [focus, setFocus] = React.useState<FocusArea>('list')
    const [diagOffset, setDiagOffset] = React.useState(0)
    const [detailOffset, setDetailOffset] = React.useState(0)
    const [marked, setMarked] = React.useState<Set<string>>(() => new Set())
    const [groupFilter, setGroupFilter] = React.useState<string | undefined>(undefined)
    const [groupSelectedId, setGroupSelectedId] = React.useState<string | undefined>(undefined)
    const [modal, setModal] = React.useState<Modal | undefined>(undefined)
    const [mcpSelectedId, setMcpSelectedId] = React.useState<string | undefined>(undefined)
    const [mcpQuery, setMcpQuery] = React.useState('')
    const [mcpStatus, setMcpStatus] = React.useState<McpStatusFilter>('all')
    const [mcpGroupFilter, setMcpGroupFilter] = React.useState<string | undefined>(undefined)
    const [groupKind, setGroupKind] = React.useState<'skills' | 'mcp'>('skills')

    React.useEffect(() => runtime.subscribe(forceRender), [])
    React.useEffect(() => {
      void runtime.ensureFresh()
    }, [])

    const state = runtime.snapshot()
    const scan = state.scan
    const summary = counts(scan)
    const scopeCounts: Record<ScopeFilter, number> = {
      all: summary.total,
      workspace: summary.workspace,
      global: summary.global,
    }
    const scopeKeyOf = (instance: SkillInstance): string =>
      instance.scope === 'global' ? 'global' : (scan?.projectRoot ?? 'workspace')
    const baseFiltered = filterInstances(scan, scope, query)
    const filtered =
      groupFilter === undefined
        ? baseFiltered
        : baseFiltered.filter((instance) => {
            const group = state.groups[groupFilter]
            if (group === undefined) return false
            return (group.scopes[scopeKeyOf(instance)] ?? []).includes(instance.name)
          })
    const previous = previousSelected.current
    const toggledPath = previous === undefined ? undefined
      : previous.path.endsWith('.disabled') ? previous.path.slice(0, -'.disabled'.length) : `${previous.path}.disabled`
    // Scan IDs include the physical path. A toggle renames that path, while
    // this remains the same selected source file; exact IDs still win if both exist.
    const selected = filtered.find((instance) => instance.id === selectedId)
      ?? (previous !== undefined && previous.id === selectedId ? filtered.find((instance) => instance.source === previous.source && instance.path === toggledPath) : undefined)
      ?? filtered[0]
    const selectedIndex = Math.max(
      0,
      filtered.findIndex((instance) => instance.id === selected?.id),
    )
    const groupEntries = Object.entries(state.groups).sort((left, right) => left[1].name.localeCompare(right[1].name))
    const profilePath = state.mcp.profilePatchPath
    const profileGroups = profilePath === undefined ? {} : groupsForMcpProfile(state.config.mcpGroups, profilePath)
    const mcpGroupEntries = Object.entries(profileGroups).sort((left, right) => left[1].name.localeCompare(right[1].name))
    const groupListEntries = groupKind === 'skills'
      ? groupEntries.map(([id, group]) => ({ id, name: group.name, count: groupMemberCount(group), visible: (group.scopes[scan?.projectRoot ?? 'workspace'] ?? []).length + (group.scopes.global ?? []).length }))
      : mcpGroupEntries.map(([id, group]) => ({ id, name: group.name, count: group.members.length,
        visible: state.mcp.rows.filter((row) => group.members.includes(mcpMemberKey(row))).length }))
    const selectedGroupId = groupListEntries.some((group) => group.id === groupSelectedId) ? groupSelectedId : groupListEntries[0]?.id
    const selectedGroupIndex = Math.max(
      0,
      groupListEntries.findIndex((group) => group.id === selectedGroupId),
    )
    const mcpRows = filterMcpRows(state.mcp.rows, { query: mcpQuery, status: mcpStatus, groupId: mcpGroupFilter, profilePath, groups: state.config.mcpGroups })
    const selectedMcp = mcpRows.find((row) => row.id === mcpSelectedId) ?? mcpRows[0]
    const selectedMcpIndex = Math.max(
      0,
      mcpRows.findIndex((row) => row.id === selectedMcp?.id),
    )

    React.useEffect(() => {
      previousSelected.current = selected
      if (selected === undefined) {
        if (selectedId !== undefined) setSelectedId(undefined)
        return
      }
      if (selected.id !== selectedId) setSelectedId(selected.id)
      void runtime.loadDetail(selected)
    }, [selected?.id])

    React.useEffect(() => {
      setDetailOffset(0)
    }, [selected?.id])
    React.useEffect(() => { setModalOffset(0) }, [modal?.kind, modal?.title])

    React.useEffect(() => {
      if (groupFilter !== undefined && state.groups[groupFilter] === undefined) setGroupFilter(undefined)
    }, [groupFilter, state.groups])
    React.useEffect(() => {
      if (mcpGroupFilter !== undefined && profileGroups[mcpGroupFilter] === undefined) setMcpGroupFilter(undefined)
    }, [mcpGroupFilter, state.config.mcpGroups, profilePath])

    // ── layout metrics ──────────────────────────────────────────────────────
    const contentWidth = Math.max(20, columns - 2)
    const wide = columns >= 110
    const twoPane = columns >= 72
    const narrow = !twoPane
    const fullActions = columns >= 110
    const skillActions = narrow && focus === 'detail'
      ? [...SKILL_ACTIONS, ['back', 'Esc 返回', '←返回'] as const] : SKILL_ACTIONS
    const mcpActions = (state.mcp.legacyToggles?.length ?? 0) > 0
      ? [...MCP_ACTIONS, ['migrate', 'm 迁移旧启停', 'm迁移'] as const] : MCP_ACTIONS
    const actionDefinitions = tab === 'skills' ? skillActions : tab === 'mcp' ? mcpActions : tab === 'groups' ? GROUP_ACTIONS : DIAG_ACTIONS
    const actionLabels = actionDefinitions.map(([, full, short]) => ({ label: fullActions ? full : short }))
    const extraFooterRows = packActions(actionLabels, contentWidth).length - 1
    const statusText =
      state.statusMessage?.text ??
      (state.status === 'error' ? `错误：${state.error ?? 'unknown'}` : state.groupsWarning ?? state.configWarning ?? state.dumpMessage)
    const statusTone = state.statusMessage?.tone ?? (state.status === 'error' ? 'error' : 'info')
    const cardsHeight = Math.max(
      5,
      rows - 4 - extraFooterRows - (tab === 'skills' && !wide ? 1 : 0) - (statusText === undefined ? 0 : 1),
    )
    const bodyRows = Math.max(2, cardsHeight - 3)
    const scopeCardWidth = 22
    const gap = 1
    const listWidth = wide
      ? Math.max(24, Math.floor((contentWidth - scopeCardWidth - gap * 2) * 0.5))
      : twoPane
        ? Math.max(24, Math.floor((contentWidth - gap) / 2))
        : contentWidth
    const detailWidth = wide
      ? Math.max(24, contentWidth - scopeCardWidth - gap * 2 - listWidth)
      : twoPane
        ? Math.max(24, contentWidth - gap - listWidth)
        : contentWidth
    const listInner = listWidth - 6
    const nameWidth = Math.max(8, Math.min(28, listInner - 22))
    const detailLines = skillDetailLines(selected, state, detailWidth - 4)
    const detailAt = Math.min(detailOffset, Math.max(0, detailLines.length - bodyRows))
    const bodyLines = diagnosticLines(state, contentWidth - 4)
    const diagAt = Math.min(diagOffset, Math.max(0, bodyLines.length - bodyRows))
    const helpLines = wrapTextLines(HELP_LINES, contentWidth)
    const helpRows = Math.max(1, rows - 6)
    const helpAt = Math.min(helpOffset, Math.max(0, helpLines.length - helpRows))
    const modalWidth = Math.max(20, Math.min(contentWidth, 100))
    const modalRows = Math.max(1, rows - 9)
    const modalLines = modal?.kind === 'confirm' ? wrapTextLines(modal.message, modalWidth - 4)
      : modal?.kind === 'info' ? wrapTextLines(modal.lines, modalWidth - 4) : []
    const modalAt = Math.min(modalOffset, Math.max(0, modalLines.length - modalRows))

    // ── shared actions ──────────────────────────────────────────────────────
    const targetInstances = (): SkillInstance[] =>
      marked.size > 0
        ? filtered.filter((instance) => marked.has(instance.id))
        : selected === undefined
          ? []
          : [selected]

    const clearMarks = (): void => setMarked(new Set())

    const runToggle = (): void => {
      const targets = targetInstances()
      if (targets.length === 0) {
        runtime.setStatus('没有可切换的技能', 'warning')
        return
      }
      void runtime.toggleSkills(targets)
      clearMarks()
    }

    const askDelete = (): void => {
      const targets = targetInstances()
      if (targets.length === 0) {
        runtime.setStatus('没有可删除的技能', 'warning')
        return
      }
      setModal({
        kind: 'confirm',
        title: '删除技能',
        danger: true,
        message: [
          `将移入回收站（可撤销）：共 ${targets.length} 个`,
          '↑/↓ 滚动 · PgUp/PgDn 翻页 · Home/End 首尾',
          ...targets.flatMap((instance, index) => [
            '',
            `${index + 1}. ${instance.name}`,
            `作用域：${SCOPE_LABELS[instance.scope]} · 来源：${SOURCE_LABELS[instance.source]}`,
            instance.form === 'directory' ? `删除目录：${instance.locatorDir}` : `删除文件：${instance.skillFile}`,
            ...(instance.form === 'directory' ? [`技能文件：${instance.skillFile}`] : []),
          ]),
        ],
        onConfirm: () => {
          void runtime.deleteSkillInstances(targets)
          clearMarks()
        },
      })
    }

    const runUndoSkills = (): void => {
      void (async () => {
        const outcome = await runtime.undoLastDelete()
        const entry = outcome?.conflictEntries?.[0]
        if (entry === undefined || outcome?.batchId === undefined) return
        const batchId = outcome.batchId
        const otherScope = entry.scope === 'global' ? 'workspace' : 'global'
        const showChoices = (): void => setModal({
          kind: 'select', title: `恢复冲突 · ${entry.name}`, index: 0,
          options: [
            { id: 'cancel', label: '取消（保留回收站与占用对象）' },
            { id: 'replace', label: '覆盖前备份，再恢复到原位置…' },
            { id: 'scope', label: `恢复到${SCOPE_LABELS[otherScope]}…` },
          ],
          onSubmit: (choice) => {
            if (choice === 'cancel') return
            void (async () => {
              const session = await runtime.openSkillRecovery(batchId, entry.entryId, choice === 'replace' ? 'replace' : 'scope', otherScope)
              if (session === undefined) {
                setModal({ kind: 'info', title: '无法准备恢复', lines: [runtime.snapshot().statusMessage?.text ?? '请重新按 u 并检查恢复记录'] })
                return
              }
              setModal({ kind: 'confirm', title: '确认恢复技能', danger: choice === 'replace',
                message: [`技能：${session.entry.name}`, `原作用域：${SCOPE_LABELS[session.entry.scope as 'global' | 'workspace']}`,
                  `回收站：${session.entry.trashPath}`, `恢复到：${session.destination}`,
                  ...(session.backupDir === undefined ? ['目标作用域不同，原占用对象保留；目标已存在或同名时拒绝。']
                    : [`覆盖前备份：${session.backupDir}/entity`, '确认后先复制并校验备份，再移走占用对象；备份失败不开始替换。']),
                  '写入前重查源、目标和清单；发生变化会停止。其他冲突保持原状。'],
                onCancel: showChoices,
                onConfirm: () => {
                  void runtime.recoverSkill(session).then((result) => {
                    setModal({ kind: 'info', title: result === undefined ? '恢复未完成' : '恢复结果', lines: result === undefined
                      ? [`恢复到：${session.destination}`, `回收站：${session.entry.trashPath}`,
                        ...(session.backupDir ? [`计划备份位置：${session.backupDir}`] : []), runtime.snapshot().statusMessage?.text ?? '请检查恢复记录和备份']
                      : [`已恢复：${result.destination}`, ...(result.backupPath ? [`覆盖前备份：${result.backupPath}`] : []),
                        ...result.warnings, '其他冲突可关闭后按 u 继续处理。'] })
                  })
                },
              })
            })()
          },
        })
        showChoices()
      })()
    }

    const openAdd = (): void => {
      setModal({
        kind: 'input',
        title: '添加技能',
        label: '本地绝对路径（.md 文件，或包含 SKILL.md 的目录）',
        value: '',
        hint: '导入会把技能复制到所选作用域；不修改源路径。',
        validate: (value) => (isAbsolute(value.trim()) ? undefined : '请输入绝对路径'),
        onSubmit: (value) => {
          const sourcePath = value.trim()
          setModal({
            kind: 'select',
            title: '添加到哪个作用域？',
            options: [
              { id: 'workspace', label: '当前工作区', hint: scan?.projectRoot ?? '(pending)' },
              { id: 'global', label: '全局（~/.dsh/skills）' },
            ],
            index: 0,
            onSubmit: (id) => {
              void runtime.addSkillFromPath(sourcePath, id === 'global' ? 'global' : 'workspace')
            },
          })
        },
      })
    }

    const showMcpForm = (session: McpEditSession, config: McpConfig, index = 0): void => {
      const fields: McpField[] = ['serverName', 'transport',
        ...(config.transport === 'streamable-http' ? ['url', 'headers'] as const : ['command', 'args', 'cwd', 'env'] as const),
        'toolCallTimeoutMs', 'failOnStartupError']
      setModal({
        kind: 'select', title: session.id === undefined ? '新增 MCP' : `编辑 MCP · ${session.serverName}`,
        options: [...fields.map((field) => ({ id: field,
          label: oneLine(`${field}  ${fieldDisplay(config, field)}`, Math.max(20, contentWidth - 10)) })),
          { id: '__save__', label: '✓ 保存配置…', hint: '校验并确认变更字段' }],
        index: Math.min(index, fields.length),
        onSubmit: (selectedField) => {
          if (selectedField === '__save__') {
            try { validateMcpConfig(config) } catch (error) {
              runtime.setStatus(error instanceof Error ? error.message : '配置无效', 'error')
              showMcpForm(session, config, fields.length)
              return
            }
            const changed = configChanges(session.config, config)
            if (changed.length === 0 && session.id !== undefined) {
              runtime.setStatus('配置未变化', 'info')
              showMcpForm(session, config, fields.length)
              return
            }
            setModal({ kind: 'confirm', title: '保存 MCP 配置',
              message: [`${session.id === undefined ? '新增' : '修改'} ${String(config.serverName)} · ${String(config.transport)}`,
                `变更字段：${changed.join(', ') || '(默认配置)'}`,
                changed.some((field) => field === 'env' || field === 'headers') ? '包含敏感配置；值不显示，保存前备份。' : '保存前备份；现有连接可能重启，工具列表会更新。'],
              onCancel: () => showMcpForm(session, config, fields.length),
              onConfirm: () => { void runtime.saveMcpForm(session, config) } })
            return
          }
          const field = selectedField as McpField
          const position = fields.indexOf(field)
          if (field === 'transport') {
            setModal({ kind: 'select', title: 'MCP transport', index: config.transport === 'streamable-http' ? 1 : 0,
              options: [{ id: 'stdio', label: 'stdio · 本地进程' }, { id: 'streamable-http', label: 'streamable-http · HTTP(S)' }],
              onCancel: () => showMcpForm(session, config, position),
              onSubmit: (transport) => showMcpForm(session, { ...config, transport }, position) })
            return
          }
          const secret = field === 'env' || field === 'headers'
          setModal({ kind: 'input', title: `MCP ${field}`, label: field, value: fieldInput(config, field),
            secret, multiline: secret, preserveWhitespace: secret,
            hint: secret ? '每行 KEY=VALUE（支持 ${ENV}）；Shift+Enter 换行；留空保留、-KEY 删除、! 清空；值已隐藏' :
              field === 'args' ? 'JSON 数组，例如 ["--port", "3000"]；Ctrl+U 清空后重输' :
                'Ctrl+U 清空；已有 !!js 留空保留；Esc 返回表单',
            validate: (value) => { try { patchMcpField(config, field, value); return undefined } catch (error) { return error instanceof Error ? error.message : '字段格式无效' } },
            onSubmit: (value) => showMcpForm(session, patchMcpField(config, field, value), position),
            onCancel: () => showMcpForm(session, config, position),
          })
        },
      })
    }

    const openMcpForm = (id?: string): void => {
      void runtime.openMcpForm(id).then((session) => {
        if (session !== undefined) showMcpForm(session, session.config)
      })
    }

    const openMcpInfo = (): void => {
      if (selectedMcp === undefined) { runtime.setStatus('先选择 MCP 行', 'warning'); return }
      setModal({ kind: 'info', title: `MCP 详情 · ${selectedMcp.serverName}`,
        lines: mcpDetailLines(selectedMcp, Number.MAX_SAFE_INTEGER) })
    }

    const askMigrateMcp = (): void => {
      const expected = state.mcp
      const toggles = state.mcp.legacyToggles ?? []
      if (toggles.length === 0) { runtime.setStatus('没有待迁移的旧启停配置', 'info'); return }
      setModal({ kind: 'confirm', title: '迁移旧 MCP 启停配置',
        message: ['将保存的启停状态写回服务器定义，恢复 web/TUI 开关一致。',
          ...toggles.map(row => `${row.id} → ${row.disabled ? '停用' : '启用'}`),
          '写前备份；仅修改 disabled 并移除本插件旧覆盖；任一目标有歧义则整批停止。'],
        onConfirm: () => { void runtime.migrateMcpToggles(expected) } })
    }

    const askDeleteMcp = (): void => {
      if (selectedMcp === undefined) { runtime.setStatus('先选择 MCP 行', 'warning'); return }
      if (!selectedMcp.managed) { runtime.setStatus(selectedMcp.editReadOnlyReason ?? '仅能删除本面板受管行', 'warning'); return }
      const row = selectedMcp
      setModal({ kind: 'confirm', title: '删除 MCP', danger: true,
        message: [`删除 ${row.serverName}（${row.entryId} · ${row.layer}）？`,
          '连接会断开、工具会注销；写前备份并记录原文，可按 u 撤销。'],
        onConfirm: () => { void runtime.deleteMcp(row.id) } })
    }

    const openGroupPicker = (): void => {
      if (tab === 'mcp') {
        if (selectedMcp === undefined) { runtime.setStatus('先选择 MCP 行', 'warning'); return }
        const row = selectedMcp
        const memberships = mcpGroupIds(state.config.mcpGroups, profilePath ?? '', row)
        setModal({ kind: 'select', title: `MCP 分组 · ${row.serverName} (${row.entryId})`, index: 0,
          options: [...mcpGroupEntries.map(([id, group]) => ({ id, label: group.name,
            hint: memberships.includes(id) ? '已在组内 · 选择移出' : '选择加入' })),
            { id: '__new__', label: '＋ 新建 MCP 分组…' }, { id: '__manage__', label: '管理 MCP 分组…' }],
          onSubmit: (id) => {
            if (id === '__manage__') { setGroupKind('mcp'); goTab('groups'); return }
            if (id === '__new__') {
              setModal({ kind: 'input', title: '新建 MCP 分组', label: '分组名称', value: '',
                onSubmit: (name) => { void runtime.createMcpGroup(name, [row]) } })
              return
            }
            void runtime.setMcpGroupMembership(id, row, !memberships.includes(id))
          } })
        return
      }
      const targets = targetInstances()
      if (targets.length === 0) {
        runtime.setStatus('先选择一个技能', 'warning')
        return
      }
      const options: { id: string; label: string; hint?: string }[] = groupEntries.map(([id, group]) => {
        const allIn = targets.every((instance) => runtime.groupIdsFor(instance).includes(id))
        return {
          id,
          label: group.name,
          hint: `${groupMemberCount(group)} 个成员${allIn ? ' · 已全部在组内（选择移出）' : ''}`,
        }
      })
      options.push({ id: '__new__', label: '＋ 新建分组…' })
      setModal({
        kind: 'select',
        title: `分组（${targets.length} 个技能）`,
        options,
        index: 0,
        onSubmit: (id) => {
          if (id === '__new__') {
            setModal({
              kind: 'input',
              title: '新建分组',
              label: '分组名称',
              value: '',
              onSubmit: (name) => {
                void runtime.createGroup(name, targets)
              },
            })
            return
          }
          const allIn = targets.every((instance) => runtime.groupIdsFor(instance).includes(id))
          void runtime.setGroupMembershipForInstances(id, targets, !allIn)
        },
      })
    }

    const pressMark = (): void => {
      if (selected === undefined) {
        runtime.setStatus('先选择一个技能', 'warning')
        return
      }
      const next = new Set(marked)
      if (next.has(selected.id)) next.delete(selected.id)
      else next.add(selected.id)
      setMarked(next)
    }

    const toggleGroupFilter = (): void => {
      if (selectedGroupId === undefined) {
        runtime.setStatus('还没有分组', 'warning')
        return
      }
      if (groupKind === 'mcp') {
        const enabling = selectedGroupId !== mcpGroupFilter
        setMcpGroupFilter(enabling ? selectedGroupId : undefined)
        runtime.setStatus(enabling ? `按 MCP 分组过滤：${profileGroups[selectedGroupId]?.name}（x 清除）` : '已清除 MCP 分组过滤', 'info')
        if (enabling) goTab('mcp')
        return
      }
      const enabling = selectedGroupId !== groupFilter
      setGroupFilter(enabling ? selectedGroupId : undefined)
      const group = state.groups[selectedGroupId]
      runtime.setStatus(enabling ? `按分组过滤：${group?.name ?? selectedGroupId}（x 清除）` : '已清除分组过滤', 'info')
      if (enabling) goTab('skills')
    }

    const openCreateGroup = (): void => {
      setModal({
        kind: 'input',
        title: groupKind === 'mcp' ? '新建 MCP 分组' : '新建分组',
        label: '分组名称',
        value: '',
        onSubmit: (name) => {
          if (groupKind === 'mcp') void runtime.createMcpGroup(name)
          else void runtime.createGroup(name)
        },
      })
    }

    const openRenameGroup = (): void => {
      if (selectedGroupId === undefined) {
        runtime.setStatus('还没有分组', 'warning')
        return
      }
      const group = groupKind === 'mcp' ? profileGroups[selectedGroupId] : state.groups[selectedGroupId]
      setModal({
        kind: 'input',
        title: '重命名分组',
        label: '新的分组名称',
        value: group?.name ?? '',
        onSubmit: (name) => {
          if (groupKind === 'mcp') void runtime.renameMcpGroup(selectedGroupId, name)
          else void runtime.renameGroup(selectedGroupId, name)
        },
      })
    }

    const askDeleteGroup = (): void => {
      if (selectedGroupId === undefined) {
        runtime.setStatus('还没有分组', 'warning')
        return
      }
      const group = groupKind === 'mcp' ? profileGroups[selectedGroupId] : state.groups[selectedGroupId]
      setModal({
        kind: 'confirm',
        title: '删除分组',
        message: [`删除分组 "${group?.name ?? selectedGroupId}"？`, groupKind === 'mcp' ? '只删除分组元数据；MCP 配置、连接状态不变。' : '只删除分组元数据，不会删除任何技能。'],
        onConfirm: () => {
          if (groupKind === 'mcp') void runtime.deleteMcpGroup(selectedGroupId)
          else void runtime.deleteGroupById(selectedGroupId)
        },
      })
    }

    const moveSelection = (delta: number): void => {
      if (filtered.length === 0) return
      const next = Math.max(0, Math.min(filtered.length - 1, selectedIndex + delta))
      setSelectedId(filtered[next]?.id)
      setFocus('list')
    }

    const moveGroupSelection = (delta: number): void => {
      if (groupListEntries.length === 0) return
      const next = Math.max(0, Math.min(groupListEntries.length - 1, selectedGroupIndex + delta))
      setGroupSelectedId(groupListEntries[next]?.id)
    }

    const moveMcpSelection = (delta: number): void => {
      if (mcpRows.length === 0) return
      const next = Math.max(0, Math.min(mcpRows.length - 1, selectedMcpIndex + delta))
      setMcpSelectedId(mcpRows[next]?.id)
    }

    const clearFilters = (): void => {
      if (tab === 'mcp') { setMcpQuery(''); setMcpStatus('all'); setMcpGroupFilter(undefined) }
      else if (tab === 'groups' && groupKind === 'mcp') setMcpGroupFilter(undefined)
      else if (groupFilter !== undefined) setGroupFilter(undefined)
      else if (marked.size > 0) clearMarks()
      runtime.setStatus('已清除过滤', 'info')
    }

    const openMcpFilters = (): void => {
      setModal({ kind: 'select', title: 'MCP 筛选 · 状态与分组可组合', index: 0,
        options: [
          ...Object.entries(MCP_STATUSES).map(([id, label]) => ({ id: `status:${id}`, label: `状态 · ${label}${mcpStatus === id ? ' ✓' : ''}` })),
          { id: 'group:', label: `分组 · 全部${mcpGroupFilter === undefined ? ' ✓' : ''}` },
          ...mcpGroupEntries.map(([id, group]) => ({ id: `group:${id}`, label: `分组 · ${group.name}${mcpGroupFilter === id ? ' ✓' : ''}` })),
        ], onSubmit: (id) => {
          if (id.startsWith('status:')) setMcpStatus(id.slice(7) as McpStatusFilter)
          else setMcpGroupFilter(id.slice(6) || undefined)
        } })
    }

    const switchTab = (delta: number): void => {
      const index = TABS.indexOf(tab)
      const next = TABS[(index + delta + TABS.length) % TABS.length] ?? 'skills'
      goTab(next)
    }

    const goTab = (next: Tab): void => {
      setTab(next)
      setFocus(next === 'skills' ? 'list' : 'body')
      setDiagOffset(0)
      setDetailOffset(0)
    }

    const cycleScope = (delta: number): void => {
      const index = SCOPE_FILTERS.indexOf(scope)
      setScope(SCOPE_FILTERS[(index + delta + SCOPE_FILTERS.length) % SCOPE_FILTERS.length] ?? 'all')
      setFocus('scope')
    }

    const confirmModal = (target: Extract<Modal, { kind: 'confirm' }>): void => {
      setModal(undefined)
      target.onConfirm()
    }

    const cancelModal = (): void => {
      setModal(undefined)
      if (modal !== undefined && modal.kind !== 'info') modal.onCancel?.()
    }

    const submitInputModal = (target: Extract<Modal, { kind: 'input' }>): void => {
      const value = target.preserveWhitespace ? target.value : target.value.trim()
      const error = target.validate?.(value)
      if (error !== undefined) {
        runtime.setStatus(error, 'error')
        return
      }
      setModal(undefined)
      target.onSubmit(value)
    }

    const scrollDetail = (delta: number): void => {
      const max = Math.max(0, detailLines.length - bodyRows)
      setDetailOffset((value) => Math.max(0, Math.min(max, value + delta)))
    }

    useInput((input, key) => {
      if (tooSmall) {
        if (key.escape || (!key.ctrl && !key.meta && input.toLowerCase() === 'q')) close()
        return
      }
      if (modal?.kind === 'input' && key.ctrl && input.toLowerCase() === 'u') {
        setModal({ ...modal, value: '' })
        return
      }
      // Human terminals deliver a lone ESC as escape+meta (see Ink's 50ms
      // escape flush), so the modifier guard must never swallow it.
      if ((key.ctrl || key.meta) && !key.escape) return
      const text = input.replace(/[\r\n]+/gu, '')
      const char = text.length > 0 ? (text[0]?.toLowerCase() ?? '') : ''

      if (modal !== undefined) {
        if (modal.kind === 'confirm') {
          const next = textOffset(key, char, modalAt, modalLines.length, modalRows)
          if (next !== undefined) { setModalOffset(next); return }
          if (char === 'y' || key.return) confirmModal(modal)
          else if (char === 'n' || key.escape) cancelModal()
          return
        }
        if (modal.kind === 'input') {
          if (key.escape) {
            cancelModal()
          } else if (key.return && key.shift && modal.multiline) {
            setModal({ ...modal, value: `${modal.value}\n` })
          } else if (key.return) {
            submitInputModal(modal)
          } else if (key.backspace || key.delete) {
            setModal({ ...modal, value: Array.from(modal.value).slice(0, -1).join('') })
          } else if (input.length > 0) {
            const entered = modal.multiline ? input.replaceAll('\r\n', '\n').replaceAll('\r', '\n') : text
            setModal({ ...modal, value: modal.value + entered })
          }
          return
        }
        if (modal.kind === 'select') {
          if (key.escape) {
            cancelModal()
          } else if (key.upArrow || char === 'k') {
            setModal({ ...modal, index: Math.max(0, modal.index - 1) })
          } else if (key.downArrow || char === 'j') {
            setModal({ ...modal, index: Math.min(modal.options.length - 1, modal.index + 1) })
          } else if (key.home || key.end || key.pageUp || key.pageDown) {
            const next = key.home ? 0 : key.end ? modal.options.length - 1 : modal.index + (key.pageUp ? -1 : 1) * Math.max(1, rows - 12)
            setModal({ ...modal, index: Math.max(0, Math.min(modal.options.length - 1, next)) })
          } else if (key.return || char === ' ') {
            const option = modal.options[modal.index]
            if (option !== undefined) {
              const submit = modal.onSubmit
              setModal(undefined)
              submit(option.id)
            }
          }
          return
        }
        const next = textOffset(key, char, modalAt, modalLines.length, modalRows)
        if (next !== undefined) setModalOffset(next)
        else if (key.escape || key.return || char === 'q') setModal(undefined)
        return
      }

      if (helpOpen) {
        const next = textOffset(key, char, helpAt, helpLines.length, helpRows)
        if (next !== undefined) setHelpOffset(next)
        else if (key.escape || text === '?' || char === 'q') setHelpOpen(false)
        return
      }
      if (searchMode) {
        if (key.escape || key.return) {
          setSearchMode(false)
          return
        }
        if (key.backspace || key.delete) {
          if (tab === 'mcp') setMcpQuery((current) => Array.from(current).slice(0, -1).join(''))
          else setQuery((current) => Array.from(current).slice(0, -1).join(''))
          return
        }
        if (text.length > 0) {
          if (tab === 'mcp') setMcpQuery((current) => current + text)
          else setQuery((current) => current + text)
        }
        return
      }
      if (key.escape) {
        if (tab === 'skills' && marked.size > 0) {
          clearMarks()
          return
        }
        if (focus === 'detail') {
          setFocus('list')
          return
        }
        close()
        return
      }
      if (key.tab) {
        switchTab(key.shift ? -1 : 1)
        return
      }
      if (char === 'q') {
        close()
        return
      }
      if (char === '?') {
        setHelpOffset(0)
        setHelpOpen(true)
        return
      }
      if (char === '/') {
        if (tab === 'skills' || tab === 'mcp') setSearchMode(true)
        return
      }
      if (text === 'R') {
        void runtime.refresh('manual')
        return
      }
      if (char === 'w') {
        void runtime.dumpNow()
        return
      }
      if (char === '1') return goTab('skills')
      if (char === '2') return goTab('mcp')
      if (char === '3') return goTab('groups')
      if (char === '4') return goTab('diagnostics')
      if (char === 'u') {
        if (tab === 'mcp') void runtime.undoMcpDelete()
        else runUndoSkills()
        return
      }
      if (char === 'x') {
        clearFilters()
        return
      }

      if (tab === 'groups') {
        if (char === 't') { setGroupKind(groupKind === 'skills' ? 'mcp' : 'skills'); return }
        if (char === 'a') return openCreateGroup()
        if (char === 'r') return openRenameGroup()
        if (char === 'd') return askDeleteGroup()
        if (focus === 'tabs') {
          if (key.leftArrow || char === 'h') switchTab(-1)
          else if (key.rightArrow || char === 'l') switchTab(1)
          else if (key.downArrow || char === 'j' || key.return) setFocus('body')
          return
        }
        if (key.return) {
          toggleGroupFilter()
          return
        }
        if (key.upArrow || char === 'k') {
          if (selectedGroupIndex <= 0) setFocus('tabs')
          else moveGroupSelection(-1)
        } else if (key.downArrow || char === 'j') moveGroupSelection(1)
        else if (key.leftArrow || char === 'h') switchTab(-1)
        else if (key.rightArrow || char === 'l') switchTab(1)
        else if (key.pageUp) moveGroupSelection(-bodyRows)
        else if (key.pageDown) moveGroupSelection(bodyRows)
        else if (key.home) setGroupSelectedId(groupListEntries[0]?.id)
        else if (key.end) setGroupSelectedId(groupListEntries[groupListEntries.length - 1]?.id)
        return
      }

      if (tab === 'mcp' && char === ' ') {
        if (selectedMcp !== undefined) void runtime.toggleMcp(selectedMcp.id)
        return
      }

      if (tab === 'mcp') {
        if (char === 'm') return askMigrateMcp()
        if (char === 'i') return openMcpInfo()
        if (char === 'g') return openGroupPicker()
        if (char === 'f') return openMcpFilters()
        if (char === 'r') { void runtime.refreshMcp(); return }
        if (char === 'a') return openMcpForm()
        if (char === 'd') return askDeleteMcp()
        if (focus === 'tabs') {
          if (key.leftArrow || char === 'h') switchTab(-1)
          else if (key.rightArrow || char === 'l') switchTab(1)
          else if (key.downArrow || char === 'j' || key.return) setFocus('body')
          return
        }
        if (key.upArrow || char === 'k') {
          if (selectedMcpIndex <= 0) setFocus('tabs')
          else moveMcpSelection(-1)
        } else if (key.downArrow || char === 'j') moveMcpSelection(1)
        else if (key.leftArrow || char === 'h') switchTab(-1)
        else if (key.rightArrow || char === 'l') switchTab(1)
        else if (key.pageUp) moveMcpSelection(-bodyRows)
        else if (key.pageDown) moveMcpSelection(bodyRows)
        else if (key.home) setMcpSelectedId(mcpRows[0]?.id)
        else if (key.end) setMcpSelectedId(mcpRows[mcpRows.length - 1]?.id)
        else if (key.return || char === 'e') { if (selectedMcp !== undefined) openMcpForm(selectedMcp.id) }
        return
      }

      if (tab !== 'skills') {
        if (char === 'r') {
          void runtime.refresh('manual')
          return
        }
        if (focus === 'tabs') {
          if (key.leftArrow || char === 'h') switchTab(-1)
          else if (key.rightArrow || char === 'l') switchTab(1)
          else if (key.downArrow || char === 'j' || key.return) setFocus('body')
          return
        }
        const next = textOffset(key, char, diagAt, bodyLines.length, bodyRows)
        if ((key.upArrow || char === 'k') && diagAt === 0) setFocus('tabs')
        else if (next !== undefined) setDiagOffset(next)
        else if (key.leftArrow || char === 'h') {
          switchTab(-1)
        } else if (key.rightArrow || char === 'l') {
          switchTab(1)
        }
        return
      }

      // skills-tab actions (available regardless of focus)
      if (char === 'r') {
        void runtime.refresh('manual')
        return
      }
      if (char === 'a') return openAdd()
      if (char === 'v') {
        if (selected !== undefined) {
          const next = new Set(marked)
          if (next.has(selected.id)) next.delete(selected.id)
          else next.add(selected.id)
          setMarked(next)
        }
        return
      }
      if (char === 'g') return openGroupPicker()
      if (char === ' ') return runToggle()
      if (char === 'd') return askDelete()

      if (focus === 'tabs') {
        if (key.leftArrow || char === 'h') switchTab(-1)
        else if (key.rightArrow || char === 'l') switchTab(1)
        else if (key.downArrow || char === 'j' || key.return) setFocus(wide ? 'scope' : 'list')
        return
      }

      if (focus === 'scope') {
        if (key.upArrow || char === 'k') {
          const index = SCOPE_FILTERS.indexOf(scope)
          if (index <= 0) setFocus('tabs')
          else setScope(SCOPE_FILTERS[index - 1] ?? 'all')
        } else if (key.downArrow || char === 'j') {
          const index = SCOPE_FILTERS.indexOf(scope)
          if (index >= SCOPE_FILTERS.length - 1) setFocus('list')
          else setScope(SCOPE_FILTERS[index + 1] ?? 'all')
        } else if (key.rightArrow || char === 'l' || key.return) {
          setFocus('list')
        } else if (key.leftArrow || char === 'h') {
          setFocus('tabs')
        }
        return
      }

      if (focus === 'detail') {
        const next = textOffset(key, char, detailAt, detailLines.length, bodyRows)
        if (next !== undefined) setDetailOffset(next)
        else if (key.leftArrow || char === 'h' || key.return) setFocus('list')
        return
      }

      if (key.upArrow || char === 'k') {
        if (selectedIndex <= 0) setFocus(narrow ? 'scope' : 'tabs')
        else moveSelection(-1)
      } else if (key.downArrow || char === 'j') {
        moveSelection(1)
      } else if (key.leftArrow || char === 'h') {
        setFocus('scope')
      } else if (key.rightArrow || char === 'l' || key.return) {
        setFocus('detail')
      } else if (key.pageUp) {
        moveSelection(-bodyRows)
      } else if (key.pageDown) {
        moveSelection(bodyRows)
      } else if (key.home) {
        moveSelection(-filtered.length)
      } else if (key.end) {
        moveSelection(filtered.length)
      }
    })

    // ── card primitives ─────────────────────────────────────────────────────
    const card = (options: {
      title: string
      subtitle?: string
      focused: boolean
      width: number
      children: ReactNode
      onClick?: () => void
      onWheel?: (event: { deltaY: number }) => void
    }): ReactNode => (
      <Box
        flexDirection="column"
        width={options.width}
        height={cardsHeight}
        borderStyle="round"
        borderColor={options.focused ? 'accent' : 'promptBorder'}
        paddingX={1}
        onClick={options.onClick}
        onWheel={options.onWheel}
      >
        <Box flexDirection="row" height={1}>
          <Text bold={options.focused} color={options.focused ? 'accent' : undefined} dimColor={!options.focused} wrap="truncate">
            {options.title}
          </Text>
          {options.subtitle === undefined ? null : (
            <Text dimColor wrap="truncate">
              {`  ${options.subtitle}`}
            </Text>
          )}
        </Box>
        <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          {options.children}
        </Box>
      </Box>
    )

    const rowNode = (
      key: string,
      content: string,
      options: { selected: boolean; dim?: boolean; onClick?: (event: ClickLike) => void },
    ): ReactNode => (
      <Box
        key={key}
        flexDirection="row"
        height={1}
        backgroundColor={options.selected ? 'selectionBg' : undefined}
        onClick={options.onClick}
      >
        <Text color={options.selected ? 'accent' : undefined} bold={options.selected}>
          {options.selected ? '❯ ' : '  '}
        </Text>
        <Text bold={options.selected} dimColor={options.dim === true && !options.selected} wrap="truncate">
          {content}
        </Text>
      </Box>
    )

    const groupIds = (instance: SkillInstance): string[] => runtime.groupIdsFor(instance)
    const markedFlag = (instance: SkillInstance): string => (marked.has(instance.id) ? '✓ ' : '')

    // Verification-only render snapshot (SKILL_MCP_PANEL_RENDER_DUMP).
    const verificationRows = filtered.map((instance) => {
      const flags = statusFlags(instance)
      const groups = groupIds(instance)
        .map((id) => state.groups[id]?.name)
        .filter((name): name is string => name !== undefined)
      return `${STATUS_GLYPHS[instance.status]} ${instance.name} [${SOURCE_LABELS[instance.source]}${flags.length > 0 ? ` ${flags}` : ''}${groups.length > 0 ? ` groups=${groups.join(',')}` : ''}${marked.has(instance.id) ? ' marked' : ''}]`
    })
    const verificationFrame = [
      `tab=${tab} scope=${scope} query=${JSON.stringify(query)} search=${searchMode} help=${helpOpen} focus=${focus} modal=${modal?.kind ?? '-'} groupFilter=${groupFilter ?? '-'} marked=${marked.size}`,
      `screen=${columns}x${rows} listWidth=${listWidth} detailWidth=${detailWidth}`,
      `summary total=${summary.total} enabled=${summary.enabled} disabled=${summary.disabled} invalid=${summary.invalid} shadowed=${summary.shadowed} workspace=${summary.workspace} global=${summary.global}`,
      `list(${filtered.length}):`,
      ...verificationRows,
      `selected=${selected?.name ?? '(none)'} status=${selected?.status ?? '-'} path=${selected?.path ?? '-'}`,
      `groups(${groupEntries.length}): ${groupEntries.map(([id, group]) => `${id}:${group.name}:${groupMemberCount(group)}`).join(' ')}`,
      `mcp(${mcpRows.length}): ${mcpRows.map((row) => `${row.id}:${row.enabled ? 'on' : 'off'}:${row.layer}${row.targetable ? '' : ':ro'}`).join(' ')}`,
      `mcpView query=${JSON.stringify(mcpQuery)} status=${mcpStatus} group=${mcpGroupFilter ?? '-'} groupKind=${groupKind}`,
      `mcpGroups(${mcpGroupEntries.length}): ${mcpGroupEntries.map(([id, group]) => `${id}:${group.name}:${group.members.length}`).join(' ')}`,
      `trash=${state.latestTrash?.batchId ?? '-'} status=${state.statusMessage?.text ?? '-'}`,
      `detail=${state.detail.status}${state.detail.error === undefined ? '' : ` error=${state.detail.error}`}`,
      ...(tab === 'mcp'
        ? [MCP_SCOPE_NOTICE, ...mcpDetailLines(selectedMcp, contentWidth)]
        : tab === 'diagnostics'
          ? diagnosticLines(state, contentWidth)
          : []),
      ...(helpOpen ? HELP_LINES : []),
    ].join('\n')
    React.useEffect(() => {
      runtime.writeRenderFrame(
        `tab=${tab} scope=${scope} focus=${focus}${helpOpen ? ' help' : ''}${modal === undefined ? '' : ` modal=${modal.kind}`}`,
        verificationFrame,
      )
    }, [tab, scope, focus, selected?.id, selectedMcp?.id, state.mcp, state.groupsFingerprint, state.groupsWarning, state.config, state.scan?.scannedAt, helpOpen, searchMode, query, mcpQuery, mcpStatus, mcpGroupFilter, groupKind, state.detail.status, state.statusMessage?.at, modal?.kind, marked, groupFilter])

    const textPager = (at: number, total: number, page: number, setOffset: (value: number) => void): ReactNode => (
      <Box flexDirection="row" height={1}>
        {([
          ['首', 0], ['上页', Math.max(0, at - page)],
          ['下页', Math.min(Math.max(0, total - page), at + page)], ['末', Math.max(0, total - page)],
        ] as const).map(([label, next]) => <Box key={label} flexShrink={0} onClick={() => setOffset(next)}><Text color="accent">{`[${label}] `}</Text></Box>)}
        <Text dimColor wrap="truncate">{columns < 72 ? `${at + 1}/${total}` : `${at + 1}-${Math.min(at + page, total)}/${total}`}</Text>
      </Box>
    )

    // ── modal screen ────────────────────────────────────────────────────────
    if (tooSmall) {
      return <Box flexDirection="column" height={Math.max(1, rows - 1)} paddingX={1}>
        {['空间不足 · q/Esc', '可用区域需 40×16', '放大后草稿仍在'].slice(0, Math.max(1, rows - 1)).map((line) => <Text key={line} wrap="truncate">{line}</Text>)}
        {rows >= 5 ? <Box onClick={close}><Text color="accent">[q 关闭]</Text></Box> : null}
      </Box>
    }
    if (modal !== undefined) {
      const modalDanger = modal.kind === 'confirm' && modal.danger === true
      const modalBody = ((): ReactNode => {
        if (modal.kind === 'confirm') {
          return (
            <>
              {modalLines.slice(modalAt, modalAt + modalRows).map((line, index) => (
                <Text key={`modal-${modalAt + index}`} wrap="truncate" dimColor={modalAt + index > 0}>{line}</Text>
              ))}
              {textPager(modalAt, modalLines.length, modalRows, setModalOffset)}
              <Box flexDirection="row" height={1}>
                <Box onClick={() => confirmModal(modal)}>
                  <Text color="accent">[y 确认]</Text>
                </Box>
                <Text> </Text>
                <Box onClick={cancelModal}>
                  <Text>[n / Esc 取消]</Text>
                </Box>
              </Box>
            </>
          )
        }
        if (modal.kind === 'input') {
          return (
            <>
              <Text dimColor wrap="truncate">{displayLine(`${modal.label}：`, modalWidth - 4)}</Text>
              <Box flexDirection="row" height={1}>
                <Text color="accent">❯ </Text>
                <Text wrap="truncate">{modal.secret ? `（已输入 ${Array.from(modal.value).length} 字符，值已隐藏）` : inputTail(modal.value.replaceAll('\n', ' ↵ '), modalWidth - 8)}</Text>
                <Text color="accent">▌</Text>
              </Box>
              {wrapTextLines(modal.hint === undefined ? [] : [modal.hint], modalWidth - 4).slice(0, Math.max(1, rows - 10)).map((line, index) => <Text key={`input-hint-${index}`} dimColor wrap="truncate">{line}</Text>)}
              <Box flexDirection="row" height={1}>
                <Box onClick={() => submitInputModal(modal)}>
                  <Text color="accent">[Enter 提交]</Text>
                </Box>
                <Text> </Text>
                <Box onClick={cancelModal}>
                  <Text>[Esc 取消]</Text>
                </Box>
              </Box>
            </>
          )
        }
        if (modal.kind === 'select') {
          const pageSize = Math.max(1, rows - 12)
          const start = Math.max(0, Math.min(modal.index - Math.floor(pageSize / 2), modal.options.length - pageSize))
          return (
            <>
              {modal.options.slice(start, start + pageSize).map((option, index) => {
                const active = start + index === modal.index
                return (
                  <Box
                    key={option.id}
                    flexDirection="row"
                    height={1}
                    backgroundColor={active ? 'selectionBg' : undefined}
                    onClick={() => {
                      setModal(undefined)
                      modal.onSubmit(option.id)
                    }}
                  >
                    <Text color={active ? 'accent' : undefined}>{active ? '❯ ' : '  '}</Text>
                    <Text bold={active} wrap="truncate">{oneLine(option.label, modalWidth - 6)}</Text>
                    {option.hint === undefined ? null : (
                      <Text dimColor wrap="truncate">
                        {`  ${option.hint}`}
                      </Text>
                    )}
                  </Box>
                )
              })}
              <Box flexDirection="row" height={1}>
                <Text dimColor wrap="truncate">{`↑↓ ↵确认 · ${modal.index + 1}/${modal.options.length} `}</Text>
                <Box flexShrink={0} onClick={cancelModal}><Text color="accent">[Esc 取消]</Text></Box>
              </Box>
            </>
          )
        }
        return (
          <>
            {modalLines.slice(modalAt, modalAt + modalRows).map((line, index) => <Text key={`modal-info-${modalAt + index}`} wrap="truncate">{line}</Text>)}
            {textPager(modalAt, modalLines.length, modalRows, setModalOffset)}
            <Box onClick={cancelModal}><Text color="accent">[Enter/Esc 关闭]</Text></Box>
          </>
        )
      })()
      return (
        <Box flexDirection="column" height={Math.max(1, rows - 1)} paddingX={1}>
          <Box flexDirection="row" height={1}>
            <Box flexShrink={0}><Text bold color="accent">Skill / MCP manager</Text></Box>
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate">{oneLine(sceneId, Math.max(0, contentWidth - 20))}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} marginTop={1}>
            <Box
              flexDirection="column"
              width={modalWidth}
              borderStyle="round"
              borderColor={modalDanger ? 'error' : 'accent'}
              paddingX={1}
              onWheel={(event: { deltaY: number }) => {
                const step = Math.sign(event.deltaY)
                if (modal.kind === 'select') setModal({ ...modal, index: Math.max(0, Math.min(modal.options.length - 1, modal.index + step)) })
                else if (modalLines.length > 0) setModalOffset(Math.max(0, Math.min(Math.max(0, modalLines.length - modalRows), modalAt + step)))
              }}
            >
              <Text bold color={modalDanger ? 'error' : 'accent'} wrap="truncate">
                {oneLine(modal.title, modalWidth - 4)}
              </Text>
              {modalBody}
            </Box>
          </Box>
          <Text dimColor wrap="truncate">
            {displayLine(state.statusMessage?.text ?? '', contentWidth)}
          </Text>
        </Box>
      )
    }

    const tabBar = (
      <Box flexDirection="row" height={1}>
        <Text color="accent">{focus === 'tabs' ? '❯' : ' '}</Text>
        {TABS.map((candidate) => (
          <Box key={candidate} onClick={() => goTab(candidate)}>
            <Text
              bold={candidate === tab}
              color={candidate === tab ? 'accent' : undefined}
              backgroundColor={candidate === tab ? 'selectionBg' : undefined}
              dimColor={candidate !== tab}
            >
              {` ${twoPane ? TAB_LABELS[candidate] : TAB_LABELS_NARROW[candidate]} `}
            </Text>
          </Box>
        ))}
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate">
          {searchMode ? `搜索: ${tab === 'mcp' ? mcpQuery : query}▌  (Enter/Esc)` : tab === 'skills' ? `${SCOPE_LABELS[scope]} · ${filtered.length} 项${groupFilter === undefined ? '' : ` · 分组:${state.groups[groupFilter]?.name ?? groupFilter}`}` : ''}
        </Text>
      </Box>
    )

    if (helpOpen) {
      return (
        <Box flexDirection="column" height={Math.max(1, rows - 1)} paddingX={1}>
          <Box flexDirection="row" height={1}>
            <Box flexShrink={0}><Text bold color="accent">Skill / MCP manager</Text></Box>
            <Box flexGrow={1} />
            <Text dimColor>帮助 Help · {columns}x{rows}</Text>
          </Box>
          {tabBar}
          <Box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1}
            onWheel={(event: { deltaY: number }) => setHelpOffset(Math.max(0, Math.min(Math.max(0, helpLines.length - helpRows), helpAt + Math.sign(event.deltaY))))}>
            {helpLines.slice(helpAt, helpAt + helpRows).map((line, index) => (
              <Text key={`help-${index}`} wrap="truncate" bold={index === 0} color={index === 0 ? 'accent' : undefined} dimColor={index > 0 && line.startsWith('  ')}>
                {line}
              </Text>
            ))}
          </Box>
          {textPager(helpAt, helpLines.length, helpRows, setHelpOffset)}
          <Box onClick={() => setHelpOpen(false)}><Text dimColor>Esc/? 关闭帮助</Text></Box>
        </Box>
      )
    }

    // ── scope chips (two-pane/narrow) ───────────────────────────────────────
    const scopeChips = (
      <Box flexDirection="row" height={1}>
        <Text color="accent">{focus === 'scope' ? '❯' : ' '}</Text>
        <Text dimColor>作用域 </Text>
        {SCOPE_FILTERS.map((candidate) => (
          <Box
            key={candidate}
            onClick={() => {
              setScope(candidate)
              setFocus('scope')
            }}
          >
            <Text
              bold={candidate === scope}
              color={candidate === scope ? 'accent' : undefined}
              backgroundColor={candidate === scope ? 'selectionBg' : undefined}
              dimColor={candidate !== scope}
            >
              {` ${SCOPE_LABELS[candidate]}${columns < 50 ? '' : `(${scopeCounts[candidate]})`} `}
            </Text>
          </Box>
        ))}
      </Box>
    )

    // ── skills panes ────────────────────────────────────────────────────────
    const skillPageRows = Math.max(1, bodyRows - (filtered.length > bodyRows ? 1 : 0))
    const listWindowStart = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(skillPageRows / 2), Math.max(0, filtered.length - skillPageRows)),
    )
    const listRows =
      filtered.length === 0
        ? [
            <Text key="empty" dimColor wrap="wrap">
              {scan === undefined
                ? '扫描中…'
                : query.length > 0
                  ? '没有匹配的技能（/ 修改搜索）。'
                  : groupFilter !== undefined
                    ? `分组「${state.groups[groupFilter]?.name ?? groupFilter}」在当前作用域没有技能（x 清除过滤）。`
                    : scope !== 'all' && summary.total > 0
                      ? `当前筛选「${SCOPE_LABELS[scope]}」下没有技能（←/→ 切换作用域）。`
                      : '没有任何技能。按 a 添加，或把技能放到发现根。'}
            </Text>,
          ]
        : filtered.slice(listWindowStart, listWindowStart + skillPageRows).map((instance) => {
            const isSelected = instance.id === selected?.id
            const flags = statusFlags(instance)
            const groupNames = groupIds(instance)
              .map((id) => state.groups[id]?.name)
              .filter((name): name is string => name !== undefined)
            const content = truncateToWidth(
              `${markedFlag(instance)}${padToWidth(instance.name, nameWidth)}  ${SOURCE_LABELS[instance.source]}${flags.length > 0 ? `  ${flags}` : ''}${groupNames.length > 0 ? `  ◆${groupNames.join('/')}` : ''}`,
              listInner,
            )
            return rowNode(instance.id, content, {
              selected: isSelected,
              dim: !instance.effective,
              onClick: (event) => {
                // This row's navigation wins over the containing card's focus handler.
                event.stopImmediatePropagation()
                setSelectedId(instance.id)
                setFocus(narrow ? 'detail' : 'list')
              },
            })
          })

    const listCard = card({
      title: '技能列表',
      subtitle: `${SCOPE_LABELS[scope]} · ${filtered.length}项${query.length > 0 ? ` · "${query}"` : ''}${marked.size > 0 ? ` · 已标记 ${marked.size}` : ''}`,
      focused: tab === 'skills' && focus === 'list',
      width: listWidth,
      onClick: () => setFocus('list'),
      onWheel: (event: { deltaY: number }) => {
        if (event.deltaY === 0) return
        setFocus('list')
        moveSelection(event.deltaY > 0 ? 1 : -1)
      },
      children: [
        ...listRows,
        ...(filtered.length > skillPageRows
          ? [
              <Text key="scroll-hint" dimColor>
                {`${listWindowStart + 1}-${Math.min(listWindowStart + skillPageRows, filtered.length)} / ${filtered.length}`}
              </Text>,
            ]
          : []),
      ],
    })

    const detailWindow = detailLines.slice(detailAt, detailAt + bodyRows)
    const detailCard = card({
      title: '详情',
      subtitle:
        selected === undefined
          ? undefined
          : `${truncateToWidth(selected.name, Math.max(8, detailWidth - 12))}${detailLines.length > bodyRows ? `  ↕${detailAt + 1}/${detailLines.length}` : ''}`,
      focused: tab === 'skills' && focus === 'detail',
      width: detailWidth,
      onClick: () => setFocus('detail'),
      onWheel: (event: { deltaY: number }) => {
        if (event.deltaY === 0) return
        setFocus('detail')
        scrollDetail(event.deltaY > 0 ? 1 : -1)
      },
      children: detailWindow.map((line, index) => (
        <Text key={`detail-${detailOffset + index}`} wrap="truncate" dimColor={line.startsWith('  ')}>
          {line}
        </Text>
      )),
    })

    const scopeCard = card({
      title: '作用域',
      focused: tab === 'skills' && focus === 'scope',
      width: scopeCardWidth,
      onClick: () => setFocus('scope'),
      children: SCOPE_FILTERS.map((candidate) => {
        const isSelected = candidate === scope
        return rowNode(candidate, truncateToWidth(`${SCOPE_LABELS[candidate]} (${scopeCounts[candidate]})`, scopeCardWidth - 6), {
          selected: isSelected,
          dim: !isSelected,
          onClick: () => {
            setScope(candidate)
            setFocus('scope')
          },
        })
      }),
    })

    const skillsBody = wide ? (
      <Box flexDirection="row" flexGrow={1} height={cardsHeight}>
        {scopeCard}
        <Box width={gap} />
        {listCard}
        <Box width={gap} />
        {detailCard}
      </Box>
    ) : twoPane ? (
      <Box flexDirection="row" flexGrow={1} height={cardsHeight}>
        {listCard}
        <Box width={gap} />
        {detailCard}
      </Box>
    ) : focus === 'detail' && selected !== undefined ? (
      detailCard
    ) : (
      listCard
    )

    // ── MCP tab ─────────────────────────────────────────────────────────────
    const legacyCount = state.mcp.legacyToggles?.length ?? 0
    const mcpErrors = [...state.mcp.errors.map(error => `错误：${error}`),
      ...(legacyCount ? [`旧启停配置 ${legacyCount} 条，web 开关可能不一致；按 m 迁移`] : [])]
      .slice(0, Math.min(2, Math.max(0, bodyRows - 4)))
    const mcpFixedRows = 2 + mcpErrors.length + (mcpRows.length > 1 ? 1 : 0)
    const mcpListRows = Math.max(1, Math.min(8, bodyRows - mcpFixedRows - 3))
    const mcpDetailRows = Math.max(0, bodyRows - mcpFixedRows - mcpListRows - 1)
    const mcpWindowStart = Math.max(
      0,
      Math.min(selectedMcpIndex - Math.floor(mcpListRows / 2), Math.max(0, mcpRows.length - mcpListRows)),
    )
    const mcpListNodes = mcpRows.length === 0
      ? wrapTextLines([state.mcp.rows.length === 0 ? (columns < 72 ? '没有 MCP 行。按 a 新增；已有行仅启停。' : '当前 profile / home 层没有 MCP 行。按 a 新增；仅本面板受管行支持编辑/删除，已有 profile 行可启停。') : '没有匹配的 MCP 行。按 x 清除搜索、状态与分组过滤。'], contentWidth - 6)
          .slice(0, Math.max(1, bodyRows - 2 - mcpErrors.length)).map((line, index) => <Text key={`mcp-empty-${index}`} dimColor wrap="truncate">{line}</Text>)
      : mcpRows.slice(mcpWindowStart, mcpWindowStart + mcpListRows).map((row) => {
          const isSelected = row.id === selectedMcp?.id
          const flags = [
            row.enabled ? '启用' : '停用',
            row.layer,
            ...(row.phase === undefined ? [] : [row.phase]),
            ...(row.targetable ? [] : ['只读']),
            ...(row.managed ? ['受管'] : row.targetable ? ['仅启停'] : []),
            ...mcpGroupIds(state.config.mcpGroups, profilePath ?? '', row).map((id) => `◆${profileGroups[id]?.name}`),
          ].join(' · ')
          return rowNode(
            row.id,
            truncateToWidth(`${padToWidth(row.serverName, Math.max(8, Math.min(24, contentWidth - 42)))}  ${row.transport}  ${flags}`, contentWidth - 6),
            {
              selected: isSelected,
              dim: !row.enabled,
              onClick: () => setMcpSelectedId(row.id),
            },
          )
        })
    const selectedMcpGroups = selectedMcp === undefined ? [] : mcpGroupIds(state.config.mcpGroups, profilePath ?? '', selectedMcp).map((id) => profileGroups[id]?.name)
    const mcpDetail = [
      ...(selectedMcp === undefined ? [] : [`分组：${selectedMcpGroups.join(' / ') || '(未分组)'} · g 修改`]),
      ...mcpDetailLines(selectedMcp, contentWidth - 6),
    ].slice(0, mcpDetailRows)
    const mcpCard = card({
      title: 'MCP servers',
      subtitle: `${mcpRows.length} 行 · 启用 ${mcpRows.filter((row) => row.enabled).length} · 停用 ${mcpRows.filter((row) => !row.enabled).length}${state.mcp.togglingId === undefined ? '' : ' · 热加载中…'}`,
      focused: tab === 'mcp' && focus === 'body',
      width: contentWidth,
      onClick: () => setFocus('body'),
      onWheel: (event: { deltaY: number }) => {
        if (event.deltaY === 0) return
        setFocus('body')
        moveMcpSelection(event.deltaY > 0 ? 1 : -1)
      },
      children: [
        <Text key="mcp-scope" dimColor wrap="truncate">{columns < 72 ? '无工作区 · profile写 · home只读' : MCP_SCOPE_NOTICE}</Text>,
        <Text key="mcp-filters" color="accent" wrap="truncate">{`筛选: ${MCP_STATUSES[mcpStatus]} · 分组:${mcpGroupFilter === undefined ? '全部' : profileGroups[mcpGroupFilter]?.name ?? '?'}${mcpQuery ? ` · 搜索:${mcpQuery}` : ''} · ${mcpRows.length}/${state.mcp.rows.length} 行`}</Text>,
        ...mcpErrors.map((error, index) => (
          <Text key={`mcp-error-${index}`} color={error.startsWith('错误：') ? 'error' : 'warning'} wrap="truncate">
            {displayLine(error, contentWidth - 6)}
          </Text>
        )),
        ...mcpListNodes,
        ...(mcpRows.length > mcpListRows
          ? [
              <Text key="mcp-window" dimColor>
                {`${mcpWindowStart + 1}-${Math.min(mcpWindowStart + mcpListRows, mcpRows.length)} / ${mcpRows.length}`}
              </Text>,
            ]
          : []),
        ...(mcpDetailRows > 0 && selectedMcp !== undefined ? [<Text key="mcp-divider" dimColor>{'─'.repeat(Math.max(4, contentWidth - 6))}</Text>] : []),
        ...(selectedMcp === undefined ? [] : mcpDetail).map((line, index) => (
          <Text key={`mcp-detail-${index}`} wrap="truncate" dimColor={line.startsWith('  ')}>
            {line}
          </Text>
        )),
      ],
    })

    // ── groups tab ──────────────────────────────────────────────────────────
    const activeGroupFilter = groupKind === 'mcp' ? mcpGroupFilter : groupFilter
    const groupStart = Math.max(0, Math.min(selectedGroupIndex - Math.floor((bodyRows - 2) / 2), groupListEntries.length - bodyRows + 2))
    const groupRows = groupListEntries.length === 0
      ? [<Text key="groups-empty" dimColor wrap="wrap">{`还没有${groupKind === 'mcp' ? '当前 profile 的 MCP' : '技能'}分组。按 a 新建，或在${groupKind === 'mcp' ? 'MCP' : '技能'}页按 g 添加成员。`}</Text>]
      : groupListEntries.slice(groupStart, groupStart + Math.max(1, bodyRows - 2)).map((group) => rowNode(group.id,
          displayLine(`${padToWidth(group.name, Math.max(12, contentWidth - (columns < 72 ? 16 : 40)))}  ${columns < 72 ? `${group.visible}/${group.count}项` : `${group.count} 个成员（当前可见 ${group.visible}）`}${activeGroupFilter === group.id ? ' ◆' : ''}`, contentWidth - 6), {
            selected: group.id === selectedGroupId, dim: group.count === 0,
            onClick: () => setGroupSelectedId(group.id),
          }))

    const groupsCard = card({
      title: '分组 Groups',
      subtitle: `${groupKind === 'mcp' ? 'MCP' : '技能'} · ${groupListEntries.length} 组`,
      focused: tab === 'groups' && focus === 'body', width: contentWidth,
      onClick: () => setFocus('body'),
      onWheel: (event: { deltaY: number }) => { if (event.deltaY !== 0) moveGroupSelection(event.deltaY > 0 ? 1 : -1) },
      children: [
        <Box key="group-kind" flexDirection="row" height={1}>
          {(['skills', 'mcp'] as const).map((kind) => <Box key={kind} flexShrink={0} onClick={() => setGroupKind(kind)}><Text color={groupKind === kind ? 'accent' : undefined} bold={groupKind === kind}>{`[${kind === 'skills' ? '技能' : 'MCP'}] `}</Text></Box>)}
          <Text dimColor wrap="truncate">{columns < 72 ? 't 切换 · 可见/总数' : groupKind === 'mcp' ? `t 切换 · profile: ${profilePath === undefined ? '(未知)' : basename(dirname(profilePath))}` : 't 切换 · 技能分组共享 web 配置'}</Text>
        </Box>,
        ...groupRows,
        ...(groupKind === 'mcp' ? [<Text key="group-note" dimColor wrap="truncate">成员引用按 profile 保存；删除服务器保留归属供撤销恢复。</Text>] : []),
      ],
    })

    // ── mcp / diagnostics tab ───────────────────────────────────────────────
    const bodyWindow = bodyLines.slice(diagAt, diagAt + bodyRows)
    const bodyCard = card({
      title: tab === 'mcp' ? 'MCP' : '诊断 Diagnostics',
      subtitle: tab === 'diagnostics' ? `扫描 ${scan?.scannedAt ?? '(pending)'}` : undefined,
      focused: tab !== 'skills' && tab !== 'groups' && focus === 'body',
      width: contentWidth,
      onClick: () => setFocus('body'),
      onWheel: (event: { deltaY: number }) => {
        if (event.deltaY === 0) return
        setFocus('body')
        setDiagOffset(Math.max(0, Math.min(Math.max(0, bodyLines.length - bodyRows), diagAt + (event.deltaY > 0 ? 1 : -1))))
      },
      children: bodyWindow.map((line, index) => (
        <Text key={`body-${diagOffset + index}`} wrap="truncate" dimColor={line.startsWith('  ')}>
          {line}
        </Text>
      )),
    })

    const footerStats = state.busy
      ? '处理中…'
      : tab === 'mcp'
        ? `MCP ${mcpRows.length} · 启用 ${mcpRows.filter((row) => row.enabled).length} · 停用 ${mcpRows.filter((row) => !row.enabled).length}${state.mcp.togglingId === undefined ? '' : ' · 热加载中…'}`
        : `共 ${summary.total} · 生效 ${summary.enabled - summary.shadowed} · 停用 ${summary.disabled} · 无效 ${summary.invalid} · 遮蔽 ${summary.shadowed}`
    const statusColor =
      statusTone === 'success' ? 'success' : statusTone === 'warning' ? 'warning' : statusTone === 'error' ? 'error' : 'accent'

    // Mouse parity: every keyboard action also exists as a clickable footer button.
    const actionButton = (label: string, onClick: () => void): ReactNode => (
      <Box key={label} flexShrink={0} onClick={onClick}>
        <Text color="accent">{`[${label}] `}</Text>
      </Box>
    )
    const actionItems = actionDefinitions.map(([id, full, short]) => ({ label: fullActions ? full : short, onClick: () => {
      if (id === 'help') { setHelpOffset(0); setHelpOpen(true); return }
      if (id === 'refresh') { if (tab === 'mcp') void runtime.refreshMcp(); else void runtime.refresh('manual'); return }
      if (id === 'clear') { clearFilters(); return }
      if (tab === 'skills') {
        if (id === 'back') setFocus('list')
        else if (id === 'toggle') runToggle()
        else if (id === 'mark') pressMark()
        else if (id === 'delete') askDelete()
        else if (id === 'undo') runUndoSkills()
        else if (id === 'create') openAdd()
        else if (id === 'group') openGroupPicker()
        else if (id === 'search') setSearchMode(true)
      } else if (tab === 'groups') {
        if (id === 'create') openCreateGroup()
        else if (id === 'rename') openRenameGroup()
        else if (id === 'delete') askDeleteGroup()
        else if (id === 'filter') toggleGroupFilter()
        else if (id === 'kind') setGroupKind(groupKind === 'skills' ? 'mcp' : 'skills')
      } else if (tab === 'mcp') {
        if (id === 'migrate') askMigrateMcp()
        if (id === 'toggle') { if (selectedMcp !== undefined) void runtime.toggleMcp(selectedMcp.id) }
        else if (id === 'create') openMcpForm()
        else if (id === 'edit') { if (selectedMcp !== undefined) openMcpForm(selectedMcp.id) }
        else if (id === 'delete') askDeleteMcp()
        else if (id === 'undo') void runtime.undoMcpDelete()
        else if (id === 'group') openGroupPicker()
        else if (id === 'filter') openMcpFilters()
        else if (id === 'search') setSearchMode(true)
        else if (id === 'detail') openMcpInfo()
      }
    } }))

    return (
      <Box flexDirection="column" height={Math.max(1, rows - 1)} paddingX={1}>
        <Box flexDirection="row" height={1}>
          <Box flexShrink={0}><Text bold color="accent">Skill / MCP manager</Text></Box>
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            {` ${sceneId} · ${columns}x${rows}`}
          </Text>
        </Box>
        {tabBar}
        {tab === 'skills' && !wide ? scopeChips : null}
        {tab === 'skills' ? skillsBody : tab === 'groups' ? groupsCard : tab === 'mcp' ? mcpCard : bodyCard}
        {packActions(actionItems, contentWidth).map((items, index) => <Box key={`actions-${index}`} flexDirection="row" height={1}>
          {items.map((item) => actionButton(item.label, item.onClick))}
          <Box flexGrow={1} />
          {fullActions && tab !== 'mcp' ? (
            <Text dimColor wrap="truncate">
              {footerStats}
            </Text>
          ) : null}
        </Box>)}
        {statusText === undefined ? null : (
          <Text color={statusColor} wrap="truncate">
            {displayLine(statusText, contentWidth)}
          </Text>
        )}
      </Box>
    )
  }
}
