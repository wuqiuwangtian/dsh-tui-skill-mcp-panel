# ADR-0001：MCP 启停与列表以 patch/loader 为主路径

- 状态：已采纳（2026-11-08）
- 更新（2026-11-11）：追加 disabled 覆盖的具体写法由 [ADR-0002](0002-mcp-disabled-in-place.md) 替代；patch/loader 主路径与写入保护继续有效。以下覆盖写法保留为历史背景。
- 关联：[`../需求文档.md`](../需求文档.md) D-9、FR-9、FR-10；[`../research/05-m0-real-machine-probe.md`](../research/05-m0-real-machine-probe.md) §2 Q9

## 背景

需求初稿（FR-9/FR-10）假设 MCP 的「列表状态」可来自 `ctx.pluginManager.listPlugins()`、「启停」优先走官方 `ctx.pluginManager.setPluginEnabled(entryId, enabled)`，失败再回退 patch 文本编辑。

2026-11-08 在独立探针 profile（dsh-tui 0.19.0 + DSH 0.2.2-rc.1）真机实测：

- `pluginManager.listPlugins()` 返回 **0 条**（同一时刻 loader 组合树有 120 条）；
- 对 profile patch 中插入的 MCP 行调用 `setPluginEnabled('mcp-probe', false)`，返回
  `{ application: 'failed', error: { code: 'unknown-plugin' } }`，**耗时 ≈33s**；
- 与此同时 `ctx.loader.entries()` 能完整列出该 MCP 行（`@deepseek-ai/dsh-mcp-client`），
  且 patch 写入 → loader 行可见 ≈2.5s（HMR 正常）。

## 选项

1. 继续以 `pluginManager` 为主路径，只在失败时回退——实测必然失败，且每次操作阻塞 30s+，UI 体验不可接受。
2. **以 patch 文本编辑 + loader 条目为主路径**，`pluginManager` 仅在「服务存在 && `listPlugins()` 能定位 entryId」时作为可选加速。
3. 等待上游提供可管理任意 loader 行的 API 后再实现启停——首版功能缺失，不满足 D-5。

## 决定

采纳选项 2：

- **列表**：解析当前 profile 的 `cordis.patch.yml`，以 `ctx.loader.entries()` 兜底/交叉校验（受管块 + 字节保真原则在 FR-11/12/13 不变）；`pluginManager` 只补充运行时状态。
- **启停**：主路径是 patch 文本编辑（写/删 `disabled` 覆盖）；`pluginManager.setPluginEnabled` 仅在能定位 entryId 时尝试，**必须带超时**且后台执行、不阻塞键盘；返回 `failed/restart-required/overridden` 时按 FR-10 的 UI 状态映射提示。
- 结论写回需求文档 D-9 与 FR-9/FR-10，并在 `docs/research/05` 记录证据。

## 后果

- 面板需要自建「patch 文本 ↔ MCP 行模型」的解析与编辑层（本就在 M3/M4 计划内），复杂度不变，但不再依赖未兑现的宿主 API。
- 启停的「已生效」判定改为：写后轮询 loader 条目的 `disabled`/fiber 状态，超时提示检查日志。
- 若上游将来支持按 entryId 管理任意 loader 行，可在诊断页保留能力探测，届时把官方 API 提升回主路径（无需改 UI 契约）。

## 2026-11-09 补充：启用语义与写入保护

- 原配置若已 `disabled: true`，启用必须在受管块写 `disabled: false`；仅删除本面板的覆盖无法启用。恢复基线状态时删除本面板覆盖，原配置不变。
- 受管块只编辑目标二字段覆盖行，保留外来行、注释、块外字节与 CRLF。标记损坏、重复目标、目标含外来字段时拒绝写入，不尝试修复用户文件。
- 保存需持有 web 2.3.7 兼容的 `<patch>.panel.lock`（默认等待 5s、陈旧 30s；存活进程的锁不抢占）。锁仅覆盖读取/校验/备份/保存，不覆盖 HMR 等待。
- profile/home 内容快照在获取锁后和最终 rename 前检查；冲突只提供「刷新后重试」，不做强制覆盖。备份失败立即停止。锁不约束普通编辑器，因此最后一次核对到 rename 间仍存在极短竞争窗口。
- 「已生效」只在启用且 fiber `active`，或停用且 fiber 已消失/`disposed` 时报告；`loading` 保持等待、`failed` 明确报错。此状态表示插件激活，不单独保证 MCP 服务器已连接；连接与工具列表用宿主 `/mcp` 核对。
