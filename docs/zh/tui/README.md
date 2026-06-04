# TUI 方案调研与改造路线

本文档汇总 `references/hermes-agent`、`references/opencode`、`references/codex` 的 TUI 方案，并给出 Vera 后续 TUI/Web UI/客户端统一接入的架构路线。

## 结论

短期不建议立刻把现有 Ink TUI 全量替换成 OpenTUI。更稳妥的路线是：

1. 先把当前 `packages/core/src/repl/ui` 改造成事件驱动、状态分层、可测试的 TUI 架构。
2. 同时把 agent runtime 与 UI 表现层之间的协议抽出来，形成 UI-neutral event model。
3. Web UI 和桌面/客户端后续都复用这套事件协议与会话投影，而不是复用 Ink 组件。
4. 等事件协议、composer 状态机、session projection 稳定后，再评估是否把 terminal renderer 从 Ink 切到 OpenTUI。

核心判断：**真正要先抽的是 UI 协议和状态模型，不是先换渲染框架。**

## 参考项目要点

### Hermes Agent

Hermes 的 `ui-tui` 与我们最接近，都是 TypeScript + React/Ink。

关键设计：

- TUI 通过 JSON-RPC gateway 与后端交互，Python 负责 session、工具、模型调用，Ink 只负责显示和输入。
- UI 内部拆出 `turnStore`、`uiStore`、`overlayStore`、`useComposerState`、`useInputHandlers`。
- 有虚拟历史、滚动高度缓存、terminal parity、bracketed paste、OSC 52、completion、prompt flows。
- 事件面清晰：`message.delta`、`tool.start`、`tool.complete`、`approval.request`、`clarify.request` 等。

适合借鉴：

- 在不换框架的情况下拆分当前 `App.tsx`。
- 建立 UI-neutral event stream。
- 将 blocking prompt、approval、session picker、queue、completion 统一成 overlay/composer 状态。

### OpenCode

OpenCode 的 TUI 基于 `@opentui/core` 和 `@opentui/solid`，目标是高性能、强交互、插件化 terminal shell。

关键设计：

- 使用 OpenTUI renderer，支持 mouse、Kitty keyboard、selection、console copy、60fps。
- TUI 是可扩展平台：route、slot、command、dialog、theme、keybind 都是上下文服务。
- Prompt/composer 使用 `TextareaRenderable`，支持附件、extmark、autocomplete、stash、history、editor selection。
- Session 页面通过 SDK/sync/event context 获取数据，UI 不直接绑定模型调用。

适合借鉴：

- 插件 API：commands、routes、slots、dialogs。
- 统一主题和 keybind 系统。
- Prompt 作为可扩展组件，而不是简单 input bar。

不适合现在直接迁移的原因：

- 框架替换成本高，Solid/OpenTUI 心智模型和 Ink 完全不同。
- 当前核心复杂度在 runtime/UI 状态耦合，换 renderer 不能自动解决。
- Web UI 和客户端更需要统一协议，不需要共享 terminal renderer。

### Codex

Codex 的 TUI 是 Rust + ratatui/crossterm，工程化和可靠性最好。

关键设计：

- 显式 `AppEvent` 总线，组件通过事件请求 app 层动作。
- `ChatComposer` 是完整状态机，覆盖 slash/file/skill popup、history、reverse search、paste burst、附件。
- adaptive stream chunking：平滑输出与 catch-up 模式，避免 burst 输出造成 UI 延迟。
- alternate screen 策略可配置，兼容 Zellij 等 multiplexer。
- 大量 snapshot tests 覆盖 markdown、diff、history cell、resume picker、status widget。

适合借鉴：

- AppEvent 总线。
- Composer 状态机和 paste-burst。
- 流式输出调度策略。
- 渲染 snapshot 测试。

## 当前 Vera TUI 的主要问题

当前入口集中在：

- `packages/core/src/repl/ui/App.tsx`
- `packages/core/src/repl/ui/InputBar.tsx`
- `packages/core/src/repl/ui/ConversationPanel.tsx`
- `packages/core/src/repl/ui/ToolResultView.tsx`

主要问题：

- `App.tsx` 同时处理 session、routing、context injection、memory、streaming、tool call、plan mode、overlay、render state，难以维护。
- `InputBar.tsx` 已经手写按键解析，但缺少明确 composer 状态机，后续 multiline、paste、completion、外部编辑器会越来越难加。
- `ConversationPanel.tsx` 使用估算行数做虚拟化，按字符串长度 wrap，对 CJK、emoji、ANSI、markdown、diff 不够稳。
- 工具输出、streaming assistant、activity lane 混在 transcript 中，流式期间容易重排。
- UI 状态与 agent runtime 强耦合，不利于 Web UI、桌面客户端、远程 session viewer 复用。

## 目标架构

后续应形成四层：

```text
Agent Runtime / Harness Runtime
  produces
UI Event Protocol
  projects into
Session View Model / TUI Store / Web Store
  rendered by
Ink TUI / OpenTUI TUI / Web UI / Desktop Client
```

核心原则：

- runtime 不知道 Ink/OpenTUI/Vue/Electron。
- UI renderer 不直接拼 agent loop 的复杂参数。
- 所有 UI 都消费同一套 event protocol 或 session projection。
- TUI 的输入行为由 composer state machine 管理，输出行为由 transcript/activity projection 管理。
- Web UI 和客户端共享协议、类型和投影逻辑，不共享 terminal 专用组件。

## 两条方案

| 方案 | 说明 | 推荐度 |
|---|---|---|
| [基于现有 Ink 的渐进改造](./ink-evolution.md) | 保留 Ink，重构状态、事件、composer、渲染和测试 | 短期推荐 |
| [彻底切换到 OpenTUI](./opentui-rewrite.md) | 用 OpenTUI/Solid 重写 terminal renderer，并建设插件化 TUI shell | 中长期备选 |

## 决策矩阵

| 维度 | Ink 渐进改造 | OpenTUI 重构 |
|---|---:|---:|
| 性能上限 | 中 | 高 |
| 当前改造成本 | 低到中 | 高 |
| 风险 | 低 | 高 |
| 可维护性提升 | 高 | 中到高 |
| 可扩展性 | 中到高 | 高 |
| Web UI 复用 | 高，前提是先抽协议 | 高，前提也是先抽协议 |
| 客户端复用 | 高，前提是先抽协议 | 高，前提也是先抽协议 |
| 团队学习成本 | 低 | 高 |
| 短期交付速度 | 快 | 慢 |
| 终端交互能力 | 中 | 高 |

关键结论：

- 如果目标是快速改善稳定性、接入 Web UI、降低维护成本，选 Ink 渐进改造。
- 如果目标是做极致 terminal product、强鼠标/selection/extmark/plugin shell，OpenTUI 更合适。
- 两条路线共同前置工作都是：**UI event protocol、session projection、composer state machine**。

## 推荐阶段计划

### Phase 0：协议与边界

- 定义 `ReplEvent` / `UiEvent` 类型。
- 将 streaming、tool、approval、question、status、usage 都转成事件。
- 新增 session view model projector。
- `App.tsx` 改成订阅 view model，而不是直接处理全部业务。

### Phase 1：Ink TUI 内部重构

- 拆出 `turnStore`、`overlayStore`、`composerState`、`useReplController`。
- `InputBar` 升级为 composer 状态机。
- `ConversationPanel` 改用更准确的 width/wrap/height 计算。
- activity lane 与 transcript 分离。

### Phase 2：Web UI/客户端接入

- Web UI 消费同一套 session projection。
- 服务端通过 SSE/WebSocket 推送 UI events。
- 客户端只负责 local input、approval、file attachment、render。

### Phase 3：OpenTUI PoC

- 在协议稳定后实现最小 OpenTUI renderer。
- 只覆盖 session page、prompt、tool list、approval dialog、theme/keybind。
- 与 Ink TUI 并行一段时间，用相同测试 fixture 对比。

### Phase 4：是否切换默认 TUI

根据以下指标决策：

- Ink 在长会话和高频流式输出下是否仍有明显性能瓶颈。
- OpenTUI renderer 是否能覆盖现有功能并显著改善交互。
- Web UI/客户端是否已不依赖 Ink 内部状态。
- 团队是否能承担 Solid/OpenTUI 维护成本。

## 建议先做的 P0 工作

1. 新建 `packages/core/src/repl/ui/events.ts`，定义 UI 事件协议。
2. 新建 `packages/core/src/repl/ui/state/turnStore.ts`，承载当前流式 turn。
3. 新建 `packages/core/src/repl/ui/state/overlayStore.ts`，统一 diff/session/approval/question。
4. 新建 `packages/core/src/repl/ui/state/composerState.ts`，把 `InputBar` 的编辑逻辑迁出组件。
5. 新建 `packages/core/src/repl/ui/useReplController.ts`，从 `App.tsx` 搬出 runtime orchestration。
6. 为 composer 和 event projector 增加 Vitest 单测。

## 当前实现进度

已完成：

- `ui/events.ts`：已建立 `UiEvent` 和 `ReplViewModel`。
- `controller/eventProjector.ts`、`controller/useReplViewModel.ts`：stream/status/usage/tool 事件已投影到 view model。
- `state/turnStore.ts`：active turn 已承载 live assistant text、tool uses、output tokens、turn status。
- `ActivityLane.tsx`：当前 turn 的活动与 transcript 分离显示。
- `state/blockingPrompt.ts`、`state/overlayStore.ts`、`OverlayHost.tsx`：diff、session picker、path approval、ask-user-question 已统一为 overlay + `BlockingPrompt` 协议。
- `state/composerState.ts`：`InputBar` 的 grapheme 光标、word 移动、history、slash completion、Ctrl 快捷键、submit/cancel/scroll effects、基础 multiline/paste、path completion 算法已进入纯状态机。
- `inputKeys.ts`：`InputBar` 和 `SessionPicker` 已共享 raw terminal input parser。
- `commands/metadata.ts`：slash command 元数据已独立，completion 和 App command 分发表面可共享。
- `controller/slashCommands.ts`、`controller/commandSubmission.ts`、`controller/commandCapture.ts`、`controller/errorFormatting.ts`、`controller/turnContext.ts`、`controller/turnContextRuntime.ts`、`controller/turnSetup.ts`、`controller/runtimeBridge.ts`：App 中的 slash command parsing/submission、runtime command capture、错误格式化、memory/project context 准备、memory/context options、turn tool/system setup、stream/plan runtime bridge 已拆成可测试 helper。
- `controller/routing.ts`：routing/classifier provider/model 选择、classifier usage 回调、失败 fallback 已从 `App.tsx` 抽成 controller helper。
- `controller/sessionTitle.ts`、`controller/turnPersistence.ts`、`controller/turnUsage.ts`：AI title 状态机、assistant turn/session end 持久化、turn usage 累加已从 `App.tsx` 抽成可测试 helper。
- `controller/turnLifecycle.ts`：routing fallback UI、plan placeholder、plan summary、plan error/abort message reduction 已从 `App.tsx` 抽成纯 helper。
- `controller/turnRunner.ts`：plan/stream runtime orchestration 已从 `App.tsx` 收敛，统一处理 plan/stream 选择、UI lifecycle、runtime bridge 调用、成功/错误持久化、AI title 回调和 abort cleanup。
- `controller/toolProjection.ts`：工具展示模型、低信号工具压缩、read/search/list 分组已从渲染组件抽离。
- `controller/transcriptLayout.ts`：message height cache、CJK/emoji display-width wrap 估算已抽成纯模块并接入 `ConversationPanel`。
- `state/queueState.ts`、`state/reverseSearch.ts`、`state/externalEditor.ts`：pending queue、reverse search、external editor roundtrip 的纯状态/协议层已建立；reverse search、path completion、external editor trigger 已接入 `InputBar`。
- `controller/pathCompletion.ts`：已接入受限深度/数量的文件系统候选扫描，忽略 `.git`、`node_modules`、构建产物等高成本目录，并通过挂载后懒调度向 `WelcomeScreen`/主输入栏提供真实 path candidates，避免首帧 render 同步扫目录。
- `controller/externalEditorRuntime.ts`：已接入 `$VISUAL`/`$EDITOR` 临时文件 roundtrip，`Ctrl+X` 可打开外部编辑器并把结果回写 composer。
- `controller/useReplController.ts`：已建立聚合 view model、overlay、queue 的 controller 壳层，并暴露 queue enqueue/prepend/dequeue/update/remove/clear；queue controller 已使用内部同步状态，避免依赖 React state updater 返回值处理 dequeue。
- `hooks/usePlanRunner.ts`：plan step text flush 调度已可注入，便于后续统一 streaming/plan 的高频 UI 更新调度。
- `/queue` UI command：已支持 `/queue`、`/queue drop <n>`、`/queue edit <n> <new input>`、`/queue clear`，pending queue 显示编号，便于流式期间管理排队输入。
- 已补充 TUI/REPL 相关单测：event projector、turn store、activity lane、blocking prompt、overlay store、composer state、input keys、slash commands、command submission、command capture、error formatting、turn context、turn context runtime、turn setup、turn lifecycle、turn runner、routing、session title、turn persistence、turn usage、runtime bridge、tool projection、transcript layout、queue state、reverse search、external editor、path completion、command metadata。

仍未完成：

- `App.tsx` 尚未完全切到 `useReplController`，仍直接编排 routing/context/tool setup wiring 和部分 session lifecycle。
- composer 仍是单行显示模型叠加换行符展示，尚未实现完整 textarea、多行光标定位和选择区域。
- transcript 还缺 ANSI/markdown/diff snapshot render tests，以及更完整的虚拟化策略。
