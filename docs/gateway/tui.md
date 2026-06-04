# TUI Overview

> Vera's terminal user interface is built with React + Ink, running in an interactive TTY, providing conversation panels, Diff display, Slash command system, and a complete terminal interaction experience.

## Architecture Overview

```
packages/core/src/repl/
  index.ts          ← startRepl() → Ink render(<App />) → waitUntilExit()
  context.ts        ← ReplContext (cwd, config, adapter, sessionStore...)
  commands/         ← 17 /slash commands, unified handleCommand routing
  ui/
    App.tsx             ← Root component, global state + Turn lifecycle
    ConversationPanel   ← Viewport-clipped conversation list + scroll anchoring
    InputBar            ← Line editor (cursor/history/completion/search/external editor)
    StatusBar           ← Breathing spinner + Token count
    OverlayHost         ← Overlay container (6 overlay types)
    DiffView / DiffDialog ← Syntax-level Diff (word-level highlighting + file list)
    SessionPicker       ← Interactive session restore (search/pagination/preview/branch compare)
    WelcomeScreen       ← Empty session welcome screen
    ToolResultView      ← Tool call result inline display
    SelectPrompt        ← Single/multi-select prompt (reused for Provider/Model picker)
    renderers/          ← Bash/Code/Error/FileList/Text
    AskUserQuestion/    ← Multi-select Q&A component
    controller/         ← Event projection, Turn lifecycle, routing, persistence
    hooks/              ← Streaming, session lifecycle, tool calls
    state/              ← Composer state machine, Overlay Reducer, queue, Turn Store
```

## REPL Loop Flow

### Startup Path

```text
startRepl(ctx)
  → assertInteractiveInput()           // check TTY
  → render(<App ctx={ctx} />)          // Ink mounts to terminal
  → waitUntilExit()                    // block until user exit()
```

### Main Loop: Full Lifecycle of One Turn

```text
User input → handleSubmit(line)
  │
  ├─ Slash Command → handleSlashCommandSubmission()
  │   └─ Directly manipulate UI state (setMessages / dispatchOverlay / exit)
  │
  └─ Normal message → Turn Pipeline
      ├─ 1. resolveTurnRouting()       → Intent classification + select Provider/Model
      ├─ 2. prepareTurnContext()       → Load history, Memory, ProjectContext
      ├─ 3. prepareTurnSetup()         → Assemble Prompt + Tools + toolCallHandler
      └─ 4. runPreparedTurn()
          ├─ Plan Mode                 → Multi-step plan + step visualization
          └─ Stream Mode               → streamAgent() LLM streaming call
```

### Task Queue

When `streamStatus !== "idle"`, input is automatically queued (enqueue), and StatusBar shows queue count. After streaming ends, useEffect auto-dequeues and executes:

```typescript
useEffect(() => {
  if (streamStatus !== "idle" || queue.items.length === 0) return;
  const next = dequeue();
  if (next) handleSubmit(next);
}, [streamStatus, queue.items.length]);
```

## Core Components

### App (Root Component)

`packages/core/src/repl/ui/App.tsx`

Global state management control center, using `useRef` to hold mutable state and avoid unnecessary re-renders:

| Ref | Purpose |
|---|---|
| `ctxRef` | ReplContext (config, adapter, sessionStore) |
| `streamingBufferRef` / `thinkingBufferRef` | Streaming text/Thinking incremental buffers |
| `historyRef` | LLM conversation history (Message[]) |
| `compressionStateRef` / `memoryTrackerRef` | Context compression + Memory extraction |
| `costRef` | Cumulative cost (tracked by Provider/Model) |
| `abortRef` | AbortController, for cancelling the current Turn |
| `planStepsRef` | Plan Mode step list |

Terminal size monitoring `stdout.on("resize")` → `columns × rows` → drives ConversationPanel viewport calculations.

### ConversationPanel

`packages/core/src/repl/ui/ConversationPanel.tsx`

Line-estimation-based viewport-clipped message list:

1. **Line Estimation**: `getEstimatedMessageLines()` estimates each message's line count based on text length, wrapWidth, Thinking/tool line count. Results cached in `heightCacheRef` (Map).
2. **Viewport Clipping**: Determines `[viewStart, viewEnd)` range based on `scrollOffset` and `availableHeight`, only renders visible messages. Hidden messages indicated by "↑ N messages hidden" hint.
3. **Scroll Anchoring**: When new content arrives, auto-increment `scrollOffset` to compensate, keeping user's visual position stable.
4. **Context Preservation**: When the viewport top is an assistant message, trace back to include the preceding user message, ensuring conversation continuity.

**Message render order**: Thinking block → Tool Uses → text content. User messages prefixed with green `>`, assistant messages prefixed with orange `●`. Plan Mode messages render step list (pending ○ / running ▶ / done ✓ / failed ✗).

### InputBar

`packages/core/src/repl/ui/InputBar.tsx`

Based on the `composerState` pure function state machine:

```
(input, key) → reduceComposerInput(composer, input, key, history)
  → { state: ComposerState, effect?: Effect }
    → onChange(value)                  // write back to React state
    → Effect triggered (submit/exit/cancel/scroll)
```

**Features**: cursor control (grapheme-aware, Ctrl+A/E, Meta+Arrow), editing (Ctrl+W delete word, Ctrl+U clear line, Ctrl+K delete to end of line), history navigation (↑↓ browse, Ctrl+R reverse search), completion (`/` command completion + Tab file path completion), external editor (Ctrl+X → `$VISUAL`/`$EDITOR` → backfill), IME/CJK compatibility.

**Dual-path input**: Ink `useInput()` handles steady-state input + synchronous `internal_eventEmitter.on("input")` covers the first keypress during mount window. `inkInputReadyRef` flag ensures no double parsing.

### StatusBar

`packages/core/src/repl/ui/StatusBar.tsx`

- **idle**: `⌥O` tool output collapse/expand hint
- **Scrolling**: yellow ↑ + scroll navigation
- **Active**: 8-frame brand orange breathing animation (120ms/frame) + elapsed time + input/output tokens + `esc to cancel` + queue count

### OverlayHost

`packages/core/src/repl/ui/OverlayHost.tsx`

Driven by `useReducer(reduceOverlay)` with 6 states:

| Overlay | Component | Description |
|---|---|---|
| `diff` | DiffDialog | Full-screen Git Diff viewer |
| `sessionPicker` | SessionPicker | Session restore (search/preview/branch compare) |
| `providerPicker` | SelectPrompt | Provider list selection |
| `modelPicker` | SelectPrompt | Model selection (grouped by Provider) |
| `prompt: question` | AskUserQuestion | Multi-select Q&A |
| `prompt: approval` | SelectPrompt | High-risk operation confirmation |

After switching, persists via `writeConfig()` and calls back App to update routing.

### DiffView

`packages/core/src/repl/ui/DiffView.tsx`

Uses `diffWordsWithSpace` for word-level syntax highlighting:

- Adjacent deletion+addition lines with change ratio ≤ 40% get word-level coloring
- Deleted lines: red background + red text; added lines: green background + green text
- dim mode for historical Diff (lowered brightness)
- DiffDialog: file list view (↑↓ navigate, Enter expand details, esc/q back)

### SessionPicker

`packages/core/src/repl/ui/SessionPicker.tsx`

Interactive session restore panel:

- **Paginated loading**: `listSessionsPaged()` paging, auto-load more near bottom
- **Full-text search**: `/` enters search mode, supports `branch:` `tag:` `cost>` `cost<` `after:` `before:` filters, full scan during search
- **Session preview**: reuses ConversationPanel to render conversation preview (12-line viewport + scrolling)
- **Branch comparison**: `listBranches()` shows branch tree for the same parent
- **Keyboard navigation**: ↑↓ select, PgUp/PgDn page, u/d scroll preview, o expand tools, b branch compare, Enter restore, esc close

## Theme System

`packages/core/src/repl/ui/theme.ts`

Dark theme palette, all colors defined as semantic-named CSS RGB strings:

### Semantic Color Tokens

| Token | RGB | Usage |
|---|---|---|
| `brand` | `(215,119,87)` | Brand orange — assistant message prefix, input prompt |
| `brandShimmer` | `(235,159,127)` | Brand light orange — queued messages |
| `success` | `(78,186,101)` | Success green — user message prefix, tool OK |
| `error` | `(255,107,128)` | Error red — failure markers |
| `warning` | `(255,193,7)` | Warning yellow — queue marker, scroll hint |
| `suggestion` | `(177,185,249)` | Blue-purple — completion suggestions, Plan header |
| `text` | `(255,255,255)` | Primary text (white) |
| `textDim` | `(153,153,153)` | Secondary text (gray) |
| `textSubtle` | `(80,80,80)` | Subtle text (dark gray) — dividers |

### Domain Colors

**Diff**: `diffAddedBg (34,92,43)` / `diffAddedWord (56,166,96)` green scheme, `diffRemovedBg (122,41,54)` / `diffRemovedWord (179,89,107)` red scheme, `diffHunk (100,149,237)` cornflower blue.

**Plan Step**: pending `textDim`, running `suggestion`, done `success`, failed `error`.

**Spinner**: `spinnerFrames` 8 frames of brand orange from dark→light→dark, simulating breathing pulse.

**Tool**: `toolName` (orange), `toolLabel` (gray), `toolOk` (green), `toolError` (red).

**Thinking**: `thinkingText (120,120,120)` / `thinkingLabel (100,100,100)` low-contrast gray.

## State Management

### UiEvent Protocol

All UI changes are driven through a unified event protocol, not direct setState:

```typescript
type UiEvent =
  | { type: "user.submitted"; text: string }
  | { type: "assistant.started" | "assistant.delta" | "assistant.completed" | "assistant.failed" }
  | { type: "assistant.thinking.delta" | "assistant.thinking.updated" }
  | { type: "tool.started" | "tool.output" | "tool.completed" }
  | { type: "status.changed"; status: StreamStatus }
  | { type: "usage.updated"; usage: Partial<TokenUsage> }
```

`dispatchUiEvent(event)` → `projectUiEvent(viewModel, event)` → new `ReplViewModel`:

```
ReplViewModel { messages, status, usage, activeTurn }
```

- **activeTurn** maintained by `reduceActiveTurn()` pure function (streaming text + Thinking + tool list + Tokens)
- **messages** archived on `assistant.completed` (merge thinking + toolUses + content)
- **usage** accumulated (inputTotal / outputTotal / cacheWriteTotal / cacheReadTotal / costUsd)

### State Modules

| Module | Responsibility |
|---|---|
| `composerState` | InputBar editor state machine, pure function reduce |
| `turnStore` | ActiveTurn reducer, responds to UiEvent |
| `overlayStore` | Overlay Action/Reducer |
| `queueState` | Input queue (FIFO + prepend) |
| `reverseSearch` | Ctrl+R reverse search state |
| `blockingPrompt` | Blocking Prompt type definitions |

## Input Parsing

`packages/core/src/repl/ui/inputKeys.ts`

Custom ANSI parser `parseInputChunk(rawChunk) → { input, key }`, compatible with Ink protocol:

- **Filtering**: Focus Event, SGR Mouse, X10 Mouse control sequences
- **Special keys**: ANSI Arrow / Page / Return / Escape / Tab / Backspace / Delete → key flags
- **Modifier keys**: Ctrl+letter (`\x01`~`\x1a`), Meta+char (`\x1b`+char), Shift (uppercase)
- **Denoising**: `parseInputKey()` returns only key flags

## Rendering Pipeline

`packages/core/src/repl/ui/renderers/` provides 5 content renderers:

| Renderer | Description |
|---|---|
| `BashOutputView` | ANSI color-parsed shell output |
| `CodeView` | Syntax-highlighted code blocks |
| `ErrorView` | Structured error display |
| `FileListView` | File change/search result list |
| `TextView` | Plain text (with truncation) |

`ToolResultView` is inline-embedded in ConversationPanel, controlled by `toolUsesForDisplay()` strategy: default collapsed showing tool name + first line result; `⌥O` globally expands to show full parameters and output.

## Command System

17 Slash commands, unified `handleSlashCommandSubmission()` dispatch, signature `(args[], ctx) => Promise<void>`:

| Command | Description | Overlay |
|---|---|---|
| `/help` | All commands and descriptions | — |
| `/model` | View/switch model | modelPicker |
| `/provider` | View/switch Provider | providerPicker |
| `/sessions` | Historical session summary | — |
| `/resume` | Open session picker | sessionPicker |
| `/branch` / `/branches` | Create/list branches | — |
| `/switch` / `/adopt` / `/drop` / `/merge` | Branch operations | — |
| `/title` / `/metadata` | Session metadata | — |
| `/transcript` / `/sub` / `/subjobs` | Export/sub-agent | — |
| `/try <text>` | Non-streaming quick execution | — |
