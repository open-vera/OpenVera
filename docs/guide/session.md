# Session Management

Vera's Session system handles complete conversation persistence, recovery, branching, and cost tracking. It uses JSONL format for storage with support for SQLite backend extension.

> For underlying implementation details, see `docs/core/session.md`. This document focuses on usage-level guidance.

---

## Session Lifecycle

A complete session goes through the following event flow:

```
session_start → user → [assistant → tool_call → tool_result]* → session_end
```

### Write API

```typescript
import { SessionStore } from "@open-vera/core";

const store = new SessionStore({ cwd: "/path/to/project" });
// sessionId is auto-generated (crypto.randomUUID())
// File path: ~/.vera/projects/<encoded_cwd>/<uuid>.jsonl

// 1. Start session
store.writeStart("claude-sonnet-4-6", "anthropic");

// 2. Record user input (returns uuid)
const userUuid = store.writeUser("Help me refactor UserService");

// 3. Record assistant reply (returns uuid)
const assistantUuid = store.writeAssistant({
  parentUuid: userUuid,
  content: "OK, let me first analyze the existing code...",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  stopReason: "end_turn",
  usage: { input_tokens: 1500, output_tokens: 800 },
  turn: 1,
  latencyMs: 3200,
  toolCalls: ["read_file", "grep"],
  status: "ok",
});

// 4. Record tool call (returns uuid)
const toolCallUuid = store.writeToolCall({
  parentUuid: userUuid,
  toolName: "read_file",
  toolCallId: "toolu_xxx",
  arguments: { file_path: "src/UserService.ts" },
});

// 5. Record tool result
store.writeToolResult({
  parentUuid: toolCallUuid,
  toolCallId: "toolu_xxx",
  content: "export class UserService { ... }",
});

// 6. End session
store.writeEnd(
  { input_tokens: 15000, output_tokens: 8000 },
  0.1234,  // totalCostUsd
  5,       // turnCount
  "Help me refactor UserService"  // lastPrompt
);
```

### Metadata Writes

```typescript
// Custom title
store.writeTitle("Refactor UserService data access layer");

// AI auto-generated title
store.writeAiTitle("Refactor UserService query logic");

// Conversation summary
store.writeSummary("Completed refactoring the UserService data access layer, submitted 3 PRs.");

// Tags (support categorization and merge markers)
store.writeTag("refactor");
store.writeTag("merged-from:dup-id-xxx");

// Git branch
store.writeGitBranch("refactor/user-service");

// PR link
store.writePrLink({
  prUrl: "https://github.com/org/repo/pull/42",
  prRepository: "org/repo",
  prNumber: 42,
});
```

---

## JSONL Storage Format

### File Path

```
~/.vera/projects/<sanitized_cwd>/<sessionId>.jsonl
```

The project path is sanitized: non-alphanumeric characters are replaced with `-`; overly long paths are truncated with a hash suffix appended.

### Entry Type Overview

| Type | Description | Key Fields |
|---|---|---|
| `session_start` | Start marker | `cwd`, `model`, `provider` |
| `user` | User message | `uuid`, `content` |
| `assistant` | AI reply | `uuid`, `parentUuid`, `content`, `model`, `usage`, `stopReason`, `turn`, `latencyMs`, `toolCalls`, `status` |
| `tool_call` | Tool call | `uuid`, `parentUuid`, `toolName`, `toolCallId`, `arguments` |
| `tool_result` | Tool result | `uuid`, `parentUuid`, `toolCallId`, `content` |
| `session_end` | End marker | `totalUsage`, `totalCostUsd`, `turnCount` |
| `last-prompt` | Last input | `lastPrompt` |
| `custom-title` | Custom title | `customTitle` |
| `ai-title` | AI title | `aiTitle` |
| `summary` | Conversation summary | `summary`, `leafUuid` |
| `tag` | Tag | `tag` |
| `git-branch` | Git branch | `gitBranch` |
| `pr-link` | PR association | `prUrl`, `prRepository`, `prNumber` |
| `branch` | Branch relationship | `parentSessionId`, `forkedFromUuid`, `title`, `status`, `worktreePath`, `worktreeBranch`, `baseCommit` |

### Design Characteristics

- **Append-only writes**: Uses append mode; process crashes do not lose already-written data
- **Corruption recovery**: Single-line JSON parse failures are skipped; partial corruption does not affect the rest of the data
- **Progressive summaries**: `readSessionSummary` only reads the first and last 64KB of the file to generate a complete summary, avoiding full parsing of large files

---

## Query and Recovery

### Listing

```typescript
// List all sessions for the current project
const sessions = SessionStore.listSessions("/path/to/project");

// Paginated
const result = SessionStore.listSessionsPaged({
  cwd: "/path/to/project",
  all: false,
  limit: 20,
  offset: 0,
  includeWorktrees: true,
});
console.log(result.sessions.length);
console.log(result.nextOffset);       // Next page start offset
console.log(result.totalCandidates);  // Total candidate count
```

**SessionSummary fields:**

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | Unique ID |
| `filePath` | string | JSONL file path |
| `startedAt` / `lastActivityAt` | Date | Time information |
| `model` / `provider` | string | Model/provider |
| `turnCount` | number | Conversation turns |
| `messageCount` | number | Total message count |
| `fileSize` | number | File size in bytes |
| `totalUsage` | Usage | Cumulative tokens (input/output/cache_w/cache_r) |
| `totalCostUsd` | number | Cumulative cost (USD) |
| `title` / `summary` | string | Title/summary |
| `firstPrompt` / `lastUserInput` | string | First/last user input |
| `tag` | string | Tag |
| `gitBranch` | string | Git branch |
| `pr` | object | PR info |
| `branch` | object | Branch info |

### Recovery

```typescript
const loaded = SessionStore.loadSession("session-id-prefix");
console.log(loaded.history);      // Message[] — full conversation history
console.log(loaded.turnCount);    // Turn count
console.log(loaded.totalCostUsd); // Total cost
console.log(loaded.cwd);          // Original working directory
```

Loading logic: Parse JSONL line by line, reconstruct `Message[]` from `user`/`assistant` entries, accumulate usage and cost. The total in `session_end` is trusted over the accumulated value when available.

### Transcript Preview

```typescript
const preview = SessionStore.loadTranscriptPreview("session-id");
// { sessionId, messages: SessionPreviewMessage[], summary?: SessionSummary }

preview.messages.forEach((msg) => {
  console.log(`${msg.role}: ${msg.content.slice(0, 100)}`);
  msg.toolUses?.forEach((tu) => {
    console.log(`  Tool: ${tu.name} → ${tu.result.content.slice(0, 100)}`);
  });
});
```

---

## Branch System

Session branches allow forking independent branches from any historical point to continue the conversation, with each branch fully isolated.

### Branch States

| State | Description |
|---|---|
| `active` | Active branch |
| `adopted` | Adopted and confirmed |
| `merged` | Merged back into parent session |
| `discarded` | Discarded |

### Creating Branches

```typescript
// Regular branch
const forked = SessionStore.forkSession({
  fromSessionId: "parent-session-id",
  cwd: "/path/to/project",
  title: "Try solution B",
  atUuid: "message-uuid", // Optional, fork from a specific message
});

// Branch with worktree isolation (/try)
const tryBranch = SessionStore.forkSession({
  fromSessionId: "parent-session-id",
  cwd: "/path/to/project",
  title: "Upgrade to Next.js 14",
  worktreePath: "/path/to/.vera/worktrees/try-upgrade-xxx",
  worktreeBranch: "try-upgrade-next14-xxx",
  baseCommit: "abc123def456",
});
```

Fork core logic:
1. Read the parent session's complete JSONL
2. Filter out replayable messages (excluding `session_end`, `summary`, `tag`, and other metadata entries)
3. Copy to a new file, update `sessionId`
4. Write `branch` entry (`status: "active"`, recording `parentSessionId`, `forkedFromUuid`)
5. If titled, append `(Branch)` suffix

### Branch Operations

```typescript
// List branches
const branches = SessionStore.listBranches("parent-session-id");
// Filters by parentSessionId match and status !== "discarded"

// Adopt
SessionStore.adoptBranch("branch-session-id");

// Mark as merged
SessionStore.markBranchMerged("branch-session-id");

// Discard
SessionStore.discardBranch("branch-session-id");
```

Discarding is a logical deletion (marked `discarded`); the JSONL file is not physically removed.

---

## Cost Tracking

### Pricing Table

Built-in pricing for mainstream models (USD per million tokens):

| Model | Input | Output | Cache Write | Cache Read |
|---|---|---|---|---|
| claude-opus-4-6 | $15.00 | $75.00 | $18.75 | $1.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $3.75 | $0.30 |
| claude-haiku-4-5 | $0.80 | $4.00 | $1.00 | $0.08 |
| gpt-4o | $2.50 | $10.00 | - | - |
| gpt-4o-mini | $0.15 | $0.60 | - | - |
| o3 | $10.00 | $40.00 | - | - |
| o4-mini | $1.10 | $4.40 | - | - |
| gemini-2.0-flash | $0.10 | $0.40 | - | - |
| gemini-2.5-pro | $1.25 | $10.00 | - | - |

### Model Name Normalization

`normalizeModelKey` strips date suffixes (`-\d{8}`) and `-latest`/`-preview`/`-exp` variants, ensuring `claude-sonnet-4-6-20251001` matches `claude-sonnet-4-6` pricing.

### Calculation

```typescript
import { calculateCost, accumulateCost, emptyAccumulatedCost } from "@open-vera/core";

// Single turn cost
const turnCost = calculateCost(usage, "claude-sonnet-4-6");

// Accumulated (immutable, returns new object)
let cost = emptyAccumulatedCost();
cost = accumulateCost(cost, usage1, "claude-sonnet-4-6", "anthropic");
cost = accumulateCost(cost, usage2, "gpt-4o", "openai");

console.log(cost.totalUsd);
// AccumulatedCost { totalUsd, byModel: Record<string, ModelCostRecord>, totalUsage: Usage }
```

Cost is persisted in the `session_end` entry and read directly on recovery without recalculation.

---

## AI Title Generation

```typescript
import { generateSessionTitle } from "@open-vera/core";

const title = await generateSessionTitle({
  adapter,                          // LLMAdapter instance
  model: "claude-haiku-4-5",        // Use low-cost model
  userPrompt: "Help me write a TypeScript quicksort implementation",
  assistantText: "Here is the TS implementation...",
  signal: abortController.signal,
});
// → "Quicksort TypeScript Implementation"
```

Generation strategy:
- `max_tokens=32`, `temperature=0`
- System prompt requests 3-8 word English or short Chinese output
- Auto-truncates overly long input (user/assistant each capped at 2000 characters)
- Strips quotes, whitespace; auto-truncates if exceeding 80 characters
- Returns `null` if generation is not possible

---

## Lifecycle Management (SessionManager)

`SessionManager` provides automatic cleanup and search capabilities:

```typescript
const manager = new SessionManager({
  autoCompress: {
    enabled: true,
    tokenThreshold: 100_000,  // Token threshold to trigger compression
    keepRecentTurns: 6,       // Keep the most recent N turns uncompressed
  },
  ttlDays: 30,       // Auto-cleanup after 30 days of inactivity
  maxSessions: 1000, // Max sessions retained per project
});

// Auto-compress
const { messages, compressed } = await manager.autoCompress(
  sessionId, messages, adapter, model
);

// Lifecycle cleanup
const result = manager.cleanup({ cwd: "/path/to/project", dryRun: true });
// → { removedCount, removedSessionIds, remainingCount }

// Keyword search
manager.buildIndex(summaries);
const results = manager.searchByKeyword("quick sort");

// Similar session detection
const similar = manager.findSimilarSessions(targetId, candidates, 0.6);
```

Search uses a trigram Jaccard similarity algorithm, lightweight with no external dependencies. Title matches are weighted 2x, exact keyword matches get 1x extra weight. Both Chinese and English stop words are filtered.

---

## Context Compression

Vera automatically compresses long sessions to stay within context window limits. The system has three layers:

### Progressive Compression

LLM-driven summarization of old turns, injected as system context. Triggered when estimated tokens exceed the configured threshold.

```jsonc
// .vera/settings.json
{
  "session": {
    "compact": {
      "enabled": true,
      "provider": "my-provider",
      "model": "claude-haiku-4-5"
    }
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable progressive compression |
| `provider` | (active chat provider) | Provider for compression model |
| `model` | (active chat model) | Model for compression (use cheap/fast) |
| `triggerTokens` | 100,000 | Token threshold to trigger compression |
| `keepRecentTurns` | 6 | Recent turns kept uncompressed |

The compressed summary preserves: decisions made, key findings, pending tasks, and topic transitions. The **first message (original task definition) is always preserved** — the agent never loses its goal.

### Micro-Compaction

Heuristic cleanup of stale tool results — **no LLM call needed**. Triggered by time gaps between turns.

- **Default gap**: 60 minutes between tool results
- **Keeps**: last 5 recent tool results
- **Cost**: zero (purely heuristic)

### Reactive Compact

Triggered by `prompt-too-long` API errors. Performs aggressive compression and retries, with a circuit breaker (max 3 retries) to prevent infinite loops.

### Idle Compression Timer

After 314 seconds of idle time, Vera can preemptively compress context to keep the cache warm for the next user message.

> Set `"enabled": false` in `session.compact` to disable automatic compression.
