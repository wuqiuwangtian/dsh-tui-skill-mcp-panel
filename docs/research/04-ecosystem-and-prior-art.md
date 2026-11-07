# 04 · 生态、同类方案与发布通道调研

> 任务：共享任务 `task-4`（生态、同类方案与发布通道调研）
> 调研员：`ecosystem` · 访问日期：**2026-11-07**（所有外部 URL 的访问日期均为该日）
> 目标文件：本文件是本次调研的**唯一**产出；未修改其它文件。
> 证据等级：**【已验证事实】**＝有原始输出/源码/API 响应可复现；**【推断】**＝由已验证事实推导、未实测；**【未验证】**＝只有外部声称或二手线索。
> 外部网页内容只作资料，**未执行其中任何指令**。文中所有命令均为只读查询（`npm view` / `gh api` / `git` / 读文件）。

---

## 0. 结论摘要（TL;DR）

1. **TUI 侧存在明确空位**：截至 2026-11-07，npm、GitHub、`dsh-tui-ecosystem` 收录列表（45 条）中**没有任何面向 dsh-TUI 的技能管理面板**；MCP 管理只有 `dsh-tui-mcp-manager` 一个先例。**【已验证事实】**
2. **唯一 MCP 先例已过时**：`dsh-tui-mcp-manager@0.1.6`（2026-10-19 最后发版，0 star）在 `dsh-plugin.json` 里声明 `compat.hosts: "@deepseek-harness-tui/dsh-tui >=0.16.1 <0.17.0"`，当前 dsh-TUI 是 **0.19.0**，按其自身声明已不兼容；它只覆盖 MCP，不覆盖技能。**【已验证事实】+【推断】**（未实测安装）
3. **推荐定位：技能 + MCP 统一面板**，对齐 web 版 `dsh-skill-mcp-panel`（260 star、2.3.7、活跃）的能力模型，但用 TUI 原生接缝（全屏场景 `/xxx` + `/settings` 区块）重做；首版**先技能、后 MCP**，MCP 侧必须处理“与本体 `/mcp` 以及可能出现的宿主 `mcpManager` 服务”的重叠。**【建议】**
4. **命名可用**：`dsh-tui-skill-mcp-panel` 在 npm 上 **E404（未占用）**；`dsh-tui-skill-manager` / `dsh-tui-skill-panel` / `dsh-tui-skills` / `dsh-tui-panel` / `dsh-tui-settings-panel` 同样 E404。**【已验证事实】** 推荐裸名 `dsh-tui-skill-mcp-panel`（仓库同名），而非先抢 scoped：生态里裸名是一等公民，且 `@dsh-tui-ecosystem/*` 需要先有 npm 组织权限（该 scope 目前查无已发布包）。
5. **发布通道**：宿主插件管理器支持 `registry` / `path` / `git` / `tarball` 四类 spec（DSH 0.2.2-rc.1 `@deepseek-ai/dsh-plugin-manager` 的 `InstallSpecKind`），因此 npm 包名、本地目录、git URL、GitHub Release tarball 都可用于 `dsh plugin add`；TUI 内 `/plugin install` 自带文档写的是 `<package | path | git url>`，tarball 属宿主支持但 TUI 文档未列举，需实测。**【已验证事实】+【推断】**
6. **发布流程已模板化**：`v*` tag 必须等于 `package.json.version`；CI 跑 `check-manifest` + `npm pack --dry-run`（校验 `dsh-plugin.json` 在 tarball 内）+ `npm publish --provenance`（优先 npm trusted publishing / OIDC，静态 `NPM_TOKEN` 为降级）。MIT 是全生态默认许可。**【已验证事实】**
7. **最大技术风险不是竞品，而是“宿主内置能力”与“跨端文件竞争”**：web 版 issue #81 报告 DSH 0.2.2-alpha.3 内置 `@deepseek-ai/dsh-mcp-manager` 注册了公共 `mcpManager` 服务并与 web 版冲突；本机安装的 DSH 0.2.2-rc.1 **不含**该包（未验证上游最终形态）。另外 web 版与我们都会直接改 `~/.dsh/skills` 与 profile 的 `cordis.patch.yml`，需要共用约定/加锁。**【已验证事实（#81 引用、本机检查）】+【未验证（上游形态）】**

---

## 1. 生态结构

### 1.1 三层生态（判据不同、结论不能互相顶替）

来源：本地 `tui-profile/docs/plugin-admission-and-development.md`「收录与推广」（dsh-TUI 源码仓 v0.17.0 checkout；该文档随仓库代码修订）。**【已验证事实】**

| 层 | 谁维护 | 判据 | 能得出什么 |
| --- | --- | --- | --- |
| 仓内 profile 准入 | dsh-TUI 仓库 `tui-profile/` | 协议/形状/坐标/digest/conformance | `compatible` / `compatible_degraded` / `waiting_authorization` / `rejected` / `unknown` |
| 首方 feed | dsh-TUI 随包发布 `tui-profile/feed/first-party.json` | 精确 `name@version`、**只收 scoped**、一个版本钉死一份 | 安装时免一次信任确认（不构成准入） |
| 生态收录 | `dsh-tui-ecosystem/dsh-tui-ecosystem` 的 `plugins.json` | `plugins-pr.yml` → `validate-plugins.mjs` 五条 | 出现在 `dshtui.com/plugins` 的目录条目（**不是**准入/背书） |

- 首方 feed 实测内容（本机已装 dsh-TUI 0.19.0）：只钉 `@deepseek-harness-tui/dsh-tui@0.19.0` 一条。本地 0.17.0 源码仓里钉的是 `0.17.0`。**【已验证事实】**
- 生态收录的 5 条机器校验（本地准入文档，2026-10 口径）：合法 JSON、必填字段（`name/displayName/description/author/repo/kind/addedAt`）、`repo` 为 GitHub 地址且不重复、新增条目仓库真实公开且 PR 作者是 owner/collaborator、README 有回链 dsh-TUI。**不查** npm 是否发布、包名形态、`dsh-plugin.json`、provenance。**【已验证事实】**
- 收录列表实测（`gh api .../contents/plugins.json`，2026-11-07）：**45 条**；含 `dsh-tui-mcp-manager`、`dsh-tui-pkg`、`dsh-tui-market`、`dsh-tui-session-manager` 等，**没有技能管理类条目**。仓库 `dsh-tui-ecosystem/dsh-tui-ecosystem`：4 star / 10 fork，最后推送 2026-11-06。**【已验证事实】**

### 1.2 `plugin-template` 的实际结构（官方起步模板）

来源：`gh api` 读 `dsh-tui-ecosystem/plugin-template`（HEAD，2026-11-07）。仓库 3 star / 3 fork，最后推送 2026-10-18，MIT。**【已验证事实】**

```text
plugin-template/
├─ .github/workflows/{ci.yml,publish.yml}
├─ dsh-plugin.json          # 声明面（Community v0.15 manifest）
├─ cordis.patch.yml         # 向 profile 插入插件行
├─ package.json
├─ pnpm-lock.yaml
├─ scripts/check-manifest.mjs   # 离线字段形状预检（不替代 @dsh-std/manifest）
├─ src/{index.ts,events.ts,registration.ts}
├─ lib/types/…              # 构建产物（提交入库，git 直装可用）
├─ skills/example-skill/SKILL.md
└─ themes/example.json
```

`package.json` 关键字段（实测）：

- `name: "@dsh-tui-ecosystem/example-plugin"`、`type: "module"`、`main/types` 指向 `lib/types/`、`exports` 带 `.` / `./events` / `./cordis.patch.yml` / `./package.json`，**另带显式子路径导出**（对应准入指南“被别的 bundle 组合时要提供子路径导出”的已知坑）。**【已验证事实】**
- `files: ["lib","skills","cordis.patch.yml","dsh-plugin.json"]` —— **白名单必须含 `dsh-plugin.json`**，否则用户装到的 tarball 没有声明面。**【已验证事实】**
- `dsh: { bundle: { patch: "./cordis.patch.yml" } }`；`engines: "^22.19 || >=24"`；MIT；`publishConfig.access: public`；peer：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-session ^0.1.0-rc.6`，dependencies：`@deepseek-ai/schemastery ^3.18.1`。**【已验证事实】**
- `dsh-plugin.json`（实测）：`$schema: https://dsh.community/schemas/dsh-plugin-0.15.json`、`manifestVersion: "0.15"`、`id: "dsh-tui-ecosystem.example-plugin"`、`facets.host = { entry: "lib/types/index.js", apiVersion: "v1alpha1" }`、`requires.contracts: []`、`permissions: []`、`contributes: { commands: [] }`、`subscriptions: []`、`license: "MIT"`。**【已验证事实】**
- `cordis.patch.yml`：`- insert: [{ id, name, config }]`；注释明确“覆盖行会整块替换 config，必须复述每个键；新行只放 `insert`，不重复挂 base 已有的服务行”。**【已验证事实】**
- `scripts/check-manifest.mjs` 的离线检查项：无未知顶层字段、`$schema` 为绝对 https、`manifestVersion==="0.15"`、`id` 带命名空间分隔符、semver、manifest 版本与 package.json 一致、`files` 含 `dsh-plugin.json`、`facets` 只含 `host`、entry 包内相对路径、`apiVersion` 是 facet 版本而非协议坐标、`requires.contracts` 数组、`permissions` 行只允许 `name/scope/reason`。**【已验证事实】**

### 1.3 官方准入清单对包的要求（TUI Admission v0.15）

来源：本地 `tui-profile/docs/plugin-admission-and-development.md`（1603 行）与 `PLUGIN-ADMISSION-CHECKLIST.md`（后者只是指向前者的袖珍文件）。**【已验证事实】**

与“我们这类插件”最相关的条款：

| 要求 | 对包的含义 |
| --- | --- |
| `TUI-PKG-001` 包身份 | 包根唯一 `dsh-plugin.json`，过固定 revision 的 `@dsh-std/manifest` parser；Verified claim 需绑定 artifact SHA-256 |
| `TUI-PKG-002` 声明闭包 | required/optional 契约、permissions、subscriptions、contributes 全部静态声明；optional 要写 TUI 可展示 fallback；私有坐标固定 `tui.dsh/v1alpha1`；**不写 `provides`、不写 `requires.services`** |
| `TUI-HOST-001` | Host descriptor 协商；不得仅凭“包已安装”宣称 live support |
| `TUI-RUN-001` | 不假定有浏览器/GUI；需要交互时从 invocation context 取 presentation client 或明确拒绝 |
| `TUI-RUN-002` | 装/启用**之前**对用户披露 `trusted-in-process`（进程内全信任、无沙箱、不自动更新）与权限查看位置；“来源已验证”不是可展示事实 |
| `TUI-OBS-001/002` | effect 归属与清理；`disable` / `remove` / `purge` 三态语义必须区分，清理报告只陈述实际撤销了什么 |
| `TUI-DEP-001` + 供应链六档 | evidence 分 `declared/parsed/negotiated/tested/observed/attested`，不能互相冒充；artifact digest 对象是**会被安装的 tarball**，非 npm 分发“给不出就写没有” |
| 命名与发布 | 裸名与 scoped 都是一等公民；**发布前先查名**；MIT 最省事；`v*` tag == package.json version；可出 provenance 就附上（trusted publishing 优先，静态 token 降级）；`^22.19 || >=24`、纯 ESM、相对导入带 `.js` |
| 质量红线 | 不追加 surface 事件、不注入凭证；TUI 活动期 stdout 安静；`~/.dsh-tui` 下放用户数据、外部 JSON 必须校验；渲染路径字符串按 terminal cell 宽度处理 |

补充（对“管理面板”类插件的现实含义）：`permissions-0.1.json` 当前只有 `storage.local.read/write`、`commands.invoke`、`messages.observe.read` 与四个拦截类权限，**没有文件系统类权限**；插件在进程内运行，改 `~/.dsh/skills`、profile 的 `cordis.patch.yml` 不受权限门禁，只能靠信任披露与评审约束。先例 `dsh-tui-mcp-manager` 只声明 `commands.invoke` 一条。**【已验证事实】**

### 1.4 发布流程（模板即事实标准）

来源：`plugin-template/.github/workflows/publish.yml`（实测全文）。**【已验证事实】**

1. 触发：`push: tags: v*`；`permissions: contents: read` + `id-token: write`（npm provenance / trusted publishing 走 OIDC）。
2. 步骤：checkout → pnpm 11 → Node 24 → `pnpm install --frozen-lockfile` → **校验 tag == v`package.json.version`**（不等直接失败）→ `pnpm build` → `node scripts/check-manifest.mjs` → `npm pack --dry-run --json` 断言 `dsh-plugin.json` 在 tarball 里 → `npm publish --provenance --access public`。
3. 鉴权：优先在 npmjs.com 把仓库 + 该 workflow 配成 trusted publisher（无需 secret）；`secrets.NPM_TOKEN` 是降级。
4. `ci.yml`：PR/main 上同样的 install/build/check-manifest/tarball 断言。

dsh-TUI 主仓 `.github/workflows/publish.yml` 采用同一模式（tag 校验、`pnpm verify:build`、`verify:package`、`npm publish` + provenance），并额外处理 prerelease 的 dist-tag（prerelease 显式 `--tag latest`）。**【已验证事实】**

### 1.5 参考实现 `dsh-working-activity` 的形态

- 包 `dsh-working-activity@0.6.0`；仓库 `ccch1mneyyy/working-activity`（666 star / 237 fork，MIT，最后推送 2026-10-18）。注意：**npm `license` 字段实测为 `BSD-3-Clause`**，与“生态普遍 MIT”不一致，引用代码/资产时要单独核对。**【已验证事实】**
- 形态（准入文档描述；仓库与 npm 元数据已核对）：运行工作状态行，**双出口**——官方 TUI 的 `tuiPrompt` 槽位（`ctx.get('tuiPrompt', false)`）+ dsh-TUI 消费的 `activity/status` log-only 会话事件；可选接缝用 `ctx.get('service', false)` 静默降级。**【已验证事实（文档 + 元数据）】**
- 对我们的借鉴：**不要依赖单一宿主**；能用 log-only 事件 + 窄接缝就别碰私有面；`apply` 内不 await、耗时工作脱离 apply。**【建议】**

---

## 2. 同类先例（含对比表）

### 2.1 dsh-TUI 侧：谁已经占了什么位置

| 项目 | 版本/时间 | 能力 | 与我们的关系 | 证据等级 |
| --- | --- | --- | --- | --- |
| **dsh-TUI 本体** `@deepseek-harness-tui/dsh-tui` | 0.19.0 / 2026-11-06 | 内置 `/skills`（只读技能目录 picker，Enter 回填 `/name`）、`/mcp`（状态报告 + 取决于后端能力的 reconnect/toggle）、`/plugin install` / `remove` / `enable` / `disable`、`/settings` 可被插件扩展 | **技能侧只读、MCP 侧只“看/开关”，没有增删改/导入/分组/安装**；管理面板要在其旁边补位 | 【已验证事实】 |
| **dsh-tui-mcp-manager** | 0.1.6 / 2026-10-19 | `/mcp-manager` 全屏：MCP CRUD、启停、Sets、复制、Inspector、Tool schema、Doctor Lite、凭据引用；原子写 profile `cordis.patch.yml` + `mcp-manager.sets.yml` | **唯一 MCP 直接竞品**；只做 MCP、无技能；声明 `compat.hosts >=0.16.1 <0.17.0`，与 0.19.0 不兼容；0 star、2026-10-19 后无发版 | 【已验证事实】 |
| **dsh-tui-pkg** | 0.4.3 / 2026-09-28 | `/pkg` 全屏插件管理器：列已装插件/bundle，装/卸/启停，新版本探测 | 占“插件管理”，不占技能/MCP；可参考其交互与版本探测 | 【已验证事实】 |
| **dsh-tui-market** | 未上 npm（源码 0.2.0，2026-08-28） | `/market` 浏览生态 `plugins.json`、GitHub `topic:dsh-plugin` 搜索、装/卸（子进程 `dsh plugin add/remove`） | 占“发现/安装渠道”；它读的就是我们将来要投稿的收录列表 | 【已验证事实】 |
| **dsh-tui-skill**（`KotlinHero/dsh-tui-skill`） | 0 star / 2026-09-27 | 是一份 **DSH 技能（SKILL.md + references）**，教 agent 操作 dsh-TUI | 不是管理面板；说明“技能”这个词在检索里噪声大 | 【已验证事实】 |
| 其它 dsh-TUI 插件 | — | 主题、会话管理、快捷键、文件浏览、任务面板、成本计费等（生态列表 45 条） | 均不涉及技能/MCP 管理 | 【已验证事实】 |

细节（`dsh-tui-mcp-manager`，均来自其 GitHub 文件）：

- `dsh-plugin.json`：`id: "com.dsh-tui.mcp-manager"`、`manifestVersion 0.15`、`facets.host.apiVersion v1alpha1`、`requires.contracts: [commands.dsh/v1alpha1 Command]`、`permissions: [commands.invoke]`、`contributes.commands`、`license MIT`、`compat.hosts: "@deepseek-harness-tui/dsh-tui >=0.16.1 <0.17.0"`、`overrides: [{ target: "cordis.patch.yml", kind: "patch" }]`。**【已验证事实】**
- `package.json`：peer 里把 `@deepseek-harness-tui/dsh-tui` 钉 `^0.16.1`（对 0.x 而言 **不含 0.17+**），另有十余个 `@deepseek-ai/dsh-*` 精确 peer；`files` 含 `lib/cordis.patch.yml/dsh-plugin.json/README*/LICENSE`；`lib/` 提交入库。**【已验证事实】**
- README 明说：需要 TUI `>=0.16.1 <0.17.0`、dsh `0.2.1-rc.2`；并提醒旧入口 `dsh --profile dsh-tui` 在 0.16.1 下“可能因宿主接纳顺序导致命令未注册”。→ 该包是本项目**最直接、也最脆弱**的先例：契约写得很足，但兼容钉得过窄。**【已验证事实】**

### 2.2 web（DSH）侧：能力模型可参考，不是同赛道竞品

| 包 | 版本/时间 | 形态 | 可借鉴点 |
| --- | --- | --- | --- |
| **dsh-skill-mcp-panel**（参考对象） | 2.3.7 / 2026-11-04；仓库 260 star、25 fork、10 open issues，2026-11-05 仍在推送 | Web 侧边栏「Skill / MCP」整页面板 + 统一 CLI `dsh-panel`（bin 字段实测） | 技能=直接改磁盘文件、MCP=接管 profile 的 `@deepseek-ai/dsh-mcp-client` 行；分组、批量迁移、原子写、OAuth、Doc/Inspector |
| dsh-mcp-panel | 0.6.31 / 2026-11-05 | Web MCP 控制台 `/mcp`，健康诊断 | MCP 诊断/工具 schema 的呈现参照 |
| dsh-mcp-servers-panel | 0.2.3 / 2026-10-20 | 设置页 MCP 面板，写 profile `cordis.patch.yml`、启停 `dsh-mcp-cli` | 受管块/行接管策略 |
| dsh-mcp-setting | 0.2.0 / 2026-10-19 | 设置页 MCP 增删改 | — |
| @moon16u/dsh-mcp-console | 0.3.10 / 2026-10-21 | Web GUI MCP 控制台 | — |
| @sunshaobei/dsh-mcp-manager、@wingsky-1/dsh-mcp-manager | 3.1.6 / 0.2.11 | Web MCP 管理（四中间件工具） | — |
| @michengai/dsh-skills-manager | 1.2.35 / 2026-11-06 | 技能统一加载与安全管理 | 技能安全/审计 |
| dsh-skill-hub | 0.3.31 / 2026-11-03 | skill hub：浏览/搜索/分组开关/安装审计 | 安装时审计的提示可借鉴 |
| dsh-skill-cockpit | 1.6.0 / 2026-11-04 | App 级导航页列出全部技能 | 列表信息架构 |
| @linxin666/dsh-client-ui-skill-explorer、@moruoxing/dsh-skill-manager、dsh-skill-collections | 2026-10/11 | 按来源分组、启停、收藏夹、批量绑定工作区 | 启停/分组的数据模型 |

关键复用点（来自 web 版源码/README，均可独立复核）：**【已验证事实】**

- **仓库活跃度**：创建 2026-08-14，2.3.7 发布于 2026-11-04，最后推送 2026-11-05，13 个已发版本；`gh search issues --repo Fishquito7/dsh-skill-mcp-panel "tui"` **无结果**——即 web 版 issue 中没有 TUI 相关需求/提案，TUI 侧机会不是“对方正在做”。**【已验证事实】**
- **技能存储就是磁盘文件**：全局 `~/.dsh/skills`，工作区 `<ws>/.dsh/skills`；**停用 = `SKILL.md` 改名为 `SKILL.md.disabled`，启用 = 改回**；迁移 = 复制/移动目录（先校验、失败回滚）；bundled 技能只读。卸载插件后技能仍是普通文件，DSH 文件监听器热发现。
- **分组只是显示配置**，存 `<dshHome>/skills/.system/skill-viewer/groups.json`（`version: 1`，`groups[groupId] = { name, scopes: { global: [...], "<工作区路径>": [...] } }`），位于发现服务跳过的 `.system` 隐藏区；损坏按空配置处理。→ 若 TUI 版也要分组，**复用同一文件格式**可做到两端一致，否则会分裂成两套分组。
- **MCP 配置**：只维护 profile `cordis.patch.yml` 中由 marker 包围的受管块（`# >>> dsh-mcp-manager: managed MCP server rows >>>`），受管块外内容逐字节保留；敏感值只写 DSH credentials 引用；跨文件提交用 fsync + 原子 rename + 恢复日志；与 DSH 的 Profile 配置编辑器共用锁。→ 这是 MCP 面板“不破坏用户配置”的硬要求，TUI 版必须同样处理（我们的 marker 必须与 web 版**不同**，避免同一文件两个 owner）。
- 版本兼容教训：web 版 2.3.0 起只支持 DSH 0.2.x（peer `>=0.2.0-rc.1 <0.3.0-0`）；2.1.0 起把入口从 `/settings` tab 迁到侧边栏；2.3.6 才做到“全接管 `dsh-mcp-client` 行（不区分受管块内外）”。→ 我们的首版不要一口气承诺“全接管”。
- 与 TUI 无直接关系：`dsh-panel update` 按 profile 原安装渠道（tarball / npm / Git）升级；Web 版**没有 `dsh-plugin.json`**（Web 插件不参与 TUI 准入），故其 manifest/权限模型不能直接照抄。

### 2.3 市场/目录侧：`dshmarket`、`dshfind`、生态 `plugins.json`

- **dshmarket**（`dsh-market/dsh-market`，1.73.14 / 2026-11-06，MIT）：DSH **Web** 可视化插件市场（浏览/搜索/一键装）。源码里有一个启发式 `looksTerminal()`：包名含 `tui/cli/tty/terminal` 或描述里“只在终端/命令行工具”等正向断言时，把它标记为终端型插件（用于“可能在 web 应用里不能用”的提示）；它**不会**把包装进 `dsh-tui` profile。本机 web profile 已装 `dshmarket: github:dsh-market/dsh-market`。**它是否已收录技能/MCP 管理类插件**：目录来自远端 registry（`RegistryPlugin` 带 `npm/tarball/category` 等字段），本次未抓取目录快照、无法确认；即便收录，安装目标也是 web profile，与 TUI 插件不互通。**【已验证事实】+【未验证（目录内容）】**
- **dsh-tui 生态内市场** `dsh-tui-market` 的市场数据就是生态 `plugins.json`（无技能/MCP 管理类条目），搜索来自 GitHub `topic:dsh-plugin`；说明目前 TUI 侧**没有**任何“技能/MCP 管理”类可发现条目。**【已验证事实】**
- **dshfind**（`hikariming/dshfind`，371 star；另有 `oh-my-dsh/dsh-community-standard` 13 star 的社区互操作标准草稿）：第三方 DSH 插件目录/市场与徽章服务，`dsh-tui-pkg` 的 README 里挂了它的 badge。它不是 TUI 官方渠道，收录状态未核实。**【已验证事实（仓库存在/star）】+【未验证（是否收录 TUI 插件）】**
- **生态 `plugins.json`**（45 条）是 TUI 内 `/market` 与 `dshtui.com/plugins` 的数据源，也是我们上线后最该投的“发现渠道”。**【已验证事实】**
- 本机 web profile 里除 `dsh-skill-mcp-panel` 外还装了 `dsh-context`、`dshmarket` 等多个 web 插件；`dsh-tui` profile 里只有本体 + `ds-harness-remote`。→ **两个 profile 天然隔离**，web 版与我们不共享 profile（除非用户手动混装）。**【已验证事实】**

### 2.4 空位与差异化

| 能力 | dsh-TUI 内置 | dsh-tui-mcp-manager | web 版 dsh-skill-mcp-panel | 我们的机会 |
| --- | --- | --- | --- | --- |
| 技能列表/查看 | ✅ `/skills`（只读 picker） | ❌ | ✅ | 补 CRUD、搜索、分组、来源过滤 |
| 技能启停/删除/导入/迁移 | ❌ | ❌ | ✅（磁盘文件语义） | 主战场 |
| 技能分组与显示配置 | ❌ | ❌ | ✅（`groups.json` v1） | 复用格式，跨端一致 |
| MCP 列表/状态 | ✅ `/mcp`（状态 + 有限 reconnect/toggle） | ✅ | ✅ | 状态之外补配置管理 |
| MCP 增删改/导入/诊断/工具 schema | ❌ | ✅（但仅 TUI 0.16.x） | ✅（全接管 `dsh-mcp-client` 行） | 次战场：先“查看/诊断/启停”，后 CRUD |
| 统一“技能+MCP”入口 | ❌ | ❌ | ✅（合并成一行入口 + 页签） | **差异化核心** |
| 与 `/settings` 集成 | 宿主提供 `tuiSettingsSections` 接缝 | 未用 | web 设置页（不是 tab） | 可做“面板设置区块” |

**结论**：空位真实存在——TUI 侧“技能管理”= 0，“技能+MCP 统一面板”= 0；唯一 MCP 先例已与当前 0.19.0 脱节。我们的差异化应落在：**TUI 原生全屏体验 + 技能/MCP 统一入口 + 与 web 版共享磁盘语义（分组格式/停用后缀）**，而不是重做 `/plugin`（dsh-tui-pkg 已占）或插件市场（dsh-tui-market 已占）。

---

## 3. 命名与发布通道

### 3.1 npm 候选名实测（2026-11-07，原始输出）

```text
$ npm view dsh-tui-skill-mcp-panel version
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/dsh-tui-skill-mcp-panel - Not found
npm error 404  The requested resource 'dsh-tui-skill-mcp-panel@*' could not be found or you do not have permission to access it.

$ npm view dsh-tui-skill-manager version   → E404（同上）
$ npm view dsh-tui-skill-panel version     → E404
$ npm view dsh-tui-skills version          → E404
$ npm view dsh-tui-panel version           → E404
$ npm view dsh-tui-settings-panel version  → E404
$ npm view dsh-tui-mcp-skill-panel version → E404
$ npm view dsh-tui-skill-mcp version       → E404
```

E404 = 该名字在 npm 上不存在（**可用**，但不等于“可发布”：仍需 npm 账号/组织权限与发布时再查一次）。**【已验证事实】**

已占用参照（对比用）：

```text
$ npm view dsh-tui-mcp-manager version   → 0.1.6
$ npm view dsh-tui-pkg version           → 0.4.3
$ npm view dsh-skill-mcp-panel version   → 2.3.7
$ npm view dsh-mcp-manager version       → 0.6.0   # 第三方 web MCP 管理器，与 @deepseek-ai/* 无关
$ npm view @deepseek-ai/dsh-mcp-manager version → E404（公共 npm 无此包）
$ npm view @dsh-tui-ecosystem/example-plugin version → E404（该 scope 目前查无已发布包）
```

注意两个坑：**(a)** 裸名 `dsh-tui` 已被无关项目占用（`dsh-tui@0.2.19`，MashedPotato817 的 terminal client）；**(b)** `@deepseek-harness-tui/*` 是官方 scope、`@deepseek-ai/*` 是上游宿主 scope，生态插件都不要占用。**【已验证事实】**

### 3.2 命名/仓库名建议

| 项 | 建议 | 理由 |
| --- | --- | --- |
| npm 包名 | **`dsh-tui-skill-mcp-panel`**（首选，E404 可用） | 与 web 版 `dsh-skill-mcp-panel` 形成清晰对应；含 `dsh-tui` 便于生态检索；与先例 `dsh-tui-mcp-manager` 不撞名 |
| 备选 | `dsh-tui-skill-manager`（更短，但只提技能）；`@dsh-tui-ecosystem/skill-mcp-panel`（需先有 npm 组织与该 scope 的发布权） | scoped 只是建议不是要求；**scoped ≠ 嫡系**：只有被 dsh-TUI 随包 feed 精确钉住才免信任确认，且 feed 由 dsh-TUI 维护者决定 |
| GitHub 仓库 | `dsh-tui-skill-mcp-panel`（个人账号或 `dsh-tui-ecosystem` 组织二选一） | 收录校验要求 `repo` 公开 + README 回链 dsh-TUI + PR 作者是 owner/collaborator；裸名仓库在个人账号下是生态常态 |
| `dsh-plugin.json` `id` | `dsh-tui.skill-mcp-panel`（或 `com.dsh-tui.skill-mcp-panel`，与 mcp-manager 风格一致） | 需满足 `check-manifest` 的命名空间 id 正则；**不随版本变化** |
| `dsh-plugin.json` `name` | `dsh-TUI Skill & MCP Panel`（展示名） | 展示名不必等于包名 |
| 包 peer | `@deepseek-harness-tui/dsh-tui: ">=0.19.0 <0.20.0"`（首版），`@deepseek-ai/cordis: "^4.0.1"`，按需加 `@deepseek-ai/dsh-skill`/`dsh-settings`/`dsh-mcp-client` 等**仅实际 import 的** | 先窄后宽：仿 mcp-manager 把范围钉到单个 minor 是它过时的直接原因；但也不要写 `*`（准入要求可判定的范围） |
| `compat.hosts` | 与 peer 同写 `">=0.19.0 <0.20.0"`（0.19.0 实测通过后再放宽） | `compat` 是 manifest 允许字段（模板 `check-manifest` 的 TOP_LEVEL 里有）；mcp-manager 用了它 |

### 3.3 安装渠道与 `/plugin install` 的兼容性

证据：dsh-TUI 0.19.0 README（已装包）明确 `/plugin install <package | path | git url>`，走宿主 `ctx.pluginManager`（装前提醒→信任确认→可取消进度→构建脚本批准→精确版本豁免）；DSH 0.2.2-rc.1 的 `@deepseek-ai/dsh-plugin-manager` 类型 `InstallSpecKind = 'registry' | 'path' | 'git' | 'tarball'`；其 README 说明 `installBundle` 接受“registry 包名、本地目录、或保存依赖时使用的 git / tarball spec”，git 安装前会 `git ls-remote` 检查 GitHub 可达性。**【已验证事实】**

| 渠道 | spec 示例 | 状态 | 备注 |
| --- | --- | --- | --- |
| npm registry | `dsh-tui-skill-mcp-panel@0.1.0` / 裸名（解析 latest） | ✅ 支持 | 裸名/tag/range 在 TUI 会被解析为精确 `name@version` 再装；只有“精确命中首方 feed 的 `name@version`”才免一次信任确认 |
| 本地目录 | `/path/to/repo` 或 `file:...` | ✅ 支持 | 开发期主用法；需先 `pnpm install && pnpm build` |
| git | `https://github.com/<owner>/<repo>.git`（可带 `#tag`/commit） | ✅ 支持（会先 `git ls-remote`，默认 5s 超时） | **必须提交构建产物 `lib/` 与 `pnpm-lock.yaml`**，否则装后没有可加载入口（模板就是这么做的） |
| GitHub Release tarball | `https://github.com/<owner>/<repo>/releases/latest/download/<name>.tgz` | 【推断】可用 | 宿主 inspect/install 支持 `tarball`（含 HTTP(S) 与本地文件）；但 TUI README 只列了三种形式，**需在真机 `/plugin install <tarball-url>` 实测**；tarball 内 `package.json.name` 应与包名一致，`files` 必须含 `dsh-plugin.json`（模板 publish 已断言） |
| CLI | `dsh plugin --profile dsh-tui add <spec>` / `remove` / `enable` / `disable` | ✅ 支持 | TUI 0.19.0 文档：服务缺席时由转录给出 CLI 命令，“不在 TUI 内代跑 `dsh plugin`” |

建议：**npm 作为主渠道，GitHub Release tarball 作为“无 npm 账号/快速试装”的备用**（web 版 README 推荐恒定别名 tarball；我们可同时上传 `dsh-tui-skill-mcp-panel.tgz` 与带版本号的 `...-0.1.0.tgz`）。`git` 渠道只在 README 里作为开发用法，不作为主推。

### 3.4 许可证与发布注意

- **许可证**：MIT（与 dsh-TUI 主包、模板、web 参考版一致）；`package.json.license` + 仓库 `LICENSE` 一致可定位（准入 A 节）。**【建议】**
- **版本与标签**：语义化版本；`v*` tag **必须等于** `package.json.version`（模板与主仓 publish 都会硬失败）。**【已验证事实】**
- **provenance**：能出就出（GitHub Actions + npm trusted publishing，OIDC，无需 secret）；provenance 只是 `attested` 档 evidence，**不构成准入、不等于审计**（准入文档明确）。**【已验证事实】**
- **tarball 完整性**：`files` 白名单必须含 `dsh-plugin.json`、`cordis.patch.yml`（若用）、`lib/`、README、LICENSE；publish 前跑 `node scripts/check-manifest.mjs` 与 `npm pack --dry-run` 自查。**【建议】**
- **Node/ESM**：跟 dsh-TUI 的 `^22.19 || >=24`、`type: "module"`、相对导入 `.js`。注意：本机 DSH CLI `@deepseek-ai/dsh@0.2.2-rc.1` 自己的 `engines` 是 **`>=24.9.0`**，所以实际运行环境的下限是 Node ≥24.9（`dsh-tui` 的宽范围只是兼容声明）。**【已验证事实】+【推断（实际影响）】**
- **claim（可选）**：若要发 Verified claim，需补 `source`（repository + revision）与 `artifact`（tarball SHA-256），并绑定 std revision/profile/Host/suite/result；**运行时不校验** digest/provenance。首版可先不做 claim，只保证可安装+可准入。**【建议】**

### 3.5 与 web 版共存的风险与缓解

| 风险 | 现状/证据 | 缓解建议 |
| --- | --- | --- |
| 技能文件并发写 | 两端都直接改 `~/.dsh/skills`、`<ws>/.dsh/skills`；web 版用原子写 + 失败回滚 | 沿用同一套磁盘契约（`SKILL.md` / `SKILL.md.disabled`）；写前重读、原子 rename、冲突时保留用户文件并提示；首版可加 `.lock` 或仅在文件未变化时写 |
| 分组配置分裂 | web 版把分组存 `$DSH_HOME/skills/.system/skill-viewer/groups.json`（version 1） | 复用同一路径与结构（只读兼容或读写兼容）；如要扩展字段，走 `version` 升级并保持向后兼容 |
| MCP 行双 owner | web 版接管当前 profile 的所有 `@deepseek-ai/dsh-mcp-client` 行，并有自己的受管块 marker | 我们的 marker 必须**不同名**（如 `# >>> dsh-tui-skill-mcp: managed rows >>>`），只动自己块内行；跨块行只读展示/提示“由外部管理” |
| 公共 `mcpManager` 服务冲突 | web 版 issue #81：DSH 0.2.2-alpha.3 内置 `@deepseek-ai/dsh-mcp-manager` 注册 `mcpManager`，与 web 版重复注册导致内置插件启动失败；该包在公共 npm **E404**，本机 DSH 0.2.2-rc.1 的 `node_modules` **不含**它 | **不要**注册同名 `mcpManager` 服务；若需要内部服务用 `dsh-tui-skill-mcp.*` 命名空间。若宿主提供 `mcpManager`，优先 `ctx.get('mcpManager', false)` 消费而不是自建；跟踪上游是否恢复内置 |
| 命名混淆 | `dsh-skill-mcp-panel`（web）与 `dsh-tui-skill-mcp-panel`（TUI）只差前缀 | README 互相注明“Web 版 / TUI 版”，安装命令写清 profile；`dsh-plugin.json` 的 name 与 description 明确 TUI-only |
| 同一 profile 混装 | 两个 profile（web / dsh-tui）默认隔离；但用户可以手动把 web 插件装进 TUI profile | 我们只依赖 `ctx.tui*`/`skills` 服务，缺服务时静默降级（准入要求）；web 版装进 TUI profile 大概率无 UI 但不应崩宿主——这一点由对方保证，不是我们的承诺 |

---

## 4. 对首版范围的影响

### 4.1 可复用的社区资产（不用从零写）

- **脚手架**：`plugin-template` 的 `dsh-plugin.json` / `cordis.patch.yml` / `check-manifest.mjs` / `ci.yml` / `publish.yml` 可直接复制改名。**【已验证事实】**
- **接缝示例**：模板的 `src/{index,events,registration}.ts` 演示 Cordis 三面导出、会话事件类型注册（resume 安全）、可选槽位；`dsh-working-activity` 演示双出口与降级。**【已验证事实】**
- **交互范本**：`dsh-tui-pkg`（`/pkg` 全屏列表+启停+安装输入）、`dsh-tui-mcp-manager`（`/mcp-manager` 全屏 + Sets + 诊断）、`dsh-tui-find`/`dsh-tui-session-manager`（全屏场景 + 搜索过滤）↔ 都证明“全屏场景 + 命令入口”是 TUI 插件的事实标准形态。**【已验证事实】**
- **数据模型**：web 版的技能磁盘语义（disable 后缀、迁移、分组 `groups.json` v1）与 MCP 受管块/原子写/凭据引用策略，可直接移植成 TUI 版领域层（代码是 Web/TS，需重写渲染层）。**【建议】**
- **宿主服务**：DSH 技能服务 `ctx.skills`（`registerProvider` / `register` / `list` / 按 agent scope）可用于“只读目录 + 运行期技能提供者”；MCP 侧 DSH `@deepseek-ai/dsh-mcp-client` 是真正的连接与工具注册者，我们只改配置。**【已验证事实（类型定义）】**

### 4.2 需要自研（社区没有现成 TUI 实现）

1. **TUI 渲染层**：技能三栏（来源/分组/内容）或两栏布局、MCP 卡片/表单、搜索、多选、确认对话框——Ink/自研 ink 系渲染在 dsh-TUI 内，社区面板都是 Web React，**不能直接复用**。
2. **Profile `cordis.patch.yml` 编辑**：受管块识别、外部行逐字节保留、重复 id/serverName 定位、原子写 + 恢复日志、与 DSH Profile 编辑器共享锁（web 版 ADR-0003/0007 的经验要重新实现）。
3. **技能写操作**：`SKILL.md` frontmatter 校验（单行 `name`/`description`）、`.md`/`.zip`/目录导入、移动/复制回滚、bundled 只读判定、`SKILL.md.disabled` 约定、防止路径逃逸。
4. **与宿主 `/skills`、`/mcp` 的关系**：不重复实现 picker；面板改完文件后依赖 DSH 文件监听热生效（web 版实测可行），不重启宿主。
5. **信任与权限披露**：`commands.invoke` 之外是否需要 `storage.local.read/write`？改磁盘文件不在权限目录内，需在 README/首次运行披露 `trusted-in-process`（准入 `TUI-RUN-002`）。

### 4.3 上游接缝与 issue 线索（截至 2026-11-07）

- **dsh-TUI 0.19.0 可用接缝**（本地文档 + 已装包导出）：`tuiScenes`（全屏场景，稳定候选，`./scenes` 导出）、`tuiSettingsSections`（`/settings` 声明式区块，稳定候选，`./settings-sections`）、`tuiDialogs`、`tuiStatus`、`tuiShortcuts`、`tuiRenderers`、`commands`；`tuiPanels`（右侧栏面板）**实验性**、compact 仅校验 descriptor 不渲染、`sendToChat` 暂不支持。→ 首版建议 **`tuiScenes` + `commands`**，设置项走 `tuiSettingsSections`，**不要**押 `tuiPanels`。**【已验证事实】**
- **上游 issue 线索**（`gh search issues --repo ccch1mneyyy/dsh-TUI`）：
  - `#204`（closed 2026-08-16）请求 `/skills` 命令 → 已有只读 picker（实现于 `src/components/SkillsPicker.tsx`，注释写明 issue #204）。**【已验证事实】**
  - `#86`（closed）文件系统技能不进 `/` 补全菜单；`#684`（closed 2026-10-22）建议统一 `/skill <名>` 命名空间，结论“待决策/拆范围”，说明**技能命令入口仍会演进**，我们不应把技能调用路径写死。**【已验证事实】**
  - `#1578`（open 2026-10-16）“MCP 日志污染输入框 && 界面无法动态调整” → MCP 场景 UX 是已知痛点，我们的面板要避免往输入框打日志。**【已验证事实】**
  - `#1246`（open）`dst 承担 CLI 职能`、`#1559`（open）CLI 二期 adapter 打包闭环：上游正在补 CLI 能力，长期可能与面板的管理动作重叠（面板应调用公开服务/命令，而不是自己拼子进程）。**【已验证事实（issue 存在）】+【推断（重叠）】**
  - roadmap（本地 `docs/roadmap.md`，Phase 2）：稳定 plugin API、主题/命令/场景/状态行插件模板、插件兼容性检查、生态目录均为 `🟡 Design`/`⚪ Not started` → 说明我们的面板在“上游还没做完”的窗口期，需自带兼容层与清晰降级。**【已验证事实】**
- **web 版 issue #81 的上游内置 MCP 管理**：见 3.5；需持续跟踪 DSH 0.2.2 正式版是否内置 `mcpManager`。**【未验证】**

---

## 5. 风险与未决问题（交给需求/设计文档）

1. **首版范围**：技能+MCP 双面板 vs 先技能后 MCP？证据支持“技能没竞品、MCP 有先例且宿主可能内置”，建议**首版只做技能（查看/启停/导入/分组）+ MCP 只读诊断/启停**，CRUD 二期。
2. **MCP 归属**：宿主若提供 `mcpManager` 服务，我们的 MCP 面板是“消费宿主服务”还是“自建配置层”？需在实现前用 DSH 0.2.2 正式版复核。
3. **技能启停语义**：`SKILL.md.disabled` 是 web 版私有约定，DSH 文件 provider 是否真的忽略 `.disabled`？（web 版 README 声称可热生效，TUI 侧未实测）→ **需在真机验证**。
4. **分组文件跨端共享**：读写同一 `groups.json` 会带来 schema 耦合；是否只读兼容、或另存 `~/.dsh-tui/skills-viewer.json`？需产品决策。
5. **权限模型空白**：TUI 权限目录没有文件系统权限；改用户技能目录/写 profile 只能靠信任披露。首版是否需要额外的“只读模式/扫描模式”？
6. **命名撞车**：`dsh-tui-mcp-manager` 已存在且名字接近；用户可能误装。README 需写明差异与迁移（若其作者恢复维护，我们是否共存/合并？）。
7. **生态收录**：投稿 `plugins.json` 需仓库公开 + README 回链 + 作者本人 PR；是否有账号/组织可用，需确认（本项目所在 GitHub 身份未在本次调研中核实）。

---

## 6. 关键证据清单（URL + 访问日期 2026-11-07）

| # | 来源 | 用途 | 等级 |
| --- | --- | --- | --- |
| 1 | 本地 `dsh-TUI/tui-profile/docs/plugin-admission-and-development.md`（v0.17.0 checkout，1603 行） | 准入规范/命名发布/收录/供应链 | 已验证事实 |
| 2 | 本地 `dsh-TUI/tui-profile/{README.md,PLUGIN-ADMISSION-CHECKLIST.md,registry/permissions-0.1.json,feed/first-party.json}` | 三层生态、权限、feed | 已验证事实 |
| 3 | 本地 `dsh-TUI/docs/plugins.md`、`docs/roadmap.md` | 接缝稳定性、/plugin 现状、roadmap | 已验证事实 |
| 4 | 本地 `dsh-TUI/src/components/SkillsPicker.tsx`、`src/dsh-adapter/channel/core/compose.ts`（mcp capability） | 内置 `/skills`、`/mcp` 能力边界 | 已验证事实 |
| 5 | `https://github.com/dsh-tui-ecosystem/plugin-template`（API 读文件树/package.json/dsh-plugin.json/cordis.patch.yml/publish.yml/ci.yml/check-manifest.mjs） | 模板结构、发布流程 | 已验证事实 |
| 6 | `https://github.com/dsh-tui-ecosystem/dsh-tui-ecosystem/blob/main/plugins.json`（API 原始内容，45 条） | 生态收录现状与渠道 | 已验证事实 |
| 7 | `https://github.com/dsh-tui-ecosystem/dsh-tui-ecosystem`（README/issues/commits） | 命名约定、投稿流程、活跃度 | 已验证事实 |
| 8 | `https://github.com/0N3-0/dsh-tui-mcp-manager`（package.json/dsh-plugin.json/README/README_EN/releases/repo meta） | MCP 先例、兼容钉死 | 已验证事实 |
| 9 | `https://github.com/Whos12Jackson/dsh-tui-pkg`（README）、`https://github.com/FUSU123fusu/dsh-tui-market`（README） | 插件管理/市场先例 | 已验证事实 |
| 10 | `https://github.com/KotlinHero/dsh-tui-skill`（文件树/README） | 排除“同名≠面板” | 已验证事实 |
| 11 | `https://github.com/Fishquito7/dsh-skill-mcp-panel`（repo meta/issues #81/README/源码 src/groups.ts） | web 参考对象能力模型、存储约定、服务冲突 | 已验证事实（#81 内容为其用户报告，未独立复现） |
| 12 | `https://github.com/dsh-market/dsh-market`（npm 元数据、源码 `src/client/market-data.ts`） | dshmarket 是 web 市场、`looksTerminal` 判定 | 已验证事实 |
| 13 | `https://github.com/hikariming/dshfind`、`https://github.com/oh-my-dsh/dsh-community-standard` | 第三方目录/社区标准 | 已验证事实（存在/star）；收录细节未验证 |
| 14 | 本机 `@deepseek-ai/dsh@0.2.2-rc.1` 的 `node_modules/@deepseek-ai/dsh-plugin-manager`（`lib/types/types.d.ts`、README.zh.md）、`@deepseek-harness-tui/dsh-tui@0.19.0`（package.json/README/lib） | `InstallSpecKind`、`/plugin install`、引擎/peer、feed | 已验证事实 |
| 15 | npm registry（`npm view`） | 包名可用性、版本、peer、license | 已验证事实 |
| 16 | `https://github.com/ccch1mneyyy/dsh-TUI` issues（#204/#86/#684/#1578/#1246/#1559）与 `https://github.com/dsh-tui-ecosystem/dsh-tui-ecosystem/plugins.json` | 上游线索 | 已验证事实（issue/内容）；影响为推断 |

---

## 附录 A：环境与数据快照（2026-11-07）

```text
本机 dsh-TUI 源码 checkout：/home/wqwt/code/dsh-TUI（v0.17.0，origin https://github.com/ccch1mneyyy/dsh-TUI）
本机已装 dsh-tui：@deepseek-harness-tui/dsh-tui 0.19.0（profile ~/.dsh/profiles/dsh-tui）
本机已装 DSH CLI：@deepseek-ai/dsh 0.2.2-rc.1（engines node >=24.9.0）
本机 Node：v26.3.0；npm 12.0.2；gh 已登录（wuqiuwangtian）
GitHub：ccch1mneyyy/dsh-TUI 7131 star / 349 fork / MIT / 最后推送 2026-11-07
        dsh-tui 最新 release v0.19.0（2026-11-06）
        dsh-tui-ecosystem/plugin-template 3 star，最后推送 2026-10-18，MIT
        dsh-tui-ecosystem/dsh-tui-ecosystem 4 star / 10 fork，最后推送 2026-11-06
        Fishquito7/dsh-skill-mcp-panel 260 star / 25 fork / 10 open issues，最后推送 2026-11-05，MIT
        0N3-0/dsh-tui-mcp-manager 0 star，最后推送 2026-10-19，MIT
npm 版本：dsh-tui 0.2.19（无关项目占用裸名）、dsh-tui-mcp-manager 0.1.6、dsh-tui-pkg 0.4.3、
          dsh-skill-mcp-panel 2.3.7、dshmarket 1.73.14、@deepseek-harness-tui/dsh-tui 0.19.0、
          @deepseek-ai/dsh 0.2.2-rc.1、dsh-working-activity 0.6.0（license BSD-3-Clause）
```

## 附录 B：可直接执行的复核命令

```sh
# 1) 包名是否仍可用（E404 = 可用）
npm view dsh-tui-skill-mcp-panel version

# 2) 模板与发布流程
gh api -H "Accept: application/vnd.github.raw" repos/dsh-tui-ecosystem/plugin-template/contents/.github/workflows/publish.yml
gh api -H "Accept: application/vnd.github.raw" repos/dsh-tui-ecosystem/plugin-template/contents/dsh-plugin.json

# 3) 生态收录现状
gh api -H "Accept: application/vnd.github.raw" repos/dsh-tui-ecosystem/dsh-tui-ecosystem/contents/plugins.json

# 4) MCP 先例的兼容声明
gh api -H "Accept: application/vnd.github.raw" repos/0N3-0/dsh-tui-mcp-manager/contents/dsh-plugin.json

# 5) 宿主支持的安装 spec 类型（本机已装 DSH）
grep -n "InstallSpecKind" ~/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/types.d.ts

# 6) 装进 profile 并真机验证（会写 profile；发布前在一次性 profile 或备份后执行）
dsh plugin --profile dsh-tui add <你的包名>
dsh --profile dsh-tui
# 若用 tarball 渠道，额外实测 TUI 内：
#   /plugin install https://github.com/<owner>/<repo>/releases/download/v0.1.0/<name>.tgz
```
