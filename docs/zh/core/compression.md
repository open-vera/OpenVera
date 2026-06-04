# 上下文压缩系统设计

> 包：`@open-vera/core` | 源码：`packages/core/src/context/`
> 最后更新：2026-06-04

## 概述

Vera 的上下文压缩系统管理 LLM 对话历史的体量，使其保持在模型上下文窗口限制之内，同时尽可能保留关键信息。系统采用**三层防线**策略：从轻量级滑动窗口裁剪，到 LLM 驱动的渐进式摘要压缩，再到纯启发式的微压缩清理——每层各司其职。

## 为什么需要压缩

1. **Token 成本**：每次 API 调用按 token 计费；历史越长成本越高。压缩可将早期轮次的 token 消耗降低 90% 以上。
2. **上下文窗口限制**：主流模型窗口有限（Claude 200K、GPT-4o 128K、Gemini 1M）。超出限制会导致 API 直接拒绝请求。
3. **回复质量**：过长的上下文会稀释模型注意力，造成"迷失在中间"——模型忽略中间轮次的信息。
4. **Prompt 缓存失效**：Anthropic 的 prompt cache 在消息结构变化时重建，增加延迟。压缩减少消息数量，间接提升缓存命中率。

## 三层架构概览

```
上下文增长方向 ------------------------------------>

[第 1 层] 滑动窗口裁剪 (window.ts)
  |  Token 估算 -> 超过 75% 预算 -> 丢弃最早轮次
  |  始终保留：messages[0]（任务定义，绝不可丢失）
  |  最少保留：最近 6 轮
  |  成本：0 token（纯本地计算）
  v
[第 2 层] 渐进压缩 (compression.ts)
  |  Token 估算 -> 超过 triggerTokens -> LLM 摘要最早轮次
  |  输出：结构化摘要 + 决策/发现/待办 + 主题标签
  |  摘要消息注入上下文开头，替换被压缩的原始轮次
  |  成本：一次小模型 API 调用（约 1K 输入 + 2K 输出 token）
  v
[第 3 层] 微压缩 Micro-Compact (compression.ts -> microCompact)
  |  时间间隔检测 -> 清除旧 tool_result 内容
  |  保留最近 N 个工具结果完整内容
  |  成本：0 token（纯启发式，无 LLM 调用）
  v
[应急层] 响应式压缩 Reactive Compression (compression.ts -> isPromptTooLongError)
  |  捕获 API "prompt too long" 错误
  |  激进压缩（保留更少轮次、更小阈值）
  |  最多重试 3 次，然后抛出原始错误（熔断）
```

### 执行顺序

每轮 Agent 循环开始时，按以下顺序执行上下文变换：

```
用户消息 -> [渐进压缩] -> [工具预算回放] -> [微压缩] -> [滑动窗口裁剪] -> API 调用
```

参见 `packages/core/src/agent/loop.ts` 中的 `prepareMessages()` 和 `applyProactiveCompress()` 函数。

---

## 第 1 层：滑动窗口裁剪

**文件**：`window.ts`

核心原则：**第一条消息（任务定义）永不丢弃**。丢失它意味着模型失去对原始目标的记忆——这是任何裁剪策略中最致命的错误。

### 工作原理

```typescript
function trimToWindow(messages, options) {
  const budget = maxTokens * targetUtilization; // 默认 75%
  if (estimateMessageTokens(messages) <= budget) return messages;

  // 按用户消息位置找到"轮次"边界
  const turnStarts = findTurnStarts(messages);

  // 从第 2 轮开始丢弃，保留最近 keepRecentTurns 轮
  for (let drop = 1; drop <= maxDrop; drop++) {
    const anchor = messages[0]; // 任务定义
    const rest = messages.slice(turnStarts[drop]);
    const trimmed = [anchor, ...rest];
    if (estimateMessageTokens(trimmed) <= budget) return trimmed;
  }
}
```

### 配置

| 参数 | 默认值 | 说明 |
|---|---|---|
| `maxTokens` | 模型限制 | 从 `MODEL_CONTEXT_LIMITS` 查找表解析 |
| `targetUtilization` | `0.75` | 目标利用率（窗口的 75% 时触发裁剪） |
| `keepRecentTurns` | `6` | 最少保留最近轮次 |

### 模型上下文窗口映射

系统内置 `MODEL_CONTEXT_LIMITS` 查找表：

| 模型前缀 | 上下文窗口 |
|---|---|
| `claude-*` | 200,000 |
| `gpt-*` / `o1` / `o3` | 128,000 |
| `gemini-*` | 1,000,000 |
| 未知模型 | 128,000（保守降级） |

### Token 估算

**文件**：`tokens.ts`

使用字符长度除以 4 的近似方法（`BYTES_PER_TOKEN = 4`），精度约 +/-8%。对于 `tool_call` 和 `tool_result` 内容块，额外计入结构开销（角色头、tool_call_id 等）。

---

## 第 2 层：渐进压缩

**文件**：`compression.ts`

当压缩启用（`compressionOptions.enabled = true`）且 token 估算超过 `triggerTokens` 阈值时，系统将最早轮次发送给 LLM 进行摘要压缩。

### 压缩提示词

系统使用与 Claude Code 自动压缩对齐的提示词，要求模型输出：

1. **`<analysis>` 块**（剥离）：按时间顺序的草稿笔记——用户请求、采用的方法、关键决策、涉及文件、错误和修复。
2. **`<summary>` 块**（保留）：包含 9 个小节的详细摘要：
   - 主要请求和意图
   - 关键技术概念
   - 文件和代码段落（含路径和变更）
   - 错误和修复
   - 问题解决过程
   - 所有用户消息（逐字记录）
   - 待办任务
   - 当前工作（压缩前的确切状态）
   - 可选的下一步
3. **`<topics>` 块**：2-6 个主题标签，用于后续检索。

模型被强制**不调用任何工具**（`NO_TOOLS_PREAMBLE`），仅输出纯文本。

### 压缩输出格式

```typescript
interface CompressedSegment {
  summary: string;          // 摘要文本
  decisions: string[];      // 关键决策和理由
  findings: string[];       // 重要发现/事实/约束
  pending: string[];        // 未解决事项
  topics: string[];         // 主题标签
  turnRange: { start: number; end: number }; // 覆盖的原始轮次范围
  originalTokenCount: number; // 压缩前 token 估算
}
```

压缩后，原始轮次被替换为一条合成的 `user` 角色消息：

```
[Compressed context — turns 1–5]
<summary>...</summary>
Decisions: ...
Findings: ...
Pending: ...
Continue the conversation from where it left off without asking the user any questions.
```

末尾的"继续对话，不要询问用户"指令确保模型看到摘要后不会停下来问用户问题。

### 再压缩（去重）

当初次压缩后上下文再次增长超过阈值时，之前的合成摘要消息会**包含**在新的压缩输入中，连同后续轮次一起发送给 LLM 进行再压缩。这产生的是**覆盖所有历史的一条更新摘要**，而不是多条摘要碎片的堆积。

### OC1：插入压缩（高效模式）

当 `insertCompress = true` 时，系统使用**提示缓存复用**策略：

1. 不发起单独的压缩 API 调用
2. 在正常对话流中插入一条压缩指令消息
3. 下一次 API 调用同时处理压缩指令和正常用户回复
4. 从回复中解析 `<summary>` 和 `<topics>` 输出
5. 被压缩的轮次替换为合成摘要

这避免了单独压缩调用的冷启动延迟，可节省约 50% 首次调用 token 消耗（OC2 模式：单次缓存重建）。

### 配置

| 参数 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用渐进压缩 |
| `triggerTokens` | `100_000` | 触发压缩的 token 阈值（200K 窗口的一半） |
| `keepRecentTurns` | `6` | 保持不压缩的最近轮次 |
| `model` | 与主模型相同 | 用于压缩的 LLM 模型 |
| `insertCompress` | `false` | 是否使用插入压缩（OC1） |

---

## 第 3 层：微压缩

**文件**：`compression.ts -> microCompact()`

纯启发式清理，无 LLM 调用。当**距离上一条助手消息的时间间隔**超过阈值时，旧的 `tool_result` 内容被清除为占位符。

### 工作原理

```typescript
function microCompact(messages, state, options) {
  // 检查时间间隔
  const gapMs = Date.now() - state.lastAssistantTs;
  if (gapMs >= gapThresholdMinutes * 60_000) {
    // 清除旧 tool_results，保留最近 keepRecent 条
    const idsToClear = new Set(state.toolUseIds.slice(0, -keepRecent));
    messages.map(m =>
      m.role === "tool" && idsToClear.has(m.tool_call_id)
        ? { ...m, content: "[Old tool result content cleared]" }
        : m
    );
  }
}
```

### 关键设计细节

- **时间间隔检测**使用上一轮保存的 `lastAssistantTs`，而不是重新扫描历史消息。因为 `Date.now()` 始终是"现在"；如果每次扫描重新计算，时间间隔将永远为零。
- `lastAssistantTs` 由 Agent Loop 在每次真实助手回复后更新。
- 清除后的内容使用固定占位符 `"[Old tool result content cleared]"` 确保 prompt cache 稳定性。

### 配置

| 参数 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用微压缩 |
| `gapThresholdMinutes` | `60` | 空闲时间阈值（分钟） |
| `keepRecent` | `5` | 保留不清除的最近 N 条工具结果 |

---

## 响应式压缩（Reactive Compact）

**文件**：`compression.ts -> isPromptTooLongError()` + Agent Loop 集成

当 API 返回 prompt-too-long 错误时触发，作为最后一道防线。

### 触发匹配规则

```typescript
const PROMPT_TOO_LONG_PATTERNS = [
  /prompt is too long/i,
  /prompt_too_long/i,
  /tokens?.*>\s*\d+/i,    // "tokens > limit" 类型错误
  /context length exceeds/i,
  /input.*too.*(?:long|large)/i,
];
```

### 重试流程

```
API 调用失败 -> isPromptTooLongError? -> 激进压缩 -> 重试
                     +- 保留轮次减半（最少 2 轮）
                     +- triggerTokens 阈值被忽略（无条件压缩）
                     +- 最多重试 3 次，超出 -> 抛出原始错误
```

### 熔断机制

`MAX_REACTIVE_RETRIES = 3`——连续 3 次响应式压缩失败后，抛出原始错误。防止在压缩无法解决的问题上无限重试。

---

## 空闲压缩

**文件**：`idle-compression.ts`

Agent 空闲一段时间后自动触发后台压缩。与 Claude Code 的 OC5-OC7 行为对齐。

- **OC5**：空闲 `idleMs` 后定时器触发（默认 314 秒，低于 5 分钟 prompt cache TTL）
- **OC6**：新的用户输入取消正在进行的压缩，确保历史一致性
- **OC7**：压缩结果通过 `onCompressed` 回调持久化

状态机：`idle -> running -> fired/cancelled/error`

---

## 工具预算管理

**文件**：`tool-budget.ts`

独立于上下文压缩，有一个单独的工具结果体量管理机制：

- **单结果上限**：`DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000`——超出结果写入磁盘，替换为预览 + 文件路径
- **每轮总预算**：`MAX_PER_TURN_CHARS = 200,000`——超出后将最大的结果卸载
- **Prompt cache 稳定性**：卸载的结果被冻结，在后续轮次中以相同方式回放（`reapplyReplacements()`）

---

## Agent Loop 集成点

**文件**：`packages/core/src/agent/loop.ts`

### 1. `applyProactiveCompress()` — 每轮开始时执行

- OC1 路径：插入压缩指令，无单独调用
- 传统路径：单独 API 调用进行压缩
- 触发 `onCompression` 钩子供 REPL/UI 通知

### 2. `prepareMessages()` — 上下文变换管线

1. 工具预算回放（保持 prompt cache 稳定性）
2. 微压缩（清理旧工具结果）
3. 滑动窗口裁剪

### 3. 钩子回调

压缩钩子支持 5 种事件类型，可供 REPL/UI 层观察：

| 事件类型 | 触发时机 | `before`/`after` 含义 |
|---|---|---|
| `"progressive"` | 渐进压缩完成 | 压缩前后的消息数 |
| `"micro"` | 微压缩完成 | 消息数（不变；事件本身是信号） |
| `"reactive"` | 响应式压缩完成 | 压缩前后的消息数 |
| `"insert-compress"` | OC1 指令插入 | 插入前后的消息数 |
| `"insert-resolved"` | OC1 解析完成 | 解析后的消息数 |

### 4. 关键不变量

- `messages[0]` 始终是任务用户消息；滑动窗口裁剪从索引 1 开始丢弃
- 压缩/微压缩通过 `onContextUpdate` 通知调用方；REPL 更新其上下文但原始会话日志不变
- 空的助手回复（无文本、无工具调用）不追加到消息列表中，防止后续 API 错误

---

## 配置示例

```typescript
const agentOptions = {
  // 第 1 层：滑动窗口
  contextOptions: {
    maxTokens: 200_000,
    targetUtilization: 0.75,
    keepRecentTurns: 6,
  },

  // 第 2 层：渐进压缩
  compressionOptions: {
    enabled: true,
    triggerTokens: 100_000,
    keepRecentTurns: 6,
    insertCompress: false,  // 设为 true 启用 OC1
  },

  // 第 3 层：微压缩
  microCompactOptions: {
    enabled: false,        // 默认关闭
    gapThresholdMinutes: 60,
    keepRecent: 5,
  },

  // 数据持久化目录（卸载工具结果时使用）
  runDir: "/tmp/vera-run",
};
```

---

## 性能指标

| 操作 | 成本 | 延迟影响 |
|---|---|---|
| 滑动窗口裁剪 | 0 token | < 1ms（纯数组切片） |
| 渐进压缩 | ~1K+2K token（一次小模型调用） | ~1-3s（含网络延迟） |
| 微压缩 | 0 token | < 1ms（纯数组遍历） |
| 响应式压缩 | ~1K+2K token | ~1-3s（网络错误后） |
| 工具预算回放 | 0 token | < 1ms（Map 查表） |
