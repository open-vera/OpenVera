# Multi-Agent Network -- Cross-Agent Communication and Collaboration

## Overview

The Multi-Agent Network provides cross-agent communication and collaboration infrastructure for Vera. When a single agent cannot complete a complex task, the MessageBus enables message routing between agents, the TaskScheduler enables capability-based task allocation, and SharedMemory enables cross-agent knowledge sharing.

Relationships among the three components:

```
┌──────────────────────────────────────────────┐
│            Multi-Agent Network                │
│                                              │
│  ┌─────────────┐  ┌──────────────┐           │
│  │ MessageBus  │  │TaskScheduler │           │
│  │  Message    │  │  Task        │           │
│  │  routing    │  │  allocation  │           │
│  │  pub/sub    │  │  load        │           │
│  │             │  │  balancing   │           │
│  └──────┬──────┘  └──────┬───────┘           │
│         │                │                   │
│         └───────┬────────┘                   │
│                 │                            │
│         ┌───────┴────────┐                   │
│         │ SharedMemory   │                   │
│         │  Knowledge      │                   │
│         │  sharing store  │                   │
│         └────────────────┘                   │
└──────────────────────────────────────────────┘
```

All components are defined in `packages/core/src/network/` and exported as public APIs from `@vera/core`.

---

## MessageBus -- Message Bus

The MessageBus is the core of inter-agent communication, providing pub/sub-based message routing.

### Message Types (MessageType)

| Type | Description | Typical Scenario |
|------|-------------|------------------|
| `task_request` | Task request | Agent A dispatches a task to Agent B |
| `task_result` | Task result | Agent B returns execution result to Agent A |
| `status_update` | Status update | An agent broadcasts its status change (ready/busy/error) |
| `resource_request` | Resource request | An agent requests access to a resource held by another agent |
| `resource_response` | Resource response | Returns the requested resource |
| `broadcast` | Broadcast message | Send a notification to all agents |
| `direct` | Direct message | Point-to-point communication between agents |

### Message Structure

```ts
interface Message {
  id: string;          // Unique message ID, format: msg-{timestamp}-{random}
  type: MessageType;   // Message type
  from: string;        // Sender agent ID
  to: string | "*";    // Recipient agent ID, "*" for broadcast
  payload: unknown;    // Message payload
  timestamp: string;   // ISO timestamp
  replyTo?: string;    // Associated request message ID (for request-reply pattern)
  priority: "low" | "normal" | "high" | "urgent";
}
```

### Pub/Sub Model

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
                      ├─→ Direct recipient: routed to the target agent's handler set
                      ├─→ Global subscribers: all globalSubscribers receive the message
                      └─→ Broadcast (*): all agents (except sender) receive the message
```

**Key behaviors:**
- `subscribe(agentId, handler)` subscribes to a specific agent's messages, returns an unsubscribe function
- `subscribeAll(handler)` subscribes to all messages (for monitoring/logging)
- `publish(message)` publishes a message, auto-generates ID and timestamp, writes to history (default retains 1000 entries)
- When publishing to `"*"`, the message is delivered to all registered agents and global subscribers

### Request-Reply Pattern

The MessageBus provides a synchronous-style `request()` method that wraps the asynchronous request-reply pattern:

```
Agent A                            Agent B
  │                                  │
  │── request(from, to, payload) ──→│
  │   (type: task_request)           │
  │                                  │── Process task
  │                                  │── publish reply (replyTo: msgId)
  │←── resolve(reply) ──────────────│
  │                                  │
```

```ts
// Agent A sends a request to Agent B and waits for a reply
const reply = await messageBus.request(
  "agent-a",
  "agent-b",
  { command: "analyze", file: "/data/report.csv" },
  10_000 // 10-second timeout
);
```

Feedback mechanism: after `request()` internally publishes a `task_request` message, it subscribes to its own replies (matching `replyTo` with the request ID), throwing an error on timeout.

### Message History and Queries

```ts
// Get full history
messageBus.getHistory();

// Filter by criteria
messageBus.getHistory({ from: "agent-a", type: "task_request" });

// Get list of registered agents
messageBus.getRegisteredAgents(); // ["agent-a", "agent-b"]

// Get subscriber count for an agent
messageBus.getSubscriberCount("agent-a");
```

---

## TaskScheduler -- Task Scheduler

The TaskScheduler assigns tasks to the most suitable agent based on capability matching and load balancing.

### Agent Capability Registration (AgentCapability)

```ts
interface AgentCapability {
  agentId: string;       // Unique agent identifier
  skills: string[];      // Skill tag list, e.g. ["browser", "code-analysis", "data-processing"]
  maxConcurrent: number; // Maximum concurrent tasks
  priority: number;      // Agent priority (higher = preferred for task assignment)
  currentLoad: number;   // Current load (number of executing tasks)
}
```

Agents register their capabilities with the scheduler via `registerAgent()` at startup.

### Task Request (TaskRequest)

```ts
interface TaskRequest {
  id: string;                                // Task ID
  requiredSkills: string[];                  // Required skills, e.g. ["browser", "screenshot"]
  priority: "low" | "normal" | "high" | "urgent";
  payload: unknown;                          // Task-specific content
  deadline?: string;                         // Deadline (ISO format)
}
```

### Allocation Algorithm

`findBestAgent()` performs a two-step filter:

1. **Capability matching**: The agent's `skills` must contain ALL skills in `requiredSkills`
2. **Capacity check**: `currentLoad < maxConcurrent`

Candidates that pass the filter are sorted by:

```
1. priority descending (higher-priority agents preferred)
2. currentLoad ascending (lower load preferred, achieving load balancing)
3. The first agent in the sorted list is selected
```

If no agent is available, the task enters the queue (`taskQueue`) and will be automatically re-assigned when an agent completes its current task.

### Task Lifecycle

```
submitTask(task)
  │
  ├─→ Agent available
  │     └─→ assignTask(task, agent)
  │           └─→ Create TaskAssignment (status: "assigned")
  │                 └─→ agent.currentLoad++
  │
  └─→ No agent available
        └─→ Enter taskQueue and wait
              └─→ completeTask / failTask triggers processQueue()
                    └─→ Attempt to assign queued tasks
```

### Task Assignment (TaskAssignment)

```ts
interface TaskAssignment {
  taskId: string;
  agentId: string;
  assignedAt: string;  // ISO timestamp
  status: "assigned" | "in_progress" | "completed" | "failed";
  result?: unknown;
}
```

### Scheduler API

| Method | Description |
|--------|-------------|
| `registerAgent(capability)` | Register agent capabilities |
| `unregisterAgent(agentId)` | Unregister an agent |
| `updateLoad(agentId, load)` | Update agent load |
| `submitTask(task)` | Submit a task, returns TaskAssignment or null (queued) |
| `completeTask(taskId, result?)` | Mark task as completed, triggers queue processing |
| `failTask(taskId)` | Mark task as failed |
| `getAssignment(taskId)` | Query task assignment |
| `getAgentAssignments(agentId)` | Query all tasks for an agent |
| `getQueueLength()` | Get number of queued tasks |
| `getAgentStatus()` | Get all agent statuses |

---

## SharedMemory -- Shared Knowledge Store

SharedMemory provides a shared semantic memory layer between agents, analogous to a distributed key-value store, with visibility control and TTL support.

### Memory Entry (MemoryEntry)

```ts
interface MemoryEntry {
  key: string;                              // Key
  value: unknown;                           // Value (any serializable data)
  owner: string;                            // Creating agent ID
  visibility: "private" | "shared" | "public"; // Visibility scope
  createdAt: string;                        // Creation time
  updatedAt: string;                        // Last update time
  ttl?: number;                             // Time-to-live in ms, auto-deleted on expiry
  tags: string[];                           // Tags for categorization and search
}
```

### Visibility Model

| Level | Rule |
|-------|------|
| `private` | Only the creator (owner) can read; invisible to other agents |
| `shared` | All agents can read; only the owner can write/delete |
| `public` | All agents can read; only the owner can write/delete (semantically distinct from shared) |

### API

| Method | Description |
|--------|-------------|
| `set(key, value, owner, options?)` | Write/update a value, optional visibility, ttl, tags |
| `get(key, requester)` | Read a value, automatically checks visibility and TTL |
| `delete(key, requester)` | Delete a value (owner only) |
| `query(query, requester)` | Multi-condition query, supports key, keyPattern, owner, visibility, tags, since filters |
| `keys()` | Get all keys |
| `size()` | Get total entry count |
| `cleanup()` | Clear all expired entries, returns count of entries cleaned |

### Query Conditions (MemoryQuery)

```ts
interface MemoryQuery {
  key?: string;           // Exact key match
  keyPattern?: string;    // Fuzzy key match (contains)
  owner?: string;         // Filter by creator
  visibility?: "private" | "shared" | "public";
  tags?: string[];        // Must contain all specified tags
  since?: string;         // ISO time, only return entries updated after this time
}
```

---

## Cross-Agent Communication Patterns

### Pattern 1: Task Delegation

A source agent publishes a `task_request` via MessageBus; the target agent processes it and returns a `task_result`.

```
Agent A                          Agent B
  │── task_request ──────────────→│
  │                               │── Execute task
  │←─ task_result ───────────────│
```

### Pattern 2: Broadcast Collaboration

One agent publishes a `broadcast` message; all online agents receive it and respond independently.

```
Agent A ── broadcast ──→ Agent B
                      ──→ Agent C
                      ──→ Agent D
```

### Pattern 3: Status Polling

Agents periodically publish `status_update` messages; other agents listen via global subscribers to perceive network state.

### Pattern 4: Knowledge Sharing

Agents write intermediate results to SharedMemory; other agents read and continue processing, forming a pipeline:

```
Agent A ──set("raw_data", ...)──→ SharedMemory
Agent B ──get("raw_data")───────→ Process ──set("processed_data", ...)──→ SharedMemory
Agent C ──get("processed_data")──→ Continue processing
```

---

## Integration with the Subagent System

The Multi-Agent Network is designed to work with Vera's Subagent system:

- **Subagent registration**: Each subagent registers its capabilities with the `TaskScheduler` at startup (declared via the `skills` array)
- **Message routing**: The parent agent sends instructions to subagents via `MessageBus.publish()`; subagents receive them via `MessageBus.subscribe()`
- **Result aggregation**: After completion, subagents return results via `task_result` messages or write to `SharedMemory` for the parent agent to read
- **Load awareness**: The scheduler decides which idle subagent receives new tasks based on `currentLoad`, preventing single-point overload

---

## Configuration Examples

### Initializing the Multi-Agent Network

```ts
import { MessageBus, TaskScheduler, SharedMemory } from "@vera/core/network";

// Create message bus (retain last 2000 messages in history)
const bus = new MessageBus({ maxHistory: 2000 });

// Create task scheduler
const scheduler = new TaskScheduler();

// Create shared memory
const memory = new SharedMemory();

// Register agents
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

### Task Delegation Example

```ts
// Agent A subscribes to its own messages
bus.subscribe("agent-a", async (msg) => {
  if (msg.type === "task_result") {
    console.log(`Received result from ${msg.from}:`, msg.payload);
  }
});

// Scheduler assigns the task
const assignment = scheduler.submitTask({
  id: "task-001",
  requiredSkills: ["browser"],
  priority: "high",
  payload: { url: "https://example.com", action: "screenshot" },
});

if (assignment) {
  // Notify the assigned agent via message bus
  await bus.publish({
    type: "task_request",
    from: "orchestrator",
    to: assignment.agentId,
    payload: { taskId: "task-001", ... },
    priority: "high",
  });
} else {
  console.log("Task queued, no available agent");
}
```

---

## Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| `MessageBus` | Complete | Pub/sub message routing, request-reply pattern, history queries, 7 message types |
| `TaskScheduler` | Complete | Capability matching + load balancing, priority sorting, task queue |
| `SharedMemory` | Complete | Three-level visibility, TTL expiry, tag indexing, multi-condition queries |
| `StepPatterns` integration | Complete | Predefined browseAndAnalyze / login / downloadAndParse patterns |
| Persistence | Not implemented | Currently in-memory storage; data lost on restart |
| Cross-process communication | Not implemented | Currently only supports in-process agent communication |
| Network topology | Not implemented | Currently flat structure, no hierarchical routing |
