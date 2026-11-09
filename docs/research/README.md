# 初期调研索引

本目录是 `dsh-tui-skill-mcp-panel` 开发前的初期调研，共四份，分别覆盖**宿主插件体系**、**参考实现**、**DSH 内核机制**、**生态与发布**。四份文档相互引用，结论汇总到 [`../需求文档.md`](../需求文档.md)。

- 调研日期：2026-11-07
- 目标基线：`@deepseek-harness-tui/dsh-tui` 0.19.0、`@deepseek-ai/dsh` 0.2.2-rc.1
- 证据约定：每份文档内部用【已验证事实】【推断】【未验证】分级；关键结论带文件路径 + 行号或 URL + 访问日期。
- **可信度边界**：所有「内核行为」均来自本机已安装包源码的静态阅读，**未启动 TUI 进程做运行时验证**；凡依赖运行时的结论都在各文档「未决问题」与本文 §4 中单列。

## 1. 文档索引

| 文档 | 回答的问题 | 最重要的产出 |
| --- | --- | --- |
| [`01-dsh-tui-plugin-architecture.md`](01-dsh-tui-plugin-architecture.md) | dsh-tui 的插件怎么装、接缝怎么用、终端里怎么做管理界面 | 接缝选择矩阵；`tuiScenes` 接入三步；场景/面板/对话框限制；技能/MCP 数据层读写矩阵；准入 A–G 适用性 |
| [`02-reference-web-plugin-dsh-skill-mcp-panel.md`](02-reference-web-plugin-dsh-skill-mcp-panel.md) | web 参考版是怎么实现的、哪些能复用 | 6 个纯 Node 模块（约 2488 行）可复用；字节保真 patch 编辑；三条必须继承的不变量；9 类历史坑 |
| [`03-dsh-skills-and-mcp-mechanisms.md`](03-dsh-skills-and-mcp-mechanisms.md) | DSH 内核里技能与 MCP 到底怎么工作 | 发现根与 rank 表；`*.disabled` 是唯一停用手段；MCP 只有 profile 级；热加载矩阵（19 项）；四条工作区级 MCP 方案与代价 |
| [`04-ecosystem-and-prior-art.md`](04-ecosystem-and-prior-art.md) | 有没有人做过、名字能不能用、怎么发布 | TUI 侧技能管理是空位；MCP 先例 `dsh-tui-mcp-manager` 已过时；命名可用；发布流程与共存风险 |

## 2. 跨文档共识（开发前必须知道的 12 条）

1. **技能真源是磁盘文件，不是 `ctx.skills`。** dsh-TUI 0.19 在 host 层禁用了 `skill-filesystem`（技能由 preset 在 agent 作用域挂载），host 插件 `ctx.skills.list()` 拿不到完整列表 → 面板必须按内核规则自行扫盘（01 §6.1、03 §1.7）。
2. **技能没有原生「停用」API。** 唯一无内核改动且热生效的手段是把 `SKILL.md` 改名为 `SKILL.md.disabled`（单文件同理），与 web 版约定一致（01 §6.1、02 §3.4、03 §1.5）。
3. **发现根有固定优先级**：项目 `.dsh/skills`(100) → `.agents/skills`(200) → custom(300) → `~/.dsh/skills`(400) → `~/.agents/skills`(500) → bundled(600)；同名按「近层遮蔽远层 → rank → provider 注册序」裁决（03 §1.2）。
4. **工作区 = `cwd` 向上最近含 `.git` 的祖先**，不是 TUI 的 workspace 记录；两者可能不一致（01 §6.1、03 §3.2）。
5. **frontmatter 非法 = 静默丢弃**（只有日志）。面板必须显式展示「文件存在但不可用」（03 §1.2）。
6. **MCP 一个 server = profile patch 里一条 `@deepseek-ai/dsh-mcp-client` loader 行**；持久化只有 profile 级，home patch 是跨 profile 的全局层，**没有工作区级容器**（01 §6.3、03 §3）。
7. **MCP 热加载两条路**：启停既有行走官方 `pluginManager.setPluginEnabled`（写 `disabled` + reload）；新增/编辑/删除行走 patch 文本字节保真编辑 + HMR 重组合（01 §3.5/§6.3、02 §4.3）。
8. **`patchReload: "live"` 在 DSH 0.2.2-rc.1 没有任何代码引用**，是无效遗留键；真正的热组合由 HMR 对 profile/home patch 的 watch 提供（03 §2.4）。
9. **MCP 编辑必须继承三条不变量**：受管块内外来行逐字节保留、`!!js` 表达式原样往返、`serverName + entryId` 双键定位（02 §0、§6.3）。
10. **UI 形态**：全屏 `tuiScenes` + `commands` 是唯一能承载「列表-详情-表单-分组」的组合；`tuiDialogs` 在场景内很可能不可见，`tuiPanels` 是实验性且只在 fullscreen 分栏出现，`tuiSettingsSections` 只能做插件自身偏好（01 §4.11、§5.4）。
11. **准入与发布**：能装能跑只需 `package.json` + `dsh.bundle.patch` + `cordis.patch.yml`；进生态必须补 `dsh-plugin.json`（manifest v0.15）+ A–G 清单 + 真实 TTY 验证（01 §8、04 §1.3）。
12. **共存风险**：web 版与 TUI 版都会改 `~/.dsh/skills`、profile patch 与 groups.json；必须共用磁盘约定（`*.disabled`、groups v1、`<patch>.panel.lock`），**受管块 marker 必须不同名**（04 §3.5）。

## 3. 对需求文档的直接输入

| 需求主题 | 调研结论 | 文档锚点 |
| --- | --- | --- |
| 首版 UI 形态 | `tuiScenes` 全屏场景 + `/skill-mcp` 命令 | 01 §4.1、§4.11 |
| 技能列表来源 | 自行扫盘，不依赖 `ctx.skills` | 01 §6.1、03 §1.7 |
| 技能启停 | 文件名加/去 `.disabled` | 03 §1.5、02 §3.4 |
| 技能删除 | 可做真撤销（回收站），优于 web 的「尽力回填」 | 02 §3.7 |
| 技能添加 | 本地路径输入；`.md` / 目录束；zip 可选 | 02 §3.5、01 §6.2 |
| 分组 | 共享 `groups.json` v1；只是显示元数据 | 02 §3.8、01 §6.4 |
| MCP 启停 | `pluginManager.setPluginEnabled`（失败回退文本编辑） | 01 §6.3 |
| MCP 增删改 | 无官方 API，必须字节保真编辑 + 锁 + 等 HMR | 01 §6.3、02 §4.3 |
| MCP 作用域 | 只有 profile 级 + home 全局层；无工作区级 | 03 §3、需求 D-4 |
| 热加载承诺 | 按矩阵逐条承诺，不笼统说「全部即时」 | 03 §4、需求 §4.4 |
| 准入/发布 | manifest + A–G + npm/tarball + 生态收录 | 01 §8、04 §1–4 |

## 4. 未验证清单（开发前/开发中必须实测）

按风险排序，全部来自四份文档的「未决问题」。**2026-11-08 真机探针已实测 1/2/3/4/7**，结论与证据见 [`05-m0-real-machine-probe.md`](05-m0-real-machine-probe.md)：

1. ✅ **场景内 `tuiDialogs` / `tuiToast`**（已实测）：**都不可用**——dialog 0ms 静默 false、toast `delivered=false`；确认/输入必须场景内自绘。
2. ✅ **`pluginManager.setPluginEnabled`**（已实测）：可调用但 `listPlugins()` 为 0、对 patch 插入行返回 `failed/unknown-plugin`（~33s）；MCP 启停改以 patch 文本编辑为主路径。
3. ⚠️ **`SKILL.md.disabled`**（部分实测）：内核 provider 侧已确认生效（改名后技能目录即时变化），M1 扫盘也按约定显示「停用」；**TUI `/skills` picker 与模型侧同步仍待补**。
4. ✅ **TUI 中 HMR 延迟**（已实测）：patch 写入 → loader 行可见 **≈2.0–2.5s**。
5. ⬜ **与 web 面板并发写 profile patch / groups.json 的锁互操作**（01 §9.6、04 §3.5）。
6. ⬜ **场景能否收到鼠标事件**（首版设计为纯键盘，不依赖）（01 §9.3）。
7. ✅ **`ctx.skills.list()` 在 host 层为空**（已实测）：服务在、`list()` 返回 `[]`、`snapshot().skills` 为空；列表必须扫盘。
8. ⬜ **MCP 测试连接的内核能力与 SDK 版本策略**（03 §2.7、02 §6.2）。
9. ⬜ **`tuiPluginHost.registerCommand` 是否为准入必选**（01 §9.8）。
10. ⬜ **0.19 vs 0.17 的运行时行为差异**（01 §2.3）。

## 4.1 已验证（2026-11-08）

- **M1**：技能扫描（发现根/rank/名称来源/遮蔽/停用/非法/`.system`）**在真机上与内核发现逐项一致**；UI 已补 headless Ink 渲染 smoke 与真实 TUI 进程注册证据，人工 TTY 逐屏走查仍缺。详见 [`06-m1-skill-scan-verification.md`](06-m1-skill-scan-verification.md)。
- **M2 P0**：启停/软删除+撤销/添加导入/分组/批量的域层实现与单测通过；运行时链路与 **headless UI 交互 smoke**（真实 runtime + 临时技能树）通过；真实 TTY 写操作观感/鼠标点击验收待补。详见 [`07-m2-skill-write-verification.md`](07-m2-skill-write-verification.md)。
- **M3 P0**：MCP 只读列表（profile+home+loader）、受管块启停、`!!js` 安全展示/只读、诊断 MCP 段。**2026-11-09 补启用边界、锁/冲突/强制备份、42 项域层回归与真实 TTY 启停/HMR/工具出现消失/只读/冲突证据**；完整 web/TUI UI 共存、模型侧技能同步与全布局人工验收仍待补。详见 [`08 §6`](08-m3-mcp-verification.md#6-2026-11-09-启用边界与写入保护补强)。
- **M4 受管 CRUD（D-10）**：2026-11-09 已实现 stdio/HTTP 表单、本面板行编辑/删除/持久撤销、未知键与表达式保留、敏感值掩码。新增域层与 120/58 列 UI/runtime smoke；真实 TTY 本地 stdio CRUD 与工具注册链路见 [`09`](09-m4-managed-crud-verification.md)。已有原始 profile 行仅启停；分组/筛选后续实现见下一条。

- **M4 分组与筛选（D-11）**：2026-11-09 已实现 profile 隔离、双键成员、分组管理、元数据搜索及状态/分组组合过滤；私有配置锁/合并/过期拒写，不改技能共享 schema。61 项域层回归、120/58 列 UI/runtime 与真实 TTY 证据见 [`10`](10-m4-groups-filter-verification.md)。完整人工验收与 M5 准入准备仍待补。

- **M5 发布准备**：manifest 0.15、固定 parser/core/profile 摘要、npm dry-run 与实际打包/入口导入、注册作用域清理回归均已补；A–G 自查、证据与待执行人工表统一见 [`../release-readiness.md`](../release-readiness.md)，不宣称整个 M5 或发布已完成。

## 5. 证据基线与复核方式

- **类型面基线**：已安装 `@deepseek-harness-tui/dsh-tui@0.19.0` 的 `lib/types/*.d.ts`（`~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui`）。
- **源码阅读基线**：`/home/wqwt/code/dsh-TUI`（v0.17.0 checkout，含 `tui-profile/` 文档与 `src/` 实现）——仅用于读实现逻辑；与 0.19 类型面一致，0.19 行为以已安装包 `.js` 为准。
- **内核基线**：`/home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh`（0.2.2-rc.1）。
- **参考实现**：`~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel`（2.3.7）。
- 复核命令见各文档附录（只读命令，不修改任何文件）。

## 6. 维护规则

- 上游版本升级、结论被推翻或出现相反证据时，**更新对应文档并注明日期**；不要删除原证据与「为什么」，可以追加「修正」段。
- 新结论若影响需求，同步更新 [`../需求文档.md`](../需求文档.md) 的 FR/AC，并在本文 §3 增补映射。
- 文档之间出现冲突时：以**实机验证 > 已安装 0.19 源码 > 0.17 源码 > 外部网页**的顺序裁决，并记录裁决依据。
