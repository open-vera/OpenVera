# 操作录制器

> 录制用户操作（工具调用），用于回放、调试和训练。

---

## 概述

操作录制器是 `@vera/core` 提供的操作捕获与回放机制。它在 agent 执行期间拦截每次工具调用，将操作序列序列化为 JSON，并按需支持回放。录制的数据可用于回归测试、演示录制、训练数据生成等场景。

## 核心数据结构

### StepRecord

每次工具调用被捕获为 `StepRecord`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | `number` | 步骤索引（从 0 开始） |
| `tool` | `string` | 被调用的工具名称 |
| `args` | `Record<string, unknown>` | 传给工具的参数 |
| `result` | `ToolResult` | 工具返回的结果 |
| `timestamp` | `number` | 步骤开始的 Unix 时间戳（毫秒） |
| `durationMs` | `number` | 工具执行耗时（毫秒） |

### OperationRecording

完整的操作序列被包裹在 `OperationRecording` 中：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 唯一录制 ID（格式：`rec_<timestamp>_<random>`） |
| `label` | `string` | 人类可读的标签 |
| `sessionId` | `string` | 录制时的会话 ID |
| `createdAt` | `number` | 录制创建时间（Unix 毫秒） |
| `totalDurationMs` | `number` | 所有步骤的总耗时（毫秒） |
| `ok` | `boolean` | 所有步骤是否成功（所有 `result.ok` 为 `true`） |
| `steps` | `StepRecord[]` | 已录制步骤的有序列表 |

## 录制模式

### 模式 1：wrapTool（工具包装）

最常用的录制方式。使用 `recorder.wrapTool(tool, ctx)` 包装已有工具，被包装的工具自动记录每次调用：

```typescript
const recorder = new OperationRecorder("my-task", sessionId);
const wrappedTool = recorder.wrapTool(myTool, ctx);
// 使用 wrappedTool 进行操作——每次调用自动录制
const recording = recorder.finish();
```

`wrapTool` 返回一个与原签名兼容的新 `ToolDef`，可无缝替换。

### 模式 2：record（手动录制）

不经过工具包装，手动添加录制条目：

```typescript
recorder.record(
  "tool-name",
  { arg1: "value" },
  { ok: true, content: "result" },
  150 // durationMs
);
```

适用于非工具调用场景插入记录，或从外部数据源导入记录。

### 模式 3：executeWithRecording（编排器集成）

与 `MultiStepOrchestrator` 深度集成，自动记录整个多步骤编排过程：

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

此函数内部创建 `OperationRecorder`，包装 `resolveTool` 函数，通过编排器执行，并返回编排结果和录制数据。

## 回放能力

### replay 函数

`replay()` 函数接收 `OperationRecording` 并按序重新执行每个工具调用：

```typescript
import { replay } from "@vera/core";

const result = await replay(recording, resolveTool, ctx, {
  startFromStep: 0,
  stopAtStep: 5,
  argsOverrides: new Map([[2, { newArg: "override" }]]),
  dryRun: true,
  signal: abortController.signal,
});
```

### ReplayOptions

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `startFromStep` | `number` | `0` | 从该步骤索引开始回放 |
| `stopAtStep` | `number` | 最后一步 | 回放到该步骤后停止（含） |
| `argsOverrides` | `Map<number, Record<string, unknown>>` | - | 覆盖指定步骤索引的参数 |
| `dryRun` | `boolean` | `false` | 干跑模式——工具收到 `ctx.dryRun = true` |
| `signal` | `AbortSignal` | - | 用于取消的 AbortSignal |

### ReplayResult

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | `boolean` | 回放是否成功完成 |
| `steps` | `StepRecord[]` | 实际回放的步骤 |
| `totalDurationMs` | `number` | 总回放耗时（毫秒） |
| `error` | `string`（可选） | 回放失败时的错误消息 |

### 回放行为

- 如果工具在执行时抛出异常，回放立即停止，`ReplayResult` 包含该步骤的错误。
- 如果某步骤返回 `result.ok === false`，回放也停止并返回错误。
- 如果 `signal` 被触发（`AbortSignal.aborted === true`），回放被取消。
- 如果某步骤的 `tool` 名称无法通过 `resolveTool` 解析，返回 "Tool not found" 错误。

## 序列化

录制数据支持 JSON 序列化，可用于持久化存储和跨会话传输：

```typescript
import { serializeRecording, deserializeRecording } from "@vera/core";

// 序列化
const json = serializeRecording(recording);
fs.writeFileSync("recording.json", json);

// 反序列化
const loaded = deserializeRecording(
  fs.readFileSync("recording.json", "utf-8")
);
```

`deserializeRecording` 会验证基本结构（必须有 `id` 和 `steps` 数组），对无效格式抛出异常。

## 使用场景

### 回归测试

录制一次成功的操作序列，在代码变更后回放，验证工具调用行为和结果是否保持一致：

```typescript
// 1. 录制
const recorder = new OperationRecorder("regression-test");
// ... 执行操作 ...
const recording = recorder.finish();
fs.writeFileSync("test-recording.json", serializeRecording(recording));

// 2. 在 CI 中回放
const recorded = deserializeRecording(fs.readFileSync("test-recording.json", "utf-8"));
const result = await replay(recorded, resolveTool, testCtx, { dryRun: false });
assert(result.ok);
```

### 演示录制

录制演示操作用于用户展示，可反复回放以展示 Vera 的能力。

### 训练数据生成

录制 agent 操作序列，作为模型微调或示例库的数据源。

## 与 Computer Use 工具的集成

操作录制器通过 `wrapTool` 机制与 Computer Use 工具（如浏览器自动化、桌面操作）自然集成。因为录制器包装的是 `ToolDef` 接口，任何实现了该接口的工具都可以被录制。在 Computer Use 场景中，录制数据包含操作截图或页面状态的引用（通过 `ToolResult` 的 `content` 字段传递），可用于验证 UI 操作的准确性。

## 当前状态

- 核心录制与回放逻辑：已完成
- `serializeRecording` / `deserializeRecording`：已完成
- `executeWithRecording`（编排器集成）：已完成
- 尚未实现的功能：
  - 录制差异对比（比较两次回放的结果）
  - 可视化录制浏览器（基于时间线的录制查看器）
  - 增量录制更新（仅录制变更的步骤）
