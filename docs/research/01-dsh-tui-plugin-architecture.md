# 01 · dsh-tui 插件体系与可视化 UI 接缝调研

> 调研员：tui-arch ｜ 日期：2026-11-07 ｜ 目标基线：**dsh-tui 0.19.0（已安装）**
> 服务对象：为 dsh-tui 开发「技能（skill）+ MCP 可视化管理」插件（参考 web 插件 `dsh-skill-mcp-panel`）。
> 本文只做调研与结论，不写产品代码；只修改本文件。

## 0. 阅读约定

### 0.1 路径缩写

| 缩写 | 绝对路径 |
| --- | --- |
| `TUI19/` | `/home/wqwt/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/`（已安装 **0.19.0**，目标基线） |
| `TUI17/` | `/home/wqwt/code/dsh-TUI/`（本地源码仓库，`package.json` 声明 **0.17.0**；用于读实现细节） |
| `DSH/` | `/home/wqwt/.local/node/lib/node_modules/@deepseek-ai/dsh/`（内核 **0.2.2-rc.1**） |
| `PROFILE/` | `/home/wqwt/.dsh/profiles/dsh-tui/`（dsh-tui profile 目录） |
| `WEBPANEL/` | `/home/wqwt/.dsh/profiles/web/node_modules/dsh-skill-mcp-panel/`（参考 web 插件 **2.3.7**） |

### 0.2 可信度标记

- **【已验证】**：直接读自 `TUI19/`、`PROFILE/` 或 `DSH/` 的代码/类型/清单。
- **【已验证·0.17】**：读自 `TUI17/` 源码并已与 `TUI19/` 类型面对照；实现细节可用，版本号写 0.17。
- **【推断】**：由已读代码/文档合理推导，未逐行验证或未实机运行。
- **【未验证】**：无法从可读文件确认，明确留待实测。

### 0.3 姊妹文档

同目录另外三份调研由其他成员撰写，本文避免重复展开，交叉引用如下：

- `02-reference-web-plugin-dsh-skill-mcp-panel.md`：web 参考插件逐模块拆解（技能扫描、patch 字节编辑、MCP 表单/原文双通道、OAuth、分组）。**MCP 的 YAML 字节编辑细节以 02 为准。**
- `03-dsh-skills-and-mcp-mechanisms.md`：DSH 内核技能/MCP 机制（发现根、rank、`ctx.skills` API、`disabled` 语义、`ctx.tools.restrict`、热加载矩阵）。**数据层机制细节以 03 为准。**
- `04-ecosystem-and-prior-art.md`：生态、准入清单、命名/发布通道、同类先例。**发布与生态以 04 为准。**

---

## 1. 结论摘要（先看这里）

### 1.1 推荐接缝组合（面向本项目的管理界面）

**主界面 = `tuiScenes` 全屏场景；入口 = `commands`（+ 可选 `tuiShortcuts`）；表单 = 场景内自绘（键盘）；确认/提示 = 场景外 `tuiDialogs` + 场景内二次确认；反馈 = `tuiToast`；可选增强 = `tuiPanels`（实验性，quick view）+ `tuiSettingsSections`（插件自身偏好）。**

| 需求 | 首选接缝 | 理由（详见 §4） |
| --- | --- | --- |
| 列表 + 详情 + 表单 + 分组（多栏管理界面） | **`tuiScenes`**（`ctx.tuiScenes`） | 全屏、独占键盘、宽度自适应、有错误边界兜底；是 `/trace`、`/settings` 同款形态 |
| 打开入口 | `commands`（注册 `/skill-mcp` 之类的命令） | 命令归 `dsh-commands`，有 `command/run`/`command/done` 日志；场景 id 由命令 `open()` |
| 快捷键直达（可选） | `tuiShortcuts` | 必须带 ctrl/alt；保留位不能注册；只在纯对话态派发 |
| 添加/删除/重命名等单值输入与确认 | `tuiDialogs`（**场景外**）或场景内自绘 | 托管对话框不能覆盖全屏场景（见 §5.4）；场景内建议自绘输入行 |
| 操作反馈 | `tuiToast`（实验性） | 插件侧唯一 toast 出口；标量文本、≤200 cell、20 条/分 |
| 侧栏快速视图（可选，v1.1） | `tuiPanels`（实验性） | 只有 fullscreen 分栏布局下存在；宽度窄、无文本输入、不可选择复制 |
| 插件自身显示偏好（可选） | `tuiSettingsSections` | 声明式字段（text/number/boolean/select），**不能**表达动态列表 |
| 状态提示（可选） | `tuiStatus.set/setField` | 纯展示；适合「12 个技能 / 3 个 MCP」的小字摘要 |
| **不建议**：`tuiRenderers` | 仅纯文本 transcript 行 | 与「管理界面」形态不匹配；回放路径限制多 |

### 1.2 三个最重要的结论/风险

1. **技能列表不能从 host 层 `ctx.skills.list()` 拿。** dsh-tui 0.19 把 host 级 `skill-filesystem` 行设为 `disabled: true`（`TUI19/cordis.patch.yml:87-88`），技能发现由 agent preset（`standard`）在 **preset 作用域**挂载（`DSH/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:40-41`；TUI 通过 `registerBundledPresets()` 把这些上游 preset 注册进 roster：`TUI19/lib/types/dsh-adapter/bundled-presets.js:81-106`）。`ctx.skills` 的读取是 `[global, ...scopeChain(scope)]`（`DSH/node_modules/@deepseek-ai/dsh-skill/lib/types/index.d.ts` 的 `SkillRegistry` 注释；TUI 自己消费时也显式带 scope：`TUI19/lib/types/dsh-adapter/channel/skill-catalog.js:25-26`）。**结论：管理面板的「列表」应按内核同样规则直接扫盘（与管理动作天然一致），而不是依赖注册表；详见 §6.1。**
2. **「热加载」在 DSH 里是既有机制的净收益，但要分清三条路径：** 技能 = 改磁盘 + provider watcher 失效（`watch: true` 默认，`DSH/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:36,96,160-198`）；启停技能 = 文件改名 `*.disabled`（内核没有「停用」API，`03` §1.5 已证）；MCP = 改 profile/home `cordis.patch.yml`，由 HMR profile/home patch watch 触发热组合（`DSH/node_modules/@deepseek-ai/dsh-hmr/README.md`「Profile and home patch changes also trigger recomposition」），或对既有行用 `ctx.pluginManager.setPluginEnabled()`（内核实现 `DSH/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:2669-2681`）。
3. **最大架构性限制是 MCP 没有「工作区」维度，且 MCP 行只能落在 patch 里。** 一个 MCP server = profile 组合中的一条 `@deepseek-ai/dsh-mcp-client` 行（`DSH/node_modules/@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts:1-16`），DSH 0.2.x 没有 per-workspace MCP 配置面（`03` §3.3 同结论）。「新增/删除 MCP 行」**没有官方 API**，必须自己做 `cordis.patch.yml` 的字节保真编辑（web 参考插件即如此，见 `02` §4.3），并处理 `!!js` 表达式、并发写锁、HMR 生效等待。**这是本项目最大的实现复杂度与风险来源。**

### 1.3 首版范围建议（结论）

- **形态**：单包 Cordis 插件（`cordis.patch.yml` 一行 insert），**不依赖** `dsh-plugin.json` 即可安装/运行；生态准入需要的 manifest 可后补（§8）。
- **技能**：列表/详情/启停/删除/添加（`.md` 文件与目录束）/分组（插件私有显示配置）。全部基于文件系统真源，与 web 面板使用**同一套**目录与 `*.disabled` 约定，保证两边看到同一实体。
- **MCP**：列/详情/启停/编辑（表单或原文）/删除；新增写 profile patch 的受管块；**「全局/工作区」在 MCP 上只承诺「home 层（跨 profile）vs 当前 profile」**，不做 per-workspace（做不到且无内核支持）；工作区维度只在技能上承诺。
- **热加载**：技能靠 watcher；MCP 靠 HMR 的 profile/home patch watch + `pluginManager` 生命周期；界面内不要求用户重启。
- **不需要任何 grant**（不订阅决策事件、不用 `tuiPluginStorage`），权限面最小；插件私有数据写 `~/.dsh-tui/` 或与 web 面板共用的 `~/.dsh/skills/.system/skill-viewer/groups.json`（§6.4）。

---

## 2. 版本基线与环境事实

### 2.1 已安装包（目标基线）【已验证】

- 包名/版本：`@deepseek-harness-tui/dsh-tui@0.19.0`（`TUI19/package.json`）。
- 纯 ESM，`main: lib/types/index.js`，`types: lib/types/index.d.ts`，`dsh.bundle.patch: ./cordis.patch.yml`。
- 对外 `exports` 子路径（插件作者可用的公开入口）：
  `.`、`./working-activity`、`./oauth`、`./workspaces`、`./command-trees`、`./preset-patch`、`./settings-sections`、`./scenes`、`./panels`、`./extensions`、`./plugin-host`、`./api`、`./jsx-runtime`、`./invariant`、`./cordis.patch.yml`、`./settings.json`、`./package.json`、`./icon`、locale 两条。
  **注意：没有 `./ui`。** 场景/面板拿到的 UI kit 只能通过 props 注入（`TuiSceneProps.ui` / `TuiPanelProps.ui`），不能自己 import 宿主组件树。
- 关键 peer：`@deepseek-ai/cordis@^4.0.1 || 4.0.5-alpha.2`，以及一长串 `@deepseek-ai/dsh-*`（作为宿主依赖；第三方插件**不必**逐条声明，见 §3.1 的依赖策略）。
- 包内自带 `tui-profile/`（feed/protocols/registry/schemas）与 `guide/dsh-tui-guide/`（0.19 版用户/插件文档）。

### 2.2 profile 与内核【已验证】

- `PROFILE/package.json`：`dsh.profile.bundles` = `@deepseek-ai/dsh-base`、`@deepseek-harness-tui/dsh-tui`、`ds-harness-remote`、若干 experimental bundle；**`dsh.profile.patchReload: "live"`**。这是「装/改完不重启生效」的前提（`TUI19/lib/types/dsh-adapter/plugin-guard.js:8-12` 的注释也印证「本 profile 跑 `patchReload: live`」）。
- 内核 `dsh@0.2.2-rc.1`（`DSH/package.json`）。DSH 的插件发现/安装/加载由 `@deepseek-ai/dsh` 的 Loader 负责，dsh-TUI 只提供 UI 与校验/诊断面（`TUI17/tui-profile/docs/plugin-admission-and-development.md:142-145`）。

### 2.3 0.17 源码 vs 0.19 已安装包：差异结论【已验证·0.17 + 已验证】

逐项对照后的结论：**本次比对未发现 0.19 相对 0.17 在公开接缝面（exports/类型签名/预算常量）上有新增或破坏性变化；差异主要落在文档覆盖度与内置功能实现细节。** 因此：**类型面以 `TUI19` 的 d.ts 为基线**；`TUI17` 用于读实现逻辑（React 契约、边界、错误隔离等），读到 0.17 独有行为时再用 0.19 的 `.js` 复核。

| 对照项 | 0.17 源码（`TUI17/src/`） | 0.19 已安装（`TUI19/lib/types/`） | 结论 |
| --- | --- | --- | --- |
| `exports` 子路径清单 | `package.json.exports` 19 项 | 同 19 项 | **一致** |
| `panels` 接缝 | `src/dsh-adapter/panels.ts` 已存在（`apiVersion=1`、每插件 ≤4、全局 ≤32、`open()` 5s 限速） | `lib/types/dsh-adapter/panels.d.ts` 同常量同类型 | **一致**（0.17 的《准入与开发指南》只是没把它写进「接缝总览」） |
| `scenes` 接缝 | `src/dsh-adapter/scenes.ts` | `lib/types/dsh-adapter/scenes.d.ts` | **一致** |
| `extensions`（dialogs/status/shortcuts/renderers/toast/themes） | `src/dsh-adapter/extensions.ts` | `lib/types/dsh-adapter/extensions.d.ts` | **一致**（含 `TuiToastRuntime`） |
| `settings-sections` 字段种类 | text/number/boolean/select + secret + page | 同 | **一致** |
| 文档 | 《指南》接缝总览只到「十四 后端」，无 panels 章节；`docs/plugins.md:34-36,48-70` 以「实验性 §18」描述 panels | 包内 `guide/dsh-tui-guide/plugins.md:35,52-59` 同文本 | **0.17 指南不能当 panels 的权威文档**，以 `TUI19` 的 d.ts + `docs/plugins.md` 为准 |
| 应用内置功能 | 已有 `/skills` 列表与 `SkillsPicker`（`TUI17/src/commands.ts:114-116`、`TUI17/src/components/SkillsPicker.tsx`）、`/mcp` 后端控制面（`TUI17/src/dsh-adapter/channel/core/compose.ts:631,1031`）、`/panel`、`/plugin` | 同名命令同样存在（`TUI19/lib/types/commands.js:35-108`、`lib/types/screens/Chat.js:3152-3177,3907-3922`） | 内置入口两版基本一致；**不要假设 0.19 新增了这些命令**。0.19 为基线，行为细节以 0.19 的 `.js` 为准 |

> 结论：**以 `TUI19` 的 d.ts 为类型基线**；`TUI17` 仅用于读实现逻辑（React 契约、边界、错误隔离等），读到 0.17 独有行为时以 0.19 的 `.js` 复核。

---

## 3. 插件形态、安装与热更新

### 3.1 Cordis 插件三面 + 包骨架【已验证】

运行时插件就是一个 Cordis 插件，固定三个面（`TUI17/tui-profile/docs/plugin-admission-and-development.md:40-74`）：

```ts
export const name = 'my-plugin'                 // Cordis 行 id 用的名字
export type Config = { … }
export const Config: Schemastery<Config> = Schema.object({ … })
export function apply(ctx: Context, config: Config): void { … }
```

硬性纪律（同上文档 `:51-55`）：无默认导出；所有配置键有默认值；清理走 `ctx.effect(() => () => …)`；可选接缝用 `ctx.get('service', false)` 探测、缺席静默降级。

最小 `package.json`（照抄即可用）：

```jsonc
{
  "name": "dsh-tui-skill-mcp-panel",
  "type": "module",
  "main": "lib/types/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/types/index.js" } },
  "files": ["lib", "cordis.patch.yml", "dsh-plugin.json"],
  "engines": { "node": "^22.19 || >=24" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

依赖策略【推断，建议】：插件**只依赖** `@deepseek-ai/cordis`（peer）与 `@deepseek-harness-tui/dsh-tui`（peer，仅为类型/JSX runtime），再加少量纯 JS 运行时依赖（`yaml` 必装；`fflate`（zip 导入）/`get-east-asian-width`（终端宽度）按需）。**不要**把 `@deepseek-ai/dsh-*` 写进 dependencies：宿主服务（`loader`/`pluginManager`/`configEditor`/`settings`/`skills`）用结构化最小接口 + `ctx.get(name, false)` 软探测，避免 peer 版本地狱（`@deepseek-ai/dsh` 的版本线极长，见 `TUI19/package.json` 的 peer 列表）。

### 3.2 `cordis.patch.yml`：插件怎么被组合进 profile【已验证】

```yaml
# cordis.patch.yml
- insert:
    - id: skill-mcp-panel
      name: 'dsh-tui-skill-mcp-panel'
```

- 包声明 `dsh.bundle.patch` 后，`dsh plugin add` / `/plugin install` 会把包名写进 profile 清单的 `dsh.profile.bundles`（`TUI17/tui-profile/docs/plugin-admission-and-development.md:1373-1381`；`DSH/node_modules/@deepseek-ai/dsh-app-boot/lib/types/profile-plugins.d.ts`「New bundle dependencies activate automatically」）。
- 覆盖行（`- id: …` 无 `insert`）会**整块替换**目标行的 `config`——要复述该行所有键（`TUI17/tui-profile/docs/plugin-admission-and-development.md:791-801`）。
- pnpm 隔离布局的已知坑：profile 根不会链入传递依赖；若你的包要被别的 bundle 组合，需提供显式子路径导出（同上 `:798-801`）。
- 行顺序重要：依赖的服务行要先于使用它的行（本插件只用到 `tuiScenes`/`tuiDialogs` 等，均在 `dsh-tui` bundle patch 里由 `dsh-tui` 自身保证顺序，见 `TUI19/cordis.patch.yml` 中 `dsh-tui-scenes`、`dsh-tui-extensions`、`dsh-tui-panels`、`dsh-tui-plugin-host` 等 insert 行）。

### 3.3 `dsh-plugin.json`（manifest）：何时必须、首版要不要【已验证】

- 生态准入（进目录/市场/被推荐）要求包根唯一 `dsh-plugin.json`，过固定 revision 的 `@dsh-std/manifest` parser（`TUI17/tui-profile/docs/plugin-admission-and-development.md:285-305`；schema 见 `TUI17/vendor/dsh-std/packages/manifest/schema/dsh-plugin-0.15.schema.json`）。
- schema `required`：`$schema`、`manifestVersion`、`id`、`name`、`version`、`facets`、`requires`、`permissions`、`contributes`、`subscriptions`；`facets.host` 必填 `entry` + `apiVersion`；`requires.contracts` 必须数组；`contributes.commands` 必填（可为 `[]`）、`contributes.panels` 在 v0.15 必须为空数组（`maxItems: 0`）；`contributes` 允许 `x-` 前缀扩展数组；**不写** `provides` / `requires.services`（`maxItems: 0`）。
- **首版结论**：仅自己安装/使用，**不需要** manifest；只有要进生态目录/市场时才必须补（`TUI17/tui-profile/docs/plugin-admission-and-development.md:1444-1479` 的迁移清单说明了「只有 patch 的包能装、能组合，但没有声明面」）。

### 3.4 安装路径【已验证】

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| TUI 内 | `/plugin install <spec>` | 走宿主 `ctx.pluginManager`；有信任披露面板、可取消、构建脚本批准、版本豁免（`TUI17/docs/plugins.md:84-94`） |
| CLI | `dsh plugin --profile dsh-tui add <spec>` | `dsh plugin` 是 pnpm 的薄封装（实测 `dsh plugin --help` 输出：「forwarding the remaining arguments to pnpm in the profile directory」）；装完 package 操作后 profile 清单自动协调（`DSH/.../dsh-app-boot/lib/types/profile-plugins.d.ts`） |
| spec 形态 | npm 名 / 绝对路径 / tarball URL / git URL | `DSH/.../dsh-plugin-manager/lib/types/install-spec.d.ts:8-24`；路径必须是绝对路径 |

### 3.5 生命周期：启用/停用/卸载与 HMR【已验证】

- **bundle 与行是两级语义**（`TUI17/docs/plugins.md:95-110`）：bundle 是组合层（写 `dsh.profile.bundles`），行是 patch 的 `disabled`；`/plugin enable|disable <名称|id>` 解析顺序 bundle 名 → `entryId` → `patchId` → 模块名。
- 宿主 API（第三方插件理论上可直接用，但**并非文档化给插件的接缝**，标记【推断】）：
  - `ctx.pluginManager.listPlugins(): PluginInfo[]`（`entryId`、`moduleName`、`patchId`、`enabled`、`fiberPhase`、`diagnostic`）——`DSH/.../dsh-plugin-manager/lib/types/index.d.ts:122`；字段见 `DSH/.../dsh-host-plugin-inventory/lib/types/types.d.ts:8-19`。
  - `ctx.pluginManager.setPluginEnabled(entryId, enabled): ChangeResult`——实现见 `DSH/.../dsh-plugin-manager/lib/index.js:2669-2681`：按 `patchId` 写 `disabled` 覆盖行并 `reload()`；这正是「启停一条 MCP 行」应走的官方路径。
  - `installBundle/removeBundle/setBundleEnabled/updateBundle`——同文件 `:122-226`。
  - `ChangeResult.application` 取值：`applied` / `restart-required` / `overridden` / `failed` / `cancelled`（`DSH/.../dsh-plugin-manager/lib/types/types.d.ts:148-153`）。
- **HMR 语义**（`DSH/node_modules/@deepseek-ai/dsh-hmr/README.md`）：
  - 「Profile and home patch changes also trigger recomposition」——**改 profile patch 或 home patch 都会热组合**（`patchReload: live` 时立即生效）。
  - 「Direct Plugin Manager operations apply without waiting for file events」——`/plugin`、`pluginManager.*` 的操作不依赖文件事件。
  - 「Profile recompositions run by HMR's profile watches and by Plugin Manager also replace plugins whose loaded files below the profile directory changed on disk」——**插件自身代码/产物变化也会被热替换**（已加载模块被驱逐后重新 import）。
  - 文件 watch 有 Chokidar 的 `awaitWriteFinish`（默认 2s 写稳定窗口）与 100ms debounce；因此「写完 patch 立刻断言已生效」不可靠，需轮询/等待（web 参考插件的 `waitForLoaderState` 是现成做法，`WEBPANEL/lib/mcp/status.js:24-53`）。
  - inline 与 fullscreen 两种布局下 HMR 行为一致；HMR 失败时旧插件停止并标 `failed`（README 同段）。
- **停用自己会杀自己**：TUI 侧有硬门禁，不能 `/plugin disable` 提供本应用的 bundle / 本应用自己的行；第三方插件不要试图自停（`TUI17/docs/plugins.md:99-105`）。
- **卸载不删用户数据**：`remove` 只移除包与行，`~/.dsh-tui/backends/<id>/`、grants、storage 命名空间保留并只报告一次（`TUI17/tui-profile/docs/plugin-admission-and-development.md:344-358`）。本插件若在 `~/.dsh-tui/` 或 `~/.dsh/skills/.system/` 下写私有配置，卸载后同样保留，文档要写明。

### 3.6 插件私有数据与授权（grants）【已验证】

- 统一授权文件 `~/.dsh-tui/extension-grants.json`；8 个注册权限里 **7 个默认拒绝**，只有 `commands.invoke` 默认允许（`TUI17/tui-profile/registry/permissions-0.1.json`；指南 `:151-175`）。
- `ctx.tuiPluginStorage`（`storage.local`）默认**拒绝**：`get` 需 `storage.local.read`、`set/delete` 需 `storage.local.write`；配额 256 键 / 256 KiB；数据在 `~/.dsh-tui/plugin-storage/<namespace>.json`（`TUI19/lib/types/dsh-adapter/plugin-storage.d.ts` 头注释）。
- **本项目不需要任何 grant**：不订阅决策事件、不使用 `tuiPluginStorage`。分组等显示配置写自己的 JSON 文件（§6.4），避免让用户先去改授权文件。

---

## 4. 可视化接缝逐个摸清

### 4.0 接缝总览与稳定性分级【已验证/已验证·0.17】

0.19 的接缝服务（`TUI19/cordis.patch.yml` 的 insert 行）：`tuiWorkspaces`、`tuiCommandTrees`、`tuiSettingsSections`、`tuiScenes`、`tuiPanels`、`tuiPluginHost`、`tuiExtensions`（内含 `tuiDialogs`、`tuiStatus`、`tuiShortcuts`、`tuiRenderers`、`tuiToast`、`tuiThemes`）。

稳定性分级（`TUI17/docs/plugins.md:32-36`，0.19 包内 `guide/dsh-tui-guide/plugins.md` 同文）：

| 分级 | 接缝 |
| --- | --- |
| 稳定候选（形态冻结） | 设置区块、全屏场景、托管对话框、状态行（+`setField`）、快捷键、条目渲染器 |
| 实验性 | 决策事件、toast（`ctx.tuiToast`）、**侧栏 Panel（`ctx.tuiPanels`）** |
| 跟随上游 | 会话事件、prompt 槽位、技能打包、主题、system prompt 段、profile 组合 |

统一纪律（`TUI17/tui-profile/docs/plugin-admission-and-development.md:596-610`）：本地优先（插件遮蔽不了内建）；渲染路径字符串按不可信输入处理（剥控制字符、按 terminal cell 截断、只收标量）；插件崩溃不拖垮 TUI（handler 抛错被捕获；决策等待 >400ms 有驻留提示）。

### 4.1 `tuiScenes`：全屏场景（★主界面首选）

- 类型入口：`@deepseek-harness-tui/dsh-tui/scenes`（`TUI19/lib/types/scenes.d.ts` / `dsh-adapter/scenes.d.ts`）。
- 服务形态：`ctx.tuiScenes.register(descriptor, identity?)` → disposer；`open(id)` → boolean；`close()`；`subscribe(listener)`；`get active`。**`open()` 要求调用者是活着的插件 activation**（`scenes.js` 的 `requirePluginCaller` + `activationFiber`，`TUI19/lib/types/dsh-adapter/scenes.js:124-129`），所以务必在 `ctx.inject(['tuiScenes'], …)` 的 child ctx 上调用，不要把 service 实例存起来跨 activation 用。
- 最小接入三步（`TUI17/tui-profile/docs/plugin-admission-and-development.md:824-896`）：

```ts
// 1) 注册场景
ctx.inject(['tuiScenes'], (sceneCtx) => {
  const dispose = sceneCtx.tuiScenes.register({
    id: 'skill-mcp-panel',            // 全局唯一 kebab-case；重复/非法注册即抛错
    title: 'Skill / MCP',
    component: SkillMcpScene,          // props: { React, ui, channel, close }
  })
  ctx.effect(() => () => dispose())    // dispose 会自动关掉当前打开的场景
})

// 2) 自己的命令打开它
ctx.inject(['commands'], (commandCtx) => {
  const dispose = commandCtx.commands.register({
    name: 'skill-mcp',
    description: 'Open the Skill & MCP manager',
    handler: () => sceneCtx.tuiScenes.open('skill-mcp-panel')
      ? { kind: 'success' as const }
      : { kind: 'error' as const, text: 'scene not registered' },
  })
  ctx.effect(() => () => dispose())
})

// 3) 组件：Hook 必须用 props 注入的 React；JSX 走宿主 jsx-runtime
export function SkillMcpScene({ React, ui, close }: TuiSceneProps) {
  const { Box, Text, useInput, useTerminalSize, ScrollBox } = ui
  const { columns, rows } = useTerminalSize()
  useInput((input, key) => { if (key.escape || input === 'q') close() })
  return <Box flexDirection="column" width="100%">…</Box>
}
```

- 必读的 React 契约（违反即首渲染崩溃，`TUI17/tui-profile/docs/plugin-admission-and-development.md:898-910` + `TUI19/lib/types/dsh-adapter/scenes.d.ts:1-30`）：
  - reconciler 是 **React 19**；hook 必须用 props 注入的 `React`；
  - JSX 必须编译到宿主的 `jsxImportSource: "@deepseek-harness-tui/dsh-tui"`（其 `./jsx-runtime` 原样 re-export 宿主 `react/jsx-runtime`）；或干脆 `React.createElement`。
- 运行时语义（`TUI17/tui-profile/docs/plugin-admission-and-development.md:912-942`）：
  - 场景位于 Chat **early-return 链最顶端**（`TUI19/lib/types/screens/Chat.js:6110-6118`：`channel.pluginScene` 存在就直接 return 场景节点），打开期间独占整个终端与键盘，`/settings`、`/resume`、轨迹屏在下面挂起；
  - inline 模式自动包 `<AlternateScreen>`，fullscreen 模式复用宿主 alt screen（组件**不要**再包一层，`Chat.js:6117`）；
  - 打开/关闭不产生任何 session 事件；
  - dispose 当前打开的场景会关屏；场景组件卸载后重开是全新挂载（hook 状态不保留）；
  - **渲染期异常由 `PluginSceneBoundary` 接住**：转录里报一条错误、场景自动关闭（`TUI19/lib/types/components/PluginSceneBoundary.js:1-30`）；**effect/异步回调里的异常 boundary 管不到**，是插件自己的责任。
- 能力/限制：拿到 `React`、整个 `ui` kit、`channel`（会话响应式视图）、`close`；尺寸用 `useTerminalSize()` 自适应，不假设固定行列；调试只能走 `DSH_TUI_DEBUG` 的 stderr，禁止往 stdout 写。
- **本项目关键限制：场景没有 Markdown 组件**（`ui` kit 的导出清单里没有 Markdown，见 §4.10），技能正文预览只能用 `Text` 包裹换行展示；需要富文本（表格/代码高亮）只能放到 `tuiPanels` 的 `ui.Markdown`/`ui.CodeBlock`。

### 4.2 `tuiPanels`：侧栏面板（实验性，可选增强）

- 类型入口：`@deepseek-harness-tui/dsh-tui/panels`（`TUI19/lib/types/panels.d.ts`）。`apiVersion` 必须为 `1`；`register` 拒绝时 **warn + 返回 undefined/false，不抛错**。
- descriptor（`TUI19/lib/types/dsh-adapter/panels.d.ts`）：`{ apiVersion: 1, id（单段 slug，宿主自动加 '<pluginId>:' 前缀）, title, icon?（显示宽度必须 1）, minColumns?, order?, component?, compact? }`。预算：**每插件 ≤4 个、全局 ≤32**；`open()` 每插件每 5s 至多 1 次；`mountPolicy` 强制 `'active'`（非 active 即卸载，组件状态不保留，`panels.d.ts` 头注释）。
- props：`{ React, ui, host, width, height, focused, visible, mode }`；`mode` 为 `'split' | 'zoom' | 'fullscreen'`。
  - **descriptor 没有 `capabilities` 字段** → 插件 Panel 拿不到内置 Panel 的「全屏」按钮/搜索/选择等能力（内置 `PanelDefinition.capabilities` 见 `TUI17/src/components/sidePanel/types.ts:21-32`，插件面没有对应入口）。
- `ui` kit（panel 专用，`panels.d.ts:TuiPanelUi`）：`Box`、`Text`、`Image`、`ScrollBox`、`Divider`、`useTerminalSize`（恒等于 panel 的 width/height）、`useAnimationTime`、`useTheme`、**`Markdown`（只收字符串）**、**`CodeBlock`（原始代码+可选语言）**。
- `host` API：`snapshot()`（策展只读快照：sessionId/cwd/lang/working/todos/jobs/subagents/attention/activity，不含转录正文与凭证）、`focused`、`notify/clearBadge`、`sendToChat`（**本阶段恒 false**，需后续授权）、`openScene(id)`（仅自己注册的场景）、`toast(text)`、`storage`（`tuiPluginStorage` 句柄）、`onKey(listener)`（**仅 focused 期间投递**；`preventDefault()` 阻止宿主回退键）、`focus()`。
- 键盘：没有通用 `useInput`，只有 `host.onKey`；且「分栏渲染时 keymap 可重映射的 paste 组合（默认 Ctrl+V / Alt+V）会先投递到活动面板」——只看 `input` 字符的快捷字母必须先排除 ctrl/meta/super（`panels.d.ts` 注释）。
- 崩溃隔离：插件 Panel 连续崩溃 **3 次 / 60s** 内 → 本会话禁用并落禁用卡（`TUI19/lib/types/components/sidePanel/PanelStore.js:3,5,101-108`）。
- 显示前提（**关键限制**）：侧栏只在 **fullscreen 布局**下存在，且内容宽度要满足 `canSplit(columns) = columns ≥ CHAT_MIN_COLUMNS(64) + PANEL_MIN_COLUMNS(28) + 1 = 93`（`TUI17/src/components/sidePanel/useSidePanel.ts:168`；`TUI17/src/components/sidePanel/dimensions.ts:22-34`）。inline 模式下没有侧栏 → **面板完全不可见**。`minColumns` 默认 28；面板宽度由用户的 ratio/zoom 决定；侧栏整列 `noSelect`（不可选择/复制，`TUI17/docs/plugins.md:52-70`）。
- `compact` 行：descriptor 只校验、**尚不挂载渲染**（0.17/0.19 一致，`panels.d.ts` 头注释 + `TUI17/src/dsh-adapter/panels.ts:20,539-540`）——首版不要依赖 compact。
- 结论：**面板只适合「常驻快速视图」**（例如「已启用技能数 / MCP 健康」摘要 + 一个 `openScene` 按钮），不适合承担列表-详情-表单的主交互。

### 4.3 `tuiSettingsSections`：`/settings` 声明式编辑区块

- 类型入口：`@deepseek-harness-tui/dsh-tui/settings-sections`；`ctx.tuiSettingsSections.register(section)` → disposer（`TUI19/lib/types/dsh-adapter/settings-sections.d.ts`）。
- 契约是**声明式**的：插件只描述字段，渲染/草稿/保存/冲突重试由 TUI 负责；存储、校验、分层在 `ctx.settings`（`TUI17/tui-profile/docs/plugin-admission-and-development.md:728-776`）。
- 字段能力（`TUI19/lib/types/adapter/ports/channel-settings.d.ts:214-322`）：`kind: 'text' | 'number' | 'boolean' | 'select'`；`secret?: { ref }`；`page?: { id, title }` 按 page 分组页签；`group`（`mode: 'inline' | 'page'`）；`hint`；`options`；`step` 等。**不支持对象/数组/dict 编辑器**，复杂结构只能提示用户手改 YAML（`:770-776`）。
- 命名空间必须由插件自己的 `ctx.settings` 命名空间支撑；未注册时区块显示为**不可用**（`:776`）。
- 适用：**插件自己的偏好**（默认视图、是否显示插件技能、保留策略等）→ 可省掉自绘设置页。
- 不适用：技能/MCP 的动态列表（数量不定、需要增删改）——声明式字段表达不了。

### 4.4 `tuiDialogs`：托管对话框（select / confirm / input）

- 类型入口：`@deepseek-harness-tui/dsh-tui/extensions`；服务 `ctx.tuiDialogs`（`TUI19/lib/types/dsh-adapter/dialogs.d.ts:114-141`）：
  - `select(request) → Promise<string | undefined>`（选项 `{ id, label, description? }`，另有 `(owner, request)` 重载）；
  - `confirm(request) → Promise<boolean>`（取消按 false）；
  - `input(request) → Promise<string | undefined>`（单行编辑）。
- 契约（`TUI17/tui-profile/docs/plugin-admission-and-development.md:1042-1098`）：永不抛错（畸形请求落定取消值 + 告警）；入参消毒（控制字符、≤120/≤400/≤500 cell、选项 ≤100）；`select` 的选项 `id` **原样返回**（opaque token，不参与渲染）；面板按键 ↑/↓/Enter/Esc；FIFO 排队、一次一个；`timeoutMs` 是无头兜底。
- **重要限制【已验证+推断】**：对话框渲染在 Chat 的提示框上方；插件场景打开时 Chat 直接 early-return（`TUI19/lib/types/screens/Chat.js:6110-6118`），因此**场景打开期间调用 dialogs 很可能不可见/不可操作**。结论：**表单不要依赖 dialog，场景内自绘；dialog 只在场景外（命令前置确认、快捷键流程）使用**。要精确验证需实机跑一次（列在 §9）。
- 生命周期：插件 deactivate 后，排队与 active dialog 以取消值结算，不留占键盘请求。

### 4.5 `tuiShortcuts`：全局快捷键

- 服务：`ctx.tuiShortcuts.register(combo, { description, handler }, identity?)` → disposer（`TUI19/lib/types/dsh-adapter/shortcuts.d.ts:39-50,73-79`）。
- 规则（`TUI17/tui-profile/docs/plugin-admission-and-development.md:1181-1216`）：**必须带 ctrl 或 alt**；保留位不发（ctrl+c/d/t/r/g/o/l/e/v/a/u/k/w、ctrl+←/→、ctrl/alt+Enter、alt+↑、Esc、Tab、Shift+Tab，含 Shift 超集）；`escape` 组合一律拒绝；重复注册被拒；只在**纯对话态**派发（picker/审批/问卷/dialog/场景/会话浏览器打开时键盘归浮层）；handler fire-and-forget，异步拒绝被捕获并 toast。
- 适用：给场景一个直达键（例如 `ctrl+shift+m`，需确认不在保留位），但**不能**替代命令入口（可发现性靠 `commands`）。

### 4.6 `commands`：斜杠命令（与 `ctx.tuiPluginHost.registerCommand`）

- 两种注册方式：
  1. **直接** `ctx.commands.register({ name, description, handler })`（`DSH/.../dsh-commands/lib/types/index.d.ts:38-55,94`）：`handler(invocation) → CommandResult | Promise<CommandResult>`；命令由 `dsh-commands` 执行，记 `command/run`/`command/done`。**这是场景文档里的写法**（`TUI17/tui-profile/docs/plugin-admission-and-development.md:849-866`）。
  2. **经调解面** `ctx.tuiPluginHost.registerCommand(pluginCtx, definition)`：给命令打上已验证 Component 身份（C-041 attribution），供 invoke 检查点做 per-owner deny（`TUI19/lib/types/dsh-adapter/plugin-host.d.ts:1-40`）。**若将来要进生态准入，建议走这条**；但它是 v0.15 的插件互通面，是否作为第三方插件的必选项需以准入文档为准（本文未验证其强制程度）。
- 冲突：**本地命令优先**，插件同名命令被丢弃（`TUI17/tui-profile/docs/plugin-admission-and-development.md:596-599`）。0.19 内置命令已占 `skills`、`mcp`、`plugin`、`panel`（`TUI19/lib/types/commands.js:35-108`）——**新命令名要避开**（建议 `/skill-mcp` 或品牌名）。
- 注意：技能也会以「Slash 命令」形式合并进菜单（`TUI19/lib/types/dsh-adapter/channel/skill-catalog.js`）；同名技能与我们命令冲突时本地/内置优先。选一个不易撞名的命令。

### 4.7 `tuiStatus`：状态行 + 底栏字段

- 服务（`TUI19/lib/types/dsh-adapter/status.d.ts`）：`set(key, text)`（提示框上方一行，` · ` 连接）；`setField(key, text, options)`（底栏第 2 行，三槽 `left-tail|right-head|right-tail`，`tone` 仅语义色，`maxCells` 默认 16、≤32，`minColumns`，`detail`，`onClick`（**仅 fullscreen 有鼠标**，且必须同时给 `detail`）；全局 ≤6 字段、单 activation ≤2）。`registerView(descriptor)`：1–3 行、只读、无键盘、无 channel 的富内容（`status.d.ts:32-56,213-226`）。
- 纪律：生命周期是调用者责任（`ctx.effect` 挂 disposer；旧 disposer 不清新值）；纯展示，不承载交互（`TUI17/tui-profile/docs/plugin-admission-and-development.md:1100-1179`）。
- 适用：摘要（「技能 12 · MCP 3」）或后台任务进度；不适合作为主入口。

### 4.8 `tuiRenderers`：transcript 条目渲染器（本项目不用）

- 服务 `ctx.tuiRenderers.register(type, renderer)`：把插件经接缝一追加的 log-only 事件映射成**纯文本行**（`TUI17/tui-profile/docs/plugin-admission-and-development.md:1218-1252`）。
- 限制：拿不到 React；必须同时满足「log-only 事件 + 写 `KNOWN_SESSION_EVENT_TYPES`」两条铁律；文本强校验（行数 ≤100、行宽 ≤400 cell）。与「管理界面」不匹配，仅适合操作留痕。**首版不采用**（若要审计轨迹，可后续加）。

### 4.9 `tuiToast`：临时通知（实验性）

- 服务 `ctx.tuiToast.show(text, options?) → boolean`（`TUI19/lib/types/dsh-adapter/toast.d.ts:62-75`）：只收标量（string/number/boolean），剥控制字符、≤200 cell；**20 条/分**，超限丢弃并只警告一次；无 sink 时返回 false。**操作成功/失败的即时反馈用它**（场景内也可以调，toast 是全局浮层——是否覆盖场景需实机确认，列 §9）。

### 4.10 UI kit 能力清单（场景与面板的区别是硬约束）

`TUI19/lib/types/ui.d.ts:7-34`（0.17 的 `TUI17/src/ui.ts` 同）导出：`render/renderSync/createRoot`、`ThemeProvider/useTheme`、`Box`、`Text`、`InputCaret`、`Spacer`、`Newline`、`NoSelect`、`Image`、`AlternateScreen`、`ScrollBox`、`useInput`、`useDeclaredCursor/useNativeCursor`、`useCopyOnSelect`、`useStdin`、`useApp`、`useAnimationFrame`、`useTerminalSize`、`useTerminalImages*`、`useBlink`、`Ansi`，类型 `Key`。

**没有**：`TextInput`/`SelectInput`/`Markdown`/`CodeBlock`/`Table`/列表组件/字符串宽度工具。场景拿到的 `ui` 就是这份清单。

- 表单输入 → 自己用 `useInput` + state + `InputCaret`（宿主只在对话框内部实现了单行编辑逻辑，未导出）。
- 富文本（Markdown/代码高亮）→ 只有 `tuiPanels` 的 `ui.Markdown`/`ui.CodeBlock` 提供（实验性、包装面，只收字符串；围栏/语言标签清洗/高亮由宿主负责，`panels.d.ts` 注释）。
- 终端宽度：宿主 `Text` 负责换行，但**手工截断/对齐必须按 terminal cell**；ui kit 不导出宽度函数，需要自带小依赖（如 `get-east-asian-width`）或只依赖 `Text` 的 `wrap` 行为。
- `ScrollBox` 可用（场景/面板都提供），适合长列表；`NoSelect` 可用于避免出现选择光标（面板侧栏整体已 `noSelect`）。

### 4.11 接缝选择矩阵（面向本项目）

| 接缝 | 全屏 | 列表/滚动 | 文本输入 | 富文本 | 键盘 | 宽度 | 崩溃隔离 | 稳定性 | 本项目 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tuiScenes` | ✅ 独占 | ✅ ScrollBox 自绘 | ❌ 需自绘 | ❌ 无 Markdown | 独占 | 自适应 | ✅ 渲染错误边界 | 稳定候选 | **主界面** |
| `tuiPanels` | ❌ 侧栏 | ✅ ScrollBox | ❌ | ✅ Markdown/CodeBlock | `host.onKey`（仅 focused） | 窄（默认≥28，需分栏宽度≥93） | ✅ 3 次/60s 禁用 | 实验性 | 可选 quick view |
| `tuiSettingsSections` | ❌ 设置页 | ❌ | ✅ 声明式 | ❌ | 宿主接管 | — | ✅ | 稳定候选 | 插件偏好 |
| `tuiDialogs` | ❌ 浮层 | ✅ 选项列表 | ✅ 单行 | ❌ | 宿主接管 | 居中 | ✅ 永不抛错 | 稳定候选 | 场景外确认/输入 |
| `tuiShortcuts` | — | — | — | — | 纯对话态 | — | ✅ | 稳定候选 | 直达键（可选） |
| `commands` | — | — | — | — | — | — | ✅ | 跟随上游 | 入口 |
| `tuiStatus` | ❌ 一行 | ❌ | ❌ | ❌ | ❌ | 窄 | ✅ | 稳定候选 | 摘要（可选） |
| `tuiRenderers` | ❌ | ❌ | ❌ | ❌ | ❌ | — | ✅ | 稳定候选 | 不用 |

---

## 5. 终端里做「列表-详情-表单-分组」：可行性与限制

### 5.1 布局方案（在 `tuiScenes` 内）

按 `useTerminalSize().columns` 分档（终端宽度是**显示单元**，不是 `String.length`；CJK/emoji 按 2 cell 计）：

| 内容宽度 | 布局 |
| --- | --- |
| ≥ 110 | 四栏：作用域（全局/工作区）｜分组 ｜ 列表 ｜ 详情/表单 |
| 90–109 | 三栏：作用域+分组合并为左侧可折叠树 ｜ 列表 ｜ 详情 |
| 64–89 | 双栏：列表 ｜ 详情（作用域/分组做成顶部 chip 行，按 `tab`/`f` 切换筛选器） |
| < 64 | 单栏 + 面包屑导航（列表 → 详情 → 返回），顶部显示当前作用域/分组 |

实现建议：外层 `Box flexDirection="column"`，标题行 + 主体 `Box flexDirection="row"` + 底栏键位提示；分隔线用 `Text` 绘制；主体各栏自己 `ScrollBox`。**不要**用 `%` 宽度（ink 对 % 与 padding 的解析会撒谎，`TUI17/src/components/sidePanel/dimensions.ts:1-16` 有明确教训），用实际 columns 计算且每层向下传。

### 5.2 键盘交互模型（场景必须自己实现）

- 场景独占键盘：导航键（↑/↓/j/k、PgUp/PgDn、Home/End、Tab/Shift+Tab 切栏、Enter 进入、Esc/`q` 返回/关闭）全部自绘；关闭时 `close()`。
- 表单：单行编辑自绘（字符追加、Backspace、←/→ 移动、Home/End、Enter 提交、Esc 取消）；注意 `useInput` 的回调会收到**多字符 paste**（bracketed paste 被压平成一段字符串），实现上应把多字符 input 当整段插入而不是逐字处理【推断；对话框内部的实现可参考 `TUI19` 的 dialogs 模块，但未导出】。
- 搜索：一个 `/` 进入搜索态（输入过滤列表）；搜索态下 Esc 退出。
- 危险操作（删除技能/MCP 行）：场景内二次确认行（`y/n`）或先关场景再用 `tuiDialogs.confirm`；不要依赖 dialog 覆盖场景（§4.4）。
- 鼠标【未验证】：全屏模式下宿主有鼠标跟踪与选词/滚动，但**插件场景是否能收到鼠标事件未验证**（ui kit 无 `useMouse`，`Box` 的 `onClick/onWheel` 是否在场景中被派发未证实）。**按纯键盘设计**。
- 复制/选择：fullscreen 的选区/复制是宿主能力（内建面板被明确 `noSelect`）；插件场景在这条链路上的行为【未验证】。纯键盘设计下不依赖。

### 5.3 场景 vs 面板 vs 设置区块：判据

- 主交互（列表-详情-表单-分组-批量）→ **场景**；
- 常驻摘要 + 一键进场景 → **面板**（只在 fullscreen 分栏可用）；
- 插件自身配置 → **设置区块**；
- 单值确认/输入（命令前置流程）→ **对话框**；
- 每帧成本由场景自己承担：高频动画用 `ui.useAnimationFrame`，渲染路径不做同步 I/O（`TUI17/tui-profile/docs/plugin-admission-and-development.md:938-939`）。

### 5.4 已知不可行 / 不建议

1. **对话框覆盖场景**：场景是 Chat 的整屏 early-return，dialog 渲染在提示框区域 → 打开场景时 dialog 不可见（§4.4，实机待验）。
2. **面板在 inline 布局不存在**：只看它做管理界面会在 inline 用户那里整体消失（§4.2）。
3. **场景无 Markdown/代码高亮**：技能正文只能纯文本展示；需要高亮就开一个面板或在场景里用等宽文本 + 自绘简单语法着色（成本高，建议首版不做）。
4. **面板不可选择/复制**、**compact 未渲染**、**panel `sendToChat` 恒 false**（§4.2）。
5. **noSelect / 鼠标 / paste 的细节**属于宿主实现细节，随版本变化；首版按键盘 + 纯文本走，降低耦合。

### 5.5 崩溃隔离与生命周期（务必按此设计）

- 场景：渲染/生命周期异常 → boundary 关闭场景 + 转录报错；**effect/异步异常自己兜**（try/catch + toast）。
- 面板：3 次/60s 崩溃 → 本会话禁用，用户需重开会话（§4.2）。
- 注册资源全部 `ctx.effect` 清理；场景 dispose 会关屏；面板非 active 会卸载（状态放模块级 store，组件只读）。
- HMR 重载插件代码时，旧 activation 被 dispose → 场景关闭、面板注销、命令重注册；**不要在模块级缓存里存 activation 相关对象**（service 实例、React 元素、dispose 函数）。

---

## 6. 数据层：技能与 MCP 在 TUI 侧怎么读写

> 本节只给「UI 插件需要知道的接缝级结论」；内核机制细节与逐行证据见 `03-dsh-skills-and-mcp-mechanisms.md`，web 参考实现细节见 `02-reference-web-plugin-dsh-skill-mcp-panel.md`。

### 6.1 技能：真源是文件系统（不是 `ctx.skills`）【已验证】

发现根与规则（`DSH/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:160-198,585-628,821-829`）：

| 作用域 | 根目录 | 来源标记（`source`） | rank |
| --- | --- | --- | --- |
| 工作区 | `<projectRoot>/.dsh/skills` | `project-dsh` | 最高 |
| 工作区 | `<projectRoot>/.agents/skills` | `project-agents` | 次高 |
| 全局 | `$DSH_HOME/skills`（默认 `~/.dsh/skills`） | `user-dsh` | 中 |
| 全局 | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） | `user-agents` | 低 |
| 自定义 | `customSkillDirs`（profile 配置，当前 TUI profile 未配） | `custom` | — |
| 随包 | `config.bundledSkillDir` / `DSH_BUNDLED_SKILL_DIR` | `bundled` | 最低 |

- **`projectRoot` 判定**：从 `cwd` 向上找最近含 `.git` 的祖先，找不到回落到 `cwd` 本身（`dsh-skill-filesystem/lib/index.js:821-829`）。**做工作区维度时必须用同一算法**，否则列表与实际生效不一致。
- **文件形态**：目录束 `<root>/<name>/SKILL.md`；单文件 `<root>/<name>.md`（只扫根层，**不递归分类目录**）。frontmatter 必须 `---` 包裹且含 `name`（kebab-case）+ `description`，可选 `whenToUse`/`invocation` 等；不合法 → 静默丢弃只留日志（`03` §1.2 有详细证据）。
- **「停用」没有内核 API**：把 `SKILL.md` 改名 `SKILL.md.disabled`、或把 `<name>.md` 改名 `<name>.md.disabled`，provider 就不再列出（文件名不再匹配）。这与 web 参考插件的约定完全一致（`WEBPANEL/lib/skill-files.js:9-12,21,238-270`；`02` §3.4）——**两边必须用同一约定，才能互相看见对方的状态**。
- **热生效**：provider `watch: true` 默认（`dsh-skill-filesystem/lib/index.js:36`），watcher 变更 → `invalidate()` → `skills/change` → 消费端重取（`03` §1.3）；技能正文不缓存，改正文下次 `get` 即新内容。TUI 的 `/skills` 菜单与 `/name` 命令会在下一个刷新点更新（`TUI19/lib/types/dsh-adapter/channel/skill-catalog.js`）。
- **为什么 host 插件不能靠 `ctx.skills.list()`**：见 §1.2 结论 1。**列表必须自己扫盘**（按上表根 + 同一套文件规则 + frontmatter 解析）；`ctx.skills` 只用于（可选）交叉校验「模型是否真的看到」（需要 agent scope，host 插件拿不到 agent）。
- **web 参考插件比内核多扫一层嵌套分类目录**（`WEBPANEL/lib/skill-files.js:1-17,200-245`，兼容 pi/Codex 布局，最多 8 层）。**本插件不要跟**：内核不发现嵌套层，跟了会显示「面板有、模型看不到」的幽灵技能。首版按内核规则扫，并可在详情里提示「目录束/单文件」形态。

### 6.2 技能操作矩阵（UI 需求 → 机制）

| 需求 | 机制 | 热生效 | 风险/注意 |
| --- | --- | --- | --- |
| 列表（全局/工作区） | 扫盘 + 解析 frontmatter | watcher 自动 | 与 web 面板同根同规则；嵌套目录不扫 |
| 详情 | 读 `SKILL.md` / `<name>.md` 全文 | 现读现新 | 正文按不可信输入消毒后再渲染（控制字符/超长/宽度） |
| 开启/关闭 | 文件改名 `*.disabled` | ✅（watcher） | 目录束改 `SKILL.md`；两种形态分别处理；失败要回滚改名 |
| 删除 | `rm` 文件/目录 | ✅ | 需要二次确认；**「删除」是用户数据动作**，与插件 `disable/remove/purge` 语义不同，文案必须区分（准入 E 节） |
| 添加 | 校验 frontmatter → 写入目标根 | ✅ | 目标作用域内重名要拒绝（与内核去重规则一致）；支持 `.md`/目录束，`.zip` 需 `fflate`（可选） |
| 分组 | 插件私有 JSON（显示配置） | 无需热载 | 不写技能目录；与 web 面板共用文件则两边一致（§6.4） |
| 迁移/复制到工作区 | 校验 → 复制/移动 → 失败回滚 | ✅ | 参考 `WEBPANEL/lib/scope.js`（`02` §3.6） |
| 插件自带技能 | `source: 'bundled'`（`DSH_BUNDLED_SKILL_DIR`） | 只读 | 首版只展示+隐藏，不删/不改（与 web 面板「插件技能一键隐藏」对齐） |

### 6.3 MCP：真源是 profile / home 的 `cordis.patch.yml`【已验证】

- **一个 MCP server = 一条 loader 行**：`name: '@deepseek-ai/dsh-mcp-client'`，`config` 为 `{ transport: 'stdio', serverName, command, args, env, cwd?, toolCallTimeoutMs?, failOnStartupError? }` 或 `{ transport: 'streamable-http', serverName, url, headers, … }`；`serverName` 必须 `[A-Za-z0-9_-]{1,32}` 且进程内唯一（`DSH/node_modules/@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts:1-75`）。工具注册名 `mcp__<serverName>__<rawName>`；插件实例 effect-scoped，dispose 断开连接并注销工具，HMR 用「dispose 旧实例 + 建新实例」热替换（同文件 `:1-16`）。
- **行写在哪**：
  - `PROFILE/cordis.patch.yml`（当前 profile；patch 顺序：bundle patches → profile patch → **home patch** `~/.dsh/cordis.patch.yml` → 命令行 overlay，`DSH/.../dsh-app-boot/lib/index.js:1908-1918`）；
  - `~/.dsh/cordis.patch.yml` 即「全局（跨 profile）」层；HMR 同时 watch **profile patch 与 home patch**（`DSH/node_modules/@deepseek-ai/dsh-hmr/README.md`「Profile and home patch changes also trigger recomposition」+「both user patch watches」）。
  - 覆盖面：**MCP 没有工作区（workspace）维度**。它能做到的是「home 层（全局，跨 profile）vs 当前 profile」；per-workspace MCP 需要另做设计（`03` §3.4 给过四条路径与代价，不建议首版做）。
- **读写 API 矩阵**：

| 操作 | 推荐路径 | 证据/注意 |
| --- | --- | --- |
| 列 vs 状态 | 读 patch 文本（`yaml` 解析，保留 `!!js` 自定义 tag）拿到 server 列表与原文；再用 `ctx.pluginManager.listPlugins()` 拿 `entryId/patchId/enabled/fiberPhase/diagnostic` | `pluginManager` 见 §3.5；行按 `moduleName === '@deepseek-ai/dsh-mcp-client'` 匹配 |
| 启停 | **`ctx.pluginManager.setPluginEnabled(entryId, enabled)`** | 官方写 `disabled` 覆盖行 + `reload()`（`DSH/.../dsh-plugin-manager/lib/index.js:2669-2681`）；`!!js` 的 `disabled` 表达式不走布尔路径（web 参考插件用 `waitForLoaderState` 轮询，`WEBPANEL/lib/mcp/gateway.js:42-55`） |
| 编辑配置 | 方案 A：**原始 YAML 字节保真编辑**（推荐，`02` §4.3 的 `patch-editor.js` 是现成参考）；方案 B：`ctx.settings.mutate(ns, ops, revision)`（revision 栅栏、按字段合并、保留未编辑字段）；方案 C：`ctx.configEditor.edit(entry, change)`（整块 config 替换） | B/C 都有一个坑：它们替换的是**值**，配置里的 `!!js` 表达式会被「求值后的值」或字面量覆盖（config-editor 只保证**被替换值之外**的注释/`!!js` 保留，`DSH/.../dsh-config-editor/README.md`「Known Limitations」）。**MCP 的 env/headers 常用 `!!js`，因此编辑走 A 更稳** |
| 新增 | 往 patch 里插入一条 `- insert: - id: mcp-<name>, name: '@deepseek-ai/dsh-mcp-client', config: …`；写盘后等 HMR 生效 | **没有官方 add-row API**；需自己做：YAML 校验 → 同目录临时文件 + rename → 锁；参考 web 的受管块与锁（`WEBPANEL/lib/patch-editor.js:16-17,329-362`），锁文件名 `<patch>.panel.lock`（pid+时间，>30s 视为陈旧，等锁超时 5s）——**要与 web 面板共用同一把锁**才能避免两边并发写坏文件 |
| 删除 | 从 patch 删除该行（字节保真）；先确认 | 同样无官方 API；删除后 HMR 组合会卸载该行 |
| 位置 | `ctx.settings.documentPath` / `ctx.configEditor.documentPath` 给当前 profile patch 路径（官方）；home patch 路径 = `$DSH_HOME/cordis.patch.yml` | `DSH/.../dsh-settings/lib/types/index.d.ts`（`get documentPath()` / `prepareDocument()`）；`DSH/.../dsh-config-editor/lib/types/index.d.ts`（`get documentPath()`）。**不要**用 `ctx.baseUrl` 猜（其语义未验证） |
| 测试连接 | 内核**没有**可复用 API（`03` §2.7）；要么用 MCP SDK（web 用的是 `@modelcontextprotocol/sdk@^1.12.0`），要么临时挂一次 `apply` 再销毁 | 首版可裁剪（用户原始需求未强制要求「测试连接」） |
| 单工具禁用 | `ctx.tools.restrict({ deny })` **只能由 agent scope 施加**，全局 ctx 调用会抛错（`03` §2.6） | 首版不做；若做需解决 scope 获取问题 |

- **编辑前的「被覆盖」判定**：home patch 在 profile patch 之后应用 → 同一行 id 若 home 层也配了，**home 覆盖 profile**；`configEditor` 的 `ChangeResult.application === 'overridden'` 表达这种情况。面板要提示「该行被更高层覆盖，改 profile 不生效」【已验证：patch 顺序 + ChangeResult 枚举】。
- **生效等待**：写完 patch 后 HMR 有 `awaitWriteFinish`（默认 2s）+ debounce；不要同步断言。web 参考插件的做法是 poll loader entry（`WEBPANEL/lib/mcp/status.js:24-53`），本插件可用「轮询 `pluginManager.listPlugins()` 直到 `enabled` 变化 / 超时 toast」。
- **安全**：`env`/`headers` 的值可能含令牌。列表/详情默认脱敏（`***`）；原文编辑器显式提示「明文可见」；不要把值写进日志（准入 F 节：effect ledger 不得记录 secret/credential/token/消息正文）。

### 6.4 分组/视图配置存哪（技能）

三个选项，建议 **A 优先、B 兜底**：

| 方案 | 位置 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 与 web 面板共用 | `$DSH_HOME/skills/.system/skill-viewer/groups.json`（`WEBPANEL/lib/groups.js:25-50`） | 两端分组一致；`.system` 被内核 provider 跳过（`dsh-skill-filesystem/lib/index.js:595`），不污染技能目录 | 两个进程可同时写（web 面板对该文件是「临时文件+rename」而非锁）；需容忍损坏（读失败按空配置） |
| B. 插件私有 | `~/.dsh-tui/skill-mcp-panel/groups.json` | 完全隔离，无并发 | 与 web 面板分组不同步（用户可感知） |
| C. `tuiPluginStorage` | `~/.dsh-tui/plugin-storage/<ns>.json` | 官方隔离/配额/原子写 | **默认拒绝**，需用户先写 `extension-grants.json` 授予 `storage.local.read/write`（§3.6），首版不值得 |

建议首版：**读 A，若目录/文件不存在则创建并写 A**；写用原子 rename + 与 web 面板相同的 JSON 结构（version 1，`groups[id] = { name, scopes: { "global": [names], "<workspacePath>": [names] } }`）；同时在 §9 留「并发写」风险与后续用锁/文件监听收敛的方案。

### 6.5 与 web 参考实现的对照（本项目要复用什么）

| 维度 | web 版（`WEBPANEL/`） | TUI 版（本插件） |
| --- | --- | --- |
| UI 技术 | React web + 宿主侧边栏槽位 | `tuiScenes` 全屏 React/Ink |
| 服务形态 | `TypertRemoteService`（web client RPC） | Cordis 服务 + 本地函数调用；**不需要 typert** |
| 技能实体 | 直接操作磁盘（与内核同规则，但多扫嵌套） | 直接操作磁盘（**严格跟内核规则**） |
| 技能启停 | 改文件名 `*.disabled` | 同 |
| 分组 | `~/.dsh/skills/.system/skill-viewer/groups.json` | 可复用（§6.4） |
| MCP | 编辑 profile patch（受管块 + 字节保真 + 锁） | 同思路；启停走 `pluginManager`；编辑可走字节保真 |
| MCP 作用域 | profile 级 | profile 级 + home 级（全局） |
| 依赖 | `yaml`、`zod`、`fflate`、MCP SDK、chokidar | `yaml`（+可选 `fflate`/`get-east-asian-width`）；**不引入 zod/typert/SDK**（首版） |

---

## 7. 推荐架构（供需求/设计文档落地）

### 7.1 模块拆分（只到模块级，不写产品代码）

```
dsh-tui-skill-mcp-panel/
├─ package.json            # exports "."，dsh.bundle.patch，peer: cordis + dsh-tui
├─ cordis.patch.yml        # - insert: - id: skill-mcp-panel
├─ dsh-plugin.json         # 仅生态准入阶段需要（首版可无）
├─ lib/types/              # tsc 产物（纯 ESM，相对导入带 .js）
│  ├─ index.js             # apply：注册 scene / command / shortcut / (panel) / (settings section)
│  ├─ scene/               # TuiSceneProps 组件树：布局、列表、详情、表单、确认
│  ├─ store.js             # 模块级状态 + 订阅（useSyncExternalStore），不持 activation 对象
│  ├─ data/skills.js       # 扫盘、frontmatter、改名启停、增删、迁移（与内核同规则）
│  ├─ data/mcp.js          # patch 解析/字节保真编辑、pluginManager 启停、锁、等待生效
│  ├─ data/groups.js       # 分组 JSON（A/B 方案）
│  └─ format.js            # 脱敏、cell 宽度、截断、安全文本
└─ README.md
```

### 7.2 `apply()` 的注册顺序（全部软探测 + `ctx.effect`）

1. 模块级 store 初始化（不触碰 ctx 服务）；
2. `ctx.inject(['tuiScenes'], …)` 注册场景（id `skill-mcp-panel`，`ctx.effect` 挂 disposer）；
3. `ctx.inject(['commands'], …)` 注册 `/skill-mcp`（handler 调 `tuiScenes.open`，返回静默 success）；若生态准入要求，改用 `ctx.get('tuiPluginHost', false)?.registerCommand(ctx, def)`；
4. 可选 `ctx.tuiShortcuts.register('ctrl+shift+m', …)`（先确认组合未被占用）；
5. 可选 `ctx.tuiPanels.register(…, ctx)`：quick view + `host.openScene('skill-mcp-panel')`；
6. 可选 `ctx.tuiSettingsSections.register(…)`（插件自身偏好）。
7. 任何服务缺席 → 记录一次 warn 并降级（例如没有 scenes 时命令返回错误文案，**绝不让 TUI 启动失败**）。

### 7.3 需求 → 机制映射（用于需求文档逐条验收）

| 用户需求 | 实现机制 | 首版 |
| --- | --- | --- |
| 可视化开启/关闭技能 | 改名 `*.disabled` + 列表刷新（watcher） | ✅ |
| 可视化删除技能 | `rm` 文件/目录 + 二次确认 | ✅ |
| 可视化添加技能 | 校验 frontmatter → 写目标根；`.md`/目录束；zip 可选 | ✅（zip 可延后） |
| 可视化开启/关闭 MCP | `pluginManager.setPluginEnabled` | ✅ |
| 可视化删除 MCP | patch 字节保真删行 + 确认 | ✅ |
| 可视化添加 MCP | patch 受管块插入 + 锁 + 等 HMR | ✅（复杂度最高） |
| 热加载 | 技能 watcher；MCP HMR patch watch / pluginManager reload | ✅（无需重启；极端情况 `restart-required` 要提示） |
| 区分全局和工作区 | 技能：全局根 vs 工作区根（projectRoot 判定）；MCP：home 层（全局）vs profile 层 | ✅（MCP 无 per-workspace） |
| 分组操作 | 技能分组（显示配置）+ 批量启停/迁移 | ✅ |
| 参考 web 面板 | 实体模型/改名约定/分组文件/patch 编辑复用；UI 换成 Ink 场景 | ✅ |

---

## 8. 准入清单对首版的要求

依据：`TUI17/tui-profile/docs/plugin-admission-and-development.md:275-359,1493-1551`（TUI Admission v0.15），与 `04-ecosystem-and-prior-art.md` 的生态结论。

### 8.1 两档要求，别混

| 档 | 需要什么 | 本项目首版 |
| --- | --- | --- |
| **能装能跑（自用/内部分发）** | `package.json`（`type/module/main/files/engines/peer`）+ `dsh.bundle.patch` + `cordis.patch.yml`；`dsh plugin add` 或 `/plugin install` | **满足即可发布/自用** |
| **生态准入（目录/市场/推荐）** | 上面全部 + 包根 `dsh-plugin.json`（过 0.15 parser）+ 检查清单 A–G + 版本/仓库/许可证/provenance + 真实 TTY 验证 | 需要时再补（清单见表下） |

### 8.2 官方准入检查清单（A–G）对本项目的适用性

| 节 | 要求 | 本插件是否触发/要做什么 |
| --- | --- | --- |
| A 包与身份 | 根唯一 `dsh-plugin.json`；manifestVersion `0.15`；`id` 稳定唯一；`facets.host.entry/apiVersion`；repo/license 可定位；Verified claim 需 artifact digest | **全部适用**；manifest 必填项见 §3.3；首版先不声明 Verified |
| B 声明完整性 | required/optional 契约、permissions、subscriptions、contributes 全声明；不写 `provides`/`requires.services`；`contributes.panels` 必须为 `[]` | 若用场景/设置区块：`requires.contracts` 写 `{ apiVersion: "tui.dsh/v1alpha1", kind: "Scene" }`（可选 `SettingsSection`，带 fallback 文案）；`permissions: []`；`subscriptions: []`；`contributes.commands: []`（命令运行时注册，可不列；若要展示则列）。依据：v0.15 允许 `requires.contracts` 引用 registry 的 `extensions` 段坐标，当前该段已含 `tui.scene`、`tui.settings-section`、`tui.backend`、`workspace.provider`（`TUI17/tui-profile/registry/registry-0.15.json`；`TUI17/tui-profile/docs/plugin-admission-and-development.md:302-304`） |
| C TUI 兼容性 | Host Descriptor negotiation 通过；不假设 GUI/浏览器；不缓存 Presentation；Backend 声明（本项目没有） | 场景/Dialog 全是终端 UI，满足；无 remote/attach 声明 |
| D 运行时行为 | activation 顺序、runtime generation scope、重复 activation 确定、资源可定位、cleanup 可观测 | 所有注册走 `ctx.effect`；场景/面板 disposer 必挂；HMR 重载后能重注册（§5.5） |
| E 清理与恢复 | `disable`/`remove`/`purge` 三义区分；grant/subscription 可撤销；残留如实报告 | **文案红线**：技能「删除」≠ 插件 `remove`；本插件不删用户数据、不假装清理（沿用 `TUI17/tui-profile/docs/plugin-admission-and-development.md:344-358` 的口径）；私有配置卸载后保留并说明 |
| F 信任与声明 | 装/启用前展示 `trusted-in-process`、非沙箱；claim 绑定；不记录 secret | 本插件**不做插件安装**，无需装包披露；但**修改 profile patch** 属于改变组合，UI 要明确提示影响范围（自加要求）；日志/存储不落令牌（§6.3） |
| G 市场展示 | 兼容性/验证等级/限制分开显示；不写「官方认证」「安全插件」 | README 与面板文案：能力、权限（无）、依赖、TUI-only 限制、实验性接缝（panels）单独标注 |

### 8.3 首版必守的质量红线（来自指南，适用于本插件）

- TUI 活动期间 stdout 安静（调试走 `DSH_TUI_DEBUG` 的 stderr）——`TUI17/tui-profile/docs/plugin-admission-and-development.md:1481-1491`。
- 外部输入（技能 frontmatter/正文、MCP 配置文本）按不可信处理：剥控制字符、按 terminal cell 截断、只收标量；渲染路径绝不做同步 I/O。
- per-session 状态随 `session/disposed` 清理（本插件主要状态是插件级，按 activation 清理即可）。
- 用户数据只放既有 `~/.dsh-tui` 位置（或已存在的 `~/.dsh/skills/.system/`），损坏时回退不崩溃。
- 发布前按 `TUI17/tui-profile/docs/plugin-admission-and-development.md:1552-1563` 在**真实 TTY** 手动验证（无头断言不充分）：至少覆盖 inline/fullscreen、窄终端（<64、64–92、≥110）、`/skills` 菜单热更新、MCP 增删启停与 `!!js` 值往返、HMR 重载场景。

---

## 9. 未决问题与未验证项（交给后续实测/设计决策）

> **2026-11-08 更新**：第 2/5/7 项已由真机探针实测，结论见 [`05-m0-real-machine-probe.md`](05-m0-real-machine-probe.md)。要点：`tuiDialogs`/`tuiToast` 实测不可用（静默取消/丢弃，见 05 §2 Q8）；`pluginManager.listPlugins()` 为空且 `setPluginEnabled` 对 patch 行返回 `unknown-plugin`（05 §2 Q9）；`ctx.skills` 在 host 层为空（05 §2 Q7）；HMR 延迟 ≈2.5s（05 §2 Q11）。

1. **`ctx.baseUrl` 语义**：未验证；**不要用它定位 profile**。改用 `ctx.settings.documentPath` / `ctx.configEditor.documentPath`（官方）；home patch 用 `$DSH_HOME/cordis.patch.yml`。
2. **场景中的 dialog/toast 可见性**：dialog 很可能被场景遮住（§4.4 推断）；toast 是否覆盖场景未验证。实测方法：临时插件场景里调 `ctx.tuiDialogs.confirm` / `ctx.tuiToast.show` 观察。
3. **插件场景能否收到鼠标事件**（`Box` 的 `onClick/onWheel`）：未验证；首版按纯键盘。
4. **plugins 目录下 `panels` 的 `mode: 'fullscreen'`**：插件 descriptor 没有 `capabilities.fullscreen`，是否永远不会进入 fullscreen 模式未验证；不要依赖。
5. **HMR 生效延迟**：`awaitWriteFinish` 默认 2s + debounce；写 patch 后 UI 需等待/轮询，等待上限与时序需实测确定。
6. **并发写**：与 web 面板/CLI 同时写 profile patch 的锁互操作（建议复用 `<patch>.panel.lock` 命名与协议）未实测；home patch 的并发写更需谨慎。
7. **`ctx.pluginManager` / `ctx.configEditor` / `ctx.settings` 作为第三方插件接缝的正式性**：内核有公开类型与服务，但 dsh-tui 的文档没有把它们列为插件接缝；需在需求文档中记为「跟随上游、非 dsh-TUI 承诺」（版本升级可能变）。
8. **`tuiPluginHost.registerCommand` 是否为准入必选**：C-041 attribution 的作用域/强制程度未验证；首版可先直接 `ctx.commands.register`。
9. **技能正文渲染**：场景无 Markdown；首版用纯文本 + 轻量高亮（可选）还是跳面板，需要产品决策。
10. **「工作区级 MCP」**：内核不支持；若产品坚持，需要另立设计（`03` §3.4 列了四条路径，均有代价）。
11. **0.19 是否已有变化的接缝行为**：本文以 `TUI19` d.ts 为准；「0.17 vs 0.19」的运行时行为差异（非类型面）未逐条实测。
12. **首页/帮助的菜单项显示**：插件命令在 0.19 的 `/help` 里如何分类、是否可 i18n（插件侧没有 i18n 接缝）未验证；首版用英文/双语字面量。

---

## 10. 关键证据索引（复核用）

> 全部为只读路径；`sed -n` 可直接复核。

**插件形态/安装/HMR**

- `TUI17/tui-profile/docs/plugin-admission-and-development.md:40-74`（三面 + 包骨架）、`:728-826`（设置区块/patch 组合）、`:824-942`（场景）、`:1042-1098`（对话框）、`:1100-1179`（状态行）、`:1181-1216`（快捷键）、`:1218-1252`（渲染器）、`:1451-1479`（manifest 迁移）、`:1493-1551`（A–G 清单）、`:1552-1563`（验证清单）
- `TUI17/docs/plugins.md:32-36`（接缝稳定性分级）、`:48-70`（panels 实验性细则）、`:84-110`（`/plugin` 安装与生命周期）
- `TUI19/package.json`（0.19.0、exports、`dsh.bundle.patch`）
- `TUI19/cordis.patch.yml`（seam 行：`dsh-tui-workspaces/command-trees/settings-sections/scenes/panels/plugin-host/extensions`；`skill-filesystem disabled` 在 `:87-88`）
- `TUI19/lib/types/dsh-adapter/plugin-guard.js:8-12`（patchReload live）
- `PROFILE/package.json`（`patchReload: "live"`、bundles）
- `DSH/node_modules/@deepseek-ai/dsh-hmr/README.md`（profile/home patch 热组合、模块热替换、awaitWriteFinish）
- `DSH/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/index.d.ts:122-226`；`lib/index.js:2669-2681`（`setPluginEnabled`）
- `DSH/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.d.ts:8-24`
- `DSH/node_modules/@deepseek-ai/dsh-app-boot/lib/types/profile-plugins.d.ts`（安装后 bundles 自动激活）；`lib/index.js:1908-1918`（patch 顺序含 home patch）
- `DSH/node_modules/@deepseek-ai/dsh-config-editor/README.md`、`lib/types/index.d.ts`（`documentPath`/`entries`/`edit`，限制）
- `DSH/node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts`（`documentPath`/`describe`/`update`/`mutate`）
- `TUI17/tui-profile/registry/permissions-0.1.json`（8 权限 / 7 默认拒绝）
- `TUI19/lib/types/dsh-adapter/plugin-storage.d.ts`（storage.local 契约/配额/路径）

**接缝类型面**

- `TUI19/lib/types/dsh-adapter/scenes.d.ts`、`TUI19/lib/types/scenes.d.ts`（`./scenes`）
- `TUI19/lib/types/dsh-adapter/panels.d.ts`、`TUI19/lib/types/panels.d.ts`（`./panels`；apiVersion/预算/限速/UI kit/host API）
- `TUI19/lib/types/dsh-adapter/settings-sections.d.ts` + `TUI19/lib/types/adapter/ports/channel-settings.d.ts:214-322`（字段种类/page/secret）
- `TUI19/lib/types/dsh-adapter/dialogs.d.ts:114-141`、`status.d.ts:32-56,213-226`、`shortcuts.d.ts:39-79`、`toast.d.ts:62-75`
- `TUI19/lib/types/ui.d.ts:7-34`（ui kit 全量导出；无 Markdown/TextInput）
- `DSH/node_modules/@deepseek-ai/dsh-commands/lib/types/index.d.ts:38-55,94`
- `TUI19/lib/types/dsh-adapter/plugin-host.d.ts`（`registerCommand` 调解面）
- `TUI19/lib/types/screens/Chat.js:6110-6118`（场景 early-return + boundary + inline 包 AlternateScreen）
- `TUI19/lib/types/components/PluginSceneBoundary.js:1-30`（渲染错误边界）
- `TUI17/src/components/sidePanel/useSidePanel.ts:168`、`TUI17/src/components/sidePanel/dimensions.ts:22-34`（侧栏只在 fullscreen 且宽度 ≥93）
- `TUI17/src/components/sidePanel/pluginPanelAdapter.tsx:1-30`（面板收窄契约）
- `TUI19/lib/types/components/sidePanel/PanelStore.js:3,5,101-108`（3 次/60s 崩溃禁用）
- `TUI19/lib/types/commands.js:35-108`（0.19 内置命令表：含 `skills`/`mcp`/`plugin`/`panel`）

**数据层**

- `DSH/node_modules/@deepseek-ai/dsh-skill/lib/types/index.d.ts`（`list/snapshot/get/register/registerProvider`、`skills/change`、scope 合并语义）
- `DSH/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:36`（`watch` 默认 true）、`:160-198`（发现根）、`:585-628`（目录束/单文件）、`:821-829`（projectRoot）
- `DSH/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:40-43`（preset 内挂 `skill-filesystem`）
- `TUI19/lib/types/dsh-adapter/bundled-presets.js:81-106`（TUI 把上游 preset 注册进 roster；解析 `@deepseek-ai/dsh-web-app/presets/*.patch.yml`——已在本机 `require.resolve` 实测可解析）
- `TUI19/lib/types/dsh-adapter/channel/skill-catalog.js:25-26`（TUI 自身用 `{ scope: agent, cwd }` 读技能）
- `DSH/node_modules/@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts:1-16,25-75`（一 server 一行/工具命名/HMR 替换/Config）
- `WEBPANEL/lib/skill-files.js:9-12,21,238-270`（`*.disabled` 约定）、`WEBPANEL/lib/groups.js:25-50`（分组文件）、`WEBPANEL/lib/patch-editor.js:16-17,329-362`（受管块/锁）、`WEBPANEL/lib/mcp/status.js:24-53`（等待 loader 状态）

---

## 11. 一句话给决策者

**用 `tuiScenes` 做全屏管理界面、`commands` 进入、场景内自绘列表/详情/表单，MCP 的写操作走「`pluginManager` 启停 + 字节保真 YAML 编辑」，技能全程操作文件系统并与 web 面板共用 `*.disabled` 与分组文件约定；唯一的硬伤是 MCP 没有工作区维度、新增/删除 MCP 行没有官方 API——这两点必须在需求文档里明确承诺边界。**
