# 发布准备与人工验收

面向维护者与发布前测试者。项目阶段以[需求文档 §14](需求文档.md#14-项目现状与下一步维护)为准；这里维护准入 A–G 的证据、复核入口和发布前测试步骤。开发包为 `0.1.0-dev.0`，不声明官方认证或 Verified claim。

## 1. 可复核的检查

在仓库根目录、安装开发依赖后运行，需要 Node ≥24.9、pnpm、npm 和 `tar`：

```sh
pnpm install --frozen-lockfile
pnpm check:manifest    # 官方 parser + 宿主语义检查 + 示例 descriptor 协商
pnpm check:tarball     # 清理构建 → npm dry-run → 临时实际打包/解包 → 入口导入
pnpm check:release     # 类型、域层/发布检查、打包、全部现有 UI/runtime smoke
```

`check:release` 只做本地检查，实际 tgz 放在临时目录，结束后删除，不上传或安装到用户 profile。`prepack` 先清理构建，再检查 manifest，因此从源码执行 `npm pack` 不会带入已删除源码的旧产物。构建会重建 `lib/types`，真实 TUI 验证期间先退出测试进程再构建。

打包文件清单由 `src/**/*.ts(x)` 推导：每个源文件对应 `.js` / `.d.ts` / `.d.ts.map`，另含 package.json、manifest、patch、README、LICENSE；多出旧探针、少了入口、混入私有文件或依赖未声明，均失败。实际 archive 逐文件核对字节并导入 `name/Config/apply`，依赖从当前锁定 checkout 解析；**这不等于全新 registry 安装验证**。

首次 M5 准备基线（de3b27d）的环境与结果见[结构化证据](research/evidence/m5-readiness.json)；后续共享分组写入修正见下方 §6，布局与当前包检查见 §7。自动化通过不替代下方人工验收，也不会自动启动发布。

## 2. 固定的准入基线

唯一机器配置为 [`scripts/release/admission-pin.json`](../scripts/release/admission-pin.json)。宿主开发依赖精确为 0.19.0；使用其携带的官方 `@dsh-std/manifest` parser，核对 parser/core 的 SHA-256、宿主的 `DSH_STD_REVISION`、registry 摘要及契约文件摘要，再运行官方语义验证与协商。没有联网获取 schema，也不依赖维护者机器上的另一个源码 checkout。

本机对照 `/home/wqwt/code/dsh-TUI/vendor/dsh-std` 的干净 revision `614dfa1ac168db79fcf4577cf0ebb34e2e3b944b`，parser/core 构建产物与宿主所带文件逐字节相同。规范来源为该 checkout 的 `tui-profile/docs/plugin-admission-and-development.md` A–G 与已装 0.19.0 的实际实现；二者有差异时以实际实现核对并记录。

本轮纠正早期调研建议：`Scene` 通过 `contributes.x-dsh-tui` 声明；它是 extension，当前 Host Descriptor 不把它作为可协商的 runtime protocol 发布，不能塞进 `requires.contracts` 当必需能力。相关回归会证明这种写法被拒绝。`Command` 列为必需契约；slash 命令在 Cordis 运行时注册，`contributes.commands: []`，继续保持用户确认的 `permissions: []`。插件没有调用受 grant 控制的标准 Command client。

`check:manifest` 的 `compatible` 来自上游**示例 descriptor**，只证明该声明可以与示例协商。实际宿主能力、远程 attach、布局、用户数据都需单独验证；不把这个结果宣传成运行时已准入或安全隔离。

## 3. A–G 自查

| 项 | 本项目适用性、证据与剩余项 |
| --- | --- |
| A 包与身份 / TUI-PKG-001 | 根唯一 manifest；固定 parser 接受 0.15；稳定 ID `com.dsh-tui.skill-mcp-panel`；版本、入口、license、来源与 package 一致；实际 62 文件 archive 验证。ID 的整个生态唯一性未做全网保证；不提交 Verified claim。 |
| B 声明完整性 / TUI-PKG-002 | Command 契约、Scene 贡献、空 permissions/subscriptions/panels；无 provides / requires.services。官方 parser、profile 定义验证、声明漂移拒绝测试通过。命令名不使用内置 `/skills` / `/mcp`。可配置命令/场景名是本插件配置能力，manifest 描述默认值。 |
| C TUI 兼容 / TUI-HOST-001、TUI-RUN-001 | 示例 descriptor 协商通过；实际 0.19.0 真实 TTY 打开/关闭/重开场景通过。TUI-only，不依赖 GUI/浏览器、不声明 remote attach 或 Backend 贡献；无场景服务时命令返回可读错误，全部接缝缺失时等待注入，服务缺失不阻塞宿主。所有布局与远程环境未全面验收。 |
| D 运行时 / TUI-OBS-001 | `ctx.inject` 等待服务；注册清理归属注入作用域，服务移除立即撤销，恢复/重复 activation 只保留一份注册。真实 Cordis lifecycle 测试覆盖场景/命令服务分别移除、恢复、停用/再启用；runtime 的 timer/listener 随面板 dispose。实际宿主 HMR/生命周期面板仍需人工复核。 |
| E 清理恢复 / TUI-OBS-002 | 插件停用释放自己的运行期资源；卸载包不删除技能、MCP 配置、共享分组或私有备份/回收站；不提供 purge。停用管理器不会自动停用已保存的 MCP，也不会恢复被用户停用的技能。真实包卸载后启动验证待执行。 |
| F 信任 / TUI-RUN-002、TUI-DEP-001、TUI-CLAIM-001 | README 安装前披露 trusted-in-process、非沙箱；安装/启用确认由宿主负责，人工复核该提示。依赖在 pnpm-lock.yaml，artifact SHA-256 随检查输出；未证明跨环境可重现或 provenance，不声明 Reproducible/Attested/Verified。UI/dump 脱敏测试通过，备份仍含原值并有私有权限。 |
| G 展示 | README 分列能力、兼容范围、权限、限制与开发状态；无“官方认证”“安全插件”等宣称。未来生态收录提交需作者本人操作与发布包版本/来源核对，目前未提交。 |

以上是自查记录，不表示 A–G 的全部人工/生态要求均已通过。

## 4. 发布前完整测试表

用户于 2026-11-09 表示目前未发现问题，并安排在发布前进行一次完整测试。下表保留待勾选状态；只有执行并记录结果后才能标为通过。建议使用隔离目录，备份操作对象；涉及真实 `~/.dsh` 的安装/卸载需用户自己执行或另行授权。

先按 [AGENT.md §7](../AGENT.md#7-开发与验证命令) 生成 `/tmp` 夹具并运行输出的 `run.sh`，可先复验不依赖模型/真实密钥的交互。下面涉及模型或 web 共存的条目，使用自己的测试 profile；不要把真实令牌写入问题报告。

| 状态 | 项目 / 最短操作与预期 |
| --- | --- |
| 待测 | AC-9 安装/卸载：从构建源码或明确版本 tgz 安装 → `/skill-mcp` 打开 → 宿主停用管理器 → 命令/场景消失 → 再启用恢复 → 卸载 → TUI 正常启动；用户配置与数据保留。记录实际安装 spec 与包版本。 |
| 待测 | AC-10 技能与模型同步：工作区/全局同名技能切换作用域；空格停用/启用，`/skills` 与下一步模型技能列表同步；非法 frontmatter 有原因，bundled 不可写。 |
| 待测 | AC-11 MCP：新增本地 stdio、修改参数、停用/启用/删除；观察热加载中→已生效、`/mcp` 工具出现/消失，模型侧同步；服务异常给出失败或超时。 |
| 待测 | AC-12 表达式/脱敏：stdio env 与 HTTP headers 用测试 `${ENV}`；重开/重载仍是表达式，其他字段不丢；UI、诊断、dump 不出现测试密钥明文。HTTP 若连接远端，使用自己控制的测试端点。 |
| 待测 | AC-13 撤销：技能、受管 MCP 各删除后撤销；重开后仍能撤销；删除后外部修改目标文件，撤销拒绝覆盖。原始 profile MCP 行仅启停，home/表达式行不可编辑删除。 |
| 待测 | FR-8/9 分组/过滤：技能分组与 web 一致；MCP `g/f/ /x`、分组页 `t/a/r/d/Enter`；搜索与状态/组取交集；不同 profile 同名服务器不串组，重开保留成员，改名/删除/撤销归属正确。 |
| 待测 | AC-14 布局：<64、64–92、≥93 列，inline/fullscreen；键盘/鼠标完成列表→详情→表单→确认→取消，无溢出/错位。包含长列表、CJK/emoji、空列表/过滤空结果；底部按钮可点击且与键盘范围一致。 |
| 待测 | AC-15 共存：同一测试 profile 中 web/TUI 交替停用技能与 MCP；刷新双方一致，受管块互不覆盖；并发写触发等待/冲突，无丢行。共享技能分组已有 TUI 快照保护，但实际 web 2.3.7 不使用组锁，不能先勾选双端同时写入通过；可复核边界见 §6。 |
| 待测 | AC-16/18 限制与信任：MCP 顶部“无工作区级”、home 只读、帮助/README 一致；宿主装/启用前显示进程内全信任/非沙箱。错误/备份路径可找到，关闭面板后宿主键盘正常。 |

记录格式：包版本/提交、宿主/内核/Node、终端尺寸与模式、操作、实际结果、必要的脱敏截图/日志。失败保留最短复现，不将自动化报告当成人工勾选依据。

## 5. 发布执行前提

1. 处理需求 §14 的剩余发布缺口，完成上述人工测试并记录；本轮检查通过不会消除共享技能分组并发等已知限制。
2. 用户确认要发布的版本与范围，再同步 package/manifest/version/tag；目前不创建 tag。
3. 对最终提交重跑 `pnpm check:release`，重新生成最终 tgz 与摘要；当前开发包摘要不是未来发布包摘要。
4. 获得打 tag / npm 发布 / Release 上传的对应授权后，才执行 AC-19；provenance 与生态投稿依据当时实际渠道处理。未发布前不写成已完成。

## 6. 共享技能分组写入保护

2026-11-09，依据 FR-17 / Q11 补齐面板侧保护，schema 仍为 web 兼容的 `{ version: 1, groups }`。加载时记录原始字节指纹；保存取得 `groups.json.panel.lock` 后重读，任何外部变化（包括其他组或格式变化）都会拒写，不自动合并过期 UI 意图。按大写 `R` 全局刷新后重试。多个 TUI 写者共享该锁，一个旧快照成功后另一个必须刷新；UI 不误报两者均成功。

已有文件写前必须保存精确原文到私有 `backups/skill-groups/<UUID>/groups.json`（0600，新目录 0700），失败则停止。未编辑的顶层/分组字段、其他作用域、无效外来记录保留；重命名不顺手修复异常 scopes 容器。提交前再比对，提交后读回核对；诊断页显示源文件、写入状态、备份路径，状态条显示冲突/只读警告。

损坏 JSON/非 UTF-8 读取时在锁内重读后复制 `.corrupt-<fingerprint>` 精确备份，重复刷新不重复备份，**不移动共享源文件**。备份成功才允许之后用同一快照恢复写入；备份失败只读。未知版本、非法顶层结构、符号链接只读，读取错误不伪装成“空配置”。这些规则避免读取损坏文件时误移动刚被 web 修复的新内容。

自动化涵盖新建/改名/删除/成员变更的旧快照拒写、双进程互斥与刷新重试、提交前无锁替换、备份失败、权限保留、原始损坏字节与未知字段保留；真实 UI/runtime smoke 增补冲突提示与刷新流程。实际 web 2.3.7 API 在临时 home 上验证两端互读与顺序修改；同时明确复现了 web 后提交旧状态仍可覆盖 TUI 的限制。证据见 [`skill-groups-concurrency.json`](research/evidence/skill-groups-concurrency.json)。

复核：

```sh
pnpm test:ui:interaction
node scripts/skill-groups-interop.mjs ~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel
```

后者需要本机已装 web 2.3.7，只从安装目录读代码，所有数据写入临时目录并清理，不纳入要求独立可运行的 `check:release`。其他环境可使用域层/界面回归，无需安装 web 插件。

**未解决的边界**：web 2.3.7 的组 API 不遵守此锁，也没有快照比较；它在 TUI 保存后提交旧内容仍会丢掉 TUI 的新成员。最终检查与 rename 之间也存在不遵守锁的写入竞争窗口。因此完整 web/TUI 并发安全仍需要上游协作，当前使用时避免同时编辑同一个共享分组文件；这不是“自动化已通过”的项目。备份自动清理未接入，发布前完整人工验收继续保持待执行。


## 7. 布局与异常交互回归

2026-11-09 补齐 M5 局部回归，证据为 [m5-layout-verification.json](research/evidence/m5-layout-verification.json)。`pnpm check:release` 完整通过：82 项域层/发布测试，原有全部 UI/runtime smoke，以及新增 8 种场景尺寸下的 176 项断言。可单独运行 `pnpm test:ui:layout`；若需逐屏文本，使用 `LAYOUT_SMOKE_DUMP=/tmp/panel-layout pnpm test:ui:layout`。构建前先退出正在运行的测试 TUI，避免 HMR 干扰。

场景尺寸为 40×16、58×20、64×24、72×24、92×24、93×24、110×30、160×40，每种含缩小到 20×8 后恢复。夹具使用 60 项技能、分组及 MCP、长 CJK/🧭 字段、多页正文/帮助/确认框、空结果、只读行与扫描/读取错误。检查包括标题与动作可见、首尾可达、过度翻页不空白、错误替换长详情时偏移收敛、输入末尾和 Unicode 退格、错误 args 不提交、过小区域阻止隐藏操作且恢复草稿、密钥不出现在终端帧。该脚本是内存 runtime + 真实宿主 React/ui 渲染，不声称替代真实文件写入或宿主服务测试。

本轮修复：帮助/确认/信息框按 cell 折行并分页；所有页签动作条按实际行数分配高度；技能/分组首尾及诊断滚动边界统一收敛；长输入显示末尾；MCP `i` 可分页查看已知字段的脱敏详情（未知键仍不展示）；窄屏组名分配更多宽度；技能正文超过 400 行显示预览限制。可用区域小于 40×16 时保留草稿，暂停隐藏操作，只允许关闭。终端最后一行需留给渲染器换行，避免整个标题被推出屏幕。

测试终端使用开发依赖 `@xterm/headless` 与精确固定的 `@xterm/addon-unicode11@0.9.0`，按[官方用法](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-unicode11/README.md)启用 Unicode 11 宽度表，避免旧宽度表把 🧭 当成一个 cell 后生成假的残影。该依赖不进入运行时 dependencies；不据此保证所有组合 emoji/字体宽度一致。

真实 TTY 另用本机 0.19.0 / 内核 0.2.2-rc.1，全部数据在 `/tmp` 的独立 home/profile：fullscreen 终端 44×18（场景 40×16），inline 终端 62×24（场景 58×22）。两种模式实按键盘打开场景、技能详情 End 到第 99 行、帮助 End 到限制段、MCP `i` + End 到第 79 个 env 键；标题、翻页/关闭入口均可见，env 仅显示键与“值已隐藏”。宿主 `restart.log` 分别记录 `fullscreen:true/false`，没有仅凭修改配置推断模式。宿主会把显示偏好导入临时 `user/.dsh-tui/settings.json`，inline 复验需在该临时文件设 `values.fullscreen:false` 并重启；仅修改 patch 不足以覆盖已导入偏好。探针未请求模型、未改真实 `~/.dsh`，退出码均为 0。

复核时先按 AGENT.md §7 准备隔离探针：调整窗口，使场景显示目标可用尺寸；`?` → `End` 应看见限制段与关闭提示；技能 `Enter` → `End` 应显示正文末尾；MCP `i` → `End` 应显示脱敏末页；编辑长字段应能看到末尾，缩小窗口后操作暂停，放大恢复草稿。输入和确认都用 `Esc` 取消即可。

**仍待完整验收**：鼠标点击/滚轮、不同终端渲染器与连续 resize、安装/卸载、模型侧同步、web/TUI 完整 UI 共存。当前布局为 <72 单栏、72–109 双栏、≥110 三栏，与需求 §6.1 的初始分档/可选帮助栏有差异；原设计与 AC-14 不改为“已通过”，由发布前完整验收核对。
