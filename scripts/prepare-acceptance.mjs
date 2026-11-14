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
const cases = [
  ['AC-9', '实际 tgz 安装、信任提示、停用/再启用、卸载后配置与数据保留', 'install'],
  ['AC-10', '目录束/平铺、同名回退、只读 bundled、/skills 与模型请求级技能同步', 'sync'],
  ['AC-11', '受管 stdio 新增/编辑/启停/删除；HMR、/mcp 及模型工具同步、失败/超时', 'fullscreen'],
  ['AC-12', '测试 env/headers 表达式往返与脱敏；HTTP 使用自控端点', 'fullscreen'],
  ['AC-13', '技能/受管 MCP 删除、冷启动撤销、外部变更冲突与备份恢复', 'fullscreen'],
  ['FR-8/9', '技能及 MCP 分组、搜索/状态交集、重开保留；另建 profile 验证 MCP 分组隔离', 'fullscreen'],
  ['AC-14-fullscreen', '场景宽 <64、64–89、≥90；键盘/鼠标、缩放、长内容、空结果和取消', 'fullscreen'],
  ['AC-14-inline', '同一布局/交互矩阵；实际模式核对临时 user/.dsh-tui/restart.log', 'inline'],
  ['AC-15', 'web/TUI 顺序共存；KI-01～03 与无锁分组并发仍未关闭', null],
  ['AC-16/18', '只读和作用域限制、诊断版本来源、信任提示、退出后宿主键盘正常', 'fullscreen'],
  ['NFR-performance', '目标存储和用户终端环境的首次打开、搜索性能', null],
]
const report = { preparedAt: new Date().toISOString(), plugin: pkg.version, commit, dirty,
  host: fullscreen.hostVersion, kernel: fullscreen.kernelVersion, node: fullscreen.nodeVersion,
  fixtures: { install, fullscreen, inline, sync },
  cases: cases.map(([id, expected, fixture]) => ({ id, expected, fixture, status: 'pending', actual: '', evidence: [] })),
  limitations: ['准备成功不代表验收通过', '模型请求、HTTP 端点及 web 共存需用户自行准备',
    'FR-17 MCP 强制覆盖、元数据保留和共享分组并发边界仍按需求 §14.1；不因本包自动豁免',
    '未启动 UI、未安装 tgz、未请求模型、未改真实用户配置；只构建自己的插件并准备临时夹具'],
}
await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const text = `手工验收包 · ${pkg.version} · ${commit}${dirty ? '（工作区有未提交修改）' : ''}
环境：host ${report.host} / DSH ${report.kernel} / Node ${report.node}
结果：${join(root, 'results.json')}（全部 pending，逐项填写实际结果和脱敏证据）
权威步骤与剩余缺口：${join(repo, 'docs/release-readiness.md')} §4 / §23；需求 §14.1。

先关闭其他测试 TUI，再分别运行；不要同时改同一个夹具。
1. fullscreen：${quote(fullscreen.launcher)}
2. inline：${quote(inline.launcher)}
   /skill-mcp → 1 技能、2 MCP、3 分组、4 诊断；? 查看对应快捷键。
   在上述两种模式调整终端，按标题显示的场景宽检查 <64 / 64–89 / ≥90。
   初始 mcp-probe 停用；冷启动已启用 MCP 的 TTY 风险见 KI-03，专项另行记录。
3. 技能同步：${quote(sync.launcher)}；观察步骤见发布准备 §10。
4. 实际安装：${quote(install.manage)} add ${quote(install.archive)}
   然后 ${quote(install.launcher)}；生命周期核对见发布准备 §8。
   停用/再启用/卸载必须操作这个临时 profile，不要换成真实 profile。

AC-12 的 HTTP、模型请求级 AC-10/11 与 AC-15 不能仅用这些本地夹具勾选通过。
web 候选补丁、旧 rc.1 兼容实验不在本包中；不写真实 ~/.dsh，不打 tag，不发布。
复用前重新生成本包：源码、依赖、CLI 升级会使旧 /tmp 夹具过期。
`
await writeFile(join(root, 'START.txt'), text, { mode: 0o600 })
await chmod(root, 0o700)
console.log(JSON.stringify({ root, instructions: join(root, 'START.txt'), results: join(root, 'results.json'),
  host: report.host, kernel: report.kernel, dirty, archive: install.archive }, null, 2))
