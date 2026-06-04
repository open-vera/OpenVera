# Flow 配置与使用指南

Flow 是 Vera 的多步骤任务编排机制，通过 **Plan（规划）-> Act（执行）-> Critique（评估）-> Replan（重规划）** 循环驱动复杂任务自动完成。

## 什么是 Flow

Flow 将用户目标分解为一系列有序的执行步骤（`ExecutionPlan`），由 `HarnessRuntime` 驱动状态机自动推进。每一步执行完毕后由 Challenger（挑战者）独立评估，决定是继续、重试还是重新规划。

**适用场景：**

- 多文件重构 + 测试验证
- 跨模块功能开发（前后端联动）
- 自动化代码审查与修复
- 需要人工审批的高风险操作

**不适用场景：**

- 单次问答（直接用 Core agent loop）
- 无明确步骤依赖的探索性任务

## 目录结构

Flow 定义存放在项目根目录下的 `.vera/flows/` 中：

```
.vera/
  flows/
    my-flow/
      main.md          # Flow 入口：goal 描述与配置
      agents/
        default.md     # 默认 Role Agent 的系统提示词
        reviewer.md    # 审查 Agent 提示词
    auto-dev/
      main.md
      task/
        goal.md        # 分步任务说明
    challenger/
      lessons/
        step_1.md      # 积累的经验教训（自动生成）
```

- `main.md`：定义 Flow 的目标（goal）和元信息
- `agents/`：各 Role Agent 的角色提示词
- `task/`：分步骤的任务详细说明
- `challenger/lessons/`：Challenger 自动积累的失败模式经验

## Flow 定义格式

### ExecutionPlan 结构

```typescript
interface ExecutionPlan {
  planId: string;          // 唯一标识，如 "plan-1700000000"
  goal: string;            // 任务目标描述
  assumptions: string[];   // 前置假设
  steps: PlanStep[];       // 执行步骤列表（3-6 个）
  risk: "low" | "medium" | "high";
}

interface PlanStep {
  id: string;              // 步骤 ID，如 "step_1"
  type: "analyze" | "tool" | "delegate" | "critique" | "finalize";
  action: string;          // 描述具体要做什么
  dependsOn: string[];     // 依赖的前置步骤 ID
  assignedAgent: string;   // 分配的 Agent，默认 "default"
  status: "pending" | "running" | "done" | "failed" | "blocked";
}
```

### Step 类型说明

| 类型 | 用途 | 示例 |
|------|------|------|
| `analyze` | 读取/分析代码 | "阅读 auth 模块源码，分析认证流程" |
| `tool` | 修改/执行操作 | "重构 login 函数，提取 token 验证逻辑" |
| `delegate` | 委派子任务 | "委派给 UI agent 更新登录页组件" |
| `critique` | 评审/验证 | "审查重构后的代码，检查安全问题" |
| `finalize` | 收尾 | "运行全量测试，提交代码" |

### 通过 Planner 自动生成

最常用的方式是让 LLM 自动规划：

```typescript
import { HarnessRuntime } from "@open-vera/openvera";
import { AnthropicAdapter } from "@open-vera/core/adapters";

const runtime = new HarnessRuntime(
  adapter,
  "claude-sonnet-4-6",
  { artifactsRootDir: ".vera/artifacts" }
);

// 从自然语言目标自动生成 Plan 并执行
const handle = await runtime.planAndStart(
  "重构认证模块，添加单元测试",
  "auth-refactor",
  {
    tools: ["read_file", "write_file", "bash", "grep"],
    contextSummary: "项目使用 JWT 认证，auth.ts 约 300 行",
  }
);
```

### 手动定义 Plan

```typescript
const plan: ExecutionPlan = {
  planId: "auth-refactor-v1",
  goal: "重构认证模块，添加单元测试",
  assumptions: ["JWT 库已安装", "测试框架使用 Vitest"],
  steps: [
    {
      id: "step_1",
      type: "analyze",
      action: "阅读 auth.ts 源码，理解现有认证流程",
      dependsOn: [],
      assignedAgent: "default",
      status: "pending",
    },
    {
      id: "step_2",
      type: "tool",
      action: "拆分 token 验证逻辑到独立文件 token.ts",
      dependsOn: ["step_1"],
      assignedAgent: "default",
      status: "pending",
    },
    {
      id: "step_3",
      type: "tool",
      action: "编写 token.ts 的单元测试",
      dependsOn: ["step_2"],
      assignedAgent: "default",
      status: "pending",
    },
    {
      id: "step_4",
      type: "finalize",
      action: "运行全部测试，确认无回归",
      dependsOn: ["step_3"],
      assignedAgent: "default",
      status: "pending",
    },
  ],
  risk: "medium",
};

const handle = await runtime.startFlow({
  flowId: "auth-refactor",
  goal: plan.goal,
  plan,
  maxLoops: 3,
});
```

## 运行 Flow

### CLI 方式

```bash
# 运行指定 Flow
openvera run auto-dev

# 启动 REPL（带 Harness 支持）
openvera repl --dir .
```

### 编程方式

```typescript
// 方式 1：自动规划 + 执行
const result = await runtime.runFlowLoop(handle, {
  maxSteps: 4,
  maxParallel: 1,    // 并行步数（依赖允许时）
  onEvent: (event) => {
    console.log(event.type, event.stepId);
  },
});

// 方式 2：手动按步驱动
const { handle: h1, assignment } = runtime.dispatchStep(handle);
const { handle: h2, result } = await runtime.runAgentAssignment(h1, assignment);

// 方式 3：使用 SelfLoop（自动多轮循环直到完成）
const selfLoopResult = await runtime.runSelfLoop(handle, {
  maxCycles: 5,
  budgetUsd: 1.0,
});
```

## Flow 状态机

Flow 在 11 个状态间按严格规则迁移，非法跳转会立即抛出异常：

```
intaking          ← 接收用户输入
  → planning      ← LLM 生成 ExecutionPlan
    → dispatching ← 分配步骤给 Agent（解析依赖，检测循环）
      → executing ← Agent 执行当前步骤
        → waiting_tool     ← 等待工具调用返回
        → waiting_approval ← 等待人工审批（高风险操作）
        → critiquing       ← Challenger 评估执行结果
          → dispatching    ← 继续下一步（confidence >= 0.7）
          → replanning     ← 需要重规划（confidence < 0.7）
            → dispatching
          → completed      ← 所有步骤完成
          → failed         ← 超过最大循环次数或其他致命错误
      → paused             ← 人工暂停（可恢复）
```

### 状态迁移规则

代码位于 `packages/harness/src/runtime/flow-state.ts`，核心迁移表：

```typescript
const VALID_TRANSITIONS: Record<HarnessState, Set<HarnessState>> = {
  intaking:          new Set(["planning", "completed"]),
  planning:          new Set(["dispatching", "failed"]),
  dispatching:       new Set(["executing", "completed", "waiting_approval", "failed"]),
  executing:         new Set(["waiting_tool", "waiting_approval", "critiquing", "failed"]),
  waiting_tool:      new Set(["executing", "failed"]),
  waiting_approval:  new Set(["executing", "dispatching", "failed", "paused"]),
  critiquing:        new Set(["dispatching", "replanning", "waiting_approval", "completed"]),
  replanning:        new Set(["dispatching", "failed"]),
  paused:            new Set(["dispatching", "executing", "failed"]),
  completed:         new Set([]),   // 终态
  failed:            new Set([]),   // 终态
};
```

### 认知角色分离

Flow 运行时区分四种角色，防止同一实体既当运动员又当裁判：

| 角色 | 职责 | 权利 |
|------|------|------|
| **Planner** | 读取上下文，生成 ExecutionPlan | 决定"做什么" |
| **Role Agent** | 执行指定步骤，产出交付物 | 决定"怎么做" |
| **Challenger** | 独立评估每步输出，累计经验教训 | 决定"做没做好" |
| **Orchestrator** | 调度 Agent，管理上下文重置，强制执行审批 | 决定"下一步" |

**关键约束：** Role Agent 永远不能判断自己的工作是否完成——这个权利只属于 Challenger。

## Plan Mode 集成

`planAndStart()` 将自然的语言目标转换为结构化 ExecutionPlan：

1. 调用 `planFromPrompt()`，向 LLM 发送带有 Planner 系统提示词的请求
2. LLM 返回 JSON，解析为 `ExecutionPlan`
3. 解析失败时自动重试（默认最多 2 次），提示 LLM 修正格式
4. JSON 解析完全失败时降级为单步 Plan（numbered list 解析）

```typescript
// planFromPrompt 的内部流程
const plan = await planFromPrompt(goal, adapter, {
  tools: ["read_file", "write_file", "bash", "grep"],
  contextSummary: "工作目录: /home/user/my-project",
  maxRetries: 3,
  model: "claude-opus-4-7",
});
```

## 审批门控

高风险操作会触发 `waiting_approval` 状态暂停 Flow：

- **触发条件：** Critic 判断 `nextAction === "ask_human"` 或安全插件检测到危险 bash 命令
- **审批记录：** 每次审批生成 `ApprovalRecord`（含时间戳、决策）
- **恢复执行：** 审批通过后，Flow 从 `waiting_approval` 回到 `dispatching` 继续

```typescript
// 记录审批决策
const { handle: newHandle, record } = await runtime.recordApproval(
  handle, pendingAction, { approved: true, reason: "操作安全" }
);
```

## Checkpoint 与恢复

### CheckpointStore

Checkpoint 以 JSONL 格式持久化到磁盘，支持 Flow 中断后恢复：

```
<checkpointsDir>/<flowId>.checkpoints.jsonl
```

每行一个完整 `FlowCheckpoint` JSON，追加写入（崩溃安全）。

```typescript
const runtime = new HarnessRuntime(adapter, model, {
  checkpointsDir: ".vera/checkpoints",   // 必填：启用 persistence
  autoCheckpoint: true,                   // 默认 true：每步自动保存
  artifactsRootDir: ".vera/artifacts",
});
```

### 自动Checkpoint

`runFlowLoop()` 在以下时机自动保存 Checkpoint：

- 每批次步骤执行完成后
- Flow 暂停时（`waiting_approval`）
- Flow 完成或失败时

### 恢复执行

```typescript
// 从最新 Checkpoint 恢复
const handle = await runtime.resumeFromCheckpoint("auth-refactor");
if (handle) {
  await runtime.runFlowLoop(handle);
}

// 从指定步骤恢复
const handle = await runtime.resumeFromCheckpoint("auth-refactor", {
  fromStepId: "step_3",
  skipCompleted: false,   // 保留已完成步骤的状态
});
```

### Fork Flow

从已有 Checkpoint 分叉出新 Flow，共享 Plan 但独立执行：

```typescript
const forked = await runtime.forkFromCheckpoint("auth-refactor", {
  newFlowId: "auth-refactor-v2",
  newGoal: "重构认证模块 v2 — 添加 OAuth 支持",
  resetSteps: ["step_3"],  // 需要重做的步骤
});
```

### 查询 Checkpoint

```typescript
const store = runtime.getCheckpointStore();
if (store) {
  store.listFlows();                           // 所有有 Checkpoint 的 Flow
  store.list("auth-refactor");                 // 某个 Flow 的所有 Checkpoint
  store.count("auth-refactor");                // Checkpoint 数量
  store.loadLatest("auth-refactor");           // 最新 Checkpoint
  store.load("auth-refactor", "cp-xxx-yyy");   // 指定 ID Checkpoint
  store.compact("auth-refactor");              // 压缩去重
  store.clear("auth-refactor");                // 清除所有 Checkpoint
}
```

## SelfLoop 模式

`runSelfLoop()` 提供自动多轮循环，直到满足终止条件：

```typescript
const result = await runtime.runSelfLoop(handle, {
  maxCycles: 5,         // 最大循环次数
  budgetUsd: 1.0,       // 费用上限（美元）
  terminationConfidence: 0.85,  // 达到此置信度自动终止
}, criticAgent);

// result: { flow, cycles, terminationReason, totalCost }
```

## 并行执行

Flow 支持在依赖图允许的情况下并行执行多个步骤：

```typescript
await runtime.runFlowLoop(handle, {
  maxParallel: 3,  // 最多同时执行 3 步（默认 1）
});
```

步骤依赖通过 `dependsOn` 字段定义。调度器（`getDispatchableStepIds`）只选择依赖已全部完成的步骤。如果在 Plan 中检测到循环依赖，会在 `dispatchStep` 时抛出异常。

## 完整示例

```typescript
import { HarnessRuntime } from "@open-vera/openvera";
import { AnthropicAdapter } from "@open-vera/core/adapters";

// 1. 初始化 Runtime
const runtime = new HarnessRuntime(
  new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }),
  "claude-sonnet-4-6",
  {
    artifactsRootDir: ".vera/artifacts",
    checkpointsDir: ".vera/checkpoints",
    autoCheckpoint: true,
  },
);

// 2. 自动规划并启动
const handle = await runtime.planAndStart(
  "阅读 src/auth.ts，为每个导出函数编写单元测试",
  "add-auth-tests",
  { tools: ["read_file", "write_file", "bash", "grep"] },
);

// 3. 运行 Flow loop
const result = await runtime.runFlowLoop(handle, {
  maxSteps: 5,
  onEvent: (e) => console.log(`[${e.type}] ${e.stepId ?? ""}`),
});

console.log(
  `完成步骤: ${result.completedSteps.join(", ")}`,
  `状态: ${result.handle.flow.state}`,
);
```
