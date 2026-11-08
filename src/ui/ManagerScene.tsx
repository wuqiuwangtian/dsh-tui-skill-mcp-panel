/**
 * Full-screen manager scene (M1): skills read-only list + detail, host
 * diagnostics, and placeholders for the M2/M3 tabs.
 *
 * Interaction model:
 * - keyboard is primary and sufficient: ↑/↓ select, ←/→ switch scope,
 *   Tab switches pages, Enter opens detail on narrow terminals;
 * - mouse is additive where the host routes events (fullscreen): click tabs /
 *   scope / rows, wheel scrolls the list, detail or diagnostics pane.
 * Host dialogs/toasts remain unusable from plugin scenes (docs/research/05).
 */
import type { ComponentType, ReactNode } from 'react'
import { isAbsolute } from 'node:path'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { groupMemberCount } from '../domain/groups.js'
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
  '  Tab / Shift+Tab     切换页签；数字 1-4 直达',
  '  Enter              进入详情；分组页应用分组过滤',
  '  空格               启用/停用选中技能（有标记时批量）',
  '  v                  标记/取消标记当前技能（批量操作用）',
  '  d                  删除选中/标记技能（回收站，可撤销）',
  '  u                  撤销最近一次删除',
  '  a                  添加技能（本地路径导入）',
  '  g                  把选中/标记技能加入或移出分组',
  '  x                  清除分组过滤 / 清除标记',
  '  /                  搜索（Enter/Esc 退出搜索）',
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
  '  · 迁移/复制、zip 导入为 P1，尚未实现；MCP 管理在 M3。',
]


const MCP_PLACEHOLDER_LINES = [
  '当前版本尚未解析 profile patch 的 MCP 行。',
  '已确认的宿主限制：MCP 没有工作区级配置；',
  '只有当前 profile（可写）+ home 全局层（只读）。',
  '启停以 patch 文本编辑为主路径（ADR-0001）。',
  'pluginManager 能力探测见「诊断」页。',
]

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
  for (const line of firstLines(body, 400)) push(`  ${line}`)
  return lines
}


type FocusArea = 'tabs' | 'scope' | 'list' | 'detail' | 'body'

const HELP_HINTS = '? 帮助'

type Modal =
  | { kind: 'confirm'; title: string; message: string[]; danger?: boolean; onConfirm: () => void }
  | { kind: 'input'; title: string; label: string; value: string; hint?: string; validate?: (value: string) => string | undefined; onSubmit: (value: string) => void }
  | { kind: 'select'; title: string; options: { id: string; label: string; hint?: string }[]; index: number; onSubmit: (id: string) => void }
  | { kind: 'info'; title: string; lines: string[] }

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
    const [focus, setFocus] = React.useState<FocusArea>('list')
    const [diagOffset, setDiagOffset] = React.useState(0)
    const [detailOffset, setDetailOffset] = React.useState(0)
    const [marked, setMarked] = React.useState<Set<string>>(() => new Set())
    const [groupFilter, setGroupFilter] = React.useState<string | undefined>(undefined)
    const [groupSelectedId, setGroupSelectedId] = React.useState<string | undefined>(undefined)
    const [modal, setModal] = React.useState<Modal | undefined>(undefined)

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
    const selected = filtered.find((instance) => instance.id === selectedId) ?? filtered[0]
    const selectedIndex = Math.max(
      0,
      filtered.findIndex((instance) => instance.id === selected?.id),
    )
    const groupEntries = Object.entries(state.groups).sort((left, right) => left[1].name.localeCompare(right[1].name))
    const selectedGroupId = groupEntries.some(([id]) => id === groupSelectedId) ? groupSelectedId : groupEntries[0]?.[0]
    const selectedGroupIndex = Math.max(
      0,
      groupEntries.findIndex(([id]) => id === selectedGroupId),
    )

    React.useEffect(() => {
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

    React.useEffect(() => {
      if (groupFilter !== undefined && state.groups[groupFilter] === undefined) setGroupFilter(undefined)
    }, [groupFilter, state.groups])

    // ── layout metrics ──────────────────────────────────────────────────────
    const contentWidth = Math.max(20, columns - 2)
    const wide = columns >= 110
    const twoPane = columns >= 72
    const narrow = !twoPane
    const statusText =
      state.statusMessage?.text ??
      (state.status === 'error' ? `错误：${state.error ?? 'unknown'}` : state.dumpMessage)
    const statusTone = state.statusMessage?.tone ?? (state.status === 'error' ? 'error' : 'info')
    const cardsHeight = Math.max(
      5,
      rows - 4 - (tab === 'skills' && !wide ? 1 : 0) - (statusText === undefined ? 0 : 1),
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
          ...targets.slice(0, 8).map((instance) => `· ${instance.name}  [${SOURCE_LABELS[instance.source]}]`),
          ...(targets.length > 8 ? [`… 其余 ${targets.length - 8} 个`] : []),
        ],
        onConfirm: () => {
          void runtime.deleteSkillInstances(targets)
          clearMarks()
        },
      })
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

    const openGroupPicker = (): void => {
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
      const enabling = selectedGroupId !== groupFilter
      setGroupFilter(enabling ? selectedGroupId : undefined)
      const group = state.groups[selectedGroupId]
      runtime.setStatus(enabling ? `按分组过滤：${group?.name ?? selectedGroupId}（x 清除）` : '已清除分组过滤', 'info')
      if (enabling) goTab('skills')
    }

    const openCreateGroup = (): void => {
      setModal({
        kind: 'input',
        title: '新建分组',
        label: '分组名称',
        value: '',
        onSubmit: (name) => {
          void runtime.createGroup(name)
        },
      })
    }

    const openRenameGroup = (): void => {
      if (selectedGroupId === undefined) {
        runtime.setStatus('还没有分组', 'warning')
        return
      }
      const group = state.groups[selectedGroupId]
      setModal({
        kind: 'input',
        title: '重命名分组',
        label: '新的分组名称',
        value: group?.name ?? '',
        onSubmit: (name) => {
          void runtime.renameGroup(selectedGroupId, name)
        },
      })
    }

    const askDeleteGroup = (): void => {
      if (selectedGroupId === undefined) {
        runtime.setStatus('还没有分组', 'warning')
        return
      }
      const group = state.groups[selectedGroupId]
      setModal({
        kind: 'confirm',
        title: '删除分组',
        message: [`删除分组 "${group?.name ?? selectedGroupId}"？`, '只删除分组元数据，不会删除任何技能。'],
        onConfirm: () => {
          void runtime.deleteGroupById(selectedGroupId)
          if (groupFilter === selectedGroupId) setGroupFilter(undefined)
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
      if (groupEntries.length === 0) return
      const next = Math.max(0, Math.min(groupEntries.length - 1, selectedGroupIndex + delta))
      const entry = groupEntries[next]
      if (entry !== undefined) setGroupSelectedId(entry[0])
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

    const submitInputModal = (target: Extract<Modal, { kind: 'input' }>): void => {
      const value = target.value.trim()
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
      // Human terminals deliver a lone ESC as escape+meta (see Ink's 50ms
      // escape flush), so the modifier guard must never swallow it.
      if ((key.ctrl || key.meta) && !key.escape) return
      const text = input.replace(/[\r\n]+/gu, '')
      const char = text.length > 0 ? (text[0]?.toLowerCase() ?? '') : ''

      if (modal !== undefined) {
        if (modal.kind === 'confirm') {
          if (char === 'y' || key.return) confirmModal(modal)
          else if (char === 'n' || key.escape) setModal(undefined)
          return
        }
        if (modal.kind === 'input') {
          if (key.escape) {
            setModal(undefined)
          } else if (key.return) {
            submitInputModal(modal)
          } else if (key.backspace || key.delete) {
            setModal({ ...modal, value: modal.value.slice(0, -1) })
          } else if (text.length > 0) {
            setModal({ ...modal, value: modal.value + text })
          }
          return
        }
        if (modal.kind === 'select') {
          if (key.escape) {
            setModal(undefined)
          } else if (key.upArrow || char === 'k') {
            setModal({ ...modal, index: Math.max(0, modal.index - 1) })
          } else if (key.downArrow || char === 'j') {
            setModal({ ...modal, index: Math.min(modal.options.length - 1, modal.index + 1) })
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
        if (key.escape || key.return || char === 'q') setModal(undefined)
        return
      }

      if (helpOpen) {
        if (key.escape || text === '?' || char === 'q') setHelpOpen(false)
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
        if (marked.size > 0) {
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
        setHelpOpen(true)
        return
      }
      if (char === '/') {
        setSearchMode(true)
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
        void runtime.undoLastDelete()
        return
      }
      if (char === 'x') {
        if (groupFilter !== undefined) {
          setGroupFilter(undefined)
          runtime.setStatus('已清除分组过滤', 'info')
        } else if (marked.size > 0) {
          clearMarks()
        }
        return
      }

      if (tab === 'groups') {
        if (focus === 'tabs') {
          if (key.leftArrow || char === 'h') switchTab(-1)
          else if (key.rightArrow || char === 'l') switchTab(1)
          else if (key.downArrow || char === 'j' || key.return) setFocus('body')
          return
        }
        if (char === 'a') return openCreateGroup()
        if (char === 'r') return openRenameGroup()
        if (char === 'd') return askDeleteGroup()
        if (key.return) {
          if (selectedGroupId !== undefined) {
            setGroupFilter(selectedGroupId === groupFilter ? undefined : selectedGroupId)
            const group = state.groups[selectedGroupId]
            runtime.setStatus(
              selectedGroupId === groupFilter ? '已清除分组过滤' : `按分组过滤：${group?.name ?? selectedGroupId}（x 清除）`,
              'info',
            )
            if (selectedGroupId !== groupFilter) goTab('skills')
          }
          return
        }
        if (key.upArrow || char === 'k') {
          if (selectedGroupIndex <= 0) setFocus('tabs')
          else moveGroupSelection(-1)
        } else if (key.downArrow || char === 'j') moveGroupSelection(1)
        else if (key.pageUp) moveGroupSelection(-bodyRows)
        else if (key.pageDown) moveGroupSelection(bodyRows)
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
        if (key.upArrow || char === 'k') {
          if (diagOffset === 0) setFocus('tabs')
          else setDiagOffset((value) => Math.max(0, value - 1))
        } else if (key.downArrow || char === 'j') {
          setDiagOffset((value) => value + 1)
        } else if (key.leftArrow || char === 'h') {
          switchTab(-1)
        } else if (key.rightArrow || char === 'l') {
          switchTab(1)
        } else if (key.pageUp) {
          setDiagOffset((value) => Math.max(0, value - bodyRows))
        } else if (key.pageDown) {
          setDiagOffset((value) => value + bodyRows)
        } else if (key.home) {
          setDiagOffset(0)
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
        if (key.upArrow || char === 'k') scrollDetail(-1)
        else if (key.downArrow || char === 'j') scrollDetail(1)
        else if (key.pageUp) scrollDetail(-bodyRows)
        else if (key.pageDown) scrollDetail(bodyRows)
        else if (key.home) setDetailOffset(0)
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
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {options.children}
        </Box>
      </Box>
    )

    const rowNode = (
      key: string,
      content: string,
      options: { selected: boolean; dim?: boolean; onClick?: () => void },
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
      `trash=${state.latestTrash?.batchId ?? '-'} status=${state.statusMessage?.text ?? '-'}`,
      `detail=${state.detail.status}${state.detail.error === undefined ? '' : ` error=${state.detail.error}`}`,
      ...(tab === 'mcp'
        ? ['MCP（M3 计划）', ...MCP_PLACEHOLDER_LINES]
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
    }, [tab, scope, focus, selected?.id, state.scan?.scannedAt, helpOpen, searchMode, query, state.detail.status, state.statusMessage?.at, modal?.kind, marked, groupFilter])

    // ── modal screen ────────────────────────────────────────────────────────
    if (modal !== undefined) {
      const modalDanger = modal.kind === 'confirm' && modal.danger === true
      const modalWidth = Math.max(30, Math.min(contentWidth, 100))
      const modalBody = ((): ReactNode => {
        if (modal.kind === 'confirm') {
          return (
            <>
              {modal.message.map((line, index) => (
                <Text key={`modal-${index}`} wrap="truncate" dimColor={index > 0}>
                  {index === 0 ? line : line}
                </Text>
              ))}
              <Box flexDirection="row" height={1}>
                <Box onClick={() => confirmModal(modal)}>
                  <Text color="accent">[y 确认]</Text>
                </Box>
                <Text> </Text>
                <Box onClick={() => setModal(undefined)}>
                  <Text>[n / Esc 取消]</Text>
                </Box>
              </Box>
            </>
          )
        }
        if (modal.kind === 'input') {
          return (
            <>
              <Text dimColor wrap="truncate">
                {`${modal.label}：`}
              </Text>
              <Box flexDirection="row" height={1}>
                <Text color="accent">❯ </Text>
                <Text wrap="truncate">{modal.value}</Text>
                <Text color="accent">▌</Text>
              </Box>
              {modal.hint === undefined ? null : (
                <Text dimColor wrap="truncate">
                  {modal.hint}
                </Text>
              )}
              <Box flexDirection="row" height={1}>
                <Box onClick={() => submitInputModal(modal)}>
                  <Text color="accent">[Enter 提交]</Text>
                </Box>
                <Text> </Text>
                <Box onClick={() => setModal(undefined)}>
                  <Text>[Esc 取消]</Text>
                </Box>
              </Box>
            </>
          )
        }
        if (modal.kind === 'select') {
          return (
            <>
              {modal.options.map((option, index) => {
                const active = index === modal.index
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
                    <Text bold={active} wrap="truncate">
                      {option.label}
                    </Text>
                    {option.hint === undefined ? null : (
                      <Text dimColor wrap="truncate">
                        {`  ${option.hint}`}
                      </Text>
                    )}
                  </Box>
                )
              })}
              <Text dimColor>↑/↓ 选择 · Enter 确认 · Esc 取消</Text>
            </>
          )
        }
        return (
          <>
            {modal.lines.map((line, index) => (
              <Text key={`modal-info-${index}`} wrap="truncate">
                {line}
              </Text>
            ))}
            <Text dimColor>Enter/Esc 关闭</Text>
          </>
        )
      })()
      return (
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Box flexDirection="row" height={1}>
            <Text bold color="accent">
              Skill / MCP manager
            </Text>
            <Box flexGrow={1} />
            <Text dimColor>{sceneId}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} marginTop={1}>
            <Box
              flexDirection="column"
              width={modalWidth}
              borderStyle="round"
              borderColor={modalDanger ? 'error' : 'accent'}
              paddingX={1}
            >
              <Text bold color={modalDanger ? 'error' : 'accent'} wrap="truncate">
                {modal.title}
              </Text>
              {modalBody}
            </Box>
          </Box>
          <Text dimColor wrap="truncate">
            {state.statusMessage?.text ?? ''}
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
          {searchMode ? `搜索: ${query}▌  (Enter/Esc)` : tab === 'skills' ? `${SCOPE_LABELS[scope]} · ${filtered.length} 项${groupFilter === undefined ? '' : ` · 分组:${state.groups[groupFilter]?.name ?? groupFilter}`}` : ''}
        </Text>
      </Box>
    )

    if (helpOpen) {
      return (
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Box flexDirection="row" height={1}>
            <Text bold color="accent">
              Skill / MCP manager
            </Text>
            <Box flexGrow={1} />
            <Text dimColor>帮助 Help · {columns}x{rows}</Text>
          </Box>
          {tabBar}
          <Box flexDirection="column" flexGrow={1} marginTop={1}>
            {HELP_LINES.map((line, index) => (
              <Text key={`help-${index}`} wrap="truncate" bold={index === 0} color={index === 0 ? 'accent' : undefined} dimColor={index > 0 && line.startsWith('  ')}>
                {line}
              </Text>
            ))}
          </Box>
          <Text dimColor>Esc/? 关闭帮助</Text>
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
              {` ${SCOPE_LABELS[candidate]}(${scopeCounts[candidate]}) `}
            </Text>
          </Box>
        ))}
      </Box>
    )

    // ── skills panes ────────────────────────────────────────────────────────
    const listWindowStart = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(bodyRows / 2), Math.max(0, filtered.length - bodyRows)),
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
        : filtered.slice(listWindowStart, listWindowStart + bodyRows).map((instance) => {
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
              onClick: () => {
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
        ...(filtered.length > bodyRows
          ? [
              <Text key="scroll-hint" dimColor>
                {`${listWindowStart + 1}-${Math.min(listWindowStart + bodyRows, filtered.length)} / ${filtered.length}`}
              </Text>,
            ]
          : []),
      ],
    })

    const detailLines = skillDetailLines(selected, state, detailWidth - 4)
    const detailWindow = detailLines.slice(detailOffset, detailOffset + bodyRows)
    const detailCard = card({
      title: '详情',
      subtitle:
        selected === undefined
          ? undefined
          : `${truncateToWidth(selected.name, Math.max(8, detailWidth - 12))}${detailLines.length > bodyRows ? `  ↕${detailOffset + 1}/${detailLines.length}` : ''}`,
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

    // ── groups tab ──────────────────────────────────────────────────────────
    const groupRows = groupEntries.length === 0
      ? [
          <Text key="groups-empty" dimColor wrap="wrap">
            还没有分组。按 a 新建分组，或在技能页按 g 把技能加入分组。
          </Text>,
        ]
      : groupEntries.slice(0, bodyRows).map(([id, group]) => {
          const here = (group.scopes[scan?.projectRoot ?? 'workspace'] ?? []).length
          const globalCount = (group.scopes.global ?? []).length
          const isSelected = id === selectedGroupId
          const filteredFlag = groupFilter === id ? ' · 过滤中' : ''
          return rowNode(id, truncateToWidth(`${padToWidth(group.name, Math.max(8, contentWidth - 40))}  ${groupMemberCount(group)} 个成员（当前作用域 ${here} / 全局 ${globalCount}）${filteredFlag}`, contentWidth - 6), {
            selected: isSelected,
            dim: groupMemberCount(group) === 0,
            onClick: () => setGroupSelectedId(id),
          })
        })

    const groupsCard = card({
      title: '分组 Groups',
      subtitle: `${groupEntries.length} 组${groupFilter === undefined ? '' : ` · 过滤: ${state.groups[groupFilter]?.name ?? groupFilter}（x 清除）`}`,
      focused: tab === 'groups' && focus === 'body',
      width: contentWidth,
      onClick: () => setFocus('body'),
      children: groupRows,
    })

    // ── mcp / diagnostics tab ───────────────────────────────────────────────
    const bodyLines =
      tab === 'mcp'
        ? ['MCP（M3 计划）', ...MCP_PLACEHOLDER_LINES]
        : tab === 'groups'
          ? []
          : diagnosticLines(state, contentWidth - 4)
    const bodyWindow = bodyLines.slice(diagOffset, diagOffset + bodyRows)
    const bodyCard = card({
      title: tab === 'mcp' ? 'MCP' : '诊断 Diagnostics',
      subtitle: tab === 'diagnostics' ? `扫描 ${scan?.scannedAt ?? '(pending)'}` : undefined,
      focused: tab !== 'skills' && tab !== 'groups' && focus === 'body',
      width: contentWidth,
      onClick: () => setFocus('body'),
      onWheel: (event: { deltaY: number }) => {
        if (event.deltaY === 0) return
        setFocus('body')
        setDiagOffset((value) => Math.max(0, value + (event.deltaY > 0 ? 1 : -1)))
      },
      children: bodyWindow.map((line, index) => (
        <Text key={`body-${diagOffset + index}`} wrap="truncate" dimColor={line.startsWith('  ')}>
          {line}
        </Text>
      )),
    })

    const footerStats = state.busy
      ? '处理中…'
      : `共 ${summary.total} · 生效 ${summary.enabled - summary.shadowed} · 停用 ${summary.disabled} · 无效 ${summary.invalid} · 遮蔽 ${summary.shadowed}`
    const statusColor =
      statusTone === 'success' ? 'success' : statusTone === 'warning' ? 'warning' : statusTone === 'error' ? 'error' : 'accent'

    // Mouse parity: every keyboard action also exists as a clickable footer button.
    const fullActions = columns >= 110
    const actionButton = (label: string, onClick: () => void): ReactNode => (
      <Box key={label} onClick={onClick}>
        <Text color="accent">{`[${label}] `}</Text>
      </Box>
    )
    const actionItems: { label: string; onClick: () => void }[] =
      tab === 'skills'
        ? fullActions
          ? [
              { label: '空格 启停', onClick: runToggle },
              { label: 'v 标记', onClick: () => pressMark() },
              { label: 'd 删除', onClick: askDelete },
              { label: 'u 撤销', onClick: () => void runtime.undoLastDelete() },
              { label: 'a 添加', onClick: openAdd },
              { label: 'g 分组', onClick: openGroupPicker },
              { label: '/ 搜索', onClick: () => setSearchMode(true) },
              { label: 'r 刷新', onClick: () => void runtime.refresh('manual') },
              { label: '? 帮助', onClick: () => setHelpOpen(true) },
            ]
          : [
              { label: '␣启停', onClick: runToggle },
              { label: 'v标记', onClick: () => pressMark() },
              { label: 'd删除', onClick: askDelete },
              { label: 'u撤销', onClick: () => void runtime.undoLastDelete() },
              { label: 'a添加', onClick: openAdd },
              { label: 'g分组', onClick: openGroupPicker },
              { label: '?', onClick: () => setHelpOpen(true) },
            ]
        : tab === 'groups'
          ? fullActions
            ? [
                { label: 'a 新建', onClick: openCreateGroup },
                { label: 'r 重命名', onClick: openRenameGroup },
                { label: 'd 删除', onClick: askDeleteGroup },
                { label: '↵ 过滤', onClick: toggleGroupFilter },
                { label: 'x 清除', onClick: () => setGroupFilter(undefined) },
                { label: '? 帮助', onClick: () => setHelpOpen(true) },
              ]
            : [
                { label: 'a新建', onClick: openCreateGroup },
                { label: 'r改名', onClick: openRenameGroup },
                { label: 'd删除', onClick: askDeleteGroup },
                { label: '↵过滤', onClick: toggleGroupFilter },
                { label: '?', onClick: () => setHelpOpen(true) },
              ]
          : [
              { label: 'r 刷新', onClick: () => void runtime.refresh('manual') },
              { label: '? 帮助', onClick: () => setHelpOpen(true) },
            ]

    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Box flexDirection="row" height={1}>
          <Text bold color="accent">
            Skill / MCP manager
          </Text>
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            {sceneId} · {columns}x{rows}
          </Text>
        </Box>
        {tabBar}
        {tab === 'skills' && !wide ? scopeChips : null}
        {tab === 'skills' ? skillsBody : tab === 'groups' ? groupsCard : bodyCard}
        <Box flexDirection="row" height={1}>
          {actionItems.map((item) => actionButton(item.label, item.onClick))}
          <Box flexGrow={1} />
          {fullActions ? (
            <Text dimColor wrap="truncate">
              {footerStats}
            </Text>
          ) : null}
        </Box>
        {statusText === undefined ? null : (
          <Text color={statusColor} wrap="truncate">
            {statusText}
          </Text>
        )}
      </Box>
    )
  }
}
