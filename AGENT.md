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

- **阶段：M2 P0 已落地（2026-11-08）**。阶段状态与里程碑以 [`docs/需求文档.md`](docs/需求文档.md) §10/§14 为唯一权威，这里不复制。
- **当前能力边界**：`/skill-mcp` 技能列表/详情 + 启停 + 软删除/撤销 + 添加导入 + 分组 + 批量；MCP/组内批量为后续里程碑。扫盘与内核一致已真机验证（[`docs/research/06`](docs/research/06-m1-skill-scan-verification.md)），写操作与分组的域层证据见 [`docs/research/07`](docs/research/07-m2-skill-write-verification.md)；真实 TUI 写操作走查待补；**不可发布**。
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
- **没有原生「停用」状态**。唯一无内核改动且热生效的停用手段是改名 `SKILL.md` ↔ `SKILL.md.disabled`（`<name>.md` ↔ `<name>.md.disabled`），**需真机验证**。
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
- 受管块只允许动**自己插入的行**；块内外来行必须逐字节保留（参考版 ADR-0003 真实事故）。**我们的受管块 marker 必须与 web 版不同名**。
- `!!js` 表达式必须原样往返（否则 Bearer 令牌退化成字面量）；`env`/`headers` 在 UI 与日志中脱敏，值里的 `${NAME}` 读环境变量。
- **不要注册公共 `mcpManager` 服务名**（参考版 issue #81：与宿主内置冲突）。内部服务用 `dsh-tui-skill-mcp.*` 命名空间。

### 5.3 分组

- 分组是**显示层元数据**，绝不改技能目录。
- 参考版存 `$DSH_HOME/skills/.system/skill-viewer/groups.json`（`version: 1`，成员以 `(scope, 技能名)` 二元组计）。同名技能在全局与工作区各自独立归属。
- 若与 web 版共享该文件，必须**读写兼容**；若要扩展字段，走 version 升级并向后兼容。
- **MCP 分组不写共享文件**：存本插件配置（`~/.dsh-tui/skill-mcp-panel/config.json` 的 `mcpGroups`），成员是「serverName + entryId」，避免扩展 web 版 schema。

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
- **多字符输入块**：`useInput` 可能一次收到 `"d\r"` 或整段 paste → 快捷键匹配不能假设 `input.length === 1`。
- **鼠标**：场景已按 `Box onClick`/`onWheel` 实现点击与滚轮（fullscreen），键盘始终完整可用；插件场景是否真的收到鼠标事件**仍需真机确认**（宿主路由未验证）。
- **JSX 已验证可行**：`tsconfig` 的 `jsxImportSource: "@deepseek-harness-tui/dsh-tui"` + props 注入 `React`，真实 TUI 渲染无 invalid hook/元素错误。
- **`link:` 安装时依赖解析**：插件运行时依赖须写在自身 `dependencies`（pnpm link 不解析目标目录依赖）；类型依赖放 `devDependencies`。
- **扫盘与内核一致性已验证**（M1）：发现根/rank、frontmatter 名称、遮蔽、`.disabled`、非法条目与内核实测目录逐项一致（`docs/research/06`）；**但 `customSkillDirs` 在 host 层不可读**（按未配置处理），runtime 注册的技能不在扫盘内。
- **写操作不变量**（M2）：启停/删除前重读 frontmatter 校验 name；目标已存在拒绝；bundled 只读；删除进回收站（manifest + 撤销冲突不覆盖）；添加用临时路径 + rename，限制 200 文件/8 MiB/1 MiB；分组写共享 groups.json（损坏备份回退）。细节与测试见 `docs/research/07`。
- **UI 可验证方式**：真实 TTY 人工走查是最终验收；自动化用 `pnpm test:ui`（headless Ink + host ui kit）证明组件能渲染出列表/详情/页签，避免把「环境截不到图」当成「UI 不可用」。

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
- **写入安全**：原子写（临时文件 + rename）、文件锁、写前重读、失败回滚；只改自己受管区域；用户文件损坏时保留原样并报错，**绝不静默覆盖**。
- **不可信输入**：技能名/正文、MCP 配置、`!!js` 表达式；所有进入渲染路径的字符串统一消毒（C0/C1、空白折叠、按 cell 截断）；不 `eval` 用户表达式。
- **热加载是「异步生效」**：保存后 UI 显示「已保存，热加载中」并可轮询/订阅结果，不要假装瞬时。
- **崩溃隔离**：单条技能/服务器失败不能拖垮整个场景；`apply` 内不 await 长任务；错误走日志与 UI，不抛到宿主。
- **可测试性**：domain 层优先纯函数；对文件系统用临时目录；真机验收清单见需求文档。

## 7. 开发与验证命令

**当前可用**：

```sh
pnpm install
pnpm build                  # tsc → lib/types/
pnpm typecheck              # 同上，不产出
pnpm test                   # build + node:test（domain 层，22 个用例）
pnpm test:ui                # headless Ink 渲染 smoke（160/58 列）
pnpm test:ui:interaction    # headless 交互 smoke：真实 ManagerRuntime + 临时技能树，
                            # 驱动 空格/v/d+u/a/g/Tab，断言文件与 groups.json 变化
```

**真机安装（已验证流程）**——用独立探针 profile，避免影响日常 `dsh-tui` profile：

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

**计划中（M2/M5 落地）**：`pnpm check:manifest`（离线校验 `dsh-plugin.json`，M5）、`pnpm check:tarball`（`npm pack --dry-run` 断言 manifest/entry 在包内，M5）。

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
│  │  ├─ groups.ts        # 共享 groups.json v1（损坏回退、原子写、成员）
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
   ├─ research/            # 01–07 调研 + 真机实测；README 为索引
   ├─ decisions/           # ADR（0001 MCP 启停路径）
   └─ research/evidence/   # 探针原始 JSON 报告
```

`src/domain/`（纯逻辑、可单测）在 M1 新增；`dsh-plugin.json` 在 M5 补。
