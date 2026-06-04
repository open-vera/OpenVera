# 运行时实现设计

> 目标：把"Harness 是系统调度和规划层，Agent 是执行层"变成可实现的运行时协议，而不只是概念文档。

---

## 1. 设计目标

本版运行时设计首先解决 3 个问题：

1. 用统一的类型描述 `Flow / Plan / Step / Critique / Proposal / Checkpoint`
2. 让 `packages/core` 成为运行时的公共协议层
3. 为后续 `packages/harness` 的调度实现留下清晰的挂载点

当前版本是**初始接口**。目标是先统一协议，不是在这里建完整运行时。

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

这里不放任何具体调度逻辑——只有协议。

### 2.2 `packages/harness`

负责系统运行时逻辑：

- `startFlow`
- `dispatch`
- `critique`
- `approve`
- `resume`
- `replay`
- `rollout`

即真正跑起 `core` 协议。

### 2.3 `packages/core/src/agent`

负责 Agent 执行循环：

- 接收 `AgentAssignment`
- 调用模型和工具
- 产出 `StepResult`
- 可选包含本地自检

---

## 3. 运行时模型

### 3.1 顶层对象是 Flow

Flow 代表一次任务执行实例，是运行时最重要的聚合根。

一个 Flow 至少包含：

- `flowId`
- `goal`
- `state`
- `plan`
- `scope`
- `budget`
- `loopCount`
- `artifacts`

### 3.2 Harness 控制 Flow 状态

推荐状态机：

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

关键点：

- 状态属于 Harness，不属于 Agent
- Agent 只能返回结果，不能直接修改 Flow State

### 3.3 Plan 和 Step 是结构化的执行层

Plan 是 Flow 的执行方案；Step 是最小执行单元。

Harness 职责：

- 生成或接受一个 Plan
- 判定当前激活的 Step
- 将 Step 分发为 `AgentAssignment`
- 根据 `CritiqueResult` 决定下一步动作

### 3.4 Critique 是结构化的控制信号

Critique 不是附加备注，而是 Flow 的分支条件。

至少必须回答：

- 置信度是多少
- 存在什么问题
- 下一步动作是 `complete / replan / retry / ask_human`

### 3.5 Proposal 是进化接口

Proposal 不直接修改系统，而是将审视/梦境/benchmark 发现的问题转化为待审核提案。

Proposal Pipeline：

```
发现问题
  -> 生成 Proposal
  -> 人类审核
  -> Rollout
  -> Benchmark 验证
```

---

## 4. 初始类型边界

### 4.1 放入 `runtime.ts` 的内容

推荐的初始公共类型：

- 基础枚举：状态 / 状态码 / 制品类型
- 约束类型：`TaskScope`、`BudgetState`
- Plan 类型：`ExecutionPlan`、`PlanStep`
- 执行类型：`AgentAssignment`、`StepResult`
- 控制类型：`CritiqueResult`、`PendingAction`
- 恢复类型：`FlowCheckpoint`
- 进化类型：`PolicyProposal`
- 事件类型：`RuntimeEvent`

### 4.2 暂不放入的内容

以下暂时不放公共类型，避免过早锁定实现：

- 具体存储后端接口
- 队列 / 调度器实现
- 审批 UI 协议
- Rollout 策略细节
- Benchmark 案例 schema 细节

---

## 5. 后续实现顺序

### Step 1

落地 `packages/core/src/types/runtime.ts`，并从 `types/index.ts` 导出。

### Step 2

在 `packages/harness` 加入运行时接口壳，例如：

```ts
interface HarnessRuntime {
  startFlow(input: StartFlowInput): Promise<FlowHandle>;
  resumeFlow(flowId: string): Promise<FlowHandle>;
  approve(flowId: string, decision: ApprovalDecision): Promise<void>;
  replayFlow(flowId: string): Promise<ReplayResult>;
}
```

### Step 3

让 `agent/loop.ts` 支持接收 `AgentAssignment`，而不只是纯字符串用户消息。

### Step 4

在 `packages/harness` 接入最小状态机：

- `planning`
- `dispatching`
- `executing`
- `critiquing`
- `completed`

---

## 6. 当前交付物

本批次交付：

- `packages/core/src/types/runtime.ts`
- `packages/core/src/types/index.ts`

这样后续实现 harness 运行时的时候，协议已经有了统一的锚点——不需要从文档反推。
