# Operation Recorder

> Records user operations (tool calls) for replay, debugging, and training.

---

## Overview

The Operation Recorder is an operation capture and replay mechanism provided by `@vera/core`. It intercepts every tool call during agent execution, serializes the operation sequence to JSON, and supports replay on demand. Recorded data can be used for regression testing, demonstration capture, training data generation, and more.

## Core Data Structures

### StepRecord

Each tool invocation is captured as a `StepRecord`:

| Field | Type | Description |
|---|---|---|
| `index` | `number` | Step index (0-based) |
| `tool` | `string` | Name of the invoked tool |
| `args` | `Record<string, unknown>` | Arguments passed to the tool |
| `result` | `ToolResult` | Result returned by the tool |
| `timestamp` | `number` | Unix timestamp when the step started (ms) |
| `durationMs` | `number` | Duration of tool execution (ms) |

### OperationRecording

A complete operation sequence is wrapped in an `OperationRecording`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique recording ID (format: `rec_<timestamp>_<random>`) |
| `label` | `string` | Human-readable label |
| `sessionId` | `string` | Session ID during which the recording was made |
| `createdAt` | `number` | Recording creation time (Unix ms) |
| `totalDurationMs` | `number` | Total duration of all steps (ms) |
| `ok` | `boolean` | Whether all steps succeeded (every `result.ok` is `true`) |
| `steps` | `StepRecord[]` | Ordered list of recorded steps |

## Recording Modes

### Mode 1: wrapTool (Tool Wrapping)

The most common recording method. Use `recorder.wrapTool(tool, ctx)` to wrap an existing tool. The wrapped tool automatically records every invocation:

```typescript
const recorder = new OperationRecorder("my-task", sessionId);
const wrappedTool = recorder.wrapTool(myTool, ctx);
// Use wrappedTool for operations — each call is auto-recorded
const recording = recorder.finish();
```

`wrapTool` returns a new `ToolDef` compatible with the original signature, allowing seamless replacement.

### Mode 2: record (Manual Recording)

Manually add a record entry without going through tool wrapping:

```typescript
recorder.record(
  "tool-name",
  { arg1: "value" },
  { ok: true, content: "result" },
  150 // durationMs
);
```

Useful for inserting records in non-tool-call scenarios or importing records from external data sources.

### Mode 3: executeWithRecording (Orchestrator Integration)

Deep integration with `MultiStepOrchestrator` that automatically records the entire multi-step orchestration process:

```typescript
import { executeWithRecording } from "@vera/core";

const { orchestration, recording } = await executeWithRecording(
  steps,
  resolveTool,
  ctx,
  "my-orchestration",
  inputArgs,
  { globalTimeoutMs: 60000, stopOnError: true }
);
```

This function creates an `OperationRecorder` internally, wraps the `resolveTool` function, executes through the orchestrator, and returns both the orchestration result and the recording.

## Replay Capabilities

### The replay Function

The `replay()` function accepts an `OperationRecording` and re-executes each tool call in sequence:

```typescript
import { replay } from "@vera/core";

const result = await replay(recording, resolveTool, ctx, {
  startFromStep: 0,      // Start replaying from this step
  stopAtStep: 5,         // Stop after this step (inclusive)
  argsOverrides: new Map([[2, { newArg: "override" }]]), // Override args at specific steps
  dryRun: true,          // Dry-run mode
  signal: abortController.signal, // Cancellation signal
});
```

### ReplayOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `startFromStep` | `number` | `0` | Start replaying from this step index |
| `stopAtStep` | `number` | Last step | Stop replaying after this step (inclusive) |
| `argsOverrides` | `Map<number, Record<string, unknown>>` | - | Override args for specific step indices |
| `dryRun` | `boolean` | `false` | Dry-run mode — tools receive `ctx.dryRun = true` |
| `signal` | `AbortSignal` | - | AbortSignal for cancellation |

### ReplayResult

| Field | Type | Description |
|---|---|---|
| `ok` | `boolean` | Whether replay completed successfully |
| `steps` | `StepRecord[]` | Steps that were actually replayed |
| `totalDurationMs` | `number` | Total replay duration (ms) |
| `error` | `string` (optional) | Error message if replay failed |

### Replay Behavior

- If a tool throws during execution, replay stops immediately and the `ReplayResult` includes the error for that step.
- If a step returns `result.ok === false`, replay also stops and returns the error.
- If `signal` is triggered (`AbortSignal.aborted === true`), replay is cancelled.
- If a step's `tool` name cannot be resolved via `resolveTool`, a "Tool not found" error is returned.

## Serialization

Recording data supports JSON serialization for persistent storage and cross-session transfer:

```typescript
import { serializeRecording, deserializeRecording } from "@vera/core";

// Serialize
const json = serializeRecording(recording);
fs.writeFileSync("recording.json", json);

// Deserialize
const loaded = deserializeRecording(
  fs.readFileSync("recording.json", "utf-8")
);
```

`deserializeRecording` validates the basic structure (must have `id` and a `steps` array) and throws on invalid format.

## Use Cases

### Regression Testing

Record a successful operation sequence once, then replay after code changes to verify that tool call behavior and results remain consistent:

```typescript
// 1. Record
const recorder = new OperationRecorder("regression-test");
// ... perform operations ...
const recording = recorder.finish();
fs.writeFileSync("test-recording.json", serializeRecording(recording));

// 2. Replay in CI
const recorded = deserializeRecording(fs.readFileSync("test-recording.json", "utf-8"));
const result = await replay(recorded, resolveTool, testCtx, { dryRun: false });
assert(result.ok);
```

### Demonstration Capture

Record demo operations for user presentations that can be replayed repeatedly to showcase Vera's capabilities.

### Training Data Generation

Record agent operation sequences as data sources for model fine-tuning or example libraries.

## Integration with Computer Use Tools

Operation Recorder integrates naturally with Computer Use tools (e.g., browser automation, desktop operations) via the `wrapTool` mechanism. Because the recorder wraps the `ToolDef` interface, any tool implementing that interface can be recorded. In Computer Use scenarios, recorded data includes references to operation screenshots or page state (passed through the `content` field of `ToolResult`), which can be used to verify the accuracy of UI operations.

## Current Status

- Core recording and replay logic: complete
- `serializeRecording` / `deserializeRecording`: complete
- `executeWithRecording` (orchestrator integration): complete
- Features not yet implemented:
  - Recording diff comparison (comparing results of two replays)
  - Visual recording browser (timeline-based recording viewer)
  - Incremental recording updates (recording only changed steps)
