# Infinite Context — Current Implementation Notes

> This document aligns with [roadmap.md P0.6](../roadmap.md) and [agent-design.md section 1](./agent-design.md#1-infinite-context), describing the actual implementation state as of 2026-04-28.

---

## 1. Summary

The P0 capabilities for infinite context have been implemented and integrated into the `runAgent`/`streamAgent` main loops:

- Window trimming
- Progressive compression
- Micro-compact
- Reactive compact (retry with compression after a too-long error)
- Compressed segment recall

---

## 2. Code Locations

| File | Capability |
|---|---|
| `packages/core/src/context/tokens.ts` | Token estimation and model context limits |
| `packages/core/src/context/window.ts` | `trimToWindow` (window trimming, preserving task anchors) |
| `packages/core/src/context/compression.ts` | `compressMessages`, `microCompact`, segment indexing and recall |
| `packages/core/src/context/tool-budget.ts` | Tool output budget and persistent substitution strategy |
| `packages/core/src/agent/loop.ts` | Orchestrates window/compression/reactive compact in both main loops |

---

## 3. Runtime Mechanism (Current)

1. Before each turn's request, `trimToWindow` controls window occupancy.
2. When thresholds are reached, `compressMessages` is triggered, preserving recent context and compressing old messages.
3. Based on time gaps and message patterns, `microCompact` is triggered to reclaim stale tool outputs.
4. If the model returns a prompt-too-long error, reactive compact is triggered and the request is retried.
5. Compressed segments retain segment metadata and can be retrieved and expanded by relevance.

---

## 4. P0 Acceptance Criteria

- [x] Long conversations automatically trim the window, avoiding direct context length limit errors
- [x] Compression is integrated into `runAgent` and `streamAgent`
- [x] Prompt-too-long errors trigger reactive compact retries
- [x] Compressed segments can be retrieved and restored
- [x] Micro-compact state is held and updated within the main loop

---

## 5. Current Boundaries and Next Steps

- Continued optimization is needed: post-execution trimming cost for large tool outputs (roadmap item M3, status TBD).
- Integration with the long-term memory system (P1) is in a later phase: infinite context currently addresses in-session context capacity, not cross-task memory.
- For related alignment items and technical debt, see [roadmap.md#known-defects-and-technical-debt](../roadmap.md#known-defects-and-technical-debt) and [capability-gaps.md](./capability-gaps.md).
