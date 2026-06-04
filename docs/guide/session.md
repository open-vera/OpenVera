# Session 管理

Vera 的 Session 系统负责对话的完整持久化、恢复、分支和费用追踪。采用 JSONL 格式存储，支持 SQLite 后端扩展。

> 底层实现细节见 `docs/core/session.md`，本文档聚焦使用层面的指南。

---

## Session 生命周期

一个完整的 Session 经历以下事件流：

```
session_start → user → [assistant → tool_call → tool_result]* → session_end
```

### 写入 API

```typescript
import { SessionStore } from "@open-vera/core";

const store = new SessionStore({ cwd: "/path/to/project" });
// sessionId 自动生成 (crypto.randomUUID())
// 文件路径：~/.vera/projects/<encoded_cwd>/<uuid>.jsonl

// 1. 启动 session
store.writeStart("claude-sonnet-4-6", "anthropic");

// 2. 记录用户输入（返回 uuid）
const userUuid = store.writeUser("帮我重构 UserService");

// 3. 记录助手回复（返回 uuid）
const assistantUuid = store.writeAssistant({
  parentUuid: userUuid,
  content: "好的，我先分析现有代码...",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  stopReason: "end_turn",
  usage: { input_tokens: 1500, output_tokens: 800 },
  turn: 1,
  latencyMs: 3200,
  toolCalls: ["read_file", "grep"],
  status: "ok",
});

// 4. 记录工具调用（返回 uuid）
const toolCallUuid = store.writeToolCall({
  parentUuid: userUuid,
  toolName: "read_file",
  toolCallId: "toolu_xxx",
  arguments: { file_path: "src/UserService.ts" },
});

// 5. 记录工具结果
store.writeToolResult({
  parentUuid: toolCallUuid,
  toolCallId: "toolu_xxx",
  content: "export class UserService { ... }",
});

// 6. 结束 session
store.writeEnd(
  { input_tokens: 15000, output_tokens: 8000 },
  0.1234,  // totalCostUsd
  5,       // turnCount
  "帮我重构 UserService"  // lastPrompt
);
```

### 元数据写入

```typescript
// 自定义标题
store.writeTitle("重构 UserService 数据访问层");

// AI 自动生成标题
store.writeAiTitle("重构 UserService 查询逻辑");

// 对话摘要
store.writeSummary("完成了 UserService 的数据访问层重构，提了 3 个 PR。");

// 标签（支持分类和合并标记）
store.writeTag("refactor");
store.writeTag("merged-from:dup-id-xxx");

// Git 分支
store.writeGitBranch("refactor/user-service");

// PR 链接
store.writePrLink({
  prUrl: "https://github.com/org/repo/pull/42",
  prRepository: "org/repo",
  prNumber: 42,
});
```

---

## JSONL 存储格式

### 文件路径

```
~/.vera/projects/<sanitized_cwd>/<sessionId>.jsonl
```

项目路径经过净化：非字母数字字符替换为 `-`，过长路径截断并追加哈希后缀。

### Entry 类型一览

| 类型 | 说明 | 关键字段 |
|---|---|---|
| `session_start` | 启动标记 | `cwd`, `model`, `provider` |
| `user` | 用户消息 | `uuid`, `content` |
| `assistant` | AI 回复 | `uuid`, `parentUuid`, `content`, `model`, `usage`, `stopReason`, `turn`, `latencyMs`, `toolCalls`, `status` |
| `tool_call` | 工具调用 | `uuid`, `parentUuid`, `toolName`, `toolCallId`, `arguments` |
| `tool_result` | 工具结果 | `uuid`, `parentUuid`, `toolCallId`, `content` |
| `session_end` | 结束标记 | `totalUsage`, `totalCostUsd`, `turnCount` |
| `last-prompt` | 最后输入 | `lastPrompt` |
| `custom-title` | 自定义标题 | `customTitle` |
| `ai-title` | AI 标题 | `aiTitle` |
| `summary` | 对话摘要 | `summary`, `leafUuid` |
| `tag` | 标签 | `tag` |
| `git-branch` | Git 分支 | `gitBranch` |
| `pr-link` | PR 关联 | `prUrl`, `prRepository`, `prNumber` |
| `branch` | 分支关系 | `parentSessionId`, `forkedFromUuid`, `title`, `status`, `worktreePath`, `worktreeBranch`, `baseCommit` |

### 设计特性

- **追加写入**：使用追加模式，进程崩溃不丢失已写入数据
- **损坏恢复**：单行 JSON 解析失败跳过继续，保证部分损坏不影响其余数据
- **渐进式摘要**：`readSessionSummary` 只读文件头尾各 64KB 即可生成完整摘要，无需全量解析大文件

---

## 查询与恢复

### 列表

```typescript
// 列出当前项目的所有 session
const sessions = SessionStore.listSessions("/path/to/project");

// 分页
const result = SessionStore.listSessionsPaged({
  cwd: "/path/to/project",
  all: false,
  limit: 20,
  offset: 0,
  includeWorktrees: true,
});
console.log(result.sessions.length);
console.log(result.nextOffset);       // 下一页起始偏移量
console.log(result.totalCandidates);  // 总候选数
```

**SessionSummary 字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string | 唯一 ID |
| `filePath` | string | JSONL 文件路径 |
| `startedAt` / `lastActivityAt` | Date | 时间信息 |
| `model` / `provider` | string | 模型/provider |
| `turnCount` | number | 对话轮次 |
| `messageCount` | number | 消息总数 |
| `fileSize` | number | 文件字节数 |
| `totalUsage` | Usage | 累计 token（input/output/cache_w/cache_r） |
| `totalCostUsd` | number | 累计费用（USD） |
| `title` / `summary` | string | 标题/摘要 |
| `firstPrompt` / `lastUserInput` | string | 首/尾用户输入 |
| `tag` | string | 标签 |
| `gitBranch` | string | Git 分支 |
| `pr` | object | PR 信息 |
| `branch` | object | 分支信息 |

### 恢复

```typescript
const loaded = SessionStore.loadSession("session-id-prefix");
console.log(loaded.history);      // Message[] — 完整对话历史
console.log(loaded.turnCount);    // 轮次数
console.log(loaded.totalCostUsd); // 总费用
console.log(loaded.cwd);          // 原工作目录
```

加载逻辑：逐行解析 JSONL，按 `user`/`assistant` entry 重建 `Message[]`，累加 usage 和 cost。优先信任 `session_end` 中的总额覆盖累加值。

### 转录预览

```typescript
const preview = SessionStore.loadTranscriptPreview("session-id");
// { sessionId, messages: SessionPreviewMessage[], summary?: SessionSummary }

preview.messages.forEach((msg) => {
  console.log(`${msg.role}: ${msg.content.slice(0, 100)}`);
  msg.toolUses?.forEach((tu) => {
    console.log(`  Tool: ${tu.name} → ${tu.result.content.slice(0, 100)}`);
  });
});
```

---

## 分支系统

Session 分支允许从任意历史点 fork 出独立分支继续对话，各分支互不干扰。

### 分支状态

| 状态 | 说明 |
|---|---|
| `active` | 活跃分支 |
| `adopted` | 已接管确认 |
| `merged` | 已合并回父 session |
| `discarded` | 已丢弃 |

### 创建分支

```typescript
// 普通分支
const forked = SessionStore.forkSession({
  fromSessionId: "parent-session-id",
  cwd: "/path/to/project",
  title: "尝试方案B",
  atUuid: "message-uuid", // 可选，从指定消息处 fork
});

// 带 worktree 隔离的分支（/try）
const tryBranch = SessionStore.forkSession({
  fromSessionId: "parent-session-id",
  cwd: "/path/to/project",
  title: "升级到 Next.js 14",
  worktreePath: "/path/to/.vera/worktrees/try-upgrade-xxx",
  worktreeBranch: "try-upgrade-next14-xxx",
  baseCommit: "abc123def456",
});
```

Fork 核心逻辑：
1. 读取父 session 的完整 JSONL
2. 过滤出可重放的消息（排除 `session_end`、`summary`、`tag` 等元数据 entry）
3. 复制到新文件，更新 `sessionId`
4. 写入 `branch` entry（`status: "active"`，记录 `parentSessionId`、`forkedFromUuid`）
5. 如有标题，追加 `(Branch)` 后缀

### 分支操作

```typescript
// 列出分支
const branches = SessionStore.listBranches("parent-session-id");
// 过滤 parentSessionId 匹配且 status !== "discarded"

// 接管
SessionStore.adoptBranch("branch-session-id");

// 标记已合并
SessionStore.markBranchMerged("branch-session-id");

// 丢弃
SessionStore.discardBranch("branch-session-id");
```

丢弃是逻辑删除（标记 `discarded`），JSONL 文件不会物理删除。

---

## 费用追踪

### 定价表

内置主流模型定价（USD/百万 token）：

| 模型 | 输入 | 输出 | 缓存写 | 缓存读 |
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

`normalizeModelKey` 去除日期后缀（`-\d{8}`）和 `-latest`/`-preview`/`-exp` 变体，保证 `claude-sonnet-4-6-20251001` 匹配到 `claude-sonnet-4-6` 定价。

### 计算

```typescript
import { calculateCost, accumulateCost, emptyAccumulatedCost } from "@open-vera/core";

// 单次调用费用
const turnCost = calculateCost(usage, "claude-sonnet-4-6");

// 累计（immutable 返回新对象）
let cost = emptyAccumulatedCost();
cost = accumulateCost(cost, usage1, "claude-sonnet-4-6", "anthropic");
cost = accumulateCost(cost, usage2, "gpt-4o", "openai");

console.log(cost.totalUsd);
// AccumulatedCost { totalUsd, byModel: Record<string, ModelCostRecord>, totalUsage: Usage }
```

费用在 `session_end` entry 持久化，恢复时直接读取无需重算。

---

## AI 标题生成

```typescript
import { generateSessionTitle } from "@open-vera/core";

const title = await generateSessionTitle({
  adapter,                          // LLMAdapter 实例
  model: "claude-haiku-4-5",        // 用低成本模型
  userPrompt: "帮我写一个 TypeScript 的快速排序实现",
  assistantText: "以下是 TS 实现...",
  signal: abortController.signal,
});
// → "快速排序 TypeScript 实现"
```

生成策略：
- `max_tokens=32`，`temperature=0`
- System prompt 要求返回 3-8 词英文或简短中文
- 自动截断过长输入（user/assistant 各 2000 字符）
- 去引号、空白、超 80 字符自动截断
- 返回 `null` 表示无法生成

---

## 生命周期管理 (SessionManager)

`SessionManager` 提供自动清理和搜索能力：

```typescript
const manager = new SessionManager({
  autoCompress: {
    enabled: true,
    tokenThreshold: 100_000,  // 触发压缩的 token 阈值
    keepRecentTurns: 6,       // 保留最近 N 轮不解压
  },
  ttlDays: 30,       // 30 天未活动自动清理
  maxSessions: 1000, // 每项目最多保留数
});

// 自动压缩
const { messages, compressed } = await manager.autoCompress(
  sessionId, messages, adapter, model
);

// 生命周期清理
const result = manager.cleanup({ cwd: "/path/to/project", dryRun: true });
// → { removedCount, removedSessionIds, remainingCount }

// 关键词搜索
manager.buildIndex(summaries);
const results = manager.searchByKeyword("quick sort");

// 相似 session 检测
const similar = manager.findSimilarSessions(targetId, candidates, 0.6);
```

搜索使用 trigram Jaccard 相似度算法，轻量无外部依赖。标题匹配 2x 权重，关键词精确匹配 1x 额外权重。中英文 stop words 均过滤。
