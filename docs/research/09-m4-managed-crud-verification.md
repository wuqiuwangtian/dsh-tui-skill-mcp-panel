# 09 · M4 本面板受管 MCP CRUD（2026-11-09）

本轮范围按需求 **D-10**：新增 stdio/Streamable HTTP MCP；仅编辑、删除与撤销本面板受管行。已有 profile 行保留启停，home 与 `disabled: !!js` 控制行只读。MCP 分组、搜索/筛选、连接测试与发布不在本轮交付范围；不把本轮称为任意 profile 行的完整 CRUD。

## 1. 实现入口

| 模块 | 用途 |
| --- | --- |
| `src/domain/mcp/model.ts` | 字段校验、JSON args、KEY=VALUE 增量输入、`${ENV}` 表达式、变更键摘要、敏感字段展示 |
| `src/domain/mcp/managed.ts` | 专用 `mcp:begin/end` 插入块的增删改；YAML 节点位置定位，保留非目标字节 |
| `src/domain/mcp/crud.ts` | 共享锁/快照/备份/原子写事务，删除清单与持久撤销 |
| `src/domain/mcp/patch.ts` | 支持自定义 `!!js` 的解析/序列化与不可枚举的表达式来源标记；解析错误不附带原文 |
| `src/host/manager-runtime.ts` | 原始配置表单会话、管理边界、HMR 状态与 runtime 重载判定、回收站摘要 |
| `src/ui/ManagerScene.tsx` | `a`/Enter/`d`/`u`、字段表单、变更确认、掩码输入、键盘/动作条 |

## 2. 数据与写入约束

- 新增块使用需求规定的 `dsh-tui-skill-mcp-panel:mcp:begin/end`，与 M3 的 `mcp-toggle` 块及 web 版 marker 分离。新块前置，使既有覆盖、启停块仍处于后序；其他配置字节不变。仅有 `[]` 的空数组根会转换为块式列表，空根的排版不保证往返；没有用户行因此不会丢配置。
- 新增拒绝文件级/活跃实例重名，id 使用 `mcp-<serverName>`，碰撞加序号。编辑以原始文件的 `serverName + entryId` 双键定位，保留未知行属性/配置字段与真正的 `!!js`。未知自定义 tag、重复 id、歧义容器、另有 config 覆盖时拒写，不猜测合并。
- 编辑/删除仅接受本面板块中的 MCP insert。配置从磁盘读，绝不把 loader 已求值的 env/header 回填到磁盘。普通 `{ __js: "…" }` 映射保持普通数据；只有解析来源/显式构造的表达式带内部来源标记，避免把数据意外升级成可执行标签。插件不求值表达式。
- `args` 为 JSON 字符串数组；env/headers 每行 KEY=VALUE。`${ENV}` 转成仅访问命名环境变量的表达式，文本片段用 JSON 转义。敏感输入不显示原值；留空保留，`-KEY` 删除键，`!` 清空。已有表达式空输入保留。
- 写入持有与 web 版兼容的 patch 锁，两层文件与打开表单时的快照一致才继续；备份在提交前完成，最终 rename 前复核快照。备份失败、清单失败、冲突均停止。普通编辑器不遵守锁时仍存在最后一次检查到 rename 之间的极短竞争窗口，见 ADR-0001。
- 删除前写 `trash/mcp/<UUID>/manifest.json`，记录源片段、位置、前后哈希及整文件备份引用（目录 0700、文件 0600）；同时移除本面板对应启停覆盖。撤销只有在文件仍为删除后的精确内容、home 未变、备份哈希正确时才恢复整份原文；外部变化时拒绝覆盖，提示重新加载/手工合并。清单不进入 UI/dump，后者只有无密钥摘要。自动清理尚未接入。
- 保存与应用分开：新增/恢复等待 loader 行与 active；删除等待 loader 行消失；编辑还需观察 options/config/fiber 版本变化，避免用重载前的 active 误报成功。超时或加载失败不自动覆盖回滚已保存文件。

## 3. 自动化验证

```sh
pnpm typecheck
pnpm test
pnpm test:mcp
pnpm test:mcp:crud
pnpm test:ui:interaction
pnpm test:ui
```

本轮执行：域层 **54 pass / 0 fail**（新增 12 项 M4 回归）、构建/类型检查、原有启停 smoke、技能交互与渲染 smoke 均通过。

`mcp-crud-smoke.mjs` 使用真实宿主 React/UI kit、真实 ManagerRuntime、临时文件与稳定 fake loader（延迟按磁盘重组合，非定时盲翻转），在 **120 列和 58 列** 各验证：

1. stdio 表单字段、密钥/多行引用、保存字段摘要与取消返回；
2. 编辑 args，未知键与环境表达式保留，重载前不会报告 applied；
3. 删除确认取消、删除、撤销后逐字节恢复；
4. 原始 profile 行拒绝编辑/删除；
5. HTTP 表单 URL/headers/引用、transport 子表单 Esc 返回；
6. 新建 ManagerRuntime 从磁盘找到清单并撤销，证明不依赖内存中的删除状态。

域层还覆盖：CRLF、块内外来行与 insert 兄弟、缺失/空 profile、歧义标记/重复 id/表达式控制拒写、命名冲突、未知键/标签、字面 `__js` 对象、备份/清单失败、两层快照冲突、撤销前外部修改、错误摘要不泄漏原文。

## 4. 真实 TTY 验证

环境：Node v26.3.0、DSH 0.2.2-rc.1、已安装 dsh-TUI 0.19.0，160×48 fullscreen，DSH backend。通过 `prepare-tui-probe.mjs` 生成 `/tmp` 下独立 home/profile/project/panel，测试进程的 `os.homedir()` 重定向；不改 HOME 或日常配置，不安装外部 MCP、不发模型请求。

```sh
pnpm build
node scripts/prepare-tui-probe.mjs ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
# 在真实终端执行输出的 launcher
```

复现入口：`/skill-mcp` → `2` → `a`。serverName 可填 `m4-local`；command 使用 `node -p 'process.execPath'` 输出的绝对路径；args 使用本仓库 `test/fixtures/mcp-stdio-server.mjs` 的绝对路径组成的 JSON 数组。env 输入 `PANEL_REF=${TERM}`（可另加普通测试值），保存确认后等待生效。

【已实测】真实键盘驱动界面，执行新增 → 编辑 args（加 `--revision`, `2`）→ 删除 → 退出/重新进入场景 → `u` 撤销：

| 操作 | 保存至应用耗时 | 结果 |
| --- | --- | --- |
| 新增 | 2.540s | 新行 active/受管，`/mcp` 列出 `m4-local（1 个工具）: ping` |
| 编辑 | 2.514s | 新参数进入 loader，active；原环境引用保留，dump 为 `***` |
| 删除 | 2.064s | loader 行消失；`/mcp` 提示未配置 MCP；文件与新增前备份逐字节一致 |
| 撤销 | 2.511s | active，`ping` 恢复；文件与删除前逐字节一致 |

环境输入、确认、详情与 render dump 未出现测试敏感值；落盘保留 `!!js`，不写入 loader 求值后的字符串。原始结果摘要与源码哈希见 [`evidence/2026-11-09-m4-managed-crud.json`](evidence/2026-11-09-m4-managed-crud.json)。真实进程已退出，stdio 夹具无残留。

## 5. 尚未验收/实现

- HTTP 真实服务器连接、本轮冷启动真实 TTY 撤销未单独运行（HTTP 与冷恢复已覆盖 UI/runtime/fake loader；stdio 实际连接与同进程场景重开已实测）。
- 用户鼠标与观感验收、完整 inline/fullscreen/宽度矩阵、模型侧技能 catalog 同步、完整 web/TUI 并发 UI 仍不能标为通过。
- MCP 分组/搜索/状态筛选、MCP 删除清单自动清理、manifest/tarball/发布检查待补。已有用户行编辑/删除仍按 D-10 排除；连接测试为 P1 可选。
