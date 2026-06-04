# Multi-Agent Network -- 多 Agent 网络

## 定位

多 Agent 网络为 Vera 提供跨 agent 通信与协作基础设施。当单个 agent 无法完成复杂任务时，通过 MessageBus 实现 agent 间消息路由，通过 TaskScheduler 实现基于能力的任务分配，通过 SharedMemory 实现跨 agent 知识共享。

三大组件的关系：

```
┌──────────────────────────────────────────────┐
│              Multi-Agent Network              │
│                                              │
│  ┌─────────────┐  ┌──────────────┐           │
│  │ MessageBus  │  │TaskScheduler │           │
│  │  消息路由    │  │  任务分配    │           │
│  │  pub/sub    │  │  负载均衡    │           │
│  └──────┬──────┘  └──────┬───────┘           │
│         │                │                   │
│         └───────┬────────┘                   │
│                 │                            │
│         ┌───────┴────────┐                   │
│         │ SharedMemory   │                   │
│         │  知识共享存储    │                   │
│         └────────────────┘                   │
└──────────────────────────────────────────────┘
```

所有组件定义在 `packages/core/src/network/` 中，作为 `@vera/core` 的公共导出。

---

## MessageBus -- 消息总线

MessageBus 是 agent 间通信的核心，提供基于 pub/sub 模式的消息路由。

### 消息类型（MessageType）

| 类型 | 说明 | 典型场景 |
|------|------|----------|
| `task_request` | 任务请求 | Agent A 向 Agent B 下发任务 |
| `task_result` | 任务结果 | Agent B 向 Agent A 返回执行结果 |
| `status_update` | 状态更新 | Agent 广播自身状态变化（就绪/忙碌/错误） |
| `resource_request` | 资源请求 | Agent 请求访问另一个 agent 持有的资源 |
| `resource_response` | 资源响应 | 返回所请求的资源 |
| `broadcast` | 广播消息 | 向所有 agent 发送通知 |
| `direct` | 直连消息 | Agent 间点对点通信 |

### 消息结构（Message）

```ts
interface Message {
  id: string;          // 唯一消息 ID，格式：msg-{timestamp}-{random}
  type: MessageType;   // 消息类型
  from: string;        // 发送者 agent ID
  to: string | "*";    // 接收者 agent ID，"*" 表示广播
  payload: unknown;    // 消息负载
  timestamp: string;   // ISO 时间戳
  replyTo?: string;    // 关联的请求消息 ID（用于 request-reply 模式）
  priority: "low" | "normal" | "high" | "urgent";
}
```

### Pub/Sub 模型

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
                      ├─→ 指定接收者: 路由到对应 agent 的 handler 集合
                      ├─→ 全局订阅者: 所有 globalSubscribers 收到消息
                      └─→ 广播(*): 所有 agent（除发送者）收到消息
```

**关键行为：**
- `subscribe(agentId, handler)` 订阅特定 agent 的消息，返回取消订阅函数
- `subscribeAll(handler)` 订阅所有消息（用于监控/日志）
- `publish(message)` 发布消息，自动生成 ID 和时间戳，写入历史记录（默认保留 1000 条）
- 向 `"*"` 发布时，消息同时投递到所有已注册 agent 和全局订阅者

### Request-Reply 模式

MessageBus 提供了同步风格的 `request()` 方法，封装异步请求-应答模式：

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
// Agent A 向 Agent B 发送请求，等待回复
const reply = await messageBus.request(
  "agent-a",
  "agent-b",
  { command: "analyze", file: "/data/report.csv" },
  10_000 // 超时 10 秒
);
```

`request()` 内部发布 `task_request` 消息后，订阅自身的回复（`replyTo` 匹配请求 ID），超时抛出错误。

### 消息历史与查询

```ts
// 获取全部历史
messageBus.getHistory();

// 按条件过滤
messageBus.getHistory({ from: "agent-a", type: "task_request" });

// 获取注册的 agent 列表
messageBus.getRegisteredAgents(); // ["agent-a", "agent-b"]

// 获取某个 agent 的订阅者数量
messageBus.getSubscriberCount("agent-a");
```

---

## TaskScheduler -- 任务调度器

TaskScheduler 负责将任务分配给最合适的 agent，基于能力匹配和负载均衡进行决策。

### Agent 能力注册（AgentCapability）

```ts
interface AgentCapability {
  agentId: string;       // Agent 唯一标识
  skills: string[];      // 技能标签列表，如 ["browser", "code-analysis", "data-processing"]
  maxConcurrent: number; // 最大并发任务数
  priority: number;      // Agent 优先级（越高越优先接收任务）
  currentLoad: number;   // 当前负载（正在执行的任务数）
}
```

Agent 启动时通过 `registerAgent()` 注册自身能力到调度器。

### 任务请求（TaskRequest）

```ts
interface TaskRequest {
  id: string;                                // 任务 ID
  requiredSkills: string[];                  // 必需技能，如 ["browser", "screenshot"]
  priority: "low" | "normal" | "high" | "urgent";
  payload: unknown;                          // 任务具体内容
  deadline?: string;                         // 截止时间（ISO 格式）
}
```

### 分配算法

`findBestAgent()` 执行两步筛选：

1. **能力匹配**：agent 的 `skills` 必须包含 `requiredSkills` 中的所有技能
2. **容量检查**：agent 的 `currentLoad < maxConcurrent`

通过筛选的候选 agent 按以下规则排序：

```
1. priority 降序（优先级高的 agent 优先）
2. currentLoad 升序（负载低的优先，实现负载均衡）
3. 取排序后的第一个 agent
```

如果没有可用 agent，任务进入队列（`taskQueue`），等待 agent 完成当前任务后自动重新分配。

### 任务生命周期

```
submitTask(task)
  │
  ├─→ 有可用 agent
  │     └─→ assignTask(task, agent)
  │           └─→ 创建 TaskAssignment (status: "assigned")
  │                 └─→ agent.currentLoad++
  │
  └─→ 无可用 agent
        └─→ 进入 taskQueue 等待
              └─→ completeTask / failTask 触发 processQueue()
                    └─→ 尝试分配队列中的任务
```

### 任务分配记录（TaskAssignment）

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

| 方法 | 说明 |
|------|------|
| `registerAgent(capability)` | 注册 agent 能力 |
| `unregisterAgent(agentId)` | 注销 agent |
| `updateLoad(agentId, load)` | 更新 agent 负载 |
| `submitTask(task)` | 提交任务，返回 TaskAssignment 或 null（进队列） |
| `completeTask(taskId, result?)` | 标记任务完成，触发队列处理 |
| `failTask(taskId)` | 标记任务失败 |
| `getAssignment(taskId)` | 查询任务分配 |
| `getAgentAssignments(agentId)` | 查询 agent 的所有任务 |
| `getQueueLength()` | 获取排队任务数 |
| `getAgentStatus()` | 获取所有 agent 状态 |

---

## SharedMemory -- 共享知识存储

SharedMemory 提供 agent 间的共享语义记忆层，类似分布式 key-value 存储，支持可见性控制和 TTL。

### 内存条目（MemoryEntry）

```ts
interface MemoryEntry {
  key: string;                              // 键
  value: unknown;                           // 值（任意可序列化数据）
  owner: string;                            // 创建者 agent ID
  visibility: "private" | "shared" | "public"; // 可见范围
  createdAt: string;                        // 创建时间
  updatedAt: string;                        // 更新时间
  ttl?: number;                             // 过期时间（ms），超期自动删除
  tags: string[];                           // 标签，用于分类检索
}
```

### 可见性模型

| 级别 | 规则 |
|------|------|
| `private` | 仅创建者（owner）可读，其他 agent 查询不到 |
| `shared` | 所有 agent 可读，仅创建者可写/删 |
| `public` | 所有 agent 可读，仅创建者可写/删（语义上区别于 shared） |

### API

| 方法 | 说明 |
|------|------|
| `set(key, value, owner, options?)` | 写入/更新值，可选 visibility、ttl、tags |
| `get(key, requester)` | 读取值，自动检查可见性和 TTL |
| `delete(key, requester)` | 删除值（仅 owner 可删） |
| `query(query, requester)` | 多条件查询，支持 key、keyPattern、owner、visibility、tags、since 过滤 |
| `keys()` | 获取所有 key |
| `size()` | 获取条目总数 |
| `cleanup()` | 清除所有过期条目，返回清除数量 |

### 查询条件（MemoryQuery）

```ts
interface MemoryQuery {
  key?: string;           // 精确匹配 key
  keyPattern?: string;    // 模糊匹配 key（contains）
  owner?: string;         // 按创建者过滤
  visibility?: "private" | "shared" | "public";
  tags?: string[];        // 必须包含所有指定标签
  since?: string;         // ISO 时间，仅返回此时间之后更新的条目
}
```

---

## 跨 Agent 通信模式

### 模式 1：任务委派

Source agent 通过 MessageBus 发布 `task_request`，目标 agent 处理后返回 `task_result`。

```
Agent A                          Agent B
  │── task_request ──────────────→│
  │                               │── 执行任务
  │←─ task_result ───────────────│
```

### 模式 2：广播协作

一个 agent 发布 `broadcast` 消息，所有在线 agent 接收并各自响应。

```
Agent A ── broadcast ──→ Agent B
                      ──→ Agent C
                      ──→ Agent D
```

### 模式 3：状态轮询

Agent 定期发布 `status_update`，其他 agent 通过全局订阅者监听以感知网络状态。

### 模式 4：知识共享

Agent 通过 SharedMemory 写入中间结果，其他 agent 读取后继续处理，形成流水线：

```
Agent A ──set("raw_data", ...)──→ SharedMemory
Agent B ──get("raw_data")───────→ 处理后 ──set("processed_data", ...)──→ SharedMemory
Agent C ──get("processed_data")──→ 继续处理
```

---

## 与 Subagent 系统的集成

多 Agent 网络设计为与 Vera 的 Subagent 系统协同工作：

- **Subagent 注册**：每个 subagent 启动时向 `TaskScheduler` 注册自身能力（通过 `skills` 数组声明）
- **消息路由**：父 agent 通过 `MessageBus.publish()` 向 subagent 发送指令，subagent 通过 `MessageBus.subscribe()` 接收
- **结果汇总**：subagent 完成后通过 `task_result` 消息返回结果，或写入 `SharedMemory` 供父 agent 读取
- **负载感知**：调度器根据 `currentLoad` 决定将新任务分配给空闲的 subagent，避免单点过载

---

## 配置示例

### 初始化多 Agent 网络

```ts
import { MessageBus, TaskScheduler, SharedMemory } from "@vera/core/network";

// 创建消息总线（保留最近 2000 条历史消息）
const bus = new MessageBus({ maxHistory: 2000 });

// 创建任务调度器
const scheduler = new TaskScheduler();

// 创建共享内存
const memory = new SharedMemory();

// 注册 agent
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
  // 通过消息总线通知被分配的 agent
  await bus.publish({
    type: "task_request",
    from: "orchestrator",
    to: assignment.agentId,
    payload: { taskId: "task-001", ... },
    priority: "high",
  });
} else {
  console.log("任务已排队，无可用 agent");
}
```

---

## 当前状态

| 组件 | 状态 | 说明 |
|------|------|------|
| `MessageBus` | 已完成 | pub/sub 消息路由、request-reply 模式、历史查询、7 种消息类型 |
| `TaskScheduler` | 已完成 | 能力匹配 + 负载均衡、优先级排序、任务队列 |
| `SharedMemory` | 已完成 | 三级可见性、TTL 过期、标签索引、多条件查询 |
| `StepPatterns` 集成 | 已完成 | 预定义的 browseAndAnalyze / login / downloadAndParse 模式 |
| 持久化 | 未实现 | 当前为内存存储，重启后数据丢失 |
| 跨进程通信 | 未实现 | 当前仅支持同进程内 agent 通信 |
| 网络拓扑 | 未实现 | 当前为扁平结构，无分层路由 |
