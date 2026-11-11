# 06 · M1 技能扫描真机验证（2026-11-08）

> 目的：验证 M1 的 domain 扫盘实现与 **DSH 0.2.2-rc.1 内核发现结果一致**（需求文档 §10 M1 退出条件「列表与内核发现一致」、§9.1 AC-1），并记录尚未完成的 UI 视觉验收。
> 关联：[`05-m0-real-machine-probe.md`](05-m0-real-machine-probe.md)（宿主接缝实测）、[`../需求文档.md`](../需求文档.md) §4.2。

## 1. 方法

1. **域层单测**：`pnpm test`（9 个用例）用临时目录构造目录束 / 平铺 `.md` / `.disabled` / 非法 frontmatter / 同层重名遮蔽 / `.system` / 缺失根，断言发现根、状态、名称来源（frontmatter）、rank 排序与遮蔽关系。
2. **真机对比**：在项目根（`~/.dsh/profiles/dsh-tui-probe` 独立 profile）放置一组磁盘夹具，同时采集：
   - 插件自身扫盘结果（`ManagerRuntime` 在 `SKILL_MCP_PANEL_DUMP=<path>` 时写 JSON dump）；
   - **内核实际发现结果**：同一 DSH 内核宿主（web profile 会话）的实时技能目录（`available skills` 列表），它由同一个 `dsh-skill-filesystem` provider 提供。
3. 夹具（项目工作区，git 忽略）：

```text
.dsh/skills/alpha/SKILL.md                 目录束，name=alpha
.dsh/skills/beta.md                        平铺，name=beta
.dsh/skills/from-frontmatter.md            文件名 from-frontmatter，frontmatter name=flat-inner-name
.dsh/skills/mismatch-dir/SKILL.md          目录名 mismatch-dir，frontmatter name=mismatch-name
.dsh/skills/gamma/SKILL.md.disabled        停用（目录束）
.dsh/skills/delta.md.disabled              停用（平铺）
.dsh/skills/broken/SKILL.md                非法（缺 description）
.dsh/skills/.system/hidden/SKILL.md        应不被发现（一层扫描）
.agents/skills/alpha/SKILL.md              name=alpha，rank 200 被 rank 100 遮蔽
```

## 2. 结果

**插件 dump（真机）**（完整 JSON 见运行输出；字段见 `src/host/manager-runtime.ts`）：

| name | source | status | effective | 说明 |
| --- | --- | --- | --- | --- |
| alpha | project-dsh | enabled | ✅ | 目录束，rank 100 胜出 |
| beta | project-dsh | enabled | ✅ | 平铺 |
| flat-inner-name | project-dsh | enabled | ✅ | 名称取自 frontmatter |
| mismatch-name | project-dsh | enabled | ✅ | 名称取自 frontmatter；有「目录名不一致」警告 |
| probe-skill | project-dsh | enabled | ✅ | M0 遗留夹具 |
| software-delivery-workflow | user-dsh | enabled | ✅ | 真实全局技能 |
| alpha | project-agents | enabled | ❌ 被遮蔽 | shadowedBy=project-dsh 的 alpha |
| gamma | project-dsh | disabled | — | `SKILL.md.disabled` |
| delta | project-dsh | disabled | — | `.md.disabled` |
| broken | project-dsh | invalid | — | 原因：`frontmatter requires name and description` |

**内核实际目录（同一时刻）**：`alpha, beta, flat-inner-name, mismatch-name, probe-skill, software-delivery-workflow`。

→ **结论：内核可见集合 = 插件 `status=enabled && effective=true` 集合，逐项一致**；被遮蔽、停用、非法、`.system` 四类都没有出现在内核目录中，插件也分别标为 shadowed/disabled/invalid/未发现。这验证了：

- 发现根与 rank：project `.dsh/skills`(100) 遮蔽 `.agents/skills`(200)；
- 名称来源：目录束与平铺都取 frontmatter `name`；
- `.disabled` 约定与非法 frontmatter 的「存在但不可用」展示；
- 一层扫描 + `.system` 跳过（项目根下 `.system/hidden/SKILL.md` 不被发现）。

**单测**：`pnpm test` → 9 pass / 0 fail（frontmatter 6 + 扫盘 3）。

### 2.1 UI 渲染证据（组件 + 真机进程）

- **headless Ink 渲染**：`pnpm test:ui`（`scripts/ui-render-smoke.mjs`）用宿主自己的 `@deepseek-harness-tui/dsh-tui` ui kit + React 19 `renderSync` 挂载编译后的 `ManagerScene`（stub runtime + 真实扫描结果），断言 160 列与 58 列两种宽度都渲染出：标题、页签（窄屏为紧凑标签）、作用域/统计、技能列表行（含 `alpha/beta/software-delivery-workflow` 等）、详情/正文、键位提示。**结果：OK（wide=685 chars, narrow=415 chars）**；期间发现并修复了窄屏（<64 列）页签溢出换行的问题（窄屏改用「技能/MCP/分组/诊断」紧凑标签）。
- **真机进程**：独立探针 profile 真实启动（`SKILL_MCP_PANEL_DUMP`），插件 activation 后 dump 显示：`sceneError: null`（场景注册 + `/skill-mcp` 命令注册均未报错）、13 个 TUI 接缝服务全部可用、扫描结果与上表一致。说明插件在真实 TUI 进程里完成了注册与扫描；**尚未采集到该进程的逐屏画面**（见 §3.1）。

## 3. 已知缺口（未验证，不要写成已验收）

1. **人工 TTY 走查未完成（唯一缺口）**：本环境终端工具对长驻 TUI 的屏幕捕获不稳定，拿不到 `/skill-mcp` 的逐屏画面；因此**视觉与键位的人工走查**（列表/详情/诊断切换、滚动、搜索、宽窄屏观感、MCP/分组占位页）仍需真实终端手工执行（对应 AC-9 UI 部分、AC-14 的观感项）。可自动化的部分已补：headless 渲染 smoke 证明组件能在宿主 React/ui kit 下渲染出预期内容（§2.1）；M0 已证明场景注册/打开路径真实可用（`docs/research/05` §3）。

6. **鼠标支持（已真机确认可用）**：M1 已实现 `Box onClick`（页签/作用域/技能行）与 `onWheel`（列表/详情/诊断滚动），并保留完整键盘路径。用户在真实 TUI 中确认「这轮鼠标操作支持的不错」→ **插件场景确实收到鼠标事件**（补上 M0 Q8 的鼠标部分）；键盘始终完整可用。
7. **UI 迭代（按用户反馈）**：第一版布局出现作用域计数换行、焦点不可见、键位复杂等问题；已改为原生风格圆角卡片（accent 聚焦边框/`selectionBg` 选中行/`❯` 指针）、空间化焦点模型（↑↓ 本区域选择，←→ 跨区域移动，页签栏与列表可互相上下切换），并用 headless xterm 屏幕还原验证 160/58 列排版。
2. **bundled 根**：本次启动环境未设置 `DSH_BUNDLED_SKILL_DIR`，`bundled` 根不存在；TUI 正常启动时由启动器提供该变量，需在真实 TUI 里再核对一次「随包技能」行。
3. **customSkillDirs**：host 插件读不到 provider 配置，当前按未配置处理 → 自定义技能根会被漏掉（诊断页已注明）。若必须支持，需要从 profile patch/设置读取 provider 配置（后续里程碑）。
4. **运行期注册技能**：扫盘只覆盖文件来源；`ctx.skills.register` 的 runtime/agent-scope 技能不在列表中（M0 已确认 host 层 `ctx.skills` 为空，无法互补）。
5. **AC-10（TUI `/skills` 与模型侧热更新）**：M0 已确认 `.disabled` 内核机制；**2026-11-11 补充**：同一真实 TUI/agent 下的目录、菜单、slash 注册、正文来源与调用策略已做 10 阶段验证，见 [发布准备 §10](../release-readiness.md#10-技能启停与实际-agent-目录同步)。实际模型请求中的 catalog 更新与模型行为仍待完整人工验收。

## 4. 复现

```sh
pnpm test
# 真机（建议先备份/使用独立 profile，见 AGENT.md §7）：
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID TERM=xterm-256color \
  SKILL_MCP_PANEL_DUMP=/tmp/skill-mcp-panel/dump.json \
  dsh --profile dsh-tui-probe        # 插件 activation 后即写 dump
```

`SKILL_MCP_PANEL_DUMP` 只用于验证/调试；未设置时插件不写任何临时文件。
