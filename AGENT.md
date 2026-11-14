# AGENT.md

本文件是本仓库的工作约定，面向后续接手开发的 agent。**先读本文件，再按「阅读顺序」进入需求与调研。**

> **文档分工**：`README.md` 面向**使用者**（是什么、怎么装、怎么用、有哪些限制）；本文件与 `docs/` 面向**开发者**（约定、需求、调研、决策、验证）。同一事实只在权威位置维护，其他文档引用而不复制：阶段与里程碑 → [`docs/需求文档.md`](docs/需求文档.md)，证据 → `docs/research/`，取舍 → `docs/decisions/`，用户向能力/限制 → `README.md`。

## 1. 项目一句话

`dsh-tui-skill-mcp-panel`：给 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 提供一个全屏可视化面板，统一管理「技能（skill）」与「MCP 服务器」，要求：

- **热加载**：启停/增删/改配置后尽量不重启 TUI；
- **区分全局与工作区**；
- **可视化开启、关闭、删除、添加**；
- **支持分组操作**。

参考实现是 web 版 [`dsh-skill-mcp-panel`](https://github.com/Fishquito7/dsh-skill-mcp-panel)（DSH web 侧边栏面板），但**渲染层、宿主接缝、安装形态完全不同**，不能整包照搬。

## 2. 当前阶段与边界

- **阶段：首版 P0 差异补齐与 M5 验收准备并行，尚不可发布（2026-11-14）**。阶段状态与里程碑以 [`docs/需求文档.md`](docs/需求文档.md) §10/§14 为唯一权威，这里不复制。
- **当前能力边界**：`/skill-mcp` 技能管理、MCP 列表/启停 + 本面板受管行新增/编辑/删除/撤销。已有 profile 行仅启停、home 层只读，这是用户确认的 D-10。证据见 [`06`](docs/research/06-m1-skill-scan-verification.md)/[`07`](docs/research/07-m2-skill-write-verification.md)/[`08`](docs/research/08-m3-mcp-verification.md)/[`09`](docs/research/09-m4-managed-crud-verification.md)；MCP 分组/搜索筛选见 [`10`](docs/research/10-m4-groups-filter-verification.md)；M5 manifest/打包检查、A–G 自查见 [`发布准备`](docs/release-readiness.md)；共享技能分组 TUI 写入保护与 web 边界见同文档 §6；布局/异常交互回归及最小可用区域见 §7；实际 tgz 安装/停用/再启用/卸载与信任提示见 §8；鼠标回归、窄屏导航与启停选中项保持见 §9；技能启停与实际 agent 目录/`/skills` 同步见 §10；完整 web/TUI 顺序共存历史失败见 §11；D-12 精确 disabled 编辑与旧覆盖迁移见 §11.1；剩余 web/TTY 根因与官方 2.3.12 对照见 §11.2；内核 stderr 候选、原宿主组合复验和暂不推荐的宿主恢复实验见 §11.3；真实安装局部变更/恢复历史提案见 §11.4；用户于 2026-11-12 决定保持现状、不实施，KI-01～KI-03 速查处理入口见 §11.5；完整人工验收与发布仍待执行；**不可发布**。
- **首版范围 D-13（2026-11-12 用户确认）**：P1 延后，先补齐 P0、修复缺陷并完成验收。主要流程可用不等于 P0 全部完成；实际差异与下一项以需求文档 §14.1 为准。技能删除/清理的三项安全补强及验证见发布准备 §12，完整删除确认与局部真机验证见 §13；跨设备复制校验、失败恢复与部分撤销保护见 §14；撤销冲突的备份/其他作用域选择及验证见 §15；启动/删除后清理、执行前诊断快照及失败保护见 §16；FR-2 页签记忆、已知本地工作区入口与 channel.cwd 根对齐见 §17；FR-3 有界预览、分页全文和完整路径见 §18；FR-18 运行版本/来源及不可读降级见 §19；FR-2 技能状态筛选、组合过滤与可见项批量边界见 §20；AC-14 布局/双模式与 §8 本机性能核对见 §21；当前等待用户选择按原设计补齐布局或明确采纳现行分档，未改断点与 FR/AC；不以文档声明代替实现。
- 已获用户授权（2026-11-08）：仓库内安装依赖、创建 GitHub 远端并 push。**仍需逐次授权**：打 tag、发布 npm、修改 `~/.dsh` 下真实配置（探针实验应使用独立 profile / 项目内夹具）。

## 3. 阅读顺序（必须）

1. 本文件；
2. [`docs/需求文档.md`](docs/需求文档.md) —— **唯一需求权威**：范围、功能需求（FR）、非功能需求（NFR）、验收标准、里程碑、未决问题；
3. [`docs/research/README.md`](docs/research/README.md) 及调研（`01`–`05`）—— 证据、限制与参考实现拆解；**`05` 是真机实测结论，优先读**；
4. 上游权威资料（版本会漂移，以本机已装版本为准，见 §4）：
   - dsh-TUI 0.19.0 已安装包（类型面、manifest、cordis patch、locale）：
     `~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui`
   - 插件准入与开发指南（唯一整合入口；npm 包内不随附 `docs/`，以本地源码仓库为准）：
     `/home/wqwt/code/dsh-TUI/tui-profile/docs/plugin-admission-and-development.md`（源码仓库为 v0.17.0 checkout，与 0.19.0 的差异见调研 `01`）
   - DSH 内核 0.2.2-rc.1：`~/.local/node/lib/node_modules/@deepseek-ai/dsh`

## 4. 版本基线（首版）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 目标宿主 | `@deepseek-harness-tui/dsh-tui` `>=0.19.0 <0.20.0` | `peerDependencies` 与 `dsh-plugin.json` 的 `compat.hosts` 同写；实测通过后再放宽 |
| DSH 内核 | `@deepseek-ai/dsh` 0.2.2-rc.1 线 | 只消费公开服务与 dsh-TUI 公开子路径 |
| Node | `^22.19 \|\| >=24`（dsh-tui 声明） | 注意 DSH CLI 自身 `engines` 为 `>=24.9.0`，**实际运行下限按 Node ≥24.9 对待** |
| 包管理 / 构建 | pnpm 11、TypeScript、`tsc` 输出 `lib/types/` | 纯 ESM，相对导入带 `.js` 后缀 |
| 许可证 | MIT | 与 dsh-TUI 主包、生态模板、参考版一致 |

版本策略：**先窄后宽**。参考先例 `dsh-tui-mcp-manager` 把范围钉死在 `>=0.16.1 <0.17.0`，在 0.19.0 直接不可用；不要写 `*`，也不要无实测就放宽。

## 5. 已确认的关键事实（违反会返工）

> 以下结论均可追溯，详细出处见 `docs/research/01`–`04`；**2026-11-08 真机探针实测见 `docs/research/05`**（Q7–Q11，含 dialog/toast 不可用、pluginManager 限制、HMR ≈2.5s、服务异步就绪）。标【未验证】的需在真机/编码阶段确认。

### 5.1 技能（skills）

- **技能真源是磁盘文件**：目录束 `<root>/<name>/SKILL.md` 或平铺 `<root>/<name>.md`（只认固定文件名，不递归）。
- **发现根与优先级**（数值小者优先）：`<projectRoot>/.dsh/skills`(100) → `<projectRoot>/.agents/skills`(200) → `customSkillDirs`(300) → `~/.dsh/skills`(400) → `~/.agents/skills`(500) → bundled(600)。
- **没有原生「停用」状态**。唯一无内核改动且热生效的停用手段是改名 `SKILL.md` ↔ `SKILL.md.disabled`（`<name>.md` ↔ `<name>.md.disabled`）；2026-11-11 已在同一真实 TUI/agent 中验证启停、目录与平铺、工作区与全局、同名回退，见发布准备 §10。
- **frontmatter 非法 = 静默丢弃该技能**（只有日志）。面板必须把「存在但不可用」明确显示出来，否则用户会以为面板漏项。
- **bundled 技能只读**（不可停用/删除）；用户根下的 `.system/` 子树被 provider 跳过。
- **dsh-TUI 在 host 层禁用了 `skill-filesystem` 与 `tool-skill`**（技能由 preset 在 agent 作用域挂载）→ host 层 `ctx.skills.snapshot()` 可能为空。**列表以「按发现规则扫盘」为主、`ctx.skills` 为辅**。
- **工作区语义 = lookup `cwd` 向上最近的含 `.git` 祖先**，与 TUI 的 workspace 记录（`ctx.tuiWorkspaces`）不是同一概念。面板显示「工作区 X 的技能」前必须用同一规则求 `projectRoot`，否则会出现「面板说有、模型看不到」。

### 5.2 MCP

- **一个 MCP server = profile `cordis.patch.yml` 里的一行 `@deepseek-ai/dsh-mcp-client` loader entry**。
- **持久化只有 profile 级，没有工作区级容器**；DSH 没有「按工作区存插件配置」的位置。工作区级 MCP 是首版唯一需要产品妥协的需求（见需求文档 §12）。
- profile patch 之外还有 **home 层 patch**（`~/.dsh/cordis.patch.yml`，跨 profile 的全局层，优先级更高）；**首版只读展示、不写入**，因为它会影响所有 profile。
- `disabled: true` = dispose fiber（断开连接 + 注销工具）；改回即重新初始化。
- patch 变更由 HMR 热重载（条目级重启，进程不重启），延迟约 1–2s（`awaitWriteFinish` 2s 窗口）。**`patchReload: "live"` 在 DSH 0.2.2-rc.1 中无任何代码引用，是无效遗留键**，不要依赖它。
- **行身份 = `serverName` + `entryId`**；同文件可存在重名。编辑必须双键定位。
- 配置编辑/删除只允许动本面板受管行，块内外来行保真（参考版 ADR-0003 真实事故）；D-12 的启停例外只允许定点修改 profile MCP 定义的普通布尔 `disabled` 并清理本插件对应旧覆盖，其他字节保留。**我们的受管块 marker 必须与 web 版不同名**。
- `!!js` 表达式必须原样往返（否则 Bearer 令牌退化成字面量）；`env`/`headers` 在 UI 与日志中脱敏，值里的 `${NAME}` 读环境变量。
- **不要注册公共 `mcpManager` 服务名**（参考版 issue #81：与宿主内置冲突）。内部服务用 `dsh-tui-skill-mcp.*` 命名空间。

### 5.3 分组

- 分组是**显示层元数据**，绝不改技能目录。
- 参考版存 `$DSH_HOME/skills/.system/skill-viewer/groups.json`（`version: 1`，成员以 `(scope, 技能名)` 二元组计）。同名技能在全局与工作区各自独立归属。
- 若与 web 版共享该文件，必须**读写兼容**；若要扩展字段，走 version 升级并向后兼容。
- **MCP 分组不写共享文件**：存本插件配置（`~/.dsh-tui/skill-mcp-panel/config.json` 的 `mcpGroups`），成员是「serverName + entryId」，按当前 profile patch 绝对路径隔离（D-11），避免扩展 web 版 schema。私有配置损坏只读回退，原文保留，不自动重建。

### 5.4 UI 与插件形态

- **首版形态已确认：全屏场景（`ctx.tuiScenes`）+ slash 命令入口**（场景 id `skill-mcp-panel`，命令名 `/skill-mcp`，需避开内置 `/skills`、`/mcp`、`/plugin`、`/panel`）。`tuiScenes` 是「稳定候选」接缝；侧栏 `ctx.tuiPanels` 是实验性接缝（compact 仅校验 descriptor、`sendToChat` 暂不可用、只在 fullscreen 分栏且宽度 ≥93 时存在），**首版不押**。
- 场景里**必须使用宿主注入的 `React` 与 `ui` kit**（single-React 规则：插件自带 React 副本会导致 hook 崩溃）。JSX 需配置 `"jsxImportSource": "@deepseek-harness-tui/dsh-tui"`。
- 终端宽度按 **terminal cell** 计算，不用 `string.length`；场景/侧栏 `noSelect`；TUI 活动期间 **stdout 保持安静**（不 `console.log`）。
- 插件包必须是一个 Cordis 插件（`name` / `Config` / `apply` 三面）并通过 bundle 安装：`dsh-plugin.json`（manifest v0.15）+ `cordis.patch.yml` + `dsh.bundle.patch`。
- 准入相关：`TUI-PKG-001/002` 声明闭包、`TUI-OBS-001/002` 清理与移除级别、`TUI-RUN-002` 安装前信任披露（`trusted-in-process`）、`permissions` 只允许 `name/scope/reason`。

### 5.5 真机实测补充（2026-11-08，违反会返工）

- **TUI 接缝是异步就绪的**：插件 activation 时 `tuiScenes/tuiDialogs/...` 尚不存在（约 +1.0s 后出现）→ 一律 `ctx.inject(['…'])`，禁止 `apply` 里同步取服务。
- **`tuiDialogs` / `tuiToast` 实测不可用**：dialog 在场景内/命令内都 0ms 静默返回取消值，toast `delivered=false` → 确认、单行输入全部场景内自绘；反馈用场景内状态条。
- **`pluginManager` 管不到 patch 插入的 MCP 行**：`listPlugins()` 为空、`setPluginEnabled` 返回 `failed/unknown-plugin` 且耗时 ≈33s → MCP 列表用 `ctx.loader.entries()` + patch 解析，启停以 patch 文本编辑为主；任何 `pluginManager` 调用都要带超时、不阻塞键盘。
- **HMR 实测 ≈2.0–2.5s**（2s `awaitWriteFinish` + debounce + 探测轮询）；UI 显示「已保存，热加载中…」并轮询。
- **注册资源归属注入作用域**：`sceneCtx.effect` / `commandCtx.effect` 随服务移除立即撤销，不能挂在父插件 `ctx.effect` 上等到整个面板停用才清理。M5 的真实 Cordis lifecycle 测试覆盖移除/恢复与重复 activation。
- **多字符输入块**：`useInput` 可能一次收到 `"d\r"` 或整段 paste → 快捷键匹配不能假设 `input.length === 1`。
- **鼠标**：场景已按 `Box onClick`/`onWheel` 实现点击与滚轮（fullscreen），且底部动作条/模态按钮与键盘操作范围一致；鼠标事件已由用户真机确认可用。
- **鼠标事件冒泡**：0.19.0 的 click 路径只检查 `stopImmediatePropagation()`；技能行点击后进入窄屏详情时必须使用它，避免外层卡片把焦点改回列表。选择框取消、窄屏详情返回均需可点击入口；SGR 事件回归为 `pnpm test:ui:mouse`。
- **裸 ESC 是 escape+meta**：宿主输入解析给 `useInput` 的裸 Esc 同时带 `escape: true` 与 `meta: true`（Ink 50ms flush）→ 快捷键守卫必须写成 `if ((key.ctrl || key.meta) && !key.escape) return`，否则模态框无法用 Esc 取消（M2 实际踩过）。
- **`r` 键按页签分派**：分组页 `r` = 重命名，技能/诊断页 `r` = 刷新；全局刷新用 `R`。
- **←/→ 统一语义**：先移动空间焦点（技能页：作用域 ⇄ 列表 ⇄ 详情）；内容区没有左右相邻区域时（分组/MCP/诊断）切换页签；页签栏上始终切换页签。
- **MCP 启停不靠 pluginManager**：`listPlugins()` 实测为空；D-12 启停精确编辑 profile MCP 定义的普通布尔 `disabled`，不再追加覆盖；旧 `dsh-tui-skill-mcp-panel:mcp-toggle` 在目标启停时清理，或 MCP 页 `m` 确认后整批迁移（不改保存的启停状态、遇歧义整批拒写），打开/刷新不自动写；写前备份、写后 YAML 校验、原子写，然后轮询 loader 最多 10s。`!!js` 值只用 custom tag 解析、不 eval、不执行；home 层/表达式控制行只读。
- **JSX 已验证可行**：`tsconfig` 的 `jsxImportSource: "@deepseek-harness-tui/dsh-tui"` + props 注入 `React`，真实 TUI 渲染无 invalid hook/元素错误。
- **`link:` 安装时依赖解析**：插件运行时依赖须写在自身 `dependencies`（pnpm link 不解析目标目录依赖）；类型依赖放 `devDependencies`。
- **扫盘与内核一致性已验证**（M1）：发现根/rank、frontmatter 名称、遮蔽、`.disabled`、非法条目与内核实测目录逐项一致（`docs/research/06`）；**但 `customSkillDirs` 在 host 层不可读**（按未配置处理），runtime 注册的技能不在扫盘内。
- **写操作不变量**（M2）：启停/删除前重读 frontmatter 校验 name；普通操作目标已存在拒绝；bundled 只读；删除进回收站（manifest；撤销冲突默认取消，只有显式确认和校验备份后才可替换，或另作用域无覆盖恢复）；添加用临时路径 + rename，限制 200 文件/8 MiB/1 MiB；分组写共享 groups.json：TUI 锁、加载快照/提交前比对、强制写前备份；损坏时精确复制备份并保留原文件，未备份不允许恢复写入。web 2.3.7 不使用分组锁，不能宣称双端同时写安全。细节与测试见 `docs/research/07`。
- **UI 可验证方式**：真实 TTY 人工走查是最终验收；布局回归用 `pnpm test:ui:layout`（8 种尺寸、缩小/恢复、长内容/只读/错误），自动化用 `pnpm test:ui`（headless Ink + host ui kit）证明组件能渲染出列表/详情/页签，避免把「环境截不到图」当成「UI 不可用」。

## 6. 架构约束（编码阶段必须遵守）

**分层**（建议目录，编码前再最终确认）：

```
src/
  index.ts            # Cordis 插件入口：name / Config / apply
  domain/             # 纯逻辑，无 React、无宿主服务：技能扫描/校验、patch 编辑、分组、MCP 配置模型
  host/               # Cordis 服务、命令注册、文件操作、HMR 等待、诊断
  ui/                 # scene 组件（Ink 系，仅通过注入的 React/ui 渲染）
  shared/             # 类型、常量、i18n 文案
```

- **domain 层可单测、不 import React**；UI 层不直接做文件操作；host 层把 domain 接到 Cordis 服务与场景。
- **不重实现 DSH 域服务**：技能注册/监听、MCP 连接与工具注册都归 DSH；本插件只做「读盘 + 写配置 + 呈现」。
- **写入安全**：原子写（临时文件 + rename）、文件锁、写前重读、失败回滚；CRUD 只改自己受管区域；D-12 允许对已有 profile MCP 精确编辑普通布尔 `disabled`，并清理本插件旧启停覆盖，其他字节保真；用户文件损坏时保留原样并报错，**绝不静默覆盖**。
- **不可信输入**：技能名/正文、MCP 配置、`!!js` 表达式；所有进入渲染路径的字符串统一消毒（C0/C1、空白折叠、按 cell 截断）；不 `eval` 用户表达式。
- **热加载是「异步生效」**：保存后 UI 显示「已保存，热加载中」并可轮询/订阅结果，不要假装瞬时。
- **崩溃隔离**：单条技能/服务器失败不能拖垮整个场景；`apply` 内不 await 长任务；错误走日志与 UI，不抛到宿主。
- **可测试性**：domain 层优先纯函数；对文件系统用临时目录；真机验收清单见需求文档。

## 7. 开发与验证命令

**当前可用**：

```sh
pnpm install
pnpm build                  # 清理生成目录 lib/types，再 tsc；避免旧源码产物进入发布包
pnpm typecheck              # 同上，不产出
pnpm test                   # build + node:test（含 MCP 写入保护的回归用例）
pnpm test:ui                # headless Ink 渲染 smoke（160/58 列）
pnpm test:ui:mouse          # 真实 host 命中检测：SGR 点击/释放/滚轮，40/58/116 列，含启停后选中项保持
pnpm audit:performance /tmp/skill-performance.json # 1000 技能/逐键计时；项目文件系统隔离夹具，非物理 SSD 认证
pnpm test:skills:filters     # 120/58 列：真实 runtime 状态/搜索/作用域/分组组合与可见项批量边界
pnpm test:ui:interaction    # headless 交互：技能操作/分组 + 旧快照拒写/刷新/多 runtime/备份，
                            # 驱动 空格/v/d+u/a/g/Tab，断言文件与 groups.json 变化
pnpm test:mcp               # headless MCP smoke：patch/loader 合成、精确字段启停、HMR 轮询、home 只读
pnpm check:manifest         # 固定官方 parser/core 摘要 + profile 校验 + 示例 descriptor 协商
pnpm check:tarball          # clean build + npm dry-run/实际临时打包/解包/入口导入
pnpm test:release           # 声明、打包拒绝边界、真实 Cordis 服务移除/恢复/停用
pnpm check:release          # 类型 + 域层/发布测试 + 打包 + 全部 UI/runtime smoke
pnpm test:mcp:groups        # 120/58 列 UI/runtime：分组、组合筛选、profile 隔离、冷启动与生命周期
pnpm test:mcp:crud          # 120/58 列真实 UI/runtime：stdio+HTTP 表单、脱敏、CRUD、冷启动撤销
node scripts/skill-groups-interop.mjs ~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel
                            # 只在临时 DSH home 调用实际 web 2.3.7 分组 API；验证互读与锁外边界
node scripts/prepare-tui-probe.mjs ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
                            # 准备 /tmp 下独立 home/profile/技能/本地 MCP，输出 run.sh；不启动进程
```

基础真机探针可在宿主目录后加 `--mode=inline` 或 `--mode=fullscreen`（默认）；会在新建的临时 home 预设显示偏好和已完成的 fullscreen factory migration，避免首次迁移清除 inline 选择。实际模式仍需核对宿主日志，步骤见[发布准备 §21](docs/release-readiness.md#21-布局模式与性能核对2026-11-14)。

完整 web/TUI 同一宿主探针用 `node scripts/prepare-web-interop-probe.mjs <CLI 已安装宿主目录> <已安装 web 面板目录>`；复验步骤、认证链接保护与 AC-15 失败证据见 [发布准备 §11](docs/release-readiness.md#11-webtui-完整-ui-顺序共存)。只准备临时目录，仍需真实 UI 操作。

实际 tgz 安装/生命周期探针用 `node scripts/prepare-install-probe.mjs <CLI 已安装宿主目录>`，数据与 observer 都在 `/tmp`；`install-probe-state.mjs` 检查真实注册与文件哈希。前提、步骤和证据见 [发布准备 §8](docs/release-readiness.md#8-实际-tgz-安装停用与卸载)，不纳入通用 `check:release`。

**推荐真机验证**：先 `pnpm build`，执行上面的 `prepare-tui-probe.mjs`，然后在真实终端运行输出的 `run.sh`。`/skill-mcp` → `2` → 选 `mcp-probe` → 空格启停；预期「热加载中」→「已生效」，退出场景后 `/mcp` 可核对 `ping` 工具出现/消失。夹具初始停用，`mcp-home` / `mcp-expr` 只读。不需要 npm 下载或模型请求。

M4 真机步骤见 [`research/09`](docs/research/09-m4-managed-crud-verification.md)：MCP 页 `a` 填入本地夹具的 Node 命令/JSON args，保存后 `/mcp` 核对 `ping`；`Enter` 修改参数，`d/y` 删除，重新打开面板后 `u` 恢复。夹具位置 `test/fixtures/mcp-stdio-server.mjs`。MCP 分组验收见 [`research/10`](docs/research/10-m4-groups-filter-verification.md)：`g` 建组、`f` 筛选、`/` 搜索、分组页 `t` 切换 MCP。

宿主 0.19 的首选项直接使用 `os.homedir()`，不认 `DSH_TUI_HOME`；脚本用仅测试进程的 Node preload 将该路径指向临时目录，**不修改 HOME 或真实首选项**。开发依赖中的宿主可能缺少启动所需的内核 peer，真机脚本应传入 CLI 已安装的宿主目录。证据与剩余人工项见 `docs/research/08`/`09`。

技能同步探针：`node scripts/prepare-skill-sync-probe.mjs <CLI 已安装宿主目录>`；启动输出的 `run.sh` 后，用 `record-skill-sync.mjs <root> <phase>` 核对实际 agent、面板与命令集合。步骤和观测边界见 [发布准备 §10](docs/release-readiness.md#10-技能启停与实际-agent-目录同步)。它只观察目录源，不派发模型回合；不要把 host 层空目录当作 agent 无技能。

**历史真机安装流程**——复制独立探针 profile；此流程会写 `~/.dsh`，仍需遵循 §2 的逐次授权：

```sh
pnpm build
cp -a ~/.dsh/profiles/dsh-tui ~/.dsh/profiles/dsh-tui-probe
# 编辑 ~/.dsh/profiles/dsh-tui-probe/package.json：name 改为 dsh-profile-dsh-tui-probe，
# dsh.profile.bundles 裁为 @deepseek-ai/dsh-base + @deepseek-harness-tui/dsh-tui
dsh plugin --profile dsh-tui-probe add /home/wqwt/code/dsh-tui-skill-mcp-panel
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID TERM=xterm-256color \
  SKILL_MCP_PANEL_DUMP=/tmp/skill-mcp-panel/dump.json \
  dsh --profile dsh-tui-probe        # TUI 内输入 /skill-mcp
```

`SKILL_MCP_PANEL_DUMP` 是验证用开关：设置后插件每次扫描写 JSON（扫描结果 + 宿主能力），未设置时不写任何临时文件。

发布基线、A–G 自查与用户发布前完整测试表见 [`docs/release-readiness.md`](docs/release-readiness.md)。`check:manifest` 的 compatible 仅为上游示例 descriptor 协商，不是 live host 或 Verified claim；实际包导入复用当前 checkout 依赖，不代表全新 registry 安装。构建会清理生成目录，先退出真实 TUI 验证进程再构建。

> **不要声称跑过不存在的命令/测试**。真机行为验证必须在真实 TTY 打开 TUI 场景操作，构建成功/截图不能替代交互验证；探针运行限制见 [`docs/research/05`](docs/research/05-m0-real-machine-probe.md) §3.7。

## 8. 发布约定

- **远端仓库**：`https://github.com/wuqiuwangtian/dsh-tui-skill-mcp-panel`（2026-11-08 由用户授权创建，当前为公开仓库；本地 `main` 跟踪 `origin/main`）。

- **主渠道**：npm；**备用**：GitHub Release tarball（`dsh plugin add <tarball-url>` 支持性需真机实测，TUI 文档只列了 package/path/git）。
- **MIT**；`v*` tag 必须严格等于 `package.json.version`；有 provenance 就附上（trusted publishing 优先）。
- 发布前必须：`check:manifest`、tarball 断言、准入清单逐条自查、真实 TTY 走查受影响流程。
- 生态收录：向 `dsh-tui-ecosystem/dsh-tui-ecosystem` 的 `plugins.json` 提 PR（要求仓库公开、README 回链 dsh-TUI、作者本人 PR）。
- **未经用户明确授权，不 push、不打 tag、不 publish。**

## 9. 文档规则

- 需求只维护一份权威：[`docs/需求文档.md`](docs/需求文档.md)。其他文档引用它，不复制结论。
- 调研结论被推翻时，更新对应 `docs/research/0X-*.md`，保留证据出处并注明日期；不要删除「为什么」。
- 每条外部事实/推断标注【已验证事实】【推断】【未验证】，避免把推断当结论。
- 重要取舍写 `docs/decisions/NNNN-<slug>.md`（ADR 风格：背景/选项/决定/后果），在需求文档与 AGENT.md 中引用。

## 10. 多 agent 协作约定

- 同一时间同一文件只有一个 writer；任务开始前在共享任务上声明 write scope。
- Lead 负责需求澄清、任务依赖、最终整合与验证；teammate 完成后报告：文件路径 + ≤10 行摘要 + 阻塞/未决项。
- 不越过自己的 write scope；发现他人文档有误，**报告 Lead**，不擅自改。
- **M0 已完成；M1 起写代码**，按需求文档里程碑推进（当前进入编码阶段已获用户明确指令）。

## 11. 仓库结构（当前）

```text
dsh-tui-skill-mcp-panel/
├─ README.md               # 面向使用者：能力 / 安装 / 使用 / 限制 / 权限 / 许可
├─ AGENT.md                # 本文件：面向开发者
├─ package.json            # ESM 包；dsh.bundle.patch → cordis.patch.yml
├─ tsconfig.json           # jsxImportSource 指向 @deepseek-harness-tui/dsh-tui
├─ cordis.patch.yml        # 把插件作为一行 insert 挂进 profile
├─ LICENSE                 # MIT
├─ src/
│  ├─ index.ts             # Cordis 插件三面：name / Config / apply
│  ├─ domain/              # 纯逻辑，可单测、不 import React：
│  │  ├─ skills/          # 发现根/rank/frontmatter/扫盘/遮蔽 + 写操作（启停/删除/撤销/添加）
│  │  ├─ mcp/patch.ts     # MCP patch 解析（!!js）、受管块启停、层级/脱敏、原子写/备份
│  │  ├─ mcp/write.ts     # web 兼容锁、profile/home 快照冲突检测、强制备份与写入事务
│  │  ├─ mcp/managed.ts   # 本面板 MCP 插入块增删改；其他字节保留
│  │  ├─ mcp/model.ts     # 表单校验、环境引用、敏感值处理
│  │  ├─ mcp/crud.ts      # 受管 CRUD 事务与持久删除撤销清单
│  │  ├─ groups.ts        # 共享 groups.json v1：加载快照、TUI 锁/冲突/备份、定点合并与成员
│  │  └─ store.ts         # 插件私有路径（trash/backups/config）与配置
│  ├─ host/                # 场景与命令注册、ManagerRuntime（扫描状态/详情/诊断/dump）
│  ├─ shared/              # 宿主接缝结构化类型、cell 宽度/消毒等格式工具
│  └─ ui/                  # ManagerScene：技能列表-详情、搜索、帮助、诊断页
├─ lib/                    # tsc 产物（git 忽略，npm files 携带）
├─ scripts/                # ui-render-smoke.mjs：host ui kit 的 headless 渲染 smoke
├─ test/domain/            # node:test 单测（frontmatter + 扫盘）
├─ .dsh/skills/            # 真机验证用的项目级技能夹具（git 忽略）
└─ docs/
   ├─ 需求文档.md          # 需求唯一权威（含 FR/NFR/AC/里程碑/未决问题/现状）
   ├─ research/            # 01–10 调研 + 真机实测；README 为索引
   ├─ release-readiness.md # M5 准入自查、固定校验基线与发布前人工测试表
   ├─ decisions/           # ADR（0001 MCP 启停路径）
   └─ research/evidence/   # 探针原始 JSON 报告
```

`src/domain/` 负责纯逻辑；`dsh-plugin.json` 已在 M5 补齐，发布校验脚本位于 `scripts/release/`。
