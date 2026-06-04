# 会话系统设计

> 本文档描述 OpenVera 的会话持久化系统，包括 JSONL 存储格式、会话生命周期、分叉机制、费用追踪和搜索能力。

## 概述

Session 系统是 OpenVera 的会话持久化层，负责完整记录每次 agent 对话。核心设计原则：

- **JSONL 格式**：每行一条 JSON 记录，人类可读，方便 grep/流式处理
- **双后端**：默认 JSONL 文件存储，可选 SQLite 后端（含 FTS 全文搜索和索引）
- **渐进加载**：只读头尾各 64KB 生成摘要；完整读取仅用于对话恢复
- **原生 fork 支持**：从任意轮次分叉；多个分支独立推进，可合并

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

`new SessionStore()` 自动创建项目目录（`~/.vera/projects/<cwd_hash>/`），文件名使用 UUID。

### 写入对话

Agent loop 中的每次用户输入、LLM 响应、工具调用和结果按序写入：

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
  content: "文件写入成功。",
});
```

### 结束会话

```typescript
const totalUsage = { input_tokens: 5000, output_tokens: 3000 };
const totalCostUsd = 0.045;
const turnCount = 5;

store.writeEnd(totalUsage, totalCostUsd, turnCount, lastUserPrompt);
```

`writeEnd` 同时写入 `last-prompt` 条目（最后一次用户输入的前 120 字符，用于列表预览）和 `session_end` 条目。

### 加载与恢复

```typescript
const loaded = SessionStore.loadSession(sessionId, cwd);
// LoadedSession { sessionId, filePath, cwd, history: Message[], totalUsage, totalCostUsd, turnCount, model, provider }
```

恢复时仅解析 `user` 和 `assistant` 类型的条目；`tool_call`/`tool_result` 被跳过（这些信息已包含在 assistant 的 content 中）。

### 读取摘要（无需完整加载）

```typescript
const summary = SessionStore.loadTranscriptPreview(sessionId, cwd);
// SessionTranscriptPreview { sessionId, messages: SessionPreviewMessage[], summary?: SessionSummary }
```

摘要读取仅访问文件头尾各 64KB，包含：
- `SessionSummary`：模型、提供商、轮次数、费用、标题、摘要、标签、git 分支、PR 链接
- `SessionPreviewMessage[]`：用户和 assistant 消息（含工具使用详情）

### 列表与分页

```typescript
const result = SessionStore.listSessionsPaged({
  cwd: "/path/to/project",   // 按项目过滤
  limit: 20,                  // 每页条数
  offset: 0,                  // 偏移量
  includeWorktrees: true,     // 包含 git worktree 下的会话
});
// ListSessionsResult { sessions: SessionSummary[], nextOffset?: number, totalCandidates: number }
```

## JSONL 格式与 Schema

每条记录是独立的 JSON 行。完整的条目类型定义来自 `types.ts`：

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
{"type":"assistant","sessionId":"uuid","timestamp":"ISO-8601","uuid":"msg-uuid","parentUuid":"user-uuid","content":"LLM 响应","model":"claude-sonnet-4-6","provider":"anthropic","stopReason":"end_turn|tool_use|max_tokens|stop","usage":{"input_tokens":500,"output_tokens":200},"turn":1,"latencyMs":1234,"toolCalls":["write","read"],"status":"ok|error"}
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

| 类型 | 说明 |
|---|---|
| `custom-title` / `custom_title` | 用户自定义标题 |
| `ai-title` | AI 自动生成标题 |
| `summary` | 会话摘要（自动压缩时生成） |
| `last-prompt` / `last_prompt` | 最后一次用户消息（前 120 字符） |
| `tag` | 标签（支持多个，如 `merged-from:xxx`） |
| `git-branch` | 会话所在的 git 分支 |
| `pr-link` | 关联的 PR 链接 |
| `branch` | 分支/fork 标记（parentSessionId, forkedFromUuid, status） |

### 内容截断

`preview()` 函数将所有字段截断到 120 字符：过长内容显示 `前 117 字符...`。这防止超长提示词导致列表摘要膨胀。

## 会话元数据

### AI 自动标题

`generateSessionTitle()`（`title.ts`）在会话结束时调用，使用 LLM 根据首次用户提示和首次 assistant 回复生成简短标题（3-8 个词）：

```typescript
import { generateSessionTitle } from "@open-vera/core";

const title = await generateSessionTitle({
  adapter: llmAdapter,
  model: "claude-haiku-4-5",
  userPrompt: "帮我重构用户认证模块",
  assistantText: "好的，我来分析现有代码...",
});
```

标题写为 `ai-title` 条目。展示优先级：**用户自定义标题 > AI 标题 > 首条提示 > 摘要**。

### 费用追踪

价格表在 `cost.ts` 中，支持多种模型：

```typescript
// 计算单次调用费用
const cost = calculateCost(usage, "claude-sonnet-4-6");

// 累计到会话级别
const accumulated = accumulateCost(current, usage, model, provider);
// AccumulatedCost { totalUsd, byModel: Record<string, ModelCostRecord>, totalUsage }
```

模型名称在查询前会规范化：日期后缀（`-20251001`）、`-latest`、`-preview`、`-exp` 会被去除。

当前支持定价：Claude Opus 4.6、Sonnet 4.6、Haiku 4.5，以及 GPT-4o、GPT-4o-mini、o3、o4-mini、Gemini 2.0 Flash、Gemini 2.5 Pro。

## 分叉机制

### 从任意轮次分叉

```typescript
const forked = SessionStore.forkSession({
  fromSessionId: "parent-uuid",
  atUuid: "specific-message-uuid", // 可选：从特定消息分叉；省略则从末尾
  title: "尝试方案 B",
  cwd: "/path/to/project",
});
// ForkedSession { sessionId, parentSessionId, forkedFromUuid, filePath, title }
```

分叉实现：
1. 读取源会话中所有可回放的条目（排除 `session_end`、`last-prompt`、`summary` 等）
2. 复制到新文件，将 `sessionId` 替换为新 UUID
3. 写入 `branch` 条目标记分叉关系
4. 写入 `custom-title` 条目（如提供了标题）

### 分支生命周期

分支有四种状态（`BranchStatus`）：

| 状态 | 说明 | 操作 |
|---|---|---|
| `active` | 活跃分支，正常推进 | 创建时默认 |
| `adopted` | 被采纳为主路径 | `SessionStore.adoptBranch(id)` |
| `merged` | 合并回父分支 | `SessionStore.markBranchMerged(id)` |
| `discarded` | 已丢弃 | `SessionStore.discardBranch(id)` |

### 查询分支

```typescript
// 列出父会话的所有活跃分支
const branches = SessionStore.listBranches(parentSessionId, cwd);
// 返回 SessionSummary[]，排除已丢弃分支
```

状态变更通过追加新 `branch` 条目实现（JSONL 不可原地修改）。读取时使用最后一条 `branch` 条目的状态。

### 合并

通过 `SessionManager.mergeSessions()` 实现：

```typescript
const manager = new SessionManager();
manager.mergeSessions("primary-session-id", ["dup-1", "dup-2"]);
// 主会话获得 merged-from 标签，重复会话获得 merged-into 标签
```

此操作不会自动合并 JSONL 内容；它通过标签建立关联。合并操作的含义是：标记重复会话，指向规范版本。

## 会话管理器

`SessionManager` 提供高级会话生命周期能力：

### 自动压缩（SS1）

当消息历史 token 数超过阈值时，早期消息自动压缩为摘要，最近 N 轮保留完整内容。

### 去重与相似度检测（SS2）

```typescript
const similar = manager.findSimilarSessions(targetSessionId, candidates, 0.6);
// SimilarSession[] 按相似度排序（基于 trigram 的 Jaccard 相似度）
```

使用字符 trigram Jaccard 相似度比较标题、首条提示、摘要等。

### 索引与搜索（SS3）

```typescript
manager.buildIndex(sessions);
const results = manager.searchByKeyword("React 组件测试");
// SessionIndexEntry[] 按相关度排序
```

支持中英文关键词，标题匹配获得额外加分。停用词包括常用中英文词汇。

### TTL 清理（SS4）

两阶段清理：先删除超过 TTL（默认 30 天）的会话，如仍超过 maxSessions（默认 1000），按最旧活动时间继续删除。

## 存储后端

### JSONL 文件后端（默认）

- 存储路径：`~/.vera/projects/<sanitized_cwd>/<sessionId>.jsonl`
- 路径清洗：非字母数字字符替换为 `-`，过长的路径截断并追加哈希
- Git worktree 支持：列表包含 worktree 路径下的会话

### SQLite 后端（可选）

```typescript
const { backend, migrated } = await SessionStore.configureSqlite({
  dbPath: "~/.vera/sessions.db",
  enableFts: true,            // 启用 FTS5 全文搜索
  autoMigrate: true,          // 自动从 JSONL 迁移
});
```

SQLite 后端将完整 JSONL 内容保留在 `content` 字段中，同时提取元数据用于索引和查询。详见 `packages/core/src/session/sqlite-backend.ts`。

## 配置

会话相关配置通过 `settings.json` 的 `session` 字段设置：

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

`sanitizePath()` 将非字母数字字符替换为 `-`；长路径追加 djb2 哈希后缀以保证唯一性。`resolveSessionFilePath()` 支持向后兼容的多目录搜索。
