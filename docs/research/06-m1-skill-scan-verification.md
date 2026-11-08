# 06 · M1 技能扫描真机验证（2026-11-08）

> 目的：验证 M1 的 domain 扫盘实现与 **DSH 0.2.2-rc.1 内核发现结果一致**（需求文档 §10 M1 退出条件「列表与内核发现一致」、§9.1 AC-1），并记录尚未完成的 UI 视觉验收。
> 关联：[`05-m0-real-machine-probe.md`](05-m0-real-machine-probe.md)（宿主接缝实测）、[`../需求文档.md`](../需求文档.md) §4.2。

## 1. 方法

1. **域层单测**：`pnpm test`（9 个用例）用临时目录构造目录束 / 平铺 `.md` / `.disabled` / 非法 frontmatter / 同层重名遮蔽 / `.system` / 缺失根，断言发现根、状态、名称来源（frontmatter）、rank 排序与遮蔽关系。
2. **真机对比**：在项目根（`~/.dsh/profiles/dsh-tui-probe` 独立 profile）放置一组磁盘夹具，同时采集：
   - 插件自身扫盘结果（`ManagerRuntime` 在 `SKILL_MCP_PANEL_DUMP=<path>` 时写 JSON dump）；
   - **内核实际发现结果**：同一 DSH 内核宿主（web profile 会话）的实时技能目录（`available skills` 列表），它由同一个 `dsh-skill-filesystem` provider 提供。
3. 夹具（项目工作区，git 忽略）：

```text
.dsh/skills/alpha/SKILL.md                 目录束，name=alpha
.dsh/skills/beta.md                        平铺，name=beta
.dsh/skills/from-frontmatter.md            文件名 from-frontmatter，frontmatter name=flat-inner-name
.dsh/skills/mismatch-dir/SKILL.md          目录名 mismatch-dir，frontmatter name=mismatch-name
.dsh/skills/gamma/SKILL.md.disabled        停用（目录束）
.dsh/skills/delta.md.disabled              停用（平铺）
.dsh/skills/broken/SKILL.md                非法（缺 description）
.dsh/skills/.system/hidden/SKILL.md        应不被发现（一层扫描）
.agents/skills/alpha/SKILL.md              name=alpha，rank 200 被 rank 100 遮蔽
```

## 2. 结果

**插件 dump（真机）**（完整 JSON 见运行输出；字段见 `src/host/manager-runtime.ts`）：

| name | source | status | effective | 说明 |
| --- | --- | --- | --- | --- |
| alpha | project-dsh | enabled | ✅ | 目录束，rank 100 胜出 |
| beta | project-dsh | enabled | ✅ | 平铺 |
| flat-inner-name | project-dsh | enabled | ✅ | 名称取自 frontmatter |
| mismatch-name | project-dsh | enabled | ✅ | 名称取自 frontmatter；有「目录名不一致」警告 |
| probe-skill | project-dsh | enabled | ✅ | M0 遗留夹具 |
| software-delivery-workflow | user-dsh | enabled | ✅ | 真实全局技能 |
| alpha | project-agents | enabled | ❌ 被遮蔽 | shadowedBy=project-dsh 的 alpha |
| gamma | project-dsh | disabled | — | `SKILL.md.disabled` |
| delta | project-dsh | disabled | — | `.md.disabled` |
| broken | project-dsh | invalid | — | 原因：`frontmatter requires name and description` |

**内核实际目录（同一时刻）**：`alpha, beta, flat-inner-name, mismatch-name, probe-skill, software-delivery-workflow`。

→ **结论：内核可见集合 = 插件 `status=enabled && effective=true` 集合，逐项一致**；被遮蔽、停用、非法、`.system` 四类都没有出现在内核目录中，插件也分别标为 shadowed/disabled/invalid/未发现。这验证了：

- 发现根与 rank：project `.dsh/skills`(100) 遮蔽 `.agents/skills`(200)；
- 名称来源：目录束与平铺都取 frontmatter `name`；
- `.disabled` 约定与非法 frontmatter 的「存在但不可用」展示；
- 一层扫描 + `.system` 跳过（项目根下 `.system/hidden/SKILL.md` 不被发现）。

**单测**：`pnpm test` → 9 pass / 0 fail（frontmatter 6 + 扫盘 3）。

## 3. 已知缺口（未验证，不要写成已验收）

1. **UI 视觉验收未完成**：本环境的终端工具在脚本化 pty 里对长驻 TUI 的输出捕获不稳定（`script` 类型记录只在进程退出时落盘，且部分运行会话拿不到完整帧），因此 `/skill-mcp` 场景的逐屏人工走查（列表/详情/诊断、宽窄屏、键盘）**仍需真实终端手工执行**（对应 AC-9 的 UI 部分、AC-14）。场景注册/打开路径与 React 契约已在 M0 探针中实测可用（`docs/research/05` §3）。
2. **bundled 根**：本次启动环境未设置 `DSH_BUNDLED_SKILL_DIR`，`bundled` 根不存在；TUI 正常启动时由启动器提供该变量，需在真实 TUI 里再核对一次「随包技能」行。
3. **customSkillDirs**：host 插件读不到 provider 配置，当前按未配置处理 → 自定义技能根会被漏掉（诊断页已注明）。若必须支持，需要从 profile patch/设置读取 provider 配置（后续里程碑）。
4. **运行期注册技能**：扫盘只覆盖文件来源；`ctx.skills.register` 的 runtime/agent-scope 技能不在列表中（M0 已确认 host 层 `ctx.skills` 为空，无法互补）。
5. **AC-10（TUI `/skills` 与模型侧热更新）**：M0 已确认 `.disabled` 内核机制，但 TUI 内的逐步走查仍未做。

## 4. 复现

```sh
pnpm test
# 真机（建议先备份/使用独立 profile，见 AGENT.md §7）：
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID TERM=xterm-256color \
  SKILL_MCP_PANEL_DUMP=/tmp/skill-mcp-panel/dump.json \
  dsh --profile dsh-tui-probe        # 插件 activation 后即写 dump
```

`SKILL_MCP_PANEL_DUMP` 只用于验证/调试；未设置时插件不写任何临时文件。
