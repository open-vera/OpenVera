# Subagent 系统设计

> Subagent 是 Vera 的并行执行与任务隔离机制,由 Orchestrator 统一调度,Worker 独立执行,通过标准消息协议通信。

---

## 1. 核心概念

### 1.1 什么是 Subagent

Subagent 是主 agent(Orchestrator)创建的独立执行单元,用于:
- **并行处理**互不依赖的子任务
- **隔离上下文**避免探索性任务污染主会话
- **专业化执行**由特定领域的 Worker 完成任务

### 1.2 设计原则

| 原则 | 说明 |
|---|---|
| **最小上下文传递** | 只传递必要的上下文片段,不传完整历史 |
| **工具白名单** | Subagent 只能使用父 agent 授权的子集工具 |
| **独立生命周期** | 每个 subagent 是独立的 `runAgent` 调用 |
| **结果汇总** | Worker 完成后返回结构化结果,Orchestrator 负责整合 |
| **权限继承** | Subagent 继承父 agent 的 harness 约束,不能越权 |
| **可选工作区隔离** | 写代码类实验可用 `isolation: "try"` 在独立 git worktree 中执行 |

---

## 2. 何时使用 Subagent

### 2.1 决策矩阵

```
收到任务
  ↓
任务是否可以拆分为独立子任务? ──否──→ 直接执行
  ↓是
子任务之间是否相互依赖? ──是──→ 串行流水线模式
  ↓否
是否需要隔离上下文? ──是──→ 创建 Subagent
  ↓否
token 预算是否充足? ──是──→ 直接执行(避免过度拆分)
  ↓否
创建 Subagent
```

### 2.2 典型使用场景

#### ✅ 应该使用 Subagent

| 场景 | 模式 | 原因 |
|---|---|---|
| **多文件/模块分析** | 并行扇出 | 各模块独立,可并发 |
| **代码审查** | 并行扇出 | 安全/性能/质量可并行检查 |
| **研究 + 写作** | 串行流水线 | 先收集信息,再整合输出 |
| **探索性任务** | 单 Subagent | 避免污染主上下文 |
| **大任务拆分** | 递归 Subagent | 单次 context window 不足 |

#### ❌ 不应使用 Subagent

| 场景 | 原因 |
|---|---|
| 单文件读取/编辑 | 单步操作,无并行价值 |
| 简单命令执行 | 无上下文隔离需求 |
| 高度依赖主会话的任务 | 上下文传递成本过高 |
| token 预算充足的小任务 | 过度拆分增加开销 |

### 2.3 代码示例:决策逻辑

```typescript
interface SubagentDecision {
  shouldUse: boolean;
  pattern: 'parallel' | 'serial' | 'isolated' | 'none';
  reason: string;
}

function decideSubagent(
  task: Task,
  context: AgentContext
): SubagentDecision {
  // 1. 检查任务复杂度
  if (task.complexity < COMPLEXITY_THRESHOLD) {
    return { shouldUse: false, pattern: 'none', reason: '任务过于简单' };
  }

  // 2. 检查是否可并行
  if (task.subtasks && task.subtasks.length > 1) {
    const hasDependencies = task.subtasks.some(t => t.dependsOn);
    if (!hasDependencies) {
      return { shouldUse: true, pattern: 'parallel', reason: '可并行执行' };
    }
    return { shouldUse: true, pattern: 'serial', reason: '需要串行流水线' };
  }

  // 3. 检查上下文隔离需求
  if (task.isExploratory || task.riskLevel === 'high') {
    return { shouldUse: true, pattern: 'isolated', reason: '需要隔离上下文' };
  }

  // 4. 检查 token 预算
  const estimatedTokens = estimateTaskTokens(task);
  if (estimatedTokens > context.remainingBudget * 0.8) {
    return { shouldUse: true, pattern: 'parallel', reason: '超出单次 token 预算' };
  }

  return { shouldUse: false, pattern: 'none', reason: '直接执行更高效' };
}
```

---

## 3. 通信协议

### 3.1 消息类型

```typescript
type AgentMessage =
  | { type: 'task'; payload: AgentTask }
  | { type: 'result'; payload: AgentResult }
  | { type: 'progress'; payload: ProgressUpdate }
  | { type: 'error'; payload: AgentError }
  | { type: 'request_context'; payload: ContextRequest }
  | { type: 'context_response'; payload: ContextData };
```

### 3.2 任务下发协议

```typescript
interface AgentTask {
  /** 唯一任务 ID */
  task_id: string;
  
  /** 父 agent ID */
  parent_agent_id: string;
  
  /** 执行指令 */
  instruction: string;
  
  /** 允许使用的工具白名单 */
  tools: string[];
  
  /** 必要的上下文片段(非完整历史) */
  context?: string;
  
  /** 共享上下文 key 列表 */
  sharedContextKeys?: string[];
  
  /** 超时时间(毫秒) */
  timeout_ms?: number;
  
  /** 最大递归深度(防止无限拆分) */
  maxDepth?: number;
  
  /** 期望输出格式 */
  expectedOutputFormat?: 'text' | 'json' | 'structured';

  /** 执行隔离模式: none 使用父工作区; try 创建可 merge/drop 的 git worktree */
  isolation?: 'none' | 'try';
}
```

### 3.3 结果返回协议

```typescript
interface AgentResult {
  /** 对应的任务 ID */
  task_id: string;
  
  /** 执行状态 */
  status: 'success' | 'failure' | 'partial' | 'timeout';
  
  /** 输出内容 */
  output: string;
  
  /** 结构化输出(可选) */
  structuredOutput?: Record<string, unknown>;
  
  /** 工具调用记录 */
  tool_calls: ToolCallRecord[];
  
  /** Token 消耗 */
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  
  /** 执行耗时(毫秒) */
  duration_ms: number;
  
  /** 错误信息(失败时) */
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  
  /** 元数据 */
  metadata?: {
    model: string;
    turns: number;
    checkpoint_id?: string;
  };
}
```

### 3.4 进度更新协议

```typescript
interface ProgressUpdate {
  task_id: string;
  /** 进度百分比 0-100 */
  percentage: number;
  /** 当前步骤描述 */
  currentStep: string;
  /** 已完成步骤列表 */
  completedSteps: string[];
  /** 可选的中间结果 */
  interimResult?: string;
}
```

---

## 4. 上下文共享机制

### 4.1 上下文分层设计

```
┌─────────────────────────────────────┐
│        Shared Context Layer         │  ← 所有 agent 共享
│  (项目结构、用户偏好、全局知识)      │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│     Parent Context (Orchestrator)   │  ← 父 agent 私有
│  (完整会话历史、规划、决策记录)      │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│     Worker Context (Subagent)       │  ← 子 agent 私有
│  (任务指令、必要上下文片段)          │
└─────────────────────────────────────┘
```

### 4.2 上下文传递策略

#### 策略 1: 最小必要上下文

```typescript
interface ContextSnapshot {
  /** 项目根路径 */
  workspaceRoot: string;
  
  /** 相关文件路径列表 */
  relevantFiles: string[];
  
  /** 关键决策摘要(非完整对话) */
  keyDecisions: string[];
  
  /** 当前任务目标 */
  currentGoal: string;
  
  /** 约束条件 */
  constraints: {
    maxTokens: number;
    allowedTools: string[];
    timeLimit?: number;
  };
}
```

#### 策略 2: 共享上下文层

```typescript
class SharedContextManager {
  private sharedStore: Map<string, ContextEntry>;
  private subscriptions: Map<string, Set<string>>;
  
  /** 写入共享上下文 */
  set(key: string, value: any, agentId: string): void {
    this.sharedStore.set(key, {
      value,
      updatedAt: Date.now(),
      updatedBy: agentId,
    });
    
    // 通知订阅者
    this.notifySubscribers(key);
  }
  
  /** 读取共享上下文 */
  get(key: string, agentId: string): any {
    const entry = this.sharedStore.get(key);
    if (!entry) return undefined;
    
    // 记录访问
    this.recordAccess(key, agentId);
    return entry.value;
  }
  
  /** 订阅上下文变化 */
  subscribe(key: string, agentId: string): void {
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Set());
    }
    this.subscriptions.get(key)!.add(agentId);
  }
  
  /** 批量同步上下文到 subagent */
  syncToSubagent(keys: string[], subagentId: string): ContextData {
    const data: Record<string, any> = {};
    for (const key of keys) {
      data[key] = this.get(key, subagentId);
    }
    return { task_id: subagentId, context: data };
  }
}
```

### 4.3 上下文压缩规则

传递给 subagent 的上下文必须经过压缩:

```typescript
function compressContextForSubagent(
  fullHistory: Message[],
  task: AgentTask
): string {
  const compressor = new ContextCompressor();
  
  return compressor
    // 1. 保留 system prompt
    .keepSystemPrompt()
    // 2. 提取与任务相关的文件/代码片段
    .extractRelevantSnippets(task.instruction)
    // 3. 保留关键决策点
    .keepDecisionPoints()
    // 4. 移除冗余对话
    .removeRedundantChat()
    // 5. 生成任务相关摘要
    .generateTaskSummary(task)
    // 6. 控制在 token 预算内
    .limitToTokens(task.contextTokens || 8000)
    .finalize();
}
```

---

## 5. 调度器实现

### 5.1 Orchestrator 核心

```typescript
class AgentOrchestrator {
  private activeAgents: Map<string, AgentHandle>;
  private messageQueue: PriorityQueue<AgentMessage>;
  private sharedContext: SharedContextManager;
  private results: Map<string, AgentResult>;
  
  /** 创建 subagent */
  async spawnAgent(config: {
    id: string;
    instruction: string;
    tools: string[];
    context?: Partial<ContextSnapshot>;
    sharedContextKeys?: string[];
    timeoutMs?: number;
  }): Promise<AgentHandle> {
    // 1. 构建任务描述
    const task: AgentTask = {
      task_id: config.id,
      parent_agent_id: this.parentId,
      instruction: config.instruction,
      tools: config.tools,
      context: config.context ? JSON.stringify(config.context) : undefined,
      sharedContextKeys: config.sharedContextKeys,
      timeout_ms: config.timeoutMs,
    };
    
    // 2. 同步共享上下文
    if (config.sharedContextKeys) {
      const contextData = this.sharedContext.syncToSubagent(
        config.sharedContextKeys,
        config.id
      );
      // 注入到 subagent
      await this.injectContext(config.id, contextData);
    }
    
    // 3. 创建 agent handle
    const handle = new AgentHandle({
      id: config.id,
      task,
      onProgress: (update) => this.forwardProgress(update),
      onComplete: (result) => this.collectResult(result),
    });
    
    this.activeAgents.set(config.id, handle);
    
    // 4. 启动执行
    handle.start();
    
    return handle;
  }
  
  /** 并行扇出 */
  async parallelFanOut(
    tasks: Array<{ id: string; instruction: string; tools: string[] }>
  ): Promise<AgentResult[]> {
    const handles = await Promise.all(
      tasks.map(t => this.spawnAgent(t))
    );
    
    // 等待所有完成
    const results = await Promise.all(
      handles.map(h => h.waitForResult())
    );
    
    return results;
  }
  
  /** 串行流水线 */
  async serialPipeline(
    steps: Array<{
      id: string;
      instruction: string;
      tools: string[];
      transformInput?: (prevResult: AgentResult) => string;
    }>
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    
    for (const step of steps) {
      // 上一步结果作为输入
      const input = results.length > 0 && step.transformInput
        ? step.transformInput(results[results.length - 1])
        : step.instruction;
      
      const result = await this.spawnAgent({
        id: step.id,
        instruction: input,
        tools: step.tools,
      }).then(h => h.waitForResult());
      
      results.push(result);
      
      // 失败快速返回
      if (result.status === 'failure') {
        throw new Error(`Step ${step.id} failed: ${result.error?.message}`);
      }
    }
    
    return results;
  }
  
  /** 收集结果 */
  private collectResult(result: AgentResult): void {
    this.results.set(result.task_id, result);
    this.activeAgents.delete(result.task_id);
    
    // 更新共享上下文
    if (result.status === 'success') {
      this.sharedContext.set(
        `result:${result.task_id}`,
        result.output,
        result.task_id
      );
    }
  }
  
  /** 汇总所有结果 */
  aggregateResults(taskIds: string[]): AggregatedResult {
    const results = taskIds.map(id => this.results.get(id)!);
    
    return {
      taskIds,
      results,
      totalUsage: results.reduce((sum, r) => ({
        prompt_tokens: sum.prompt_tokens + r.usage.prompt_tokens,
        completion_tokens: sum.completion_tokens + r.usage.completion_tokens,
        total_tokens: sum.total_tokens + r.usage.total_tokens,
      }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
      totalDurationMs: Math.max(...results.map(r => r.duration_ms)),
    };
  }
}
```

### 5.2 Agent Handle

```typescript
class AgentHandle {
  readonly id: string;
  private promise: Promise<AgentResult>;
  private resolve!: (result: AgentResult) => void;
  private reject!: (error: Error) => void;
  
  constructor(config: {
    id: string;
    task: AgentTask;
    onProgress?: (update: ProgressUpdate) => void;
    onComplete?: (result: AgentResult) => void;
  }) {
    this.id = config.id;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
  
  /** 启动执行 */
  start(): void {
    // 实际调用 runAgent
    runAgent({
      instruction: this.task.instruction,
      tools: this.task.tools,
      context: this.task.context,
      maxDepth: this.task.maxDepth || 3,
      onProgress: (update) => this.emitProgress(update),
    })
      .then(result => {
        this.resolve(result);
        this.config.onComplete?.(result);
      })
      .catch(error => this.reject(error));
  }
  
  /** 等待结果 */
  async waitForResult(): Promise<AgentResult> {
    return this.promise;
  }
  
  /** 取消执行 */
  cancel(): void {
    // 发送取消信号
    this.reject(new Error('Task cancelled'));
  }
  
  private emitProgress(update: ProgressUpdate): void {
    this.config.onProgress?.(update);
  }
}
```

---

## 6. 典型模式

### 6.1 并行扇出(Fan-Out)

**适用场景**: 多个独立子任务可并发执行

```
                    ┌─ SubAgent A: 分析 frontend
Orchestrator ───────┼─ SubAgent B: 分析 backend
                    └─ SubAgent C: 查询文档
                         ↓ (全部完成后)
                    整合结果 → 最终回答
```

**示例代码**:

```typescript
// 场景: 全面代码审查
const orchestrator = new AgentOrchestrator();

const results = await orchestrator.parallelFanOut([
  {
    id: 'security-review',
    instruction: '审查以下代码的安全漏洞',
    tools: ['read_file', 'grep_text'],
  },
  {
    id: 'performance-review',
    instruction: '分析以下代码的性能问题',
    tools: ['read_file', 'grep_text'],
  },
  {
    id: 'quality-review',
    instruction: '评估代码质量和可维护性',
    tools: ['read_file', 'grep_text'],
  },
]);

// 整合审查结果
const report = integrateReviews(results);
```

### 6.2 串行流水线(Pipeline)

**适用场景**: 步骤间存在依赖,需要顺序执行

```
Researcher → Analyzer → Writer → Reviewer
   ↓            ↓          ↓         ↓
 收集信息    分析数据    生成报告    质量检查
```

**示例代码**:

```typescript
// 场景: 技术调研报告
const results = await orchestrator.serialPipeline([
  {
    id: 'researcher',
    instruction: '调研当前项目中使用的认证方案',
    tools: ['read_file', 'grep_text', 'web_search'],
  },
  {
    id: 'analyzer',
    instruction: '分析调研结果,对比最佳实践',
    tools: ['read_file'],
    transformInput: (prevResult) => 
      `基于以下调研结果进行分析:\n${prevResult.output}`,
  },
  {
    id: 'writer',
    instruction: '撰写技术评估报告',
    tools: ['write_file'],
    transformInput: (prevResult) =>
      `根据以下分析撰写报告:\n${prevResult.output}`,
  },
  {
    id: 'reviewer',
    instruction: '审查报告质量和完整性',
    tools: ['read_file'],
    transformInput: (prevResult) =>
      `审查以下报告:\n${prevResult.output}`,
  },
]);

const finalReport = results[results.length - 1].output;
```

### 6.3 递归 Subagent

**适用场景**: 子任务过大,需要进一步拆分

```
Orchestrator (depth=0)
  └─ SubAgent A (depth=1)
       └─ SubAgent A1 (depth=2)
            └─ SubAgent A1a (depth=3, 达到上限)
```

**约束**:
- 设置 `maxDepth` 防止无限递归(建议 3-5)
- 每次递归传递深度递减
- 达到深度限制时,subagent 必须直接执行

```typescript
// Subagent 内部再次拆分时
function delegateTask(task: Task, currentDepth: number): AgentResult {
  if (currentDepth >= MAX_DEPTH) {
    // 达到深度限制,直接执行
    return executeDirectly(task);
  }
  
  // 继续拆分
  return orchestrator.spawnAgent({
    ...task,
    maxDepth: currentDepth + 1,
  });
}
```

### 6.4 隔离探索模式

**适用场景**: 探索性任务,不希望污染主上下文

```typescript
// 场景: 尝试不同的实现方案
const exploration = await orchestrator.spawnAgent({
  id: 'explore-alternative',
  instruction: '探索使用 Redux 替代当前状态管理方案的可行性',
  tools: ['read_file', 'grep_text', 'web_search'],
  context: {
    currentGoal: '评估状态管理方案迁移',
    relevantFiles: ['src/store/index.ts', 'src/store/types.ts'],
    keyDecisions: ['当前方案存在性能瓶颈'],
  },
});

// 探索结果不会影响主会话,Orchestrator 可选择性采用
if (exploration.status === 'success') {
  console.log('探索结果:', exploration.output);
  // 决定是否采用...
}
```

---

## 7. 错误处理与恢复

### 7.1 错误分类

```typescript
enum SubagentErrorType {
  /** 可重试错误: 网络超时、API 限流 */
  TRANSIENT = 'transient',
  
  /** 不可重试错误: 参数错误、权限不足 */
  FATAL = 'fatal',
  
  /** 超时: 执行超过 timeout_ms */
  TIMEOUT = 'timeout',
  
  /** 递归深度限制 */
  DEPTH_LIMIT = 'depth_limit',
  
  /** Token 预算不足 */
  BUDGET_EXHAUSTED = 'budget_exhausted',
}
```

### 7.2 重试策略

```typescript
async function executeWithRetry(
  task: AgentTask,
  options: {
    maxRetries?: number;
    backoffMs?: number;
    retryableErrors?: SubagentErrorType[];
  } = {}
): Promise<AgentResult> {
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 1000;
  const retryableErrors = options.retryableErrors ?? [
    SubagentErrorType.TRANSIENT,
    SubagentErrorType.TIMEOUT,
  ];
  
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await executeTask(task);
      
      if (result.status === 'success' || result.status === 'partial') {
        return result;
      }
      
      // 检查是否可重试
      if (result.error && !retryableErrors.includes(result.error.code as SubagentErrorType)) {
        return result; // 不可重试,直接返回
      }
      
      lastError = new Error(result.error?.message);
    } catch (error) {
      lastError = error as Error;
    }
    
    // 指数退避
    if (attempt < maxRetries) {
      await sleep(backoffMs * Math.pow(2, attempt));
    }
  }
  
  // 所有重试失败
  return {
    task_id: task.task_id,
    status: 'failure',
    output: '',
    tool_calls: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    duration_ms: 0,
    error: {
      code: SubagentErrorType.TRANSIENT,
      message: `All ${maxRetries + 1} attempts failed. Last error: ${lastError?.message}`,
      retryable: false,
    },
  };
}
```

### 7.3 部分失败处理

当并行任务中部分 subagent 失败时:

```typescript
function handlePartialFailure(results: AgentResult[]): {
  successful: AgentResult[];
  failed: AgentResult[];
  canProceed: boolean;
} {
  const successful = results.filter(r => r.status === 'success');
  const failed = results.filter(r => r.status === 'failure');
  
  // 决策: 是否能继续
  const canProceed = successful.length > 0 && 
    successful.length >= results.length * 0.5; // 至少 50% 成功
  
  return { successful, failed, canProceed };
}
```

---

## 8. Token 预算管理

### 8.1 预算分配策略

```typescript
interface BudgetAllocation {
  /** 总预算 */
  totalBudget: number;
  
  /** Orchestrator 保留预算 */
  orchestratorReserve: number; // 通常 20-30%
  
  /** 每个 subagent 的平均预算 */
  perAgentBudget: number;
  
  /** 最大 subagent 数量 */
  maxAgents: number;
}

function calculateBudget(
  totalBudget: number,
  estimatedSubagents: number
): BudgetAllocation {
  const reserveRatio = 0.25; // Orchestrator 保留 25%
  const orchestratorReserve = totalBudget * reserveRatio;
  const availableForSubagents = totalBudget - orchestratorReserve;
  
  return {
    totalBudget,
    orchestratorReserve,
    perAgentBudget: Math.floor(availableForSubagents / estimatedSubagents),
    maxAgents: Math.max(1, estimatedSubagents),
  };
}
```

### 8.2 使用量汇总

```typescript
function aggregateUsage(results: AgentResult[]): UsageSummary {
  return {
    totalPromptTokens: results.reduce((sum, r) => sum + r.usage.prompt_tokens, 0),
    totalCompletionTokens: results.reduce((sum, r) => sum + r.usage.completion_tokens, 0),
    totalTokens: results.reduce((sum, r) => sum + r.usage.total_tokens, 0),
    totalCost: calculateCost(results),
    perAgentBreakdown: results.map(r => ({
      taskId: r.task_id,
      tokens: r.usage.total_tokens,
      cost: calculateCost([r]),
    })),
  };
}
```

---

## 9. Harness 集成

### 9.1 权限继承

Subagent 继承父 agent 的 harness 约束:

```typescript
interface InheritedPermissions {
  /** 工具白名单(子集) */
  allowedTools: string[];
  
  /** 工作目录限制 */
  allowedDirectories: string[];
  
  /** 网络域名白名单 */
  allowedDomains?: string[];
  
  /** 最大 token 预算 */
  maxTokens: number;
  
  /** 超时时间 */
  timeoutMs?: number;
  
  /** 高风险操作需要审批 */
  requireApprovalFor: string[];
}
```

### 9.2 审计日志

每个 subagent 的执行记录必须写入审计日志:

```typescript
interface SubagentAuditLog {
  timestamp: string;
  parentAgentId: string;
  subagentId: string;
  task: string;
  status: string;
  tokensUsed: number;
  durationMs: number;
  toolsUsed: string[];
  riskLevel: 'low' | 'medium' | 'high';
  approvalRequired: boolean;
  approvalGranted?: boolean;
}
```

---

## 10. 实现清单

### P1 阶段(当前)

- [x] `agent` tool 基础协议：`description` / `prompt` / `subagent_type` / `allowedTools` / `maxTurns`
- [x] sidechain session：子 agent transcript 独立记录,父 agent 只接收 summary
- [x] 自定义 agent definitions：用户级与项目级 `.vera/agents/*.md`
- [x] 工具策略：内置 `general-purpose` / `explore` / `plan`,支持 readonly 与 allow/disallow tools
- [x] try worktree isolation：`isolation: "try"` 创建独立 worktree,工具调用在 worktree cwd 执行
- [x] 采纳路径：try-isolated 子 agent 记录 branch metadata,可通过 `/merge <id-prefix>` 应用回原工作区
- [ ] `AgentTask` / `AgentResult` 完整消息协议定义
- [ ] `AgentOrchestrator` 基础实现
- [ ] 并行扇出 (`parallelFanOut`)
- [ ] 串行流水线 (`serialPipeline`)
- [ ] 最小必要上下文传递
- [ ] 基础错误处理与重试
- [ ] Token 预算追踪

### P2 阶段

- [ ] 共享上下文管理器 (`SharedContextManager`)
- [ ] 上下文压缩与摘要
- [ ] 递归 subagent 支持
- [ ] 进度更新实时推送
- [ ] 部分失败恢复策略
- [ ] 审计日志集成

### P3 阶段

- [ ] 自适应预算分配
- [ ] Subagent 性能监控
- [ ] 动态调度策略优化
- [ ] 失败模式自动学习
- [ ] 可视化的 subagent 树

---

## 11. 最佳实践

### ✅ DO

| 实践 | 原因 |
|---|---|
| 传递最小必要上下文 | 控制 token 消耗 |
| 设置合理的 `maxDepth` | 防止无限递归 |
| 使用工具白名单 | 权限最小化 |
| 并行独立任务 | 提升吞吐量 |
| 失败时快速返回 | 避免浪费时间 |

### ❌ DON'T

| 实践 | 原因 |
|---|---|
| 传递完整对话历史 | token 浪费 |
| 创建过深递归 | 复杂度爆炸 |
| subagent 使用全量工具 | 安全风险 |
| 忽略错误处理 | 难以调试 |
| 过度拆分小任务 | 增加开销 |

---

## 12. 与相关系统对比

| 系统 | Subagent 支持 | 特点 |
|---|---|---|
| **Claude Code** | ✅ Subagent | 并行文件分析,独立上下文 |
| **Codex** | ✅ Sandbox | 隔离执行环境 |
| **LangChain** | ✅ Agent Executor | 灵活但需手动编排 |
| **AutoGen** | ✅ Multi-Agent | 对话式多 agent |
| **Vera** | ✅ Subagent + SharedContext | 共享上下文层 + Harness 集成 |

Vera 的差异化优势:
1. **共享上下文层**: 不传递完整历史,而是按需同步 key-value
2. **Harness 集成**: 权限继承、审计日志、审批门
3. **预算管理**: 自动 token 预算分配与追踪
4. **标准化协议**: 与 intent-routing、plan mode 无缝集成

---

## 附录 A: 完整示例

### 场景: 大型代码重构

```typescript
const orchestrator = new AgentOrchestrator();

// 1. 并行分析多个模块
const analysisResults = await orchestrator.parallelFanOut([
  {
    id: 'analyze-auth',
    instruction: '分析认证模块的依赖关系和复杂度',
    tools: ['read_file', 'grep_text'],
  },
  {
    id: 'analyze-api',
    instruction: '分析 API 路由层的依赖关系和复杂度',
    tools: ['read_file', 'grep_text'],
  },
  {
    id: 'analyze-db',
    instruction: '分析数据库访问层的依赖关系和复杂度',
    tools: ['read_file', 'grep_text'],
  },
]);

// 2. 基于分析结果制定重构计划
const plan = generateRefactorPlan(analysisResults);

// 3. 串行执行重构步骤
const refactorResults = await orchestrator.serialPipeline([
  {
    id: 'update-types',
    instruction: `更新类型定义,计划:\n${plan.typeChanges}`,
    tools: ['read_file', 'write_file'],
  },
  {
    id: 'refactor-core',
    instruction: `重构核心逻辑,计划:\n${plan.coreChanges}`,
    tools: ['read_file', 'write_file', 'bash'],
    transformInput: (prev) => 
      `类型定义已更新,基于以下继续重构:\n${prev.output}`,
  },
  {
    id: 'run-tests',
    instruction: '运行测试验证重构结果',
    tools: ['bash'],
    transformInput: (prev) => 
      `重构完成,运行测试验证:\n${prev.output}`,
  },
]);

// 4. 汇总结果
const summary = orchestrator.aggregateUsage(refactorResults);
console.log(`重构完成,消耗 ${summary.totalTokens} tokens`);
```

---

## 参考文档

- [agent-design.md](./agent-design.md) - Agent 能力版图总览
- [intent-routing.md](./intent-routing.md) - 意图识别与模型路由
- [runtime-design.md](./runtime-design.md) - Core runtime 设计
- [harness/design.md](../harness/design.md) - Harness 内核设计
