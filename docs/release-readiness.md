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

当前实测环境与结果见[结构化证据](research/evidence/m5-readiness.json)。自动化通过不替代下方人工验收，也不会自动启动发布。

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
| 待测 | AC-15 共存：同一测试 profile 中 web/TUI 交替停用技能与 MCP；刷新双方一致，受管块互不覆盖；并发写触发等待/冲突，无丢行。共享技能分组并发保护仍是已知缺口，不能先勾选其并发通过。 |
| 待测 | AC-16/18 限制与信任：MCP 顶部“无工作区级”、home 只读、帮助/README 一致；宿主装/启用前显示进程内全信任/非沙箱。错误/备份路径可找到，关闭面板后宿主键盘正常。 |

记录格式：包版本/提交、宿主/内核/Node、终端尺寸与模式、操作、实际结果、必要的脱敏截图/日志。失败保留最短复现，不将自动化报告当成人工勾选依据。

## 5. 发布执行前提

1. 处理需求 §14 的剩余发布缺口，完成上述人工测试并记录；本轮检查通过不会消除共享技能分组并发等已知限制。
2. 用户确认要发布的版本与范围，再同步 package/manifest/version/tag；目前不创建 tag。
3. 对最终提交重跑 `pnpm check:release`，重新生成最终 tgz 与摘要；当前开发包摘要不是未来发布包摘要。
4. 获得打 tag / npm 发布 / Release 上传的对应授权后，才执行 AC-19；provenance 与生态投稿依据当时实际渠道处理。未发布前不写成已完成。
