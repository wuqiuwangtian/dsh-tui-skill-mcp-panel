# 03 · DSH 内核的技能与 MCP 机制（热加载、作用域）

> 调研人：dsh-core（task-3）｜日期：2026-11-07｜只读调研，未修改任何产品代码或配置
>
> 目标：为 dsh-tui 的「技能 + MCP 可视化管理插件」回答内核能力边界：技能怎么发现/热更新、MCP 怎么加载/热重载、全局 vs 工作区在 DSH 里各自意味着什么、哪些需求必须妥协或改内核。

## 0. 证据基准与约定

### 0.1 调查对象（均已核实版本号）

| 对象 | 路径 | 版本 |
|---|---|---|
| DSH 内核 | `/home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh/`（下文简称 `K/`） | `@deepseek-ai/dsh` **0.2.2-rc.1** |
| 内核包目录 | `K/node_modules/@deepseek-ai/*`（330 个包，下文以「包名」为前缀引用） | 绝大多数 **0.2.2-rc.1** |
| Cordis | `K/node_modules/@deepseek-ai/cordis` | 4.1.0 |
| Loader | `K/node_modules/@deepseek-ai/cordis-plugin-loader` | 1.1.0 |
| MCP SDK（内核使用） | `K/node_modules/@modelcontextprotocol/client` | 2.2.0（另有 `@modelcontextprotocol/core`） |
| dsh-tui | `/home/wqwt/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui`（简称 `T/`） | 0.19.0 |
| 既有 Web 版同类插件（只作对照实现参考） | `/home/wqwt/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel`（简称 `W/`） | 2.3.7 |

引用格式：`<包名>/lib/<文件>:<行号>`，行号基于上述安装路径的构建产物（`lib/*.js` / `lib/types/*.d.ts`）实测。

### 0.2 结论可信度标记

- **【已验证事实】**：直接读到实现代码/类型声明，上文行号可复核。
- **【推断】**：由已验证代码 + Cordis 语义推出，但未实测运行（本会话不启动 TUI）。
- **【未验证】**：需要实际跑进程才能确认；已单列到第 6 节。

### 0.3 一句话结论（先看这里）

1. **技能天然支持「全局 / 工作区」与热加载，几乎零内核改动。** 发现根有固定 rank 表（项目 `.dsh/skills` 100 → `.agents/skills` 200 → custom 300 → 用户 `~/.dsh/skills` 400 → `~/.agents/skills` 500 → bundled 600），重名按「层内 rank → provider 注册序 → provider 内顺序」裁决；Chokidar depth=1 监听 + 缺失根轮询 + 首方 `write/edit` 直接失效，`skills/change` 事件驱动下一步重发目录。
2. **技能没有「原生开关」概念。** 内核只有 frontmatter 的调用策略（`disable-model-invocation` / `user-invocable`），没有「这个技能停用」的注册表状态。**改名 `SKILL.md` → `SKILL.md.disabled` 是当前唯一无内核改动、且热生效的停用手段**（发现器只认固定文件名，改名后立即不可见）。
3. **MCP 的持久化配置只有 profile 级，没有工作区级。** 每个 MCP server = profile patch 里的一行 `@deepseek-ai/dsh-mcp-client` loader entry；`cordis.patch.yml` 变更由 HMR 监听并 `recomposeProfile` 热替换 entry（重启条目，不重启进程）。`disabled: true` 会让 entry 销毁 fiber（断连、注销工具），改回即重新初始化。
4. **`patchReload: live` 在 0.2.2-rc.1 内核里没有任何代码引用**（全量 grep 无该字符串）。patch 热加载实际由「HMR 在存在 `profileContext` 时无条件监听 profile patch + home patch」提供，与这个键无关。**属于遗留/无效键，不要依赖它作为开关。**
5. **单工具禁用有内核机制，但只能由 scoped context 施加。** `ctx.tools.restrict({deny})` 在全局 ctx 会直接抛错（"would mask every agent"），必须在 agent scope 上注册；被遮盖的工具确实从模型 schema 消失（省上下文）。名字必须已注册，否则抛错 → 需要重试/重放策略。
6. **「MCP 测试连接」内核没有可复用 API**（`dsh-mcp-client` 只导出 `Config/apply/createMcpToolDefinition/name/inject`）。要么直接用 MCP SDK（与内核同代的 `@modelcontextprotocol/client@2.2.0`），要么临时把 `apply` 挂到一次性 scope 再销毁。
7. **dsh-tui 现状会直接影响面板设计：** TUI bundle **禁用了 host 级 `skill-filesystem` 与 `tool-skill`**，技能发现改由 preset（agent 作用域）挂载。因此**在 host 层 `ctx.skills.snapshot()` 不带 agent scope 会看到空目录**；面板若想「列出模型真正可用的技能」，要么传 agent scope，要么自己按相同规则扫盘。MCP 管理则天然是 profile/patch 级。

---

## 1. 技能子系统（dsh-skill / dsh-skill-filesystem / dsh-tool-skill）

### 1.1 三个包的分工

- `dsh-skill`：**注册表（服务）**，提供 `ctx.skills`，负责合并、去重、裁决、加载、失效广播。没有内容来源。
- `dsh-skill-filesystem`：**本地 provider**，扫盘 + 解析 frontmatter + Chokidar 监听，向 `ctx.skills` 注册。
- `dsh-tool-skill`：**面向模型的消费者**，把目录渲染成持久化 catalog 消息 + 提供 `skill` 工具 + `/name` 用户手势。

证据：三个包的 `README.md` 首段 + `dsh-skill/lib/types/index.d.ts:1-16`、`dsh-skill-filesystem/lib/types/index.d.ts:1-15`、`dsh-tool-skill/README.md:12,57,85`。

### 1.2 发现根、优先级、重名裁决 【已验证事实】

**根列表（按 rank，数值小者优先）** — `dsh-skill-filesystem/lib/index.js:20-24,160-198`：

| rank | source 标签 | 路径 | 说明 |
|---|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` | 仅当有 lookup `cwd` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` | 同上 |
| 300 | `custom` | `Config.customSkillDirs`（逐个 resolve） | profile 配置级，非工作区 |
| 400 | `user-dsh` | `$DSH_HOME/skills`（默认 `~/.dsh/skills`） | `skipSystem: true`，跳过 `.system` 子目录 |
| 500 | `user-agents` | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） | |
| 600 | `bundled` | `Config.bundledSkillDir`，缺省取环境变量 `DSH_BUNDLED_SKILL_DIR` | 常量 `BUNDLED_SKILL_RANK` 定义在 `dsh-skill/lib/types/index.d.ts:16` |

**projectRoot 的算法**（关键坑）：从 lookup `cwd` 开始向上找最近含 `.git`（文件或目录都算，`pathExists` 只做存在性判断）的祖先；找不到则回落到 `cwd` 本身 — `dsh-skill-filesystem/lib/index.js:821-828`。
→ **工作区语义 = 最近 `.git` 祖先，而不是 TUI 的 workspace 记录。** 如果 TUI workspace 指向的是 git 仓库的子目录，面板上「这个工作区自己的技能」和 DSH 实际扫描根会不一致。另：没有 monorepo 子工程选择能力（同包 README「Known Limitations」）。

**技能的文件形态**（决定「添加/删除/停用」只能怎么写）`dsh-skill-filesystem/lib/index.js:595-628`：

- 目录束：`<root>/<name>/SKILL.md`（只认这一层，不递归 `**/SKILL.md`）。
- 平铺文件：`<root>/<name>.md`（顶层 `.md` 都算；技能名来自 frontmatter 的 `name`，不是文件名）。
- `.system` 子树在用户根被显式跳过（`:559,599`）。

**frontmatter 要求** `dsh-skill-filesystem/lib/index.js:678-718`：必须 `---` 包裹；`name`（kebab-case，`isSkillName` 校验）+ `description` 必填；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`（布尔词法严格，见 `:863-892`，非法值整条技能被丢弃并 warn）。任何一项不合法 → **静默丢掉该技能（只有日志）**，模型侧无法区分「不存在」与「不合法」。

**重名裁决（两层规则）** — `dsh-skill/lib/index.js:312-330,331-375,520`：

1. 先按 **layer** 分层：注册表是 `host + per-scope` 结构（`dsh-scope` 的 `ScopedLayers`）。`registerProvider` 落在调用方 ctx 所属 scope 的 layer；host 行与普通插件落 global 层，被 preset 常驻组合挂载的落该 preset 层（`dsh-skill/lib/index.js:108-118,147-183`）。
2. 读取时 `collectFresh` 合并 `[global, ...scopeChain(scope)]`，**近层直接遮蔽远层**（`:298-311`）。
3. 同层内去重按 `compareIndexedCandidates`：`rank` → `providerOrder`（provider 注册顺序）→ `localOrder`（provider 返回顺序），先到先得，落败者 warn（`:520`、`:312-330`）。
4. runtime 注册（`ctx.skills.register`）rank 常量 250（`:20-21,446`），介于项目（100/200）与用户（400+）之间。

**能看到落败者吗？不能。** 没有「列出所有被遮蔽定义」的 API（`dsh-skill/README.md` Known Limitations）。`snapshot()` 只给每个名字的胜出者，附 `source/provider/path`，可据此提示用户「本项目同名覆盖了全局版本」。

### 1.3 监听与热更新 【已验证事实】

实现位置全在 `dsh-skill-filesystem/lib/index.js`：

- 入口 `apply()` 用 `ctx.skills.registerProvider` + `ctx.on('fs/observed')`（`:45-60`）。**首方 `write`/`edit` 工具改动技能文件时，不依赖 watcher，直接同步失效**（`:56-59,249-254,578-582`）。
- Chokidar 参数：`depth: 1`、`ignoreInitial`、`atomic`、`awaitWriteFinish { stabilityThreshold: 200ms, pollInterval: 100ms }`、可选 `usePolling`、`followSymlinks`（`:381-394`，默认值 `:30-43`）。
- **根不存在时**：从最近存在祖先用 `fs.watchFile(pollInterval)` 一段段轮询，直到根出现后换 Chokidar（`:342-380,516-551`）。
- 相关性判断（决定什么改动触发刷新）`isRelevantWatchEvent` `:555-564`：
  - 根目录本身 `addDir/unlinkDir` → 相关；
  - 根下一层目录 `addDir/unlinkDir` → 相关（新增/删除技能目录）；
  - 根下一层 `.md` 的 add/change/unlink → 相关；
  - 二层且文件名为 `SKILL.md`（非 addDir/unlinkDir）→ 相关；
  - `references/`、`scripts/`、`assets/` 等资源子树 → **不相关**（README 明说）。
- 失效合并：`queueInvalidation()` 用 `queueMicrotask` 合并成一次 `invalidate()`（`:476-485`）；`invalidate()` 由注册表提供的注册域能力 `control.invalidate`，仅在**该次 provider 注册仍存活**时才生效（`dsh-skill/lib/index.js:151-157`）。
- 失效效果：`revision += 1`、清空按 `cwd+scope 链+revision` 的采集缓存、`emit('skills/change')`（`dsh-skill/lib/index.js:376-380,395-401,403-412`）。
- **技能正文不缓存**：`get()` 每次现读文件（`dsh-skill-filesystem/lib/index.js:125-144`；`dsh-skill/README.md`「Loading and staleness」）。所以改正文无需失效，下一次 `get` 就新内容。
- 消费端刷新：`dsh-tool-skill` **不监听 `skills/change`**，而是在每个 `agent/pre-step` 调 `ctx.skills.snapshot({ scope: agent, cwd })`，对 entries+complete 做 sha256 digest，与 session 日志里最新一条 catalog 消息比对，变了就在下一步追加一条「replacement catalog」消息（`dsh-tool-skill/lib/index.js:935-960,1035-1037`；README `:85`）。
  → 对「热加载」的准确表述：**磁盘变化在下一步模型请求前生效**，不是即时推送；且是 append-only 替换，不重写历史。

### 1.4 `ctx.skills` 服务 API（面板可用的全部读写面）【已验证事实】

来自 `dsh-skill/lib/types/index.d.ts`：

| API | 签名要点 | 用途/边界 |
|---|---|---|
| `registerProvider(create)` | 同步注册 provider，返回精确 disposer（`:237-247`） | 面板若要自定义来源（如远程/数据库）用它；`runtime` 是保留名 |
| `register(skill)` | 注册内存 runtime 技能，返回 disposer（`:249-257`） | 面板可以「虚拟技能」（不落盘）；同层同名先到先得并 warn |
| `list(options)` | `SkillViewOptions { cwd?, scope?, signal? }` → `SkillSummary[]`（`:258-266`） | 只给摘要，不读正文 |
| `snapshot(options)` | → `{ skills, complete }`（`:267-274`） | **`complete:false` 表示有 provider 失败/失效中**，本次不入缓存，消费方应保留 last-good |
| `get(name, options)` | → `SkillDefinition | undefined`（`:275-284`） | 正文每次都现读；名称非法返回 undefined 不抛 |
| 事件 `skills/change` | 无参数、**未过滤**（`:199-213`） | 只是「可能变了」，消费方需按自己的 cwd/scope 重新拉 |

关键语义：

- **`scope` 省略 = 只看 global 层**（`:298-311` + `dsh-scope` 的 `chainLayers(undefined)` 返回空）。要拿「某个 agent 实际看到的目录」必须传 `scope: agent`。
- 缓存键含 `cwd`，所以多个工作区互不污染（`:395-401`）。
- 没有 provider/rank 的公开枚举 API；也不能删除/隐藏某个文件来源的技能（除了直接改盘）。

### 1.5 「停用技能」到底有没有原生支持 【已验证事实 + 结论】

**没有。** 全量 grep `disable` 在三个技能包中只命中 frontmatter 的 `disable-model-invocation` / 拒绝旧键的逻辑（`dsh-skill-filesystem/lib/index.js:863-891`），以及 tool-skill 对「不可模型调用」的报错文案（`dsh-tool-skill/README.md:61,89`）。

澄清三个容易混淆的概念：

| 概念 | 机制 | 效果 | 是否算「停用」 |
|---|---|---|---|
| `disable-model-invocation: true` | frontmatter → `invocation.modelInvocable=false` | 模型 catalog / `skill` 工具看不到；用户仍能 `/name` 调用（`user-invocable` 默认 true） | 半停用，且仍会被 `snapshot` 列出 |
| `user-invocable: false` | frontmatter → `userInvocable=false` | 不出现在 `/` 菜单与 `/skills` 选择器 | 半停用 |
| 两个都关 | 双 false | 仍被 list/snapshot 返回，只是两个消费面都过滤掉 | 逻辑停用但文件仍被解析、仍占一次解析成本 |

**真正「停用」= 让发现器看不到它。** 可行的无内核改动手段：

1. **改名**：`<root>/<name>/SKILL.md` → `SKILL.md.disabled`（目录束），或 `<name>.md` → `<name>.md.disabled`（平铺）。发现器只认固定文件名/`.md` 后缀（`:595-628`），改名后立刻不在 catalog；Chokidar 会收到 `unlink SKILL.md`（`:564` 判定为相关）→ 失效 → 下一步目录更新。**这就是既有 Web 插件 `W/lib/skill-files.js` 的做法（`W/README.md:245`：「停用 = 把 `SKILL.md` 改名为 `SKILL.md.disabled`」）。**
2. 移到扫描根之外（等价，但丢失「就地可见」语义，迁移恢复要记路径）。
3. 改 frontmatter 双 false（最不推荐：仍解析、仍列出、且改正文会触发失效）。

风险：改名/移动是**真实文件操作**，涉及用户磁盘；跨设备/权限失败要回滚；软链接目录要小心（`path` 保留符号链接形态，`realpath` 相关逻辑见 `:516-551`）。「bundled 600」根通常位于安装包内，升级会覆盖，**应视为只读**（内核未强制，属产品约定；既有实现同样禁改 `W/README.md:247`）。

### 1.6 bundled（随包）技能如何注册 【已验证事实】

- 机制：`config.bundledSkillDir`，缺省 `includeDefaultRoots && process.env.DSH_BUNDLED_SKILL_DIR`（`dsh-skill-filesystem/lib/index.js:83-84`），以 rank 600 / source `bundled` / `trustedHost: true` 加入根列表（`:191-196`）。
- `trustedHost` 会放宽读取通道（`parseSkillFile(..., true)`，`:127,608`），但仍然是同一套 frontmatter 规则。
- dsh-tui 的用法：启动器把包内 `guide/` 目录塞进 `DSH_BUNDLED_SKILL_DIR`（`T/bin/dsh-tui.js:94-98`），`guide/dsh-tui-guide/SKILL.md` 就是内置手册技能。
- ⚠️ 但 TUI 又禁用了 host 级 `skill-filesystem`（见 1.7）；实际生效的是 preset 里重新挂载的 `skill-filesystem`，它读同一个环境变量（构造函数缺省逻辑），所以 bundled 技能仍出现（【推断】需在 TUI 会话里 `/skills` 验证）。

### 1.7 对 dsh-tui 的直接影响（本任务最关键的现状）【已验证事实】

TUI bundle patch 的行为（`T/cordis.patch.yml`）：

| 行 | 内容 | 行号 |
|---|---|---|
| 技能 | `- id: skill-filesystem` → `disabled: true` | `T/cordis.patch.yml:87-88` |
| 工具 | `- id: tool-skill` → `disabled: true` | `T/cordis.patch.yml:139-140` |

原因写在注释里：模型面插件集「搬进 preset 注册表」，host 行禁用以免 minimal preset 泄漏 host 工具（`T/cordis.patch.yml:57-69`）。
技能实际由 preset 挂载：`T/presets/liangshen/agent.cordis.yml:231-247` 挂了 `skill-filesystem`，并用自定义 `./skill-search.mjs` 替代 `dsh-tool-skill`（注释解释了移除 9KB 常驻 catalog 的动机）。
TUI 自己消费技能目录的地方：`T/lib/types/dsh-adapter/channel/skill-catalog.js`，用 `registry.snapshot({ scope: agent, cwd })` 来渲染 `/skills` 选择器与 `/name` 命令（同文件 `viewOptions`/`registryFor` 在 `:25-26`，调用点在 `:51,62,98,103`）。

对本项目的三条硬结论：

1. **host 层 `ctx.skills.snapshot({cwd})` 不带 scope 会得到空表**（global 层只有注册表本身，provider 在 preset 层）。面板若想「只读展示模型可用目录」，必须拿到 agent（session）scope；TUI 内可用 `serviceForAgent` 式做法（`T/lib/types/dsh-adapter/channel/skill-catalog.js`）或订阅 `agent/created`。
2. **面板「管理视图」更适合直接扫盘**：按 1.2 的根/格式规则自己扫，才能看到 `SKILL.md.disabled`、非法技能、被遮蔽的重名项——这些 `ctx.skills` 都不提供。既有 Web 实现就是扫盘（`W/lib/skill-files.js`）。
3. **技能热加载不需要 TUI 侧做任何事**：改盘即可（1.3）。TUI 自己的 catalog 读取走 `snapshot`，所以面板改完盘，下一轮 `/skills` 拉取就会看到（【推断】取决于 TUI 的刷新时机）。

---

## 2. MCP 子系统（dsh-mcp-client / dsh-mcp-resources）

### 2.1 模型：一个 MCP server = 一个 loader entry = 一个插件实例 【已验证事实】

- 包注释明确：「Each plugin instance connects to one MCP server; load multiple instances in `cordis.yml` for multiple servers」（`dsh-mcp-client/lib/index.js:747-760`，同 `lib/types/index.d.ts:1-14`）。
- `apply()` 干五件事：解析 reconnect 策略 → 在当前注册域内**预留 `serverName`**（`WeakMap` 按 `scopeOf(ctx) ?? ctx.root` 分域）→ `startConnection` → `registerServerContext`（资源与 instructions）→ 等 `ready`，`failOnStartupError` 时抛错（`dsh-mcp-client/lib/index.js:810-834`）。
- 工具命名：`mcp__<serverName>__<rawName>`，超长/非法字符时追加 12 位 sha256 后缀（`:96-100`，`lib/types/tools.d.ts` 注释有完整契约）。**名字是稳定契约**，改动会破坏会话历史与权限规则。
- 同名 serverName：同一 scope 内重复 → 加载即抛错（`:819`）；**不同 scope 允许复用同名**（`:770-780` 注释：Agent-scoped MCP servers may reuse a namespace in another Agent）。

### 2.2 Config schema（面板表单可以直接照抄）【已验证事实】

`dsh-mcp-client/lib/index.js:781-801`（类型见 `lib/types/index.d.ts`）：

| 字段 | stdio | http | 默认 | 约束 |
|---|---|---|---|---|
| `transport` | `'stdio'` | `'streamable-http'` | 必填（union 判别键） | 二选一 |
| `serverName` | ✓ | ✓ | 必填 | `/^[A-Za-z0-9_-]{1,32}$/`，同 scope 唯一 |
| `command` | ✓ | — | 必填 | 直接 exec，不经 shell |
| `args` | ✓ | — | `[]` | 不做 shell 插值 |
| `env` | ✓ | — | `{}` | 叠加在「清洗过的父环境」之上；`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 会被剔除（README「Environment scrubbing」） |
| `cwd` | ✓ | — | `""` | 子进程工作目录 |
| `url` | — | ✓ | 必填 | MCP endpoint |
| `headers` | — | ✓ | `{}` | |
| `toolCallTimeoutMs` | ✓ | ✓ | `60000` | 每次工具调用/资源请求 |
| `failOnStartupError` | ✓ | ✓ | `false` | true 时初始连接/同步失败 → 插件 activation 失败 |
| `maxInstructionBytes` | ✓ | ✓ | `32768` | 超限拒绝连接 |
| `reconnect` | ✓ | ✓ | 见下 | `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}` |

`reconnect` 的子 schema 在 `:775-780`，默认值常量在 `lib/types/connection.d.ts`（`RECONNECT_DEFAULTS`）。断连语义：工具**保留在列表里但调用失败**；10 次连续失败后注销该 server 全部工具并停止重连，只有 reload/重启能恢复（README「Startup, updates, and reconnection」）。

### 2.3 一行 MCP 配置是怎么被组合加载的 【已验证事实】

1. profile 的 `package.json` 声明 `dsh.profile.bundles`（有序 bundle 列表，内核类型只有 `bundles?: string[]`，见 `dsh-package-manifest/lib/types/types.d.ts:76-80`）。
2. patch 叠加顺序：**各 bundle 的 patch（按 bundles 顺序）→ profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`（home 层）→ 启动器 `--patch` overlays → telemetry 开关**。实现 `dsh-app-boot/lib/index.js:1908-1918`；文件名常量 `PROFILE_PATCH_FILENAME` 在 `:1326-1327`。
3. patch 语义（`cordis-plugin-include/lib/types/patch.d.ts:3-13`）：顶层是 patch 数组，元素可 `id` 定向覆盖、`insert` 插入新行、`disabled` 开关；插入的行**必须有唯一 id**（「Runtime changes are routed back to an inserted entry by its id」）。**定向 patch 会整体替换该行的 `config`**（TUI patch 注释亦明说 `T/cordis.patch.yml:6-7`）→ 面板改配置必须写全量字段，不能只写 diff。
4. Loader 把行变成插件实例；`disabled` 是入口开关而不是删除（见 2.4）。
5. 想加 MCP：往目标 patch 文件插一行（或改写已有行）；想删：删掉自己 `insert` 的行；**bundle 自带的行使不能「删」，只能 `disabled: true` 覆盖**。

### 2.4 HMR 对 patch 的热加载边界 【已验证事实】

**触发链**（`dsh-hmr/lib/index.js`）：

- HMR 只在存在 `profileContext` 时监听 profile 与 home 两份 patch：`const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]`，逐个 `watchConfig(...)`，**任何内容变化都调 `reconcileProfile()`**（`:830-873`）。`refresh()` 先比对「bundles 列表 + 两份 patch 原文」，完全没变则跳过（`:853-864`）。
- `watchConfig`：Chokidar 监听目标文件，**默认 `awaitWriteFinish: true`**（`:49-64`），add/change/unlink 都触发，串行 + 合并（`:66-87`）。
- `reconcileProfile` → `recomposeProfile`（`dsh-app-boot`）：把新 patch 列表写回 root Include 的 config，`await entry.update(...)`，然后 `await loader.await()`（`dsh-app-boot/lib/index.js:4547-4620`，核心在 `:4596-4609`）；被移出 patch 的行会 `disabled=true` 后 `remove`，并等 fiber 结束（`:4568-4584`）。
- Loader 侧 `Entry.update`：`disabled` 为真 → `await this.fiber?.dispose()`（**断连、注销工具**），否则按变化重启/`_patchContext`（`cordis-plugin-loader/lib/index.js:498-519`）。`disabled` 支持 `!!js` 表达式，每次装载/重算时对 loader ctx 求值，原始 YAML 保留（`:462-478`）。
- HMR 自身前置条件：`const profile = this.ownerContext.get("profileContext")`，且必须有 `appReady`，否则直接抛 `Profile HMR requires application readiness`（`dsh-hmr/lib/index.js:830-833,1326-1328`）。base bundle 的 `hmr` 行即 `disabled: !!js "!ctx.get('profileContext')"`（`dsh-base/cordis.patch.yml:28-30`）。
- **dsh-tui 提供 `profileContext`**：`T/lib/types/dsh-adapter/host-dsh.js:302-303` 在挂载 root include 之前 `ctx.provide('profileContext', ...)`（`mountRootInclude` 在 `:374-375` 附近）。TUI patch 未禁用 `hmr` 行 → **TUI 的 DSH kernel 路径上 HMR 应当启用**（【推断】，见第 6 节待实测项）。
- **`patchReload` 键**：全量 grep 安装目录（含所有 `lib/*.js` 与 package.json）**0 命中**。web/dsh-tui profile 的 `"patchReload": "live"` 属无效遗留键，对 0.2.2-rc.1 无作用。【已验证事实】

**hot reload 的边界（必须写进 UI 提示）**：

- HMR 的 patch 重算会**替换/重启**受影响的 entry（MCP 连接重建、工具先注销再注册），不会重启进程；
- 但**代码模块替换**受 `root` 监听与模块缓存限制，host 依赖图里的模块只能重启（`dsh-hmr/README.md` Known Limitations）；改「本插件自身」的代码在 TUI 中通常要重启 TUI 进程（本会话不验证）；
- `package.json` 里 bundles 列表变化才触发 manifest 重载；单纯依赖升级要等下一次重算或重启（`dsh-hmr/README.md`）；
- HMR 不监听启动器 `--patch` overlay 文件（`overlays` 只在启动时读入）。

### 2.5 `disabled` 的精确语义（面板「启停 MCP」就是它）【已验证事实】

- 判断是**沿父链传播**的：`Entry.disabled` 若有祖先 group 禁用也算禁用（`cordis-plugin-loader/lib/index.js:462-471`）。
- 禁用 = entry 保留在树里、fiber 被 dispose；重新启用 = `init()` 重新导入并 apply（即 MCP 重连、工具重新注册）。
- 官方**程序化入口**：`ctx.pluginManager.setPluginEnabled(entryId, enabled)` → `writePluginEnabled(...)` 用 YAML 文档级编辑把 `- id: <row>\n  disabled: true|false` 写进 profile 的 `cordis.patch.yml`（保留注释；若该行是纯 id+disabled 且删掉后行为等价则直接删行），随后 `reload()` 即时重组（`dsh-plugin-manager/lib/index.js:1139-1181,2669-2682`）。返回 `ChangeResult.application ∈ applied | restart-required | overridden | failed | cancelled`（`lib/types/types.d.ts:148-177`，`RestartReason` 在 `:46-52`）。
- 前提：`pluginManager` 服务可用（base 行 `disabled: !!js "!ctx.get('profileContext')"`，`dsh-base/cordis.patch.yml:20-22`）。它 `listPlugins()` 返回的条目**只有 entryId / moduleName / enabled / fiberPhase / diagnostic，没有 config**（`dsh-host-plugin-inventory/lib/types/types.d.ts:8-19`，`PluginInfo` 见 `dsh-plugin-manager/lib/types/types.d.ts:53-60`）→ **读/写 serverName、command、env 这些字段必须自己解析 patch YAML**，官方 API 只负责启停。
- ⚠️ 与既有 Web 插件对照：后者**不用** pluginManager，而是自己维护受管块并直接改 patch 文件（`W/README.md:207-215,249-251`），把整件事的兼容责任留在自己手里。

### 2.6 工具注册、`tools/change` 与「单工具禁用」 【已验证事实】

- MCP 工具注册到 `ctx.tools`（scoped registry）。工具层的每次变更都会触发 `tools/change`：`layers = new ScopedLayers(..., () => this.ctx.emit("tools/change"))`（`dsh-tools/lib/index.js:410-412`）。
- **单工具禁用的内核机制是 `ctx.tools.restrict(filter)`**（`dsh-tools/lib/index.js:453-468`，类型 `lib/types/contracts.d.ts:354-365`）：
  - 只能施加在 **scoped ctx**（agent 或其祖先）上；unscoped 直接抛 `tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent`（`:453-455`）。
  - `allow`/`deny` 至少给一个，空 filter 抛错（`:458`）；不能点名 PTC 保留名 `run_code`（`:463`）。
  - **名字必须在「可限制集合」里，否则抛错并列出已知工具**（`:464-466`）。可限制集合 = 继承来的（global/祖先）工具；**本 scope 自己注册的工具不可被 restrict**（`:477-508`）。
  - 效果：被 deny 的工具从该 agent 的模型 schema 里消失（真省上下文），不是调用时才拒绝。
  - 生命周期：跟随注册 ctx 的 effect，scope 销毁即解除；**不持久化**（进程内状态）。
- 既有实现踩过的坑（`W/lib/tool-filter.js` 头注释，实测记录）：`tools/change` 同步 emit + 监听器里再 `restrict/undo` → 同步无限递归烧 CPU。必须做「重入守卫 + 签名去重 + 监听器集中持有」。
- 对 MCP 的推论（【推断】）：
  - host 级挂载的 MCP 工具是 global 注册 → 可用 `agent` scope 的 `restrict` 选择性隐藏；
  - 若要「每个 agent 单独配置隐藏哪些 MCP 工具」，需订阅 `agent/created` 在 `agent.ctx` 上 restrict（`agent.ctx` 见 `dsh-agent/lib/types/runtime-types.d.ts:176`；事件 schema `:254-258`）；
  - 若 MCP 改成 **agent scope 挂载**（见 3.4），工具变成「own registrations」，**restrict 对其无效** → 单工具过滤必须在挂载前/挂载时做，而 `dsh-mcp-client` 没有过滤配置项（2.2 无 `allow/deny/filter` 字段）。→ 这是一条真实的「二选一」约束。

### 2.7 「测试连接」有哪些可复用内核能力 【已验证事实 + 方案】

内核**没有**「测试 MCP 连接」的公开 API：`dsh-mcp-client` 的导出只有 `Config, apply, createMcpToolDefinition, inject, name`（`lib/index.js:836`），package `exports` 只暴露 `.`（无 `./transport`、`./connection` 子路径）。可选三条路：

| 方案 | 怎么做 | 优点 | 代价/风险 |
|---|---|---|---|
| A. 直接 MCP SDK | 用与内核同代的 `@modelcontextprotocol/client@2.2.0`：`Client` + `StdioClientTransport` / `StreamableHTTPClientTransport`（导出名已核实：`K/node_modules/@modelcontextprotocol/client/dist/index.d.mts` 与 `dist/stdio.d.mts`），`connect` → `listTools` → `close` | 轻、可控超时；能拿到 tools/resources 列表做 UI 预览 | 复制一份 transport/env 清洗逻辑；与内核版本漂移需自行跟（内核锁 2.2.0；既有 Web 插件用的是旧代 `@modelcontextprotocol/sdk@1.32.2`，**两代 SDK 不可混用**） |
| B. 临时挂载真插件 | 在**一次性 scope**（如 `createScope(ctx, {})`，或用某个专用 agent scope）里 `ctx.plugin(dshMcpClient, config)`，用 `failOnStartupError: true`，成功/失败后 dispose | 100% 复用内核连接/清洗/超时逻辑 | 会短暂注册工具、触发 `tools/change`；stdio 要真起进程；失败路径要保证 dispose |
| C. 复用 `createMcpToolDefinition` | 只适配单个工具定义，**不做连接** | — | 与「测试连接」无关，仅列此排除 |

【推断】首版推荐 A（简单、无副作用），B 作为「要显示服务器实际工具列表」时的备选。

### 2.8 作用域能力：MCP 其实支持 agent scope，只是配置面不支持 【已验证事实】

- `serverName` 预留按 scope 分域（2.1），不同 agent 可各自挂同名 server。
- `dsh-mcp-resources` 是**按调用 agent 的 scope 解析 server**：`const provider = this.layers.merge(exec.agent, (layer) => layer.servers).get(server)`，找不到抛 `MCP resource server "<server>" is unavailable in this agent's scope`（`dsh-mcp-resources/lib/index.js:160-176`）；`list`/`prompt` 也用 `exec.agent`/scope 做 merge（`:123-125`）。
- 因此：**「配置来源」只有 profile patch；「运行时挂载」可以落在任意 scope。** 这是理解第 3 节的关键区分。

---

## 3. 「全局 vs 工作区」：DSH 既有语义盘点

### 3.1 DSH 里各层的真实含义 【已验证事实】

| 维度 | 是否有「工作区」概念 | 实际承载物 | 证据 |
|---|---|---|---|
| 插件组合 / loader 行 | ❌ 只有 profile + home + 启动器 overlay | `cordis.patch.yml` 分层 | `dsh-app-boot/lib/index.js:1908-1918`；`dsh-package-manifest/lib/types/types.d.ts:76-80` |
| settings（可视化改配置） | ❌ profile 级 | 写回当前 profile 的 patch；home patch 与 CLI overlay 优先级更高，会拒绝写入 | `dsh-settings/README.md`「Use this package」（"Changes persist through the active profile's Cordis patch"）；`dsh-settings/lib/types/index.d.ts:73-118` |
| credentials | ❌ 单库 | `$DSH_HOME/.credentials.yaml` + 环境变量/项目 `.env`/用户 `.env` 回退 | `dsh-base/cordis.patch.yml:113-116,125-126`；`dsh-credentials/README.md` |
| workspace（项目实体） | ✅ 但是「记录」不是「配置域」 | `ctx.workspaceRegistry` 的持久化记录（canonical path、标题、session 归属、排序、归档/pin） | `dsh-workspace/lib/types/spec.d.ts:20-40`；README |
| scope（隔离域） | 部分（= agent / preset） | `ScopeKey`（agent 对象本身），注册按 scope 分层 | `dsh-scope/lib/types/index.d.ts`；`dsh-agent-loop/lib/index.js:543`（`this.scope = createScope(loopCtx, this)`） |
| cwd（发现根） | ✅ 真正的「工作区敏感」维度 | 技能根 = 最近 `.git` 祖先；沙箱 workspaceRoot 也取 `process.cwd()` | `dsh-skill-filesystem/lib/index.js:160-198,821-828`；`dsh-base/cordis.patch.yml:243-247` |

**结论：DSH 没有「按工作区存插件配置」的容器。** 唯一天然按工作区变化的输入是 **lookup cwd**（技能、文件工具、sandbox 根、workspace 记录都从它派生）。MCP 没有 cwd 敏感的任何接口。

### 3.2 技能为什么「天然区分全局/工作区」

因为 provider 的 `list(options)` 接收 `cwd`，每次 lookup 现算根列表（`dsh-skill-filesystem/lib/index.js:92-118`），注册表缓存键也含 cwd（`dsh-skill/lib/index.js:395-401`）。
所以「全局技能」= 用户根（400/500）；「工作区技能」= 项目根（100/200）。UI 只要按 rank/source 分组即可，无需任何内核改动。

唯一要小心的语义错位：TUI 的 workspace 记录（`ctx.tuiWorkspaces`，含 id/path/title/sessionCount，见 `T/lib/types/adapter/ports/channel-workspace.d.ts:27-38`、`T/lib/types/dsh-adapter/workspaces.d.ts:72`）与技能发现用的 projectRoot **不是同一个东西**。面板要显示「工作区 X 的技能」，必须用 `findProjectRoot(workspace.path)` 之后的目录（且没有 `.git` 时等于 workspace.path）。否则会出现「面板说有、模型看不到」。

### 3.3 MCP 为什么只有 profile 级

- MCP server 只是 loader 行（2.1），行的来源是 patch 文件（2.3），patch 层级只有 bundle/profile/home/--patch，**没有任何一层的路径与 cwd 或 workspace 绑定**。
- `PluginManager`（官方启停 API）也只操作「当前 profile 的 patch」（2.5）。
- settings 同样只写 profile patch（3.1）。
- 所以：**要「这个工作区启用哪些 MCP」，内核里没有一个地方能存。**

### 3.4 若首版要做「工作区级 MCP」，四条可行路径与代价

| 方案 | 做法 | 热生效? | 代价/风险 | 建议 |
|---|---|---|---|---|
| **A. 收敛为 profile 级**（推荐首版） | UI 上「全局」= 当前 profile 的 patch；「工作区」一栏对 MCP 显示为「不支持」或「工作区预设（保存后切换 profile）」 | ✅ 编辑 patch 即热加载 | 无法真正做到不同工作区用不同 MCP；用户心智需要文案解释 | ⭐️ 首版 |
| **B. 按 workspace 存「启停集合」，实际仍写 profile patch** | 面板维护 `<ws>` 维度元数据（哪些 server 在工作区 Y 启用），切换到该 workspace 会话时改写 profile patch 的 `disabled` 位 | ✅（HMR） | 本质是「单例全局状态 + 跟随切换」，**多会话不同 workspace 并发时会互相踩**（TUI 可同时开多个 workspace 的 session）；每次切换都重建 MCP 连接 | 可作为过渡，必须显式提示限制 |
| **C. 插件动态挂载到 agent scope** | 订阅 `agent/created`，按该 agent 的 session cwd 匹配工作区配置，`agent.ctx.plugin(dshMcpClient, config)`（`ctx.plugin` 见 `cordis/lib/types/registry.d.ts:198`）；scope 销毁自动断连 | ✅（随 agent 生命周期） | ① 每个 agent 一份连接（stdio 每 agent 起一个子进程）→ 资源成本；② 工具成为 scope 内注册，**restrict 单工具过滤失效**（2.6）；③ serverName 每 scope 唯一所以不冲突（2.8），但无法复用连接；④ 需要自己持久化配置（无内核容器）；⑤ scope 是隔离不是鉴权（`dsh-scope/README.md` 明确非安全边界） | 真正满足需求的方向，成本最高 |
| **D. 插件自建「工作区 patch 合并」** | 在 `readProfilePatches()` 结果后追加 `<ws>/.dsh/mcp.patch.yml`，调 `reconcileProfilePatches` 重组 | ✅（但每次都重建） | 需要 hook 应用启动/切换流程（`profileContext.overlays` 由启动器提供，是只读快照）；同一进程只能有一份全局树，多 workspace 并发不可行；与 HMR 自己的重算可能互相覆盖；属「改动 DSH 组合语义」的高风险做法 | 不推荐 |

另外两条次要路径：**home patch**（`~/.dsh/cordis.patch.yml`，跨 profile 但仍是「全局」，且优先级高于 profile patch，会压过用户配置）与 **profile patch + 自定义 profile**（用「一个工作区一个 profile」模拟，代价是切换即不同进程/重登录）。两者都不给工作区语义。

---

## 4. 热加载矩阵（操作 → 机制 → 是否重启）

前提：TUI 运行在 DSH kernel 路径（`profileContext` 已提供 → HMR 生效，【推断】见 6.2）。

| # | 用户操作 | 内核机制 | 需要重启？ | 生效时机 | 证据 |
|---|---|---|---|---|---|
| 1 | 新增技能（建目录/`.md`） | Chokidar add → `queueInvalidation` → `skills/change` | ❌ | 下一步模型请求前（catalog 替换消息） | `dsh-skill-filesystem/lib/index.js:445-456,476-485`；`dsh-tool-skill/lib/index.js:935-960` |
| 2 | 删除技能 | Chokidar unlink → 同上 | ❌ | 同上 | 同上 |
| 3 | 改技能正文（不改 frontmatter） | 无失效；`get()` 每次现读 | ❌ | 下一次 `get`/`skill_load` | `dsh-skill-filesystem/lib/index.js:125-144` |
| 4 | 改 frontmatter（name/description/调用策略） | Chokidar change → 失效 | ❌ | 下一步 | `:555-564` |
| 5 | 停用/启用技能（改名 `.disabled`） | unlink/add of `SKILL.md` → 失效 | ❌ | 下一步；`/skills` 选择器下次拉取 | `:564,595-628`；`W/README.md:245` |
| 6 | 新建一个此前不存在的技能根（如首次建 `<ws>/.dsh/skills`） | `fs.watchFile` 轮询祖先直到出现 → 换 Chokidar | ❌（有最长 `watchPollIntervalMs`=100ms 级轮询延迟） | 出根后的下一次 lookup | `:342-380,516-551` |
| 7 | 迁移技能到全局/另一工作区 | 真实复制/移动文件 → 两端目录事件 | ❌ | 下一步 | 组合 1/2 + 5 |
| 8 | 新增/编辑/删除 profile patch 中的 MCP 行 | HMR `watchConfig`（awaitWriteFinish）→ `reconcileProfile` → `recomposeProfile` → Loader update | ❌（条目级重启，进程不重启） | 文件落盘稳定后（1～2 秒级：`awaitWriteFinish` 2s 窗口 + debounce/串行） | `dsh-hmr/lib/index.js:49-64,830-873`；`dsh-app-boot/lib/index.js:4547-4620` |
| 9 | 启用/停用已有 MCP 行（`disabled: true/false`） | Loader `update` → 禁用则 dispose fiber（断连+注销工具），启用则 `init()` | ❌ | 同上 | `cordis-plugin-loader/lib/index.js:462-478,498-519` |
| 10 | 改已加载 MCP 的 config（command/env/url…） | entry restart（dispose→init）→ 连接重建 | ❌（连接会中断重建） | 同上 | 同上；README「Editing the configuration entry reloads the server connection in place」 |
| 11 | 用 `pluginManager.setPluginEnabled` 启停 | 写 profile patch（`- id/disabled`）→ `reload()` | ❌（`application` 会显式返回 `applied`/`restart-required`） | 调用返回即已应用 | `dsh-plugin-manager/lib/index.js:1139-1181,2669-2682` |
| 12 | 单工具禁用（restrict） | agent scope 上 `tools.restrict` → `tools/change` | ❌ | 下一次工具 schema 组装（下一步） | `dsh-tools/lib/index.js:410-412,453-468` |
| 13 | 技能分组 / MCP 分组顺序 / 自定义标签 | **无内核机制**，插件自存元数据文件 | ❌ | 插件自己刷新 | `W/lib/groups.js`（对照实现） |
| 14 | 改 MCP server 的 OAuth token 等配置 | 同 #10（写回行 config → 热重载） | ❌ | 同上 | `W/README.md:207-210` |
| 15 | 改管理插件自身的代码 | HMR 模块替换（需 profile 内文件变更 + 模块可替换） | ⚠️ 通常需要重启 TUI（终端进程持有 UI 运行时） | — | `dsh-hmr/README.md` Known Limitations |
| 16 | 改 `package.json` 的 `dsh.profile.bundles` | HMR 监听 manifest → recompose、装载新 bundle | ❌（新包要已安装；依赖变化可能 `restart-required`） | 保存后 | `dsh-hmr/lib/index.js:849-873` |
| 17 | 改技能发现根的配置（如 `customSkillDirs`） | 属插件 config → 需改 patch 行 → 热重启该插件条目 | ❌ | 同 #9/#10 | 2.3/2.4 |
| 18 | 改 home patch（`~/.dsh/cordis.patch.yml`） | HMR 同样监听 | ❌ | 同上 | `dsh-hmr/lib/index.js:850,872` |
| 19 | 依赖 `patchReload: live` | **无实现** | — | — | 0 命中（见 2.4） |

**明确的「必须重启」场景**（写给 UI 的不可能清单）：

- 改到 host 依赖图里的模块 / 未受 Loader 管理的插件代码（`host-module`、`unmanaged-plugin`，见 `dsh-plugin-manager/lib/types/types.d.ts:46-52`）；
- 替换/移动了包目录（`package-moved`）；
- 没有 HMR 的 profile（`no-hmr`）——TUI 的 DSH kernel 路径下不适用；
- 进程本身的工作目录 / `process.cwd()` 相关设置（sandbox workspaceRoot 等在 base patch 用 `process.cwd()` 求值，patch 只在装载时求值）。

---

## 5. 首版能否不改内核实现全部需求？

### 5.1 逐条需求判定

| 需求 | 零内核改动？ | 实现方式 | 妥协/风险 |
|---|---|---|---|
| 可视化列出技能（含全局/工作区） | ✅ | 自行扫盘（4 个默认根 + bundled），或 `ctx.skills.snapshot({cwd})` | 两者取舍见 1.7；建议扫盘为主、snapshot 为辅 |
| 可视化启停技能 | ✅ | 改名 `SKILL.md` ↔ `SKILL.md.disabled`（或移动），热生效 | **没有原生 disable**；改名是文件操作，需回滚/权限处理；bundled 只读 |
| 可视化增删技能 | ✅ | 复制/删除文件；支持 `.md`、目录束、（可选）zip | 写盘需校验 frontmatter、重名（目标 scope 内）、编码；失败回滚 |
| 可视化启停 MCP | ✅ | 改 patch 行 `disabled`（或 `pluginManager.setPluginEnabled`）→ HMR 热重载 | 只能 profile 级；工具名/连接会重建 |
| 可视化增删 MCP | ✅ | 改 profile `cordis.patch.yml`（insert / 删除自己插入的行） | 需自己解析+保留注释与原文字节；`- insert` 行必须有唯一 id；行 config 整体替换 |
| 可视化改 MCP 配置（env/headers…） | ✅ | 同上 | 必须写全量 config；`!!js` 表达式原样保留；密钥要脱敏展示（`${NAME}` 约定） |
| MCP 测试连接 | ✅ | 直接 MCP SDK（推荐）或临时挂插件实例 | 内核无现成 API；SDK 两代不可混用 |
| 分组（技能/MCP） | ✅ | 插件自存元数据（建议 `~/.dsh/skills/.system/<plugin>/`，该目录被 provider 跳过且不触发监听：`dsh-skill-filesystem/lib/index.js:185,559,599`） | 分组只是显示层；文件被外部移走后要容错 |
| **区分全局 vs 工作区（技能）** | ✅ | 按 source/rank 分组；工作区路径用 projectRoot 规则 | 必须与「最近 `.git` 祖先」对齐（3.2） |
| **区分全局 vs 工作区（MCP）** | ❌（只能模拟） | 方案 A/B（3.4） | **这是唯一真正需要妥协的需求**：真正的工作区级 MCP 需要「per-agent scope 动态挂载」自研（方案 C），代价是每 agent 一份连接 + 失去 restrict 过滤 + 自管配置存储 |
| 单工具禁用（MCP） | ✅（有条件） | `agent` scope 上 `ctx.tools.restrict({deny})`，随 `agent/created` 施加 | 仅对 host 级（global）注册的工具有效；名字必须已存在（需重试）；不持久化（自己存 deny 列表）；有 `tools/change` 重入坑 |

### 5.2 会不会需要改内核？

**不需要改内核就能覆盖 8/9 条需求**（全部技能 + 全部 MCP CRUD/启停/配置/测试 + 分组 + 单工具禁用）；唯一的硬缺口是「工作区级 MCP」。缺口不是 API 缺失，而是**没有持久化容器**：内核不提供「按工作区存插件配置」的位置，且 loader 树是进程级单例。要「原生」支持，需要上游改动，方向至少包括其一：

- `profileContext` 增加 per-workspace overlay 的读取与 HMR 监听；
- 或 `dsh-mcp-client` 增加 declarative 的「按 cwd 启用/过滤」字段；
- 或提供 workspace→patch 的组合点（loader 子 Include 按 cwd 挂载）。

短期更现实的是**产品层妥协**：MCP 明确标注「全局（当前 profile）」，把「工作区」留给技能；或者采用方案 B（跟随当前 workspace 改写 disabled 位）并在 UI 上写明「多工作区并发会话不受支持」。

### 5.3 首版建议边界（供 Lead 决策）

- 必做：技能全生命周期 + 全局/工作区分组 + MCP CRUD/启停（profile 级）+ 测试连接 + 分组；
- 可选：MCP 单工具禁用（收益明确但坑已明——重入、名字不存在、仅 global 工具）；
- 缓做/需上游：工作区级 MCP；
- 所有「热加载」承诺要按第 4 节写成矩阵，不要笼统承诺「全部热生效」。

---

## 6. 未决问题与需要实测的事项

### 6.1 TUI 侧（本会话未启动进程，均未验证）

1. **HMR 在 dsh-tui 中是否实际生效**：代码路径显示 `profileContext` 在 `mountRootInclude` 之前 provide（`T/lib/types/dsh-adapter/host-dsh.js:300-303,374-375`），`hmr` 行条件因此为 false→启用；但需实跑一次「改 profile patch → 观察 MCP 行是否热重载」确认（含 TUI 是否在启动早期就 dispose 掉某些服务）。
2. **TUI 的 agent 创建路径**是否允许宿主插件在 `agent/created` 里拿到可用于 `ctx.plugin` 的 scope（loop 里 `createScope(loopCtx, this)`，`dsh-agent-loop/lib/index.js:543`），以及 TUI 自己的 session 生命周期是否会在 agent scope 之外再套一层。方案 C 以此为前提。
3. **TUI `/skills` 与 `skill-search` 的刷新时机**：preset 用的是自定义 `./skill-search.mjs`（`T/presets/liangshen/agent.cordis.yml:245-246`），未知它监听 `skills/change` 还是每步 snapshot；这决定「面板改盘后模型多快看到」。
4. **host 层 `ctx.skills.snapshot({cwd})` 是否确实为空**：需实跑确认（按 1.4/1.7 的代码推断为空表，若 TUI 在 host 也挂了 provider 则结论要修正）。
5. **`TuiWorkspaceEntry.path` 与 projectRoot 的实际偏离度**（有没有用户把 workspace 指到 git 子目录）。

### 6.2 内核/兼容性

6. **`patchReload` 键的来历**：0.2.2-rc.1 无任何引用（已验证）；需确认是否来自 dsh-tui 安装器/更早或更晚版本文档，避免未来版本把它变成真开关。
7. **`pluginManager.setPluginEnabled` 在 TUI 中是否可直接调用**：服务应存在（base 行条件满足），但它是 `TypertRemoteService`，是否要求请求上下文/权限，需要试一次；若不可用则退回「自己改 patch YAML」。
8. **MCP SDK 版本策略**：内核锁 `@modelcontextprotocol/client@2.2.0`；若面板自带 SDK，需保证与内核不同代时不会互相污染（既有 Web 插件用 1.32.2，说明两代可共存但不要互换 Client/Transport）。
9. **`tools.restrict` 与 MCP 工具重新同步的交互**：MCP server re-sync 会先 dispose 再 register 同批名字，restrict 的 deny 集合是否仍然命中、是否会因「暂时不存在」而抛 unknown（需实测；这会直接决定单工具禁用的实现健壮性）。
10. **HMR `awaitWriteFinish` 的 2 秒窗口**（`dsh-hmr/lib/index.js:56` 传 `awaitWriteFinish: true`）对 UI「保存 → 生效」的体感影响；面板应做「已保存，热加载中」的状态而不是假装瞬时。

### 6.3 需求侧待确认

11. 「工作区级 MCP」到底是「不同项目用不同 MCP」还是「同一 MCP 在不同项目用不同参数」（前者要方案 C/D，后者方案 B 足够）——直接决定首版是否要碰方案 C。
12. 技能「删除」的语义：永久删除 vs 软删除（移动到插件回收区）；内核无回收站概念，若要「可撤销」必须插件自己实现（既有 Web 实现有撤销，`W/README.md:111`）。
13. 单工具禁用是否属于首版硬需求（用户原话「可视化开启/关闭/删除/添加/分组」未点名单工具）。

---

## 附录 A：关键证据索引

- 技能注册表：`dsh-skill/lib/index.js:20-21,147-183,193-215,224-226,298-330,331-375,376-380,395-401,403-412,520`；类型 `dsh-skill/lib/types/index.d.ts:15-16,37-70,194-213,225-296`
- 技能发现/监听：`dsh-skill-filesystem/lib/index.js:20-24,30-60,83-84,92-118,125-144,160-198,342-394,445-456,476-485,516-564,566-576,595-628,678-718,821-828,863-892`
- 模型侧 catalog：`dsh-tool-skill/lib/index.js:935-960,1035-1037`；`dsh-tool-skill/README.md:12,57,85,61,89`
- MCP 客户端：`dsh-mcp-client/lib/index.js:747-768,774-801,810-834`；`lib/types/index.d.ts:16-89`；`lib/types/connection.d.ts`；`lib/types/tools.d.ts:46`（publicToolName 契约）
- MCP 资源：`dsh-mcp-resources/lib/index.js:123-125,160-176`
- HMR：`dsh-hmr/lib/index.js:49-116,767-772,820-874,1326-1328`；`dsh-hmr/lib/types/index.d.ts`
- patch 组合：`dsh-app-boot/lib/index.js:1326-1327,1908-1918,4520-4633`；`cordis-plugin-include/lib/types/patch.d.ts:3-13`
- Loader：`cordis-plugin-loader/lib/index.js:440-520,779-781`；`lib/types/config/entry.d.ts`、`lib/types/config/tree.d.ts:37-58`
- 工具注册表：`dsh-tools/lib/index.js:410-412,453-468,477-508`；`lib/types/contracts.d.ts:354-365`
- scope：`dsh-scope/lib/types/index.d.ts`；`dsh-scope/lib/index.js:162-169`；`dsh-agent/lib/types/runtime-types.d.ts:164-176,245-269`；`dsh-agent-loop/lib/index.js:543`
- 插件管理：`dsh-plugin-manager/lib/index.js:1139-1181,2669-2682`；`lib/types/index.d.ts:46-51,182-187`；`lib/types/types.d.ts:46-60,148-177`
- settings/workspace/credentials：`dsh-settings/README.md`、`dsh-settings/lib/types/index.d.ts:73-118`；`dsh-workspace/lib/types/spec.d.ts:20-40`；`dsh-base/cordis.patch.yml:105-127`
- TUI 现状：`T/cordis.patch.yml:57-69,87-88,139-140`；`T/bin/dsh-tui.js:94-98`；`T/presets/liangshen/agent.cordis.yml:231-247`；`T/lib/types/dsh-adapter/host-dsh.js:238-323`；`T/lib/types/dsh-adapter/channel/skill-catalog.js`；`T/lib/types/adapter/ports/channel-workspace.d.ts:27-38`
- 对照实现（既有 Web 插件）：`W/README.md:104-123,169-171,207-215,238-251`；`W/lib/tool-filter.js`（头注释含 restrict 三条实测结论与重入坑）

## 附录 B：只读复核命令（不修改任何文件）

```bash
K=/home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
# 技能发现根与 rank
grep -n "RANK\|findProjectRoot\|isRelevantWatchEvent" $K/dsh-skill-filesystem/lib/index.js
# 重名裁决与失效
grep -n "compareIndexedCandidates\|invalidateCache\|skills/change" $K/dsh-skill/lib/index.js
# MCP Config 与 serverName 预留
sed -n '774,834p' $K/dsh-mcp-client/lib/index.js
# patch 热加载
grep -n "watchConfig\|reconcileProfile\|PROFILE_PATCH" $K/dsh-hmr/lib/index.js $K/dsh-app-boot/lib/index.js
# 单工具过滤
sed -n '453,468p' $K/dsh-tools/lib/index.js
# 确认 patchReload 不存在
grep -rl "patchReload" /home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh | head
```
