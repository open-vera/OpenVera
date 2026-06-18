# Partner — 技术方案文档

> 版本：v0.1 · 2026-06-18 · 状态：草案  
> 依赖文档：[PRD v0.7](./prd.md)

---

## 目录

1. [技术边界与约定](#1-技术边界与约定)
2. [整体架构](#2-整体架构)
3. [前端层（Vue 3 + Tauri WebView）](#3-前端层)
4. [Tauri Rust 核心层](#4-tauri-rust-核心层)
5. [OpenVera Core 集成方案](#5-openvera-core-集成方案)
6. [编排层 (Orchestrator)](#6-编排层-orchestrator)
7. [数据层设计](#7-数据层设计)
8. [IPC 协议设计](#8-ipc-协议设计)
9. [上下文引擎集成](#9-上下文引擎集成)
10. [工具系统](#10-工具系统)
11. [安全实现](#11-安全实现)
12. [构建与打包](#12-构建与打包)
13. [测试策略](#13-测试策略)
14. [性能指标与约束](#14-性能指标与约束)
15. [开放技术风险](#15-开放技术风险)

---

## 1. 技术边界与约定

### 1.1 范围

本文档覆盖 Partner 应用的工程实现方案，面向**开发者**。产品目标见 PRD，本文不重复产品需求。

### 1.2 关键术语

| 术语 | 含义 |
|------|------|
| **Tauri App** | 桌面宿主进程，含 Rust Core + WebView |
| **WebView** | 渲染 Vue 3 UI 的内嵌浏览器引擎 |
| **Rust Core** | Tauri 后端，处理 OS 调用、文件系统、进程管理 |
| **Agent Instance** | 一个 OpenVera Core + Harness 运行单元，对应一个窗口/会话 |
| **Orchestrator** | 管理多个 Agent Instance 生命周期的 TypeScript 层 |
| **IPC** | Tauri 的 invoke/emit 机制，连接 WebView 与 Rust |
| **Sidecar** | 由 Tauri 生命周期管理的子进程（备选方案） |
| **Context Manager** | OpenVera Core 的 `context/` 模块集合 |

### 1.3 依赖版本锁定

| 依赖 | 版本 |
|------|------|
| Tauri | 2.x LTS |
| Vue | 3.5+ |
| Vite | 6.x |
| Pinia | 2.x |
| Rust | stable (≥ 1.78) |
| Node.js | 20 LTS |
| SQLite | 3.45+ (via tauri-plugin-sql) |
| TypeScript | 5.x strict |

---

## 2. 整体架构

### 2.1 进程模型

```
┌─────────────────────────────────────────────────────────────┐
│                   OS 进程：tauri-partner                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WebView (Chromium WebKit / WebView2)                 │   │
│  │                                                      │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │  Vue 3 Application                           │     │   │
│  │  │  ┌──────┐ ┌──────────┐ ┌──────┐ ┌────────┐  │     │   │
│  │  │  │ Left │ │  Chat    │ │Right │ │Kanban  │  │     │   │
│  │  │  │ Panel│ │  Panel   │ │Panel │ │ Board  │  │     │   │
│  │  │  └──────┘ └──────────┘ └──────┘ └────────┘  │     │   │
│  │  │                                              │     │   │
│  │  │  ┌──────────────────────────────────────┐    │     │   │
│  │  │  │  Orchestrator (TypeScript)            │    │     │   │
│  │  │  │  AgentInstance × N + TaskQueue        │    │     │   │
│  │  │  └──────────────────────────────────────┘    │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  └──────────────────────────┬───────────────────────────┘   │
│                             │  Tauri IPC (invoke/emit)       │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │  Rust Core (src-tauri/)                               │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │   │
│  │  │ Commands │ │  State   │ │  Events  │ │ Plugins │  │   │
│  │  │ (fs/shell│ │ (AppState│ │ (Emitter │ │ (sql/   │  │   │
│  │  │  /keychain│ │ /sessions│ │ /bridge) │ │ updater)│  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**关键设计决策**：

- Orchestrator 运行在 WebView 的 JS 线程中，不是独立进程
- Agent Instance 同样运行在 WebView JS 线程（Worker 线程用于插件隔离）
- 所有 OS 级别操作（文件、Shell、Keychain）通过 Tauri IPC 路由到 Rust
- SQLite 通过 `tauri-plugin-sql` 在 Rust 侧读写，JS 侧通过 IPC 调用

### 2.2 目录结构

```
partner/
├── src/                          # Vue 3 前端
│   ├── App.vue
│   ├── main.ts
│   ├── components/
│   │   ├── chat/                 # 对话流组件
│   │   │   ├── ChatPanel.vue
│   │   │   ├── MessageBubble.vue
│   │   │   ├── ToolCallCard.vue
│   │   │   └── InputBar.vue
│   │   ├── left/                 # 左侧面板
│   │   │   ├── LeftPanel.vue
│   │   │   ├── FileTree.vue
│   │   │   └── GitChanges.vue
│   │   ├── preview/              # 右侧预览面板
│   │   │   ├── PreviewPanel.vue
│   │   │   ├── PreviewTab.vue
│   │   │   └── viewers/         # 各格式查看器
│   │   └── kanban/              # 任务看板
│   │       └── KanbanBoard.vue
│   ├── stores/                   # Pinia stores
│   │   ├── chat.ts
│   │   ├── session.ts
│   │   ├── preview.ts
│   │   ├── kanban.ts
│   │   └── settings.ts
│   ├── orchestrator/             # Agent 编排层
│   │   ├── index.ts
│   │   ├── agent-instance.ts
│   │   ├── task-queue.ts
│   │   └── gateway.ts
│   ├── bridge/                   # Tauri IPC 封装
│   │   ├── fs.ts
│   │   ├── shell.ts
│   │   ├── keychain.ts
│   │   └── index.ts
│   └── types/                    # 前端类型定义
│       └── index.ts
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   │   ├── fs.rs             # 文件系统命令
│   │   │   ├── shell.rs          # Shell 执行命令
│   │   │   ├── keychain.rs       # Keychain 操作
│   │   │   └── storage.rs        # SQLite 操作
│   │   ├── state.rs              # Tauri AppState
│   │   └── events.rs             # 事件定义
│   └── tauri.conf.json
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

---

## 3. 前端层

### 3.1 Pinia Store 设计

#### ChatStore

```typescript
interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  isStreaming?: boolean
  tokenCount?: number
}

interface ChatStore {
  messages: Message[]
  isAgentRunning: boolean
  currentTokenCount: number
  estimatedCost: number
  append(message: Message): void
  updateStreaming(id: string, delta: string): void
  finalizeMessage(id: string): void
  abort(): void
}
```

#### SessionStore

```typescript
interface Session {
  id: string                    // UUID
  windowId: string              // Tauri window label
  createdAt: number
  lastActiveAt: number
  instanceId: string | null     // 绑定的 AgentInstance
}

interface SessionStore {
  current: Session
  loadFromDb(): Promise<void>
  persist(): Promise<void>
}
```

#### SettingsStore

```typescript
interface LLMProvider {
  id: 'anthropic' | 'openai' | 'gemini'
  model: string
  apiKey: string               // 仅持有引用句柄，实际存 Keychain
}

interface SettingsStore {
  provider: LLMProvider
  theme: 'dark' | 'light' | 'system'
  maxInstances: number
  locale: 'zh' | 'en'
  firstLaunchComplete: boolean
  save(): Promise<void>
}
```

### 3.2 组件通信模式

```
用户输入
  → InputBar emits 'submit'
  → ChatPanel 调用 orchestrator.sendMessage(text)
  → Orchestrator 调用 AgentInstance.run()
  → Agent 流式返回 → bridge event 'agent:delta'
  → ChatStore.updateStreaming()
  → MessageBubble 响应式更新
```

所有跨层通信通过 Pinia store，组件不直接调用 orchestrator。

### 3.3 流式渲染

Agent 输出通过 Tauri 事件（`agent:stream:delta`）推送到前端：

```typescript
// bridge/index.ts
import { listen } from '@tauri-apps/api/event'

export function onAgentDelta(instanceId: string, cb: (delta: string) => void) {
  return listen<{ instanceId: string; delta: string }>('agent:stream:delta', (e) => {
    if (e.payload.instanceId === instanceId) cb(e.payload.delta)
  })
}
```

Markdown 渲染使用 `markdown-it` 增量解析，避免每次 delta 全量重渲。策略：

1. 流式阶段：追加原始文本到 buffer，每 100ms 用 `requestAnimationFrame` 刷新一次渲染
2. 完成阶段：全量解析 Markdown，替换气泡内容

### 3.4 右侧预览面板

预览面板各格式的渲染策略：

| 格式 | 渲染方式 | 安全隔离 |
|------|---------|---------|
| HTML/URL | Tauri WebView `<iframe>` | `sandbox` 属性 + CSP + 独立 origin |
| PDF | PDF.js（WebAssembly） | 无外部网络请求 |
| 图片 | `<img>` + object-fit | N/A |
| 音视频 | `<video>`/`<audio>` 原生元素 | N/A |
| 代码 | highlight.js 语法高亮 | 纯文本渲染，无执行 |
| Markdown | markdown-it 渲染 | DOMPurify 净化 |

HTML 预览使用独立 WebView 窗口，通过 Tauri `WebviewWindow` API 创建，禁用 Node 集成与 IPC 访问。

---

## 4. Tauri Rust 核心层

### 4.1 Command 清单

遵循**最小权限原则**，`tauri.conf.json` 的 `capabilities` 仅开放下列命令：

```rust
// commands/fs.rs
#[tauri::command]
async fn read_file(path: String, state: State<'_, AppState>) -> Result<String, String>

#[tauri::command]
async fn write_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String>

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntry>, String>

#[tauri::command]
async fn git_status(path: String) -> Result<Vec<GitChange>, String>
```

```rust
// commands/shell.rs
#[tauri::command]
async fn execute_shell(
  cmd: String,
  args: Vec<String>,
  cwd: Option<String>,
  timeout_ms: Option<u64>,
  state: State<'_, AppState>,
) -> Result<ShellOutput, String>
```

```rust
// commands/keychain.rs
#[tauri::command]
async fn store_secret(service: String, key: String, value: String) -> Result<(), String>

#[tauri::command]
async fn get_secret(service: String, key: String) -> Result<Option<String>, String>

#[tauri::command]
async fn delete_secret(service: String, key: String) -> Result<(), String>
```

### 4.2 Shell 沙箱

Shell 命令不直接透传，Rust 侧实施以下防护：

```rust
struct ShellSandbox {
  allowed_commands: HashSet<String>,   // 命令白名单
  cwd_root: PathBuf,                   // 工作目录根，禁止 cd 逃逸
  env_allowlist: Vec<String>,          // 允许透传的环境变量
  max_output_bytes: usize,             // 输出截断防内存爆炸
}
```

高风险命令（`rm -rf`、`chmod 777`、`sudo` 等）需在 JS 侧先弹出确认对话框，Rust 侧收到 `confirmed: true` flag 才执行。

### 4.3 AppState

```rust
struct AppState {
  db: Mutex<SqlitePool>,
  sandbox: ShellSandbox,
  session_registry: Mutex<HashMap<String, SessionMeta>>,
}
```

### 4.4 文件路径安全

所有从 JS 传入的路径均通过 `canonicalize` + 前缀检查，防止路径穿越：

```rust
fn validate_path(path: &str, allowed_root: &Path) -> Result<PathBuf> {
  let canonical = Path::new(path).canonicalize()?;
  if !canonical.starts_with(allowed_root) {
    return Err(anyhow!("path escape denied"));
  }
  Ok(canonical)
}
```

---

## 5. OpenVera Core 集成方案

### 5.1 集成路径决策树

Phase 2 的 WASM spike 需在 2 周内给出结论，决策标准如下：

```
Q1: OpenVera Core 的逻辑层（context/agent/plan/intent）能否脱离 @open-vera/plugin-runtime 等内部包独立编译？
  ├─ 否 → 进入备选方案 B（Node.js Sidecar）
  └─ 是 → Q2: wasm-pack + wasm-bindgen 能否处理所有 TS/JS → WASM 依赖？
              ├─ 否 → 进入备选方案 B
              └─ 是 → 方案 A（WASM 直接调用）
```

### 5.2 方案 A：WASM 直接调用（首选）

```
Vue 前端
  │  invoke('agent_run', payload)
  ▼
Rust Command (src-tauri/src/commands/agent.rs)
  │  wasm_agent::run(payload)
  ▼
OpenVera Core WASM 模块
  │  (内存内调用，延迟 < 1ms)
  ▼
工具回调 → Rust 侧执行 → 返回结果
```

WASM 编译目标模块（仅逻辑层）：

| 模块 | 编译为 WASM | 备注 |
|------|------------|------|
| `context/window.ts` | ✅ | 纯逻辑 |
| `context/compression.ts` | ✅ | 纯逻辑 |
| `context/idle-compression.ts` | ✅ | 纯逻辑 |
| `agent/` `plan/` `intent/` | ✅ (待验证) | 需确认无 IO 依赖 |
| `adapters/` (LLM HTTP) | ❌ | 走 Tauri HTTP 调用 |
| `storage/` (SQLite) | ❌ | 走 Tauri SQLite |
| `tools/` | ❌ | 走 Tauri IPC |

工具回调机制（WASM → Rust）：

```
WASM 调 tool → 通过 wasm-bindgen extern JS → JS bridge → invoke Rust command
```

具体实现：在 WASM bindgen 绑定中注册 `__tool_dispatch` JS 函数，Agent 每次需要调用工具时同步调用该函数，由 Rust 执行后返回结果。

### 5.3 方案 B：Node.js Sidecar（备选）

若 WASM 不可行，OpenVera Core 以 Node.js 子进程（sidecar）形式运行：

```
Vue 前端
  │  invoke('agent_run', payload)
  ▼
Rust Command
  │  向 sidecar stdin 写入 JSON RPC 请求
  ▼
Node.js sidecar (openvera-core-server)
  │  执行，流式输出到 stdout
  ▼
Rust 读 stdout → emit 'agent:stream:delta' → WebView
```

Sidecar IPC 协议（JSON Lines，stdin/stdout）：

```jsonc
// 请求（Rust → Node.js）
{ "id": "req-001", "method": "agent.run", "params": { "sessionId": "...", "message": "..." } }

// 流式响应（Node.js → Rust）
{ "id": "req-001", "type": "delta", "data": { "text": "思考中..." } }
{ "id": "req-001", "type": "tool_call", "data": { "name": "read_file", "input": {...} } }
{ "id": "req-001", "type": "done", "data": { "usage": {...} } }
```

Sidecar 工具调用需再回传 Rust（因为工具执行需要 OS 权限）：

```
Node.js 发出 tool_call → Rust 读取 → Rust 执行工具 → Rust 向 sidecar stdin 写入 tool_result
```

### 5.4 多实例下的 Core 加载

无论方案 A/B，每个 Agent Instance 共享同一个 Core 模块，通过 sessionId 区分状态：

- **WASM**：单例 WASM 实例，状态通过 sessionId 隔离在内存 Map 中
- **Sidecar**：单 Node.js 进程，多 session 并发，内部 Map 管理 session 状态

---

## 6. 编排层 (Orchestrator)

### 6.1 AgentInstance

```typescript
// orchestrator/agent-instance.ts

type InstanceStatus = 'idle' | 'running' | 'paused' | 'error'

interface AgentInstance {
  id: string
  sessionId: string
  windowId: string
  status: InstanceStatus
  currentTask: Task | null

  run(message: string, context?: ContextHints): Promise<void>
  abort(): void
  getTokenUsage(): TokenUsage
}
```

AgentInstance 内部流程：

```
run(message)
  ├─ 构建 RunRequest（message + context hints + session history refs）
  ├─ 调用 Core（WASM 或 sidecar）
  ├─ 处理流式事件
  │   ├─ delta → ChatStore.updateStreaming()
  │   ├─ tool_call → 显示工具调用卡片
  │   ├─ tool_result → 更新卡片状态
  │   └─ done → ChatStore.finalizeMessage() + 持久化
  └─ 错误处理（重试 / 上报）
```

### 6.2 TaskQueue

```typescript
// orchestrator/task-queue.ts

interface Task {
  id: string
  instanceId: string
  sessionId: string
  description: string         // Agent 自动提取的任务描述
  status: 'pending' | 'running' | 'done' | 'failed'
  createdAt: number
  completedAt?: number
  steps: TaskStep[]
}

interface TaskStep {
  toolName: string
  input: unknown
  output: unknown
  durationMs: number
  status: 'ok' | 'error'
}

class TaskQueue {
  private queue: Task[]
  private maxConcurrent: number

  enqueue(task: Task): void
  dequeue(instanceId: string): Task | null
  updateStatus(taskId: string, status: Task['status']): void
  getAll(): Task[]
  getByInstance(instanceId: string): Task[]
}
```

### 6.3 Gateway

Gateway 聚合所有 AgentInstance 状态，供看板 UI 消费：

```typescript
// orchestrator/gateway.ts

class Gateway {
  private instances: Map<string, AgentInstance>

  register(instance: AgentInstance): void
  unregister(instanceId: string): void

  getStatus(): GatewayStatus
  getTaskView(): TaskView[]       // 看板数据
  getTotalTokenUsage(): TokenUsage
  enforceResourceLimit(): void    // 超内存上限时拒绝新实例
}

interface GatewayStatus {
  instanceCount: number
  runningCount: number
  totalTokensUsed: number
  estimatedTotalCost: number
}
```

### 6.4 并发控制

```typescript
const INSTANCE_LIMITS = {
  maxInstances: 3,              // 默认并发上限（可配置）
  maxTokensPerSession: 500_000, // 单 session token 预算
  maxMemoryMb: 450,             // 内存上限（配合非功能需求 < 500MB）
}
```

当 `gateway.instanceCount >= maxInstances` 时，新建窗口会提示用户等待或关闭已有窗口。

---

## 7. 数据层设计

### 7.1 SQLite Schema

```sql
-- schema version 1
-- 所有时间字段存 Unix timestamp (ms)

CREATE TABLE schema_version (
  version   INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  window_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  metadata     TEXT    -- JSON blob
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  role         TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  token_count  INTEGER,
  metadata     TEXT   -- JSON blob（tool_calls, tool_results, cost 等）
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TABLE memory_segments (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  segment_type TEXT NOT NULL CHECK(segment_type IN ('summary','decision','finding','pending')),
  content      TEXT NOT NULL,
  embedding    BLOB,           -- 可选：向量嵌入（Phase 3）
  created_at   INTEGER NOT NULL,
  turn_range   TEXT            -- JSON: { start: N, end: N }
);
CREATE INDEX idx_memory_session ON memory_segments(session_id);

CREATE TABLE tool_executions (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id),
  tool_name    TEXT NOT NULL,
  input        TEXT NOT NULL,  -- JSON
  output       TEXT,           -- JSON
  status       TEXT NOT NULL CHECK(status IN ('ok','error','pending')),
  duration_ms  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
```

### 7.2 Schema 迁移策略

使用版本号递增方案，Rust 侧应用启动时自动运行迁移：

```rust
// src-tauri/src/migrations.rs
const MIGRATIONS: &[Migration] = &[
  Migration {
    version: 1,
    description: "initial schema",
    sql: include_str!("../migrations/001_initial.sql"),
  },
  // 后续版本追加
];
```

迁移规则：
- 只追加，不删除旧列（向后兼容）
- 删除列需经过两个版本：先标记 deprecated，下一版本再删
- 每次自动更新前先备份 SQLite 文件（保留 3 个版本）

### 7.3 全文检索实现

FTS5 虚拟表配置 `content_rowid` 指向 `messages` 表，保持同步：

```sql
-- 插入消息后同步更新 FTS
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

搜索接口：

```sql
SELECT m.id, m.session_id, m.content, m.created_at,
       snippet(messages_fts, 0, '<b>', '</b>', '...', 20) as snippet
FROM messages_fts f
JOIN messages m ON m.rowid = f.rowid
WHERE messages_fts MATCH ?
ORDER BY rank
LIMIT 50;
```

---

## 8. IPC 协议设计

### 8.1 Tauri Command 命名规范

所有 Tauri command 采用 snake_case，按模块分组：

```
fs_read_file
fs_write_file
fs_list_dir
fs_git_status

shell_execute
shell_kill

keychain_store
keychain_get
keychain_delete

db_query
db_execute

agent_run
agent_abort
agent_get_usage
```

### 8.2 标准响应格式

所有 command 返回统一 Result 格式（Rust serde）：

```rust
#[derive(Serialize)]
#[serde(tag = "status")]
enum CommandResult<T> {
  #[serde(rename = "ok")]
  Ok { data: T },
  #[serde(rename = "error")]
  Error { code: String, message: String },
}
```

前端 bridge 层统一处理错误：

```typescript
// bridge/index.ts
async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  const result = await tauriInvoke<CommandResult<T>>(cmd, args)
  if (result.status === 'error') throw new AppError(result.code, result.message)
  return result.data
}
```

### 8.3 Event 命名规范

Tauri 事件（Rust → JS 推送）采用 `domain:action` 格式：

```
agent:stream:delta        { instanceId, delta: string }
agent:stream:tool_call    { instanceId, toolName, input }
agent:stream:tool_result  { instanceId, toolName, status, output }
agent:stream:done         { instanceId, usage: TokenUsage }
agent:error               { instanceId, code, message }

session:restored          { sessionId }
task:status_changed       { taskId, status }
```

### 8.4 大数据传输

工具执行结果可能很大（如文件内容），采用流式分块传输：

```rust
// 超过 64KB 的结果分块 emit
const CHUNK_SIZE: usize = 65536;

fn emit_large_result(app: &AppHandle, event: &str, data: &[u8]) {
  let chunks: Vec<_> = data.chunks(CHUNK_SIZE).collect();
  let total = chunks.len();
  for (i, chunk) in chunks.iter().enumerate() {
    app.emit(event, ChunkPayload { index: i, total, data: chunk }).ok();
  }
}
```

---

## 9. 上下文引擎集成

### 9.1 复用边界

Partner 直接复用 `@open-vera/core/context`，不重新实现。具体复用模块：

| 模块 | 接口入口 | Partner 使用方式 |
|------|---------|----------------|
| `context/window.ts` | `trimToWindow(messages, opts)` | 每次发送前裁剪 |
| `context/compression.ts` | `compressSegment(segment)` | 超阈值时压缩 |
| `context/idle-compression.ts` | `IdleCompressor` 类 | 空闲 314s 自动触发 |
| `context/tool-budget.ts` | `applyToolBudget(result)` | 工具输出截断 |

### 9.2 上下文构建流程

每次 `agent.run()` 调用前构建 LLM 请求上下文：

```
1. 从 SQLite 加载当前 session 的消息历史
   └─ 取最近 K 条原文（working memory）
   └─ 取相关 memory_segments（semantic recall via findRelevantSegments）

2. trimToWindow(messages, { maxTokens: contextWindowSize * 0.7 })
   └─ 保留 system prompt + 原始任务锚点 + 最近 N 轮
   └─ 超出时触发 compressSegment

3. 注入结构化摘要（summary/decisions/findings/pending）

4. 拼装最终 prompt → 送入 LLM adapter
```

### 9.3 空闲压缩集成

```typescript
// orchestrator/agent-instance.ts
class AgentInstance {
  private idleCompressor: IdleCompressor

  constructor(sessionId: string) {
    this.idleCompressor = new IdleCompressor({
      idleMs: 314_000,
      onCompress: async (segments) => {
        await this.persistMemorySegments(segments)
      },
    })
  }

  // 用户输入时重置空闲计时器
  onUserInput() {
    this.idleCompressor.interrupt()
  }
}
```

### 9.4 Token 计费实时显示

每条消息完成后从 LLM 响应中提取 usage，更新 SettingsStore：

```typescript
const COST_PER_1K: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  // ...
}

function calcCost(usage: TokenUsage, model: string): number {
  const rates = COST_PER_1K[model] ?? { input: 0, output: 0 }
  return (usage.inputTokens / 1000) * rates.input
       + (usage.outputTokens / 1000) * rates.output
}
```

---

## 10. 工具系统

### 10.1 工具注册表

Partner 内置工具通过 Tool Registry 注册，Agent Core 通过名称查找并调用：

```typescript
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

class ToolRegistry {
  private tools: Map<string, Tool>
  register(tool: Tool): void
  get(name: string): Tool | undefined
  listAll(): ToolDefinition[]
}
```

### 10.2 内置工具实现

| 工具名 | 实现位置 | 底层调用 |
|--------|---------|---------|
| `read_file` | JS bridge → Tauri `fs_read_file` | Rust `std::fs::read_to_string` |
| `write_file` | JS bridge → Tauri `fs_write_file` | Rust `std::fs::write` |
| `edit_file` | JS 端做字符串替换 → `write_file` | — |
| `list_dir` | JS bridge → Tauri `fs_list_dir` | Rust `std::fs::read_dir` |
| `bash` | JS bridge → Tauri `shell_execute` | Rust `Command::new` + sandbox |
| `glob` | Rust 侧实现（glob crate） | — |
| `grep` | Rust 侧实现（ripgrep 库） | — |
| `browser` | Playwright via Node.js sidecar | — |
| `web_search` | AnySearch Skill（Phase 4） | Tavily API + 百度 API |

### 10.3 工具结果截断

通过 `context/tool-budget.ts` 控制单工具结果体积：

```typescript
const TOOL_BUDGETS: Record<string, number> = {
  read_file:  50_000,   // ~50K chars
  bash:       20_000,
  grep:       30_000,
  browser:    10_000,
}
```

超出预算时末尾追加 `\n[输出过长，已截断 N 字节]` 提示。

### 10.4 工具调用 UI 卡片

每次工具调用在对话流中内联展示为可展开卡片：

```
┌─ 🔧 read_file ───────────────── ✅ ─┐
│ path: src/components/App.vue         │
│ [展开查看输出 ↓]                      │
└──────────────────────────────────────┘
```

折叠态：工具名 + 关键参数 + 状态图标  
展开态：完整 input/output，代码块高亮

---

## 11. 安全实现

### 11.1 API Key 存储

```
存储策略（按优先级）：
  1. 系统 Keychain
     ├─ Windows: Windows Credential Manager (via keyring crate)
     ├─ macOS: Keychain Services (via keyring crate)
     └─ Linux: libsecret / KWallet (via keyring crate)
  2. 回退（无 Keychain 时）：
     └─ ~/.partner/keys.enc
         ├─ AES-256-GCM 加密
         └─ 派生密钥：PBKDF2(机器 UUID + salt, 100_000 iterations, SHA-256)
```

API Key 永不进入：
- SQLite（settings 表存 Key 引用，不存明文）
- 日志
- 对话上下文
- 导出文件

### 11.2 Tauri Capability 配置

```json
// tauri.conf.json (精简，仅必要权限)
{
  "app": {
    "security": {
      "capabilities": ["partner-core"]
    }
  }
}

// capabilities/partner-core.json
{
  "identifier": "partner-core",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-execute",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "fs:allow-read-dir",
    "sql:default",
    "http:default"
  ]
}
```

### 11.3 插件安全模型

插件运行在独立 Worker 线程，通过 MessageChannel 与主线程通信：

```
主线程 (Orchestrator)
  │  postMessage({ type: 'tool_call', ... })
  ▼
Worker 线程 (PluginRuntime)
  │  执行插件代码
  │  postMessage({ type: 'tool_result', ... })
  ▼
主线程（接收结果）
```

Worker 内无 `importScripts` 白名单外 URL 权限，网络请求经网关代理过滤。

---

## 12. 构建与打包

### 12.1 开发构建流程

```bash
# 启动开发模式（HMR + Tauri）
pnpm tauri dev

# 前端独立开发（无 Tauri）
pnpm dev
```

### 12.2 生产构建

```bash
# 生产构建（自动打包为平台安装包）
pnpm tauri build

# 产物：
#   Windows: target/release/bundle/nsis/*.exe
#   macOS:   target/release/bundle/dmg/*.dmg
#   Linux:   target/release/bundle/appimage/*.AppImage
```

### 12.3 WASM 构建（方案 A）

Phase 2 spike 验证通过后，补充 WASM 构建脚本：

```bash
# 编译 OpenVera Core 逻辑层为 WASM
cd packages/core
wasm-pack build --target web --out-dir ../../partner/src/wasm/openvera-core

# partner/vite.config.ts 引入 WASM
import { vitePlugin as wasm } from '@wasm-tool/vite-plugin-wasm'
```

### 12.4 自动更新

使用 Tauri `updater` 插件，更新流程：

```
应用启动 → 检查 update server（GitHub Releases / 自托管）
  → 有更新 → 提示用户（非强制）
  → 用户确认 → 下载 .zip / .sig
  → 签名验证（ed25519）
  → 备份当前 SQLite
  → 应用补丁 → 重启
  → 启动时运行 schema migration
```

---

## 13. 测试策略

### 13.1 测试分层

| 层次 | 工具 | 覆盖目标 | 位置 |
|------|------|---------|------|
| 单元测试 | Vitest | 工具函数、Store 逻辑、Bridge 包装 | `tests/unit/` |
| Rust 单元测试 | cargo test | Rust Commands、沙箱逻辑 | `src-tauri/src/` |
| 集成测试 | Vitest + mock Tauri IPC | Orchestrator、TaskQueue、Gateway | `tests/integration/` |
| E2E 测试 | Playwright + Tauri driver | 完整用户流程 | `tests/e2e/` |

### 13.2 覆盖率门禁

| 模块 | 最低覆盖率 |
|------|----------|
| `orchestrator/` | 80% |
| `bridge/` | 80% |
| `stores/` | 70% |
| `src-tauri/src/commands/` | 80% |
| 整体 | 70% |

### 13.3 关键测试用例

**Orchestrator**：
- 单实例正常 run → done 流程
- abort 中断正在运行的实例
- 超过 maxInstances 时拒绝创建新实例
- 实例崩溃后 Gateway 状态更新

**数据层**：
- schema migration v1 → v2 兼容性
- FTS 搜索中文内容
- 大消息（>64KB）存取正确

**安全**：
- 路径穿越攻击被拒绝
- Shell 白名单外命令被拒绝
- API Key 不出现在日志或导出文件

---

## 14. 性能指标与约束

### 14.1 指标目标

| 指标 | 目标 | 测量方法 |
|------|------|---------|
| 冷启动时间 | < 3s | `tauri::Manager::app_handle` 到首帧 |
| 空闲内存 | < 150MB | Windows Task Manager RSS |
| 多实例运行内存 | < 500MB (3 实例) | 压测 3 个并发 Agent |
| 流式首字节延迟 | < 500ms | LLM 返回首 token 到 UI 更新 |
| IPC 调用延迟 | < 5ms | Tauri bench |
| SQLite 写入（单消息） | < 10ms | Rust benchmark |

### 14.2 内存管理

- 消息列表虚拟滚动（超过 100 条时）：仅渲染可视区域
- 工具输出默认折叠，展开时才挂载 DOM
- 闲置 Agent Instance（> 10 分钟无活动）释放内存快照，保留持久化状态

---

## 15. 开放技术风险

与 PRD 第 9 节对应，补充工程层面的风险评估与应对：

| # | 风险 | 概率 | 影响 | 缓解措施 |
|---|------|------|------|---------|
| 1 | WASM 编译不可行 | 中 | 高 | Phase 2 立即做 spike；准备好 Node.js sidecar 方案，2 周内定案 |
| 2 | Tauri 2.x API 与现有 gateway-ui Vue 代码不兼容 | 低 | 中 | 提前搭骨架项目验证，bridge 层隔离 |
| 3 | SQLite FTS5 中文分词效果差 | 中 | 中 | 接入 jieba-rs (Rust binding) 做预分词；或用 mmseg |
| 4 | 多实例内存超 500MB | 中 | 中 | 强制 maxInstances=3；超限告警；AG 空闲内存释放策略 |
| 5 | AnySearch Tavily API 在中国大陆访问不稳定 | 高 | 中 | 优先百度搜索；Tavily 作为补充；用户可配置搜索源 |
| 6 | Playwright 浏览器工具包体超限 | 中 | 低 | 浏览器工具按需下载，不打包进安装包 |

---

## 附录 A：类型定义索引

主要共享类型定义位于 `src/types/index.ts`：

```typescript
export type { Message, ChatStore }      // 对话相关
export type { Session, SessionStore }    // 会话相关
export type { Task, TaskStep, TaskQueue } // 任务相关
export type { AgentInstance }            // 实例相关
export type { GatewayStatus }            // 网关聚合状态
export type { LLMProvider, SettingsStore } // 配置相关
export type { ToolDefinition, ToolResult } // 工具相关
export type { TokenUsage }               // 计费相关
```

## 附录 B：Phase 对应交付物速查

| Phase | 主要交付 | 关键技术决策 |
|-------|---------|------------|
| Phase 1 | Tauri + Vue 骨架、三栏布局、IPC bridge | — |
| Phase 2 | Core 集成（WASM/sidecar）、对话持久化、无限上下文（工作/摘要记忆）、token 计费 | **WASM spike 结论** |
| Phase 3 | 全文搜索、长期记忆语义检索、预览面板、主题、崩溃恢复 | FTS 分词方案 |
| Phase 4 | 多实例编排、任务看板、AnySearch、STT | 搜索 API 选型 |
| Phase 5 | 跨平台打包、自动更新、文档 | — |
