# dsh-tui-skill-mcp-panel

给 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的技能（skill）与 MCP 服务器可视化管理面板：在终端里输入 `/skill-mcp` 打开全屏管理场景，不用离开 TUI 就能查看、启用/停用、添加、迁移、分组技能与 MCP 服务器；改动尽量热加载，不要求重启 TUI。

> **开发状态（2026-11-08）**：早期开发中（M1 骨架）。当前可构建、可在真实 TUI 中打开 `/skill-mcp` 诊断场景；**技能 / MCP 管理功能尚未实现，npm 尚未发布**。完整范围与里程碑以 [docs/需求文档.md](docs/需求文档.md) 为准。

## 功能（规划中）

| 模块 | 能力 | 状态 |
| --- | --- | --- |
| 技能 | 全局 / 工作区列表、详情、启用/停用（`*.disabled` 约定）、软删除 + 撤销、按本地路径添加（`.md` / 目录束）、迁移、分组、批量操作 | 🚧 |
| MCP | 当前 profile 的 patch 行 + home 全局层（只读）、启用/停用、新增 / 编辑 / 删除（受管块、字节保真、备份 + 撤销） | 🚧 |
| 分组 | 显示层分组与按组批量操作；技能分组与 web 版共享 `groups.json` | 🚧 |
| 诊断 | 发现根、frontmatter 合法性、遮蔽/停用状态、锁 / 备份 / 回收站、宿主能力探测 | 🚧 |
| 入口 | `/skill-mcp` 命令打开全屏场景 | ✅ |

热加载：技能靠磁盘 watcher，MCP 靠 HMR 重组合。保存后面板显示「已保存，热加载中…」，生效后改为「已生效」，不承诺瞬时生效。

## 安装

**尚未发布到 npm。** 发布后：

```sh
dsh plugin --profile dsh-tui add dsh-tui-skill-mcp-panel
```

从源码安装、构建与真机验证流程见 [AGENT.md](AGENT.md) §7。

## 使用

在 dsh-TUI 中输入 `/skill-mcp` 回车打开管理场景，`Esc` / `q` 关闭。当前版本打开的是诊断场景（宿主接缝能力、loader 条目、热加载时间线），用于工程验证；正式管理界面随里程碑落地。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| **MCP 没有「工作区级」** | DSH 内核只有 profile 级 MCP 配置。面板提供「当前 profile（可写）+ home 全局层（跨 profile，只读）」；工作区维度只适用于技能。 |
| 技能只发现一层 | 与 DSH 内核一致：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`，不递归嵌套分类目录。 |
| 热加载有延迟 | MCP 配置写入后需要 HMR 重组合（实测约 2–2.5 秒），面板如实显示状态，不假装瞬时。 |
| 交互为纯键盘自绘 | 场景内不依赖宿主对话框 / toast（实测不可用）；确认与单行输入在场景内完成。 |
| 首版不做 | 技能正文编辑、插件安装/更新、MCP OAuth、单工具禁用、伴随 CLI。 |

## 兼容性

- 目标宿主：`@deepseek-harness-tui/dsh-tui` `>=0.19.0 <0.20.0`
- DSH 内核：`0.2.2-rc.1` 线；Node `>=24.9`
- 与 web 版 [`dsh-skill-mcp-panel`](https://github.com/Fishquito7/dsh-skill-mcp-panel) 共享磁盘约定（`*.disabled`、`groups.json`、补丁锁 `<patch>.panel.lock`，但受管块标记不同名）

## 权限与信任

- 插件 `permissions: []`：不申请额外权限，不安装插件、不执行用户命令、不 `eval` 用户表达式。
- 插件直接读写 `~/.dsh` 下的技能文件与当前 profile 的 `cordis.patch.yml`（同进程信任模型，安装前需信任）；写前备份、原子写、只改自己的受管块，删除走回收站可撤销。
- MCP 的 `env` / `headers` 可能含令牌：面板与日志脱敏，不落明文。

## 开发文档

需求与设计在 [`docs/`](docs/)：需求唯一权威 [docs/需求文档.md](docs/需求文档.md)、调研与真机实测 [docs/research/README.md](docs/research/README.md)、关键决策 [docs/decisions/](docs/decisions/)、仓库工作约定与开发流程 [AGENT.md](AGENT.md)。

## 许可证

[MIT](LICENSE)。
