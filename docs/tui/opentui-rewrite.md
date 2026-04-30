# 彻底切换到 OpenTUI 的方案

本文档描述将 Vera terminal UI 从 `ink + react` 全量切换到 `@opentui/core + @opentui/solid` 的重构路线。

该方案目标不是简单换组件库，而是把 TUI 建成一个高性能、强交互、插件化的 terminal client。

## 适用场景

选择 OpenTUI 的前提：

- terminal UI 是长期核心产品，而不是 REPL 辅助入口。
- 需要鼠标、selection、extmark、复杂 textarea、侧边栏、多 panel、插件 route/slot。
- Ink 的性能或输入模型已经成为明确瓶颈。
- 团队能接受 Solid/OpenTUI 的维护成本。
- UI event protocol 和 session projection 已经稳定。

不建议在协议层和状态层尚未稳定时直接重写 renderer。

## 目标架构

```text
packages/core
  runtime / session / tool / projection

packages/tui-opentui
  renderer
  routes
  components
  dialogs
  prompt
  theme
  keybind
  plugin host

apps/web-ui
  web renderer using same events/projection
```

OpenTUI renderer 只消费：

- `UiEvent`
- `SessionViewModel`
- `CommandRegistry`
- `BlockingPrompt`
- `ToolDisplayModel`

不直接依赖 `streamAgent`、`planExecutor`、工具实现细节。

## OpenTUI 能带来的能力

### 1. 更强的 terminal renderer

OpenTUI 支持：

- 目标 FPS。
- 鼠标事件。
- selection/copy。
- Kitty keyboard。
- 复杂 renderable。
- textarea/input renderable。
- terminal dimensions hooks。
- external output passthrough。

相比 Ink：

- 更适合复杂布局和交互。
- 更接近 GUI app 的 retained UI 模型。
- 对高频局部更新更友好。

### 2. Prompt/Composer 能力上限更高

可实现：

- 多行 textarea。
- 文件/技能/agent mention extmark。
- 附件行。
- paste placeholder。
- rich autocomplete。
- stash/history。
- editor selection context。
- 鼠标点击定位。

这类能力在 Ink 中可以做，但维护成本会快速上升。

### 3. 插件化 TUI shell

参考 OpenCode，可设计：

- routes：插件增加页面。
- slots：插件往 sidebar/footer/status/activity 插内容。
- commands：插件注册命令。
- dialogs：插件打开标准弹窗。
- keybinds：插件注册快捷键。
- kv：插件保存 UI 本地状态。

这对后续生态和内部扩展有价值。

## 性能分析

### 优势

- 更细粒度 render 控制。
- 复杂 textarea/scrollbox 不需要用 React/Ink 手写补丁。
- 鼠标、selection、console copy 等能力是 renderer 原生考虑。
- 对长会话、多 panel、sidebar、live activity 更有优势。

### 仍需自行解决的问题

OpenTUI 不能自动解决：

- runtime 与 UI 耦合。
- session projection。
- tool display policy。
- streaming chunking。
- composer 业务状态机。
- Web UI/客户端协议复用。

因此即使切 OpenTUI，也必须先做 UI event protocol。

## 可扩展性分析

OpenTUI 适合做 terminal-first 平台：

```ts
interface TuiPlugin {
  name: string;
  routes?: TuiRoute[];
  commands?: TuiCommand[];
  slots?: TuiSlotContribution[];
  keybinds?: TuiKeybindContribution[];
  activate(ctx: TuiPluginContext): void | Promise<void>;
}
```

可扩展点：

- Home route
- Session sidebar
- Activity lane
- Footer/status
- Command palette
- Model/provider picker
- Tool detail renderer
- Approval/question prompt

但 Web UI 不能直接复用 OpenTUI components。真正能复用的仍是：

- plugin metadata
- commands
- event protocol
- view models
- tool display models

## 可维护性分析

### 正面

- Renderer 能力更完整，少写 terminal hack。
- Prompt、dialog、scroll、mouse、selection 有更合适的抽象。
- 插件边界更明确。

### 负面

- 引入 Solid 和 OpenTUI 两套新心智模型。
- 当前 React/Ink 组件基本需要重写。
- 与现有测试体系不兼容，需要重新搭建 renderer tests。
- OpenTUI 社区和生态相对 Ink 更小，版本风险更高。
- 如果 runtime/UI 协议没拆好，会把当前耦合问题搬到新框架里。

## 改造成本

| 模块 | 重写成本 | 说明 |
|---|---:|---|
| App shell/layout | 中 | provider/context/route 体系重建 |
| Conversation/transcript | 高 | scrollbox、height、markdown、tool render 都要重写 |
| Composer | 高 | textarea、completion、history、paste、queue |
| Dialog/overlay | 中 | 可借 OpenTUI 基础能力 |
| Theme/keybind | 中 | 可设计成长期资产 |
| Session/runtime bridge | 中 | 若事件协议已完成，成本下降 |
| Tests | 中到高 | 需要 snapshot/fixture 体系 |

整体风险高于 Ink 渐进改造。

## 与 Web UI/客户端的关系

OpenTUI 不应成为 Web UI 的上游。正确关系是平级 renderer：

```text
UiEvent / SessionViewModel
  ├─ Ink TUI
  ├─ OpenTUI TUI
  ├─ Web UI
  └─ Desktop Client
```

如果先重写 OpenTUI，再抽协议，会出现两个问题：

- Web UI 仍然无法复用 terminal 内部状态。
- OpenTUI renderer 会被迫承载 runtime orchestration，重蹈当前 `App.tsx` 的问题。

因此 OpenTUI 切换必须以后置方式推进：

1. 先抽协议。
2. 再做 OpenTUI renderer。
3. Ink 和 OpenTUI 并行验证。
4. 最后决定默认入口。

## 建议 PoC 范围

不要一上来重写完整 TUI。建议 PoC 只覆盖：

- session route
- transcript list
- live activity lane
- prompt/composer
- command palette
- approval/question dialog
- status/footer

不在 PoC 做：

- 完整插件系统。
- 全量主题市场。
- 所有历史 session 操作。
- 所有 tool renderer。
- 复杂 sidebar。

PoC 成功标准：

- 能消费与 Ink 相同的 `UiEvent` fixture。
- 能完成一轮 user -> assistant streaming -> tool -> approval -> final。
- 长输出性能明显好于 Ink。
- paste/multiline/completion 体验优于现状。
- 渲染 snapshot 可稳定。

## 迁移阶段

### Phase A：前置抽象

必须先完成：

- `UiEvent`
- `SessionViewModel`
- `CommandRegistry`
- `BlockingPrompt`
- `ToolDisplayModel`
- runtime bridge

这部分与 Ink 方案共享。

### Phase B：OpenTUI sandbox package

新增独立 package：

```text
packages/tui-opentui/
  src/main.tsx
  src/app.tsx
  src/context/
  src/routes/
  src/components/
  src/prompt/
  src/theme/
```

从一开始就避免依赖 Ink 内部类型。

### Phase C：Renderer parity

用同一组 fixture 对比：

- Ink transcript render。
- OpenTUI transcript render。
- Tool display。
- Approval/question flow。
- Composer key sequences。

### Phase D：双入口试运行

CLI 提供：

```bash
vera repl
vera repl --renderer ink
vera repl --renderer opentui
```

默认仍为 Ink，OpenTUI 作为实验入口。

### Phase E：默认切换决策

只有满足以下条件才切默认：

- OpenTUI 覆盖现有主要功能。
- 长会话和高频 streaming 性能明显更好。
- Web UI 已基于同一协议接入，不依赖 Ink。
- OpenTUI 的测试稳定。
- 团队能维护 Solid/OpenTUI 代码。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 重写周期过长 | 先做 PoC，不承诺默认切换 |
| 新框架学习成本高 | OpenTUI package 隔离，核心协议仍在 core |
| 与 Web UI 复用关系混乱 | 强制通过 event/view model 交互 |
| 测试不稳定 | fixture-based renderer parity tests |
| 功能回归 | Ink 与 OpenTUI 双入口并行 |
| OpenTUI 生态风险 | 保留 Ink renderer 直到稳定 |

## 什么时候该选择 OpenTUI

满足多数条件时再推进：

- 当前 Ink 在长会话下出现不可接受的性能问题。
- 需要 terminal mouse/selection/textarea/extmark 等高级交互。
- TUI 会变成独立产品级体验。
- UI 协议和 projection 已经完成。
- Web UI 不再依赖 TUI 内部实现。
- 有至少一个迭代周期可用于双 renderer 并行。

## 什么时候不该选择 OpenTUI

以下情况不建议：

- 只是想整理当前代码。
- Web UI/客户端接入更紧急。
- 当前团队没有维护 OpenTUI/Solid 的余量。
- UI 协议还没抽出来。
- 期望靠换 renderer 解决 runtime 耦合。

## 推荐判断

OpenTUI 是合理的中长期选项，但不是当前第一步。

当前第一步应该是：

```text
Ink TUI 内部重构 + UI event protocol + session projection
```

这一步完成后，OpenTUI 才会变成低风险的 renderer 替换，而不是高风险的全量重写。

