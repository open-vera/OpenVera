# Ink Evolution Plan

> Goal: Improve the modularity, testability, and performance of the Ink terminal UI through incremental evolution without rewriting the existing TUI.

## Current Architecture Pain Points

The existing Ink TUI has accumulated full functionality through multiple iterations, but also some structural challenges:

1. **Giant App component**: `App.tsx` is approximately 475 lines, concentrating too many responsibilities: resize monitoring, session lifecycle, streaming processing, Turn execution, input routing, Overlay management, Plan mode, etc.
2. **Ref waterfall**: 20+ `useRef` scattered throughout App, making data flow hard to trace
3. **Tightly coupled rendering**: `ConversationPanel` internally contains three responsibilities: Line Estimation, viewport clipping, and message rendering
4. **Incomplete event protocol**: some UI updates bypass `UiEvent` protocol and directly call `setMessages` / `setUsage`
5. **No unit tests**: Composer state machine and event projection have a few tests; most UI logic relies on manual verification

## Incremental Evolution Strategy

Principle: keep UI behavior unchanged with each change, only reorganize internal structure. Commit granularity is separated from feature changes.

### Phase 1: App Component Decomposition

Split `App.tsx` responsibilities into 3 custom Hooks, with App itself degraded to an orchestration layer (approximately 100 lines):

```typescript
// Before: App.tsx — 475 lines, 20+ refs
// After:

useTerminalDimensions() → { columns, rows }
useSessionBridge({ ctx, resumeSessionId }) → { loaded, error }
useTurnPipeline({ ctx, routing, viewModel }) → { handleSubmit, cancel, isStreaming }

function App({ ctx, resumeSessionId }) {
  const dims = useTerminalDimensions();
  const bridge = useSessionBridge({ ctx, resumeSessionId });
  const pipeline = useTurnPipeline({ ctx, routing: dims.routing, viewModel });
  // only responsible for JSX orchestration
  return (/* ... */);
}
```

Specific Hook responsibility assignments:

| Hook | Owns Refs | Exposes |
|---|---|---|
| `useTerminalDimensions` | stdout | `{ columns, rows }` |
| `useSessionBridge` | ctxRef, historyRef, compressionRef, memoryRef, projectContextRef | `{ loaded, error }` |
| `useTurnPipeline` | streamingBufferRef, thinkingBufferRef, rafRef, abortRef, costRef, turnCountRef, etc. | `{ handleSubmit, handleCancel, streamStatus }` |
| `useOverlayController` | dispatchOverlay | `{ overlay, openXxx, close }` |

### Phase 2: Promote Composer to Independent Module

Promote the pure function logic in `composerState.ts` to an independently testable module:

- **Input**: `(state: ComposerState, input: string, key: ComposerKeyState, history: string[])`
- **Output**: `{ state: ComposerState; effect?: ComposerEffect }`
- **100% pure function**: no dependency on React, Ink, or any side effects

Target coverage: Composer state machine >= 95% (branch coverage for all Ctrl+Key combinations, history navigation, completion selection).

Also promote `inputKeys.ts` to an independent module; the input encoding table can be directly used for testing.

### Phase 3: Formalize Event Protocol

Two state update paths currently exist:

1. `dispatchUiEvent(event)` → `projectUiEvent()` → ViewModel
2. `setMessages(fn)` / `setUsage(fn)` direct calls

Long-term approach: unify all ViewModel updates into the UiEvent protocol, eliminating direct setter calls. During the transition, retain setters but mark them `@deprecated`, auditing each call site for potential conversion to events.

#### New Event Types

```typescript
// Currently missing event types
| { type: "session.loaded"; sessionId: string; turnCount: number }
| { type: "session.error"; message: string }
| { type: "history.truncated"; removedCount: number }
| { type: "compression.triggered"; beforeTokens: number; afterTokens: number }
| { type: "cost.updated"; usd: number }
| { type: "routing.switched"; provider: string; model: string }
```

### Phase 4: Viewport Rendering Abstraction

Abstract `ConversationPanel`'s viewport logic into a generic Hook:

```typescript
function useViewportScrolling<T>({
  items: T[],
  estimateLines,    // (item: T) => number
  availableHeight,
}: ViewportConfig): ViewportResult<T> {
  // returns { visibleItems, hiddenAbove, scrollOffset, handleScroll }
}
```

`ConversationPanel` itself becomes a thin layer (approximately 80 lines), only responsible for message → JSX mapping.

### Phase 5: Performance Optimization

#### Reduce Ink Re-renders

- `ConversationPanel` uses `React.memo` + precise props comparison (avoids shallow comparison failures on identity-stable setters)
- `DiffView` already uses `memo` + `useMemo`, keep as-is
- Add `React.memo` to `ThinkingView`, `ToolResultView`
- Change scroll offset from `useState` to `useRef` (ref avoids extra renders for changes that don't affect the render tree)

#### ReplayBuffer Replaces setTimeout

Current streaming rendering uses `setTimeout` 56ms (~18fps) to batch increments:

```typescript
// Current
rafRef.current = setTimeout(() => { flush(); }, 56);

// Optimized
// Use requestAnimationFrame or microtask queue, aligned to terminal refresh rate
```

#### Virtual Scrolling

When messages exceed 200, enable virtual scrolling mode: only track estimated line heights, skip actual rendering, reducing Ink's React reconciliation overhead.

## Testing Strategy

### Testable Layers

| Layer | Test Method | Target Coverage |
|---|---|---|
| Composer state machine | Pure function unit test | >= 95% |
| UiEvent → ViewModel projection | Pure function unit test | >= 95% |
| Input key code parsing | Pure function unit test | >= 90% |
| Tool projection (toolUsesForDisplay) | Pure function unit test | >= 85% |
| Hook integration tests | React Testing Library | >= 70% |
| Render smoke tests | Ink `render()` + string snapshot | Critical paths |

### Non-testable Layers

- Visual appearance verification of Ink components (depends on terminal rendering, unsuitable for snapshot tests)
- Real TTY interaction (left for manual E2E verification)

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Hook decomposition breaks closure references | Medium | High (functional regression) | Strict Phase ordering, TTY smoke test at each step |
| Event protocol migration misses events | High | Medium (partial update loss) | Audit grep `setMessages\|setUsage\|setStreamStatus` to find all direct call sites |
| React.memo causes stale UI | Low | Medium | Only add memo to leaf components, keep App layer unmemoized |
| Virtual scrolling stutter | Medium | Low (UX degradation) | Set 200-entry threshold, disabled below threshold |

## Directions NOT to Evolve (Keep As-Is)

- **Ink version**: lock on Ink 5.x, do not chase major version upgrades (API is stable)
- **TSX approach**: do not migrate to string templates (e.g. `ink-template`), maintain JSX composability
- **Web replacement**: TUI and Web UI evolve independently, do not replace each other
