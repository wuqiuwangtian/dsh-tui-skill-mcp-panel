# 07 · M2 技能写操作与分组（2026-11-08）

> 范围：M2 的 P0 部分——技能启停（`*.disabled`）、软删除 + 回收站撤销、添加/导入、分组（共享 `groups.json` v1）、批量操作。迁移/复制与 zip 导入为 P1，未实现。
> 关联：[`06-m1-skill-scan-verification.md`](06-m1-skill-scan-verification.md)、[`../需求文档.md`](../需求文档.md) FR-4~FR-8、FR-15、AC-1~AC-5、AC-13。

## 1. 实现位置

| 能力 | 模块 |
| --- | --- |
| 启停 / 软删除 / 撤销 / 清理 / 添加导入 | [`src/domain/skills/write.ts`](../../src/domain/skills/write.ts) |
| 分组（共享文件、损坏回退、原子写、upsert/成员） | [`src/domain/groups.ts`](../../src/domain/groups.ts) |
| 插件私有路径与配置（trash/backups/config、`$SKILL_MCP_PANEL_HOME` 测试覆盖） | [`src/domain/store.ts`](../../src/domain/store.ts) |
| 运行时编排（批量、状态消息、busy、刷新、分组持久化） | [`src/host/manager-runtime.ts`](../../src/host/manager-runtime.ts) |
| UI（空格启停、d 删除确认、u 撤销、v 标记、a 添加向导、g 分组、分组页、过滤） | [`src/ui/ManagerScene.tsx`](../../src/ui/ManagerScene.tsx) |

## 2. 关键不变量

- **启停**：只操作选中实例；目录束 `SKILL.md ↔ SKILL.md.disabled`，平铺 `<name>.md ↔ <name>.md.disabled`；目标已存在则拒绝；写前重读 frontmatter 并校验 `name` 未变（外部修改 → 提示刷新，不猜写）；bundled 根拒绝；无效 frontmatter 拒绝。
- **软删除**：实体移动到 `~/.dsh-tui/skill-mcp-panel/trash/<ISO 批次>/<global|workspace>/<技能名>[-n]/`，批次写 `manifest.json`（name/source/scope/rootPath/原路径/trash 路径）；**不删除技能根目录本身**；bundled 拒绝；单条失败不影响其余（逐条报告）。
- **撤销**：默认恢复最近批次；恢复前检查原位置是否被占用（冲突仅报告、不覆盖，条目留在回收站）；成功后删除批次与空目录。
- **清理**：默认保留 7 天或最近 100 批（先到者），写操作前触发。
- **添加/导入**：只接受**绝对路径**的 `.md` 或含顶层 `SKILL.md` 的目录；frontmatter 必须合法；目标作用域内同名（按内核 name）拒绝；目录上限 200 文件 / 8 MiB、`SKILL.md` ≤1 MiB；拒绝符号链接；复制到临时路径后 `rename`，失败清理临时文件；默认复制不改源。
- **分组**：与 web 版共用 `$DSH_HOME/skills/.system/skill-viewer/groups.json`（`version: 1`，成员按 `(scope, name)`，全局 scope key 为 `global`，工作区为 project root 路径）；文件损坏 → 备份 `.corrupt-<ts>` + 空配置 + 警告；写入用临时文件 + rename；分组名非空且忽略大小写唯一；删除分组不影响技能。
- **批量**：`v` 标记多个技能后，空格/`d` 对全部标记项逐条执行并汇总结果；标记在批量动作后清空。
- **外部变更**：所有写操作前重新读盘校验，不静默覆盖；失败通过场景内状态行/诊断页可见（不用 console）。

## 3. 验证证据（本次）

- **域层单测**：`pnpm test` → **22 pass / 0 fail**：
  - `frontmatter.test.js`（6）：内核同规则解析/校验；
  - `discovery.test.js`（3）：扫盘/遮蔽/缺失根；
  - `write.test.js`（8）：启停双向、目标冲突、bundled 拒绝、删除+清单、撤销、撤销冲突、批量部分失败、清理策略、添加 .md/目录束、frontmatter 非法/重名/相对路径/超大文件；
  - `groups.test.js`（5）：v1 读写往返、重名/空名/重命名、成员（scope,name）增删、损坏备份回退、非法结构丢弃。
- **运行时集成**（本机临时目录脚本，非仓库测试）：`ManagerRuntime.refresh → toggleSkills → deleteSkillInstances → undoLastDelete → createGroup` 全链路通过；产生了 `groups.json`（version 1、scope key 为 projectRoot、成员 alpha）与回收站批次，撤销后文件回位。
- **UI 渲染**：`pnpm test:ui` 通过（160/58 列屏幕还原，含 M2 页脚与卡片）。
- **UI 交互（headless，真实 runtime）**：`pnpm test:ui:interaction` 通过——用真实 `ManagerRuntime` + 临时技能树渲染场景，通过 stdin 驱动按键并断言文件系统/共享 groups.json：
  1. 空格启停（`SKILL.md` ↔ `.disabled`）；
  2. `v` + 空格批量启停；
  3. `d` 打开确认模态 → `y` 移入回收站 → `u` 恢复；
  4. `a` 输入绝对路径 → 选择作用域 → 文件复制导入；
  5. `g` → 新建分组 → `groups.json` 写入（与 web 版同结构）；
  6. `Tab` 进分组页 → `a` 新建第二个分组。
  → 说明 **UI 的写操作 wiring 与模态键盘流程可用**；仍缺真实 TTY 下的观感与鼠标点击模态验收。

## 3.1 真机反馈后的修复（2026-11-08）

用户在真实 TUI 验证 M2 后报告并已修复：

1. **分组页无法用 ↑ 回到页签栏**：分组页现在 `↑` 到第一个分组再按会切到页签栏，`←/→` 切页签、`↓` 回列表；交互 smoke 加了回归断言。
2. **模态框 Esc 无法取消**：根因是宿主把裸 Esc 解析为 `escape: true` **且 `meta: true`**，而快捷键守卫先 `if (key.meta) return` 吞掉了它。守卫改为 `if ((key.ctrl || key.meta) && !key.escape) return` 后，确认/输入/选择模态均可 Esc 取消（smoke 断言）。
3. **分组页 `r` 重命名不可用**：全局 `r`（刷新）抢先拦截；改为按页签分派——分组页 `r` 重命名、技能/诊断页 `r` 刷新、`R` 全局刷新。
4. **鼠标与键盘范围不一致**：新增底部**动作条**（启停/标记/删除/撤销/添加/分组/搜索/刷新/帮助；分组页为新建/重命名/删除/过滤/清除/帮助）与**模态按钮**（确认 y/n、输入提交/取消），全部可点击；鼠标与键盘操作范围一致（文字输入仍用键盘）。
5. **页签内容区 ←/→ 行为不一致**：MCP/诊断可直接切页签，分组/技能不能。统一规则为「←/→ 先移动空间焦点；没有左右相邻区域时切页签」：分组页与 MCP/诊断一致（内容区直接切页签），技能页因有作用域/详情两个水平区域而移动焦点（页签栏上仍切换页签）。交互 smoke 增加回归断言。

## 4. 待真机验收（未验证，勿写成已通过）

1. **启停**：空格切换 → 列表状态变化、`/skills` 菜单与模型侧在下一步前同步（AC-10）；bundled 只读拒绝。
2. **软删除/撤销**：`d` → `y` 确认 → 回收站目录/清单正确；`u` 恢复后文件内容一致（AC-13）。
3. **添加/导入**：`a` → 绝对路径 → 选择作用域 → 出现新行；重名/非法 frontmatter/超大文件报错可见。
4. **分组**：`g` 加入/移出；分组页 `a/r/d`、Enter 过滤 + `x` 清除；与 web 面板同时读写 groups.json 的兼容性（AC-15 部分）。
5. **批量**：`v` 标记多个后空格/删除，逐条结果与部分失败提示。
6. **UI 细节**：模态框（确认/输入/选择）在真实 TUI 的键盘与鼠标点击（模态选项点击）是否顺手；宽窄屏。

## 5. 后续（M2 剩余 / M3）

- P1：迁移/复制（FR-7）、zip 导入（FR-6）、分组批量动作（FR-8/FR-15 的组内批量）。
- M3：MCP 只读 + 启停（patch/loader 主路径，ADR-0001）；MCP 分组写入本插件配置（`config.json`）。
- M1 遗留：AC-10 的 TUI `/skills` 与模型侧同步走查、bundled 根核对。
