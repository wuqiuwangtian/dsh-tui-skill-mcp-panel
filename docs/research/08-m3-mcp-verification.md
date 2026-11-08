# 08 · M3 MCP 只读列表与启停（2026-11-08）

> 范围：M3 的 P0——MCP 只读列表（profile patch + home 层 + loader 运行时状态）、启停（按 ADR-0001：patch 文本编辑为主路径）、诊断页补充。MCP 新增/编辑/删除（受管块完整编辑）属于 M4；home 层只读。
> 关联：[`01`](01-dsh-tui-plugin-architecture.md) §6.3、[`03`](03-dsh-skills-and-mcp-mechanisms.md) §2–§3、[`05`](05-m0-real-machine-probe.md) Q9、[`../decisions/0001-mcp-toggle-via-patch-text.md`](../decisions/0001-mcp-toggle-via-patch-text.md)。

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
