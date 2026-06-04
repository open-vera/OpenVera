# Ink 演进方案

> 目标：在不重写现有 TUI 的前提下，通过增量演进提升 Ink 终端的模块化、可测试性和性能。

## 当前架构痛点

现有 Ink TUI 经过多次迭代已具备完整功能，但也积累了一些结构性挑战：

1. **巨型 App 组件**：`App.tsx` 约 475 行，集中了尺寸监听、会话生命周期、流式处理、Turn 执行、输入路由、Overlay 管理、Plan 模式等过多职责
2. **Ref 瀑布**：20+ 个 `useRef` 分散在 App 中，数据流不易追踪
3. **紧耦合渲染**：`ConversationPanel` 内部包含 Line Estimation、视口裁剪、消息渲染三种职责
4. **事件协议不完整**：部分 UI 更新绕过 UiEvent 协议直接 `setMessages` / `setUsage`
5. **无单元测试**：Composer 状态机和事件投影有少量测试，大部分 UI 逻辑依赖手工验证

## 增量演进策略

原则：每次改动保持 UI 行为不变，仅重组内部结构。提交粒度与功能改动分离。

### Phase 1：App 组件拆分

将 `App.tsx` 的职责拆分为 3 个自定义 Hook，App 本身退化为编排层（约 100 行）：

```typescript
// 拆分前：App.tsx — 475 行，20+ refs
// 拆分后：

useTerminalDimensions() → { columns, rows }
useSessionBridge({ ctx, resumeSessionId }) → { loaded, error }
useTurnPipeline({ ctx, routing, viewModel }) → { handleSubmit, cancel, isStreaming }

function App({ ctx, resumeSessionId }) {
  const dims = useTerminalDimensions();
  const bridge = useSessionBridge({ ctx, resumeSessionId });
  const pipeline = useTurnPipeline({ ctx, routing: dims.routing, viewModel });
  // 仅负责 JSX 编排
  return (/* ... */);
}
```

具体 Hook 职责分配：

| Hook | 拥有 Ref | 对外暴露 |
|---|---|---|
| `useTerminalDimensions` | stdout | `{ columns, rows }` |
| `useSessionBridge` | ctxRef, historyRef, compressionRef, memoryRef, projectContextRef | `{ loaded, error }` |
| `useTurnPipeline` | streamingBufferRef, thinkingBufferRef, rafRef, abortRef, costRef, turnCountRef 等 | `{ handleSubmit, handleCancel, streamStatus }` |
| `useOverlayController` | dispatchOverlay | `{ overlay, openXxx, close }` |

### Phase 2：Composer 提升为独立模块

将 `composerState.ts` 中的纯函数逻辑提升为可独立测试的模块：

- **输入**：`(state: ComposerState, input: string, key: ComposerKeyState, history: string[])`
- **输出**：`{ state: ComposerState; effect?: ComposerEffect }`
- **100% 纯函数**：不依赖 React、Ink、或任何副作用

目标覆盖率：Composer 状态机 ≥ 95%（分支覆盖所有 Ctrk+Key 组合、历史导航、补全选择）。

同时将 `inputKeys.ts` 提升为独立模块，输入编码表可直接用于测试。

### Phase 3：事件协议严肃化

当前存在两条状态更新路径：

1. `dispatchUiEvent(event)` → `projectUiEvent()` → ViewModel
2. `setMessages(fn)` / `setUsage(fn)` 直接调用

长期方案：将所有 ViewModel 更新统一到 UiEvent 协议，消灭直接 setter 调用。过渡期保留 setter 但标记为 `@deprecated`，审计每个调用点是否可转为事件。

#### 新增事件类型

```typescript
// 当前缺失的事件类型
| { type: "session.loaded"; sessionId: string; turnCount: number }
| { type: "session.error"; message: string }
| { type: "history.truncated"; removedCount: number }
| { type: "compression.triggered"; beforeTokens: number; afterTokens: number }
| { type: "cost.updated"; usd: number }
| { type: "routing.switched"; provider: string; model: string }
```

### Phase 4：视口渲染抽象

将 `ConversationPanel` 的视口逻辑抽象为通用 Hook：

```typescript
function useViewportScrolling<T>({
  items: T[],
  estimateLines,    // (item: T) => number
  availableHeight,
}: ViewportConfig): ViewportResult<T> {
  // 返回 { visibleItems, hiddenAbove, scrollOffset, handleScroll }
}
```

`ConversationPanel` 自身变为薄层（约 80 行），仅负责消息 → JSX 映射。

### Phase 5：性能优化

#### 减少 Ink 重渲染

- `ConversationPanel` 使用 `React.memo` + 精确 props 比较（跳过 identity-stable setter 的浅比较失败）
- `DiffView` 已使用 `memo` + `useMemo`，保持
- `ThinkingView`、`ToolResultView` 添加 `React.memo`
- 滚动偏移量改为 `useRef` 而非 `useState`（不影响渲染树的变动用 ref 避免额外渲染）

#### ReplayBuffer 替代 setTimeout

当前流式渲染使用 `setTimeout` 56ms（~18fps）合并增量：

```typescript
// 当前
rafRef.current = setTimeout(() => { flush(); }, 56);

// 优化
// 使用 requestAnimationFrame 或微任务队列，对齐终端刷新率
```

#### Virtual Scrolling

当消息超过 200 条时启用虚拟滚动模式：仅跟踪预估行高，跳过实际 render，减少 Ink 的 React reconciliation 开销。

## 测试策略

### 可测试层

| 层 | 测试方式 | 目标覆盖率 |
|---|---|---|
| Composer 状态机 | 纯函数单元测试 | ≥ 95% |
| UiEvent → ViewModel 投影 | 纯函数单元测试 | ≥ 95% |
| 输入键码解析 | 纯函数单元测试 | ≥ 90% |
| Tool 投影（toolUsesForDisplay） | 纯函数单元测试 | ≥ 85% |
| Hook 集成测试 | React Testing Library | ≥ 70% |
| 渲染冒烟测试 | Ink `render()` + string snapshot | 关键路径 |

### 不测试层

- Ink 组件的外貌验证（依赖终端渲染，不适合快照测试）
- 真实 TTY 交互（留待 E2E 手工验证）

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Hook 拆分破坏闭包引用 | 中 | 高（功能回归） | 严格按 Phase 顺序，每步通过 TTY 冒烟测试 |
| 事件协议迁移遗漏事件 | 高 | 中（部分更新丢失） | 审计 grep `setMessages\|setUsage\|setStreamStatus` 找到所有直接调用点 |
| React.memo 导致过期 UI | 低 | 中 | 仅对叶子组件添加 memo，保持 App 层不 memo |
| Virtual scrolling stutter | 中 | 低（体验降级） | 设置 200 条阈值，低于阈值不启用 |

## 不演进的方向（保持现状）

- **Ink 版本**：锁定 Ink 5.x，不追大版本升级（API 稳定）
- **TSX 方案**：不迁移到字符串模板（如 `ink-template`），保持 JSX 可组合性
- **Web 替代方案**：TUI 和 Web UI 独立演进，不互相替代
