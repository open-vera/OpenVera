# Session 管理

> Vera 的 Session 持久化、分支、恢复、费用追踪与搜索系统。

---

## 概述

Vera 将每次对话以 **JSONL（JSON Lines）** 格式持久化到本地文件系统。单个 Session 文件是一个追加写入的 `.jsonl` 文件，每行一条 JSON 记录（entry），按时间顺序记录从 Session 启动到结束的全部事件。

核心模块位于 `packages/core/src/session/`，主要组件：

| 组件 | 文件 | 职责 |
|---|---|---|
| `SessionStore` | `store.ts` | Session 读写的主入口，封装 JSONL 追加、列表、加载、分支 |
| `SessionManager` | `session-manager.ts` | 高层管理：自动压缩、去重合并、索引构建、关键词搜索、生命周期清理 |
| `SessionStoreBackend` | `backend.ts` | 存储后端抽象接口，JSONL 文件和 SQLite 共用同一接口 |
| `generateSessionTitle` | `title.ts` | AI 驱动的 Session 标题生成 |
| `calculateCost` / `accumulateCost` | `cost.ts` | 基于内置定价表的费用计算 |

---

## Session 生命周期

一个 Session 从创建到结束，经历以下阶段：

```
session_start → user → [assistant → tool_call → tool_result]* → session_end
```

### 写入流程

1. **启动**：`writeStart(model, provider)` — 写入 `session_start` entry，记录模型、provider、工作目录
2. **用户输入**：`writeUser(content)` — 每次用户消息写入一条 `user` entry，返回 UUID
3. **助手响应**：`writeAssistant(...)` — 写入 `assistant` entry，包含模型名、usage、延迟、stop_reason 等
4. **工具调用**：`writeToolCall(...)` / `writeToolResult(...)` — 记录工具名称、参数、结果
5. **结束**：`writeEnd(totalUsage, totalCostUsd, turnCount, lastPrompt)` — 写入 `session_end` entry 和可选的 `last-prompt` entry

### 生命周期管理（SessionManager）

`SessionManager` 提供自动清理机制：

- **TTL 过期清理**：默认 30 天未活动的 Session 自动删除（可配置 `ttlDays`）
- **数量上限清理**：每个项目默认最多保留 1000 个 Session，超出时删最旧的（可配置 `maxSessions`）
- **dryRun 模式**：`cleanup({ dryRun: true })` 只返回将被清理的列表，不实际删除

```ts
const manager = new SessionManager({ ttlDays: 30, maxSessions: 1000 });
const result = manager.cleanup({ cwd: "/path/to/project" });
// → { removedCount, removedSessionIds, remainingCount }
```

---

## JSONL 格式

### 文件路径

Session 文件存储在全局数据目录下，按项目路径散列：

```
<globalData>/projects/<sanitized-project-path>/<sessionId>.jsonl
```

其中项目路径经过以下处理：
- 非字母数字字符替换为 `-`
- 路径过长（超过 80 字符）时截断并追加哈希后缀

### Entry 类型一览

| type | 说明 | 关键字段 |
|---|---|---|
| `session_start` | Session 启动标记 | `cwd`, `model`, `provider` |
| `user` | 用户消息 | `uuid`, `content` |
| `assistant` | 助手响应 | `uuid`, `parentUuid`, `content`, `model`, `usage`, `stopReason`, `turn`, `latencyMs`, `status` |
| `tool_call` | 工具调用请求 | `uuid`, `parentUuid`, `toolName`, `toolCallId`, `arguments` |
| `tool_result` | 工具调用结果 | `uuid`, `parentUuid`, `toolCallId`, `content` |
| `session_end` | Session 结束标记 | `totalUsage`, `totalCostUsd`, `turnCount` |
| `last-prompt` | 最后一条用户提示 | `lastPrompt` |
| `custom-title` | 用户自定义标题 | `customTitle` |
| `ai-title` | AI 自动生成标题 | `aiTitle` |
| `summary` | 对话摘要 | `summary`, `leafUuid` |
| `tag` | 标签（分类/合并标记） | `tag` |
| `git-branch` | 关联 Git 分支 | `gitBranch` |
| `pr-link` | 关联 PR 链接 | `prUrl`, `prRepository`, `prNumber` |
| `branch` | 分支关系标记 | `parentSessionId`, `forkedFromUuid`, `status` |

### 特性

- **追加写入**：所有写入使用 `appendFileSync` 原子追加，安全可恢复。即使进程崩溃，已写入的 entry 不丢失。
- **损坏恢复**：解析 JSONL 时跳过无法 parse 的行，保证部分损坏不影响剩余数据读取。
- **渐进式摘要**：`readSessionSummary` 采用两级加载策略 —— 先读文件头部 64 KB（解析 session_start + 首条 prompt + 标题），再读尾部 64 KB（解析 session_end + 最新标题/摘要），无需全量加载大文件。

---

## 分支系统

Vera 支持从任意 Session 的任意消息节点 **Fork** 出新分支，实现对话的并行探索。

### 分支状态

| 状态 | 说明 |
|---|---|
| `active` | 活跃分支，正在使用中 |
| `adopted` | 被采纳为主干（分支内容成为正式结论） |
| `merged` | 已合并回父 Session |
| `discarded` | 已丢弃（实验/错误方向） |

### 操作

**Fork 新分支**（通过 `SessionStore.forkSession`）：

```ts
const forked = SessionStore.forkSession({
  fromSessionId: "parent-session-id",
  title: "尝试方案B",
  atUuid: "message-uuid",  // 可选，不指定则从最后一条消息 fork
  worktreePath: "/tmp/worktree",
  worktreeBranch: "topic-b",
  baseCommit: "abc123",
});
// → { sessionId, parentSessionId, forkedFromUuid, filePath, title }
```

Fork 时会：
1. 读取父 Session 的完整 JSONL 文件
2. 过滤出可重放的消息（排除 `session_end`、`summary`、`tag` 等元数据 entry）
3. 复制到新文件并写入 `branch` entry（`status: "active"`）
4. 自动追加 `(Branch)` 后缀到标题

**列出分支**：

```ts
const branches = SessionStore.listBranches("parent-session-id");
// → 过滤出 parentSessionId 匹配且 status !== "discarded" 的 Session
```

**分支生命周期操作**：

```ts
SessionStore.adoptBranch(sessionId);   // 标记为 adopted
SessionStore.markBranchMerged(sessionId); // 标记为 merged
SessionStore.discardBranch(sessionId);    // 标记为 discarded
```

---

## 恢复

`SessionStore.loadSession` 从 JSONL 文件中重放全部对话历史，恢复为 `LoadedSession`：

```ts
const loaded = SessionStore.loadSession("session-id");
// → {
//     sessionId, filePath, cwd,
//     history: Message[],  // 用户消息 + 助手响应（不含工具调用细节）
//     totalUsage, totalCostUsd, turnCount,
//     model, provider
//   }
```

加载逻辑：
1. 逐行解析 JSONL，按 `user` / `assistant` entry 重建 `Message[]` 数组
2. 累加所有 assistant entry 的 usage 和 cost
3. 优先信任 `session_end` entry 中的总费用（覆盖累加值，保证精确）

**转录预览**（`loadTranscriptPreview`）提供更轻量的视图，包含工具调用详情但不重建完整对话历史，适合 UI 列表展示。

---

## AI 标题生成

`generateSessionTitle` 使用 LLM 自动为 Session 生成简洁标题：

```ts
const title = await generateSessionTitle({
  adapter: llmAdapter,
  model: "claude-haiku-4-5",
  userPrompt: "帮我写一个快速排序的 TypeScript 实现",
  assistantText: "以下是快速排序的 TS 实现...",
  signal: abortController.signal,
});
// → "快速排序 TypeScript 实现"
```

实现细节：
- 使用 Claude API，`max_tokens=32`，`temperature=0`
- System prompt 要求返回 3-8 个英文单词或简短中文短语，不带引号
- 自动截断过长输入（user 2000 字符，assistant 2000 字符）
- 生成后自动清洗（去引号、去首尾空白、超过 80 字符截断）
- 返回 `null` 表示无法生成标题

生成的标题通过 `writeAiTitle` 写入 JSONL 文件。

---

## 费用追踪

### 定价表

内置多模型定价（`cost.ts`），按 USD / 百万 token：

| 模型 | Input | Output | Cache Write | Cache Read |
|---|---|---|---|---|
| claude-opus-4-6 | $15.00 | $75.00 | $18.75 | $1.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $3.75 | $0.30 |
| claude-haiku-4-5 | $0.80 | $4.00 | $1.00 | $0.08 |
| gpt-4o | $2.50 | $10.00 | - | - |
| gpt-4o-mini | $0.15 | $0.60 | - | - |
| o3 | $10.00 | $40.00 | - | - |
| o4-mini | $1.10 | $4.40 | - | - |
| gemini-2.0-flash | $0.10 | $0.40 | - | - |
| gemini-2.5-pro | $1.25 | $10.00 | - | - |

### 模型名归一化

`normalizeModelKey` 去掉日期后缀和 `-latest`/`-preview`/`-exp` 变体，确保 `claude-sonnet-4-6-20251001` 匹配到 `claude-sonnet-4-6` 的定价。

### 计算

```ts
// 单次调用费用
const turnCost = calculateCost(usage, "claude-sonnet-4-6");

// 累加费用（immutable），返回新的 AccumulatedCost
const next = accumulateCost(current, usage, model, provider);
// next = {
//   totalUsd: 累计总费用,
//   byModel: { "model-key": { usage, costUsd } },
//   totalUsage: 累计总 token
// }
```

费用在 `session_end` entry 中持久化，恢复时可直接读取，无需重算。

---

## Session 列表与搜索

### 列表

`SessionStore.listSessions` 返回当前项目的所有 Session 摘要：

```ts
const summaries = SessionStore.listSessions(); // → SessionSummary[]
```

`SessionSummary` 包含：`sessionId`、`filePath`、`startedAt`、`lastActivityAt`、`model`、`turnCount`、`totalUsage`、`totalCostUsd`、`cwd`、`title`、`summary`、`firstPrompt`、`tag`、`gitBranch`、`pr`、`branch` 等字段。

**分页列表**：

```ts
const result = SessionStore.listSessionsPaged({
  cwd: "/path/to/project",
  limit: 20,
  offset: 0,
  includeWorktrees: true,
});
// → { sessions: SessionSummary[], nextOffset?: number, totalCandidates: number }
```

**候选文件**（不含摘要，仅文件元数据，性能高于 `listSessions`）：

```ts
const candidates = SessionStore.listSessionCandidates({ cwd });
// → [{ sessionId, filePath, mtimeMs, fileSize }]
```

### 搜索（SessionManager）

`SessionManager` 提供基于内存索引的关键词搜索：

```ts
const manager = new SessionManager();
manager.buildIndex(summaries);           // 构建索引
const results = manager.searchByKeyword("quick sort");
// → 按相关度排序的 SessionIndexEntry[]
```

搜索逻辑：
- 将查询拆分为词项，在标题、摘要、首条 prompt、关键词中匹配
- 标题匹配获得 2 倍权重
- 关键词精确匹配获得 1 倍额外权重
- 中英文通用：stop words 过滤包括中文（的、了、是...）和英文（the、a、an...）

### 相似度检测

```ts
const similar = manager.findSimilarSessions(targetId, candidates, 0.6);
// → [{ session: SessionSummary, similarity: number, matchReason: string }]
```

- 基于 trigram Jaccard 相似度算法（轻量、无外部依赖）
- 匹配原因包括：相同标题、相似首条 prompt、相同 Git 分支、相似摘要

### 去重合并

```ts
manager.mergeSessions("primary-id", ["duplicate-1", "duplicate-2"]);
// → 主 Session 写入 "merged-from:xxx" tag
// → 重复 Session 写入 "merged-into:yyy" tag
```
