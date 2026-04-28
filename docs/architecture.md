# Core 与 Harness 职责边界

> 澄清 `@vera/core` 和 `@vera/harness` 的职责分工、隔离边界、以及可共用的部分。

---

## 0. 一句话定义

| 包 | 定义 |
|----|------|
| `@vera/core` | **一次 LLM 调用需要什么** — 适配器、agent 循环、上下文管理、协议类型 |
| `@vera/harness` | **一个多步任务需要什么** — 流程编排、规划、批判、产物持久化、评估 |

依赖方向：`harness → core`，**core 不依赖 harness，永远如此。**

---

## 1. Core 的职责

### 1.1 负责

| 模块 | 内容 |
|------|------|
| **LLM Adapter** | 封装 Anthropic / OpenAI / Gemini API，统一为 `LLMAdapter` 接口 |
| **Agent Loop** | `runAgent` / `streamAgent` — 消息循环、工具调用、多轮对话 |
| **Context 管理** | 滑动窗口裁剪、token 估算、tool result 预算（防止单次结果撑爆上下文） |
| **Intent 分类** | `classifyIntent`、`routeTarget` — L0~L3 分级，domain 识别 |
| **Config Schema** | `VeraConfig`、`MCPServerConfig` 等配置类型及加载逻辑 |
| **协议类型** | `Message`、`Tool`、`CompletionRequest`、`ContentPart`、`Usage` |
| **运行时协议类型** | `HarnessState`、`ExecutionPlan`、`TaskFlow` 等 —— 类型定义在 core，实现在 harness |
| **REPL** | 交互式终端 UI（Ink）、session 存储 |

### 1.2 不负责

- 任何跨步骤的状态机（流程走到哪一步、是否要重规划）
- 批判（Critique）/ 回顾（Retrospective）的生成逻辑
- 产物（Artifact）的持久化
- Skill 的加载、解析、按需激活
- MCP server 的连接与管理
- 评估框架（TestCase、Evaluator）

---

## 2. Harness 的职责

### 2.1 负责

| 模块 | 内容 |
|------|------|
| **Flow 状态机** | `HarnessRuntime` — 管理 `intaking → planning → dispatching → executing → critiquing → …` |
| **Plan 管理** | 创建 `ExecutionPlan`、分发 Step、依赖解析、replan |
| **Critique 循环** | `critiquePlan`、`critiqueStep`、`generateRetrospective` — 用 LLM 评判输出质量 |
| **Proposal 生成** | 从 Retrospective 提炼策略改进提案 |
| **产物持久化** | `writeArtifact`、timeline、checkpoint — 写磁盘，保证可回放 |
| **Approval 工作流** | 高风险操作暂停、等待人工确认 |
| **Skill 系统** | Skill 加载（markdown → 运行时对象）、SkillResolver 按 intent 按需激活 |
| **MCP 管理** | 读 `settings.json` 的 `mcp_servers`，spawn 进程，维护连接 |
| **评估框架** | `runCase`、`runSuite`、`evaluate` — TestCase 执行与评分 |
| **Markdown Flow** | 从 `.md` 文件加载 plan 定义 |

### 2.2 不负责

- 直接调用 LLM API（统一走 `@vera/core` 的 adapter）
- 上下文窗口裁剪（交给 `streamAgent` 内部处理）
- Token 计算（用 `@vera/core` 的 `estimateMessageTokens`）
- 协议类型定义（从 `@vera/core/types` 导入）

---

## 3. 可复用的共享部分

这些由 core 提供，harness 和其他调用方（REPL、CLI、测试）都可以直接用，**不需要重新实现**。

### 3.1 LLMAdapter 接口

```ts
import type { LLMAdapter } from "@vera/core/adapters";
```

所有 harness 内的 LLM 调用都通过 `LLMAdapter`，不直接 new AnthropicAdapter。这样测试时可以注入 mock adapter。

### 3.2 streamAgent / runAgent

```ts
import { streamAgent } from "@vera/core/agent";
```

harness 的 `runAgentAssignment`、evaluator 的 `runCase` 都调这个，不自己实现 turn loop。

### 3.3 协议类型

```ts
import type { Tool, Message, Usage, ContentPart } from "@vera/core/types";
```

### 3.4 运行时协议类型

```ts
import type {
  HarnessState, ExecutionPlan, TaskFlow,
  CritiqueResult, StepResult, AgentAssignment,
  ...
} from "@vera/core/types";
```

**定义在 core，实现在 harness。** core 只管类型约定，harness 提供具体行为。这使得第三方可以实现自己的 harness 而不 fork core。

### 3.5 Intent 分类

```ts
import { classifyIntent, routeTarget } from "@vera/core/intent";
```

harness 的 SkillResolver 用 `IntentResult` 决定激活哪些 skill；REPL 用它决定路由到哪个模型。同一个分类结果，两边都用。

### 3.6 Config 类型

```ts
import type { VeraConfig, MCPServerConfig } from "@vera/core/config";
```

harness 读 `settings.json` 的 `mcp_servers`，core 定义 schema。

---

## 4. 当前需要厘清的边界问题

### 4.1 `core/src/index.ts` 做了太多

现在 `core/src/index.ts` 里有：适配器初始化、routing 逻辑、工具硬编码、REPL 启动——这是**应用入口**的职责，不是 core 库的职责。

应该迁移到 `apps/` 下的入口文件，core 只导出库接口。

### 4.2 REPL 是否属于 core

REPL 目前在 core，但 REPL 依赖 `SessionStore`，而 session 存储是有状态的应用级能力。
短期可留在 core，长期考虑拆到 `apps/repl`，core 只提供无状态的 agent loop。

### 4.3 `harness/types.ts` 与 `core/types/runtime.ts` 的重复

harness 有自己的 `ToolCallRecord`（`packages/harness/src/types.ts`），core 也有（`core/types/runtime.ts`）。
应统一用 core 的定义，harness 直接 re-export 或直接导入。

---

## 5. 依赖图

```
apps/
  ├── harness-ui  ──→  @vera/harness  ──→  @vera/core
  └── audio-label ──→  @vera/core

packages/
  ├── harness     ──→  @vera/core
  ├── benchmark   ──→  @vera/harness, @vera/core
  └── core        (无内部依赖)
```

**禁止方向**：`core` → `harness`，`core` → `apps/*`

---

## 6. 新能力加在哪里

| 新能力 | 加在哪 | 理由 |
|--------|--------|------|
| 新 LLM provider | core/adapters | 纯协议适配 |
| Skill 加载 / SkillResolver | harness | 依赖 intent 分类 + MCP 连接 |
| MCP 连接管理 | harness | 有状态，依赖 settings.json |
| 新的 Critique 策略 | harness/runtime | 流程逻辑 |
| 新 eval 方法 | harness/evaluator | 评估框架 |
| 新协议类型（如 ACP 消息体） | core/types | 类型约定归 core |
| ACP 分发逻辑 | harness/runtime | 流程编排归 harness |
| context window 策略调整 | core/context | 上下文管理归 core |
