# 自动化迭代方案（v2 — SelfLoopRunner 驱动）

> 用 Vera 自己的 SelfLoopRunner + CriticAgent 驱动迭代

## 核心理念

迭代不是 while 循环，而是 **SelfLoopRunner 的自然行为**：

```
┌─────────────────────────────────────────────────────────┐
│                  SelfLoopRunner                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐             │
│  │ Cycle 1 │───▶│ Cycle 2 │───▶│ Cycle 3 │───▶ done    │
│  │         │    │         │    │         │             │
│  │ execute │    │ execute │    │ execute │             │
│  │ critique│    │ critique│    │ critique│             │
│  │ replan  │    │ replan  │    │ ✅      │             │
│  └─────────┘    └─────────┘    └─────────┘             │
│                                                         │
│  终止条件:                                               │
│  - confidence ≥ 0.9                                     │
│  - maxCycles 达到上限                                    │
│  - 连续 critique 无新问题                                │
│  - budget 超限                                           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## SelfLoopRunner 配置

```typescript
// packages/harness/src/auto-dev/dev-flow.ts

const devLoopConfig: SelfLoopConfig = {
  // 终止条件
  maxCycles: 5,
  targetConfidence: 0.9,
  
  // 死循环检测
  repeatDetection: {
    enabled: true,
    maxConsecutiveSimilar: 2,
    similarityThreshold: 0.8,
  },
  
  // 预算控制
  budget: {
    maxUsd: 2.0,           // 单任务最多 $2
    maxTokens: 100_000,    // 单任务最多 100k tokens
  },
  
  // Critic 配置
  critic: new CriticAgent({
    model: 'claude-sonnet-4',
    // 自定义 critique 提示词
    prompt: devCritiquePrompt,
  }),
  
  // 失败归因
  failureAttributor: new FailureAttributor(),
  
  // Checkpoint（可恢复）
  checkpointStore: new SQLiteCheckpointStore(),
};
```

## Critique 维度

针对开发任务的 Critique 评估：

```typescript
// packages/harness/src/auto-dev/critique-prompt.ts

const devCritiquePrompt = `
评估本次代码实现的质量：

## 任务
{task_description}

## 实现
{implementation_diff}

## 测试结果
{test_output}

## 覆盖率
{coverage_report}

请评估以下维度（0-1）：

1. **正确性** (0.4 权重)
   - 代码是否正确实现了需求？
   - 是否有逻辑错误？
   - 边界条件是否处理？

2. **完整性** (0.25 权重)
   - 是否覆盖所有需求点？
   - 是否有遗漏的场景？

3. **测试充分性** (0.2 权重)
   - 测试覆盖率是否达标（≥90%）？
   - 是否测试了边界条件？
   - 是否测试了错误路径？

4. **代码质量** (0.15 权重)
   - 是否符合项目规范？
   - 是否有代码异味？
   - 是否易于理解和维护？

输出 JSON:
{
  "score": 0.85,
  "confidence": 0.9,
  "dimensions": {
    "correctness": { "score": 0.9, "issues": [...] },
    "completeness": { "score": 0.8, "issues": [...] },
    "test_coverage": { "score": 0.85, "issues": [...] },
    "code_quality": { "score": 0.85, "issues": [...] }
  },
  "issues": [...],
  "nextAction": "replan" | "complete" | "retry" | "ask_human"
}
`;
```

## 迭代策略

### 策略 1: 保守模式（默认）

```
Cycle 1: 实现基本功能 → 测试 → critique
Cycle 2: 修复 critique 指出的问题 → 测试 → critique
Cycle 3: 补充测试覆盖 → 测试 → critique
...
直到 score ≥ 0.9 或 maxCycles
```

### 策略 2: 激进模式

```
Cycle 1: 完整实现 + 完整测试 → critique
Cycle 2: 一次性修复所有问题 → critique
...
适合简单任务，减少迭代次数
```

### 策略 3: 渐进模式

```
Cycle 1: 最小可用实现 → critique
Cycle 2: 添加核心功能 → critique
Cycle 3: 添加边界处理 → critique
Cycle 4: 优化测试覆盖 → critique
...
适合复杂任务，逐步构建
```

## 失败归因与恢复

```typescript
// 自动归因失败原因
const failure = await failureAttributor.analyze({
  task: currentTask,
  error: testFailure,
  context: currentContext,
});

// 根据归因结果决定下一步
switch (failure.category) {
  case 'model':
    // LLM 生成的代码有问题
    // → 重新生成，补充上下文
    return { action: 'replan', extraContext: failure.suggestedContext };
    
  case 'tool':
    // 测试工具/环境问题
    // → 尝试修复环境，或报告
    return { action: failure.canAutoFix ? 'retry' : 'ask_human' };
    
  case 'context':
    // 缺少必要的上下文
    // → 补充上下文后重试
    return { action: 'retry', context: failure.suggestedContext };
    
  case 'permission':
    // 权限问题
    // → 需要人工介入
    return { action: 'ask_human', reason: failure.rootCause };
    
  case 'plan_deviation':
    // 实现偏离计划
    // → 重新规划
    return { action: 'replan', reason: failure.rootCause };
}
```

## Checkpoint 恢复

长任务可以中断后恢复：

```typescript
// 保存 checkpoint
await checkpointStore.save({
  taskId: 'S1',
  cycle: 3,
  state: {
    files: changedFiles,
    testResults: lastTestResult,
    critique: lastCritique,
  },
});

// 恢复 checkpoint
const checkpoint = await checkpointStore.load('S1');
if (checkpoint) {
  await devFlow.resume(checkpoint);
}
```

## 并行迭代

多个任务并行迭代时：

```
┌─────────────────────────────────────────────────────────┐
│                  Orchestrator                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Flow A   │  │ Flow B   │  │ Flow C   │              │
│  │ S1       │  │ S2       │  │ S3       │              │
│  │          │  │          │  │          │              │
│  │ Cycle 1  │  │ Cycle 1  │  │ Cycle 1  │              │
│  │ Cycle 2  │  │ Cycle 2  │  │ ...      │              │
│  │ Cycle 3  │  │ ✅ done  │  │ Cycle 4  │              │
│  │ ✅ done  │  │          │  │ ✅ done  │              │
│  └──────────┘  └──────────┘  └──────────┘              │
│       │              │              │                   │
│       └──────────────┼──────────────┘                   │
│                      ▼                                  │
│              ┌───────────────┐                          │
│              │   Merge PRs   │                          │
│              └───────────────┘                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 并发控制

```typescript
const orchestrator = new DevOrchestrator({
  maxConcurrency: 3,        // 最多 3 个并行 Flow
  
  // 任务依赖分析
  dependencyAnalyzer: (tasks) => {
    // 分析任务之间的文件依赖
    return buildDependencyGraph(tasks);
  },
  
  // 冲突检测
  conflictDetector: (taskA, taskB) => {
    // 检查是否修改同一文件
    return hasFileOverlap(taskA.files, taskB.files);
  },
});
```

## 可观测性

### JSONL Trace

每个 Flow 的完整执行记录：

```jsonl
{"type":"flow_start","task_id":"S1","timestamp":"2026-05-27T14:30:00Z"}
{"type":"cycle_start","cycle":1,"timestamp":"..."}
{"type":"step","name":"implement","duration_ms":45000,"files_changed":2}
{"type":"step","name":"test","duration_ms":12000,"passed":15,"failed":0}
{"type":"critique","score":0.72,"confidence":0.85,"issues":3}
{"type":"cycle_end","cycle":1,"action":"replan","timestamp":"..."}
{"type":"cycle_start","cycle":2,"timestamp":"..."}
...
{"type":"flow_end","task_id":"S1","cycles":3,"final_score":0.92,"duration_ms":272000}
```

### 实时监控

```bash
# 查看所有运行中的 Flow
vera auto-dev status

# 输出
┌────────┬─────────┬─────────┬──────────┬───────────┐
│ Task   │ Status  │ Cycle   │ Score    │ Duration  │
├────────┼─────────┼─────────┼──────────┼───────────┤
│ S1     │ running │ 2/5     │ 0.85     │ 2m 30s    │
│ S2     │ done    │ 3/5     │ 0.92     │ 4m 15s    │
│ S3     │ queued  │ -       │ -        │ -         │
└────────┴─────────┴─────────┴──────────┴───────────┘
```

## 与 Vera 进化闭环集成

自动化迭代本身就是 Vera 进化能力的体现：

```
Vera 开发 Vera
     │
     ▼
┌─────────────────┐
│  Auto-Dev Flow  │ ← 用 SelfLoopRunner
│                 │
│  implement      │ ← 用 Tool Runtime
│  test           │ ← 用 Vitest Runner
│  critique       │ ← 用 CriticAgent
│  fix            │ ← 用 FailureAttributor
│  commit         │ ← 用 Git Tools
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Vera 变得更强   │
│                 │
│  新能力         │
│  更好的测试     │
│  更好的 critique│
└────────┬────────┘
         │
         ▼
    下一轮自举
```

这就是 **自我进化** 的闭环。
