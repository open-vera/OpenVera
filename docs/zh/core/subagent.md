# Subagent 系统设计

> Subagent 是 Vera 的并行执行和任务隔离机制，由编排器（Orchestrator）统一调度，Worker 独立执行，通过标准消息协议通信。

---

## 1. 核心概念

### 1.1 什么是 Subagent

Subagent 是由主 Agent（编排器）创建的独立执行单元，用于：

- **并行处理**相互独立的子任务
- **上下文隔离**，防止探索性任务污染主会话
- **专项执行**，由领域特定的 Worker 处理

### 1.2 设计原则

| 原则 | 说明 |
|---|---|
| **最小上下文传递** | 只传递必要的上下文片段，不传完整历史 |
| **工具白名单** | Subagent 只能使用父 Agent 授权的工具子集 |
| **独立生命周期** | 每个 Subagent 是一次独立的 `runAgent` 调用 |
| **结果聚合** | Worker 返回结构化结果，编排器负责整合 |
| **权限继承** | Subagent 继承父 Agent 的 Harness 约束，不可越权 |
| **可选工作区隔离** | 代码编写实验可使用 `isolation: "try"` 在独立 git worktree 中执行 |

---

## 2. 何时使用 Subagent

### 2.1 决策矩阵

```
接收任务
  |
  任务是否可分解为独立子任务？ --否--> 直接执行
  | 是
  子任务之间是否相互依赖？ --是--> 串行流水线模式
  | 否
  是否需要上下文隔离？ --是--> 创建 Subagent
  | 否
  Token 预算是否充足？ --是--> 直接执行（避免过度分解）
  | 否
  创建 Subagent
```

### 2.2 典型使用场景

**应该使用 Subagent：**

| 场景 | 模式 | 原因 |
|---|---|---|
| **多文件/模块分析** | 并行扇出 | 模块独立，可并发执行 |
| **代码审查** | 并行扇出 | 安全/性能/质量可并行检查 |
| **调研 + 写作** | 串行流水线 | 先收集信息，再整合输出 |
| **探索性任务** | 单个 Subagent | 避免污染主上下文 |
| **大任务分解** | 递归 Subagent | 超出单上下文窗口 |

**不应使用 Subagent：**

| 场景 | 原因 |
|---|---|
| 单文件读取/编辑 | 单步操作，无并行价值 |
| 简单命令执行 | 无需上下文隔离 |
| 高度依赖主会话的任务 | 上下文传递成本过高 |
| Token 预算充足的小任务 | 过度分解增加开销 |

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

### 3.2 任务分发协议

```typescript
interface AgentTask {
  task_id: string;
  parent_agent_id: string;
  instruction: string;
  tools: string[];                    // 允许使用的工具白名单
  context?: string;                   // 必要的上下文片段（非完整历史）
  sharedContextKeys?: string[];       // 共享上下文键列表
  timeout_ms?: number;
  maxDepth?: number;                  // 最大递归深度（防止无限分解）
  expectedOutputFormat?: 'text' | 'json' | 'structured';
  isolation?: 'none' | 'try';        // 执行隔离模式
}
```

### 3.3 结果协议

```typescript
interface AgentResult {
  task_id: string;
  status: 'success' | 'failure' | 'partial' | 'timeout';
  output: string;
  structuredOutput?: Record<string, unknown>;
  tool_calls: ToolCallRecord[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  duration_ms: number;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  metadata?: {
    model: string;
    turns: number;
    checkpoint_id?: string;
  };
}
```

---

## 4. 上下文共享机制

### 4.1 上下文分层

```
+-------------------------------------------+
|        共享上下文层                         |  <- 所有 Agent 共享
|  (项目结构、用户偏好、全局知识)              |
+-------------------+-----------------------+
                    |
+-------------------------------------------+
|     父上下文（编排器）                      |  <- 父 Agent 私有
|  (完整会话历史、规划、决策记录)              |
+-------------------+-----------------------+
                    |
+-------------------------------------------+
|     Worker 上下文（Subagent）              |  <- 子 Agent 私有
|  (任务指令、必要的上下文片段)               |
+-------------------------------------------+
```

### 4.2 上下文传递策略

#### 策略 1：最小必要上下文

```typescript
interface ContextSnapshot {
  workspaceRoot: string;
  relevantFiles: string[];
  keyDecisions: string[];
  currentGoal: string;
  constraints: {
    maxTokens: number;
    allowedTools: string[];
    timeLimit?: number;
  };
}
```

#### 策略 2：共享上下文层

`SharedContextManager` 提供基于键值对的上下文共享，支持订阅通知。Subagent 可以读取和订阅上下文变化，无需接收完整历史。

### 4.3 上下文压缩规则

传递给 Subagent 的上下文必须经过压缩：

1. 保留 system prompt
2. 提取与任务相关的文件/代码片段
3. 保留关键决策点
4. 移除冗余对话
5. 生成任务相关摘要
6. 控制在 token 预算内（默认 8K token）

---

## 5. 调度器实现

### 5.1 编排器核心

`AgentOrchestrator` 管理：

- **活跃 Agent 映射表**：追踪所有运行中的 Subagent
- **消息队列**：Agent 间消息的优先队列
- **共享上下文**：`SharedContextManager` 实例
- **结果收集**：来自所有 Subagent 的聚合结果

关键方法：
- `spawnAgent(config)` — 创建并启动一个 Subagent
- `parallelFanOut(tasks)` — 并发执行独立任务
- `serialPipeline(steps)` — 顺序执行，输出在步骤间传递
- `aggregateResults(taskIds)` — 合并结果，含总用量和耗时

### 5.2 Agent Handle

每个 Subagent 被包装为 `AgentHandle`，提供：
- `start()` — 通过 `runAgent` 开始执行
- `waitForResult()` — 返回一个在 Subagent 完成时 resolve 的 Promise
- `cancel()` — 发送取消信号

---

## 6. 典型模式

### 6.1 并行扇出

**适用场景**：多个可以并发执行的独立子任务。

```
                    +-- SubAgent A: 分析前端
Orchestrator -------+-- SubAgent B: 分析后端
                    +-- SubAgent C: 查询文档
                         | (全部完成后)
                    整合结果 -> 最终答案
```

### 6.2 串行流水线

**适用场景**：存在依赖关系、必须按顺序执行的步骤。

```
研究员 -> 分析员 -> 写手 -> 审核员
   |        |        |       |
 收集信息  分析数据  生成报告  质量检查
```

### 6.3 递归 Subagent

**适用场景**：某个子任务太大，需要进一步分解。

```
Orchestrator (depth=0)
  +-- SubAgent A (depth=1)
       +-- SubAgent A1 (depth=2)
            +-- SubAgent A1a (depth=3, 达到上限)
```

**约束**：
- 设置 `maxDepth` 防止无限递归（推荐 3-5）
- 每次递归递减深度计数器
- 达到深度上限时，Subagent 必须直接执行

### 6.4 隔离探索模式

**适用场景**：不应污染主上下文的探索性任务。

```typescript
const exploration = await orchestrator.spawnAgent({
  id: 'explore-alternative',
  instruction: '探索用 Redux 替换当前状态管理的可行性',
  tools: ['read_file', 'grep_text', 'web_search'],
  context: {
    currentGoal: '评估状态管理迁移',
    relevantFiles: ['src/store/index.ts', 'src/store/types.ts'],
    keyDecisions: ['当前方案存在性能瓶颈'],
  },
});
// 探索结果不影响主会话；编排器可选择性采纳
```

---

## 7. 错误处理与恢复

### 7.1 错误分类

```typescript
enum SubagentErrorType {
  TRANSIENT = 'transient',       // 可重试：网络超时、API 速率限制
  FATAL = 'fatal',                // 不可重试：无效参数、权限不足
  TIMEOUT = 'timeout',            // 执行超过 timeout_ms
  DEPTH_LIMIT = 'depth_limit',   // 达到递归深度上限
  BUDGET_EXHAUSTED = 'budget_exhausted', // Token 预算耗尽
}
```

### 7.2 重试策略

- 默认：最多 2 次重试，指数退避（1s、2s、4s）
- 仅对 `TRANSIENT` 和 `TIMEOUT` 错误重试
- 不可重试的错误立即返回

### 7.3 部分失败处理

并行任务中部分 Subagent 失败时：

- 至少 50% Subagent 成功则继续
- 向编排器同时报告成功和失败结果
- 编排器决定重试失败任务还是以部分结果继续

---

## 8. Token 预算管理

### 8.1 预算分配策略

- 编排器预留约 25% 的总预算
- 剩余预算在预估的 Subagent 间均分
- 执行时强制实施每个 Agent 的预算

### 8.2 用量聚合

总用量跨所有 Subagent 聚合：
- 总 prompt token、completion token 和总计 token
- 总成本计算
- 每个 Agent 的明细用于可观测性

---

## 9. Harness 集成

### 9.1 权限继承

Subagent 继承父 Agent 的 Harness 约束：

```typescript
interface InheritedPermissions {
  allowedTools: string[];          // 工具白名单（子集）
  allowedDirectories: string[];   // 工作目录限制
  allowedDomains?: string[];      // 网络域名白名单
  maxTokens: number;              // 最大 token 预算
  timeoutMs?: number;
  requireApprovalFor: string[];   // 需要审批的高风险操作
}
```

### 9.2 审计日志

每次 Subagent 执行产出审计日志条目，包含：
- 时间戳、父 Agent ID、Subagent ID
- 任务描述和状态
- 消耗 token、耗时、使用的工具
- 风险等级和审批状态

---

## 10. 实现清单

### P1 阶段（当前）

- [x] `agent` 工具基础协议：`description` / `prompt` / `subagent_type` / `allowedTools` / `maxTurns`
- [x] 侧链会话：子 Agent 对话记录独立保存，父 Agent 仅收到摘要
- [x] 自定义 Agent 定义：用户级和项目级 `.vera/agents/*.md`
- [x] 工具策略：内置 `general-purpose` / `explore` / `plan`，支持只读和允许/禁止工具
- [x] Try worktree 隔离：`isolation: "try"` 创建独立 worktree，工具在 worktree cwd 中执行
- [x] 采纳路径：try 隔离的 Subagent 记录分支元数据，可通过 `/merge <id-prefix>` 应用回来
- [ ] 完整 `AgentTask` / `AgentResult` 消息协议定义
- [ ] 基础 `AgentOrchestrator` 实现
- [ ] 并行扇出（`parallelFanOut`）
- [ ] 串行流水线（`serialPipeline`）
- [ ] 最小必要上下文传递
- [ ] 基础错误处理和重试
- [ ] Token 预算追踪

### P2 阶段

- [ ] 共享上下文管理器（`SharedContextManager`）
- [ ] 上下文压缩和摘要
- [ ] 递归 Subagent 支持
- [ ] 实时进度更新
- [ ] 部分失败恢复策略
- [ ] 审计日志集成

### P3 阶段

- [ ] 自适应预算分配
- [ ] Subagent 性能监控
- [ ] 动态调度策略优化
- [ ] 自动失败模式学习
- [ ] 可视化 Subagent 树

---

## 11. 最佳实践

**应该做：**

| 实践 | 原因 |
|---|---|
| 传递最小必要上下文 | 控制 token 消耗 |
| 设置合理的 `maxDepth` | 防止无限递归 |
| 使用工具白名单 | 最小化权限 |
| 并行化独立任务 | 提升吞吐量 |
| 错误快速失败 | 避免浪费时间 |

**不应做：**

| 实践 | 原因 |
|---|---|
| 传递完整对话历史 | Token 浪费 |
| 创建过深的递归 | 复杂度爆炸 |
| 给 Subagent 全部工具权限 | 安全风险 |
| 忽视错误处理 | 难以调试 |
| 过度分解小任务 | 增加开销 |

---

## 12. 与相关系统的对比

| 系统 | Subagent 支持 | 特点 |
|---|---|---|
| **Claude Code** | 有（Subagent） | 并行文件分析，独立上下文 |
| **Codex** | 有（Sandbox） | 隔离执行环境 |
| **LangChain** | 有（Agent Executor） | 灵活但需手动编排 |
| **AutoGen** | 有（Multi-Agent） | 基于对话的多 Agent |
| **Vera** | 有（Subagent + SharedContext） | 共享上下文层 + Harness 集成 |

Vera 的差异化优势：
1. **共享上下文层**：按需同步键值对，而非传递完整历史
2. **Harness 集成**：权限继承、审计日志、审批门
3. **预算管理**：自动 token 预算分配和追踪
4. **标准化协议**：与意图路由和 Plan 模式无缝集成

---

## 参见

- [agent-design.md](./agent-design.md) — Agent 能力全景
- [intent-routing.md](./intent-routing.md) — 意图识别和模型路由
- [runtime-design.md](./runtime-design.md) — 核心运行时设计
- [harness/design.md](../harness/design.md) — Harness 内核设计
