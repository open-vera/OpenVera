# 无限上下文 — 当前实现说明

> 本文档对齐 [roadmap.md P0.6](../roadmap.md) 和 [agent-design.md §1](./agent-design.md#1-无限上下文infinite-context)，描述 2026-04-28 的实际实现状态。

---

## 1. 结论

无限上下文的 P0 能力已实现并接入 `runAgent`/`streamAgent` 主循环：

- 滑动窗口裁剪（window trimming）
- 渐进压缩（progressive compression）
- 微压缩（micro-compact）
- reactive compact（超长报错后重试压缩）
- 压缩片段召回（segment recall）

---

## 2. 代码落点

| 文件 | 能力 |
|---|---|
| `packages/core/src/context/tokens.ts` | token 估算与模型上下文上限 |
| `packages/core/src/context/window.ts` | `trimToWindow`（窗口裁剪，保留任务锚点） |
| `packages/core/src/context/compression.ts` | `compressMessages`、`microCompact`、segment 索引与召回 |
| `packages/core/src/context/tool-budget.ts` | tool 输出预算与持久化替换策略 |
| `packages/core/src/agent/loop.ts` | 在两个主循环中编排 window/compression/reactive compact |

---

## 3. 运行机制（当前）

1. 每轮请求前，先做 `trimToWindow` 控制窗口占用。
2. 达到阈值时触发 `compressMessages`，保留近期上下文并压缩旧消息。
3. 根据时间间隙与消息形态触发 `microCompact`，回收陈旧工具输出。
4. 如模型返回 prompt-too-long 错误，进入 reactive compact 并重试。
5. 被压缩片段保留 segment 元数据，可按相关性检索并展开。

---

## 4. P0 验收对齐

- [x] 长对话可自动窗口裁剪，避免直接撞上 context length 上限
- [x] 压缩已集成到 `runAgent` 和 `streamAgent`
- [x] 超长错误可触发 reactive compact 重试
- [x] 压缩片段可检索与还原
- [x] micro-compact 状态在主循环内持有并更新

---

## 5. 当前边界与后续

- 仍需持续优化：大体量工具输出的执行后裁剪成本（roadmap 中 M3，状态待定）。
- 与长期记忆系统（P1）的融合仍在后续阶段：当前无限上下文解决的是会话内上下文容量，不替代跨任务记忆。
- 相关对齐与技术债统一见 [roadmap.md#已知缺陷与技术债](../roadmap.md#已知缺陷与技术债) 与 [capability-gaps.md](./capability-gaps.md)。



---


# 上下文压缩系统设计

> 所属包：`@open-vera/core` | 源码目录：`packages/core/src/context/`
> 最后更新：2026-06-04

## 概述

Vera 的上下文压缩系统负责管理 LLM 对话历史的大小，使其不超出模型的上下文窗口限制，同时尽可能保留关键信息。系统采用**三层防御**策略：从轻量级的滑动窗口裁切，到 LLM 驱动的渐进式摘要压缩，再到纯启发式的微压缩清理，层层递进、各司其职。

## 为什么需要压缩

1. **Token 成本**：每次 API 调用按 token 计费，历史消息越长成本越高。压缩可将早期轮次的 token 消耗降低 90% 以上。
2. **上下文窗口限制**：主流模型窗口有限（Claude 200K、GPT-4o 128K、Gemini 1M）。超过限制会导致 API 直接拒绝请求。
3. **响应质量**：过长的上下文会稀释模型注意力，导致"中间丢失"现象——模型忽略中间轮次的信息。
4. **提示缓存失效**：Anthropic 的 prompt cache 在消息结构变化时会重建，带来额外延迟。压缩后消息数减少，可间接提升缓存命中率。

## 三层架构总览

```
上下文增长方向 ──────────────────────────────────>

[第1层] 滑动窗口裁切 (window.ts)
  │  token 估算 → 超出 75% 预算 → 裁掉最旧轮次
  │  始终保留：messages[0]（任务定义，不可丢失）
  │  最少保留：6 轮最近对话
  │  成本：0 token（纯本地计算）
  ▼
[第2层] 渐进式压缩 (compression.ts)
  │  token 估算 → 超出 triggerTokens → LLM 摘要最旧轮次
  │  输出：结构化摘要 + 决策/发现/待办 + 话题标签
  │  摘要消息注入到上下文开头，替代被压缩的原始轮次
  │  成本：一次小模型 API 调用（约 1K input + 2K output token）
  ▼
[第3层] 微压缩 (compression.ts → microCompact)
  │  时间间隙检测 → 清空旧的 tool_result 内容
  │  保留最近 N 条 tool result 完整内容
  │  成本：0 token（纯启发式，无 LLM 调用）
  ▼
[应急层] 响应式压缩 (compression.ts → isPromptTooLongError)
  │  捕获 API 返回的 "prompt too long" 错误
  │  激进压缩（保留更少轮次，更小阈值）
  │  最多重试 3 次，超过则抛出原始错误（熔断机制）
```

### 执行顺序

在 Agent Loop 的每轮开始时，按以下顺序应用上下文变换：

```
用户消息 → [渐进压缩] → [Tool Budget 重放] → [微压缩] → [滑动窗口裁切] → API 调用
```

详见 `packages/core/src/agent/loop.ts` 的 `prepareMessages()` 和 `applyProactiveCompress()` 函数。

---

## 第一层：滑动窗口裁切

**文件**：`window.ts`

核心原则：**第一条消息（任务定义）永不丢弃**。丢失它意味着模型失去对原始目标的记忆，这是所有裁切策略中最致命的错误。

### 工作原理

```typescript
// window.ts - trimToWindow()
function trimToWindow(messages, options) {
  const budget = maxTokens * targetUtilization; // 默认 75%
  if (estimateMessageTokens(messages) <= budget) return messages;

  // 按用户消息位置找出"轮次"边界
  const turnStarts = findTurnStarts(messages);

  // 从第 2 轮开始裁切，保留最近 keepRecentTurns 轮
  for (let drop = 1; drop <= maxDrop; drop++) {
    const anchor = messages[0]; // 任务定义
    const rest = messages.slice(turnStarts[drop]);
    const trimmed = [anchor, ...rest];
    if (estimateMessageTokens(trimmed) <= budget) return trimmed;
  }
}
```

### 配置参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `maxTokens` | 模型限值 | 从 `MODEL_CONTEXT_LIMITS` 查表中解析 |
| `targetUtilization` | `0.75` | 目标利用率（75% 窗口即触发裁切） |
| `keepRecentTurns` | `6` | 最少保留的最近轮次数量 |

### 模型上下文窗口映射

系统内建了常见模型的窗口大小映射表 `MODEL_CONTEXT_LIMITS`：

| 模型前缀 | 上下文窗口 |
|---|---|
| `claude-*` | 200,000 |
| `gpt-*` / `o1` / `o3` | 128,000 |
| `gemini-*` | 1,000,000 |
| 未知模型 | 128,000（保守降级） |

### Token 估算法

**文件**：`tokens.ts`

采用字符长度除以 4 的近似法（`BYTES_PER_TOKEN = 4`），约为 ±8% 精度。对于 tool_call 和 tool_result 内容块，额外计入结构开销（role header、tool_call_id 等）。

---

## 第二层：渐进式压缩

**文件**：`compression.ts`

当启用压缩（`compressionOptions.enabled = true`）且 token 估算超过 `triggerTokens` 阈值时，系统会将最旧的轮次发送给一个 LLM 进行摘要压缩。

### 压缩提示词

系统使用与 Claude Code 自动压缩对齐的提示词，要求模型输出：

1. **`<analysis>` 块**（会被剥离）：按时间顺序的草稿记录——用户请求、采取的方法、关键决策、涉及的文件、错误和修复。
2. **`<summary>` 块**（保留）：9 个小节的详细摘要：
   - 主要请求与意图
   - 关键技术概念
   - 文件与代码段（含路径和改动内容）
   - 错误与修复
   - 问题解决过程
   - 所有用户消息（逐字记录）
   - 待办任务
   - 当前工作（压缩前的精确状态）
   - 可选的下一步
3. **`<topics>` 块**：2-6 个话题标签，用于后续检索。

模型被强制要求**不得调用任何工具**（`NO_TOOLS_PREAMBLE`），仅输出纯文本。

### 压缩输出格式

```typescript
interface CompressedSegment {
  summary: string;          // 摘要文本
  decisions: string[];      // 关键决策及理由
  findings: string[];       // 重要发现/事实/约束
  pending: string[];        // 未解决的事项
  topics: string[];         // 话题标签
  turnRange: { start: number; end: number }; // 覆盖的原始轮次范围
  originalTokenCount: number; // 压缩前的 token 估算
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

末尾的"无需确认直接继续"指令确保模型不因看到摘要而停下来问用户问题。

### 二次压缩（去重）

当上下文在首次压缩后再次增长到阈值以上时，之前的合成摘要消息会被**包含**在新的压缩输入中，与后续轮次一起发送给 LLM 进行二次压缩。这样产生的是**子母所有历史信息的单一更新摘要**，而非多个摘要片段的累积。

### OC1：插入式压缩（增效模式）

当启用 `insertCompress = true` 时，系统采用**复用提示缓存**的策略：

1. 不发起独立的压缩 API 调用
2. 在正常对话流中插入一条压缩指令消息
3. 下一轮 API 调用同时处理压缩指令和正常的用户响应
4. 解析响应中的 `<summary>` 和 `<topics>` 输出
5. 用合成摘要替换被压缩的轮次

这避免了独立压缩调用的冷启动延迟，节省约 50% 首次调用的 token 消耗（OC2 模式：单次缓存重建）。

```typescript
// compression.ts - OC1 入口
insertCompressionInstruction(messages, options) → { messages, pending }

// 在 API 调用返回后解析
resolveInsertCompress(messages, responseText, pending, state) → { messages, state }
```

### 配置参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用渐进压缩 |
| `triggerTokens` | `100_000` | 触发压缩的 token 阈值（200K 窗口的一半） |
| `keepRecentTurns` | `6` | 保持未压缩的最近轮次数 |
| `model` | 同主模型 | 压缩用 LLM 模型 |
| `insertCompress` | `false` | 是否使用插入式压缩（OC1） |

---

## 第三层：微压缩（Micro-Compact）

**文件**：`compression.ts → microCompact()`

纯启发式清理，不调用 LLM。当**距离上一条 assistant 消息的时间间隔**超过阈值时，将旧的 tool_result 内容清空为占位符。

### 工作原理

```typescript
function microCompact(messages, state, options) {
  // 检查时间间隙
  const gapMs = Date.now() - state.lastAssistantTs;
  if (gapMs >= gapThresholdMinutes * 60_000) {
    // 清空旧的 tool_result，保留最近 keepRecent 条
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

- **时间间隙判断**使用上一轮保存的 `lastAssistantTs`，而不是重新扫描历史消息计算。这是因为 `Date.now()` 总是"现在"，如果每次扫描都重新计算，时间间隙永远为零。
- `lastAssistantTs` 由 Agent Loop 在每次真实的 assistant 响应后更新。
- 清理的内容使用固定的占位符 `"[Old tool result content cleared]"`，保证 prompt cache 稳定性。

### 配置参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用微压缩 |
| `gapThresholdMinutes` | `60` | 触发清理的空闲时间（分钟） |
| `keepRecent` | `5` | 保留最近的 N 条 tool result 不清空 |

---

## 响应式压缩（Reactive Compact）

**文件**：`compression.ts → isPromptTooLongError()` + Agent Loop 集成

当 API 返回 prompt 过长错误时触发，作为最后一道防线。

### 触发匹配规则

```typescript
const PROMPT_TOO_LONG_PATTERNS = [
  /prompt is too long/i,
  /prompt_too_long/i,
  /tokens?.*>\s*\d+/i,    // "tokens > limit" 类错误
  /context length exceeds/i,
  /input.*too.*(?:long|large)/i,
];
```

### 重试流程

```
API 调用失败 → isPromptTooLongError? → 激进压缩 → 重试
                 ├─ 保留轮次减半（最少 2 轮）
                 ├─ 忽略 triggerTokens 阈值（无条件压缩）
                 └─ 最多重试 3 次，超过 → 抛出原始错误
```

响应式压缩通过 `completeWithReactiveCompact()` 和 `streamTurnWithReactiveCompact()` 两个辅助函数在非流式和流式 agent loop 中统一集成。

### 熔断机制

`MAX_REACTIVE_RETRIES = 3`——连续 3 次响应式压缩仍失败后，抛出原始错误，不再尝试。防止在非压缩可解决的问题上陷入无限重试。

---

## 空闲压缩（Idle Compression）

**文件**：`idle-compression.ts`

自动在 Agent 空闲一段时间后触发背景压缩。对齐 Claude Code 的 OC5-OC7 行为。

- **OC5**：计时器在空闲 `idleMs`（默认 314 秒，低于 5 分钟 prompt cache TTL）后触发
- **OC6**：新的用户输入取消正在进行的压缩，保证历史一致性
- **OC7**：压缩结果通过 `onCompressed` 回调持久化

状态机：`idle → running → fired/cancelled/error`

```typescript
const timer = new IdleCompressionTimer({
  idleMs: 314_000,
  compression: { enabled: true, keepRecentTurns: 10 },
  adapter, model,
  onCompressed: (result) => { /* 持久化压缩后的消息 */ },
});
```

---

## Tool Budget 管理

**文件**：`tool-budget.ts`

在上下文压缩之外，系统还有独立的 tool result 大小管理机制：

- **单条结果上限**：`DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000`，超出则写入磁盘，替换为预览 + 文件路径
- **每轮总预算**：`MAX_PER_TURN_CHARS = 200,000`，超出则将最大的结果卸载
- **Prompt Cache 稳定性**：已卸载的结果会被冻结，后续每轮按相同方式重放（`reapplyReplacements()`）

---

## Agent Loop 集成点

**文件**：`packages/core/src/agent/loop.ts`

压缩系统在 Agent Loop 中的两个主要集成位置：

### 1. `applyProactiveCompress()` — 每轮开始时执行

```typescript
// loop.ts 第 377-405 行
async function applyProactiveCompress(messages, compressionState, options, ...) {
  if (opts.insertCompress) {
    // OC1: 插入压缩指令，不单独调用
    return insertCompressionInstruction(messages, opts);
  }
  // 传统路径: 独立 API 调用来压缩
  const result = await compressMessages(messages, compressionState, opts, adapter, model);
  // 触发 onCompression hook
  if (result.messages.length !== before) {
    await hooks?.onCompression?.("progressive", before, after);
  }
}
```

### 2. `prepareMessages()` — 上下文变换管线

```typescript
// loop.ts 第 311-348 行
async function prepareMessages(messages, budgetState, windowOpts, ...) {
  // 1. tool budget 重放（保持 prompt cache 稳定）
  msgs = reapplyReplacements(msgs, budgetState);
  msgs = await enforcePerTurnBudget(msgs, budgetState, runDir);
  // 2. 微压缩（清理旧 tool result）
  const { messages, microCompactFired } = microCompact(msgs, state, opts);
  // 3. 滑动窗口裁切
  const apiMessages = windowOpts ? trimToWindow(contextMessages, windowOpts) : contextMessages;
}
```

### 3. Hook 回调

compression hook 支持 5 种事件类型，可被 REPL/UI 层监听展示：

| 事件类型 | 触发时机 | `before`/`after` 含义 |
|---|---|---|
| `"progressive"` | 渐进压缩完成 | 压缩前后的消息数量 |
| `"micro"` | 微压缩完成 | 消息数量（不变，事件即信号） |
| `"reactive"` | 响应式压缩完成 | 压缩前后的消息数量 |
| `"insert-compress"` | OC1 指令插入 | 插入前后的消息数量 |
| `"insert-resolved"` | OC1 解析完成 | 解析后的消息数量 |

### 4. 关键不变量

- `messages[0]` 始终是任务的用户消息，滑动窗口裁切从索引 1 开始丢弃
- 压缩/微压缩通过 `onContextUpdate` 回调通知调用方，REPL 层据此更新上下文，但原始 session log 保持不变
- 空 assistant 响应（无文本、无 tool call）不会追加到消息列表，防止后续 API 调用出错

---

## 配置示例

```typescript
const agentOptions = {
  // 第一层：滑动窗口
  contextOptions: {
    maxTokens: 200_000,
    targetUtilization: 0.75,
    keepRecentTurns: 6,
  },

  // 第二层：渐进压缩
  compressionOptions: {
    enabled: true,
    triggerTokens: 100_000,
    keepRecentTurns: 6,
    insertCompress: false,  // 设为 true 启用 OC1
  },

  // 第三层：微压缩
  microCompactOptions: {
    enabled: false,        // 默认关闭
    gapThresholdMinutes: 60,
    keepRecent: 5,
  },

  // 数据持久化目录（tool result 卸载时使用）
  runDir: "/tmp/vera-run",
};
```

---

## 性能指标

| 操作 | 成本 | 延迟影响 |
|---|---|---|
| 滑动窗口裁切 | 0 token | < 1ms（纯数组切片） |
| 渐进式压缩 | ~1K+2K token（一次小模型调用） | ~1-3s（含网络延迟） |
| 微压缩 | 0 token | < 1ms（纯数组遍历） |
| 响应式压缩 | ~1K+2K token | ~1-3s（在网络错误后） |
| Tool budget 重放 | 0 token | < 1ms（Map 查询） |
