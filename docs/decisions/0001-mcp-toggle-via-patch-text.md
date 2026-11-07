# ADR-0001：MCP 启停与列表以 patch/loader 为主路径

- 状态：已采纳（2026-11-08）
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
