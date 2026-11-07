# dsh-tui-skill-mcp-panel

> **状态（2026-11-08）：M0 文档与调研完成；M0 真机探针已完成，仓库已可构建出「包骨架 + `/skill-mcp` 全屏场景 + 诊断场景」并安装到独立探针 profile 运行。技能/MCP 管理功能尚未实现，不可发布。**

给 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的技能（skill）与 MCP 服务器可视化管理插件。参考 web 版 [`dsh-skill-mcp-panel`](https://github.com/Fishquito7/dsh-skill-mcp-panel)，在终端里提供一个全屏管理场景：

- `/skill-mcp` 打开管理界面，页签：**技能 / MCP / 分组 / 诊断**；
- **技能**：列全局与工作区，查看详情，启用/停用（`*.disabled` 约定），软删除 + 撤销，按本地路径添加（`.md` / 目录束 / 可选 zip），迁移、分组、批量操作；
- **MCP**：列当前 profile 的 patch 行与 home 全局层，启用/停用（官方 `pluginManager`），新增（写入本插件受管块）、编辑（字节保真）、删除（备份 + 撤销）；
- **热加载**：技能靠文件 watcher，MCP 靠 HMR 重组合；界面如实显示「已保存，热加载中 / 已生效 / 需重启」；
- **安全**：写前备份、原子写、与 web 版共用锁文件与磁盘约定；不使用额外权限（`permissions: []`）。

## 已知边界（首版）

| 边界 | 说明 |
| --- | --- |
| **MCP 无工作区级** | DSH 内核只有 profile 级 MCP 配置；插件提供「当前 profile（可写）+ home 全局层（只读）」，工作区维度只在技能上成立 |
| **技能只发现一层** | 与 DSH 内核一致：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`，不递归嵌套分类目录 |
| 不做 | 技能正文编辑、插件安装/更新、MCP OAuth、单工具禁用、伴随 CLI |
| 目标版本 | dsh-TUI `>=0.19.0 <0.20.0`；DSH `0.2.2-rc.1` 线 |

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [`AGENT.md`](AGENT.md) | 仓库工作约定、版本基线、关键事实、架构与发布纪律（接手开发先读） |
| [`docs/需求文档.md`](docs/需求文档.md) | **需求唯一权威**：目标、FR、NFR、验收标准、里程碑、风险、未决问题 |
| [`docs/research/README.md`](docs/research/README.md) | 初期调研索引与跨文档结论 |
| [`docs/research/01`](docs/research/01-dsh-tui-plugin-architecture.md) | dsh-tui 插件体系与可视化接缝 |
| [`docs/research/02`](docs/research/02-reference-web-plugin-dsh-skill-mcp-panel.md) | web 参考插件拆解与复用清单 |
| [`docs/research/03`](docs/research/03-dsh-skills-and-mcp-mechanisms.md) | DSH 内核技能/MCP 机制、热加载、作用域 |
| [`docs/research/04`](docs/research/04-ecosystem-and-prior-art.md) | 生态、同类、命名、发布通道 |

## 目录结构

```text
dsh-tui-skill-mcp-panel/
├─ AGENT.md
├─ README.md
├─ package.json            # ESM 包；dsh.bundle.patch 指向 cordis.patch.yml
├─ tsconfig.json
├─ cordis.patch.yml        # 把本插件作为一行 insert 挂进 profile
├─ LICENSE
├─ src/
│  ├─ index.ts             # Cordis 插件三面：name / Config / apply
│  ├─ host/                # 场景与命令注册、探针 runtime（临时）
│  ├─ shared/              # 宿主接缝的结构化类型、报告类型
│  └─ ui/                  # 全屏诊断场景（工程骨架，M1 起替换为真实管理界面）
├─ .dsh/skills/            # 探针用项目级技能夹具（git 忽略）
└─ docs/
   ├─ 需求文档.md
   └─ research/
      ├─ README.md
      ├─ 01-dsh-tui-plugin-architecture.md
      ├─ 02-reference-web-plugin-dsh-skill-mcp-panel.md
      ├─ 03-dsh-skills-and-mcp-mechanisms.md
      ├─ 04-ecosystem-and-prior-art.md
      ├─ 05-m0-real-machine-probe.md
      └─ evidence/            # 真机探针原始 JSON 报告
```

`lib/` 为 `tsc` 构建产物（git 忽略，npm 发布时通过 `files` 携带）。M1 起新增 `src/domain/`（纯逻辑、可单测）并在 M5 补 `dsh-plugin.json`。

## 本地开发与安装（已验证流程）

```sh
pnpm install
pnpm build
# 建议使用独立 profile 做真机验证（不要直接覆盖日常 profile）：
#   cp -a ~/.dsh/profiles/dsh-tui ~/.dsh/profiles/dsh-tui-probe
dsh plugin --profile dsh-tui-probe add /home/wqwt/code/dsh-tui-skill-mcp-panel
dsh --profile dsh-tui-probe      # 在 TUI 内输入 /skill-mcp
```

npm 公开发布尚未进行（`dsh plugin --profile dsh-tui add dsh-tui-skill-mcp-panel` 暂不可用）。

## 当前能力与限制（摘自真机实测）

- 已有：`/skill-mcp` 命令、全屏场景、宿主接缝能力探测、诊断报告（JSON）。
- 实测限制：场景内 `tuiDialogs` / `tuiToast` **不可用**（确认/输入必须自绘）；`pluginManager.listPlugins()` 为空、`setPluginEnabled` 对 patch 行返回 `unknown-plugin` → MCP 启停以 patch 文本编辑为主路径；patch 写入→热加载 ≈2.0–2.5s。
- 详见 [`docs/research/05-m0-real-machine-probe.md`](docs/research/05-m0-real-machine-probe.md)。

## 许可证

MIT（与 dsh-TUI 主包、生态模板、web 参考版一致；编码阶段落地 `LICENSE` 文件）。
