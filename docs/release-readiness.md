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
| E 清理恢复 / TUI-OBS-002 | 插件停用释放自己的运行期资源；卸载包不删除技能、MCP 配置、共享分组或私有备份/回收站；不提供 purge。停用管理器不会自动停用已保存的 MCP，也不会恢复被用户停用的技能。实际 tgz 的 CLI 安装、TUI 停用/再启用/卸载与卸载后两次启动已验证，9 个数据文件逐字节保留；见 §8，用户完整验收仍待执行。 |
| F 信任 / TUI-RUN-002、TUI-DEP-001、TUI-CLAIM-001 | README 安装前披露 trusted-in-process、非沙箱；安装/启用确认由宿主负责；真实 TTY 的 `/plugin install` 与 enable 信任提示及安装取消已验证（§8），完整人工复核仍待执行。依赖在 pnpm-lock.yaml，artifact SHA-256 随检查输出；未证明跨环境可重现或 provenance，不声明 Reproducible/Attested/Verified。UI/dump 脱敏测试通过，备份仍含原值并有私有权限。 |
| G 展示 | README 分列能力、兼容范围、权限、限制与开发状态；无“官方认证”“安全插件”等宣称。未来生态收录提交需作者本人操作与发布包版本/来源核对，目前未提交。 |

以上是自查记录，不表示 A–G 的全部人工/生态要求均已通过。

## 4. 发布前完整测试表

用户于 2026-11-09 表示目前未发现问题，并安排在发布前进行一次完整测试。下表保留待勾选状态；只有执行并记录结果后才能标为通过。建议使用隔离目录，备份操作对象；涉及真实 `~/.dsh` 的安装/卸载需用户自己执行或另行授权。

先按 [AGENT.md §7](../AGENT.md#7-开发与验证命令) 生成 `/tmp` 夹具并运行输出的 `run.sh`，可先复验不依赖模型/真实密钥的交互。下面涉及模型或 web 共存的条目，使用自己的测试 profile；不要把真实令牌写入问题报告。

| 状态 | 项目 / 最短操作与预期 |
| --- | --- |
| 用户待测；agent 隔离验证见 §8 | AC-9 安装/卸载：从构建源码或明确版本 tgz 安装 → `/skill-mcp` 打开 → 宿主停用管理器 → 命令/场景消失 → 再启用恢复 → 卸载 → TUI 正常启动；用户配置与数据保留。记录实际安装 spec 与包版本。 |
| 用户待测；agent 目录/菜单验证见 §10 | AC-10 技能与模型同步：工作区/全局同名技能切换作用域；空格停用/启用，`/skills` 与下一步模型技能列表同步；非法 frontmatter 有原因，bundled 不可写。 |
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

**仍待完整验收**：不同终端渲染器与连续 resize、模型侧同步、web/TUI 完整 UI 共存；鼠标已补 §9 的隔离 agent 证据，完整用户交互验收仍待执行；安装/卸载的隔离 agent 证据已补于 §8，用户完整验收仍待执行。当前布局为 <72 单栏、72–109 双栏、≥110 三栏，与需求 §6.1 的初始分档/可选帮助栏有差异；原设计与 AC-14 不改为“已通过”，由发布前完整验收核对。


## 8. 实际 tgz 安装、停用与卸载

2026-11-09，产品源码基线 `1b53ccf`，开发包 `0.1.0-dev.0`；[结构化证据](research/evidence/m5-install-lifecycle.json)记录 artifact SHA-256、独立安装依赖、宿主注册变化、各阶段数据哈希与信任确认文本。实际 archive 为 62 文件，SHA-256 为 `94acdd05f582ccc6a5f3f71460624d1b5f1415d568cb956db8f8eb4499a1551c`，与 §7 的产物相同；本轮只增加开发验证脚本/文档，不改运行时代码。

安装经真正的 `dsh plugin --profile panel-verification add <tgz> --ignore-scripts`，包在临时 profile 的 `.pnpm` 中解包；面板及其运行时依赖都不链接源码 checkout。实际解析为 schemastery 3.19.0、get-east-asian-width 1.7.0、yaml 2.9.1。宿主 0.19.0、Cordis 4.1.0 和内核 0.2.2-rc.1 复用本机安装，仅以 `link:` 引用；pnpm 12.6.0 对这些 link peer 报未满足，实际解析版本满足面板声明。该警告保留在证据中，不据此声称全新宿主 registry 安装通过。该 tgz 及新装的纯 JS 依赖无需安装脚本；CLI 首次安装使用 `--ignore-scripts`，随后实际 `/plugin install` 重装使用宿主默认安装流程，也成功打开面板。

真实 TTY 操作与结果：

1. CLI 安装后 `/skill-mcp` 打开；实际将技能加入既有组、删除进回收站、启用本地 MCP、创建 MCP 分组，产生可核对的私有配置、两类备份、回收站。另有预置停用技能作为保留对象。
2. `/plugin disable dsh-tui-skill-mcp-panel` 后，观察探针记录全局命令不存在、场景注册 0 个、对应 loader 行 0 个；依赖仍安装。该宿主的 bundle 停用是从 composition 的 bundles 列表撤下，不能只找 `disabled:true` 的行来判断。
3. `/plugin enable dsh-tui-skill-mcp-panel` 的确认框出现“本进程内运行、无沙箱”“授权是行为约束，不是安全隔离”；确认前未启用，确认后命令与场景各恢复一份，重新打开正常。随后再停用，数据完全一致。
4. `/plugin remove dsh-tui-skill-mcp-panel` 显示卸载确认；执行后 package 依赖、bundles 项和顶层安装链接均移除。停用技能、共享技能组、私有 MCP 组、备份、回收站、profile/home patch 共 9 文件哈希不变。完全退出再启动正常；`/mcp` 仍报告 `mcp-probe（1 个工具）: ping`，说明卸载管理器没有自动停用保存的 MCP。
5. 在卸载后的 TUI 中 `/plugin install <tgz>`，安装前显示进程内全信任/无沙箱/不会自动更新，并提示安装前尚不能判定声明；此时服务显示包名未知，不伪称已验证来源。Esc 取消后包仍不存在、9 文件不变。再次确认安装后面板恢复，重新打开可读到原分组、停用技能和回收站。最后再卸载、重启，9 文件仍不变。三个 TTY 进程均正常退出；没有模型请求或真实 `~/.dsh` 写入。

复核需要本机已装 CLI、宿主 0.19.0、npm/pnpm；脚本只准备 `/tmp` 数据，不自动安装或启动：

```sh
node scripts/prepare-install-probe.mjs ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
# 将输出 root 填到下面；每次运行都会生成新的隔离目录。
probe_root=/tmp/skill-mcp-real-tui-REPLACE
"$probe_root/manage.sh" add "$probe_root/dsh-tui-skill-mcp-panel-0.1.0-dev.0.tgz" --ignore-scripts
"$probe_root/run.sh"
```

TUI 中先 `g` 将 `probe-skill` 加入 Retained group、`d/y` 删除它；MCP 页选 `mcp-probe` 启用，`g` 新建分组。生成这些真实数据后，在另一个终端执行下列基线检查。然后回到 TUI，关闭面板，依次运行上述 enable/disable/remove 操作；每次完成后再执行对应检查：

```sh
# 启用时记录基线（TUI 必须仍在运行，观察探针服务须就绪）。
node scripts/install-probe-state.mjs "$probe_root" baseline on
# 停用后：
node scripts/install-probe-state.mjs "$probe_root" disabled off baseline
# 再启用后：
node scripts/install-probe-state.mjs "$probe_root" enabled on baseline
# 卸载后，以及退出并重新启动 run.sh 后：
node scripts/install-probe-state.mjs "$probe_root" removed removed baseline
```

预期命令输出 `OK`、保留文件哈希一致；违反期望、服务未就绪或旧宿主进程已退出均失败。探针从宿主内部只读查看全局命令和场景注册；不执行面板 handler、不请求模型、不进入发布包。真实 TUI 操作仍须人工/TTY 驱动，该检查脚本不会代替用户点击确认。脚本不纳入 `check:release`，以免要求所有开发机预装 CLI/完整宿主或自动下载依赖。

**边界**：这是隔离目录中的 agent 验证，§4 的用户完整验收仍待执行；没有全新宿主/内核 registry 安装、跨平台、安装失败回滚、生态准入或发布验证。CLI 的 add 命令本身未展示宿主 TUI 的信任确认；上述安装信任证据来自真实 `/plugin install`，与 CLI 安装结果分别记录。


## 9. 鼠标交互与选中项保持

2026-11-09，基于 `752d992` 继续 M5。真实 TTY 的 SGR 鼠标报告复现并修复三项问题；[结构化证据](research/evidence/m5-mouse-verification.json)保留修复前/后屏幕文本、事件坐标、文件结果及自动化断言。

- 窄屏点击技能行后，外层卡片的 click 冒泡会把详情焦点改回列表。宿主 0.19.0 的这条路径只检查 `stopImmediatePropagation()`；技能行现在明确阻止后续祖先处理，并在窄屏详情提供 `[←返回]`。点击进入、返回均不需要键盘导航。
- 技能启停会把 `SKILL.md` 改名为 `SKILL.md.disabled`，扫盘 ID 随物理路径变化；旧选择丢失后会退到第一行。现在优先匹配精确 ID，只有旧 ID 消失时才尝试同来源的启停对应路径，保持当前技能选中。若两种路径同时存在，原精确 ID 优先，不把不同实例合并。删除当前项后仍正常转到剩余列表。
- 选择框原先只显示 Esc 提示，没有鼠标取消入口。现在选择框提供 `[Esc 取消]`，MCP 字段选择、分组选择均可点击取消；输入文字仍使用键盘。

`pnpm check:release` 完整通过：82 项域层/发布测试、176 项布局断言，以及新增 **61 项鼠标断言**（场景 40×16、58×22、116×33）。`pnpm test:ui:mouse` 可单独复验；可加 `MOUSE_SMOKE_REPORT=/tmp/mouse-results.json` 保存断言列表。脚本通过宿主 `AlternateScreen` / React / ui 渲染，把 SGR 按下、释放、滚轮送入 stdin，按终端 cell 定位可见文本；不直接调用组件的 onClick/onWheel。内存 runtime 记录动作，测试保留选中技能、确认/取消、撤销、分组、帮助/详情分页、MCP 字段提交/取消及脱敏；不将它写成真实文件/HMR 的验证。

另用本机宿主 0.19.0 / 内核 0.2.2-rc.1 的真实 TTY，在临时 home/profile 验证终端 62×24（场景 58×22）与 120×35（场景 116×33）：点击技能详情与返回、列表/正文滚轮、作用域与页签、分组行选择/滚轮、帮助与 MCP 信息末页、输入提交/取消、选择框取消、诊断滚轮；鼠标启停 `mouse-002` 两个方向后仍选中它。删除取消保留文件，确认后正确文件进回收站、第一项未删，撤销恢复停用文件；选择分组后共享 JSON 确有目标成员。对表达式控制的只读 MCP 点击编辑没有进入表单；取消新增表单后整个 profile patch 哈希不变。MCP env 80 个键可滚到末尾，值未出现在屏幕中。四个探针 TTY 进程均正常退出，没有模型请求或真实配置写入。

复核前提：已装 CLI 与宿主 0.19.0，终端能路由鼠标。先退出正在运行的开发 TUI 再构建；下面只生成 `/tmp` 夹具，不自动启动或改用户 profile：

```sh
pnpm build
node scripts/prepare-mouse-probe.mjs ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
# 在真实终端运行输出的 run.sh，输入 /skill-mcp。
```

夹具有 42 项技能、40 个技能分组、33 行初始停用 MCP，正文 100 行、测试 env 80 键。先用约 62×24 的终端：点击 `mouse-002` 应进入详情，点击启停后仍显示它，点击删除 → 取消应保留，确认后应减少一项，撤销恢复；点击 `[←返回]` 回到列表。点击分组选择与 `[Esc 取消]`，应关闭选择框；MCP 新增中点击字段、键入测试文字，再点击提交/取消与选择框取消，应回到相应上一层，未保存时 patch 不变。点击帮助/详情的 `[末]` 应显示末页；滚轮只作用于指针所在列表或详情。放大到约 120×35，作用域/列表/详情分别可点击和滚动。

**验收边界**：SGR 序列证明当前宿主命中检测与路由，不保证所有终端模拟器、物理鼠标驱动、快速滚轮/拖拽/复制或 inline 的鼠标行为；用户 AC-14 完整验收仍待执行。原始布局断点设计差异继续保留；本轮不修改 profile MCP 的写入边界，也不据鼠标检查宣称模型同步/双端共存或发布通过。


## 10. 技能启停与实际 agent 目录同步

2026-11-11，产品基线 `02b7c7c`，本轮没有修改运行时代码或依赖。[结构化证据](research/evidence/m5-skill-sync-verification.json)记录 10 个阶段的实际 scoped 目录、面板有效集合、可调用策略、正文来源和真实 `/skills` 菜单文本；测试没有请求模型生成。

观察器运行在真实宿主 0.19.0 / 内核 0.2.2-rc.1 中，使用与 TUI 相同的 `serviceForAgent` 取得实际已挂载 preset 的技能注册表，再调用 `snapshot({ scope: agent, cwd })`。同时记录宿主层快照：其 complete 为 true、数量为 0，而当前真实 agent 有 7 项 `sync-*` 技能；二者作用域不同，不能把 host 空目录当作 agent 无技能。

为避免观察器干预缓存，只有在 snapshot 自己报告名称/路径等目录变化后才读取当前赢家正文，不反复 `get()` 已消失的旧文件；后者可能主动使缓存失效，掩盖 watcher 问题。观察器没有调用面板刷新、provider invalidate、agent dispatch 或 model generate。记录脚本等待正常变更传播，最多 8 秒；这不是精确的 watcher 延迟测量。

| 阶段 | 真实面板操作与检查结果 |
| --- | --- |
| initial | 7 项 `sync-*` 有效技能与 agent 中立目录逐项同路径/来源；非法 frontmatter 明确标无效，`.system` 子树不进入目录。 |
| local-off / local-on | 从面板停用/恢复工作区目录束 `sync-local`；物理文件改名、agent 目录与已注册 slash 命令移除/恢复，正文加载变为缺失/LOCAL-BODY；重开 `/skills` 同步为 6/7 项。 |
| shared-off / shared-on | 停用/恢复**工作区**的 `sync-shared`；数量仍是 7，但当前赢家与正文从 Workspace winner/WORKSPACE-WINNER 切到 Global fallback/GLOBAL-FALLBACK，再切回；`/skills` 来源与简述同步。不能只以“名称是否消失”判断停用成功。 |
| flat-off / flat-on | 平铺 `sync-flat.md` 改名为 `.md.disabled` 再恢复；菜单、agent 与命令集合移除/恢复，正文加载相符。 |
| global-off / global-on | 全局目录束 `sync-global` 停用/恢复；同一 agent 与 `/skills` 菜单同步变化。 |
| bundled-ro | 对受控 bundled 夹具尝试启停，面板提示只读；文件、agent 目录和菜单保持不变。这里使用显式测试 bundled 根，不代表已核对所有用户启动器的随包路径。 |

调用策略需要分开核对：`disable-model-invocation:true` 的 sync-human-only 保留在菜单和用户命令中，却不进入 model-eligible 集合；`user-invocable:false` 的 sync-model-only 保留在中立目录/菜单中，但菜单不带 `/`、不注册直调命令，仍可进入 model-eligible 集合。每个阶段都比较了面板对应策略，未把菜单出现与可直调或模型可调用画等号。

复验前提：已装 CLI 与宿主 0.19.0；先退出正在开发的 TUI 再构建。脚本只生成临时 home/profile，不启动、不修改真实配置：

```sh
pnpm build
node scripts/prepare-skill-sync-probe.mjs ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
# 在真实终端运行输出的 run.sh，然后 /skill-mcp。
```

在第二个终端，将输出 root 赋给 `probe_root`。面板首次打开后执行 `node scripts/record-skill-sync.mjs "$probe_root" initial`。在面板用 `/` 搜索目标 → Enter 结束搜索 → 空格启停 → 执行对应阶段检查，再退出面板打开 `/skills` 对照菜单。每对 off/on 阶段完成后再测下一对；对同名技能，确认选中的来源为工作区，恢复时工作区停用行可能排在全局赢家之后，需选中正确行。

```sh
probe_root=/tmp/skill-mcp-real-tui-REPLACE
node scripts/record-skill-sync.mjs "$probe_root" local-off
node scripts/record-skill-sync.mjs "$probe_root" local-on
# 同理依次 shared-off/on、flat-off/on、global-off/on、bundled-ro。
```

预期每次输出 `OK`，snapshot complete、同一 idle agent 的目录与面板赢家一致，物理文件和策略、slash 注册一致。脚本不会替你启停或刷新；旧宿主已退出时会拒绝读取留存快照。此探针需要本机实际 CLI/宿主及 TTY 驱动，不纳入通用 `check:release`。10 个阶段始终为同一 PID/agent，实际 TUI 正常退出；另验证退出后快照被拒绝。

**尚未验证**：本轮证明的是注册表、正文加载、用户菜单及模型可调用目录源的同步，没有执行 `agent/pre-step`、生成模型请求或检查实际请求消息中的 catalog 更新。因此 AC-10 的真实模型请求与行为仍待完整人工验收；没有据此将整个 AC-10 标记通过。自定义根、运行期注册技能、普通启动器 bundled 路径和跨 profile 会话不在本轮覆盖范围。
