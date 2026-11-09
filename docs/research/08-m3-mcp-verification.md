# 08 · M3 MCP 只读列表与启停（2026-11-08）

> 范围：M3 的 P0——MCP 只读列表（profile patch + home 层 + loader 运行时状态）、启停（按 ADR-0001：patch 文本编辑为主路径）、诊断页补充。MCP 新增/编辑/删除（受管块完整编辑）属于 M4；home 层只读。
> 关联：[`01`](01-dsh-tui-plugin-architecture.md) §6.3、[`03`](03-dsh-skills-and-mcp-mechanisms.md) §2–§3、[`05`](05-m0-real-machine-probe.md) Q9、[`../decisions/0001-mcp-toggle-via-patch-text.md`](../decisions/0001-mcp-toggle-via-patch-text.md)。
>
> §1–5 保留 2026-11-08 的初版证据；**启用语义、锁/冲突/备份与当前验证以 §6 的修正为准**。

## 1. 实现位置

| 能力 | 模块 |
| --- | --- |
| patch 解析（含 `!!js` 自定义 tag）、行展平、MCP 行识别、profile/home 层合并、脱敏描述 | [`src/domain/mcp/patch.ts`](../../src/domain/mcp/patch.ts) |
| 受管块 `disabled` 覆盖写入/移除（字节保留、YAML 校验、原子写、备份） | 同上 |
| loader + patch 合成列表、启停、HMR 轮询、状态消息、诊断 | [`src/host/manager-runtime.ts`](../../src/host/manager-runtime.ts) |
| MCP 页（列表/详情/启停/动作条）、诊断页 MCP 段 | [`src/ui/ManagerScene.tsx`](../../src/ui/ManagerScene.tsx) |

## 2. 关键不变量

- **数据源**：loader 条目（`@deepseek-ai/dsh-mcp-client`）提供运行时状态（enabled / fiber phase）；profile 与 home patch 提供配置与层级；`pluginManager.listPlugins()` 不用（ADR-0001：实测为空）。
- **层级**：同一 id 在 home 层出现 → `layer=home`，**只读**（home 覆盖 profile）；只在 profile → 可启停；都不在 → `layer=bundle`，只读。
- **`!!js` 表达式**：用 `yaml` 的 custom tag 解析（`tag:yaml.org,2002:js` → `{__js}`），不 `eval`；`disabled` 为表达式的行**不提供布尔开关**（面板显示表达式并标记只读）。
- **受管块**：只写本插件自己的块
  ```
  # >>> dsh-tui-skill-mcp-panel:mcp-toggle:begin
  - id: <行 id>
    disabled: true
  # <<< dsh-tui-skill-mcp-panel:mcp-toggle:end
  ```
  追加在文件末尾，靠 patch 后序覆盖生效；启用 = 删掉对应行；块空则删除标记；**块外字节零改动**（测试断言开/关往返后与原文完全一致）。marker 与 web 版不同名。
- **写入安全**：写前备份到 `~/.dsh-tui/skill-mcp-panel/backups/<ts>/cordis.patch.yml`；写后重新解析 YAML 校验；临时文件 + rename 原子写；写入失败/解析失败报错不动原文件。
- **热加载**：写入后 UI 显示「已保存，热加载中…」，每 400ms 轮询 loader（最多 10s）；观测到状态变化 → 「已生效」，超时 → 提示检查诊断/可能被覆盖或需重启（不假装瞬时）。
- **脱敏**：`env`/`headers` 只显示 key，值一律隐藏；`!!js` 只显示为表达式占位，不渲染表达式内容中的敏感部分（表达式文本本身可显示，但值不解析）。
- **只读表达**：home 层、bundle 行、`!!js` 控制行在列表与详情中标注「只读」并说明原因。

## 3. 验证证据（本次）

- **域层单测**（`test/domain/mcp-patch.test.js`，6 个，全部通过）：
  1. `!!js` 解析（env/headers/disabled）、insert/override 展平、非法 YAML；
  2. 受管块增/改/删、重复操作幂等、**开关往返字节还原**；
  3. 块在文件中部时原位替换；
  4. 层级合并（profile/home/bundle/表达式）与只读原因；
  5. 配置描述/脱敏（不泄漏 env/header 值）；
  6. 备份文件内容 + 原子写落盘 + 重新解析。
- **运行时 smoke**（`pnpm test:mcp`，headless，真实 `ManagerRuntime` + fake loader/configEditor + 临时 patch）：
  - 列表 4 行、层/只读/`!!js` 标记正确；
  - 启停写入受管块、块外字节保留、备份生成；
  - 模拟 loader 在写后翻转 → 轮询判定 `applied`、行变停用；再启停恢复且文件与原文完全一致；
  - home 层行启停被拒绝且文件不变。
- **UI smoke**：`pnpm test:ui` 通过；`pnpm test:ui:interaction` 增加「Tab 到 MCP 页渲染（无 patch 时为空状态）」断言通过。
- 全量：`pnpm test` → **28 pass / 0 fail**。

## 4. 待真机验收（未验证）

1. 真实 profile 里放一条 MCP 行（或使用 probe profile 里的 `mcp-probe`），在 TUI 中 `空格` 启停 → 状态行「已保存，热加载中…」→「已生效」；观察 loader/HMR 实际延迟与失败行为。
2. home 层同名行覆盖时的只读提示；`!!js` 控制行的只读提示。
3. 与 web 面板共享磁盘约定：仅共享 `cordis.patch.yml` 文件本身，受管块 marker 不同；无锁互操作（M4 补锁）——并发写风险仍在。
4. 真实 MCP server 的 `env/headers` 脱敏观感；长 server 名/窄屏列表布局。

## 5. 下一步（M4）

- MCP 新增/编辑/删除：受管块（`insert` 行，marker 与 web 版不同名）、字节保真、表单 + 原文双通道、写前备份/撤销、`.panel.lock` 锁与 web 版互操作；
- MCP 分组（本插件 `config.json` 的 `mcpGroups`，不扩展 web groups schema）；
- 连接测试（内核无 API，需评估 MCP SDK 或临时挂载）。

## 6. 2026-11-09 启用边界与写入保护补强

### 6.1 修正与实现

- 初版「启用 = 删除本面板覆盖」不能启用用户原配置已写 `disabled: true` 的行。现在显式写 `disabled: false`，回到原始状态时移除覆盖；原配置逐字节保留。
- `src/domain/mcp/write.ts` 将写入集中到事务：共享锁 → 校验页面快照/profile+home/目标身份 → 生成候选 → 强制备份 → 临时文件 → rename 前再次检查 → 原子提交。原文件权限保留；备份目录/文件分别为 0700/0600。备份失败停止，不出现保存成功提示。
- 共享锁采用 web 2.3.7 的 `<patch>.panel.lock` 与 pid/时间换行格式，默认等待 5s；超过 30s 且进程已退出的锁可回收；释放时核对 inode，避免删掉别人的替换锁。等待 HMR 时不占锁。
- 快照冲突停止并提示按 `r` 重新读取；没有强制覆盖入口。普通编辑器不受锁约束，最终检查到 rename 间仍有极短竞争窗口，不能宣称对非协作写入绝对互斥。
- 受管块使用 YAML 节点位置只编辑目标覆盖，保留其他原始字节、外来配置、注释与 CRLF；标记不成对/重复、目标有外来字段或重复目标时拒绝写入。
- 真机发现初版只看 `disabled` 就会在 fiber `loading` 时误报「已生效」。现等待 `active`；`failed` 显示「配置已保存，但插件加载失败」。停用需观察 fiber 消失/`disposed`。插件 active 不单独保证连接成功，工具可用性另用 `/mcp` 核对。
- MCP 页补作用域限制常驻提示；验证用 render dump 移除过时的 M3 占位内容；JSON dump 的 `env`/`headers` 值脱敏。

### 6.2 自动化与共存证据

- 域层新增原始停用行启用/还原、CRLF/外来行保真、损坏块拒写、id 转义、快照冲突、备份失败、权限、并发、锁超时/陈旧回收/替换锁保留、提交前冲突清理、目标模块身份等回归。
- 修复缺失根测试对 `DSH_BUNDLED_SKILL_DIR` 的环境依赖；正常 `pnpm test` 不再需要额外清环境变量。
- `scripts/mcp-smoke.mjs` 使用真实 ManagerRuntime + fake loader：增加原始停用行往返、两层外部修改冲突、备份失败、loading 等待、failed 拒绝成功提示、dump 脱敏。
- 本轮最终检查：`pnpm typecheck`、`pnpm test`（42 pass / 0 fail）、UI 渲染（160/58 列）、UI 交互、MCP smoke 均通过；原始结果摘要见 [`evidence/2026-11-09-mcp-hardening.json`](evidence/2026-11-09-mcp-hardening.json)。
- 【已实测】直接导入本机 web 2.3.7 的 `withPatchLock` 与本插件锁，在临时 patch 上分别先持有 web/TUI 锁，让另一方竞争；两种方向均按「先持有者退出，后等待者进入」顺序执行。这里只验证实际锁实现互操作，不等同于两个完整 UI 的 AC-15 已通过。

### 6.3 真实 TTY 复现入口与边界

```sh
pnpm build
node scripts/prepare-tui-probe.mjs ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
# 在真实终端运行输出的 launcher 路径（/tmp/skill-mcp-real-tui-…/run.sh）
```

脚本只在 `/tmp` 创建独立 profile、项目技能、插件存储与本地 stdio MCP；符号链接复用已安装宿主/本仓库。不复制日常 profile、不改真实配置、不下载 MCP 包、不发模型请求。宿主首选项不认 `DSH_TUI_HOME`，因此使用仅测试进程的 Node preload 重定向 `os.homedir()`；不修改 HOME。显式选择 backend `dsh`，防止继承外部 Codex backend。

【环境实测】开发依赖里的宿主可以 headless 渲染，但真实启动缺少内核 peer（`@deepseek-ai/dsh-session-persistence-jsonl`）；传入 CLI 已安装的宿主目录后可启动。首次测试暴露 loading 误报，修复后需以最终构建再次走查；**真机测试期间不要重建 lib，宿主会 HMR 重载插件并关闭场景，可能导致 PTY raw mode 失效**。

操作：`/skill-mcp` → `2` → `j/j` 选 `mcp-probe` → 空格启用；预期热加载后 active，退出后 `/mcp` 显示 `mcp-probe（1 个工具）: ping`。再次空格停用后工具消失、配置还原；`mcp-home`/`mcp-expr` 空格拒绝写入。临时 profile 添加外部注释后直接空格，应提示变化且保留原文件；按 `r` 再试方可保存。

真实 TTY 操作属于键盘驱动验证，不替代用户的鼠标/观感验收、全布局矩阵、模型侧技能同步或完整 web/TUI 并发场景。

【本轮真实 TTY 实测】160×48 fullscreen，`mcp-probe` 原始 `disabled: true`：启用约 2.517s 后 `active`，停用约 2.481s 后 `disposed`，完整往返后文件与启用前备份逐字节一致；`/mcp` 启用时列出 `mcp-probe（1 个工具）: ping`，停用后提示没有配置的 MCP。外部追加注释后直接空格得到 `conflict`，外部内容保持；home/表达式行只读提示与拒写均通过；dump 的 env 为 `***`。技能临时夹具停用后 `/skills` 空、启用后有 `/probe-skill`；`d/y/u` 真机删除/撤销后正文一致。这些属于 AC-10/13 的 UI/文件部分，模型侧同步与 MCP 删除撤销仍缺证据/实现。
