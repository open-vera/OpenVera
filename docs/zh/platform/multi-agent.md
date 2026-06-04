# Multi-Agent Network —— 跨 Agent 通信与协作

## 概述

Multi-Agent Network 为 Vera 提供跨 Agent 通信与协作基础设施。当单个 Agent 无法完成复杂任务时，MessageBus 实现 Agent 间消息路由，TaskScheduler 实现基于能力的任务分配，SharedMemory 实现跨 Agent 知识共享。

三者之间的关系：

```
┌──────────────────────────────────────────────┐
│            Multi-Agent Network                │
│                                              │
│  ┌─────────────┐  ┌──────────────┐           │
│  │ MessageBus  │  │TaskScheduler │           │
│  │  消息路由   │  │  任务分配    │           │
│  │  发布/订阅  │  │  负载均衡    │           │
│  └──────┬──────┘  └──────┬───────┘           │
│         │                │                   │
│         └───────┬────────┘                   │
│                 │                            │
│         ┌───────┴────────┐                   │
│         │ SharedMemory   │                   │
│         │  知识共享存储  │                   │
│         └────────────────┘                   │
└──────────────────────────────────────────────┘
```

所有组件定义在 `packages/core/src/network/`，并通过 `@vera/core` 作为公共 API 导出。

---

## MessageBus —— 消息总线

MessageBus 是跨 Agent 通信的核心，提供基于发布/订阅的消息路由。

### 消息类型（MessageType）

| 类型 | 描述 | 典型场景 |
|------|------|---------|
| `task_request` | 任务请求 | Agent A 向 Agent B 派发任务 |
| `task_result` | 任务结果 | Agent B 向 Agent A 返回执行结果 |
| `status_update` | 状态更新 | Agent 广播自身状态变化（ready/busy/error） |
| `resource_request` | 资源请求 | Agent 请求访问另一 Agent 持有的资源 |
| `resource_response` | 资源响应 | 返回请求的资源 |
| `broadcast` | 广播消息 | 向所有 Agent 发送通知 |
| `direct` | 直接消息 | Agent 间点对点通信 |

### 消息结构

```ts
interface Message {
  id: string;          // 唯一消息 ID，格式：msg-{timestamp}-{random}
  type: MessageType;   // 消息类型
  from: string;        // 发送方 Agent ID
  to: string | "*";    // 接收方 Agent ID，"*" 表示广播
  payload: unknown;    // 消息载荷
  timestamp: string;   // ISO 时间戳
  replyTo?: string;    // 关联的请求消息 ID（用于请求-回复模式）
  priority: "low" | "normal" | "high" | "urgent";
}
```

### 发布/订阅模型

```
publish(msg) → ┌─────────────┐
               │ MessageBus   │
               │              │
               │ subscribers: │
               │  agent-A → [handler1, handler2]
               │  agent-B → [handler3]
               │  global  → [logger]
               └─────────────┘
                      │
                      ├─→ 直接接收方：路由到目标 Agent 的 handler 集合
                      ├─→ 全局订阅者：所有 globalSubscribers 收到消息
                      └─→ 广播（*）：所有 Agent（发送方除外）收到消息
```

**关键行为：**
- `subscribe(agentId, handler)` 订阅特定 Agent 的消息，返回取消订阅函数
- `subscribeAll(handler)` 订阅所有消息（用于监控/日志）
- `publish(message)` 发布消息，自动生成 ID 和时间戳，写入历史（默认保留 1000 条）
- 发布到 `"*"` 时，消息投递给所有已注册 Agent 和全局订阅者

### 请求-回复模式

MessageBus 提供同步风格的 `request()` 方法，封装异步请求-回复模式：

```
Agent A                            Agent B
  │                                  │
  │── request(from, to, payload) ──→│
  │   (type: task_request)           │
  │                                  │── 处理任务
  │                                  │── publish reply (replyTo: msgId)
  │←── resolve(reply) ──────────────│
  │                                  │
```

```ts
// Agent A 向 Agent B 发送请求并等待回复
const reply = await messageBus.request(
  "agent-a",
  "agent-b",
  { command: "analyze", file: "/data/report.csv" },
  10_000 // 10 秒超时
);
```

反馈机制：`request()` 内部发布 `task_request` 消息后，订阅自身的回复（按 `replyTo` 匹配请求 ID），超时抛出错误。

### 消息历史与查询

```ts
// 获取完整历史
messageBus.getHistory();

// 按条件过滤
messageBus.getHistory({ from: "agent-a", type: "task_request" });

// 获取已注册 Agent 列表
messageBus.getRegisteredAgents(); // ["agent-a", "agent-b"]

// 获取某 Agent 的订阅者数量
messageBus.getSubscriberCount("agent-a");
```

---

## TaskScheduler —— 任务调度器

TaskScheduler 基于能力匹配和负载均衡将任务分配给最合适的 Agent。

### Agent 能力注册（AgentCapability）

```ts
interface AgentCapability {
  agentId: string;       // 唯一 Agent 标识
  skills: string[];      // 技能标签列表，如 ["browser", "code-analysis", "data-processing"]
  maxConcurrent: number; // 最大并发任务数
  priority: number;      // Agent 优先级（越高越优先分配任务）
  currentLoad: number;   // 当前负载（正在执行的任务数）
}
```

Agent 在启动时通过 `registerAgent()` 向调度器注册自身能力。

### 任务请求（TaskRequest）

```ts
interface TaskRequest {
  id: string;                                // 任务 ID
  requiredSkills: string[];                  // 所需技能，如 ["browser", "screenshot"]
  priority: "low" | "normal" | "high" | "urgent";
  payload: unknown;                          // 任务特定内容
  deadline?: string;                         // 截止时间（ISO 格式）
}
```

### 分配算法

`findBestAgent()` 执行两步筛选：

1. **能力匹配**：Agent 的 `skills` 必须包含 `requiredSkills` 中的所有技能
2. **容量检查**：`currentLoad < maxConcurrent`

通过筛选的候选者按以下规则排序：

```
1. priority 降序（高优先级 Agent 优先）
2. currentLoad 升序（低负载优先，实现负载均衡）
3. 选择排序后列表中的第一个 Agent
```

若无可用 Agent，任务进入队列（`taskQueue`），在 Agent 完成当前任务后自动重新分配。

### 任务生命周期

```
submitTask(task)
  │
  ├─→ 有可用 Agent
  │     └─→ assignTask(task, agent)
  │           └─→ 创建 TaskAssignment（status: "assigned"）
  │                 └─→ agent.currentLoad++
  │
  └─→ 无可用 Agent
        └─→ 进入 taskQueue 等待
              └─→ completeTask / failTask 触发 processQueue()
                    └─→ 尝试分配队列中的任务
```

### 任务分配（TaskAssignment）

```ts
interface TaskAssignment {
  taskId: string;
  agentId: string;
  assignedAt: string;  // ISO 时间戳
  status: "assigned" | "in_progress" | "completed" | "failed";
  result?: unknown;
}
```

### 调度器 API

| 方法 | 描述 |
|------|------|
| `registerAgent(capability)` | 注册 Agent 能力 |
| `unregisterAgent(agentId)` | 注销 Agent |
| `updateLoad(agentId, load)` | 更新 Agent 负载 |
| `submitTask(task)` | 提交任务，返回 TaskAssignment 或 null（已入队） |
| `completeTask(taskId, result?)` | 标记任务完成，触发队列处理 |
| `failTask(taskId)` | 标记任务失败 |
| `getAssignment(taskId)` | 查询任务分配 |
| `getAgentAssignments(agentId)` | 查询某 Agent 的所有任务 |
| `getQueueLength()` | 获取队列中的任务数 |
| `getAgentStatus()` | 获取所有 Agent 状态 |

---

## SharedMemory —— 共享知识存储

SharedMemory 提供 Agent 间共享的语义记忆层，类似于分布式键值存储，支持可见性控制和 TTL。

### 记忆条目（MemoryEntry）

```ts
interface MemoryEntry {
  key: string;                              // 键
  value: unknown;                           // 值（任意可序列化数据）
  owner: string;                            // 创建者 Agent ID
  visibility: "private" | "shared" | "public"; // 可见范围
  createdAt: string;                        // 创建时间
  updatedAt: string;                        // 最后更新时间
  ttl?: number;                             // 存活时间（毫秒），过期自动删除
  tags: string[];                           // 标签用于分类和搜索
}
```

### 可见性模型

| 级别 | 规则 |
|------|------|
| `private` | 仅创建者（owner）可读；其他 Agent 不可见 |
| `shared` | 所有 Agent 可读；仅 owner 可写/删除 |
| `public` | 所有 Agent 可读；仅 owner 可写/删除（语义上区别于 shared） |

### API

| 方法 | 描述 |
|------|------|
| `set(key, value, owner, options?)` | 写入/更新值，可选 visibility、ttl、tags |
| `get(key, requester)` | 读取值，自动检查可见性和 TTL |
| `delete(key, requester)` | 删除值（仅 owner） |
| `query(query, requester)` | 多条件查询，支持 key、keyPattern、owner、visibility、tags、since 过滤 |
| `keys()` | 获取所有键 |
| `size()` | 获取条目总数 |
| `cleanup()` | 清除所有过期条目，返回清理数量 |

### 查询条件（MemoryQuery）

```ts
interface MemoryQuery {
  key?: string;           // 精确键匹配
  keyPattern?: string;    // 模糊键匹配（contains）
  owner?: string;         // 按创建者过滤
  visibility?: "private" | "shared" | "public";
  tags?: string[];        // 必须包含所有指定标签
  since?: string;         // ISO 时间，仅返回此后更新的条目
}
```

---

## 跨 Agent 通信模式

### 模式 1：任务委派

源 Agent 通过 MessageBus 发布 `task_request`；目标 Agent 处理后返回 `task_result`。

```
Agent A                          Agent B
  │── task_request ──────────────→│
  │                               │── 执行任务
  │←─ task_result ───────────────│
```

### 模式 2：广播协作

一个 Agent 发布 `broadcast` 消息；所有在线 Agent 收到后各自响应。

```
Agent A ── broadcast ──→ Agent B
                      ──→ Agent C
                      ──→ Agent D
```

### 模式 3：状态轮询

Agent 定期发布 `status_update` 消息；其他 Agent 通过全局订阅者监听，感知网络状态。

### 模式 4：知识共享

Agent 将中间结果写入 SharedMemory；其他 Agent 读取后继续处理，形成流水线：

```
Agent A ──set("raw_data", ...)──→ SharedMemory
Agent B ──get("raw_data")───────→ 处理 ──set("processed_data", ...)──→ SharedMemory
Agent C ──get("processed_data")──→ 继续处理
```

---

## 与 Subagent 系统的集成

Multi-Agent Network 设计为与 Vera 的 Subagent 系统协同工作：

- **Subagent 注册**：每个 Subagent 在启动时向 `TaskScheduler` 注册自身能力（通过 `skills` 数组声明）
- **消息路由**：父 Agent 通过 `MessageBus.publish()` 向 Subagent 发送指令；Subagent 通过 `MessageBus.subscribe()` 接收
- **结果汇总**：Subagent 完成后通过 `task_result` 消息返回结果，或写入 `SharedMemory` 供父 Agent 读取
- **负载感知**：调度器根据 `currentLoad` 决定哪个空闲 Subagent 接收新任务，防止单点过载

---

## 配置示例

### 初始化 Multi-Agent Network

```ts
import { MessageBus, TaskScheduler, SharedMemory } from "@vera/core/network";

// 创建消息总线（历史保留 2000 条）
const bus = new MessageBus({ maxHistory: 2000 });

// 创建任务调度器
const scheduler = new TaskScheduler();

// 创建共享内存
const memory = new SharedMemory();

// 注册 Agent
scheduler.registerAgent({
  agentId: "browser-agent",
  skills: ["browser", "screenshot", "dom-manipulation"],
  maxConcurrent: 3,
  priority: 10,
  currentLoad: 0,
});

scheduler.registerAgent({
  agentId: "code-agent",
  skills: ["code-analysis", "code-generation", "testing"],
  maxConcurrent: 2,
  priority: 8,
  currentLoad: 0,
});
```

### 任务委派示例

```ts
// Agent A 订阅自己的消息
bus.subscribe("agent-a", async (msg) => {
  if (msg.type === "task_result") {
    console.log(`收到来自 ${msg.from} 的结果:`, msg.payload);
  }
});

// 调度器分配任务
const assignment = scheduler.submitTask({
  id: "task-001",
  requiredSkills: ["browser"],
  priority: "high",
  payload: { url: "https://example.com", action: "screenshot" },
});

if (assignment) {
  // 通过消息总线通知被分配的 Agent
  await bus.publish({
    type: "task_request",
    from: "orchestrator",
    to: assignment.agentId,
    payload: { taskId: "task-001", ... },
    priority: "high",
  });
} else {
  console.log("任务已入队，无可用 Agent");
}
```

---

## 当前状态

| 组件 | 状态 | 说明 |
|------|------|------|
| `MessageBus` | 已完成 | 发布/订阅消息路由、请求-回复模式、历史查询、7 种消息类型 |
| `TaskScheduler` | 已完成 | 能力匹配 + 负载均衡、优先级排序、任务队列 |
| `SharedMemory` | 已完成 | 三级可见性、TTL 过期、标签索引、多条件查询 |
| `StepPatterns` 集成 | 已完成 | 预定义 browseAndAnalyze / login / downloadAndParse 模式 |
| 持久化 | 未实现 | 目前为内存存储；重启后数据丢失 |
| 跨进程通信 | 未实现 | 目前仅支持进程内 Agent 通信 |
| 网络拓扑 | 未实现 | 目前为扁平结构，无层级路由 |
