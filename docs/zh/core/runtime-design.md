# Runtime 落地设计

> 目标：把 `Harness 是系统调度与规划层，Agent 是执行层` 这件事落成一套可实现的 runtime 协议，而不只是概念文档。

---

## 1. 设计目标

这一版 runtime 设计先解决 3 个问题：

1. 用统一类型描述 `Flow / Plan / Step / Critique / Proposal / Checkpoint`
2. 让 `packages/core` 成为 runtime 公共协议层
3. 给后续 `packages/harness` 的调度实现留出明确挂点

当前版本是 **初版接口**，目标是先统一协议，不在这里一次性做完完整 runtime。

---

## 2. 分层

### 2.1 `packages/core`

负责公共运行时类型：

- Flow
- Plan
- Step
- Assignment
- Critique
- Proposal
- Checkpoint
- Event / Artifact

这里不放具体调度逻辑，只放协议。

### 2.2 `packages/harness`

负责系统运行逻辑：

- `startFlow`
- `dispatch`
- `critique`
- `approve`
- `resume`
- `replay`
- `rollout`

也就是把 `core` 的协议真正跑起来。

### 2.3 `packages/core/src/agent`

负责 agent 执行循环：

- 接受 `AgentAssignment`
- 调用模型和工具
- 产出 `StepResult`
- 可选附带局部 self-check

---

## 3. 运行模型

### 3.1 顶层对象是 Flow

Flow 代表一次任务运行实例，是 runtime 最重要的聚合根。

一个 Flow 至少包含：

- `flowId`
- `goal`
- `state`
- `plan`
- `scope`
- `budget`
- `loopCount`
- `artifacts`

### 3.2 Harness 控制 Flow State

建议状态机：

```ts
type HarnessState =
  | "intaking"
  | "planning"
  | "dispatching"
  | "executing"
  | "waiting_tool"
  | "waiting_approval"
  | "critiquing"
  | "replanning"
  | "paused"
  | "completed"
  | "failed";
```

这里的关键点是：

- state 属于 harness，不属于 agent
- agent 只能返回结果，不能直接改 Flow State

### 3.3 Plan 和 Step 是结构化执行层

Plan 是 Flow 的执行方案，Step 是最小执行单元。

Harness 的职责：

- 生成或接受 Plan
- 决定当前激活的 Step
- 将 Step 派发为 `AgentAssignment`
- 根据 `CritiqueResult` 决定下一步

### 3.4 Critique 是结构化控制信号

Critique 不是附加说明，而是 Flow 的转向条件。

最少需要回答：

- 置信度多少
- 有哪些问题
- 下一步是 `complete / replan / retry / ask_human`

### 3.5 Proposal 是进化接口

Proposal 不是直接改系统，而是把 critique / dreaming / benchmark 发现的问题转成待审核提案。

Proposal Pipeline：

```
发现问题
  → 生成 Proposal
  → 人工审核
  → Rollout
  → benchmark 验证
```

---

## 4. 初版类型边界

### 4.1 `runtime.ts` 放什么

初版公共类型建议放这些：

- 基础枚举：state / status / artifact type
- 约束类型：`TaskScope`、`BudgetState`
- 计划类型：`ExecutionPlan`、`PlanStep`
- 执行类型：`AgentAssignment`、`StepResult`
- 控制类型：`CritiqueResult`、`PendingAction`
- 恢复类型：`FlowCheckpoint`
- 演化类型：`PolicyProposal`
- 事件类型：`RuntimeEvent`

### 4.2 暂时不放什么

以下内容先不塞进公共类型，避免过早定死实现：

- 具体存储后端接口
- queue / scheduler 实现
- approval UI 协议
- rollout 策略细节
- benchmark case schema 的全部细节

---

## 5. 后续实现顺序

### Step 1

先把 `packages/core/src/types/runtime.ts` 落下，并从 `types/index.ts` 导出。

### Step 2

在 `packages/harness` 里新增 runtime 接口壳，例如：

```ts
interface HarnessRuntime {
  startFlow(input: StartFlowInput): Promise<FlowHandle>;
  resumeFlow(flowId: string): Promise<FlowHandle>;
  approve(flowId: string, decision: ApprovalDecision): Promise<void>;
  replayFlow(flowId: string): Promise<ReplayResult>;
}
```

### Step 3

让 `agent/loop.ts` 支持接收 `AgentAssignment`，而不是只收一条纯字符串 user message。

### Step 4

在 `packages/harness` 里接入最小状态机：

- `planning`
- `dispatching`
- `executing`
- `critiquing`
- `completed`

---

## 6. 当前交付物

本次会同步落地：

- [packages/core/src/types/runtime.ts](/Users/yang.zhou/workspace/agent/packages/core/src/types/runtime.ts:1)
- [packages/core/src/types/index.ts](/Users/yang.zhou/workspace/agent/packages/core/src/types/index.ts:1)

这样后续实现 harness runtime 时，协议已经有统一锚点，不需要再从文档反推。
