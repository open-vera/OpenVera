# @open-vera/core

Stateless agent runtime foundation for the Vera framework.

Handles a single LLM call end-to-end: intent classification → model routing → tool execution → context management. No orchestration logic — pure execution primitive.

## Install

```bash
npm install @open-vera/core
```

## What's Inside

| Module | Capability |
|---|---|
| `adapters/` | Unified `LLMAdapter` interface — Anthropic, OpenAI, Gemini, DeepSeek, Groq, Azure |
| `agent/` | `streamAgent` / `runAgent` — multi-turn loop, tool dispatch, retry, context compression |
| `agent/subagent.ts` | `agent` tool — orchestrator/worker delegation, isolation modes, background jobs |
| `context/` | Token estimation, window trimming, progressive / micro / reactive compression, recall |
| `intent/` | `classifyIntent` / `routeTarget` — L0–L3 classification, domain detection |
| `tools/` | 7 built-in tools: `read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| `tools/registry.ts` | `ToolRegistry` — register, execute, lifecycle hooks |
| `tools/security.ts` | Path boundary enforcement, tool whitelist, injection defense, read-only mode |
| `tools/permission-rules.ts` | Persistent allow/deny rules, bash risk confirmation |
| `session/` | JSONL session store, cost tracking, AI-generated titles |
| `repl/` | React + Ink terminal UI — ConversationPanel, SessionPicker, DiffView, theme system |
| `project-context/` | `.vera/rules.md` / `CLAUDE.md` loading, path-scoped rule activation |
| `worktree/` | Git worktree creation and management |

## Intent Routing

```
User input → [classify: ~100ms] → routing decision → [target model]
```

| Level | Description | Default Model |
|---|---|---|
| L0 | Casual chat, simple Q&A | claude-haiku / gpt-4o-mini |
| L1 | Single-step tasks | claude-haiku / gpt-4o-mini |
| L2 | Multi-step tasks | claude-sonnet / gpt-4o |
| L3 | Complex planning, deep reasoning | claude-opus / o3 |

L3 tasks automatically activate Plan Mode.

## Infinite Context

Four-layer system so long tasks never lose their goal:

| Layer | Mechanism | Trigger |
|---|---|---|
| Sliding window trim | Drop earliest turns, preserve task anchor | 80% token threshold |
| Progressive compression | LLM summarization injected as system context | Token threshold exceeded |
| Micro-compaction | Heuristic cleanup of stale tool results — no LLM call | Time-gap based |
| Reactive compaction | Aggressive compression + retry on `prompt-too-long` | API error |

The original task definition is always preserved.

## Subagent Isolation Modes

| Mode | Mechanism | Use Case |
|---|---|---|
| `none` | Shared context (default) | Standard delegation |
| `try` | Isolated git worktree, reviewable via `/merge` | Experimental code changes |
| `remote` | Pluggable external executor backend | Distributed or sandboxed execution |

## Quick Start

```typescript
import { streamAgent } from "@open-vera/core/agent";
import { AnthropicAdapter } from "@open-vera/core/adapters";

const adapter = new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });

for await (const event of streamAgent({
  adapter,
  messages: [{ role: "user", content: "List files in the current directory" }],
  tools: [],
})) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

## Architecture

`@open-vera/core` is a strict dependency of `@open-vera/openvera`. Core never imports from Harness — the stateless loop is usable standalone.

```
@open-vera/openvera → @open-vera/core
```

## License

MIT
