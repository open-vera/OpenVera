# Context Compression System Design

> Package: `@open-vera/core` | Source: `packages/core/src/context/`
> Last updated: 2026-06-04

## Overview

Vera's context compression system manages the size of LLM conversation history to keep it within model context window limits while preserving as much critical information as possible. The system employs a **three-layer defense** strategy: from lightweight sliding window trimming, to LLM-driven progressive summarization compression, to purely heuristic micro-compaction cleanup — each layer serving a distinct role.

## Why Compression Is Needed

1. **Token cost**: Each API call is billed by token; longer history means higher cost. Compression can reduce token consumption for early turns by over 90%.
2. **Context window limits**: Mainstream models have finite windows (Claude 200K, GPT-4o 128K, Gemini 1M). Exceeding the limit causes the API to reject the request outright.
3. **Response quality**: Excessively long contexts dilute model attention, causing "lost in the middle" — the model ignores information from middle turns.
4. **Prompt cache invalidation**: Anthropic's prompt cache rebuilds when message structure changes, adding latency. Compression reduces message count, indirectly improving cache hit rates.

## Three-Layer Architecture Overview

```
Context growth direction ------------------------------------>

[Layer 1] Sliding Window Trimming (window.ts)
  |  Token estimation -> exceeds 75% budget -> drop oldest turns
  |  Always preserve: messages[0] (task definition, must not be lost)
  |  Minimum preserved: 6 most recent turns
  |  Cost: 0 tokens (pure local computation)
  v
[Layer 2] Progressive Compression (compression.ts)
  |  Token estimation -> exceeds triggerTokens -> LLM summarizes oldest turns
  |  Output: structured summary + decisions/findings/pending + topic tags
  |  Summary message injected at context start, replacing compressed original turns
  |  Cost: one small model API call (~1K input + 2K output tokens)
  v
[Layer 3] Micro-Compact (compression.ts -> microCompact)
  |  Time gap detection -> clear old tool_result content
  |  Preserve the most recent N tool results in full
  |  Cost: 0 tokens (pure heuristic, no LLM call)
  v
[Emergency Layer] Reactive Compression (compression.ts -> isPromptTooLongError)
  |  Catch API "prompt too long" errors
  |  Aggressive compression (fewer turns preserved, smaller thresholds)
  |  Max 3 retries, then throw original error (circuit breaker)
```

### Execution Order

At the start of each agent loop turn, context transformations are applied in this order:

```
User message -> [Progressive Compression] -> [Tool Budget Replay] -> [Micro-Compact] -> [Sliding Window Trim] -> API Call
```

See `packages/core/src/agent/loop.ts` functions `prepareMessages()` and `applyProactiveCompress()`.

---

## Layer 1: Sliding Window Trimming

**File**: `window.ts`

Core principle: **The first message (task definition) is never discarded**. Losing it means the model loses memory of the original goal — the most fatal error in any trimming strategy.

### How It Works

```typescript
function trimToWindow(messages, options) {
  const budget = maxTokens * targetUtilization; // default 75%
  if (estimateMessageTokens(messages) <= budget) return messages;

  // Find "turn" boundaries by user message positions
  const turnStarts = findTurnStarts(messages);

  // Drop from turn 2, preserving the most recent keepRecentTurns
  for (let drop = 1; drop <= maxDrop; drop++) {
    const anchor = messages[0]; // task definition
    const rest = messages.slice(turnStarts[drop]);
    const trimmed = [anchor, ...rest];
    if (estimateMessageTokens(trimmed) <= budget) return trimmed;
  }
}
```

### Configuration

| Parameter | Default | Description |
|---|---|---|
| `maxTokens` | Model limit | Resolved from `MODEL_CONTEXT_LIMITS` lookup table |
| `targetUtilization` | `0.75` | Target utilization (trims at 75% of window) |
| `keepRecentTurns` | `6` | Minimum recent turns to preserve |

### Model Context Window Mapping

The system has a built-in `MODEL_CONTEXT_LIMITS` lookup table:

| Model Prefix | Context Window |
|---|---|
| `claude-*` | 200,000 |
| `gpt-*` / `o1` / `o3` | 128,000 |
| `gemini-*` | 1,000,000 |
| Unknown model | 128,000 (conservative fallback) |

### Token Estimation

**File**: `tokens.ts`

Uses character length divided by 4 approximation (`BYTES_PER_TOKEN = 4`), roughly +/-8% accuracy. For `tool_call` and `tool_result` content blocks, additional structural overhead is accounted for (role headers, tool_call_id, etc.).

---

## Layer 2: Progressive Compression

**File**: `compression.ts`

When compression is enabled (`compressionOptions.enabled = true`) and token estimation exceeds the `triggerTokens` threshold, the system sends the oldest turns to an LLM for summarization compression.

### Compression Prompt

The system uses a prompt aligned with Claude Code's auto-compression, requiring the model to output:

1. **`<analysis>` block** (stripped): Chronological draft notes — user requests, approaches taken, key decisions, files involved, errors and fixes.
2. **`<summary>` block** (preserved): Detailed summary with 9 subsections:
   - Primary requests and intent
   - Key technical concepts
   - Files and code sections (with paths and changes)
   - Errors and fixes
   - Problem-solving process
   - All user messages (verbatim)
   - Pending tasks
   - Current work (exact state before compression)
   - Optional next steps
3. **`<topics>` block**: 2-6 topic tags for later retrieval.

The model is forced to **not call any tools** (`NO_TOOLS_PREAMBLE`), outputting only plain text.

### Compression Output Format

```typescript
interface CompressedSegment {
  summary: string;          // Summary text
  decisions: string[];      // Key decisions and rationale
  findings: string[];       // Important findings/facts/constraints
  pending: string[];        // Unresolved items
  topics: string[];         // Topic tags
  turnRange: { start: number; end: number }; // Original turn range covered
  originalTokenCount: number; // Token estimate before compression
}
```

After compression, original turns are replaced with a synthesized `user` role message:

```
[Compressed context — turns 1–5]
<summary>...</summary>
Decisions: ...
Findings: ...
Pending: ...
Continue the conversation from where it left off without asking the user any questions.
```

The trailing "continue without asking questions" instruction ensures the model doesn't pause to ask the user when it sees the summary.

### Re-compression (Deduplication)

When context grows past the threshold again after initial compression, the previous synthesized summary message is **included** in the new compression input, sent along with subsequent turns to the LLM for re-compression. This produces a **single updated summary covering all history**, not an accumulation of multiple summary fragments.

### OC1: Insert Compression (Efficiency Mode)

When `insertCompress = true`, the system uses a **prompt cache reuse** strategy:

1. No separate compression API call is made
2. A compression instruction message is inserted into the normal conversation flow
3. The next API call handles both the compression instruction and the normal user response
4. The response is parsed for `<summary>` and `<topics>` output
5. Compressed turns are replaced with the synthesized summary

This avoids the cold-start latency of a separate compression call, saving ~50% of first-call token consumption (OC2 mode: single cache rebuild).

### Configuration

| Parameter | Default | Description |
|---|---|---|
| `enabled` | `false` | Whether progressive compression is enabled |
| `triggerTokens` | `100_000` | Token threshold to trigger compression (half of 200K window) |
| `keepRecentTurns` | `6` | Recent turns kept uncompressed |
| `model` | Same as main | LLM model used for compression |
| `insertCompress` | `false` | Whether to use insert compression (OC1) |

---

## Layer 3: Micro-Compact

**File**: `compression.ts -> microCompact()`

Pure heuristic cleanup, no LLM call. When the **time gap since the last assistant message** exceeds a threshold, old `tool_result` content is cleared to a placeholder.

### How It Works

```typescript
function microCompact(messages, state, options) {
  // Check time gap
  const gapMs = Date.now() - state.lastAssistantTs;
  if (gapMs >= gapThresholdMinutes * 60_000) {
    // Clear old tool_results, preserve the most recent keepRecent entries
    const idsToClear = new Set(state.toolUseIds.slice(0, -keepRecent));
    messages.map(m =>
      m.role === "tool" && idsToClear.has(m.tool_call_id)
        ? { ...m, content: "[Old tool result content cleared]" }
        : m
    );
  }
}
```

### Key Design Details

- **Time gap detection** uses the `lastAssistantTs` saved from the previous turn, rather than re-scanning historical messages. This is because `Date.now()` is always "now"; if recalculated each scan, the time gap would always be zero.
- `lastAssistantTs` is updated by the Agent Loop after each real assistant response.
- Cleared content uses a fixed placeholder `"[Old tool result content cleared]"` to ensure prompt cache stability.

### Configuration

| Parameter | Default | Description |
|---|---|---|
| `enabled` | `false` | Whether micro-compact is enabled |
| `gapThresholdMinutes` | `60` | Idle time threshold in minutes |
| `keepRecent` | `5` | Most recent N tool results kept uncleared |

---

## Reactive Compression (Reactive Compact)

**File**: `compression.ts -> isPromptTooLongError()` + Agent Loop integration

Triggered when the API returns a prompt-too-long error, serving as the last line of defense.

### Trigger Matching Rules

```typescript
const PROMPT_TOO_LONG_PATTERNS = [
  /prompt is too long/i,
  /prompt_too_long/i,
  /tokens?.*>\s*\d+/i,    // "tokens > limit" type errors
  /context length exceeds/i,
  /input.*too.*(?:long|large)/i,
];
```

### Retry Flow

```
API call fails -> isPromptTooLongError? -> Aggressive compression -> Retry
                     +- Preserved turns halved (min 2 turns)
                     +- triggerTokens threshold ignored (unconditional compression)
                     +- Max 3 retries, exceed -> throw original error
```

### Circuit Breaker

`MAX_REACTIVE_RETRIES = 3` — after 3 consecutive reactive compression failures, the original error is thrown. Prevents infinite retry on problems that compression cannot solve.

---

## Idle Compression

**File**: `idle-compression.ts`

Automatically triggers background compression after the agent has been idle for a period. Aligns with Claude Code's OC5-OC7 behavior.

- **OC5**: Timer triggers after `idleMs` idle (default 314 seconds, under the 5-minute prompt cache TTL)
- **OC6**: New user input cancels in-progress compression, ensuring history consistency
- **OC7**: Compression results are persisted via `onCompressed` callback

State machine: `idle -> running -> fired/cancelled/error`

---

## Tool Budget Management

**File**: `tool-budget.ts`

Independent of context compression, there is a separate tool result size management mechanism:

- **Single result cap**: `DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000` — exceeded results are written to disk and replaced with a preview + file path
- **Per-turn total budget**: `MAX_PER_TURN_CHARS = 200,000` — exceeded results have the largest ones offloaded
- **Prompt cache stability**: Offloaded results are frozen and replayed the same way in subsequent turns (`reapplyReplacements()`)

---

## Agent Loop Integration Points

**File**: `packages/core/src/agent/loop.ts`

### 1. `applyProactiveCompress()` — Executed at the start of each turn

- OC1 path: Insert compression instruction, no separate call
- Traditional path: Separate API call to compress
- Triggers `onCompression` hook for REPL/UI notification

### 2. `prepareMessages()` — Context transformation pipeline

1. Tool budget replay (preserve prompt cache stability)
2. Micro-compact (clean old tool results)
3. Sliding window trim

### 3. Hook Callbacks

Compression hooks support 5 event types observable by the REPL/UI layer:

| Event Type | Trigger | `before`/`after` meaning |
|---|---|---|
| `"progressive"` | Progressive compression complete | Message counts before/after compression |
| `"micro"` | Micro-compact complete | Message count (unchanged; event is the signal) |
| `"reactive"` | Reactive compression complete | Message counts before/after compression |
| `"insert-compress"` | OC1 instruction inserted | Message counts before/after insertion |
| `"insert-resolved"` | OC1 parsing complete | Message count after parsing |

### 4. Key Invariants

- `messages[0]` is always the task user message; sliding window trimming drops from index 1
- Compression/micro-compact notifies callers via `onContextUpdate`; REPL updates its context but the original session log is unchanged
- Empty assistant responses (no text, no tool calls) are not appended to the message list, preventing subsequent API errors

---

## Configuration Example

```typescript
const agentOptions = {
  // Layer 1: Sliding window
  contextOptions: {
    maxTokens: 200_000,
    targetUtilization: 0.75,
    keepRecentTurns: 6,
  },

  // Layer 2: Progressive compression
  compressionOptions: {
    enabled: true,
    triggerTokens: 100_000,
    keepRecentTurns: 6,
    insertCompress: false,  // set true to enable OC1
  },

  // Layer 3: Micro-compact
  microCompactOptions: {
    enabled: false,        // disabled by default
    gapThresholdMinutes: 60,
    keepRecent: 5,
  },

  // Data persistence directory (used when offloading tool results)
  runDir: "/tmp/vera-run",
};
```

---

## Performance Metrics

| Operation | Cost | Latency Impact |
|---|---|---|
| Sliding window trim | 0 tokens | < 1ms (pure array slicing) |
| Progressive compression | ~1K+2K tokens (one small model call) | ~1-3s (including network latency) |
| Micro-compact | 0 tokens | < 1ms (pure array traversal) |
| Reactive compression | ~1K+2K tokens | ~1-3s (after network error) |
| Tool budget replay | 0 tokens | < 1ms (Map lookup) |
