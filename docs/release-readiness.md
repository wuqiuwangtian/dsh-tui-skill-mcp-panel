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
| 隔离组合复验已补；仍未通过，见 §11.3 | AC-15 共存：技能双向刷新、受管块保留与 D-12 已验证；剩余 web/TTY 问题已定位，内核/web 候选已在隔离原宿主复验，真实环境尚未集成修复。共享技能分组并发边界另见 §6，用户完整验收仍待执行。 |
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

## 11. web/TUI 完整 UI 顺序共存

2026-11-11，产品源码基线 `c99651d`，web 面板 **2.3.7**、官方 web app/内核 **0.2.2-rc.1**、TUI 宿主 **0.19.0**。通过 Playwright 驱动真实 Chromium 网页和同一 Cordis 宿主的真实 TTY，交替操作同一个临时 profile。测试专用启动插件只提供回环地址、随机端口和本地认证链接；网页组件、RPC、loader、TUI 均为实际安装的实现。两个面板 bundle 默认使用相同 entry id，因此夹具为 TUI 单独插入 `tui-panel-interop`，保留实际 web bundle。没有修改第三方已安装包或真实用户配置。

[结构化证据](research/evidence/m5-web-tui-interop.json)记录 8 个观察项：5 项符合预期、3 项复现兼容失败。**AC-15 未通过，属于发布阻塞**；不能用“共享文件未损坏”代替“双端状态一致”。

| 实际 UI 操作 | 结果 |
| --- | --- |
| web 停用全局 `interop-skill`，TUI 刷新 | `.disabled` 文件与 TUI 停用显示一致 |
| TUI 恢复技能，web 完整刷新后重新打开面板 | 文件恢复 `SKILL.md`，web 开关显示启用；未验证自动刷新 |
| TUI 启用原有 `mcp-probe`，web 点击 Refresh | loader 为 active，web 能看到 1 个工具，开关仍显示 Disabled |
| web 对该 MCP 先启用再停用 | 原行恢复停用，但 TUI 的 `disabled: false` 覆盖仍使服务 active；完整刷新也不一致 |
| web 新增 `interop-web`，TUI 刷新 | 本地 stdio 服务器可见且 active |
| TUI 新增 `interop-tui`，web 刷新 | 同样 active/1 个工具；创建前全部字节原样保留，两种受管块共存 |
| web 停用 TUI 新增行（此时尚无该行覆盖） | TUI 刷新显示停用、fiber disposed；web 自己的受管块字节未变 |
| TUI 恢复自己新增行，web 完整刷新 | 服务 active，web 开关仍 Disabled；web 受管块字节未变 |

修复前（`c99651d`）的根因已由安装源码与 UI 交叉确认：本插件 `saveMcpToggle` / `upsertManagedToggle` 对原始行和受管行都写独立的 `id + disabled` 覆盖；web `listMcpPatchRows` 只列有 `name` 的 MCP 行，其开关从原行取值，忽略后续覆盖。这也说明该问题不限于原始行。共同使用文件锁只能串行保存，不能保证双方理解配置的方式一致。

另观察到 web 2.3.7 三次开关操作后 `serverCard` 抛出 `TypeError: Cannot read properties of null (reading 'ok')`，导致主面板消失；完整刷新可恢复。未改该第三方问题，不把其他版本的表现推定相同。一次自动输入多发 Esc 退出 TUI 表单，误触发聊天；隔离环境无 API key，回合本地失败后已中断，未完成模型调用，不计入模型验收。后续驱动逐步核对当前模态状态。

复验需要本机已安装上述 CLI/宿主/web 包、已构建仓库和浏览器。准备脚本只写新建的 `/tmp` 目录，不启动服务、不下载依赖：

```sh
pnpm build
node scripts/prepare-web-interop-probe.mjs \
  ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui \
  ~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel
# 在终端执行输出的 run.sh；初次后端选择选 DSH，完成临时欢迎界面。
```

服务启动后，用浏览器打开输出 root 中 `web-auth-url.txt` 的本地链接，接受官方预览说明，进入 **Skill / MCP**。该文件权限 0600，内容是临时认证凭据，勿提交或贴入报告。TUI 输入 `/skill-mcp`。先按上表交替启停 `interop-skill`，再 TUI `2` → 选择 `mcp-probe` → 空格启用 → 等待已生效 → web **MCP → Refresh**；当前会复现“Disabled + 1 tools”。TUI 大写 `R` 刷新后可用 `<root>/dump.json` 核对 `enabled:true, phase:active`；dump 仅在扫描/显式刷新时更新，旧 dump 不代表当前状态。新增 MCP 复用 `test/fixtures/mcp-stdio-server.mjs` 与当前 Node 绝对路径；TUI 的 args 填 JSON 数组，web 每行一个参数。不要连续发送多个 Esc 后继续输入，先确认仍在面板内。测试结束关闭浏览器、Esc 退出场景并退出隔离宿主。

**历史决策节点**：上述问题最初受“原始 YAML 零改动”约束阻塞。用户随后明确允许精确修改已有 MCP 的 `disabled` 并处理本插件旧覆盖，已采纳为 D-12 / [ADR-0002](decisions/0002-mcp-disabled-in-place.md)，实现与验证见下节。原始行 CRUD、home/表达式只读边界继续有效。`e6979ea` 的旧包为 62 文件、85,939 字节，SHA-256 `237f4f22d3508b0024eca29c98b70d3c3bab545f2ccb60a86a322da5be59396c`，仅作历史基线。

### 11.1 D-12：精确启停与旧覆盖迁移

2026-11-11，在用户授权后修复覆盖语义冲突。新模块 `src/domain/mcp/toggle.ts` 按 id + serverName 定位唯一定义，只修改/插入普通布尔 `disabled`，启用时可移除无注释的独立字段；其他文本不重新序列化。已有 profile 行的配置编辑/删除未开放。保存沿用两层快照、共享锁、完整原文私有备份与原子写入；表达式、非布尔值、别名、重复身份、外来同 id 覆盖及无法安全定位的格式拒写。

旧条目有两种明确处理方式：目标下次启停时只清理对应旧覆盖；MCP 页 `m` 或鼠标按钮打开保存状态预览，确认后整批迁移。混合启用/停用状态保持不变，任何目标不能安全处理则整批停止。确认绑定预览时的路径与内容快照，runtime 在弹窗期间刷新也不能扩大提交范围。打开/刷新面板不自动写。围栏内有外来行时保留围栏和外来字节，不能以 marker 还存在判断迁移失败。

[结构化证据](research/evidence/m5-mcp-precise-toggle.json)记录三种来源的 12 个启停观察、一个网页实际表单新增条目的 2 个双向观察，以及整批/单条迁移、鼠标取消、首轮 9 份私有备份。7 次 TUI 启停的完整候选文本与实际文件逐字节核对；整批和单条迁移同样匹配候选，保留外来行。工具数与 loader active/disposed、网页开关在记录的稳定阶段一致。

验证入口：

```sh
pnpm check:release
node scripts/mcp-web-interop.mjs ~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel
```

本轮 `pnpm check:release` 最终以退出码 0 完成。前者覆盖类型、96 项域层/发布测试、176 项布局、61 项鼠标及既有 runtime/UI smoke；MCP CRUD 的 120/58 列还验证迁移确认/取消、预览过期拒写及迁移后旧撤销记录拒绝覆盖。后者仅使用临时文件，调用实际 web 2.3.7 编辑器/模型与 TUI 保存路径，检查三种来源的 18 个交替读写/迁移观察；这是模块级补充，不代替完整 UI。

人工复验沿用本节的隔离组合宿主。可在夹具中预置旧覆盖，启动后 `/skill-mcp` → `2`：先按 `m` 查看目标并取消，文件应不变；再次确认后旧受管覆盖数量归零，保存的启停状态不变。再从两端交替启停，网页点击 Refresh，TUI 刷新，核对工具出现/消失。修改原始行时仅 `disabled` 发生变化；`Enter`/`d` 仍不能编辑或删除原始行。普通格式可复现该修复，但下述边界不能忽略。

**仍未闭环，AC-15 与发布仍不标为通过**：

- web 2.3.7 在 7 次成功开关后出现独立的 `serverCard` 空值崩溃，记录的网页核对是在完整刷新恢复后完成。未修改第三方包，不能宣称不需要恢复的完整 UI 交互已通过。
- 手写多行 flow 配置中，web 在启用后再次补入 `disabled` 会生成非法候选并拒写，原文件保持完整；表单 Edit 也复现片段定位错误。通过 web Add server 重生成它自己的受管块为普通格式后，受影响的最后两个观察才通过。该失败和恢复路径均保留在证据中，不算 flow 格式兼容已修复；TUI 不擅自重排 config 来规避它。
- 隔离 PTY 两次变为 canonical/echo 输入；一次手动恢复、一次有日志的恢复后继续核对，受影响的旧 dump 被丢弃并重新获取。追加旧式覆盖停用的单次对照未复现，原因和归属仍未定位，不能排除宿主、夹具或交互回归；产品未新增接管 stdin/raw mode 的代码。最终确认快照保护另用新启动的真实 TTY 复验迁移，正常退出。
- 用户完整验收、真实模型请求同步、技能组的无锁 web 后提交覆盖仍按原边界保留。降级旧 TUI 会重新生成覆盖，需要再次迁移。

### 11.2 剩余互操作问题溯源与候选修复（2026-11-11）

本节更新 §11.1 当时“原因未定位”的结论，保留历史测试记录。产品源码基线仍为 `c581d2b`，**本轮没有改动 `src/`、真实 profile 或已安装第三方包**。新增隔离复现脚本与[脱敏结构化证据](research/evidence/m5-interop-root-causes.json)，另提供[针对官方 web 2.3.12 的 flow 候选补丁](research/evidence/web-2.3.12-flow-span.patch)，尚未提交上游或安装。**AC-15 仍未通过，不能发布。**

**问题一：web 开关后卡片崩溃。**【已验证事实】web 2.3.7 点击 MCP 开关后，卡片可能消失并抛出 `Cannot read properties of null (reading 'ok')`；刷新能恢复。原因是 `lib/mcp/gateway.js:230` 返回 `{ server, reconciled }`，`lib/client.js:4759` 的 adapter 原样透传，而 `applyToggle`（4080 起）把整个返回值当服务器卡片保存。错误卡片没有 `serverName`，与空 `oauthNotice` 的可选属性比较成为 `undefined === undefined`，进而访问空值的 `.ok`。单纯给 `.ok` 加判空只能隐藏后果，不能纠正卡片数据。

具体修复位置是 web 返回值到卡片的边界。2.3.7 临时候选在 adapter 解包并校验 `result.server`；实际浏览器完成 6 次 web、4 次 TUI 交替启停（普通和 flow 行），无需整页重载，另完成 flow 表单编辑/删除及外部字节核对。正常 **Refresh** 用于读取热加载后的工具数，不把这算作自动刷新能力。

【已验证事实】从 npm 下载的[官方 2.3.12 包](https://registry.npmjs.org/dsh-skill-mcp-panel/-/dsh-skill-mcp-panel-2.3.12.tgz)已在 `lib/client.js:4215` 起的 `applyToggle` 解包 `result.server`，并以 `usableCard` 防止坏卡片入状态。其未改动副本完成普通 MCP 的 4 次 web、2 次 TUI 交替启停，无整页重载或该空值错误。**因此后续优先评估官方升级，不维护旧 adapter 补丁；不能把 2.3.7 的 adapter 补丁再次叠加到 2.3.12。** 升级影响整包和协议依赖；本次通过只读链接本机内核依赖运行，并未验证全新 registry 依赖安装或真实环境升级。

**问题二：部分多行 flow YAML 无法启停、编辑或删除。**【已验证事实】`lib/patch-editor.js:484` 的 `nodeContentEndOf()` 递归到最后一个内部值，漏掉 flow 集合的 `]` / `}`。`pairContentEndOf()` 在错误位置插入 `disabled`；`itemSpan()` 编辑/删除时又会遗留闭合符。写后校验通常拒写，界面表现为操作失败。官方 2.3.12 与已装 2.3.7 的该编辑器逐字节一致，升级本身不解决此项。

具体改动是在 `nodeContentEndOf()` 进入递归前，仅对 flow map/seq 返回 `node.range[1]`。它包含闭合符；不使用 `range[2]`，以保留集合外尾注释。块式集合继续走原逻辑。候选会同时影响启停、编辑、删除的定位，故实际编辑器覆盖 stdio flow、HTTP 嵌套 flow、普通 block × LF/CRLF，各 18 项操作；两个版本均复现 4 个原 flow 失败、候选全部通过，外部哨兵、未知键、env/headers 和 `!!js` 保留。旧版候选另有完整浏览器操作；**最新版 flow 候选只验证首个网页停用成功，随后触发问题三，不能记作最新版完整 UI 通过。** 补丁只放在仓库作为可审阅提案，未部署。

**问题三：停止 MCP 后 TUI 按键失效或开始回显。**【已验证事实】TTY 从 raw 切回 canonical/echo：输入按行缓存，快捷键无法及时到达。系统调用已经把修改对应到真实 MCP 子进程，排除了“必须先打开本面板才触发”的假设：同一隔离宿主从未打开 `/skill-mcp`，冷启动已启用的 Node MCP fixture 后，通过真实网页停用它，仍复现。

完整链路如下：

1. 内核 `@deepseek-ai/dsh-mcp-client/lib/index.js:38` 的 `createTransport()` 未指定 stdio stderr 策略；实际 `@modelcontextprotocol/client/dist/stdio.mjs:79–82` 默认 `inherit`。
2. 子进程启动在宿主开启 raw 之前，stderr fd 2 指向同一 PTY，记录了 canonical/echo。停止时，子进程通过 fd 2 发出 `TCSETS2` 恢复该状态，覆盖宿主之后设置的 raw。脱敏证据保留 PID、时间与相关 ioctl；未收录完整 exec 环境或认证链接。
3. 宿主 `lib/types/ink/components/App.js:626` 的 `reassertRawMode()` 定期调用 `stdin.setRawMode(true)`；但 Node v26.3.0 / libuv 1.52.1 的缓存仍认为 raw 已开启，重复 true 不会恢复实际终端状态。独立 PTY 中 false→true 能恢复，单独重复 true 不能。

真实 SDK 对照使用三套自建 PTY、真实 fixture 的 MCP 握手与 `listTools()`：冷启动继承 stderr 的关闭后 canonical/echo 均为 true；先开 raw 再启动、冷启动但 stderr 管道隔离，关闭后均保持 false。三例工具均为 `ping`。这证明预防路径有效，**不表示所有 Node 版本、MCP 程序或平台都已验证**。

需要修改的具体位置与影响：

| 位置 | 建议与依据 | 影响和验证要求 |
| --- | --- | --- |
| 内核 `createTransport()` 的 stdio 分支及其连接/日志生命周期 | 显式 `stderr: 'pipe'`，启动前订阅并持续消费，接入有界诊断日志；避免 MCP 子进程持有用户终端 | 不能只改 pipe 后不读，否则缓冲堆积可能阻塞子进程；需要保留启动错误、处理日志量和 dispose 清理。实验只消费并计数字节，没有实现生产日志策略。HTTP transport 不受此候选影响。 |
| 宿主 `App.reassertRawMode()` | 处理 Node 缓存与实际 termios 不一致；false→true 是已验证的恢复原理 | 仍须限定 ownsStdin、rawModeEnabledCount 和退出状态，验证焦点切换、其他输入所有者、恢复与正常退出；不能直接把实验当作宿主补丁已经通过。 |
| 本项目面板 | 保持通过配置驱动 MCP 生命周期 | 不接管 stdin、不增加定时抢 raw；这样不会掩盖内核/宿主问题，也不扩大插件权限与职责。 |

**可复核入口。** Linux、Python 3、当前 Node；SDK 对照还需 `dsh` 可从 PATH 解析及本机内核依赖。命令创建自己的 PTY/临时文件并清理，不连接真实 MCP 或写真实配置：

```sh
node scripts/tty-raw-recovery-probe.mjs
node scripts/mcp-stdio-tty-probe.mjs
```

第一个命令在当前基线预期 `repeatedTrueRecovered: false`、`forcedTransition` 的 canonical/echo 均为 false；第二个输出上述三组对照。更换 Node/libuv 后以实际输出判断，不把当前现象强加给新版本。stderr 管道示例只用于隔离实验，不能作为丢弃生产诊断日志的建议。

web 复核先沿 §11 的 CLI host 准备前提构建；`WEB_RELEASE` 指已核对版本的官方 2.3.12 解包目录。下载与解包应核对归档路径，不执行安装脚本。以下输出新的隔离 root，真实安装目录只读；不传 `--flow-candidate` 则比较官方原包：

```sh
HOST_DIR=~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
WEB_DIR=~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel
# WEB_RELEASE 需先设为已解包的官方 2.3.12 目录
node scripts/prepare-web-release-probe.mjs "$HOST_DIR" "$WEB_DIR" "$WEB_RELEASE"
node scripts/prepare-web-release-probe.mjs "$HOST_DIR" "$WEB_DIR" "$WEB_RELEASE" --flow-candidate
node scripts/check-web-compat-candidate.mjs "<第一个 root>/web-official-2.3.12" "<第二个 root>/web-official-2.3.12"
```

上例两个准备器分别产生带只读依赖链接的原包副本和候选副本，模块检查直接使用这两个目录，无需改动官方原解包目录。启动输出 launcher 后，沿 §11 使用真实浏览器与 TTY；从冷启动已启用的本地 fixture 开始停用才能覆盖问题三，不能只测试运行中后启用的服务器。新版候选脚本不改变初始测试行的状态，需要在启动前仅修改新临时 profile。认证链接保持私有，禁止提交。

**交付边界与下一步。** 五个新增脚本均为开发期工具，不随 npm `files` 发布；没有新增运行时依赖或修改产品写入边界。真实浏览器/SDK/系统调用证据已经定位三个问题，但内核日志策略与宿主恢复方案尚未集成；web flow 也尚未发布修复。下一步按需求 §14「下一步」第 1 项，先形成内核与宿主的可审阅候选，使用隔离副本验证冷启动关闭、反复重连、日志与退出，再组合官方 web 更新/flow 候选完成无需恢复的全 UI 复验。真实安装更新、上游提交和正式发布沿各自授权处理。§6 的共享技能分组并发边界及用户完整人工验收仍独立存在。

本轮实际检查：五个脚本语法、两个版本编辑器、最终脚本的两套 PTY 实验、新版 flow 准备器和 `git diff --check` 均通过。`pnpm check:tarball` 退出 0，65 文件、89,602 字节，SHA-256 `3bf6abf4d2d34ef28c34e98299dcf2c66468c38bc3e1283a61387f7004ddaa91`；新增工具/证据没有混入 npm 包。README 限制说明改变使包摘要变化，产品源码仍与 `c581d2b` 相同。本轮未重跑完整 `check:release`；§11.1 的 96/176/61 项属于前次运行时基线，不冒充本轮结果。

### 11.3 内核 stderr 候选与真实双端复验（2026-11-11）

本节承接 §11.2，产品运行时仍为 `c581d2b`；本轮仅新增开发工具、[内核候选补丁](research/evidence/dsh-mcp-client-0.2.2-rc.1-stderr.patch)、[宿主实验补丁](research/evidence/dsh-tui-0.19-raw-reassert-experimental.patch)和[脱敏证据](research/evidence/m5-runtime-candidates.json)。**真实安装未更新，AC-15 与用户完整验收仍未通过。** 补丁针对所列已安装包的构建文件布局，尚未移植到上游 TypeScript 源码、提交上游或发布。

**内核候选的改动与影响。** 在 `@deepseek-ai/dsh-mcp-client@0.2.2-rc.1/lib/index.js` 的 `createTransport()` stdio 分支显式指定 `stderr: 'pipe'`，在 `connectGeneration()` 调用 `connect()` 前接入消费器；通过现有 `ctx.logger.warn` 输出有限诊断。`scripts/candidates/mcp-stderr.mjs` 是该消费器的可审阅源文件，准备器把它复制到新临时包中，不进入本项目运行时代码。

- 每行最多暂存 4 KiB；超长行整行替换为提示，避免保留截断的敏感片段。每次连接的日志正文最多 16 KiB、32 行，超过后继续读取，仅在结束时追加一次抑制提示。宿主 logger 添加的前缀不计入正文预算。
- 支持跨 chunk 的 UTF-8、无换行尾部和早期启动错误；过滤终端控制符，并精确遮盖当前 `config.env` 的已知字符串值。**这不是任意密钥识别器**；生产日志级别、预算及脱敏策略仍需维护者评审。
- 在 stderr end/close/error 或显式 transport close 时刷新尾部、撤销监听并销毁流；日志输出失败不让 MCP 连接崩溃。HTTP 分支不改动。
- 代价是高流量 stderr 超额内容不再完整落日志；收益是子进程不再持有用户终端，也不会因无人读取 stderr 而堵住。限量日志策略是候选方案，不宣称已成为上游契约。

【已验证事实】实际候选 `startConnection()`、真实 SDK 和本地 fixture 在自建 PTY 完成 3 轮连接、异常退出后的自动重连、工具重新注册及 dispose 清理。每次启动先输出 2 MiB stderr，再进行握手，均未堵住；已知环境变量值被遮盖，启动失败的无换行诊断被保留。消费器另验证跨 chunk 字符、控制符、超限、尾部、幂等清理及 logger 抛错。工具 registry/logger 在此项使用最小替身；完整宿主证据在下文，不能把模块替身叫作完整宿主。

**宿主恢复候选的结论。** `App.reassertRawMode()` 在现有 ownsStdin、shutdown、raw 引用计数和 TTY 检查之后，改为 false→true。实际 App 方法通过四项禁止操作的守卫检查；在真实候选宿主的自有 PTY 人工注入 canonical/echo 后，6.5 秒检查时已由原有周期任务恢复，退出码 0，最后一次 raw 请求为 false。

但该方案要经过两次独立的模式切换，期间会短暂进入非 raw 状态。候选宿主运行中观察到终端查询回复 `^[[?1049;0$y` 的回显，原宿主对照未见同类回显；尚未把该观察提升为覆盖所有终端的因果结论。**不推荐现在集成周期性的 false→true；保留为实验补丁。** 它能恢复状态，不等于恢复动作没有输入副作用。当前推荐优先修复内核的 stderr 继承来源，宿主防御方案单独评审；不是让本面板接管 stdin。

**组合验证结果。** 使用原始宿主 0.19.0、内核 stderr 候选、官方 web 2.3.12 + §11.2 flow 补丁，启动时启用一个多行 flow MCP。实际浏览器与同一宿主 `/skill-mcp` 操作后：

| 核对项 | 实际结果 |
| --- | --- |
| 冷启动服务器首次由 web 停用 | web 停用、0 工具；TUI 为 disabled/disposed，termios 仍为 raw；未手工恢复 |
| 普通行与 flow 行交替启停 | 保留 8 组完整双端快照：网页开关/工具数、TUI 启停/目标 loader phase 和实际终端模式一致 |
| web flow 表单编辑 | 保存后仍 active/1 工具；args 新增测试标记，目标之外字节和 env 表达式保持 |
| web 原始 flow 行删除 | 网页确认后删除成功；结果精确等于候选编辑器删除目标的结果，其他字节保留 |
| 输入与退出 | 活动期记录 107 次 raw 请求，没有 false 请求；无需整页重载或手动恢复，退出码 0，最后 raw 请求为 false |

第一次采集错误地把项目 `profileFingerprint` 当成文件的直接 SHA-256，导致验证辅助断言失败；后续按大写 `R` 获取新快照并核对目标实际状态。一次过早 Refresh 仍读到 HMR 中的旧工具数，后续轮询普通 Refresh 等待收敛；未整页重载。删除测试行首次准备缺少 insert 容器，已纠正夹具后再执行删除断言。未启动过的停用行可能没有 loader phase，不能一概断言 disposed；实际操作目标需收敛到 active/disposed。证据保留这些测试过程修正，不把它们隐去后声称“一次全过”。

**复核步骤。** Linux/Python 3、当前 Node、CLI 安装的 host 0.19.0 / 内核 0.2.2-rc.1、已装 web 2.3.7，以及经核对的官方 web 2.3.12 解包目录；先构建本项目，运行真实 TUI 时不重建。准备器只写新临时目录，复用原安装的依赖解析（包括可选和隐式 backend 导入），**不是全新安装证明**。

```sh
node scripts/prepare-runtime-candidates.mjs "$HOST_DIR" "$WEB_DIR" "$WEB_RELEASE"
node scripts/check-runtime-candidates.mjs "<输出 root>/runtime-candidates.json"
# 仅比较实验宿主时，给准备命令追加 --with-raw-recovery
```

变量路径沿 §11.2。默认 launcher 使用原宿主 + 内核 stderr/新版 web flow 候选，冷启动启用 `mcp-flow`；模块检查仍会检查已生成的宿主实验方法，但不会把它接入默认 launcher。预期输出 3 个 `autoReconnect: true`、关闭后 canonical/echo 均为 false、正常退出模式均为 true，四项所有权守卫通过，诊断限量与已知值遮盖通过。再沿 §11 启动 launcher、浏览器接受 Preview Notice、打开 MCP 和 TUI `/skill-mcp`，先 web 停用冷启动 flow 行，再交替启停并等待工具数收敛，按 `R` 核对 TUI。全过程不应需要 `stty` 或整页重载。模块检查可能短暂添加/删除临时 MCP 包内的测试导出，不能对真实安装目录运行该检查。

**当前边界与下一项。** 本轮没有新增产品功能、改变 D-10/D-12 边界或修改真实安装。已验证的是隔离候选组合与当前 Linux/Node/本地 stdio fixture，未验证 Windows、真实 HTTP/OAuth、全新 registry 依赖安装或用户完整验收。下一项按需求 §14「下一步」第 1 项审阅内核诊断策略与 web 修复的集成方式；真实安装更新仍沿 AGENT.md §2 的授权边界，宿主实验不默认随之采用。共享技能分组并发限制和发布前完整人工清单继续保留。

本轮最终检查：3 个脚本语法、带临时路径守卫的候选生命周期检查、默认/实验两种准备器链接、真实安装路径误入时拒写的反例均通过；两个补丁在独立原文件副本上 `git apply --check`/应用后，与实测候选逐字节一致。已装 MCP/宿主入口哈希保持不变。`pnpm check:tarball` 退出 0，仍为 65 文件、89,602 字节、SHA-256 `3bf6abf4d2d34ef28c34e98299dcf2c66468c38bc3e1283a61387f7004ddaa91`；新增候选/工具/证据均未进入发布包。产品源码、README、manifest 和依赖均未变，本轮未重跑完整 `check:release`。

补丁数据的合法上下文前缀（空格后接原文件 tab）会被普通源码空白规则误判；`.gitattributes` 仅对证据目录的 `.patch` 关闭这一项，保留其他空白检查，源码检查不变。最终 `git diff --check` 与提交检查通过；补充 `npm pack --dry-run`（含 prepack 构建/manifest）仍为 65 文件，未包含该属性文件、工具或证据。

### 11.4 真实环境变更与恢复清单（提案，2026-11-11）

**状态：可审阅、已在隔离目录演练，未获真实安装更新授权、未实施。** 本节形成需求 §14 的下一项准备结果；§11.2/§11.3 的候选验证不等于用户已经选择部署方式。私有评审包由准备命令输出，包含原文件、候选文件、逐文件哈希/权限、计划及演练报告；脱敏结果见 [m5-compat-rollout.json](research/evidence/m5-compat-rollout.json)。本轮推荐的临时方案编号为 `9a27a2a35acd4248`，后续批准针对这个内容快照，执行前仍须重读状态。

**原始现象与根因沿 §11.2。** web 空值卡片来自返回 envelope 解包错误，多行 flow 操作失败来自编辑区间漏掉闭合符，冷启动 MCP 关闭后输入异常来自继承的终端 stderr；三项不能靠改本面板配置或反复刷新一并解决。本节仅选择部署边界，不增加产品运行时补丁。

**两种集成路径及取舍（均未采纳为产品决定）。**

| 路径 | 修改与已验证依据 | 代价/缺口 |
| --- | --- | --- |
| 官方 web 2.3.12 + flow 候选，配合局部 MCP 候选 | 官方包的卡片修复与原宿主组合测试见 §11.3；本机两个 web 包各 30 文件，24 相同、6 改变（含 gateway/wire、client、manifest 和两份 README） | 协议包从 dependency 移到 peer。本机 `0.2.2-rc.1` 按默认 semver 不满足其 `>=0.2.0-rc.1 <0.3.0-0` 范围；这不等于每种安装都会失败，但不能把链接依赖运行成功当成干净安装通过。flow 与内核仍需本地补丁。 |
| **建议作为本机临时验证选项：web 2.3.7 两项回移 + 局部 MCP 候选** | 仅回移已测的 adapter 解包和 flow 区间修复；[两文件补丁](research/evidence/web-2.3.7-compat-backport.patch)只适用于本轮哈希匹配的 2.3.7。配合 MCP vendor 的新组合 pilot 已验证冷启动 web 停用、TUI 重新启用，双方 loader/工具/终端一致，退出码 0 | 版本号仍显示 2.3.7，需要私有回执区分本地补丁。包管理器可能覆盖两个文件或清理未声明的局部链接；每次维护后需重验。它不是可发布的上游修复，不替代 AC-15 或完整人工验收。 |

不再把“优先评估官方升级”理解为立即执行整包更新；当前有 peer 安装缺口，先把两条路径交给用户选择。**2.3.7 的 adapter 补丁不能应用到 2.3.12。** 宿主 false→true 恢复实验不纳入任一路径。

**建议临时方案的具体写入范围（尚未执行）。** 只读检查确认两个 profile 的 MCP 局部入口均不存在，当前回退到 CLI 内核原包；两层模块父目录均为真实目录，无目录链接扩大写入范围。

| 位置 | 原状态 → 候选状态 | 影响 |
| --- | --- | --- |
| `~/.dsh/profiles/dsh-tui/node_modules/@deepseek-ai/dsh-mcp-client` | 不存在 → 指向私有 vendor 的新链接 | 该 profile 下新启动的 stdio MCP 使用 stderr 隔离和限量诊断 |
| `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-mcp-client` | 不存在 → 同一 vendor 的新链接 | web profile 同样生效；不能只修一个 profile |
| `~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel/lib/client.js` | 原 2.3.7 → adapter 校验并返回 `result.server` | 修复启停后的卡片状态；网页需重新打开以加载更新后的客户端 |
| 同包 `lib/patch-editor.js` | 原实现 → flow 集合使用 `range[1]` | 影响 flow 启停/编辑/删除定位，保留集合外注释 |
| `~/.local/share/dsh-panel-compat/9a27a2a35acd4248/` | 不存在 → vendor、私有备份和回执 | vendor 是内核 MCP 包的副本，含 stderr helper；复用当前内核依赖，不能当独立 npm 安装包 |

全局 CLI MCP 原包和宿主代码不修改；profile package.json、lockfile、profile/home YAML、技能、分组及本面板源码不修改。局部链接的作用范围已有 Node 对照演练；DSH profile 局部链接的实际运行由本轮独立 pilot 补充，**并未启动/更新真实用户 profile**。

**诊断策略需确认。** 临时沿用已测候选：`warn`、每行 4 KiB、每连接正文 16 KiB/32 行、超额继续消费并抑制日志、仅精确遮盖 `config.env` 已知值。普通 stderr 被记为 warn 不表示服务器失败；未知格式的敏感输出不能承诺自动识别。限量会丢弃超额诊断，因此这组值先作为本机验证提案，不替上游决定生产默认值。

**实施前提与步骤，供后续授权后使用。**

1. 用户退出受影响的 dsh-tui/web 实例、停止包管理器和对相关包文件的编辑；不主动杀掉正在使用的会话。模块解析会缓存旧路径，局部覆盖不承诺 HMR 切换。更新后重新打开网页加载新客户端；验收期间不靠整页刷新恢复错误。
2. 重读 Node/内核/host/web 版本，核对原 MCP 与两份 web 文件的哈希、父目录类型及两条目标仍不存在。核对计划中保留文件的哈希；任一漂移先停止并重制方案，不把旧计划强行套到新安装。
3. 在私有存储中完整准备 vendor 和备份：目录 0700、回执/备份至少限制为当前用户可读；保存原 web 字节、权限、哈希，记录链接原本不存在。校验备份后才允许写入。`/tmp` 评审包不能充当唯一持久备份。
4. vendor 完整复制并校验后，再建立两条局部链接；对新链接直接创建并让 `EEXIST` 失败，避免覆盖外来入口。web 两文件分别在原目录写临时文件、保留权限并原子替换，逐项记录状态。**跨目录的四项变更不是一个原子事务**；中途失败按已完成项补偿回退。
5. 重新核对目标哈希和两个 profile 的解析路径；原 CLI 包与 host 仍须保持原哈希。先用独立 fixture/profile 验证实际加载的 vendor、冷启动关闭与重新连接，再由用户运行真实配置的完整验收。不自动改真实 YAML 来添加测试服务器。
6. 验收完成前保留备份与回执；不得把本机临时补丁、哈希核对或本轮 pilot 标成上游版本发布/用户完整验收。真实 profile 的新旧版本替换、并发写和断电恢复没有在本轮证明。

**恢复步骤与停止条件。**

1. 先退出两个受影响实例。读取回执，确认需要回退的完整集合；先检查每个现存链接仍指向本次 vendor、每个 web 文件仍为候选哈希，且备份仍匹配原哈希。
2. 若任一目标被外部修改或备份损坏，**整批停止自动恢复**，保留文件并人工比较；不能用旧备份覆盖新的用户/包管理器改动。
3. 对已替换的 web 文件恢复原字节与权限，只删除本次创建且仍指向本次 vendor 的两个链接。重启后解析应回退到 CLI 原包；第三个 profile 不应改变。回退恢复的是原版本，也会恢复原先已知问题。
4. 核对恢复后的哈希、权限和原解析路径。确认无进程或链接仍引用 vendor 后，才考虑清理该目录；备份和回执不自动删除。进程中断时以回执和每项目标的原/候选哈希辨认完成状态，不猜测整批是否成功。

**演练与复核。** 以下命令只准备评审包和新沙箱，不提供真实安装的 apply 入口，要求本机已装 web 2.3.7、host 0.19.0、内核 0.2.2-rc.1，且源码哈希匹配本轮基线：

```sh
node scripts/prepare-compat-rollout.mjs ~/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel
node scripts/rehearse-compat-rollout.mjs "<输出 root>/review-plan.json"
```

预期报告：两 profile 的新解析、第三 profile 不变、成功应用/恢复、第三步注入失败后的恢复、源文件漂移/已有入口/回退冲突/损坏备份拒绝、字节和权限恢复全部为 true。检查器拒绝真实目录、越界 relative 元数据和 MCP payload 哈希漂移。解析检查使用新 Node 子进程模拟重启，避免进程内解析缓存误判；这是文件系统/Node 解析演练，不是包管理器或真实安装回退测试。

本轮另将同一 payload 链入新隔离 DSH profile，用实际 2.3.7 网页与原宿主验证冷启动 flow 停用（0 工具、disposed、raw）和 TUI 启用（1 工具、active、raw），无整页重载或手动恢复，正常退出 0。此前 §11.2/§11.3 的编辑/删除、自动重连与日志证据继续有效，当前 pilot 不冒充用户真实 MCP 全测。两个脚本语法、路径拒绝反例、原安装/保留数据未变和 npm dry-run 均核对通过；dry-run 为 65 文件，不包含工具/文档，本轮未重跑构建或 `check:release`。

**下一项是用户的部署选择与授权。** 选择临时方案后，按上述范围准备持久备份、停机窗口和执行时重新核验；选择等上游，则保持真实安装不变，后续可整理上游评审材料但不擅自发送。真实写入必须遵守 AGENT.md §2 和需求 §14 的既有边界；本轮没有新增审批规则。开发版本仍为 `0.1.0-dev.0`，AC-15、完整人工验收与发布继续待完成。
