# Session System Design

> This document describes OpenVera's session persistence system, including JSONL storage format, session lifecycle, forking mechanism, cost tracking, and search capabilities.

## Overview

The Session system is OpenVera's session persistence layer, responsible for recording every agent conversation in its entirety. Core design principles:

- **JSONL format**: One JSON record per line, human-readable, easy to grep/stream processing
- **Dual backend**: Default JSONL file storage, optional SQLite backend (with FTS search and indexing)
- **Progressive loading**: Only reads the head and tail 64KB to generate summaries; full reads only for conversation recovery
- **Native fork support**: Fork from any turn; multiple branches advance independently and can be merged

Core code is in `packages/core/src/session/`.

## Session Lifecycle

### Creation

```typescript
import { SessionStore } from "@open-vera/core";

const store = new SessionStore({ cwd: "/path/to/project" });
// sessionId auto-generated (crypto.randomUUID())
// File path: ~/.vera/projects/<sanitized_cwd>/<sessionId>.jsonl

store.writeStart("claude-sonnet-4-6", "anthropic");
```

`new SessionStore()` automatically creates the project directory (`~/.vera/projects/<cwd_hash>/`), with filenames using UUIDs.

### Writing Conversations

Each user input, LLM response, tool call, and result in the agent loop is written sequentially:

```typescript
const userUuid = store.writeUser("Help me create a React component");
const assistantUuid = store.writeAssistant({
  parentUuid: userUuid,
  content: "Sure, I'll create...",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  stopReason: "tool_use",
  usage: { input_tokens: 500, output_tokens: 200 },
  turn: 1,
  latencyMs: 1234,
  toolCalls: ["write"],
  status: "ok",
});
```

Tool calls are recorded separately:

```typescript
const toolCallUuid = store.writeToolCall({
  parentUuid: assistantUuid,
  toolName: "write",
  toolCallId: "toolu_xxx",
  arguments: { file_path: "/path/to/Component.tsx", content: "..." },
});

store.writeToolResult({
  parentUuid: toolCallUuid,
  toolCallId: "toolu_xxx",
  content: "File written successfully.",
});
```

### Ending a Session

```typescript
const totalUsage = { input_tokens: 5000, output_tokens: 3000 };
const totalCostUsd = 0.045;
const turnCount = 5;

store.writeEnd(totalUsage, totalCostUsd, turnCount, lastUserPrompt);
```

`writeEnd` writes both a `last-prompt` entry (first 120 characters of the last user input, for list previews) and a `session_end` entry.

### Loading and Recovery

```typescript
const loaded = SessionStore.loadSession(sessionId, cwd);
// LoadedSession { sessionId, filePath, cwd, history: Message[], totalUsage, totalCostUsd, turnCount, model, provider }
```

On recovery, only `user` and `assistant` type entries are parsed; `tool_call`/`tool_result` are skipped (that info is already included in the assistant's content).

### Reading Summaries (Without Full Loading)

```typescript
const summary = SessionStore.loadTranscriptPreview(sessionId, cwd);
// SessionTranscriptPreview { sessionId, messages: SessionPreviewMessage[], summary?: SessionSummary }
```

Summary reading only accesses the file's head and tail 64KB, containing:
- `SessionSummary`: model, provider, turn count, cost, title, summary, tag, git branch, PR link
- `SessionPreviewMessage[]`: user and assistant messages with tool use details

### Listing and Pagination

```typescript
const result = SessionStore.listSessionsPaged({
  cwd: "/path/to/project",   // Filter by project
  limit: 20,                  // Items per page
  offset: 0,                  // Offset
  includeWorktrees: true,     // Include sessions under git worktrees
});
// ListSessionsResult { sessions: SessionSummary[], nextOffset?: number, totalCandidates: number }
```

## JSONL Format and Schema

Each record is an independent JSON line. Full entry type definitions from `types.ts`:

### session_start
```json
{"type":"session_start","sessionId":"uuid","timestamp":"ISO-8601","cwd":"/path","model":"claude-sonnet-4-6","provider":"anthropic"}
```

### user
```json
{"type":"user","sessionId":"uuid","timestamp":"ISO-8601","uuid":"msg-uuid","content":"User input content"}
```

### assistant
```json
{"type":"assistant","sessionId":"uuid","timestamp":"ISO-8601","uuid":"msg-uuid","parentUuid":"user-uuid","content":"LLM response","model":"claude-sonnet-4-6","provider":"anthropic","stopReason":"end_turn|tool_use|max_tokens|stop","usage":{"input_tokens":500,"output_tokens":200},"turn":1,"latencyMs":1234,"toolCalls":["write","read"],"status":"ok|error"}
```

### tool_call
```json
{"type":"tool_call","sessionId":"uuid","timestamp":"ISO-8601","uuid":"tc-uuid","parentUuid":"assistant-uuid","toolName":"write","toolCallId":"toolu_xxx","arguments":{"file_path":"/a/b.ts"}}
```

### tool_result
```json
{"type":"tool_result","sessionId":"uuid","timestamp":"ISO-8601","uuid":"tr-uuid","parentUuid":"tc-uuid","toolCallId":"toolu_xxx","content":"Tool return content"}
```

### session_end
```json
{"type":"session_end","sessionId":"uuid","timestamp":"ISO-8601","totalUsage":{"input_tokens":5000,"output_tokens":3000},"totalCostUsd":0.045,"turnCount":5}
```

### Metadata Entries

| type | Description |
|---|---|
| `custom-title` / `custom_title` | User-defined title |
| `ai-title` | AI auto-generated title |
| `summary` | Session summary (generated during auto-compression) |
| `last-prompt` / `last_prompt` | Last user message (first 120 characters) |
| `tag` | Tags (supports multiple, e.g., `merged-from:xxx`) |
| `git-branch` | Git branch the session was on |
| `pr-link` | Associated PR link |
| `branch` | Branch/fork marker (parentSessionId, forkedFromUuid, status) |

### Content Truncation

The `preview()` function truncates all fields to 120 characters: overlong content shows `first 117 chars...`. This prevents very long prompts from bloating list summaries.

## Session Metadata

### AI Auto-Title

`generateSessionTitle()` (`title.ts`) is called at session end, using an LLM to generate a short title (3-8 words) based on the first user prompt and first assistant reply:

```typescript
import { generateSessionTitle } from "@open-vera/core";

const title = await generateSessionTitle({
  adapter: llmAdapter,
  model: "claude-haiku-4-5",
  userPrompt: "Help me refactor the user authentication module",
  assistantText: "OK, I'll analyze the existing code...",
});
```

The title is written as an `ai-title` entry. Display priority: **user-defined title > AI title > first prompt > summary**.

### Cost Tracking

The pricing table is in `cost.ts`, supporting multiple models:

```typescript
// Calculate cost for a single call
const cost = calculateCost(usage, "claude-sonnet-4-6");

// Accumulate to session level
const accumulated = accumulateCost(current, usage, model, provider);
// AccumulatedCost { totalUsd, byModel: Record<string, ModelCostRecord>, totalUsage }
```

Model names are normalized before lookup: date suffixes (`-20251001`), `-latest`, `-preview`, `-exp` are stripped.

Currently supported pricing: Claude Opus 4.6, Sonnet 4.6, Haiku 4.5, plus GPT-4o, GPT-4o-mini, o3, o4-mini, Gemini 2.0 Flash, Gemini 2.5 Pro.

## Forking Mechanism

### Fork from Any Turn

```typescript
const forked = SessionStore.forkSession({
  fromSessionId: "parent-uuid",
  atUuid: "specific-message-uuid", // Optional: fork from specific message; omit for end
  title: "Try approach B",
  cwd: "/path/to/project",
});
// ForkedSession { sessionId, parentSessionId, forkedFromUuid, filePath, title }
```

Fork implementation:
1. Reads all replayable entries from the source session (excluding `session_end`, `last-prompt`, `summary`, etc.)
2. Copies to a new file, replacing `sessionId` with a new UUID
3. Writes a `branch` entry marking the fork relationship
4. Writes a `custom-title` entry (if title provided)

### Branch Lifecycle

Branches have four statuses (`BranchStatus`):

| Status | Description | Operation |
|---|---|---|
| `active` | Active branch, advancing normally | Default on creation |
| `adopted` | Adopted as the main path | `SessionStore.adoptBranch(id)` |
| `merged` | Merged back to parent | `SessionStore.markBranchMerged(id)` |
| `discarded` | Discarded | `SessionStore.discardBranch(id)` |

### Querying Branches

```typescript
// List all active branches of a parent session
const branches = SessionStore.listBranches(parentSessionId, cwd);
// Returns SessionSummary[], excluding discarded branches
```

Status changes are implemented by appending new `branch` entries (JSONL cannot be modified in place). The last `branch` entry's status is used when reading.

### Merging

Via `SessionManager.mergeSessions()`:

```typescript
const manager = new SessionManager();
manager.mergeSessions("primary-session-id", ["dup-1", "dup-2"]);
// primary gets merged-from tag, duplicates get merged-into tag
```

This does not automatically merge JSONL content; it establishes associations through tags. The meaning of the merge operation is: mark duplicate sessions, pointing to the canonical version.

## Session Manager

`SessionManager` provides advanced session lifecycle capabilities:

### Auto-Compression (SS1)

When message history token count exceeds a threshold, early messages are automatically compressed into a summary, preserving the most recent N turns in full.

### Deduplication and Similarity Detection (SS2)

```typescript
const similar = manager.findSimilarSessions(targetSessionId, candidates, 0.6);
// SimilarSession[] sorted by similarity (Jaccard similarity on trigrams)
```

Uses character trigram Jaccard similarity to compare titles, first prompts, summaries, etc.

### Indexing and Search (SS3)

```typescript
manager.buildIndex(sessions);
const results = manager.searchByKeyword("React component testing");
// SessionIndexEntry[] sorted by relevance
```

Supports both Chinese and English keywords, with title matches receiving bonus scoring. Stop words include common Chinese and English words.

### TTL Cleanup (SS4)

Two-phase cleanup: first delete sessions exceeding TTL (default 30 days), then if still exceeding maxSessions (default 1000), delete by oldest activity time.

## Storage Backends

### JSONL File Backend (Default)

- Storage path: `~/.vera/projects/<sanitized_cwd>/<sessionId>.jsonl`
- Path sanitization: non-alphanumeric characters replaced with `-`, overlong paths truncated with hash appended
- Git worktree support: listings include sessions under worktree paths

### SQLite Backend (Optional)

```typescript
const { backend, migrated } = await SessionStore.configureSqlite({
  dbPath: "~/.vera/sessions.db",
  enableFts: true,            // Enable FTS5 full-text search
  autoMigrate: true,          // Auto-migrate from JSONL
});
```

The SQLite backend preserves full JSONL content in a `content` field while extracting metadata for indexing and querying. See `packages/core/src/session/sqlite-backend.ts`.

## Configuration

Session-related configuration via `settings.json` `session` field:

```json
{
  "session": {
    "ai_title": true,
    "compact": {
      "enabled": true,
      "triggerTokens": 100000,
      "keepRecentTurns": 6
    },
    "ttlDays": 30,
    "maxSessions": 1000
  }
}
```

## File Path Conventions

```
~/.vera/
  projects/
    <sanitized_cwd_hash>/     # e.g., Users-yang-zhou-workspace-my-project
      <uuid>.jsonl            # Single session file
  settings.json               # Global configuration (including API Key)
```

`sanitizePath()` replaces non-alphanumeric characters with `-`; long paths get a djb2 hash suffix for uniqueness. `resolveSessionFilePath()` supports backward-compatible multi-directory search.
