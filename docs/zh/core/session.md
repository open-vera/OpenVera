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


---


# Claude Code Session 机制调研报告

> 基于 `@anthropic-ai/claude-code` v2.1.88-source.0 源码分析
> 调研日期：2026-04-11

---

## 目录

1. [架构概览](#1-架构概览)
2. [Session 核心实现](#2-session-核心实现)
3. [Session Resume 机制](#3-session-resume-机制)
4. [Cost 统计机制](#4-cost-统计机制)
5. [上下文还原与记录](#5-上下文还原与记录)
6. [任意 Session 恢复](#6-任意-session-恢复)
7. [关键设计模式总结](#7-关键设计模式总结)

---

## 1. 架构概览

### 1.1 存储架构

Claude Code **不使用任何数据库**，完全基于文件系统实现 Session 持久化：

```
~/.claude/
├── projects/                          # Session 存储根目录
│   ├── <project-path-sanitized>/      # 每个项目一个子目录
│   │   ├── <sessionId>.jsonl          # 主会话转录文件 (JSONL)
│   │   ├── <sessionId>/               # 子 Agent 目录
│   │   │   └── subagents/
│   │   │       ├── agent-<id>.jsonl   # 子 Agent 转录
│   │   │       └── agent-<id>.meta.json # Agent 元数据
│   │   └── .claude/
│   │       └── settings.json          # 项目配置（含 Cost 状态）
│   └── ...
├── history.jsonl                      # 命令输入历史
└── sessions/                          # 活跃 Session 注册（PID 文件）
    └── <pid>.json
```

### 1.2 核心文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `sessionStorage.ts` | 5,107 | Session 转录读写、元数据管理、文件操作 |
| `sessionRestore.ts` | 553 | Resume 时恢复 Session 状态 |
| `cost-tracker.ts` | 324 | Cost 跟踪和持久化 |
| `bootstrap/state.ts` | 1,764 | 全局状态管理（Session ID、Cost 计数器等） |
| `history.ts` | 465 | 命令历史（Ctrl+R） |

---

## 2. Session 核心实现

### 2.1 Session ID 与生命周期

Session ID 是一个 UUID，在 Session 创建时生成：

```typescript
// bootstrap/state.ts
export function switchSession(sessionId: SessionId, projectDir: string | null = null): void {
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)  // 通知监听者（如 PID 文件同步）
}
```

Session 路径计算公式：
```
~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
```

### 2.2 JSONL 转录格式

每个 Session 的核心数据存储在 `.jsonl` 文件中，每行一个 JSON 对象：

```jsonl
{"type":"user","uuid":"abc123","parentUuid":null,"timestamp":"2026-04-11T...","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"def456","parentUuid":"abc123","timestamp":"2026-04-11T...","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}
{"type":"custom-title","sessionId":"abc123","customTitle":"My Chat"}
{"type":"agent-setting","sessionId":"abc123","agentSetting":"code-reviewer"}
{"type":"summary","leafUuid":"def456","summary":"User greeted me, I responded..."}
```

**Entry 类型（完整列表）：**

| 类型 | 用途 |
|------|------|
| `user` | 用户消息 |
| `assistant` | AI 回复 |
| `attachment` | 附件（图片等） |
| `system` | 系统消息 |
| `summary` | AI 生成的对话摘要（用于 resume 时快速加载） |
| `custom-title` | 用户设置的会话标题 |
| `tag` | 会话标签（如 `/tag bugfix`） |
| `agent-name` / `agent-color` / `agent-setting` | Agent 配置 |
| `mode` | 会话模式（`coordinator` / `normal`） |
| `worktree-state` | Git worktree 状态 |
| `file-history-snapshot` | 文件编辑历史快照 |
| `attribution-snapshot` | Commit attribution 快照 |
| `content-replacement` | 内容替换记录 |
| `marble-origami-commit` / `marble-origami-snapshot` | Context Collapse 提交和快照 |
| `pr-link` | PR 链接信息 |

### 2.2.1 Vera Session 配置

Vera 在 `.vera/settings.json` 中提供 session 级配置，当前用于控制自动标题：

```json
{
  "session": {
    "ai_title": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

- `enabled: false`：关闭首轮后的自动 `ai-title` 生成。
- `provider`：可选，指定标题生成使用的 provider；不配置时复用当前对话 provider。
- `model`：可选，指定标题模型；不配置时复用当前对话模型。

### 2.3 消息链（parentUuid）

消息通过 `parentUuid` 形成链式结构：

```
User Message (uuid: A, parentUuid: null)
  └─ Assistant Message (uuid: B, parentUuid: A)
      └─ Tool Use (uuid: C, parentUuid: B)
          └─ Tool Result (uuid: D, parentUuid: C)
              └─ Assistant Reply (uuid: E, parentUuid: D)
```

Resume 时，系统从最新的 **leaf message**（没有子节点的消息）开始，沿着 `parentUuid` 回溯到根节点，重建完整对话链。

### 2.4 写入流程

```typescript
// sessionStorage.ts - Project 类
async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
  // 1. 检查是否正在关闭（避免写入损坏文件）
  if (isShuttingDown()) return
  
  // 2. 序列化 entry
  const line = jsonStringify(entry) + '\n'
  
  // 3. 追加到文件（使用 appendFile，非覆盖）
  await fsAppendFile(this.sessionFile, line)
}
```

每条消息在发送后立即写入 JSONL 文件，确保崩溃时数据不丢失。

### 2.5 大文件优化

Session 文件可能增长到数 GB，Claude Code 实现了多层优化：

1. **预压缩跳过（Pre-compact Skip）**：
   - 当文件 > 5MB 时，使用 `readTranscriptForLoad()` 流式读取
   - 只保留压缩边界后的内容 + 最后的 attribution snapshot
   - 内存峰值从文件大小降至输出大小（151MB 文件只需 32MB 内存）

2. **链式预扫描（walkChainBeforeParse）**：
   - 对大文件在解析前只遍历有效消息链
   - 跳过死分支（被工具结果覆盖的旧消息）

3. **头尾读取策略（Head + Tail）**：
   - Progressive loading 时只读取文件头部和尾部
   - 限制单次读取最大 50MB

---

## 3. Session Resume 机制

### 3.1 Resume 入口

用户通过以下方式触发 Resume：

| 方式 | 命令/参数 |
|------|-----------|
| CLI 参数 | `claude --resume <sessionId>` |
| CLI 简写 | `claude -c`（continue，恢复最近一次） |
| Slash 命令 | `/resume`（交互式选择器） |
| SDK | `options: { resume: sessionId }` |
| 跨项目 | `/resume` 支持搜索其他项目的 session |

### 3.2 Resume 完整流程

```
用户发起 resume
    │
    ▼
┌─────────────────────────────────┐
│ 1. 参数解析与验证                 │
│    - 验证 sessionId 格式 (UUID)   │
│    - 检查 session 文件是否存在    │
│    - 处理 --continue（查找最近）  │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 2. switchSession()               │
│    - 更新 STATE.sessionId        │
│    - 更新 STATE.sessionProjectDir│
│    - 触发 sessionSwitched 事件   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 3. loadTranscriptFromFile()      │
│    - 读取 JSONL 文件             │
│    - 解析所有 Entry              │
│    - 构建 messages Map           │
│    - 提取元数据到各自 Map        │
│    - 识别 leafUuids              │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 4. 重建对话链                     │
│    - 找最新 leaf message         │
│    - buildConversationChain()    │
│    - 沿 parentUuid 回溯到根      │
│    - 追加 trailing messages      │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 5. restoreSessionStateFromLog()  │
│    - 恢复文件历史快照            │
│    - 恢复 attribution 状态       │
│    - 恢复 context collapse       │
│    - 恢复 TodoWrite 状态         │
│    - 恢复 agent 设置             │
│    - 恢复 worktree 状态          │
│    - 恢复 Cost 状态              │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 6. adoptResumedSessionFile()     │
│    - 设置 project.sessionFile    │
│    - 重新追加元数据到文件尾部    │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 7. 恢复 Agent 上下文              │
│    - restoreAgentFromSession()   │
│    - setMainThreadAgentType()    │
│    - setMainLoopModelOverride()  │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ 8. 恢复协调器模式                 │
│    - matchCoordinatorMode()      │
│    - 匹配 resumed session 的模式 │
└──────────────┬──────────────────┘
               │
               ▼
         Resume 完成，继续对话
```

### 3.3 核心恢复函数

```typescript
// sessionRestore.ts
export async function resumeSession(log: LogOption): Promise<ResumeSessionResult> {
  // 1. 恢复文件历史
  if (result.fileHistorySnapshots) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, ...)
  }
  
  // 2. 恢复 attribution
  if (result.attributionSnapshots) {
    attributionRestoreStateFromLog(result.attributionSnapshots, ...)
  }
  
  // 3. 恢复 context collapse
  if (feature('CONTEXT_COLLAPSE')) {
    restoreFromEntries(result.contextCollapseCommits, result.contextCollapseSnapshot)
  }
  
  // 4. 恢复 TodoWrite
  if (!isTodoV2Enabled() && result.messages) {
    const todos = extractTodosFromTranscript(result.messages)
    setAppState(prev => ({ ...prev, todos: { [agentId]: todos } }))
  }
  
  // 5. 恢复 Agent 设置
  restoreAgentFromSession(agentSetting, currentAgentDefinition, agentDefinitions)
  
  // 6. 恢复 worktree
  restoreWorktreeForResume(result.worktreeSession)
  
  // 7. 恢复 Cost
  restoreCostStateForSession(sessionId)
}
```

---

## 4. Cost 统计机制

### 4.1 全局状态存储

```typescript
// bootstrap/state.ts
const STATE = {
  // Cost 相关
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalAPIDurationWithoutRetries: 0,
  totalToolDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  
  // Token 计数
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationInputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalWebSearchRequests: 0,
  
  // 按模型细分
  modelUsage: { [modelName: string]: ModelUsage }
}
```

### 4.2 Cost 计算

```typescript
// cost-tracker.ts
export function calculateUSDCost(model: string, usage: ModelUsage): number {
  // 定价表（每百万 tokens）
  const pricing = {
    'sonnet': { input: 3, output: 15 },
    'opus': { input: 15, output: 75 },
    'haiku': { input: 0.80, output: 4 },
    // ...
  }
  
  const price = pricing[model]
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadInputTokens * price.cacheRead +
    usage.cacheCreationInputTokens * price.cacheWrite
  ) / 1_000_000
}
```

### 4.3 Cost 持久化

Cost 状态保存在 **项目配置文件** 中：

```typescript
// cost-tracker.ts
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [
        model, { inputTokens, outputTokens, cacheReadInputTokens, ... }
      ])
    ),
    lastSessionId: getSessionId(),  // 关联 session
  }))
}

// 恢复时读取
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) return false
  
  // 只有 sessionId 匹配时才恢复
  if (projectConfig.lastSessionId !== sessionId) return false
  
  setCostStateForRestore(data)
  return true
}
```

**配置文件位置：** `~/.claude/projects/<dir>/.claude/settings.json`

```json
{
  "lastSessionId": "550e8400-e29b-41d4-a716-446655440000",
  "lastCost": 0.42,
  "lastAPIDuration": 12500,
  "lastModelUsage": {
    "claude-sonnet-4-20250514": {
      "inputTokens": 12000,
      "outputTokens": 800,
      "cacheReadInputTokens": 5000,
      "costUSD": 0.42
    }
  }
}
```

### 4.4 Cost 展示

```
Total cost:            $0.4200
Total duration (API):  12s
Total duration (wall): 45s
Total code changes:    120 lines added, 30 lines removed
Usage by model:
  sonnet:   12,000 input, 800 output, 5,000 cache read, 0 cache write ($0.42)
```

---

## 5. 上下文还原与记录

### 5.1 对话链重建

Resume 时，系统需要重建完整的对话上下文：

```typescript
// sessionStorage.ts
function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage
): TranscriptMessage[] {
  const chain: TranscriptMessage[] = []
  let current: TranscriptMessage | undefined = leafMessage
  
  // 沿 parentUuid 回溯到根
  while (current) {
    chain.unshift(current)  // 插入到头部
    if (!current.parentUuid) break
    current = messages.get(current.parentUuid)
  }
  
  return chain
}
```

### 5.2 Summary 摘要

每个 leaf message 可以关联一个 `summary` Entry，由 AI 自动生成：

```json
{"type":"summary","leafUuid":"def456","summary":"User greeted me, I responded with a hello message. No tools used."}
```

**用途：**
- Progressive loading 时只显示摘要，不加载完整消息
- `/resume` 选择器中显示会话预览
- 减少大 session 的加载时间

### 5.3 文件历史快照

```typescript
// 每次文件编辑后保存快照
{
  "type": "file-history-snapshot",
  "uuid": "...",
  "parentUuid": "...",
  "sessionId": "...",
  "snapshots": {
    "/path/to/file.ts": {
      "content": "full file content...",
      "timestamp": 1234567890
    }
  }
}
```

Resume 时恢复：
```typescript
fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, newState => {
  setAppState(prev => ({ ...prev, fileHistory: newState }))
})
```

### 5.4 Context Collapse

Claude Code 实现了上下文压缩机制（内部代号 Marble Origami）：

```typescript
// 提交压缩记录
{
  "type": "marble-origami-commit",
  "sessionId": "...",
  "collapseId": "...",
  "summaryUuid": "...",
  "summaryContent": "Compressed: User asked about X, I explained Y...",
  "firstArchivedUuid": "...",
  "lastArchivedUuid": "..."
}

// 快照暂存状态
{
  "type": "marble-origami-snapshot",
  "sessionId": "...",
  "staged": [
    { "startUuid": "...", "endUuid": "...", "summary": "...", "risk": 0.8 }
  ],
  "armed": true
}
```

### 5.5 Tool Result 存储

工具结果单独存储，支持 resume 时恢复：

```typescript
// toolResultStorage.ts
export function recordContentReplacement(
  sessionId: UUID,
  toolUseId: UUID,
  replacement: ContentReplacementRecord
): void {
  // 存储到 JSONL 中
  appendEntryToFile(getTranscriptPath(), {
    type: 'content-replacement',
    sessionId,
    toolUseId,
    replacement
  })
}
```

---

## 6. 任意 Session 恢复

### 6.1 Session 列表实现

```typescript
// sessionStorage.ts
export async function loadAllProjectsMessageLogs(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number }
): Promise<LogOption[]> {
  // 1. 扫描所有项目目录
  const projectsDir = getProjectsDir()  // ~/.claude/projects/
  const dirents = await readdir(projectsDir, { withFileTypes: true })
  
  // 2. 对每个项目目录，获取 session 文件
  for (const projectDir of projectDirs) {
    // 快速模式：只读取文件元数据（mtime, size）
    rawLogs.push(...getSessionFilesLite(projectDir, limit))
  }
  
  // 3. Progressive enrichment：按需加载完整消息
  const { logs, nextIndex } = await enrichLogs(sorted, 0, initialEnrichCount)
  
  return logs
}
```

**Lite 元数据（快速加载）：**
- `sessionId`（文件名）
- `mtime`（修改时间，用于排序）
- `size`（文件大小）
- `firstPrompt`（从文件头提取的第一条用户消息）
- `customTitle`（从文件尾提取的标题）

**Full 数据（按需加载）：**
- 完整消息链
- 文件历史快照
- Attribution 快照
- 所有内容替换记录

### 6.2 Session 选择器

```tsx
// ResumeConversation.tsx
function ResumeConversation() {
  // 1. 加载所有 sessions
  const [logs] = useState(() => loadAllProjectsMessageLogs())
  
  // 2. 按时间排序
  const sorted = sortLogs(logs)  // 最新优先
  
  // 3. 显示选择器
  return (
    <Box flexDirection="column">
      {sorted.map(log => (
        <SessionItem
          key={log.sessionId}
          title={log.customTitle || log.firstPrompt}
          date={log.modified}
          messageCount={log.messageCount}
        />
      ))}
    </Box>
  )
}
```

### 6.3 跨项目 Resume

Session 路径计算支持跨项目：

```typescript
export function getTranscriptPathForSession(sessionId: string): string {
  if (sessionId === getSessionId()) {
    return getTranscriptPath()  // 当前 session
  }
  // 其他 session：使用 originalCwd
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}
```

对于跨项目 resume，用户可以提供完整路径：
```
/resume --path /other/project/.claude/projects/<path>/sessionId.jsonl
```

### 6.4 Session 搜索

```typescript
// agenticSessionSearch.ts
export async function agenticSessionSearch(
  query: string,
  logs: LogOption[]
): Promise<LogOption[]> {
  // AI 辅助搜索：用 LLM 理解查询意图
  const response = await query({
    prompt: `Find sessions matching: "${query}"`,
    system: `You have these sessions: ${logs.map(l => l.customTitle || l.firstPrompt).join(', ')}`
  })
  return filterByResponse(response, logs)
}
```

---
## 7. 关键设计模式总结

### 7.1 设计原则

| 原则 | 实现 |
|------|------|
| **无数据库** | 纯文件系统，JSONL + JSON |
| **追加写入** | 消息立即 append，不覆盖，崩溃安全 |
| **链式结构** | parentUuid 形成 DAG，支持分支 |
| **渐进加载** | Lite 元数据 → Full 消息，按需加载（只读文件尾部 64KB） |
| **状态分离** | 全局状态（bootstrap/state）+ 持久化（JSONL） |
| **元数据重写** | Session 退出时重写标题和标签到文件末尾，确保在读取窗口内 |

---

## 8. 子 Agent (Sub-agents) 机制

### 8.1 级联存储结构

子 Agent 的数据存储在主 Session 的同名子目录下：

```
~/.claude/projects/<project>/<sessionId>/
├── subagents/
│   ├── agent-<subagentId>.jsonl       # 子 Agent 对话转录
│   └── agent-<subagentId>.meta.json   # 子 Agent 元数据
└── remote-agents/                     # 远程 Agent (CCR) 状态
    └── remote-agent-<taskId>.meta.json
```

### 8.2 元数据恢复

`agent-<id>.meta.json` 存储了恢复子 Agent 所需的关键信息：
- `agentType`: 决定了子 Agent 的系统提示词和能力集。
- `worktreePath`: 如果子 Agent 开启了隔离模式，恢复时需自动 `chdir`。
- `description`: 原始任务描述，用于 UI 展示。

### 8.3 并行与生命周期

- **独立性**：每个子 Agent 拥有独立的 JSONL 文件和状态，主 Session 崩溃不影响子 Agent 文件的完整性。
- **恢复逻辑**：Resume 主 Session 时，系统会扫描 `subagents/` 目录，重建子 Agent 列表。对于仍在运行的远程任务，通过 `remote-agent-*.meta.json` 重新连接。

---

## 9. 健壮性与安全性

### 9.1 异常处理与容错

- **JSONL 损坏恢复**：`parseJSONL` 在解析时使用 `try-catch` 包裹单行解析逻辑。如果文件末尾因崩溃出现半行或非法 JSON，系统会直接跳过该行，保证整体 Session 可读。
- **大文件尾部读取**：对于超大 Session（>100MB），读取器只加载最后 100MB 数据并自动对齐到第一个换行符，防止内存溢出。
- **Session 锁机制**：利用 `~/.claude/sessions/<pid>.json` 进行进程存活检查，防止多个实例同时写入冲突。

### 9.2 隐私保护 (PII)

- **脱敏记录**：系统在记录诊断日志时使用 `logForDiagnosticsNoPII`，强制排除路径和代码片段。
- **写入前过滤**：虽然 Session 转录目前主要存储原始对话，但通过 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 等类型约束，确保敏感元数据不进入分析系统。

---

## 10. 生命周期与一致性

### 10.1 物理环境一致性 (Worktree)

Resume 时会检查磁盘实际状态：
1. **路径校验**：如果 Session 记录在 Worktree 中，Resume 时会尝试 `process.chdir(worktreePath)`。
2. **容错逻辑**：如果物理目录已被删除，系统会捕获错误，将 Worktree 状态重置为 `null`，并将用户锚定在原始项目根目录，避免启动失败。

### 10.2 自动清理与维护

- **退出清理**：注册 `registerCleanup` 钩子，在进程退出时强制 `flush` 待写入的消息，并重新追加最新的元数据（标题、Tag）到文件尾部。
- **磁盘管理**：目前主要依赖用户手动管理或项目目录隔离。Session 列表通过 `mtime` 排序，确保活跃 Session 始终优先可见。

---

## 附录：关键文件索引

```
Session 完整状态 = 
  JSONL 文件（消息链） +
  全局 State（实时计数器） +
  Project Config（Cost 持久化） +
  文件系统（mtime、size 用于排序）
```

### 7.3 Resume 时状态恢复清单

| 状态 | 存储位置 | 恢复函数 |
|------|----------|----------|
| 对话消息 | JSONL `user`/`assistant` entries | `buildConversationChain()` |
| Session 标题 | JSONL `custom-title` entry | `restoreSessionMetadata()` |
| Agent 设置 | JSONL `agent-setting` entry | `restoreAgentFromSession()` |
| Agent 颜色 | JSONL `agent-color` entry | `restoreSessionMetadata()` |
| 会话模式 | JSONL `mode` entry | `matchCoordinatorMode()` |
| Cost 统计 | Project `settings.json` | `restoreCostStateForSession()` |
| 文件历史 | JSONL `file-history-snapshot` | `fileHistoryRestoreStateFromLog()` |
| Todo 列表 | JSONL 最后一条 `tool_use` (todo_write) | `extractTodosFromTranscript()` |
| Worktree | JSONL `worktree-state` entry | `restoreWorktreeForResume()` |
| Context Collapse | JSONL `marble-origami-*` entries | `restoreFromEntries()` |
| 命令历史 | `~/.claude/history.jsonl` | `getHistory()` |

### 7.4 与本地 AI 编程工具的对比

如果您在构建类似的工具（如 Vera），可以参考以下设计：

1. **JSONL 存储**：比 JSON 更适合追加写入，每行独立，易于流式读取
2. **parentUuid 链**：比简单数组更灵活，支持分支、工具调用嵌套
3. **渐进加载**：Session 列表只显示摘要，选中后再加载完整上下文
4. **Cost 持久化**：与 session 解耦，按项目存储，支持跨 session 累计
5. **元数据与消息同级**：标题、tag 等存入同一 JSONL，无需额外数据库

---

## 附录：关键文件索引

| 文件路径 | 职责 |
|----------|------|
| `src/utils/sessionStorage.ts` | Session 读写核心（5,107 行） |
| `src/utils/sessionRestore.ts` | Resume 状态恢复（553 行） |
| `src/cost-tracker.ts` | Cost 跟踪（324 行） |
| `src/bootstrap/state.ts` | 全局状态（1,764 行） |
| `src/history.ts` | 命令历史（465 行） |
| `src/commands/resume/resume.tsx` | /resume 命令 UI |
| `src/utils/sessionStoragePortable.ts` | 大文件优化读取 |
| `src/utils/listSessionsImpl.ts` | Session 列表实现 |
| `src/utils/agenticSessionSearch.ts` | AI 辅助搜索 |
