# M4 MCP 分组与搜索筛选验证

日期：2026-11-09。基线：dsh-TUI 0.19.0、DSH 0.2.2-rc.1、开发包 0.1.0-dev.0。承接 [09 受管 CRUD](09-m4-managed-crud-verification.md)，需求依据为 [FR-8/FR-9、D-11](../需求文档.md)，当前阶段仍以该文档 §14 为准。

## 1. 本轮范围与决定

用户确认 D-11：MCP 分组按当前 profile 隔离，避免其他 profile 的同名服务器、相同 entryId 串组。采用 `path.resolve(profilePatchPath)` 作为命名空间，不按显示名称或工作区判断；移动 profile patch 路径会形成新的命名空间，不自动猜测迁移。

私有 `config.json` 的 `mcpGroups` 每项为 `{ name, profilePath, members }`，成员是 `JSON.stringify([serverName, entryId])`。可以包含只读行，空组保留；同 profile 组名不重复，跨 profile 可以同名。受管服务器改名同步双键；删除服务器保留引用，撤销后恢复归属。外部编辑器直接改名时不自动猜测对应关系，需重新整理成员。

分组只改变显示元数据，不写 MCP YAML、不改变连接、不扩展共享技能 `groups.json`。MCP 页 `g` 管成员，`f` 选状态/分组，`/` 搜索，`x` 清除过滤；分组页 `t` 切换技能/MCP，`a/r/d/Enter` 创建/改名/删除/按组过滤。

搜索只匹配 serverName、entryId、transport、layer 和当前 profile 的分组名，按空白分词取交集；不索引 command、args、env、headers 等配置值。搜索、状态、分组条件可叠加，与技能页各自独立。状态提供全部/启用/停用/失败，失败依据 loader fiber 的 `failed`，不推测远端可达性。

## 2. 持久化与冲突边界

- 私有配置使用 `<config.json>.panel.lock` 串行化，锁内重读；不同 profile 的并发修改合并，同一 profile 的过期快照拒写并提示刷新。
- 临时文件 + 最后一次指纹检查 + rename；新文件 0600、目录 0700，现有文件保留权限，拒写符号链接或非普通文件。未遵守锁的写入仍有最终检查与 rename 之间的极短竞争窗口。
- 未知顶层字段、当前分组的未知字段、其他 profile 的原始记录值均保留。无 profile 的旧记录/无效记录隐藏并警告，原数据保留，不绑定到当前 profile。
- 整份私有配置损坏、未知版本或分组容器结构无效时保留文件并只读回退；不套用共享技能分组的损坏后重建策略，避免覆盖其他偏好。
- YAML 保存与私有 JSON 不是跨文件原子事务。若服务器改名已保存、分组同步失败，明确显示部分成功警告；不把 YAML 保存失败与元数据同步失败混为一谈。

## 3. 自动化证据

实际执行并通过：

| 检查 | 结果 / 覆盖 |
| --- | --- |
| `pnpm typecheck`、`pnpm build` | TypeScript 通过 |
| `node --test test/domain/*.test.js` | 61/61；新增 7 项 MCP 分组域层/存储检查 |
| `node scripts/mcp-groups-smoke.mjs 120` / `58` | 真实 host React/ui + ManagerRuntime + 临时文件 + 模拟 loader；分组 CRUD、双键同名、组合筛选、空结果、技能过滤独立、只读行归组、profile 隔离、同 profile 冲突、冷启动、改名/删除/撤销、45 组分页 |
| `node scripts/ui-render-smoke.mjs` | 160/58 列渲染回归 |
| `node scripts/ui-interaction-smoke.mjs` | 技能启停、删除/撤销、导入、共享分组回归 |
| `node scripts/mcp-smoke.mjs` | 两层读取、脱敏、启停、HMR、冲突、备份、home 只读回归 |
| `node scripts/mcp-crud-smoke.mjs 120` / `58` | stdio/HTTP 表单、未知键、持久撤销、原始行边界回归 |

复核入口：`pnpm test:mcp:groups` 会构建并执行 120/58 两种宽度。其他脚本由 AGENT.md §7 列出的命令调用。交互自动化使用临时目录，分组动作前后断言两层 YAML 与共享技能分组文件逐字节相等；不使用真实密钥。

## 4. 真实 TTY 证据

使用 `scripts/prepare-tui-probe.mjs` 创建 `/tmp` 独立 home/profile/project，启动 CLI 已装宿主，未修改真实 `~/.dsh` 或首选项、未发送模型请求。PTY 160×48（场景 156×46）通过键盘完成：

1. `/skill-mcp` → `2` → `g` → 新建 `TTY-group`，成员为表达式只读行 `mcp-expr`。
2. `/` 搜索 `TTY-group`，`f` 选停用；真实行数从 3 变为 1。
3. `3` → `t` → `Enter` 应用同一分组，搜索 + 停用 + 分组同时生效；`x` 清除 MCP 条件。
4. 分组页 `r` 改名为 `TTY-renamed`，关场景重开后仍保留。
5. 退出进程，以 PTY 58×30 重启同一夹具（场景 54×28）；分组与双键成员保留，全部 MCP 操作按钮分两行可见。

核对生成脚本的原始夹具文本与最终两层 YAML 完全相等，SHA-256 一致。证据：

- [结构化断言、过滤帧与冷启动帧](evidence/m4-groups-real-tty.json)
- [窄屏最终终端文本](evidence/m4-groups-narrow-screen.txt)（从真实 PTY 输出经 xterm/headless 复原，非组件快照；临时路径已替换）

两个测试进程均以 Ctrl+C 退出。分组不会激活初始停用的 MCP，未留下测试服务器进程。

## 5. 用户复验与剩余边界

先 `pnpm build`，按 AGENT.md §7 准备隔离夹具并启动输出的 `run.sh`。在 MCP 页选择一行 `g` 新建组，`f` 选对应状态/分组，`/` 输入组名；预期只看到交集，`x` 恢复全列表。分组页 `t` 切到 MCP 后改名，再退出进程重开，预期组名与成员仍在。该验收不要求连接服务或输入密钥。

真实 TTY 键盘验证不等于用户人工验收。本轮未验证鼠标点击、所有布局/inline、完整 web/TUI UI 并存、模型侧技能同步；M5 准入、tarball、发布检查仍未完成。整组批量动作、共享技能分组并发保护、MCP 删除记录清理仍在需求 §14 的剩余项内。任意原始 profile 行的编辑/删除继续遵守 D-10，不因分组功能而开放。
