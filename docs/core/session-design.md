# Session 系统设计

> 本文档描述 OpenVera 的会话持久化系统，包括 JSONL 存储格式、会话生命周期、分支机制、成本追踪和搜索能力。

## 概述

Session 系统是 OpenVera 的会话持久化层，负责记录每一次 agent 对话的全部过程。核心设计原则：

- **JSONL 格式**：每行一条 JSON 记录，人类可读、易于 grep/流式处理
- **双后端**：默认 JSONL 文件存储，可选 SQLite 后端（具备 FTS 搜索和索引能力）
- **渐进式加载**：仅读取头尾各 64KB 即可生成摘要，全量读取仅用于恢复对话
- **分支原生支持**：可从任意 turn 分叉（fork），多个分支独立推进，最终合并

核心代码位于 `packages/core/src/session/`。

## 会话生命周期

### 创建

```typescript
import { SessionStore } from "@open-vera/core";

const store = new SessionStore({ cwd: "/path/to/project" });
// sessionId 自动生成（crypto.randomUUID()）
// 文件路径：~/.vera/projects/<sanitized_cwd>/<sessionId>.jsonl

store.writeStart("claude-sonnet-4-6", "anthropic");
```

`new SessionStore()` 会自动创建项目目录（`~/.vera/projects/<cwd_hash>/`），文件名使用 UUID。

### 写入对话

每次 agent loop 中的用户输入、LLM 响应、工具调用和结果都会按序写入：

```typescript
const userUuid = store.writeUser("帮我创建一个 React 组件");
const assistantUuid = store.writeAssistant({
  parentUuid: userUuid,
  content: "好的，我来创建...",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  stopReason: "tool_use",
  usage: { input_tokens: 500, output_tokens: 200 },
  turn: 1,
  latencyMs: 1234,
  toolCalls: ["write"],
  status: "ok",
});
```

工具调用单独记录：

```typescript
const toolCallUuid = store.writeToolCall({
  parentUuid: assistantUuid,
  toolName: "write",
  toolCallId: "toolu_xxx",
  arguments: { file_path: "/path/to/Component.tsx", content: "..." },
});

store.writeToolResult({
  parentUuid: toolCallUuid,
  toolCallId: "toolu_xxx",
  content: "File written successfully.",
});
```

### 结束会话

```typescript
const totalUsage = { input_tokens: 5000, output_tokens: 3000 };
const totalCostUsd = 0.045;
const turnCount = 5;

store.writeEnd(totalUsage, totalCostUsd, turnCount, lastUserPrompt);
```

`writeEnd` 会同时写入 `last-prompt`（最后一条用户输入的前 120 字符，用于列表预览）和 `session_end` 两项条目。

### 加载与恢复

```typescript
const loaded = SessionStore.loadSession(sessionId, cwd);
// LoadedSession { sessionId, filePath, cwd, history: Message[], totalUsage, totalCostUsd, turnCount, model, provider }
```

恢复时仅解析 `user` 和 `assistant` 类型的条目，跳过 `tool_call`/`tool_result`（这些信息已包含在 assistant 的 content 中）。

### 读取摘要（无需全量加载）

```typescript
const summary = SessionStore.loadTranscriptPreview(sessionId, cwd);
// SessionTranscriptPreview { sessionId, messages: SessionPreviewMessage[], summary?: SessionSummary }
```

摘要读取仅访问文件头尾各 64KB，包含：
- `SessionSummary`：模型、provider、turn 数、cost、title、summary、tag、git branch、PR 链接
- `SessionPreviewMessage[]`：用户和 assistant 消息，含 tool use 详情

### 列表与分页

```typescript
const result = SessionStore.listSessionsPaged({
  cwd: "/path/to/project",   // 按项目过滤
  limit: 20,                  // 每页条数
  offset: 0,                  // 偏移量
  includeWorktrees: true,     // 是否包含 git worktree 下的会话
});
// ListSessionsResult { sessions: SessionSummary[], nextOffset?: number, totalCandidates: number }
```

## JSONL 格式与 Schema

每条记录是独立的 JSON 行。以下是完整的 entry 类型定义（`types.ts`）：

### session_start
```json
{"type":"session_start","sessionId":"uuid","timestamp":"ISO-8601","cwd":"/path","model":"claude-sonnet-4-6","provider":"anthropic"}
```

### user
```json
{"type":"user","sessionId":"uuid","timestamp":"ISO-8601","uuid":"msg-uuid","content":"用户输入内容"}
```

### assistant
```json
{"type":"assistant","sessionId":"uuid","timestamp":"ISO-8601","uuid":"msg-uuid","parentUuid":"user-uuid","content":"LLM响应","model":"claude-sonnet-4-6","provider":"anthropic","stopReason":"end_turn|tool_use|max_tokens|stop","usage":{"input_tokens":500,"output_tokens":200},"turn":1,"latencyMs":1234,"toolCalls":["write","read"],"status":"ok|error"}
```

### tool_call
```json
{"type":"tool_call","sessionId":"uuid","timestamp":"ISO-8601","uuid":"tc-uuid","parentUuid":"assistant-uuid","toolName":"write","toolCallId":"toolu_xxx","arguments":{"file_path":"/a/b.ts"}}
```

### tool_result
```json
{"type":"tool_result","sessionId":"uuid","timestamp":"ISO-8601","uuid":"tr-uuid","parentUuid":"tc-uuid","toolCallId":"toolu_xxx","content":"工具返回内容"}
```

### session_end
```json
{"type":"session_end","sessionId":"uuid","timestamp":"ISO-8601","totalUsage":{"input_tokens":5000,"output_tokens":3000},"totalCostUsd":0.045,"turnCount":5}
```

### 元数据条目

| type | 说明 |
|---|---|
| `custom-title` / `custom_title` | 用户自定义标题 |
| `ai-title` | AI 自动生成的标题 |
| `summary` | 会话摘要（自动压缩时生成） |
| `last-prompt` / `last_prompt` | 最后一条用户消息（前 120 字符） |
| `tag` | 标签（支持多条，如 `merged-from:xxx`） |
| `git-branch` | 会话所在 git 分支 |
| `pr-link` | 关联的 PR 链接 |
| `branch` | 分支/分叉标记（parentSessionId、forkedFromUuid、status） |

### 内容截断

`preview()` 函数将所有字段截断到 120 字符：超长内容显示 `前117字...`。这避免了超长 prompt 撑大列表摘要。

## 会话元数据

### AI 自动标题

`generateSessionTitle()`（`title.ts`）在会话结束时调用，使用 LLM 基于第一条用户 prompt 和第一条 assistant 回复生成简短标题（3-8 词或中文短语）：

```typescript
import { generateSessionTitle } from "@open-vera/core";

const title = await generateSessionTitle({
  adapter: llmAdapter,
  model: "claude-haiku-4-5",
  userPrompt: "帮我重构用户认证模块",
  assistantText: "好的，我来分析现有代码...",
});
```

标题写入 `ai-title` 条目，在摘要显示时优先级：**用户自定义标题 > AI 标题 > 首条 prompt > 摘要**。

### 成本追踪

定价表位于 `cost.ts`，支持多模型：

```typescript
// 计算单次调用的成本
const cost = calculateCost(usage, "claude-sonnet-4-6");

// 累加到会话级别
const accumulated = accumulateCost(current, usage, model, provider);
// AccumulatedCost { totalUsd, byModel: Record<string, ModelCostRecord>, totalUsage }
```

模型名在查询定价表前会先归一化：去掉日期后缀（`-20251001`）、`-latest`、`-preview`、`-exp` 等。

当前支持的定价模型：Claude Opus 4.6、Sonnet 4.6、Haiku 4.5，以及 GPT-4o、GPT-4o-mini、o3、o4-mini、Gemini 2.0 Flash、Gemini 2.5 Pro。

## 分支机制

### 从任意 turn 分叉

```typescript
const forked = SessionStore.forkSession({
  fromSessionId: "parent-uuid",
  atUuid: "specific-message-uuid", // 可选：从指定的消息位置分叉，不传则从末尾
  title: "尝试方案B",
  cwd: "/path/to/project",
});
// ForkedSession { sessionId, parentSessionId, forkedFromUuid, filePath, title }
```

分叉实现：
1. 读取源会话的所有可重放条目（排除 `session_end`、`last-prompt`、`summary` 等元数据）
2. 复制到新文件，`sessionId` 替换为新 UUID
3. 写入 `branch` 条目标记分叉关系
4. 写入 `custom-title` 条目（如果提供了 title）

### 分支生命周期

分支有四种状态（`BranchStatus`）：

| 状态 | 说明 | 操作 |
|---|---|---|
| `active` | 活跃分支，正常推进中 | 创建时默认 |
| `adopted` | 被采纳为主路径 | `SessionStore.adoptBranch(id)` |
| `merged` | 已合并回父分支 | `SessionStore.markBranchMerged(id)` |
| `discarded` | 已废弃 | `SessionStore.discardBranch(id)` |

### 查询分支

```typescript
// 列出某个父会话的所有活跃分支
const branches = SessionStore.listBranches(parentSessionId, cwd);
// 返回 SessionSummary[]，不含 discarded 状态的分支
```

状态变更通过追加新 `branch` 条目实现（JSONL 不可原地修改）。读取时取最后一条 `branch` 条目的状态。

### 合并（merge）

通过 `SessionManager.mergeSessions()` 实现：

```typescript
const manager = new SessionManager();
manager.mergeSessions("primary-session-id", ["dup-1", "dup-2"]);
// primary 写入 merged-from 标签，duplicates 写入 merged-into 标签
```

这并非自动合并 JSONL 内容，而是通过标签建立关联。合并逻辑的实际含义是：标记重复会话，指向规范版本。

## 会话管理（SessionManager）

`SessionManager` 提供会话生命周期的高级能力：

### 自动压缩（SS1）

```typescript
const manager = new SessionManager({
  autoCompress: {
    enabled: true,
    tokenThreshold: 100_000,   // 触发压缩的 token 阈值
    keepRecentTurns: 6,        // 保留最近的 N 轮不解压
  },
});

const { messages, compressed, usage } = await manager.autoCompress(
  sessionId, messages, adapter, model
);
```

当消息历史的 token 数超过阈值时，自动将早期消息压缩为摘要，保留最近 N 轮完整对话。

### 去重与相似检测（SS2）

```typescript
const similar = manager.findSimilarSessions(targetSessionId, candidates, 0.6);
// SimilarSession[] sorted by similarity (Jaccard similarity on trigrams)
```

基于字符 trigram 的 Jaccard 相似度算法，比较标题、首条 prompt、摘要等维度。

### 索引与搜索（SS3）

```typescript
manager.buildIndex(sessions);
const results = manager.searchByKeyword("React 组件 测试");
// SessionIndexEntry[] sorted by relevance
```

支持中文和英文关键词，标题匹配有额外加分。停止词包含中英文常用词。

### TTL 清理（SS4）

```typescript
manager.cleanup({ cwd: "/project", dryRun: false });
// CleanupResult { removedCount, removedSessionIds, remainingCount }
```

两阶段清理：先删除超过 TTL（默认 30 天）的会话，若仍超过 maxSessions（默认 1000），再按最旧的活动时间删除。

## 存储后端

### JSONL 文件后端（默认）

- 存储路径：`~/.vera/projects/<sanitized_cwd>/<sessionId>.jsonl`
- 路径清理策略：非字母数字字符替换为 `-`，超长路径截断并追加 hash
- 支持 git worktree：列表时会包括 worktree 路径下的会话

### SQLite 后端（可选）

```typescript
const { backend, migrated } = await SessionStore.configureSqlite({
  dbPath: "~/.vera/sessions.db",
  enableFts: true,            // 启用 FTS5 全文搜索
  autoMigrate: true,          // 自动从 JSONL 迁移
});
```

SQLite 后端将 JSONL 内容完整保留在 `content` 字段中，同时提取 metadata 用于索引和查询。详见 `packages/core/src/session/sqlite-backend.ts`。

## 配置

会话相关配置通过 `settings.json` 的 `session` 字段：

```json
{
  "session": {
    "ai_title": true,
    "compact": {
      "enabled": true,
      "triggerTokens": 100000,
      "keepRecentTurns": 6
    },
    "ttlDays": 30,
    "maxSessions": 1000
  }
}
```

## 文件路径约定

```
~/.vera/
  projects/
    <sanitized_cwd_hash>/     # 如 Users-yang-zhou-workspace-my-project
      <uuid>.jsonl            # 单个会话文件
  settings.json               # 全局配置（含 API Key）
```

`sanitizePath()` 将路径中的非字母数字字符替换为 `-`，长路径加 djb2 hash 后缀以确保唯一性。`resolveSessionFilePath()` 支持向后兼容的多目录搜索。

## 代码示例

### 完整的会话记录与查询

```typescript
import { SessionStore, SessionManager, calculateCost } from "@open-vera/core";

// 1. 创建会话
const store = new SessionStore({ cwd: process.cwd() });
store.writeStart("claude-sonnet-4-6", "anthropic");
store.writeTitle("用户认证重构");

// 2. 记录对话
const userUuid = store.writeUser("帮我重写登录逻辑");
const cost = calculateCost({ input_tokens: 500, output_tokens: 200 }, "claude-sonnet-4-6");
const assistantUuid = store.writeAssistant({
  parentUuid: userUuid,
  content: "好的，我来分析...",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  stopReason: "end_turn",
  usage: { input_tokens: 500, output_tokens: 200 },
  turn: 1,
  latencyMs: 800,
  toolCalls: [],
  status: "ok",
});
store.writeEnd({ input_tokens: 500, output_tokens: 200 }, 0.0039, 1);

// 3. 查询列表
const { sessions } = SessionStore.listSessionsPaged({ limit: 10 });
for (const s of sessions) {
  console.log(`${s.title ?? s.summary} - ${s.turnCount} turns - $${s.totalCostUsd.toFixed(4)}`);
}

// 4. 恢复对话
const loaded = SessionStore.loadSession(store.sessionId);
console.log(`History: ${loaded.history.length} messages, Model: ${loaded.model}`);

// 5. 分叉新路径
const branch = SessionStore.forkSession({
  fromSessionId: store.sessionId,
  title: "方案B：使用OAuth库",
});
console.log(`Forked: ${branch.sessionId}`);
```
