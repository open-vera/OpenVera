# 自动化开发方案（v2 — 自举模式）

> 用 Vera 自身的 Flow 能力驱动 Vera 的开发

## 核心理念

不是写 shell 脚本调 LLM，而是 **Vera 开发 Vera**：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Vera 自举开发架构                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Orchestrator (主控)                       │  │
│  │                                                           │  │
│  │  读 roadmap → 拆任务 → 分发到并行 Flow → 汇总结果          │  │
│  └─────────────┬─────────────┬─────────────┬─────────────────┘  │
│                │             │             │                    │
│           ┌────▼────┐  ┌────▼────┐  ┌────▼────┐               │
│           │ Flow A  │  │ Flow B  │  │ Flow C  │               │
│           │ task S1 │  │ task S2 │  │ task S3 │               │
│           │         │  │         │  │         │               │
│           │ SelfLoop│  │ SelfLoop│  │ SelfLoop│               │
│           │ Runner  │  │ Runner  │  │ Runner  │               │
│           └────┬────┘  └────┬────┘  └────┬────┘               │
│                │             │             │                    │
│           ┌────▼─────────────▼─────────────▼────┐              │
│           │        Execution Layer              │              │
│           │                                     │              │
│           │  Claude Code / Hermes Agent         │              │
│           │  - 编码                              │              │
│           │  - 测试                              │              │
│           │  - Git 操作                          │              │
│           └─────────────────────────────────────┘              │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Shared Infrastructure                    │  │
│  │                                                           │  │
│  │  - CriticAgent: 质量评估                                  │  │
│  │  - FailureAttributor: 失败归因                            │  │
│  │  - CheckpointStore: 断点恢复                              │  │
│  │  - Tool Runtime: 文件/命令/测试工具                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 与 v1 的区别

| 维度 | v1 (shell 脚本) | v2 (自举模式) |
|------|----------------|---------------|
| 执行引擎 | bash + curl LLM API | Vera Harness Flow |
| 并发 | 不支持 | 并行 Flow 实例 |
| 质量控制 | 手动 critique | CriticAgent 内置 |
| 失败恢复 | 手动 | CheckpointStore 自动恢复 |
| 迭代 | while 循环 | SelfLoopRunner 自动循环 |
| 可观测性 | 日志文件 | JSONL session trace |
| 自身进化 | 不感知 | 用自己开发自己 |

## 架构设计

### 1. Orchestrator（主控）

```typescript
// packages/harness/src/auto-dev/orchestrator.ts

interface DevOrchestrator {
  // 从 roadmap 提取任务
  extractTasks(phase: number): Task[];
  
  // 按依赖关系分组（可并行 vs 必须串行）
  scheduleTasks(tasks: Task[]): TaskGroup[];
  
  // 并行执行一组任务
  executeParallel(tasks: Task[]): Promise<TaskResult[]>;
  
  // 汇总结果，更新 roadmap
  summarize(results: TaskResult[]): void;
}
```

### 2. DevFlow（单任务开发 Flow）

```typescript
// packages/harness/src/auto-dev/dev-flow.ts

interface DevFlow {
  // 标准开发步骤
  steps: [
    'analyze',      // 1. 分析任务需求
    'implement',    // 2. 生成代码实现
    'test',         // 3. 编写并运行测试
    'critique',     // 4. 质量评估
    'fix',          // 5. 根据 critique 修复
    'commit',       // 6. 提交代码
  ];
  
  // 使用 SelfLoopRunner 驱动
  runner: SelfLoopRunner;
  
  // Critique 作为终止条件
  critic: CriticAgent;
}
```

### 3. Execution Layer（执行层）

实际的编码/测试由 Claude Code 或 Hermes Agent 执行：

```typescript
// packages/harness/src/auto-dev/executors/

interface TaskExecutor {
  // 读取相关代码
  readContext(task: Task): Promise<CodeContext>;
  
  // 生成实现代码
  implement(task: Task, context: CodeContext): Promise<FileChange[]>;
  
  // 编写测试
  writeTests(task: Task, impl: FileChange[]): Promise<FileChange[]>;
  
  // 运行测试
  runTests(task: Task): Promise<TestResult>;
  
  // 提交到 git
  commit(task: Task, changes: FileChange[]): Promise<string>;
}
```

## 并发模型

```
                    ┌─────────────────┐
                    │   Task Queue    │
                    │                 │
                    │  S1, S2, S3...  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
        │          │  │          │  │          │
        │  S1      │  │  S2      │  │  S3      │
        │  branch  │  │  branch  │  │  branch  │
        │  auto/S1 │  │  auto/S2 │  │  auto/S3 │
        └──────────┘  └──────────┘  └──────────┘
              │              │              │
              └──────────────┼──────────────┘
                             ▼
                    ┌─────────────────┐
                    │  Merge & PR     │
                    │                 │
                    │  合并到 main    │
                    └─────────────────┘
```

### 并发规则

- **不同文件** → 可并行
- **同文件不同函数** → 可并行（需 merge）
- **同文件同函数** → 必须串行
- **有数据依赖** → 必须串行

### Worker 隔离

每个 Worker 有独立的：
- Git worktree（避免文件冲突）
- 测试环境（避免端口/进程冲突）
- Session trace（独立可观测性）

## 使用方法

### 1. 启动单任务 Flow

```typescript
import { DevFlow } from '@vera/harness/auto-dev';

const flow = new DevFlow({
  task: { id: 'S1', description: '...' },
  executor: 'claude-code',  // or 'hermes'
  maxCycles: 5,
  targetConfidence: 0.9,
});

const result = await flow.run();
```

### 2. 启动并行开发

```typescript
import { DevOrchestrator } from '@vera/harness/auto-dev';

const orch = new DevOrchestrator({
  phase: 1,
  maxConcurrency: 3,
  executor: 'claude-code',
});

await orch.run();
```

### 3. CLI 入口

```bash
# 单任务
vera auto-dev run S1

# 整个 Phase（并行）
vera auto-dev phase 1 --concurrency 3

# 查看状态
vera auto-dev status

# 查看报告
vera auto-dev report
```

## 实施步骤

### Phase 1: 基础设施
1. 创建 `packages/harness/src/auto-dev/` 模块
2. 定义 Task / TaskResult / DevFlowConfig 类型
3. 实现 TaskExtractor（从 roadmap 提取任务）

### Phase 2: DevFlow 实现
4. 实现 DevFlow（基于 SelfLoopRunner）
5. 接入 CriticAgent 做质量评估
6. 接入 FailureAttributor 做失败归因

### Phase 3: 执行层
7. 实现 ClaudeCodeExecutor（调用 Claude Code CLI）
8. 实现 HermesExecutor（调用 Hermes Agent）
9. 实现 GitWorktree 管理（并发隔离）

### Phase 4: Orchestrator
10. 实现任务调度（依赖分析 + 并发控制）
11. 实现结果汇总（合并 PR + 更新 roadmap）
12. 实现 CLI 入口

### Phase 5: 自举
13. 用 Vera auto-dev 开发 Vera 自身
14. 迭代优化（用 Critique 改进 auto-dev 本身）
