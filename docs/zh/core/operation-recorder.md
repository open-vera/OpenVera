# Operation Recorder（操作录制器）

> 记录用户操作序列，支持回放、调试和训练。

---

## 概述

Operation Recorder 是 `@vera/core` 提供的操作录制与回放机制。它捕获 agent 执行过程中的每一步工具调用（tool call），将操作序列序列化为 JSON，支持持久化后按需重放。录制数据可用于回归测试、演示捕获、训练数据生成等场景。

## 核心数据结构

### StepRecord（单步记录）

每次工具调用被记录为一个 `StepRecord`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | `number` | 步骤序号（0-based） |
| `tool` | `string` | 被调用的工具名称 |
| `args` | `Record<string, unknown>` | 传入工具的参数 |
| `result` | `ToolResult` | 工具返回的结果 |
| `timestamp` | `number` | 步骤开始时的 Unix 时间戳（毫秒） |
| `durationMs` | `number` | 工具执行耗时（毫秒） |

### OperationRecording（完整录制）

一次完整的操作序列被封装为 `OperationRecording`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 唯一录制 ID（格式：`rec_<timestamp>_<random>`） |
| `label` | `string` | 人类可读的标签 |
| `sessionId` | `string` | 录制所属的会话 ID |
| `createdAt` | `number` | 录制创建时间（Unix 毫秒） |
| `totalDurationMs` | `number` | 所有步骤的总耗时（毫秒） |
| `ok` | `boolean` | 整体操作是否成功（所有步骤 `result.ok` 都为 `true`） |
| `steps` | `StepRecord[]` | 按顺序排列的步骤列表 |

## 录制模式

### 模式一：wrapTool（工具包装）

最常用的录制方式。通过 `recorder.wrapTool(tool, ctx)` 包装现有工具，包装后的工具在执行时会自动记录每次调用：

```typescript
const recorder = new OperationRecorder("my-task", sessionId);
const wrappedTool = recorder.wrapTool(myTool, ctx);
// 使用 wrappedTool 执行操作，每次调用自动记录
const recording = recorder.finish();
```

`wrapTool` 返回与原工具签名兼容的新 `ToolDef`，可以无缝替换原工具使用。

### 模式二：record（手动记录）

不通过工具包装，直接手动添加一条记录：

```typescript
recorder.record(
  "tool-name",
  { arg1: "value" },
  { ok: true, content: "result" },
  150 // durationMs
);
```

适用于需要在非工具调用场景下插入记录，或从外部数据源导入记录的场景。

### 模式三：executeWithRecording（编排器集成）

与 `MultiStepOrchestrator` 深度集成，自动记录多步编排执行的全过程：

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

此函数内部创建 `OperationRecorder`，包装 `resolveTool`，通过编排器执行并返回编排结果和录制两份数据。

## 回放能力

### replay 函数

`replay()` 函数接收一个 `OperationRecording`，按步骤顺序重新执行每个工具调用：

```typescript
import { replay } from "@vera/core";

const result = await replay(recording, resolveTool, ctx, {
  startFromStep: 0,      // 从第几步开始
  stopAtStep: 5,         // 到第几步停止（含）
  argsOverrides: new Map([[2, { newArg: "override" }]]), // 覆盖指定步骤的参数
  dryRun: true,          // 模拟执行模式
  signal: abortController.signal, // 取消信号
});
```

### ReplayOptions（回放选项）

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `startFromStep` | `number` | `0` | 从指定步骤开始回放 |
| `stopAtStep` | `number` | 最后一步 | 回放到此步骤停止（含） |
| `argsOverrides` | `Map<number, Record<string, unknown>>` | - | 覆盖指定步骤索引的参数 |
| `dryRun` | `boolean` | `false` | 模拟执行模式，工具收到的 `ctx.dryRun` 为 `true` |
| `signal` | `AbortSignal` | - | 用于取消回放 |

### ReplayResult（回放结果）

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | `boolean` | 回放是否成功完成 |
| `steps` | `StepRecord[]` | 实际回放的步骤列表 |
| `totalDurationMs` | `number` | 回放总耗时（毫秒） |
| `error` | `string`（可选） | 失败时的错误信息 |

### 回放行为

- 如果某一步工具在执行时抛出异常，回放立即终止，`ReplayResult` 包含该步骤的错误信息。
- 如果某一步返回 `result.ok === false`，回放同样终止并返回错误。
- 如果 `signal` 被触发（`AbortSignal.aborted === true`），回放取消。
- 如果某一步的 `tool` 名称无法通过 `resolveTool` 解析，返回 "Tool not found" 错误。

## 序列化

录制数据支持 JSON 序列化，便于持久化存储和跨会话传递：

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

`deserializeRecording` 会验证基本结构（必须有 `id` 和 `steps` 数组），格式不正确时抛出错误。

## 使用场景

### 回归测试

录制一次成功的操作序列，在代码变更后重放，验证工具调用过程和结果是否一致：

```typescript
// 1. 录制
const recorder = new OperationRecorder("regression-test");
// ... 执行操作 ...
const recording = recorder.finish();
fs.writeFileSync("test-recording.json", serializeRecording(recording));

// 2. CI 中重放
const recorded = deserializeRecording(fs.readFileSync("test-recording.json", "utf-8"));
const result = await replay(recorded, resolveTool, testCtx, { dryRun: false });
assert(result.ok);
```

### 演示捕获

录制给用户看的演示操作，可反复重放展示 Vera 的能力。

### 训练数据生成

录制 agent 的操作序列，作为模型微调或示例库的数据来源。

## 与 Computer Use 工具的集成

Operation Recorder 通过 `wrapTool` 机制与 Computer Use 工具（如浏览器操作、桌面操作）自然集成。因为录制器包装的是 `ToolDef` 接口，任何实现该接口的工具都可以被录制。在 Computer Use 场景中，录制数据包含了操作截图或页面状态的引用（通过 `ToolResult` 中的 `content` 字段传递），可用于验证 UI 操作的准确性。

## 当前状态

- 核心录制和回放逻辑已完成
- `serializeRecording` / `deserializeRecording` 已完成
- `executeWithRecording`（编排器集成）已完成
- 尚未实现的功能：
  - 录制数据的 diff 对比（比较两次回放的结果差异）
  - 可视化录制浏览器（以时间线形式展示录制数据）
  - 录制数据的增量更新（仅录制变化的步骤）
