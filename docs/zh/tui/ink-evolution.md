# 基于现有 Ink 的渐进改造方案

本文档描述在保留 `ink + react` 技术栈的前提下，如何改造当前 Vera TUI，使其具备更好的性能、扩展性、可维护性，并为 Web UI 和客户端接入打基础。

## 适用场景

选择该方案的前提：

- 希望短期内改善当前 REPL/TUI 质量。
- 不希望引入大规模 renderer 迁移风险。
- 后续 Web UI 和客户端需要复用 runtime/session 能力。
- 团队希望继续使用 React 心智模型。

该方案不是简单修 UI，而是把当前 TUI 改造成：

```text
event-driven controller + state stores + render-only components
```

## 当前结构问题

当前 `packages/core/src/repl/ui/App.tsx` 同时承担：

- session lifecycle
- routing/classifier
- model/provider selection
- memory/project context injection
- dynamic context compression
- tool schema composition
- subagent/ask-user-question tool wiring
- tool call approval and path confirmation
- plan mode execution
- streaming mode execution
- usage/cost accumulation
- pending queue
- overlays
- layout/render

这会导致：

- 单文件复杂度过高。
- 新增 UI 状态时只能继续加 `useState/useRef`。
- Web UI 无法复用这些逻辑。
- 测试只能绕过或浅测 hook。
- 输入、输出、工具、session 的边界不清晰。

## 目标结构

建议重构为：

```text
packages/core/src/repl/ui/
  App.tsx
  events.ts
  controller/
    useReplController.ts
    eventProjector.ts
    runtimeBridge.ts
  state/
    composerState.ts
    turnStore.ts
    overlayStore.ts
    sessionView.ts
  components/
    TranscriptView.tsx
    ActivityLane.tsx
    Composer.tsx
    OverlayHost.tsx
    StatusLine.tsx
```

### App.tsx

只负责：

- 初始化 controller。
- 布局。
- 把 state 传给 render components。
- 处理顶层 exit。

不再直接做 agent loop orchestration。

### runtimeBridge

负责把当前 `streamAgent`、`planExecutor`、`toolCallHandler` 包装成 UI 事件。

示例事件：

```ts
type UiEvent =
  | { type: "session.loaded"; sessionId: string }
  | { type: "user.submitted"; text: string }
  | { type: "assistant.started"; turnId: string }
  | { type: "assistant.delta"; turnId: string; text: string }
  | { type: "assistant.completed"; turnId: string; text: string }
  | { type: "tool.started"; turnId: string; toolId: string; name: string; args: unknown }
  | { type: "tool.completed"; turnId: string; toolId: string; result: unknown }
  | { type: "approval.requested"; requestId: string; message: string }
  | { type: "question.requested"; requestId: string; payload: unknown }
  | { type: "usage.updated"; usage: unknown }
  | { type: "status.updated"; status: string };
```

Web UI 和客户端后续可以直接消费同类事件。

### eventProjector

负责把事件投影成 UI state：

- transcript messages
- current turn state
- activity lane
- overlay state
- usage/cost status
- pending queue

重点：projection 是纯函数或接近纯函数，方便测试。

### turnStore

承载当前 active turn：

- streaming text buffer
- stream segments
- active tools
- completed tools
- reasoning/thinking text
- todos/subagents
- output tokens
- status

这参考 Hermes 的 `turnStore` 和 Codex 的 `AppEvent` 思路。

### composerState

把 `InputBar.tsx` 中的编辑行为迁出组件。

应覆盖：

- plain typing
- grapheme cursor movement
- word movement
- history navigation
- reverse search
- multiline
- slash command completion
- path completion
- queue editing
- paste
- paste-burst
- external editor roundtrip

组件只负责渲染 input、cursor、completion popup。

### overlayStore

统一管理：

- diff dialog
- session picker
- path approval
- ask user question
- command palette
- model picker
- provider picker
- help/status panels

避免在 `App.tsx` 中继续增加多个互斥 `useState`。

## 性能改进

### 1. 流式输出调度

当前 `useStreamingHelpers` 使用 16ms flush，所有 delta 直接拼进 React state。

建议引入 Codex 类似的 chunking 策略：

- smooth mode：小输出按固定 cadence 刷新。
- catch-up mode：积压过多时快速 drain。
- hysteresis：避免 smooth/catch-up 高频切换。

收益：

- 长输出更少卡顿。
- burst 输出更低延迟。
- React render 次数可控。

### 2. Transcript 与 live activity 分离

当前 tool uses 会进入 assistant message，流式期间更新会导致 transcript 重排。

建议：

- active turn 的工具、reasoning、status 放到 `ActivityLane`。
- turn 完成后再归档到 transcript。
- transcript 历史尽量静态。

收益：

- 减少历史区重渲染。
- 用户更容易看当前正在发生什么。
- 后续 Web UI 也能复用 activity projection。

### 3. 更准确的高度/换行计算

当前 `ConversationPanel` 按 `rawLine.length / wrapWidth` 估算行数。

改进：

- 使用 `string-width` 计算显示宽度。
- 对 ANSI、CJK、emoji、combining chars 做统一处理。
- 为 message 建立 height cache，key 包含 `messageId + width + detailMode`。
- 只完整渲染尾部 N 条，历史用估算高度。

收益：

- 滚动更稳。
- 宽字符不会错位。
- 长会话性能更好。

### 4. Tool 输出 compact policy

保留当前 `ToolResultView` 的 renderHint 分发，但进一步拆成：

- `toolProjection.ts`：工具事件到显示模型。
- `toolCompaction.ts`：低信号工具合并、read/search/list 分组。
- `renderers/*`：纯渲染。

收益：

- Web UI 可复用 tool projection。
- 不同 renderer 可以用不同视觉组件，但共享展示策略。

## 可扩展性改进

### 1. Command registry

当前 slash commands 分散在 `InputBar.tsx`、`commands/index.ts` 和 `App.tsx`。

建议统一为：

```ts
interface UiCommand {
  name: string;
  aliases?: string[];
  description: string;
  category: string;
  available?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, args: string[]) => Promise<void>;
}
```

用途：

- slash completion
- command palette
- help
- keybind
- plugin command
- Web UI command menu

### 2. Prompt/approval flows 协议化

当前 path confirm、ask-user-question 是 UI 内部状态。

建议改成统一 `blockingPrompt`：

```ts
type BlockingPrompt =
  | { kind: "approval"; requestId: string; title: string; options: ApprovalOption[] }
  | { kind: "question"; requestId: string; questions: QuestionSpec[] }
  | { kind: "secret"; requestId: string; prompt: string }
  | { kind: "select"; requestId: string; title: string; options: SelectOption[] };
```

Web UI、TUI、客户端都能用不同组件渲染同一种 prompt。

### 3. Theme/keybind 配置

短期保留当前 `theme.ts`，但改为 token 化：

- semantic color tokens
- detail mode
- compact mode
- keybind map

避免颜色和快捷键写死在组件中。

## 可维护性改进

### 1. 业务逻辑从 React 组件迁出

目标：

- React components 不直接调用 agent loop。
- hooks 不持有大批跨领域 refs。
- controller 负责 side effects。
- projector 负责 state transition。
- components 负责 render。

### 2. 单测优先覆盖状态机

新增测试：

- composer key sequence
- paste/multiline
- slash/path completion
- queue editing
- event projection
- tool compaction
- transcript wrapping

Snapshot 测试：

- diff render
- bash output render
- grouped tool render
- approval/question prompt render
- session picker render

### 3. 保持 renderer 可替换

Ink 组件不要成为核心类型。

核心类型应放在：

- `ui/events.ts`
- `ui/view-model.ts`
- `ui/projection.ts`

Ink/OpenTUI/Web 只消费 view model。

## 改造成本

| 阶段 | 成本 | 风险 | 收益 |
|---|---:|---:|---|
| 抽事件协议 | 中 | 中 | 高 |
| 拆 App.tsx | 中 | 中 | 高 |
| composer 状态机 | 中 | 中 | 高 |
| transcript height cache | 中 | 中 | 中 |
| activity lane | 低到中 | 低 | 中 |
| snapshot tests | 低 | 低 | 高 |

总体成本低于 OpenTUI 重写，且每一步都能独立交付。

## 对 Web UI/客户端的支持

Ink 演进方案对 Web UI 的关键价值不是复用 Ink，而是复用：

- event protocol
- session projection
- command registry
- blocking prompt spec
- tool display model
- usage/cost/status model

Web UI 接入方式：

```text
runtime emits UiEvent
  -> server persists event/session entries
  -> SSE/WebSocket pushes events
  -> web client runs same projector
  -> Vue/React/Svelte renders web components
```

桌面/客户端接入方式：

```text
client owns local input/editor/attachments
  -> sends UserAction
  -> receives UiEvent
  -> renders native/web/terminal UI
```

因此该方案不会阻碍未来换 renderer，反而是换 renderer 的前置条件。

## 里程碑

### M1：可测试事件层

- 定义 `UiEvent`。
- 添加 event projector。
- streaming/tool/usage 先接入事件。
- `App.tsx` 仍可保留大部分逻辑，但输出走 projection。

### M2：状态拆分

- `turnStore`
- `overlayStore`
- `composerState`
- `useReplController`

### M3：Composer v2

- multiline
- paste-burst
- slash/path completion
- history search
- queue editing

### M4：Transcript v2

- activity lane
- height cache
- better wrapping
- snapshot tests

### M5：Web UI bridge

- SSE/WebSocket event stream。
- Web client 复用 projection。
- Tool/status/approval/question 首批组件。

