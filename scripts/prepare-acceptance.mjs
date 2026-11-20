/** Prepare reproducible manual acceptance fixtures; never launch a UI or a model turn. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
assert.ok(process.argv[2], 'usage: node scripts/prepare-acceptance.mjs <CLI-installed host directory>')
const host = resolve(process.argv[2])
const root = await mkdtemp(join(tmpdir(), 'skill-mcp-acceptance-'))
const prepare = (script, ...args) => JSON.parse(execFileSync(process.execPath,
  [join(repo, 'scripts', script), host, ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
// Installation preparation packs/builds our own plugin. Run after check:release,
// with all test UIs closed, so a source-linked scene cannot observe half a build.
const install = prepare('prepare-install-probe.mjs')
const fullscreen = prepare('prepare-skill-layout-probe.mjs', '--mode=fullscreen')
const inline = prepare('prepare-skill-layout-probe.mjs', '--mode=inline')
const sync = prepare('prepare-skill-sync-probe.mjs')
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() !== ''
const documents = await Promise.all([
  ['docs/release-readiness.md', '## 4. ', '完整验收步骤与预期'],
  ['docs/release-readiness.md', '## 40. ', '本轮升级核对、影响与限制'],
  ['docs/release-readiness.md', '### 11.5 ', '遇到已知问题时快速定位'],
  ['docs/需求文档.md', '### 14.1 ', '剩余 P0 与推进顺序（参考）'],
].map(async ([file, prefix, purpose]) => {
  const path = join(repo, file)
  const lines = (await readFile(path, 'utf8')).split('\n')
  const index = lines.findIndex(line => line.startsWith(prefix))
  assert.ok(index >= 0, `acceptance document heading missing: ${path} ${prefix}`)
  return { purpose, path, line: index + 1, heading: lines[index] }
}))
const cases = [
  ['AC-9', '实际 tgz 安装、信任提示、停用/再启用、卸载后配置与数据保留', 'install'],
  ['AC-10', '目录束/平铺、同名回退、只读 bundled、/skills 与模型请求级技能同步', 'sync'],
  ['AC-11', '受管 stdio 新增/编辑/启停/删除；HMR、/mcp 及模型工具同步、失败/超时', 'fullscreen'],
  ['AC-12', '测试 env/headers 表达式往返与脱敏；HTTP 使用自控端点', 'fullscreen'],
  ['AC-13', '技能/受管 MCP 删除、冷启动撤销、外部变更冲突与备份恢复', 'fullscreen'],
  ['FR-8/9', '技能及 MCP 分组、搜索/状态交集、重开保留；另建 profile 验证 MCP 分组隔离', 'fullscreen'],
  ['AC-14-fullscreen', '场景宽 <64、64–89、≥90；键盘/鼠标、缩放、长内容、空结果和取消', 'fullscreen'],
  ['AC-14-inline', '同一布局/交互矩阵；关闭面板返回普通聊天页后核对 terminal-mode.json：不在备用屏幕', 'inline'],
  ['AC-15', 'web/TUI 顺序共存；KI-01～03 与无锁分组并发仍未关闭', null],
  ['AC-16/18', '只读和作用域限制、诊断版本来源、信任提示、退出后宿主键盘正常', 'fullscreen'],
  ['NFR-performance', '目标存储和用户终端环境的首次打开、搜索性能', null],
]
const report = { preparedAt: new Date().toISOString(), plugin: pkg.version, commit, dirty,
  host: fullscreen.hostVersion, kernel: fullscreen.kernelVersion, node: fullscreen.nodeVersion,
  fixtures: { install, fullscreen, inline, sync },
  documents,
  executionPolicy: { decision: 'D-14', fixedRegressionOwner: 'agent',
    userRole: '真实使用、现场体验及 agent 无法访问的环境反馈；不要求重复跑固定清单或填写 JSON',
    evidenceRule: '先复用对应当前代码/环境的有效证据；未覆盖的固定流程由 agent 补齐，不自动勾选通过',
    externalConditions: '私有账号/服务、模型费用或不可访问环境先说明具体条件和有限请求范围，再沿用或取得必要授权' },
  cases: cases.map(([id, expected, fixture]) => ({ id, owner: 'agent', expected, fixture, status: 'pending', actual: '', evidence: [] })),
  limitations: ['准备成功不代表验收通过', '本地 HTTP/web 夹具由 agent 准备；私有服务、真实账号或模型请求先明确条件与授权',
    'FR-17 MCP 强制覆盖、元数据保留和共享分组并发边界仍按需求 §14.1；不因本包自动豁免',
    '未启动 UI、未安装 tgz、未请求模型、未改真实用户配置；只构建自己的插件并准备临时夹具'],
}
await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const text = `验收/复现工具包 · ${pkg.version} · ${commit}${dirty ? '（工作区有未提交修改）' : ''}
分工 D-14：固定流程由 agent 负责，优先复用已有有效证据，再补缺口。
用户正常使用并反馈现场问题，不要求例行执行整表或填写 JSON。
环境：host ${report.host} / DSH ${report.kernel} / Node ${report.node}
结果：${join(root, 'results.json')}（供执行者记录；初始 pending 不代表用户欠测）
以下为执行者的参考地址；只有需用户复现具体故障时，才另给最小步骤：
${documents.map((doc, index) => `${index + 1}. ${doc.purpose}：${doc.path}:${doc.line}`).join('\n')}

先关闭其他测试 TUI，再分别运行；不要同时改同一个夹具。
1. fullscreen：${quote(fullscreen.launcher)}
2. inline：${quote(inline.launcher)}
   /skill-mcp → 1 技能、2 MCP、3 分组、4 诊断；? 查看对应快捷键。
   在上述两种模式调整终端，按标题显示的场景宽检查 <64 / 64–89 / ≥90。
   先打开面板，再 Esc 关闭并回到普通聊天页，核对模式记录（observedOutput 应为 true）：
   fullscreen：${fullscreen.modeObservation}（alternateScreenActive 应为 true）
   inline：${inline.modeObservation}（alternateScreenActive 应为 false）
   注意：宿主落地页和全屏面板都会临时进入备用屏幕，停留其上时不要据此判断聊天模式。
   保持 TUI 运行，在另一终端读取该记录；退出 TUI 后备用屏幕会关闭，不能再用其状态判断聊天模式。
   记录缺失或不可读时标为未验证，不能用配置值代替。
   初始 mcp-probe 停用；冷启动已启用 MCP 的 TTY 风险见 KI-03，专项另行记录。
3. 技能同步：${quote(sync.launcher)}；观察步骤见发布准备 §10。
4. 实际安装：${quote(install.manage)} add ${quote(install.archive)}
   然后 ${quote(install.launcher)}；当前生命周期核对见发布准备 §40、§42、§43。
   在 TUI 内卸载后，看到宿主显示“已卸载”再输入安装命令，随后核对信任提示。
   停用/再启用/卸载必须操作这个临时 profile，不要换成真实 profile。

AC-12 的 HTTP、模型请求级 AC-10/11 与 AC-15 不能仅用这些本地夹具勾选通过。
web 候选补丁、旧 rc.1 兼容实验不在本包中；不写真实 ~/.dsh，不打 tag，不发布。
复用前重新生成本包：源码、依赖、CLI 升级会使旧 /tmp 夹具过期。
`
await writeFile(join(root, 'START.txt'), text, { mode: 0o600 })
await chmod(root, 0o700)
console.log(JSON.stringify({ root, instructions: join(root, 'START.txt'), results: join(root, 'results.json'),
  host: report.host, kernel: report.kernel, dirty, archive: install.archive }, null, 2))
