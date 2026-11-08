# 05 · M0 真机探针实测（2026-11-08）

> 目的：用最小可安装插件在**真实 TUI 进程**里验证 [`01`](01-dsh-tui-plugin-architecture.md) §9、[`../需求文档.md`](../需求文档.md) §12 的未验证项（Q7–Q11），把「源码推断」升级为「实测结论」。
> 结论按 **01 §0.2** 的分级标注；本次全部来自实跑。原始报告见 [`evidence/2026-11-08-probe-report-run2.json`](evidence/2026-11-08-probe-report-run2.json)（第二次运行：能力就绪、inject 代理、skills 快照）。
> **证据说明**：第一次运行的报告文件在第二次启动时被同名覆盖；Q8 的 dialog/toast 观测与 Q9 的 `setEnabled` 返回体（含 `elapsedMs=32947`、`unknown-plugin`）记录在本文 §2 表格与本会话操作记录中，第二次运行复现了相同的「服务就绪/代理就绪」前置条件。后续探针应把每次运行写到独立文件名。

## 1. 环境与方法

| 项 | 值 |
| --- | --- |
| dsh-TUI | `@deepseek-harness-tui/dsh-tui@0.19.0` |
| DSH 内核 | `@deepseek-ai/dsh@0.2.2-rc.1` |
| Node | v26.3.0 |
| 探针 profile | `~/.dsh/profiles/dsh-tui-probe`（由 `dsh-tui` profile 复制而来；`dsh.profile.bundles` 裁剪为 `dsh-base` + `dsh-tui`，隔离 remote/experimental 行） |
| 安装方式 | `dsh plugin --profile dsh-tui-probe add /home/wqwt/code/dsh-tui-skill-mcp-panel`（pnpm `link:`；CLI 自动把包加入 `bundles`） |
| 启动 | `DSH_HOME=~/.dsh`（默认），`cwd=/home/wqwt/code/dsh-tui-skill-mcp-panel`，profile patch 覆盖 `fullscreen: true`、`lang: zh` |
| 驱动 | 真实 pty（终端会话内 `script -q -e -f <log> -c "dsh --profile dsh-tui-probe"`），键盘注入 + scene 内状态；插件把结果写 JSON 报告 |

探针插件本体当时落在仓库（提交 `3d2ddfa`）：`src/index.ts`（`name`/`Config`/`apply`）、`src/host/register.ts`（场景 + `/skill-mcp*` 命令）、`src/ui/ProbeScene.tsx`（全屏诊断场景）、`src/host/probe-runtime.ts`（能力探测 / 报告 / HMR 采样）。**M1（2026-11-08）起已被 `src/domain/skills` + `src/ui/ManagerScene.tsx` 替换**；需要复跑 Q8 探针时从该提交取回代码。

复现要点：

```sh
# 仓库内构建
pnpm build
# 独立 profile（不再复现可跳过；不要用它覆盖日常 profile）
cp -a ~/.dsh/profiles/dsh-tui ~/.dsh/profiles/dsh-tui-probe
# 编辑 probe/package.json：name 改 dsh-profile-dsh-tui-probe，bundles 裁为 dsh-base + dsh-tui
dsh plugin --profile dsh-tui-probe add /home/wqwt/code/dsh-tui-skill-mcp-panel
# 真实 TTY 里启动（TERM 不能是 dumb）
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID TERM=xterm-256color \
  dsh --profile dsh-tui-probe
# 场景内按 d/e/s/i/t/x 触发探测；报告写在 /tmp/dsh-tui-skill-mcp-panel/probe-report.json
```

## 2. 结论总表（Q7–Q11）

| 编号 | 结论 | 证据（本次实测） |
| --- | --- | --- |
| **Q7** host 层 `ctx.skills` | **已验证：不能依赖。** 服务已注册（`snapshot()`/`list()`/`collect*()` 都在），但 `list()` 返回 `[]`、`snapshot()` 返回 `{ skills: [], complete: … }`（skills 数组长度 0）。与 01 §1.2 的推断一致：host 层 `skill-filesystem` 被禁用，列表必须**按发现规则扫盘**。 | run2 报告 `skillsProbe`：`snapshot.skillsCount=0`、`list.count=0` |
| **Q8** 场景内 dialog / toast | **已验证（负面结论）：都不可用。**（a）`ctx.tuiDialogs.confirm` 从**场景内**和**命令内**都立即 resolve `false`，`elapsedMs=0`，终端日志里没有出现任何对话框标题/正文（`PROBE CONFIRM` 计数 0）；（b）`ctx.tuiToast.show('…')` 返回 `delivered=false`（无 sink 接收）。（c）两者都**不抛错**，只是静默取消/丢弃。**结论：场景内确认、单行输入必须自绘；不要用 toast 做操作反馈，用场景内状态条。** | 首次 run 报告 `dialogs: [confirm/scene false 0ms, confirm/command false 0ms]`、`toast.delivered=false`；TUI 日志无对话框文字 |
| **Q9** `ctx.pluginManager` 可调用性 | **已验证：可调用，但管不到 patch 插入的 MCP 行。**（a）服务存在，`listPlugins()` 返回 **0 条**（同一时刻 loader 有 120 条）；（b）`setPluginEnabled('mcp-probe', false)` 返回 `{ application: 'failed', error: { code: 'unknown-plugin' } }`，耗时 **≈33s**（内部等待后失败）。（c）**含义：FR-10 的首选路径（官方 API 启停）在本环境不成立；应把「patch 文本编辑」升级为 MCP 启停的主路径，官方 API 作为「存在且成功时优先」的探测路径。** 且 UI 必须处理「调用可能阻塞 30s+」，不能把键盘锁在该调用上。 | 首次 run `set-enabled` 事件：`elapsedMs=32947, application=failed/unknown-plugin`；`pluginInventory.pluginManagerEntries=0` |
| **Q10** `.disabled` 约定 | **部分验证（内核侧已确认，TUI picker 待补）。** 把项目技能 `.dsh/skills/probe-skill/SKILL.md` 改名为 `SKILL.md.disabled` 后，同一 DSH 内核（0.2.2-rc.1）的另一个宿主会话（web profile）的技能目录在数秒内**移除**该技能，改回即恢复 → skill-filesystem provider 的 watcher + 命名约定生效。【未验证】TUI 内 `/skills` picker、`/name` 命令与模型侧 catalogs 的同步时机（AC-10 仍需真实 TTY 手工走查）。 | 本会话 `available skills` 目录在改名后即时从 2 条变 1 条；改回后恢复 |
| **Q11** patch 写入 → HMR 生效延迟 | **已验证：端到端 ≈2.5s。** 向 probe profile 的 `cordis.patch.yml` 追加一条 MCP insert 行（写入完成 `15:57:59.091Z`），loader 条目在 `15:58:01.589Z` 出现（探测每 500ms 采样一次）→ **2.50s**，与 HMR `awaitWriteFinish` 2s + debounce 一致。UI 文案「已保存，热加载中…」→ 轮询 `ctx.loader.entries()`/`pluginManager` → 「已生效」的方案成立。 | 首次 run `mcp-change` 事件时间戳；loader 119→120 条 |

## 3. 其他实测观测（对 M1 实现有直接影响）

1. **服务就绪是异步的。** 插件 activation 时，`tuiScenes/tuiDialogs/tuiToast/tuiStatus/…` 尚不存在；约 **+1.0s** 后才出现（`capability-change` 事件）。`commands`/`configEditor`/`settings`/`skills`/`loader` 在 activation 时已可用；`pluginManager` 同样在 +1s 后才被探测到。**所有 TUI 接缝必须 `ctx.inject(['…'])` 软等待，不允许在 `apply` 里同步取。**
2. **场景注册/打开/键盘/清理都正常。** 全屏场景由 `/skill-mcp` 命令打开；场景内 `useInput` 可用；`ctx.effect` 清理在场景 unmount 时触发（`scene-unmount`）。场景 id 大小写被宿主归一化为小写。
3. **多字符输入块必须按整段处理。** 终端注入 `d` + Enter 时，`useInput` 收到的是 `input="d\r"` 而不是两次单键；真实 bracketed paste 同理。场景必须把多字符块当 paste（或先剥 `\r\n`）再匹配快捷键，**不能**写 `input.length === 1` 的假设。
4. **JSX + 宿主 jsx-runtime 方案可行。** `tsconfig` 用 `"jsx": "react-jsx"` + `"jsxImportSource": "@deepseek-harness-tui/dsh-tui"`，构建产物 `import { jsx } from '@deepseek-harness-tui/dsh-tui/jsx-runtime'`，真实 TUI 渲染无 invalid hook / 元素符号错误；hook 全部来自 props 注入的 `React`。
5. **`ctx.loader.entries()` 是 MCP 行列表的可靠兜底。** 在 `pluginManager.listPlugins()` 为空时，loader 条目仍完整（120 条，含插入的 `mcp-probe`）；可用于列表、HMR 等待与「行是否存在」判定。
6. **插件以 `link:` 安装时可正常被 Loader 加载。** 运行时依赖（如 `@deepseek-ai/schemastery`）需在本包自己的 `node_modules` 内可解析（pnpm link 不解析目标目录的依赖），因此依赖必须写进本包 `dependencies`。
7. **探针运行的交互限制（本次方法的局限）。** 部分终端会话里 `script` 转发键盘/输出不稳定（第二、三次启动时工具侧 pty 未捕获输出），所以 Q8 的「inject 子 ctx 代理」复测、Q10 的 TUI picker 逐步确认没有完成；它们列为下一次真机走查项，不改变本表结论。

## 4. 对需求文档的修正建议（已同步到需求文档）

| 需求条目 | 原假设 | 实测后应改为 |
| --- | --- | --- |
| FR-10 MCP 启停路径 | 优先 `pluginManager.setPluginEnabled`，失败回退 patch 文本 | **patch 文本编辑为主**；`pluginManager` 仅在「服务存在 + entry 在 listPlugins 中 + 返回 applied」时作为加速路径；调用要带超时（实测失败耗时 ~33s） |
| FR-9 MCP 列表数据源 | profile patch + `pluginManager.listPlugins()` | patch/loader 为主（`ctx.loader.entries()` 兜底），`pluginManager` 只作运行时状态补充 |
| FR-19 / §6.2 确认与输入 | 场景内自绘 + 可选 tuiDialogs | **必须全部自绘**（dialogs/toast 实测不可用）；场景外命令前置流程也不要用 dialog |
| §4.4 热加载矩阵 | 「约 1–2 秒」 | 实测 patch 写→loader 行可见 **≈2.0–2.5s**（含 2s `awaitWriteFinish`），UI 轮询上限 10s 仍合理 |
| AC-10 技能热加载 | 待验证 | `.disabled` 内核机制已验证；TUI `/skills` 与模型侧同步仍待真机走查 |

## 5. 下一步（M1 进入条件）

1. 用**新的交互方式**（推荐：真实终端里人工操作，或修好 node-pty 驱动）补完：Q8 的 inject 子 ctx 代理复测、Q10 的 TUI `/skills` 走查、Q8 根因定位（哪条守卫拒绝）。
2. 按需求文档 §10 开始 M1：把本仓库探针场景替换为「技能只读列表 + 详情 + 诊断」的最小管理界面；domain 层先做扫盘与 frontmatter 解析（可单测）。
3. 清理探针 profile / 探针命令（`/skill-mcp-probe-*`）时同步更新本文件与 01 §9。
