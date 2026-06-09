# Core 与 Harness — 职责边界

> 厘清 `@vera/core` 与 `@vera/harness` 之间的职责划分、隔离边界与共享组件。

---

## 0. 一句话定义

| 包 | 定义 |
|---------|------------|
| `@vera/core` | **单次 LLM 调用所需的一切**——适配器、agent 循环、上下文管理、协议类型 |
| `@vera/harness` | **多步任务所需的一切**——流程编排、规划、批判、产物持久化、评估 |

依赖方向：`harness -> core`。**Core 绝不依赖 Harness。**

---

## 1. Core 职责

### 1.1 在范围内

| 模块 | 内容 |
|--------|----------|
| **LLM 适配器** | 在统一的 `LLMAdapter` 接口背后封装 Anthropic / OpenAI / Gemini API |
| **Agent 循环** | `runAgent` / `streamAgent`——消息循环、工具调用、多轮对话 |
| **子 Agent** | `agent/subagent.ts`——`agent` 工具实现：侧链会话、隔离 worktree、自定义 agent 定义加载 |
| **上下文管理** | 滑动窗口裁剪、token 估算、工具结果预算（防止单个结果撑爆上下文） |
| **意图分类** | `classifyIntent`、`routeTarget`——L0-L3 分层、领域识别 |
| **配置模式** | `VeraConfig`、`MCPServerConfig` 等配置类型及其加载逻辑 |
| **协议类型** | `Message`、`Tool`、`CompletionRequest`、`ContentPart`、`Usage` |
| **运行时协议类型** | `HarnessState`、`ExecutionPlan`、`TaskFlow` 等——类型定义在 core，实现在 harness |
| **权限规则** | `tools/permission-rules.ts`——持久化的工具规则、bash 允许/拒绝模式，补充 SecurityPlugin 静态检查 |
| **项目上下文** | `project-context/`——加载 `.vera/rules.md`、`CLAUDE.md` 等项目级提示规则，按路径范围激活 |
| **记忆追踪** | `memory/`——跨轮次记忆检测（detector）、扫描器、追踪器，为 agent 提供短期记忆锚点 |
| **会话管理** | `session/`——JSONL 存储、费用追踪、AI 自动标题（`title.ts`）、会话选择器分页扫描 |
| **REPL 与工作区** | `repl/`——交互式终端 UI（Ink）、会话存储、`workspace.ts` 管理当前 cwd / ToolRegistry / worktree 状态 |
| **REPL 命令** | `/branch` `/branches` `/switch` `/drop` 对话分支；`/try` 创建隔离 git worktree；`/merge` 应用 diff；`/adopt` 标记分支；`/sub`（`/transcript`）查看子 agent 侧链 |
| **CLI 颜色主题** | `repl/ui/theme.ts`——统一的语义颜色 token，基于 Claude Code 调色板，所有 UI 组件通过 `theme.*` 引用 |

### 1.2 不在范围内

- 任何跨步骤的状态机（我们在哪个步骤、是否需要重规划）
- 批判/回顾生成逻辑
- 产物持久化
- 技能加载、解析和按需激活
- MCP 服务器连接与管理
- 评估框架（TestCase、Evaluator）

---

## 2. Harness 职责

### 2.1 在范围内

| 模块 | 内容 |
|--------|----------|
| **流转状态机** | `HarnessRuntime`——管理 `intaking -> planning -> dispatching -> executing -> critiquing -> ...` |
| **计划管理** | 创建 `ExecutionPlan`、分发步骤、依赖解析、重规划 |
| **批判循环** | `critiquePlan`、`critiqueStep`、`generateRetrospective`——LLM 评判输出质量 |
| **提案生成** | 从回顾中推导策略改进提案 |
| **产物持久化** | `writeArtifact`、时间线、检查点——写入磁盘，确保可回放性 |
| **审批工作流** | 高风险操作暂停，等待人工确认 |
| **技能系统** | 技能加载（markdown -> 运行时对象），SkillResolver 按意图按需激活 |
| **MCP 管理** | 读取 `settings.json` 的 `mcp_servers`，启动进程，维护连接 |
| **评估框架** | `runCase`、`runSuite`、`evaluate`——TestCase 执行与评分 |
| **Markdown Flow** | 从 `.md` 文件加载计划定义 |

### 2.2 不在范围内

- 直接调用 LLM API（始终通过 `@vera/core` 适配器）
- 上下文窗口裁剪（由 `streamAgent` 内部处理）
- Token 计算（使用 `@vera/core` 的 `estimateMessageTokens`）
- 协议类型定义（从 `@vera/core/types` 导入）

---

## 3. 可复用的共享组件

以下由 core 提供，harness 和其他消费者（REPL、CLI、测试）可直接使用，**无需重新实现**。

### 3.1 LLMAdapter 接口

```ts
import type { LLMAdapter } from "@vera/core/adapters";
```

harness 内的所有 LLM 调用都通过 `LLMAdapter`，绝不直接实例化 `AnthropicAdapter`。这使得测试中可以注入 mock 适配器。

### 3.2 streamAgent / runAgent

```ts
import { streamAgent } from "@vera/core/agent";
```

Harness 的 `runAgentAssignment`、evaluator 的 `runCase` 都调用此函数，绝不自己实现轮次循环。

### 3.3 协议类型

```ts
import type { Tool, Message, Usage, ContentPart } from "@vera/core/types";
```

### 3.4 运行时协议类型

```ts
import type {
  HarnessState, ExecutionPlan, TaskFlow,
  CritiqueResult, StepResult, AgentAssignment,
  // ...
} from "@vera/core/types";
```

**定义在 core，实现在 harness。** Core 拥有类型契约，harness 提供具体行为。这使得第三方可以实现自己的 harness 而无需 fork core。

### 3.5 意图分类

```ts
import { classifyIntent, routeTarget } from "@vera/core/intent";
```

Harness 的 SkillResolver 使用 `IntentResult` 决定激活哪些技能；REPL 用它决定模型路由。同一分类结果，两边都用。

### 3.6 配置类型

```ts
import type { VeraConfig, MCPServerConfig } from "@vera/core/config";
```

Harness 读取 `settings.json` 的 `mcp_servers`，core 定义模式。

---

## 4. 待解决的边界问题

### 4.1 `core/src/index.ts` 职责过多（已解决）

`core/src/index.ts` 已清理完毕——现在仅包含库接口的 re-export（不再含适配器初始化、路由逻辑、硬编码工具或 REPL 启动）。可执行 CLI 入口位于 `main.ts`（通过 `tsx src/main.ts` 运行），具有顶层副作用但不会被作为库导入。

### 4.2 REPL 是否应属于 Core（短期可接受）

REPL 目前位于 core，但 REPL 依赖 `SessionStore`，而后者是有状态的应用级能力。短期可接受（workspace.ts 已封装会话/worktree 状态）。长期考虑提取到 `apps/repl`，core 仅提供无状态的 agent 循环。

### 4.3 `harness/types.ts` 与 `core/types/runtime.ts` 重复（已解决）

Harness 不再定义自己的 `ToolCallRecord`，而是从 `@open-vera/core/types` re-export（使用 core 的运行时协议规范定义）。此外，`core/src/tools/types.ts` 中原有的同名 `ToolCallRecord`（工具统计用途）已重命名为 `ToolExecutionRecord`，消除了 core 层面的命名冲突。

### 4.4 记忆模块边界（已实现，清晰）

`memory/` 作为跨轮次记忆检测（scanner / tracker / detector）实现，属于 agent 循环的感知层——正确放置在 core。长期来看，如果记忆需要 LLM 摘要写入或向量检索，摘要生成逻辑应留在 core（无状态 LLM 调用），持久化策略迁移到 harness。

---

## 5. 依赖图

```
apps/
  +-- harness-ui  --->  @vera/harness  --->  @vera/core
  +-- audio-label --->  @vera/core

packages/
  +-- harness     --->  @vera/core
  +-- benchmark   --->  @vera/harness, @vera/core
  +-- core        （无内部依赖）
```

**禁止的方向**：`core` -> `harness`，`core` -> `apps/*`

---

## 6. 新能力应该放在哪里

| 新能力 | 位置 | 理由 |
|----------------|-------|-----------|
| 新的 LLM 提供商 | core/adapters | 纯协议适配 |
| 技能加载 / SkillResolver | harness | 依赖意图分类 + MCP 连接 |
| MCP 连接管理 | harness | 有状态，依赖 settings.json |
| 新的批判策略 | harness/runtime | 流程逻辑 |
| 新的评估方法 | harness/evaluator | 评估框架 |
| 新的协议类型（如 ACP 消息体） | core/types | 类型契约属于 core |
| ACP 分发逻辑 | harness/runtime | 流程编排属于 harness |
| 上下文窗口策略调整 | core/context | 上下文管理属于 core |
| 新的 REPL 命令 | core/repl/commands | 命令生命周期在 REPL 层 |
| 子 Agent 类型/行为 | core/agent/subagent | 侧链 + worktree 隔离在 core |
| 持久化工具权限规则 | core/tools/permission-rules | 规则读写是工具层能力，非流程编排 |
| 项目级提示规则 | core/project-context | 无状态加载，由循环注入系统提示词 |
| UI 颜色 / 组件样式 | core/repl/ui/theme.ts | 集中式语义 token 管理，组件按引用导入 |
