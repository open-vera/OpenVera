# 无限上下文 — 实现指南

> 本文档对齐 [roadmap.md P0.3](../roadmap.md) 和 [agent-design.md §1](./agent-design.md#1-无限上下文infinite-context)，描述无限上下文的**当前状态**、**缺失环节**和**实现路径**。

---

## 1. 当前状态（已有什么）

`packages/core/src/agent/loop.ts` 的 `runAgent` / `streamAgent`：

```ts
const messages: Message[] = [{ role: "user", content: userMessage }];

for (let turn = 0; turn < maxTurns; turn++) {
  const request = { model, messages, tools, system };
  const response = await adapter.complete(request);
  messages.push(response.message);
  // ... tool handling ...
}
```

**问题**：`messages[]` 无限增长，没有任何 token 感知，等到 API 报 `context_length_exceeded` 才会出错。

---

## 2. 需要解决的问题

| 问题 | 影响 |
|---|---|
| 长任务超 200K token | API 报错，任务中止 |
| 大文件内容注入 | 单次 read_file 可能吃掉大半 window |
| 多轮 tool result 堆积 | 每次 bash / grep 输出都进 messages |
| 无法跨任务保留知识 | 下一次任务不知道上次做了什么 |

---

## 3. 策略分层

不需要一次做完，分三层按优先级落地：

### 层 1（P0 必做）：滑动窗口 + token 计数

最简单的保护：在每次 `adapter.complete()` 前计算当前 messages 的 token 数，超过阈值时丢弃最早的非 system 轮次。

```
阈值设为模型 context_window 的 75%（如 claude-sonnet: 200K × 0.75 = 150K）
丢弃策略：
  保留 system prompt（不可丢）
  保留最近 N 轮（确保模型有足够工作上下文）
  丢弃中间最早的若干轮
```

token 计数方式：
- Anthropic adapter：调 `client.messages.countTokens()` 或用 `tiktoken` 估算
- 估算精度在 ±10% 以内即可，不需要精确

### 层 2（P0 必做）：工具输出持久化与预算管控

大量 token 的来源不是对话轮次，而是 tool result。参考 Claude Code 实现，**不应简单截断**，而应采用"持久化到磁盘 + 给模型预览 + 允许按需读取"的策略。

#### 两层预算

| 层 | 边界 | 触发时机 |
|---|---|---|
| **单结果阈值** | 默认 50K chars（各工具可声明更小值） | 单个 tool result 写入前 |
| **单轮聚合预算** | 200K chars（同一轮所有并发结果之和） | 每次 API 调用前 |

#### 单结果阈值：持久化而非截断

当单个 tool result 超过阈值时，将内容写到磁盘，模型收到 preview + 路径：

```ts
// 常量（参照 Claude Code toolLimits.ts）
const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;  // 单结果默认阈值
const PREVIEW_SIZE_CHARS = 2_000;              // 预览大小（前 2000 字符）

interface ToolResultOverflow {
  filepath: string;      // 持久化路径，session 级目录
  originalSize: number;
  preview: string;
  hasMore: boolean;
}

// 模型收到的替换内容
function buildOverflowMessage(result: ToolResultOverflow): string {
  return [
    `<tool-result-overflow>`,
    `Output too large (${result.originalSize} chars). Full output saved to: ${result.filepath}`,
    ``,
    `Preview (first ${PREVIEW_SIZE_CHARS} chars):`,
    result.preview,
    result.hasMore ? "..." : "",
    `</tool-result-overflow>`,
  ].join("\n");
}
```

模型读到 overflow 消息后，可以主动用 `read_file` 获取完整内容。这比截断更好：**截断让模型看到残缺数据并可能做出错误判断，而 overflow 让模型知道内容在哪、自己决定要不要读**。

#### 各工具应声明自己的阈值

```ts
// 工具注册时声明，超过此值触发持久化
interface Tool {
  maxResultSizeChars: number;  // Infinity = 工具自己管控（如 read_file 有 maxTokens）
}

// 参考值：
// bash:         50_000  （默认）
// grep:         20_000  （搜索结果往往重复，更小阈值）
// read_file:    Infinity（maxTokens 参数自控，无需外部截断）
// web_search:   50_000
// list_dir:     20_000
```

#### 单轮聚合预算：贪心替换

API 调用前，检查本轮所有 tool result 的总大小。超过聚合上限时，优先替换**最大**的结果：

```ts
const MAX_PER_TURN_CHARS = 200_000;

function selectResultsToOffload(
  results: Array<{ toolUseId: string; size: number }>,
  frozenSize: number,   // 已冻结（历史 turn）的大小
): string[] {
  // 按大小降序，贪心选出需要替换的结果集
  const sorted = [...results].sort((a, b) => b.size - a.size);
  const toOffload: string[] = [];
  let total = frozenSize + results.reduce((s, r) => s + r.size, 0);
  for (const r of sorted) {
    if (total <= MAX_PER_TURN_CHARS) break;
    toOffload.push(r.toolUseId);
    total -= r.size;
  }
  return toOffload;
}
```

#### 决策冻结（prompt cache 稳定性）

一旦某个 tool result 决定是否替换，后续 turn **不再重新评估**：
- 已替换的：每次 API 调用前重新注入相同的 overflow 消息（byte-identical，命中 prompt cache）
- 未替换的：永远不替换（替换会改变已缓存的前缀，导致 cache miss）

```ts
interface ToolResultBudgetState {
  seenIds: Set<string>;              // 已评估过的结果 ID
  replacements: Map<string, string>; // id → overflow 消息（byte-identical 重放）
}
```

### 层 3（P1，配合 Memory 系统）：渐进压缩

当滑动窗口不够用时（任务本身需要很多历史上下文），用轻量模型把早期轮次压缩成摘要注入 system：

```
messages[0..N-K]  →  压缩摘要（call lightweight model）
                  →  注入 system: "以下是早期对话摘要：\n{summary}"
messages[N-K..N]  →  保留原样
```

压缩摘要要保留：
- 已完成的 Plan Step 和结论
- 发现的重要事实（"文件 X 里存在漏洞 Y"）
- 已执行的高风险操作

不需要保留：
- 中间 tool result 原文（只保留结论）
- 重复的 read_file 内容

---

## 4. 实现路径

### Step 1：token 估算工具

在 `packages/core/src/context/tokens.ts` 新增：

```ts
/** 快速估算，误差 ±10%，不调 API */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 用 Anthropic countTokens API 精确计算（异步，仅在 anthropic adapter 下使用）*/
export async function countTokensExact(
  messages: Message[],
  adapter: LLMAdapter
): Promise<number>
```

### Step 2：`buildContext` 函数

在 `packages/core/src/context/window.ts` 新增：

```ts
export interface ContextWindowOptions {
  maxTokens: number;       // 模型 context window 上限
  targetUtilization: number; // 目标利用率，建议 0.75
  keepRecentTurns: number;   // 至少保留最近几轮，建议 6
}

/**
 * 给定完整 messages，返回符合 token 预算的裁剪版本。
 * 策略：保留 system + 最近 keepRecentTurns，
 *       超出时从最早的非 system 轮次开始丢弃。
 */
export function trimToWindow(
  messages: Message[],
  options: ContextWindowOptions
): Message[]
```

### Step 3：接入 agent loop

在 `loop.ts` 的 `runAgent` / `streamAgent` 里，每轮 `adapter.complete()` 前调用：

```ts
const trimmed = trimToWindow(messages, {
  maxTokens: MODEL_CONTEXT_LIMITS[model] ?? 200_000,
  targetUtilization: 0.75,
  keepRecentTurns: 6,
});
const request: CompletionRequest = { model, messages: trimmed, tools, system };
```

注意：`messages` 原始数组继续保留完整历史（供 Checkpoint / replay 用），`trimmed` 只用于本次 API 调用。

### Step 4：工具输出预算管控

新建 `packages/core/src/context/tool-budget.ts`：

```ts
// 预算状态（跨 turn 持有）
export interface ToolResultBudgetState {
  seenIds: Set<string>;
  replacements: Map<string, string>; // id → overflow 消息
}

// 在 loop.ts 的 AgentOptions 里增加：
// toolResultBudget?: ToolResultBudgetState

// 处理 tool result 写入前调用：
export async function processToolResult(
  toolUseId: string,
  toolName: string,
  output: string,
  state: ToolResultBudgetState,
  maxResultSizeChars: number = DEFAULT_MAX_RESULT_SIZE_CHARS,
): Promise<string>
```

**写入 messages 前（单结果）**：超过 `maxResultSizeChars` → 持久化文件 → 写入 overflow 消息

**API 调用前（聚合）**：检查本轮所有 tool_result 总大小 → 超过 200K → 贪心替换最大的

---

## 5. 文件分工

```
packages/core/src/
  context/
    tokens.ts        ← 新增：estimateTokens / countTokensExact
    window.ts        ← 新增：trimToWindow（滑动窗口裁剪）
    tool-budget.ts   ← 新增：ToolResultBudgetState / processToolResult / enforcePerTurnBudget
  agent/
    loop.ts          ← 修改：接入 trimToWindow + tool-budget
```

层 3 的渐进压缩（`compressEarlyTurns`）在 P1 Memory 系统完成后实现，放在 `context/compressor.ts`。

---

## 6. 关键参数参考

| 模型 | Context Window | 建议 maxTokens（75%） |
|---|---|---|
| claude-opus-4-6 | 200K | 150K |
| claude-sonnet-4-6 | 200K | 150K |
| claude-haiku-4-5 | 200K | 150K |
| gpt-4o | 128K | 96K |
| gemini-2.0-flash | 1M | 750K |

---

## 7. 验收标准（对应 P0 验收）

- [ ] 50 轮对话后 API 不报 context_length_exceeded
- [ ] `bash` / `grep` 输出超过 50K chars 时自动持久化，模型收到 preview + 文件路径
- [ ] `read_file` 工具豁免持久化（`maxResultSizeChars: Infinity`，自己用 maxTokens 控制）
- [ ] 单轮并发工具输出超过 200K chars 时，优先替换最大的结果
- [ ] 替换决策一旦做出不再改变（相同 toolUseId 的 overflow 消息 byte-identical）
- [ ] 每次 API 调用前 token 估算值记录在 timeline
- [ ] 原始完整 messages 历史仍保留（用于 Checkpoint / replay）
