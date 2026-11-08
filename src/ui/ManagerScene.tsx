/**
 * Full-screen manager scene (M1): skills read-only list + detail, host
 * diagnostics, and placeholders for the M2/M3 tabs. Keyboard-only by design
 * (host dialogs/toasts are unusable from plugin scenes — see docs/research/05).
 */
import type { ComponentType } from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { splitFrontmatter } from '../domain/skills/frontmatter.js'
import type { SkillInstance, SkillScanResult, SkillSource, SkillStatus } from '../domain/skills/types.js'
import type { ManagerRuntime, ManagerState } from '../host/manager-runtime.js'
import { firstLines, oneLine, padToWidth, truncateToWidth } from '../shared/format.js'

const TABS = ['skills', 'mcp', 'groups', 'diagnostics'] as const
type Tab = (typeof TABS)[number]

const TAB_LABELS: Record<Tab, string> = {
  skills: 'Skills 技能',
  mcp: 'MCP',
  groups: 'Groups 分组',
  diagnostics: 'Diagnostics 诊断',
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
  '快捷键 Keys',
  '  ↑/↓, j/k           移动选择',
  '  PgUp/PgDn, Home/End 翻页 / 首尾',
  '  Tab / Shift+Tab     切换页签',
  '  Enter              窄终端下打开/返回详情',
  '  /                   搜索（Esc 退出）',
  '  f                   切换作用域（全部/工作区/全局）',
  '  1/2/3               直接选作用域',
  '  r                   重新扫描磁盘',
  '  w                   导出诊断 JSON（需 SKILL_MCP_PANEL_DUMP）',
  '  ?                   本帮助',
  '  Esc/q               返回 / 关闭',
  '',
  '已知限制 Limits',
  '  · MCP 没有工作区级配置：只有当前 profile + home 全局层。',
  '  · 技能只发现一层：<root>/<name>/SKILL.md 或 <root>/<name>.md。',
  '  · 场景内不使用宿主对话框/toast（实测不可用），确认与输入均为自绘。',
  '  · 保存类操作尚未实现：M1 为只读（启停/删除/添加在 M2）。',
]

interface SceneUi {
  Box: TuiSceneProps['ui']['Box']
  Text: TuiSceneProps['ui']['Text']
  useInput: TuiSceneProps['ui']['useInput']
  useTerminalSize: TuiSceneProps['ui']['useTerminalSize']
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
    lines.push(truncateToWidth(line, width, '…'))
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
  push('  · 面板 M1 只读；启停/删除/添加/分组在后续里程碑。')
  return lines
}

function skillDetailLines(instance: SkillInstance | undefined, state: ManagerState, width: number): string[] {
  if (instance === undefined) {
    return ['（未选择技能）', '', '用 ↑/↓ 选择左侧列表中的技能。']
  }
  const lines: string[] = []
  const push = (line: string): void => {
    lines.push(truncateToWidth(line, width, '…'))
  }
  push(`${instance.name}`)
  push(
    `状态 ${STATUS_LABELS[instance.status]} · 来源 ${SOURCE_LABELS[instance.source]} · rank ${instance.rank} · ${instance.scope === 'workspace' ? '工作区' : '全局'}`,
  )
  if (instance.shadowedBy !== undefined) push(`被遮蔽 by ${instance.shadowedBy}`)
  push(`形态 ${instance.form === 'directory' ? '目录束' : '平铺 .md'}`)
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
  push('正文 Body（只读，前 40 行）')
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
  const bodyLines = firstLines(body, 40)
  for (const line of bodyLines) push(`  ${line}`)
  return lines
}

export function createManagerScene(runtime: ManagerRuntime, sceneId: string): ComponentType<TuiSceneProps> {
  return function ManagerScene({ React, ui, close }: TuiSceneProps): ReturnType<typeof ui.Box> {
    const sceneUi = ui as unknown as SceneUi
    const { Box, Text, useInput, useTerminalSize } = sceneUi
    const { columns, rows } = useTerminalSize()
    const [, forceRender] = React.useReducer((value: number) => value + 1, 0)
    const [tab, setTab] = React.useState<Tab>('skills')
    const [scope, setScope] = React.useState<ScopeFilter>('all')
    const [query, setQuery] = React.useState('')
    const [searchMode, setSearchMode] = React.useState(false)
    const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined)
    const [helpOpen, setHelpOpen] = React.useState(false)
    const [narrowDetail, setNarrowDetail] = React.useState(false)
    const [diagOffset, setDiagOffset] = React.useState(0)

    React.useEffect(() => runtime.subscribe(forceRender), [])
    React.useEffect(() => {
      void runtime.ensureFresh()
    }, [])

    const state = runtime.snapshot()
    const scan = state.scan
    const summary = counts(scan)
    const filtered = filterInstances(scan, scope, query)
    const selected = filtered.find((instance) => instance.id === selectedId) ?? filtered[0]
    const selectedIndex = Math.max(
      0,
      filtered.findIndex((instance) => instance.id === selected?.id),
    )

    React.useEffect(() => {
      if (selected === undefined) {
        if (selectedId !== undefined) setSelectedId(undefined)
        return
      }
      if (selected.id !== selectedId) setSelectedId(selected.id)
      void runtime.loadDetail(selected)
    }, [selected?.id])

    const contentWidth = Math.max(20, columns - 2)
    const wide = columns >= 90
    const twoPane = columns >= 64
    const narrow = !twoPane
    const scopeWidth = wide ? Math.min(20, Math.max(16, Math.floor(contentWidth * 0.16))) : 0
    const paneWidth = wide
      ? Math.floor((contentWidth - scopeWidth - 2) / 2)
      : twoPane
        ? Math.floor(contentWidth / 2) - 1
        : contentWidth
    const listWidth = Math.max(16, paneWidth)
    const detailWidth = wide ? Math.max(16, contentWidth - scopeWidth - 2 - listWidth) : Math.max(16, contentWidth - listWidth - 1)
    const visibleRows = Math.max(4, rows - 12)

    const moveSelection = (delta: number): void => {
      if (filtered.length === 0) return
      const next = Math.max(0, Math.min(filtered.length - 1, selectedIndex + delta))
      setSelectedId(filtered[next]?.id)
      setNarrowDetail(false)
    }

    const switchTab = (delta: number): void => {
      const index = TABS.indexOf(tab)
      const next = (index + delta + TABS.length) % TABS.length
      setTab(TABS[next] ?? 'skills')
      setNarrowDetail(false)
      setDiagOffset(0)
    }

    const cycleScope = (): void => {
      const index = SCOPE_FILTERS.indexOf(scope)
      setScope(SCOPE_FILTERS[(index + 1) % SCOPE_FILTERS.length] ?? 'all')
    }

    useInput((input, key) => {
      if (key.ctrl || key.meta) return
      const text = input.replace(/[\r\n]+/gu, '')
      if (helpOpen) {
        if (key.escape || text === '?' || text.toLowerCase() === 'q') setHelpOpen(false)
        return
      }
      if (searchMode) {
        if (key.escape || key.return) {
          setSearchMode(false)
          return
        }
        if (key.backspace || key.delete) {
          setQuery((current) => current.slice(0, -1))
          return
        }
        if (text.length > 0) setQuery((current) => current + text)
        return
      }
      if (key.escape) {
        if (narrow && narrowDetail) {
          setNarrowDetail(false)
          return
        }
        close()
        return
      }
      if (key.tab) {
        switchTab(key.shift ? -1 : 1)
        return
      }
      const char = text.length > 0 ? (text[0]?.toLowerCase() ?? '') : ''
      if (char === 'q') {
        if (narrow && narrowDetail) setNarrowDetail(false)
        else close()
        return
      }
      if (char === '?') {
        setHelpOpen(true)
        return
      }
      if (char === '/') {
        setSearchMode(true)
        return
      }
      if (char === 'r') {
        void runtime.refresh('manual')
        return
      }
      if (char === 'w') {
        void runtime.dumpNow()
        return
      }
      if (char === 'f') {
        cycleScope()
        return
      }
      if (char === '1') setScope('all')
      else if (char === '2') setScope('workspace')
      else if (char === '3') setScope('global')
      if (tab === 'diagnostics') {
        if (key.upArrow || char === 'k') setDiagOffset((value) => Math.max(0, value - 1))
        else if (key.downArrow || char === 'j') setDiagOffset((value) => value + 1)
        else if (key.pageUp) setDiagOffset((value) => Math.max(0, value - visibleRows))
        else if (key.pageDown) setDiagOffset((value) => value + visibleRows)
        else if (key.home) setDiagOffset(0)
        return
      }
      if (key.upArrow || char === 'k') moveSelection(-1)
      else if (key.downArrow || char === 'j') moveSelection(1)
      else if (key.pageUp) moveSelection(-visibleRows)
      else if (key.pageDown) moveSelection(visibleRows)
      else if (key.home) moveSelection(-filtered.length)
      else if (key.end) moveSelection(filtered.length)
      else if (key.return && narrow) setNarrowDetail((value) => !value)
    })

    const tabBar = (
      <Box flexDirection="row">
        {TABS.map((candidate) => (
          <Text key={candidate} bold={candidate === tab} inverse={candidate === tab} dimColor={candidate !== tab}>
            {` ${TAB_LABELS[candidate]} `}
          </Text>
        ))}
      </Box>
    )

    const scopeBar = (
      <Box flexDirection="row">
        {SCOPE_FILTERS.map((candidate) => {
          const count = candidate === 'all' ? summary.total : candidate === 'workspace' ? summary.workspace : summary.global
          return (
            <Text key={candidate} inverse={candidate === scope} dimColor={candidate !== scope}>
              {` ${SCOPE_LABELS[candidate]}(${count}) `}
            </Text>
          )
        })}
      </Box>
    )

    const topLines = [
      `Skill / MCP manager · ${columns}x${rows} · scene=${sceneId}`,
      searchMode
        ? `搜索: ${query}▌  (Enter/Esc 退出)`
        : `共 ${summary.total} · 生效 ${summary.enabled - summary.shadowed} · 停用 ${summary.disabled} · 无效 ${summary.invalid} · 遮蔽 ${summary.shadowed}${query.length > 0 ? ` · 过滤 "${query}"` : ''}`,
    ]

    if (helpOpen) {
      return (
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Text bold>{topLines[0]}</Text>
          {tabBar}
          <Box flexDirection="column" flexGrow={1} marginTop={1}>
            {HELP_LINES.map((line, index) => (
              <Text key={`help-${index}`} wrap="truncate">
                {line}
              </Text>
            ))}
          </Box>
          <Text dimColor>Esc/? 关闭帮助</Text>
        </Box>
      )
    }

    const listHeader = `技能列表 · ${SCOPE_LABELS[scope]}${query.length > 0 ? ` · "${query}"` : ''}`
    const listWindowStart = Math.max(0, Math.min(selectedIndex - Math.floor(visibleRows / 2), Math.max(0, filtered.length - visibleRows)))
    const listWindow = filtered.slice(listWindowStart, listWindowStart + visibleRows)
    const listPane = (
      <Box flexDirection="column" width={narrow ? contentWidth : listWidth}>
        <Text bold dimColor>
          {truncateToWidth(listHeader, listWidth, '…')}
        </Text>
        {filtered.length === 0 ? (
          <Text dimColor wrap="wrap">
            {scan === undefined
              ? '扫描中…'
              : query.length > 0
                ? '没有匹配的技能（/ 修改搜索，Esc 退出搜索）。'
                : scope !== 'all' && summary.total > 0
                  ? `当前筛选「${SCOPE_LABELS[scope]}」下没有技能（f 切换作用域）。`
                  : '没有任何技能。把技能放到发现根即可：\n  <project>/.dsh/skills/<name>/SKILL.md\n  或 ~/.dsh/skills/<name>/SKILL.md'}
          </Text>
        ) : (
          listWindow.map((instance) => {
            const isSelected = instance.id === selected?.id
            const glyph = STATUS_GLYPHS[instance.status]
            const line = `${glyph} ${instance.name}  ${SOURCE_LABELS[instance.source]}  ${statusFlags(instance)}`
            return (
              <Text key={instance.id} inverse={isSelected} bold={isSelected} wrap="truncate">
                {padToWidth(line, listWidth)}
              </Text>
            )
          })
        )}
        {filtered.length > visibleRows ? (
          <Text dimColor>
            {`${listWindowStart + 1}-${Math.min(listWindowStart + visibleRows, filtered.length)} / ${filtered.length}`}
          </Text>
        ) : null}
      </Box>
    )

    const detailLines = skillDetailLines(selected, state, narrow ? contentWidth : detailWidth)
    const detailPane = (
      <Box flexDirection="column" width={narrow ? contentWidth : detailWidth}>
        <Text bold dimColor>
          {selected === undefined ? '详情' : `详情 · ${truncateToWidth(selected.name, Math.max(8, detailWidth - 8))}`}
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          {detailLines.slice(0, Math.max(6, rows - 12)).map((line, index) => (
            <Text key={`detail-${index}`} wrap="truncate" dimColor={index > 0 && line.startsWith('   ')}>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    )

    const skillsContent = narrow ? (
      narrowDetail && selected !== undefined ? detailPane : listPane
    ) : (
      <Box flexDirection="row" flexGrow={1}>
        {wide ? (
          <Box flexDirection="column" width={scopeWidth}>
            <Text bold dimColor>
              作用域
            </Text>
            {scopeBar}
          </Box>
        ) : null}
        {listPane}
        <Box width={1} />
        {detailPane}
      </Box>
    )

    const placeholder = (title: string, lines: string[]): ReturnType<typeof ui.Box> => (
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text bold>{title}</Text>
        {lines.map((line, index) => (
          <Text key={`placeholder-${index}`} wrap="truncate" dimColor>
            {line}
          </Text>
        ))}
      </Box>
    )

    const diagnosticsAll = diagnosticLines(state, contentWidth)
    const diagnosticsWindow = diagnosticsAll.slice(diagOffset, diagOffset + Math.max(6, rows - 8))

    const body =
      tab === 'skills' ? (
        skillsContent
      ) : tab === 'mcp' ? (
        placeholder('MCP（M3 计划）', [
          '当前版本尚未解析 profile patch 的 MCP 行。',
          '已确认的宿主限制：MCP 没有工作区级配置；',
          '只有当前 profile（可写）+ home 全局层（只读）。',
          '启停以 patch 文本编辑为主路径（ADR-0001）。',
          'pluginManager 能力探测见「诊断」页。',
        ])
      ) : tab === 'groups' ? (
        placeholder('分组（M2 计划）', [
          '分组是显示层元数据，不写技能目录。',
          '技能分组与 web 版共享 groups.json（v1），MCP 分组存本插件配置。',
          'M1 先落地技能只读列表/详情。',
        ])
      ) : (
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {diagnosticsWindow.map((line, index) => (
            <Text key={`diag-${diagOffset + index}`} wrap="truncate" dimColor={line.startsWith('  ')}>
              {line}
            </Text>
          ))}
          {diagnosticsAll.length > diagnosticsWindow.length ? (
            <Text dimColor>
              {`${diagOffset + 1}-${diagOffset + diagnosticsWindow.length} / ${diagnosticsAll.length}（↑/↓ 滚动）`}
            </Text>
          ) : null}
        </Box>
      )

    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Text bold>{topLines[0]}</Text>
        <Box flexDirection="row">
          {tabBar}
          {tab === 'skills' && !wide ? <Box width={1} /> : null}
          {tab === 'skills' && !wide ? scopeBar : null}
        </Box>
        <Text dimColor wrap="truncate">
          {topLines[1]}
        </Text>
        {body}
        <Text bold dimColor wrap="truncate">
          {`↑↓ 移动 · Tab 页签 · / 搜索 · f 作用域 · r 刷新 · ${narrow ? 'Enter 详情 · ' : ''}? 帮助 · q 关闭`}
        </Text>
        {state.status === 'error' ? (
          <Text wrap="truncate">{`错误：${state.error ?? 'unknown'}`}</Text>
        ) : state.dumpMessage !== undefined ? (
          <Text dimColor wrap="truncate">
            {state.dumpMessage}
          </Text>
        ) : null}
      </Box>
    )
  }
}
