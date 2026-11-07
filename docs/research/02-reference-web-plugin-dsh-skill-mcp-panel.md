# 02 · 参考插件拆解：dsh-skill-mcp-panel（web）v2.3.7

> 状态：调研完成（2026-11-07）｜作者：ref-panel（调研员）｜本会话只做文档
> 目标读者：要实现「dsh-tui 技能 + MCP 可视化管理插件」的开发者。读完后**不需要再读参考实现约 690KB 的 JS**，即可知道哪些模块能拿、哪些必须重写、坑在哪里。
> 关联文档：`01-dsh-tui-plugin-architecture.md`（TUI 接缝）、`03-dsh-skills-and-mcp-mechanisms.md`（DSH 内核）、`04-ecosystem-and-prior-art.md`（生态/发布）。

## 阅读约定

- `RP` = `/home/wqwt/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel`（已安装的参考插件 2.3.7，npm 包只发预构建 `lib/*.js`，无 `src`、无测试）。
- `DSH` = `/home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh`（DSH 0.2.2-rc.1 实现）。
- `TUI` = `/home/wqwt/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui`（已安装 dsh-tui 0.19.0）。
- 证据格式统一为 `文件:行号`；行号以 2.3.7 安装包与 0.2.2-rc.1 本机文件为准。
- 标注：【已验证事实】＝本次直接读代码/文件确认；【推断】＝由代码与机制合理推导但未实测；【未验证】＝无本机证据或未做运行验证。
- 外部资料（GitHub README / ADR / Issues）只作资料补充，**一律以安装包 `lib` 代码为准**。

---

## 0. 结论速览（TL;DR）

1. **架构是三层，不是一整块。** ①纯文件逻辑（技能扫描/迁移、patch 文本编辑、分组、OAuth、MCP 模型）；②宿主服务层（Typert RPC `skillsViewer`/`mcpManager`，负责把①接到 web 网关与 loader/HMR）；③浏览器束 `lib/client.js`（React，357KB）。**TUI 版只需要①，②要改造成普通宿主类，③完全不要。**
2. **参考插件已经用 CLI 证明「无 web 也能跑通核心流程」**：`lib/cli-skill.js`、`lib/cli-mcp.js` 只依赖 Node + 文件系统，覆盖面板多数组件以外的核心操作（差集见 §2.3）。TUI 版可以直接把这套「离线实现」提炼成 core。
3. **最值得直接复用的是 6 个纯模块**：`patch-editor.js`（902 行，MCP 字节级编辑）、`skill-files.js`（294 行，技能发现/校验）、`scope.js`（208 行，迁移引擎）、`groups.js`（125 行，分组配置）、`mcp/model.js`（381 行，MCP 配置模型）、`oauth.js`（578 行，OAuth 全套）。合计约 2488 行，运行时依赖只有 `yaml`、`zod`、Node 标准库（OAuth 连 zod 都不需要）。
4. **有三条设计约束必须继承，否则会静默改坏用户文件**：受管块内「非 MCP 外来行」的语义与字节保真（ADR-0003）、MCP 行身份用 `serverName + entryId` 双键（ADR-0006）、`!!js` 表达式必须原样往返（否则 Bearer 令牌会退化成字面量）。
5. **最大风险不在代码，在上游耦合**：服务名 `mcpManager` 与 DSH 0.2.2 内置 `@deepseek-ai/dsh-mcp-manager` 冲突（issue #81）；OAuth 令牌明文落盘且刷新函数**已写未接线**（issue #80）；受管块标记失配会让 MCP 页整体不可用且无自愈入口（issue #47）；对 `@modelcontextprotocol/sdk` 1.x 全家桶的依赖偏重。详见 §6。
6. **体积纠正**：任务描述里的「400KB 源码」不准确。实测 `lib` 共 11841 行 / 692KB：宿主侧 7037 行 / 335KB，浏览器束 `client.js` 4804 行 / 357KB（`wc -l`、`wc -c` 实测）。

### 建议给 TUI 版的最小移植集（先做这一批）

| 优先级 | 模块 | 用途 | 预估成本【推断】 |
|---|---|---|---|
| P0 | `patch-editor.js`（整份） | MCP 行就地读写、受管块、foreign 保真、原子写+锁 | 0.5 人日（复制 + 改 import） |
| P0 | `skill-files.js` + `scope.js` + `groups.js` | 技能发现/启停/迁移/分组 | 1 人日（含删掉 `.agents` 之外的业务裁剪决策） |
| P0 | `mcp/model.js` | 表单 ↔ patch 行、`${NAME}` ↔ `!!js`、脱敏 | 0.5 人日 |
| P1 | `oauth.js` + `mcp/probe.js` | OAuth 登录/探活（仅 HTTP 场景） | 1 人日 + 依赖评审 |
| P1 | `cli-skill.js`/`cli-mcp.js` 中的流程函数 | 参照它们写 TUI 的 action 层（不要直接调 CLI 入口） | 1–2 人日 |
| P2 | `index.js` + `mcp/gateway.js` 的**方法体** | 宿主服务层逻辑（去 Typert 壳） | 2–3 人日 |
| — | `client.js` / `wire.js` / `codec.js` | **不移植** | 0 |

---

## 1. 规模、交付形态与依赖

### 1.1 交付物

| 项 | 事实 | 证据 |
|---|---|---|
| 版本 | 2.3.7（GitHub Release 最新为 `v2.3.7`，2026-11-04；本机安装一致） | `RP/package.json:3`；GitHub releases API |
| 包内容 | 只有 `lib/`（预构建 JS）、`assets/`、README、LICENSE、`cordis.patch.yml`；**无 `src`、无测试** | `RP/package.json:69-75` |
| 源码 | GitHub `main` 有 `src/*.ts`（与 lib 同名）、`test/*.mjs`（24 个测试 + 2 fixture）、`docs/adr/*.md`（7 份 ADR）；`lib/*.js` 与源码一起提交 | GitHub API（附录 C） |
| 许可证 | MIT，`Copyright (c) 2026 dsh-skill-viewer contributors` | `RP/LICENSE:1-3` |
| 安装形态 | `main: lib/index.js`，`exports["./client"] = lib/client.js`；`dsh.client.platform = "web"`，注入 4 个 web 客户端包；`dsh.bundle.patch = ./cordis.patch.yml` | `RP/package.json:21-41` |

### 1.2 体积（实测）

| 部分 | 行数 | 字节 | 占比 | 说明 |
|---|---:|---:|---:|---|
| 宿主侧 `lib/`（除 client.js） | 7,037 | 335,297 | 48% | 可在 Node 直接跑 |
| 浏览器束 `lib/client.js` | 4,804 | 357,613 | 52% | `window.__ModuleLoader__` + React |
| **合计** | **11,841** | **692,910** | 100% | 另有 README 中文 299 行 / 英文 288 行 |

`client.js` 头 8 行即证明它是 web 专属：`window.__ModuleLoader__.load(...)`，只能 `require("react")` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`，见 `RP/lib/client.js:1-10`。

### 1.3 运行时依赖

| 依赖 | 声明版本 | 本机解析版本 | 用途 | TUI 版是否需要 |
|---|---|---|---|---|
| `yaml` | `^2.9.0` | 2.9.1 | frontmatter 解析 + patch 文本 node 级编辑 | 需要（核心） |
| `zod` | `^4.4.3` | 4.4.3 | MCP 配置校验 / wire schema | 需要（`mcp/model.js`） |
| `fflate` | `^0.8.3` | 0.8.3 | 解 `.zip` 技能包（`unzipSync`） | 需要（若支持 zip 导入） |
| `@modelcontextprotocol/sdk` | `^1.12.0` | 1.32.2 | 「测试连接」临时 MCP 客户端 | **建议换**（见 §6.2） |
| `chokidar` | `^5.0.0` | 5.0.0 | 嵌套技能提供方的 watcher | 可选（DSH 原生已有 watcher） |
| `@deepseek-ai/dsh-typert-protocol` | `^0.2.0-rc.1 \|\| ^0.2.1-rc.1` | 0.2.1-rc.5 | Typert RPC 基类/编解码 | **不需要**（web 专属） |
| peer `@deepseek-ai/cordis` | `^4.0.1` | 4.1.x（宿主） | cordis 插件运行时 | 需要（TUI 也是 cordis 插件） |
| peer `@deepseek-ai/dsh` | `>=0.2.0-rc.1 <0.3.0-0` | 0.2.2-rc.1 | 宿主版本闸门 | 需要（TUI 同宿主） |

证据：`RP/package.json:44-59`；解析版本来自 `RP/../node_modules/*/package.json` 实读。

---

## 2. 功能地图

### 2.1 技能面板（web 侧）

| 能力 | 前端（client.js） | 宿主/文件逻辑 | 是否 web 专属 | 证据 |
|---|---|---|---|---|
| 列表（按名称搜索、工作区分栏、分组/来源筛选、卡片全文） | 有 | `list` 合并注册表 + 文件扫描；`content` 读全文 | 否（UI 层 web 专属，数据层通用） | `RP/lib/index.js:464-530, 647-682` |
| 热启停 | 开关 | 改磁盘文件名（见 §3.4） | 否 | `RP/lib/index.js:690-732` |
| 删除 + Toast 撤销 | 有 | `deleteSkill` 永久删；撤销是前端用 `addSkill` 回填正文（尽力还原） | 撤销逻辑 web 专属 | `RP/lib/index.js:734-771`；`RP/lib/client.js:1793-1830` |
| 添加（.md / .zip / 文件夹 / 拖放） | 有（浏览器选择/拖放 → base64） | `addSkill`：分类、校验、暂存、落盘、DSH 裁判、回滚 | 否（CLI 走磁盘路径实现同一逻辑） | `RP/lib/index.js:856-1011`；`RP/lib/cli-skill.js:138-267` |
| 批量迁移（多目标、复制/移动） | 有 | `migrate` / `batchMigrate` → `scope.js` | 否 | `RP/lib/index.js:791-843`；`RP/lib/scope.js:132-208` |
| 分组 CRUD + 批量勾选成员 | 有 | `groups.js` 写插件私有 JSON | **仅 web**（CLI 无分组命令，见 §2.3） | `RP/lib/index.js:532-557`；`RP/lib/groups.js:93-125` |
| 显示/隐藏插件自带技能 | 有（浏览器 localStorage，`client.js:1555-1569`） | 宿主只打 `pluginProvided` 标 | 是（纯前端偏好） | `RP/lib/index.js:404-410` |
| 打开技能根目录 | 有 | 宿主 `spawn` 系统文件管理器 | 否（Node 能力，但 TUI 未必需要） | `RP/lib/reveal.js:54-90`；`RP/lib/index.js:641-646` |
| 插件自身更新检查 | 有 | GitHub Releases API 对比版本 | 否（但与 TUI 发布通道无关） | `RP/lib/version.js:31-78`；`RP/lib/index.js:536-542` |

### 2.2 MCP 面板（web 侧）

| 能力 | 前端 | 宿主逻辑 | 是否 web 专属 | 证据 |
|---|---|---|---|---|
| 列表（含 fiber 状态、工具数、patch 错误/外来行提示） | 有 | 解析 profile patch + 读 loader/tools | 否（数据层通用） | `RP/lib/mcp/gateway.js:147-166, 133-146` |
| 新增（Stdio / HTTP 表单） | 有 | 生成 `panel-mcp-<name>` 行，追加进受管块并按 serverName 排序 | 否 | `RP/lib/mcp/gateway.js:173-219`；`RP/lib/mcp/model.js:198-205` |
| 表单编辑（保留未建模字段/手写 id/disabled） | 有 | 就地替换这一条（`replaceMcpEntryWithRow`） | 否 | `RP/lib/mcp/model.js:344-381`；`RP/lib/patch-editor.js:864-881` |
| 原文编辑（读/写这一条的字节） | 有 | `readRaw`/`writeRaw`，限定缩进/位置不变 | 否（TUI 需多行编辑器） | `RP/lib/mcp/gateway.js:249-272`；`RP/lib/patch-editor.js:762-841` |
| 启停 | 有 | 就地翻转 `disabled` 键（无 id 的手写行也支持） | 否 | `RP/lib/patch-editor.js:678-760`；`RP/lib/mcp/gateway.js:230-247` |
| 删除 | 有 | 剪掉这一条跨度；块空时收掉标记 | 否 | `RP/lib/patch-editor.js:886-902` |
| 测试连接 | 有 | 临时起 MCP client，列工具 | 否（CLI 也有 `mcp test`） | `RP/lib/mcp/probe.js:73-110` |
| 单工具禁用（按完整工具名） | 有 | `tool-filter.js` 控制器按 agent 作用域 `tools.restrict` | 否（宿主机制，TUI 可复用） | `RP/lib/tool-filter.js` 全篇 |
| OAuth 登录/轮询/状态/断开 | 有（按钮 + 轮询） | 发现→注册→PKCE→loopback→换令牌→写 Authorization 头 | 否（CLI 的 `mcp oauth` 等价，仅交互方式不同） | `RP/lib/oauth.js`；`RP/lib/mcp/gateway.js:377-501`；`RP/lib/cli-mcp.js:296-371` |
| 把受管块内非 MCP 外来行移出块 | 有 | `evacuateForeignRows` 原地搬家 | 否 | `RP/lib/patch-editor.js:375-422` |
| 重新加载 | 有 | 直接重新 `list()`（HMR 由 DSH 负责） | 否 | `RP/lib/mcp/gateway.js:502-504` |

### 2.3 面板 vs CLI 能力差集（README 的宣称需要修正）

README 第 19、24 行称「面板能做的事命令行都能做，另外多一个跨 profile 升级」。**代码事实并非如此**：

| 只有面板/RPC 有 | 只有 CLI 有 | 证据 |
|---|---|---|
| 分组 CRUD（`saveGroup`/`deleteGroup`） | — | `RP/lib/index.js:188-208`；`RP/lib/cli*.js` 中 grep 无 group 命令 |
| 单工具禁用（`listTools`/`getToolFilter`/`setToolFilter`） | — | `RP/lib/mcp/wire.js:263-292`；`cli-mcp.js` 无 tools/filter 子命令 |
| 打开目录（`openFolder`） | — | `RP/lib/index.js:159-168` |
| MCP 表单保存 `save`（CLI 只能 `raw --set` 改原文） | — | `RP/lib/mcp/wire.js:187-197`；`cli-mcp.js:411-427` |
| 批量迁移到**多个**目标（CLI `migrate` 只有单个 `--to`） | — | `RP/lib/index.js:807-843` vs `cli-skill.js:580-645` |
| 来源筛选、搜索、布局开关、删除撤销、显示插件技能（纯 UI） | — | `client.js` |
| — | `profiles`（跨 profile 安装总览） | `RP/lib/cli.js:40-59` |
| — | `update`（跨 profile 升级，按原安装渠道） | `RP/lib/cli-skill.js:292-300, 324-429` |
| — | `mcp list --ids`（entryId 列表输出） | `RP/lib/cli-mcp.js:389-410` |

> 对 TUI 版的启示：**不要照 README 的文字做能力对齐**，以这张表为准。TUI 版反而应该补齐「CLI 已有、面板因为 RPC 边界没做」的部分（真·撤销删除、本地路径直读、批量多目标）。

---

## 3. 技能子系统

### 3.1 磁盘实体模型与发现根

技能没有中心仓库、没有联接点，实体就是磁盘上的文件/目录；「改作用域」= 真实复制/移动（`RP/lib/scope.js:1-15` 注释 + 代码）。

| 根 | 路径 | 来源标签 | 原生 rank | 面板是否扫描 | 证据 |
|---|---|---|---:|---|---|
| 项目 .dsh | `<projectRoot>/.dsh/skills` | `project-dsh` | 100 | 是 | `RP/lib/skill-files.js:181-184`；`DSH/.../dsh-skill-filesystem/lib/index.js:162-174` |
| 项目 .agents | `<projectRoot>/.agents/skills` | `project-agents` | 200 | 是（README 未提） | 同上 |
| 用户 .dsh | `~/.dsh/skills` | `user-dsh` | 400 | 是 | `RP/lib/skill-files.js:186-187` |
| 用户 .agents | `~/.agents/skills` | `user-agents` | 500 | 是（README 未提） | `RP/lib/skill-files.js:188-189` |
| custom | `customSkillDirs`（原生 `skill-filesystem` 配置） | `custom` | 300 | **面板不扫描**（`buildRoots` 不含 custom）；只有原生发现会读 | `RP/lib/skill-files.js:170-191`；`DSH/.../dsh-skill-filesystem/lib/index.js:176-180` |

> 注：表中「原生 rank」是 DSH 发现所用的数字（越小越近）；插件内部另有一套 `sourceRank`（1/2/3/4，只用于 `winnerEntry` 排序，`RP/lib/skill-files.js:286-294`），两套不要混用。

- **projectRoot 的判定**：向上找最近的 `.git` 祖先，找不到退回 cwd 本身（`RP/lib/skill-files.js:42-52`）。所以「工作区」= git 项目根，会话 cwd 在子目录时仍归属同一工作区。
- **README 修正**：README 只说 `~/.dsh/skills` 与 `<ws>/.dsh/skills`（`README.md:244`），代码实际管理 4 个根。TUI 版若只做 `.dsh` 两个根，需要明确取舍（`.agents` 是 pi/Codex 兼容布局，社区存在）。
- **DSH 原生只发现一层**：`discoverRoot` 只 `listSkillRootEntries(root)` 一次，不递归（`DSH/.../dsh-skill-filesystem/lib/index.js:595-628`）；嵌套技能（`lark-cli/lark-approval/SKILL.md`）只有装了本插件的 `NestedSkillProvider` 才可见（`RP/lib/provider.js:1-11`）。TUI 版是否提供嵌套发现，是产品决策。
- **`.system` 隐藏区**：只有用户 `.dsh` 根带 `skipSystem: true`，原生发现跳过 `.system`（`DSH/.../dsh-skill-filesystem/lib/index.js:185, 599`）。插件把分组/令牌等数据放在 `<dshHome>/skills/.system/skill-viewer/`，因此不会污染技能列表（ADR 也如此声明）。

### 3.2 扫描器：`collectSkillEntries`

- 每个根并行扫描，根内深度优先（`RP/lib/skill-files.js:202-210`）。
- 目录含 `SKILL.md`（或 `SKILL.md.disabled`）＝技能包，**收集后不下钻**（`references/`、`scripts/` 属于载荷）；不含则继续递归当分类目录；单文件 `*.md` **只在根层**收集（`RP/lib/skill-files.js:220-274`）。
- 跳过隐藏目录与 `node_modules/.git/.hg/.svn`，深度上限 8，防符号链接环（`RP/lib/skill-files.js:198-201, 231`）。
- 符号链接目录会被跟随（与原生 `watchFollowSymlinks` 一致），见 `RP/lib/skill-files.js:234-235`；issue #66 曾报告 junction 型技能的启停问题（已关闭）。
- 条目字段：`name/description/whenToUse/enabled/kind(bundle|flat)/file/dirBundle/source/projectRoot/rel/modelInvocable/userInvocable`（`RP/lib/skill-files.js:244-271`）。
- 停用条目也会被列出（管理需要），名字取 frontmatter，取不到退文件名/目录名（`RP/lib/skill-files.js:245-270`）。

### 3.3 frontmatter：宽松读取 vs 严格校验

- 宽松解析 `parseFrontmatter`（列表/扫描用）：正则抽 `name`/`description`/`whenToUse` + 布尔字段，`name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（`RP/lib/skill-files.js:23, 57-102`）。
- 严格校验 `validateFrontmatter`（导入新技能用）：必须 `---` 开头闭合、YAML 可解析为映射、`name`+`description` 必填、拒绝旧字段 `disableModelInvocation/modelInvocable/userInvocable`、`metadata` 必须是对象（`RP/lib/skill-files.js:115-161`）。目的：**DSH 会拒绝的内容绝不写盘**（注释 103-114）。
- 换行归一：CRLF/CR → LF 后再解析，避免 yaml 报「Unexpected scalar at node end」（`RP/lib/skill-files.js:28-30`）。

### 3.4 启停 = 改文件名（没有 `disabled` 元数据）

| 形态 | 启用时 | 停用 | 证据 |
|---|---|---|---|
| 目录束 | `<root>/<name>/SKILL.md` | `<root>/<name>/SKILL.md.disabled` | `RP/lib/skill-files.js:21, 236-242`；`RP/lib/index.js:690-698` |
| 单文件 | `<root>/<name>.md` | `<root>/<name>.md.disabled` | `RP/lib/skill-files.js:263-271` |

- 启停前检查目标是否已存在，已存在则报错，不做覆盖（`RP/lib/index.js:694-696`）。
- 热生效依赖 DSH 的原生 watcher，不需要插件自己通知宿主（`RP/lib/index.js:29-30` 注释；DSH 文件监听见 `03` 文档）。
- bundled（随部署附带）技能只读：`assertEditable` 对 `source === "bundled"` 直接抛错（`RP/lib/index.js:683-688`）；`content/setEnabled/delete/migrate` 都走这条门。
- **TUI 版注意**：改名机制对「同一技能多 profile、多会话」天然全局生效，没有 per-session 开关；若要「只对本会话禁用」需要另做机制（DSH 无此 API，见 ADR-0004 的结论）。

### 3.5 添加技能：一个选择范围 + 一个分类器

流程（宿主版 `index.js:856-1011`；与 CLI `cli-skill.js:138-267` 同构）：

1. **输入归一**：浏览器传 `{path, base64}[]`，先 `normalizeImportPath`（反斜杠→斜杠、去 `./`、去尾 `/`），顶层 `.zip` 用 `unzipSync` 展开（`RP/lib/skill-import.js:141-165`）。
2. **护栏**：最多 200 个文件、解压后总大小 ≤ 8MB、拒绝绝对路径与 `..`/`.` 段（`RP/lib/index.js:859-880`）。
3. **分类**（`classifySkillImport`，`RP/lib/skill-import.js:111-129`）：
   - 选择范围**本身**直接含 `SKILL.md` ⇒ 整个选择是一个技能包（内部不拆，`references/`、顶层依赖 `.md` 都算载荷）；
   - 否则遍历：含 `SKILL.md` 的目录是技能包且不下钻；不含则递归（深度上限同上）；根层散装 `.md` 是单文件技能；
   - 找到的技能一律**拍平到目标技能根第一层**（原生 DSH 只认一层，卸载插件后仍可见；ADR-0001）。
4. **冲突判定收窄到目标作用域**：同作用域同名硬跳过；跨作用域同名只回一条 `warnings`（ADR-0002；`RP/lib/index.js:899-946`）。同批次内重名、plannedTargets 撞路径也跳过（`:931-957`）。
5. **落盘**：在目标根下建 `.dsh-skill-staging-<pid>-<rand>`，每个技能先写暂存目录再 `rename` 就位；单条失败只回滚该条（`RP/lib/index.js:970-995`；CLI 版 `:231-263`）。
6. **DSH 做最终裁判**：`waitForDiscovery` 每 500ms 轮询注册表，最多 12 次（6 秒）；没有被注册表接收的单独回滚并回报（`RP/lib/index.js:997-1035`）。注册表不可用时视为已接收。
7. 全部失败才整体抛错；部分成功返回 `added/skipped/warnings`。

**文件写入细节**：`.md` 文件去 BOM、CRLF→LF 后写；非 `.md` 载荷按字节复制（`RP/lib/index.js:300-303, 977-981`；CLI 同 `:135-137`）。

**CLI 与面板的差异**：CLI 没有「DSH 裁判」这一步（离线运行），只做 frontmatter 校验 + 落盘（`RP/lib/cli-skill.js:229-266`）。

### 3.6 迁移：真实复制/移动，先校验后落盘，失败回滚

`migrateEntry(entry, targetRoot, mode)`（`RP/lib/scope.js:132-186`）：

1. 校验阶段（未写任何东西）：源=目标空操作、目标已存在、源不存在（`:135-141`）。
2. 目标根 `mkdir -p`。
3. `move` 快路径：同卷 `rename` 原子完成（`:144-153`）。
4. 跨卷/被占用（`EXDEV/EBUSY/EPERM/EACCES`）：在目标根内建 `.dsh-skill-staging-*`，复制后 `rename` 就位；失败清暂存（`:156-173`）。
5. `move` 最后删源；源删不掉则**回滚刚写好的目标副本**，保证不会出现两份（`:175-184`）。
6. 批量：每条独立，一条失败不影响其余（`batchMigrateEntries`，`:196-208`）。

**作用域规则**：目标根只有两种——全局 `<dshHome>/skills` 或 `<project>/.dsh/skills`（`scope.js:21-31`）。即**迁移不会写 `.agents/skills`**（虽然源可以是 `.agents`）。工作区路径必须先存在且解析到 git 根（`normalizeWorkspaces`，`:38-56`）。

**已知缺口【已验证事实】**：`migrateEntry` 只校验目标**路径**冲突，不校验目标作用域内「同名但不同路径」的技能（例如目标根已有 `foo/SKILL.md`，把另一个 frontmatter name 为 `foo` 的单文件 `bar.md` 迁进去不会报错）。添加路径有作用域同名检查（`index.js:935-939`），迁移没有。后果是同作用域出现被遮蔽的重名实体，而面板列表按（name, scope）去重只显示一条。TUI 版建议补上「目标作用域同名检查」。

**停用状态保留**：目录束连目录一起复制/移动（含 `SKILL.md.disabled`），单文件按原文件名复制（含 `.md.disabled`），迁移后仍停用（代码推导：`scope.js:133-134, 158-168`）。【推断：未跑实测】

### 3.7 删除与「撤销」

- 目录束删整个目录（`rm -rf`），单文件删文件；bundled 拒绝（`RP/lib/index.js:734-771`）。
- **web 的「撤销删除」是尽力还原**：RPC 边界只给了 `deleteSkill`/`addSkill`，`content` 只回 `SKILL.md` 正文，没有「读技能目录任意文件」的接口。所以前端删除前抓正文，撤销时用 `addSkill` 按原 `rel` 回填：只含 `SKILL.md` 的技能能完整回来，带 `scripts/`/资源目录的只能拿回 `SKILL.md`（`RP/lib/client.js:93, 1793-1830`；`docs/pending-decisions.md` C4）。
- **TUI 版可以直接做成真撤销**：同进程可先把实体 `rename` 到 `.dsh-skill-trash/<timestamp>/` 再延时清理，或删除前快照整个目录；不依赖 RPC 边界。这是 TUI 相对 web 的结构性优势。

### 3.8 分组：只写插件自己的显示配置

- 文件：`<dshHome>/skills/.system/skill-viewer/groups.json`（`RP/lib/groups.js:24-30`）。
- 格式（version 1）：

```json
{ "version": 1,
  "groups": {
    "<groupId>": {
      "name": "分组名",
      "scopes": { "global": ["skillA"], "<工作区项目根绝对路径>": ["skillB"] }
    } } }
```

- 成员以（作用域, 技能名）二元组计：同名技能可同时存在于全局与某工作区，各自独立归属（`groups.js:9-17` 注释）。
- 原子写：临时文件 + `rename`（`groups.js:61-67`）；文件损坏/缺失一律当空配置（`groups.js:35-59`）。
- 校验：分组名不能空，忽略大小写不可重名；`names: []` 时删掉该 scope 键（新建空组会「消失」，前端 C7 又做了空组可见）（`groups.js:93-113`）。
- **绝不改技能目录**（`groups.js:2-3` 注释），删除分组也不动技能（`:118-125`）。
- groupId 生成 `g-<random>`，不可预测但稳定（`:102`）。
- 只有 web 面板有分组命令；TUI 版若做分组 UI/命令，直接复用该模块即可。

### 3.9 列表合并逻辑（web 版 `list`）

- 同时取三份：全部管理根的工作区枚举（3 秒 TTL 缓存，`index.js:319-336`）、会话注册表 `registry.list({cwd, scope})`、分组配置（`index.js:464-474`）。
- 注册表行：过滤掉「路径属于已知工作区文件根」的项（那些由下面文件扫描兜底），其余作为 global 技能，`enabled: true`（`index.js:486-507`）。
- 文件扫描行：按（name, scopePath）去重，`scope` 标 global/workspace（含工作区 title），`groups` 回填（`index.js:509-528`）。
- **小问题【已验证事实】**：文件扫描行硬编码 `modelInvocable: false, userInvocable: false`（`index.js:521-522`），但扫描器其实解析出了真实值（`skill-files.js:255-256`）。`client.js` 目前不消费这两个字段（grep 无命中），所以只是 wire 层冗余/错误数据；TUI 版直接 `entry.modelInvocable`。
- **插件自带技能判定**：注册表技能的 `path` 不在任何管理根内 ⇒ `pluginProvided: true`；嵌套 provider 的技能恒为 false（`index.js:404-410`）。前端据此显示/隐藏，开关状态存浏览器 localStorage（`client.js:1555-1569`；`index.js` 不保存该偏好）。

### 3.10 嵌套技能提供方（`provider.js`，可选移植）

- 目的：官方 `dsh-skill-filesystem` 只发现一层，本提供方把深度 ≥2 的嵌套技能 `registerProvider` 进 `ctx.skills`（`provider.js:1-11`）。
- 只上报 `rel` 含 `/` 的条目（第一层归官方扁平加载器，避免重复注册），rank 300（`provider.js:18-21, 55-78`）。
- 用 chokidar 递归 watch 用户级两个根（`~/.agents/skills`、`~/.dsh/skills`），变更 120ms 去抖后 `control.invalidate()`（`provider.js:27-54`）；项目根随 `list({cwd})` 动态扫描（`:97-106`）。
- 注册入口：`ctx.skills.registerProvider((control) => new NestedSkillProvider(...))`（`index.js:1069`）。
- **对 TUI 版**：若产品接受「只管理一层」，可以不做；若要做，依赖 chokidar 5（与 DSH 自带 chokidar 版本可能不同，注意去重）。DSH 原生 watcher 已经会热感知文件变化，TUI 版自己再监听会重复，建议复用宿主 `skills` 服务的 change 事件而非再起 watcher。

---

## 4. MCP 子系统（本插件技术含量最高的部分）

### 4.1 数据位置与 patch 层语义

- MCP 服务器全部写在 **profile 的 `cordis.patch.yml`** 里，每台服务器一行 `name: @deepseek-ai/dsh-mcp-client`；真正连接/注册工具的是官方 `@deepseek-ai/dsh-mcp-client`（README.md:249-253；`RP/lib/patch-editor.js:18`）。
- **范围限定【已验证事实】**：本插件只读写 **profile 层** patch（`gateway.patchPath()` / CLI `profilePatchPath()`），**不管理 home 层 `~/.dsh/cordis.patch.yml`**。而 DSH 的 patch 组合顺序是 bundle → profile → home → overlay（见 01/03 文档），home 层同样可以放 MCP 行——TUI 版要明确是否覆盖 home 层（参考插件不支持）。
- `cordis.patch.yml` 是 patch 层：**顶层条目 = 按 id 定向覆盖（override），`insert:` 成员 = 追加插件**。两种语义不同，整块重写会把 override 变成 append，导致同一 loader id 两行、`composeLayers` 判 duplicate 并回滚整个 dsh-market 更新链（ADR-0003 背景，真实事故）。
- 本机 web profile 的 patch 当前**没有**任何 MCP 行/受管块（`grep dsh-mcp-client /home/wqwt/.dsh/profiles/web/cordis.patch.yml` 无命中）；也就是说本机打开面板时 MCP 页是空的，第一次新增才会在文件末尾生成受管块。这是本次调研的实测状态。

### 4.2 patch 路径怎么定位

| 环境 | 算法 | 证据 |
|---|---|---|
| web 宿主（同进程） | `ctx.baseUrl` 是 profile 根 `cordis.yml` 的 file URL；取其目录 + `cordis.patch.yml`。`baseUrl` 的锚点语义由 DSH profile 启动代码保证 | `RP/lib/mcp/gateway.js:66-80`；`DSH/lib/profile-boot-e2mS45fC.js:208-210`；`DSH/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1327` |
| fallback | 从包位置 `resolve(packageDir, "../..")` 推回 profile 目录（包不在 profile 的 node_modules 下时会错，但正常安装成立） | `RP/lib/mcp/gateway.js:78-79` |
| CLI | `$DSH_HOME/profiles/<name>/cordis.patch.yml`（profile 名必须已存在） | `RP/lib/cli-mcp.js:23-25, 279-295` |

- **TUI 版【推断】**：TUI 也是 profile 内插件，`ctx.baseUrl` 同样锚定 profile 目录，因此 patch 路径算法可以直接复用；不需要 Typert。
- **风险**：`patchPath()` 假定「插件一定装在 profile 目录下、且 patch 文件在 profile 根」。如果未来 DSH 改变 profile 布局，这里会静默指向错误文件；建议 TUI 版加存在性校验/显式配置项。

### 4.3 文本编辑器：`patch-editor.js`（902 行，最值得整份移植）

核心不变量：**只替换目标 entry 的字节跨度，文件其余部分逐字节保留；单条 MCP 行的改动绝不重排其它行。**

| 能力 | 函数 | 关键行为 | 证据 |
|---|---|---|---|
| 读 patch 文件 | `readPatchFile` | 缺失/失败带路径报错 | `:58-65` |
| 整份校验 | `assertPatchText`/`validatePatchText` | 可解析且顶层是数组；只校验不写回 | `:67-79` |
| 受管块读取 | `readManagedBlock` | 返回 `{managed, foreign:{top, insert, entries}}`；标记不成对直接抛错 | `:164-217` |
| 受管行提取 | `extractManagedRows` | 仅面板自己的行（兼容旧 API） | `:219-221` |
| 全部 MCP 行 | `listMcpPatchRows` | 拍平整份文档（顶层 + `insert` 成员），过滤 `name === @deepseek-ai/dsh-mcp-client` | `:223-231` |
| 生成受管块 | `generateManagedBlock` | 外来顶层 → 外来 insert → 面板 `insert` 列表；外来部分逐字节搬运 | `:238-251` |
| 替换受管块 | `replaceManagedBlock` | 标记外字节不动；空块收掉；空文件/`[]` 模板补 `[]` | `:275-308` |
| 原子写 | `writeFileAtomic` | 同目录临时文件 + `rename`；Windows 上 `EPERM/EEXIST/EACCES` 退化 rm+rename | `:310-327` |
| 写锁 | `withPatchLock` | `<patch>.panel.lock`，`wx` 建锁；>30s 视为陈旧自动清；获取超时 5s | `:332-364` |
| 移出外来行 | `evacuateForeignRows` / `writeEvacuatedForeign` | 只搬受管块内**顶层**外来行到 begin 之前；`insert` 成员不搬（语义会变） | `:375-422` |
| 定位一条 | `findMcpEntry` | 同时给 id+serverName 时按「都对上」匹配；缺一个退回单键；命中多条报错 | `:576-598` |
| 重复检查 | `assertNoNewDuplicates` | 只拒绝**新增**重复的 id / serverName；文件原有重名允许保存 | `:599-629` |
| 启停翻转 | `setEntryDisabledInText` / `setEntryDisabled` | 见 §4.5 | `:678-760` |
| 读一条原文 | `readMcpEntryText` | 返回含 `- `、缩进、行尾换行的完整片段 | `:762-766` |
| 写一条原文 | `replaceMcpEntryTextInText` | 校验仍是 MCP 行、条数不变、position/indent/inInsert 不变、不新增重名 | `:798-832` |
| 表单保存 | `replaceMcpEntryWithRowInText` | 用结构化行替换，保持该条缩进与文件 EOL；不新增重名 | `:864-881` |
| 删除一条 | `removeMcpEntryInText` | insert 只剩它时连 `- insert:` 一起删；受管块空则收标记；文件只剩注释补 `[]` | `:886-902` |

几个容易踩的实现细节：

- **不能用 `node.range[2]` 当条目结尾**：yaml 把条目后的注释算进节点尾随范围，用它替换/删除会吞掉「下一条的说明注释」。所以有 `nodeContentEndOf` 递归求最后一个标量/子节点的末尾（`:478-510`）。
- **受管块内每个字节要有归属**：`blockItemSpans` 把整块按「下一条目行首」切段、首尾相接铺满，外来部分才能逐字节搬运（`:135-149`）。
- **CRLF**：新插入/重写的行跟随原文件 EOL（`eolOf`，`:520-523`）；原文编辑时把提交文本整体换成文件 EOL（`:806-807`）。
- **空块/只剩注释**：删完最后一行 MCP 后必须保证 patch 仍是合法顶层数组，否则 DSH 下次启动失败（`:289-294, 654-666`）。
- **受管块标记失配**（只有 begin 或只有 end）：`readManagedBlock` 刻意抛错而不猜意图（`:169-170`）；`list()` 会捕获并把错误放到 `patch.error` 给 UI（`gateway.js:147-166`），但 **save/remove/setEnabled 等直接抛**，于是现象是「MCP 页整页不可用」。issue #47 由维护者于 2026-10-22 关闭（state_reason=completed），然而 **2.3.7 与 GitHub `main` 的代码里都没有「修复受管块」的自动路径**（grep 无 `bak-`/修复/repair；只有两处 `标记不完整` 抛错），发生时仍只能手改文件。TUI 版建议补「检测到标记损坏 → 备份 + 一键修复」。

### 4.4 受管块：它现在只管「面板新建的行」

- 标记常量：`# >>> dsh-skill-mcp-panel:mcp:begin` / `# <<< dsh-skill-mcp-panel:mcp:end`（`:16-17`）。
- ADR-0006 之后，**所有** `@deepseek-ai/dsh-mcp-client` 行（块内块外、有无 `panel-mcp-*` id）都能启停/编辑/删除；受管块只剩两个职责：①面板**新增**行的落点；②非 MCP 外来行的字节保真边界。
- 受管块里「不属于面板的行」= 非 `panel-mcp-` id 的顶层条目 / 混有非面板成员的 `insert:` 条目，统一作为 `foreign` 原样保留并在 UI 提示（`:187-216`，ADR-0003）。
- 新行追加逻辑：读现有受管行 + 新行 → 按 `config.serverName` 排序 → `writeManagedRows`（`gateway.js:203-208`）；CLI 同样排序（`cli-mcp.js:382`）。
- 文件是空模板 `[]` 时，直接把 `[]` 替换成块，否则会变成 `[] - insert` 非法结构（`:296-305`）。

### 4.5 `enabled`/`disabled` 语义与 `!!js`

`disabled` 是 loader 行级字段，值为 `true` 时该插件不装载；缺省/false = 启用。

| 输入 | 视图 | 启停操作 | 依据 |
|---|---|---|---|
| 无 `disabled` 键 | 启用 | 停用：在这一条最后一个键之后按同缩进插入 `disabled: true` | `patch-editor.js:713-726` |
| `disabled: false` | 启用 | 停用：原位把 `false` 改成 `true` | `:707-712` |
| `disabled: true` | 停用 | 启用：独占一行则整行删；与别的内容同行则原位改 `false` | `:727-745` |
| `disabled: "true"` / `1` 等手写标量 | **按停用展示**，但绝不改写 | 表单保存原样保留；开关按钮可能改成 true/false 之外的语义，谨慎 | `mcp/model.js:232-241` |
| `disabled: !!js <expr>` | 按停用展示 + `disabledExpr` | **拒绝代写**，提示用原文编辑；等待 loader 时不做布尔轮询 | `patch-editor.js:695-703`；`gateway.js:35-43, 199-200` |

- 没有 `id` 的手写行也能开关：插入位置按这一条自己的缩进算（`:713-726`），不补 id（ADR-0006）。
- `rowEnabled` 的判据是 `value === undefined || value === false`（`mcp/model.js:238-241`）；`!!js` 由宿主求值，面板不知道结果，所以展示为停用但显示真实工具数（`gateway.js:143-145`）。
- 表单保存不会弄丢 `disabled`：`applyServerEdit` 显式保留 `previous.disabled`（`model.js:357-360`）。

### 4.6 表单通道 vs 原文通道

**表单通道**（`mcp/model.js` + `replaceMcpEntryWithRow`）：

- 输入 schema：Stdio `{serverName, transport:"stdio", command, args[], env, cwd, toolCallTimeoutMs, failOnStartupError, reconnect}`；HTTP `{serverName, transport:"streamable-http", url, headers, ...}`（`model.js:92-112`）。
- `${NAME}` 直觉写法 ↔ `!!js`：值里出现 `${NAME}` 自动写成 `` !!js `${process.env.NAME}` ``；以 `!!js ` 开头的值原样透传；读回时再还原成 `${NAME}`（`model.js:29-72`）。这是为了兼容 DSH 唯一的环境变量机制（YAML `!!js` 表达式）。
- `env`/`headers` 编辑语义：`string` = 覆盖、`null` = 删除该 key、**不出现 = 保留旧值**（`mergeSecretPatch`，`model.js:154-163`）；列表视图只回 key 名，不回值（脱敏，`patchRowToView`，`:243-273`）。
- 表单保存只重写这一条，并保留：未建模的 config 键（如 `maxInstructionBytes`）、顶层额外键、手写 id（不是 `panel-mcp-<旧名>` 时保持）、已有 `disabled`（`applyServerEdit`，`:344-381`）。
- 保存会重排**这一条**的键序（未知键留在 config 末尾）；要逐字节保真必须用原文通道（ADR-0006 后果）。

**原文通道**（`readRaw`/`writeRaw`）：

- 读出这一条的完整 YAML 片段（含 `- ` 与缩进），交给用户编辑（`readMcpEntryText`，`:762-766`）。
- 写回限制：仍须是一条 `@deepseek-ai/dsh-mcp-client` 行；文件里 MCP 行数量不能变；**缩进与所在列表不能变**（受管块 `insert` 成员不能改成顶层条目，否则 append 变 override）；不能新增重复 id/serverName；id 可省略但写了就必须非空；写回后必须还能按 id/serverName 定位到（`:768-832`）。
- 原文写回时整条按用户提交内容替换，因此这一条自己的注释/键序会按提交内容变化（ADR-0006 后果）。

### 4.7 行身份：`serverName` + `entryId` 双键

- 面板/网关/CLI 统一 `resolveRow(rows, {serverName, entryId})`：两个都给时按「都对上」匹配；命中 1 条即用；命中多条报「不唯一」；缺一个字段时退回单键匹配，单键命中多条也报错（`gateway.js:100-128`；CLI 同构 `cli-mcp.js:42-70`）。
- `serverName` 取值顺序：非空 `config.serverName` 优先，否则用 `panel-mcp-<name>` id 后缀（`model.js:147-152`）。
- 新增时只拒绝**新增**重复 id / serverName（`gateway.js:189-208`）；编辑同名（没改名）允许保存（`:194-197`）；原文写回前用 `assertNoNewDuplicates` 对比前后（`patch-editor.js:618-629`）。
- 文件里本来就有重名时：面板不拒绝保存，卡片带 `entryId`，CLI 用 `--id`/`list --ids` 逐条改（README.md:212-215；ADR-0006）。
- **TUI 版必须继承**：只要做「按名字操作 MCP」，就必须同时暴露 entryId，否则重名配置会操作错行。

### 4.8 HMR 热加载路径

1. 插件写 `cordis.patch.yml`（原子写 + 锁）。
2. DSH `dsh-hmr` 监听 profile 的 patch 文件与 home 级 patch 文件（`DSH/.../dsh-hmr/lib/index.js:850-872`），变更后走 `watchConfig` 的串行队列重新组合 profile（`:767-785`）。
3. loader 根据新配置启用/停用/替换对应 entry；`@deepseek-ai/dsh-mcp-client` 真正连服务器、注册工具（README.md:249-251）。
4. 插件侧可选地等待 loader 状态：`waitForLoaderState(ctx, id, predicate, 3000ms/200ms)` 轮询 `ctx.loader.entries()` 找到 entry（`mcp/status.js:47-58`）；`!!js disabled` 不等（`gateway.js:35-43`）。
5. 工具数：`ctx.tools.schemas()` 里以 `mcp__<serverName>__` 为前缀的条数（`mcp/status.js:34-41`）；工具清单：`ctx.tools.view(undefined).knownNames`（`gateway.js:287-304`）。

【已验证事实】patch 写入本身不会重启网关；实测本机 web profile 的 `patchReload` 字段为 `live`（`/home/wqwt/.dsh/profiles/web/package.json:26`），但 HMR 行为直接由 dsh-hmr 实现决定，不依赖该字段。
【未验证】本机没有实际新增过 MCP 行，未做「写入→HMR→工具出现」的端到端观测。

### 4.9 单工具禁用（`tool-filter.js`）

- 目标：MCP 服务器一挂几十个工具，全部 schema 注入上下文太大；按**完整公开工具名** `mcp__<serverName>__<原始名>` 禁用一部分（`tool-filter.js:1-36`）。
- 机制：`ctx.tools.restrict({ deny })` 只接受 **scoped ctx**；全局 ctx 调用会被宿主拒绝。可行路径是监听 `agent/created`，在该 agent 的作用域下挂一个声明 `inject:["tools"]` 的微型插件，由它调用 `restrict`；被禁工具会从模型可见 schema 里**消失**（真省上下文，不是调用时才拒），agent 销毁时限制自动解绑（`tool-filter.js:109-125`）。
- 配置：`<dshHome>/skills/.system/skill-viewer/tool-filter.json`，格式 `{version:1, deny:[...]}`，只记完整工具名；名字对不上就不生效（刻意不猜）（`:32-45, 50-76`）。
- 触发：控制器统一监听 `tools/change` 并对每个 agent `sync()`；每轮只在「实际可用禁用集合签名变化」时才 undo+restrict（`:232-249, 145-225`）。
- **历史大坑（必须继承的教训）**：宿主 `ScopedLayers.effect()` 在施加限制后**和撤销时**都会同步 `ctx.emit("tools/change")`；旧实现既监听又在回调里 undo/restrict，形成同步无限递归，`RangeError` 被空 catch 吞掉，表现为进程不崩但主线程 100% 烧 CPU（一次事件放大成 887 次 restrict / 458 层递归）。修复三件套：重入守卫 `syncing`、集合签名不变化不重施、监听器归控制器统一持有 + 所有 catch 接 logger（`tool-filter.js:18-30, 130-138`；README.md:273）。
- 限制：目前是**全局一份禁用列表**，按 agent 施加；没有「按预设差异化」（ADR-0004 决策；`docs/pending-decisions.md` A2）。
- **TUI 版**：宿主服务相同，理论上可直接照搬控制器。但 TUI 本身就在宿主线程里，任何同步递归同样会卡死整个 TUI，这条守卫必须原样保留。

### 4.10 OAuth（`oauth.js`）

- 宿主事实：`@deepseek-ai/dsh-mcp-client` 没有 OAuth 字段，只有静态 `headers`；所以只能面板自己拿令牌，再把 `Authorization: Bearer ...` 写进那一行（`oauth.js:1-24`；ADR-0005）。
- 发现顺序（RFC 9728 路径 PRM → 根 PRM → RFC 8414 插入式 → 根 AS → OIDC 插入式 → 根 OIDC → 旧行为）：带路径的端点最多 8 个候选，只有 origin 时 3 个；命中 PRM 后再按 `authorization_servers[]` 二次发现，PRM 驱动的 issuer 必须精确匹配（只忽略尾斜杠）；PRM 的 `resource` 只在同源时采用（`oauth.js:109-205, 248-381`；ADR-0007）。
- 流程：动态客户端注册（RFC 7591；无端点时复用上次 client_id 或用户指定）→ 授权码 + PKCE(S256) + RFC 8707 `resource` → 本进程监听 `127.0.0.1:<随机端口>/callback` 收回调 → 换令牌 → 记 `expiresAt`/refresh_token（`oauth.js:399-445, 451-540`）。
- 存储：`<dshHome>/skills/.system/skill-viewer/oauth.json`（按 serverName 索引）；写进 patch 的是**字面量** Bearer 头（明文，README/ADR 明确提示）（`oauth.js:20-33, 48-64`）。
- web 面板流程：`oauthStart` 返回 `authUrl`（前端打开浏览器）+ `flowId`；前端轮询 `oauthPoll`；成功换令牌后写 header 并等 loader；`oauthStatus` 看是否过期；`oauthDisconnect` 删 header + 本地记录（`mcp/gateway.js:377-501`）。CLI 是同步阻塞版（`cli-mcp.js:296-371`）。
- **已知缺口【已验证事实】**：`refreshTokens()` 在 `oauth.js:542-556` 已实现并导出，但**发布代码里没有任何调用点**（grep 仅 oauth.js 自身）；过期只由 `isExpired` 展示（`gateway.js:489`）。issue #80 正是「令牌到期后不会自动刷新，连接直接失效」（open）。TUI 版若做 OAuth，必须补刷新调度，或在 UI 明示「过期需重新登录」。
- **TUI 交互差异**：web 用浏览器打开授权 URL；TUI 只能打印/复制 URL 让用户手动打开，或在终端里调系统 opener（`cli-mcp.js:346-355` 已有跨平台 opener 逻辑可参考）。回调仍是 127.0.0.1，不受影响。

### 4.11 测试连接（`mcp/probe.js`）

- 临时起一次 MCP client（stdio 或 streamable-http），列工具后立刻关闭；不写 patch、不注册工具（`probe.js:1-5, 73-110`）。
- 支持 `!!js` 求值：`new Function("ctx","expr","with (ctx) { return eval(expr) }")`，与宿主 cordis 配置层同语义；空 ctx，只能拿全局（`process.env` 等）（`:13-43`）。
- stdio 子进程环境用 `scrubbedParentEnv()`：剔除名字含 KEY/PASSWORD/SECRET/TOKEN 及 `DSH_*` 的变量（`host-paths.js:38-54`），再叠用户显式 env。
- 超时 15s；错误回中文可读原因（`:12, 102-105`）。
- **依赖风险**：用 `@modelcontextprotocol/sdk` 1.x（实际装 1.32.2），它拖 express/hono/jose/cors/ajv… 一大串；而 DSH 0.2.2 的官方 mcp-client 用的是 `@modelcontextprotocol/client@2.2.0`（`DSH/node_modules/@deepseek-ai/dsh-mcp-client/package.json`）。TUI 版建议复用宿主已有的 MCP 客户端依赖，或只做最小 JSON-RPC 探针，避免再引入一个 SDK 全家桶。

### 4.12 错误处理策略（值得学）

- **网关边界 schema 故意放宽**：wire 的 `payload` 用 `z.unknown()`，把严格校验下沉到 handler，否则宿主只会回泛化的 `gateway/input-invalid: ... failed boundary validation`，zod 的字段说明到不了前端（`mcp/wire.js:7-16`）。
- handler 内 `parseWirePayload` + `describeSchemaError` 生成「字段：原因」中文错误（`gateway.js:44-54`；`model.js:121-131`）。
- 静默 catch 是历史事故源头（tool-filter 卡死无日志），现在关键路径都接 logger（`tool-filter.js:83-108`）。TUI 版应沿用「不吞异常 + 可读中文错误」。

---

## 5. 复用清单（按模块）

> 复用等级：**A** = 可直接复用（纯 Node/fs/YAML/zod，无 web/宿主服务耦合，可原样 import）；**B** = 需改造（逻辑可用，但壳/依赖 web 或宿主服务）；**C** = 不可复用（web UI / RPC 专属）。

### 5.1 A 级：可直接复用

| 模块 | 行数 | 依赖 | 关键函数 | 证据/备注 |
|---|---:|---|---|---|
| `lib/patch-editor.js` | 902 | node:fs、yaml | §4.3 全表 | **最高价值**；建议整份复制，保留所有不变量与测试 |
| `lib/skill-files.js` | 294 | node:fs、yaml | `buildRoots`、`collectSkillEntries`、`parseFrontmatter`、`validateFrontmatter`、`findProjectRoot`、`winnerEntry`、`sourceRank` | §3.1-3.3 |
| `lib/skill-import.js` | 165 | fflate、skill-files | `classifySkillImport`、`expandTopLevelZips`、`describeSkips` | 只做结构判定，不读内容；面板与 CLI 共用 |
| `lib/scope.js` | 208 | node:fs（引 skill-files） | `workspaceSkillRoot`、`scopeRootOf`、`normalizeWorkspaces`、`workspaceTitleMap`、`migrateEntry`、`batchMigrateEntries` | 迁移引擎；注意目标只有 `.dsh` 根 |
| `lib/groups.js` | 125 | node:fs | `loadGroups`、`saveGroups`、`groupsForSkill`、`upsertGroup`、`deleteGroup` | 分组私有配置 |
| `lib/mcp/model.js` | 381 | zod、patch-editor | `parseWireScalar`/`formatWireScalar`、`toOfficialConfig`、`toPatchRow`、`patchRowToView`、`inputFromPatchRow`、`applyServerEdit`、`rowEnabled` | 表单 ↔ patch 行 |
| `lib/oauth.js` | 578 | node:http/crypto/fetch | `discoverMetadataDetailed`、`discoveryCandidates`、`createPkce`、`registerClient`、`buildAuthorizationUrl`、`startLoopbackServer`、`exchangeCode`、`refreshTokens`、`isExpired` | 刷新未接线，见 §4.10 |
| `lib/mcp/probe.js` | 125 | @modelcontextprotocol/sdk | `probeMcpServer` | 建议换掉 SDK 依赖，逻辑保留 |
| `lib/host-paths.js` | 55 | node:os/path | `resolveDshHome`、`scrubbedParentEnv` | 内联自 `dsh-home-paths`/`dsh-subprocess`，零 peer 链（注释 1-13） |
| `lib/profiles.js` | 128 | node:fs | `listProfiles`、`requireProfile`、`isValidProfileName`、`electronBlockedMessage` | CLI/profile 枚举；TUI 若做 profile 选择可复用 |
| `lib/version.js` | 97 | node:fetch | `fetchUpdateCheck`、`compareVersions` | 参考用；TUI 更新走 plugin manager，非必需 |
| `lib/reveal.js` | 91 | node:child_process | `revealInFileManager`、`nativePath` | TUI 若是纯终端，可能不需要；保留作"在文件管理器打开"命令 |
| `lib/mcp/status.js` | 58 | 宿主 ctx | `fiberPhaseOf`、`getLoaderEntry`、`mcpToolCount`、`waitForLoaderState` | **A/B 边界**：只读 `ctx.loader`/`ctx.tools`，服务存在就能用 |
| `lib/codec.js` | 18 | 无 | `strictCodec` | **C 类**（列此仅为完整性，见 §5.3） |

### 5.2 B 级：需改造

| 模块 | 行数 | 改造点 | 建议 |
|---|---:|---|---|
| `lib/index.js` | 1070 | 类 `SkillsViewerGateway extends TypertRemoteService` + 13 个 RPC manifest（`index.js:311-314, 133-288`）；依赖 `ctx.agents/sessions/agentPresets/skills/workspaceRegistry` | 把方法体抽成 `SkillService` 普通类，构造注入 `{ctx, homes, workspaces}`；删除 `super(ctx,"skillsViewer")`、MANIFEST、`ctx.typert.register`；TUI 直接调用方法，不经过 RPC |
| `lib/mcp/gateway.js` | 507 | 类 `McpManagerGateway extends TypertRemoteService` + 内存 `OAUTH_FLOWS` + RPC schema 解析；`patchPath` 依赖 `ctx.baseUrl` | 保留 `readRows/resolveRow/list/save/removeServer/setEnabled/readRaw/writeRaw/test/oauth*` 的方法体；去掉 Typert 基类与 `parseWirePayload`（TUI 直接传对象）；OAuth 流程改成 TUI 可轮询的本地状态机 |
| `lib/tool-filter.js` | 361 | 依赖 `ctx.tools.restrict`、`agent/created`、scoped ctx、logger | 逻辑可整体保留；TUI 版要确认宿主有同样的 scope 语义（ADR-0005 的原型结论仍适用于 0.2.2）；保留重入守卫 |
| `lib/provider.js` | 107 | chokidar + `ctx.skills.registerProvider` | 产品决策：是否做嵌套技能；若做，优先用宿主 watcher/事件而不是再起 chokidar |
| `lib/cli-skill.js` | 732 | CLI 入口（readline 确认、spawn `dsh plugin`、`process.exitCode`、console 输出、`runSkillCli` 单入口） | **不要直接调用**；抽取 `addSkillFromPath`、`setEnabled`、`delete`、`scope/migrate` 等纯流程函数供 TUI 复用；`update` 逻辑与 TUI 无关 |
| `lib/cli-mcp.js` | 494 | 同上 + `--profile` 解析 + 阻塞式 OAuth | 抽取 `readRows/resolveRow/add/remove/enable/disable/raw/test/oauth` 流程；`buildInputFromArgs` 可作 TUI 命令行/表单参数解析参考 |
| `lib/index.js` 的 `list()` | — | 合并注册表 + 文件扫描；`ctx.skills`、`ctx.agents` 依赖 | TUI 版若首版只列文件技能可大幅简化；若要列插件自带技能，需要注册表 |
| `lib/global-shim.js` | 95 | 写 npm 全局 bin 的 `dsh-panel` shim（Windows 三份） | TUI 版若也发 CLI 可参考；纯 TUI 插件不需要 |

### 5.3 C 级：不可复用

| 模块 | 行数 | 原因 |
|---|---:|---|
| `lib/client.js` | 4804 | 浏览器束：`window.__ModuleLoader__`、React、`@deepseek-ai/dsh-client-ui-primitives`、web sidebar/layout 注入（`client.js:1-10`；`package.json:27-36`） |
| `lib/mcp/wire.js` | 348 | Typert wire manifest / zod 边界（`wire.js:173-348`） |
| `lib/codec.js` | 18 | Typert strict codec 契约（0.2.x 专用） |
| `lib/index.js`/`gateway.js` 的 Typert 基类与 manifest 部分 | — | 同上；方法体是 B 级 |
| `package.json` 的 `dsh.client` 段、`cordis.patch.yml`（插件自身 bundle patch） | — | web 客户端注入与「安装本插件」的 loader 行；TUI 包应写自己的 `dsh-plugin.json`/bundle patch（见 01/04 文档） |
| `assets/skill-mcp-icon.svg` | 383B | web 侧栏图标，TUI 用不到 |

### 5.4 「值得移植的函数」Top 清单（按价值排序）

1. `patch-editor.readManagedBlock` / `generateManagedBlock` / `replaceManagedBlock` / `evacuateForeignRows` —— 保证不毁用户 patch 文件。
2. `patch-editor.setEntryDisabledInText` / `replaceMcpEntryTextInText` / `removeMcpEntryInText` —— 三个「就地改一条」的原语。
3. `model.parseWireScalar` / `formatWireScalar` / `applyServerEdit` —— 保住 `!!js` 与未建模字段。
4. `skill-files.collectSkillEntries` / `parseFrontmatter` / `validateFrontmatter` —— 技能发现与写入前校验。
5. `skill-import.classifySkillImport` —— 三种添加入口统一分类。
6. `scope.migrateEntry` —— 复制/移动 + 回滚。
7. `groups.loadGroups` / `upsertGroup` —— 分组。
8. `tool-filter` 的 `pluginFor` / `syncAll` / 重入守卫 —— 单工具禁用（若要）。
9. `oauth.discoverMetadataDetailed` / `startLoopbackServer` / `exchangeCode` —— OAuth（若要）。
10. `gateway.resolveRow` / `save` / `setEnabled` 的流程 —— 双键定位与「保存后等 loader」。

### 5.5 可移植的测试（重要资产）

npm 包不带测试，但 GitHub `test/` 共 27 个文件：24 个 `test-*.mjs` + 2 个 fixture（`mcp-server-fixture.mjs`、`mcp-preview-server.mjs`）+ README。测试直接 `import "../lib/xxx.js"`，其中与纯模块对应的可直接照搬：
`test-patch-editor.mjs`(26KB)、`test-oauth.mjs`(25KB)、`test-skill-import.mjs`(18KB)、`test-cli-profiles.mjs`(19KB)、`test-scope.mjs`、`test-groups.mjs`、`test-mcp-model.mjs`、`test-mcp-gateway.mjs`、`test-tool-filter.mjs`、`test-mcp-probe.mjs`、`test-validate.mjs`、`test-version.mjs`、`test-reveal.mjs`、`test-nested-discovery.mjs`、`test-provider.mjs`、`test-codec.mjs`（清单见附录 C）。**只要保持纯模块边界，这些测试可原样移植**，是 TUI 版回归网最快的来源。

### 5.6 移植时的状态耦合与依赖注入点（接手成本）

| 耦合点 | 位置 | 说明 | TUI 移植做法 |
|---|---|---|---|
| `OAUTH_FLOWS` 模块级 `Map` | `mcp/gateway.js:56` | 进行中的 OAuth 流程存在模块全局，多实例/热重载会串 | 改成 TUI 插件实例字段 |
| `MANAGED_ROW_IDS` 空 `Set` | `mcp/gateway.js:29, 507` | 历史遗留导出，无实际用途 | 不移植 |
| `workspaceCache` 3s TTL | `index.js:319-336` | 实例字段，避免一次页面打开重复枚举工作区 | 保留实例缓存，热操作后显式 `invalidateWorkspaces()` |
| 工具过滤控制器状态 | `tool-filter.js:126-138` | `mounted/mounting/syncing` 是防递归关键状态，必须单实例 | 每个 TUI 插件实例一个控制器 |
| 嵌套提供方 watcher | `provider.js:27-54` | chokidar 生命周期绑定 `control.signal`；插件卸载要 close | 若不做嵌套发现则无需 |
| patch 写锁 | `patch-editor.js:332-364` | 以文件锁协调「Web 宿主 + CLI」并发写；TUI 与 web 可能同时在同一 profile 上改 | TUI 版保留同一把锁，避免与 web/CLI 并发写坏 |
| 环境/根 | `host-paths.js:30-54` | `DSH_HOME`、`DSH_AGENTS_HOME`、`process.env` | 构造时注入 homes，便于测试（参考 CLI 允许覆盖） |
| 会话/工作区上下文 | `index.js:338-358` | 列表/启停依赖 `sessionId → agents/sessions/agentPresets`；TUI 需自己决定「当前会话 cwd」来源 | 从 TUI 会话上下文取 cwd；无会话时退回全局根 |

---

## 6. 许可证、依赖与风险

### 6.1 许可证

- MIT（`RP/LICENSE:1-3`，GitHub license API 返回 MIT）。允许商用、修改、再分发；**必须保留版权声明与许可文本**。若直接复制 `lib/*.js` 或 `src/*.ts` 到 TUI 仓库，建议在文件头注明来源与 commit/tag（2.3.7），并在仓库 `NOTICE`/`LICENSES` 保留 MIT 文本。
- 参考插件作者与项目名：`dsh-skill-viewer contributors`；仓库 `Fishquito7/dsh-skill-mcp-panel`。

### 6.2 依赖与版本风险

| 风险 | 事实 | 影响 | 建议 |
|---|---|---|---|
| MCP SDK 版本分裂 | 参考插件用 `@modelcontextprotocol/sdk@1.32.2`（`probe.js:6-8`）；DSH 0.2.2 的官方 mcp-client 用 `@modelcontextprotocol/client@2.2.0`（`DSH/node_modules/@deepseek-ai/dsh-mcp-client/package.json`） | 两套 SDK 并存、体积/接口差异 | TUI 版复用宿主依赖，或实现最小探针 |
| DSH 版本强耦合 | peer `>=0.2.0-rc.1 <0.3.0-0`（`package.json:55`），协议 `^0.2.0-rc.1 \|\| ^0.2.1-rc.1`（`:46`）；README 明确只支持 0.2.x | 0.3 或不兼容变更需跟进 | TUI 插件同样声明 peer 范围并做启动校验 |
| 服务名冲突 | issue #81：DSH 0.2.2-alpha.3 内置 `@deepseek-ai/dsh-mcp-manager` 注册 `mcpManager` 服务，与插件同名 → 内置插件启动失败。本机安装的 0.2.2-rc.1 **未包含** `dsh-mcp-manager`（`DSH/node_modules/@deepseek-ai/` 下无此包，已核），因此当前环境未触发；但上游后续构建可能包含 | web 插件与未来宿主冲突；TUI 若复用同类名会重复踩 | TUI 版**不要**注册公共服务名 `mcpManager`；若需要服务，用带前缀命名 |
| `@deepseek-ai/dsh-home-paths` / `dsh-subprocess` peer 链 | 参考插件为剪掉 peer 链把两个纯函数内联（`host-paths.js:1-13`） | 若 TUI 直接依赖这两个包，可能出现 peer 缺失导致 import 断裂 | 沿用内联做法 |
| cordis peer | `^4.0.1`（`package.json:53-54`），本机 4.1.x | 与 dsh-tui 使用的 cordis 版本需一致 | 作为 peerDependency，不重复安装 |

### 6.3 README 更新日志里的历史坑（对 TUI 版的启示）

| 版本/事件 | 坑 | 事实/证据 | TUI 版启示 |
|---|---|---|---|
| #46 / ADR-0003 | 重写受管块把顶层 override 折进 `insert:`，导致 dsh-market 更新全部回滚（duplicate loader id） | `patch-editor.js:81-123, 238-308`；ADR-0003 | 任何「整块重写」都必须保留外来行形状；只改目标行 |
| #59/#62 | tool-filter 监听 `tools/change` 又调用 undo/restrict → 同步无限递归，主线程 100% CPU | `tool-filter.js:18-30` | 重入守卫 + 签名变化才重施 + catch 接日志 |
| #47 | 受管块标记失配后 MCP 页整页不可用；issue 已关闭，但 2.3.7/main 无自动修复路径 | `patch-editor.js:169-170`；`gateway.js:147-166`；issue #47（closed 2026-10-22） | TUI 版加「修复受管块」按钮（备份后修） |
| #80 | OAuth 令牌到期不自动刷新，连接失效 | `oauth.js:542-556` 无调用点；gateway 只用 `isExpired` 展示 | 接入刷新调度或明示限制 |
| #66 | junction 型技能目录导致启停不生效 | 已关闭；扫描器跟随符号链接（`skill-files.js:234-235`） | TUI 版扫描/改名要处理符号链接（resolve 后比较） |
| #81 | `mcpManager` 服务名与宿主内置冲突 | issue #81 | 服务命名加前缀 |
| v2.3.6 | 重复 id/serverName 改错行；CRLF 被掺 LF；删块尾行标记残留 | `patch-editor.js:478-535, 520-523, 635-653` | 双键定位、EOL 跟随、删空收标记，三条都要继承 |
| v2.3.4 | Windows `explorer.exe` 不认正斜杠，打开目录只弹「文档」 | `reveal.js:13-41` | TUI 若调系统 opener，路径先转本机分隔符 |
| v2.3.5 | 配置 `!!js disabled` 被面板当布尔改写 | `patch-editor.js:695-703`；`model.js:357-360` | `!!js` 一律原样往返，不改写 |

---

## 7. 对 TUI 版的落点（结论级，细节见 01/03）

> 本节只给「参考插件视角」的结论，TUI 接缝细节以 `01-dsh-tui-plugin-architecture.md` 为准，内核机制以 `03-...md` 为准。

1. **形态**：TUI 插件本身就是 profile 内的 cordis 插件（`/home/wqwt/.dsh/profiles/dsh-tui/package.json:10-18` 中 `@deepseek-ai/dsh-base` + `@deepseek-harness-tui/dsh-tui` 同 bundle 组合），**不需要 Typert RPC/HTTP gateway**。TUI 的可视化接缝包括设置区块、全屏场景、托管对话框、状态行、快捷键、条目渲染器（稳定候选）与实验性的侧栏 Panel `ctx.tuiPanels`（`TUI/guide/dsh-tui-guide/plugins.md:34-35, 52`）。
2. **服务面【已验证事实】**：`dsh-base` 提供 `skills`、`skill-filesystem`、`tools`、`agents`、`sessions` 与 `typert`（`DSH/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:41, 83, 46-53, 313, 316, 499`）；`loader` 由 dsh 引导器本身挂载（不在 base patch 里）。`workspaceRegistry` 与 `agentPresets` **不由 base 提供**：前者由 `dsh-web-app`/`dsh-sdk-app` 或 dsh-tui 自己的 patch 行加载（`TUI/cordis.patch.yml:238-240`），后者由 `dsh-agent-preset-registry` 行提供（`TUI/cordis.patch.yml:354-355`；服务注册见 `DSH/.../dsh-agent-preset-registry/lib/index.js:456`）。因此 TUI 侧这些服务**基本都有**；`index.js` 的 `registryFor` 对 `agentPresets` 是可选使用（`index.js:338-346`），缺失时会退回全局 `ctx.skills`。**未验证**：TUI 运行时 `ctx.workspaceRegistry` 是否真的 active（依赖 dsh-tui patch 行的 disabled 表达式与 base 版本，本机未启动 TUI 观测）。
3. **MCP 行加载**：`@deepseek-ai/dsh-mcp-client` 是 dsh CLI 的直接依赖（`DSH/package.json:50`），但**不在 TUI profile 的 `bundles` 里**（`/home/wqwt/.dsh/profiles/dsh-tui/package.json:10-18`），dsh-tui 包自身的 155 个 `@deepseek-ai/*` 依赖里也没有任何 mcp 包（`grep -c dsh-mcp` = 0）。要在 TUI 里启用 MCP，需要把插件行 insert 进 profile patch（本插件机制）或把 `@deepseek-ai/dsh-mcp-client` 加进 bundles；行能否被 loader 解析到【推断】成立（dsh 自带该包），但**未在 TUI profile 实测**。
4. **文件选择**：web 用浏览器文件选择/拖放再 base64 上传；TUI 直接走本地路径（CLI 的 `collectSourceEntries`/`walkFiles` 已实现），可去掉 200 文件/8MB 的传输护栏，但保留「递归深度/跳过目录」防护（`skill-files.js:198-201`；`skill-import.js:91-92`）。
5. **删除撤销**：TUI 可做真撤销（移入回收目录），优于 web 的「尽力回填」。
6. **MCP 原文编辑**：web 是弹窗 textarea；TUI 需要多行编辑器/外部 `$EDITOR` 方案，属于 01 文档的 UI 决策。
7. **工作区级 MCP**：参考插件只有 profile 级（没有 scope 字段，`mcp/model.js:4-6`）。TUI 若要求「工作区级 MCP」需要新设计（动态挂载 mcp-client 或按会话作用域），见 03 文档结论。
8. **分组**：可直接复用 `groups.js`，把「分组」做成 TUI 的筛选/组织维度；但注意分组是**全局单文件**、按 `(scope, name)` 存成员，不按 profile 分家。

---

## 8. 未决问题（交给 Lead / 后续任务）

| # | 问题 | 选项/建议 | 影响 |
|---|---|---|---|
| Q1 | TUI 首版是否做「嵌套技能发现」（provider.js）？ | 建议先不做（原生只认一层，TUI 可先对齐原生）；若做，复用 `ctx.skills` 事件而不是新 chokidar | 影响扫描复杂度和 chokidar 依赖 |
| Q2 | 是否保留 `.agents/skills` 两个根？ | 建议保留（成本低，扫描器已写好），但 UI 默认折叠 | 与 web 版行为一致 |
| Q3 | MCP 是否需要工作区级作用域？ | 参考实现只有 profile 级；工作区级需新增机制，风险高（参考 03） | 决定是否走「首版 profile 级 + UI 说明」 |
| Q4 | 单工具禁用是否纳入首版？ | 复用 `tool-filter.js` 成本中等；但需 TUI 有 agent 生命周期与 scoped tools（已有） | 影响 TUI 是否需要在 agent 作用域挂插件 |
| Q5 | OAuth 是否纳入首版？ | 若纳入，必须补 refresh 调度（#80）并提供「终端打印 URL + 手动粘贴 code 兜底」 | 影响范围与安全评审 |
| Q6 | 是否 vendor 参考代码，还是重写？ | 建议 vendor A 级模块（保留 MIT 声明 + 移植测试），B 级重写壳；不要 vendor client.js | 决定代码来源与许可合规 |
| Q7 | MCP 行重名/双键定位在 TUI 的交互怎么暴露？ | 建议列表行默认显示 entryId 尾号，操作时带 entryId；提供 `--id` 等价 UI | 影响 UI 设计 |
| Q8 | 受管块损坏的修复策略？ | 建议实现「备份 + 修复」入口（补/删孤立标记），并给出手改指引 | 决定 #47 类问题在 TUI 是否可自愈 |
| Q9 | TUI 版是否也要提供 CLI？ | 若提供，参考 `global-shim` 与 `cli-*.js` 的「每 profile 已装版本」更新逻辑；否则不移植 | 影响交付面 |
| Q10 | 上游 `@deepseek-ai/dsh-mcp-manager` 若进入基线，是否改为「复用官方 manager」？ | 建议先跟踪 issue #81；TUI 版把「MCP 配置读写」与「服务命名」解耦，便于切换 | 影响长期维护 |
| Q11 | TUI 版 MCP 是否也管理 home 层（`~/.dsh/cordis.patch.yml`）？ | 参考插件只管 profile 层；建议首版对齐，home 层只读展示或不做 | 决定「全局 MCP」语义是否覆盖跨 profile 层 |

---

## 附录 A · `RP/lib` 文件索引（全部 23 个 JS）

| 文件 | 行数 | 一句话 | 复用等级 |
|---|---:|---|---|
| `index.js` | 1070 | 宿主 `skillsViewer` Typert 服务：列表/启停/删除/添加/迁移/分组/打开目录/更新检查 | B |
| `client.js` | 4804 | web 浏览器束（React 三栏面板 + MCP 页 + 表单/原文/工具/OAuth UI） | C |
| `patch-editor.js` | 902 | profile `cordis.patch.yml` 字节级编辑（受管块/外来行/单条跨度/锁/原子写） | A |
| `oauth.js` | 578 | OAuth 发现 + 动态注册 + PKCE + loopback + 换/刷新令牌 + 存储 | A |
| `cli-skill.js` | 732 | `dsh-panel skill` 子命令（技能全流程 + 更新） | B |
| `cli-mcp.js` | 494 | `dsh-panel mcp` 子命令（MCP 全流程 + OAuth） | B |
| `tool-filter.js` | 361 | 单工具禁用控制器（按 agent scoped restrict） | B |
| `mcp/model.js` | 381 | MCP 配置模型（表单 ↔ patch 行、`${NAME}`↔`!!js`、脱敏、保留字段） | A |
| `mcp/wire.js` | 348 | `mcpManager` Typert wire manifest | C |
| `mcp/gateway.js` | 507 | MCP 宿主服务（list/save/remove/启停/原文/测试/工具过滤/OAuth 流程） | B |
| `mcp/probe.js` | 125 | 临时 MCP 连接探针（测试连接） | A（依赖需换） |
| `mcp/status.js` | 58 | loader entry 状态/工具计数/等待 | A/B |
| `skill-files.js` | 294 | 技能文件约定（扫描/frontmatter/校验/根） | A |
| `scope.js` | 208 | 作用域布局 + 迁移引擎 | A |
| `skill-import.js` | 165 | 添加技能的统一定类器 + zip 展开 | A |
| `groups.js` | 125 | 分组私有显示配置 | A |
| `profiles.js` | 128 | profile 枚举/校验/Electron 独占 | A |
| `provider.js` | 107 | 嵌套技能提供方（chokidar + rank 300） | B |
| `version.js` | 97 | 版本读取 + GitHub Releases 检查 | A（非必需） |
| `global-shim.js` | 95 | 全局 `dsh-panel` shim 安装（Windows 三份） | B（非必需） |
| `reveal.js` | 91 | 系统文件管理器打开目录 | A（非必需） |
| `host-paths.js` | 55 | `DSH_HOME` 解析 + 子进程环境清洗（内联） | A |
| `codec.js` | 18 | Typert strict codec 构造 | C |

其他：`assets/skill-mcp-icon.svg`（383B，web 图标）、`LICENSE`、`README.md`/`README.en.md`、`cordis.patch.yml`（插件自身 bundle patch）。

## 附录 B · README 声称 vs 代码事实（差异表）

| README 声称 | 代码事实 | 结论 |
|---|---|---|
| 技能存 `~/.dsh/skills` 与 `<ws>/.dsh/skills`（第 244 行） | 实际还扫描 `~/.agents/skills`、`<ws>/.agents/skills`（`skill-files.js:170-191`） | README 不完整 |
| 「面板能做的事命令行都能做」（第 19、24 行） | 分组、单工具禁用、打开目录、批量多目标迁移、撤销删除、搜索/布局等仅面板；CLI 另有 `profiles`/`update`（§2.3） | 不成立 |
| `skill` 子命令不需要 `--profile`（第 169-171 行） | 代码一致（`cli-skill.js:502-519`）；但 `cli.js:10-11` 文件头注释仍写「技能与 MCP 都是按 profile 存」 | 注释过期 |
| MCP 行「不区分受管块内外，也不看 id 前缀」（第 118 行） | 一致：`listMcpPatchRows` 拍平整份文档（`patch-editor.js:223-231`）；`list()` 对每一行都标 `managed: true`（`gateway.js:157, 133-146`），`managed` 字段已无区分意义 | 一致（字段名有误导） |
| 原文「只能改这一条的内容，缩进和位置不能变」（第 209 行） | 一致：`replaceMcpEntryTextInText` 校验 `inInsert` 与缩进，并禁止增删行（`patch-editor.js:798-832`） | 一致 |
| 「文件里原本就有重名时面板不会拒绝保存，只拒绝新增重名」（第 214 行） | 一致：`assertNoNewDuplicates` 对比前后（`patch-editor.js:618-629`）；`list` 失败时返回 `patch.error` 而非空白（`gateway.js:147-166`） | 一致 |
| 「删除可撤销」（第 111 行） | 前端尽力还原（只回填 `SKILL.md` 正文，带资源目录会丢载荷；`client.js:1793-1800`） | 需注明「尽力」 |
| 「随部署附带的技能不可停用/删除」（第 247 行） | 一致：`assertEditable`（`index.js:683-688`） | 一致 |
| 「保存后由 DSH HMR 热加载」（第 22 行） | 一致：dsh-hmr 监听 profile/home patch（`dsh-hmr/lib/index.js:850-872`）；本机未做端到端观测 | 机制成立，未实测 |
| 「停用 = 改名 `SKILL.md.disabled`」（第 245 行） | 一致；单文件是 `<name>.md.disabled`（`skill-files.js:21, 263-271`） | README 未提单文件形态 |
| 「技能目录里没有隐藏存储」 | 分组/令牌等确实在 `skills/.system/skill-viewer/`（隐藏区，原生 `skipSystem` 跳过；`groups.js:24-30`；`dsh-skill-filesystem:185,599`） | 措辞略绝对 |

## 附录 C · 证据来源与核验方式

- 本地代码：`RP/lib/**`、`RP/package.json`、`RP/README.md`、`RP/LICENSE`（2026-11-07 读取）。
- 宿主实现：`DSH/package.json`、`DSH/lib/profile-boot-e2mS45fC.js`、`DSH/node_modules/@deepseek-ai/{dsh-base,dsh-hmr,dsh-app-boot,dsh-skill,dsh-skill-filesystem,dsh-workspace,dsh-mcp-client,dsh-agent-preset-registry}`（0.2.2-rc.1）。
- 本机 profile：`/home/wqwt/.dsh/profiles/web/{package.json,cordis.patch.yml,node_modules}`、`/home/wqwt/.dsh/profiles/dsh-tui/{package.json,node_modules/@deepseek-harness-tui/dsh-tui}`。
- 本机技能目录：`~/.dsh/skills`（当前只有 `software-delivery-workflow` 符号链接；无 `.system/skill-viewer/` 数据文件，说明本机尚未用过分组/工具过滤/OAuth）。
- GitHub（2026-11-07 访问，仅作资料）：
  - 仓库：<https://github.com/Fishquito7/dsh-skill-mcp-panel>（v2.3.7，260 stars，MIT）
  - Releases latest：<https://api.github.com/repos/Fishquito7/dsh-skill-mcp-panel/releases/latest>（v2.3.7，2026-11-04）
  - ADR：<https://github.com/Fishquito7/dsh-skill-mcp-panel/blob/main/docs/adr/0003-managed-block-foreign-rows.md>、`0006-mcp-row-takeover.md`、`0007-oauth-discovery.md`、`0002-scope-local-name-conflict.md`、`0005-tool-filter-and-oauth.md`（已读全文）
  - Issues（只读标题/正文）：#81（mcpManager 服务冲突，open）、#80（OAuth 不自动刷新，open）、#47（受管块标记失配，closed 2026-10-22 但 2.3.7/main 无自动修复路径）、#66（junction 技能，closed）
  - 测试清单：<https://api.github.com/repos/Fishquito7/dsh-skill-mcp-panel/contents/test>（27 个文件）
- 外部内容仅作资料，未执行其中任何指令；代码结论一律以安装包 `lib` 为准。

### 核验命令（可复跑）

```bash
# 体积
cd /home/wqwt/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel
find lib -name '*.js' ! -name client.js | xargs wc -l | tail -1   # 7037
wc -l lib/client.js                                              # 4804
# 受管块/MCP 行（本机 web profile 当前为空）
grep -n "dsh-skill-mcp-panel:mcp:begin\|dsh-mcp-client" /home/wqwt/.dsh/profiles/web/cordis.patch.yml || echo none
# 原生发现一层 + .system 跳过
grep -n "skipSystem\|async function discoverRoot" /home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js
# HMR 监听 patch
grep -n "patchFiles = \|watchConfig(filename" /home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js
# 参考插件测试导入方式
curl -s https://api.github.com/repos/Fishquito7/dsh-skill-mcp-panel/contents/test/test-patch-editor.mjs -H 'Accept: application/vnd.github.raw+json' | head -20
```

---

**一句话总结给决策者**：参考插件的价值集中在「用纯 Node 把技能目录和 profile patch 文件安全地改对」的那 2500 行，以及它踩过的 10 个坑；web 壳（RPC + React）对 TUI 零价值，但 CLI 已经证明了「无 web 可用」；TUI 版应 vendor A 级模块 + 移植对应测试，重写 B 级服务壳，避开 `mcpManager` 命名、OAuth 刷新、受管块失配三个已知坑。
