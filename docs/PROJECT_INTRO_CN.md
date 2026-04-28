# Vera — 项目介绍

> **愿景：实现 SOTA AGI，加速人类创意落地。**

---

## Vera 是什么？

Vera 是一个**以 Harness 为内核的 agent runtime**，为一个核心目标而生：消除人类创意意图与可靠自主执行之间的鸿沟。

大多数 AI agent 系统本质上是更聪明的助手——响应 prompt、调用工具、产出结果。Vera 在架构层面截然不同——它是一个**可自规划、自循环、自我批判、自我进化的 runtime**。在这里，Harness 不是附加的安全壳，而是执行**内核**本身。

```
人类创意
  → 意图分级与模型路由
  → 结构化 Flow（ExecutionPlan）
  → 通过工具运行时逐步执行
  → 独立 Critique（Challenger）
  → 失败归因 & 重规划
  → 经验沉淀 → 记忆
  → benchmark 门控 Proposal → Rollout
  → 下一循环，在边界内继续
```

这不是一个工作流，而是一个**闭合的、自驱动的循环**——每一次状态转换都受框架治理。

---

## 我们要解决的问题

### 为什么当前 agent 系统在生产环境中频繁失效

演示效果惊艳与生产环境可靠之间的鸿沟，不是模型能力的问题，而是**架构问题**。

当今的 agent 系统有五种共同的结构性失效模式：

#### ❶ 缺乏结构化执行框架
任务是一个 prompt 加上临时串联的工具调用。复杂任务会逐渐漂移——agent 慢慢忘记初始目标，过度纠缠局部细节，或毫无出路地卡死。

#### ❷ 自我评估从根本上不可靠
agent 天然对自己的产出持乐观态度。它们擅长解释"为什么已经差不多了"，而不擅长主动发现问题所在。没有结构独立的评估者，质量门控形同虚设。

#### ❸ 长任务上下文崩溃
长任务会耗尽上下文窗口。agent 丢失早期推理，与之前的决策自相矛盾，输出质量越来越差——不是因为模型太弱，而是没有任何机制在管理上下文的生命周期。

#### ❹ 没有学习闭环——每次失败都被丢弃
当 agent 失败时，没有任何信息被记录、归因或反馈回系统。同样的错误在不同运行、不同用户、不同版本中反复出现。能力没有复利，只有重复。

#### ❺ 没有受治理的进化机制
改进一个 agent，今天的方式是编辑 prompt 然后祈祷。没有 benchmark 衡量变化。没有 Rollout 机制控制影响范围。没有回归测试检测退化。进步靠猜测。

### 根本原因

> 没有有原则的运行时内核，agent 能力只是 prompt 技巧的层层堆叠。

没有 Harness 的自规划是失控的。没有结构独立性的自我批判是噪音。没有 benchmark 闭环的自我进化是一厢情愿。

**需要一种根本不同的架构。**

---

## 我们的愿景

> **实现 SOTA AGI，加速人类创意落地。**

我们相信，通往 SOTA AGI 的路不只是更大的模型——它必须经过**有原则的执行框架**，让 agent 系统在规模上变得可靠、可验证、持续自我提升。

未来最强大的系统不只是产出更好。它们将：

- **自主规划工作**——将任何目标分解为可独立验证的、阶段化的执行单元
- **验证自身结果**——通过结构独立的 Critique，而非自我评估
- **从失败中学习**——沉淀经验、归因根因、生成改进提案
- **以受治理的方式进化**——每一项改进都必须经过 benchmark 验证才能 Rollout

当这四种能力叠加在一起，人类创意意图与工作现实之间的距离就会坍缩。过去需要数周精心工程化的想法，变得可以在数小时内执行落地——不是因为模型更聪明，而是因为 runtime 被设计成不允许不合格的产出蒙混过关。

**人类创意，由一个拒绝走捷径的 runtime 加速落地。**

---

## 核心哲学：以 Harness 为内核

Vera 的基础性洞察来自 Anthropic 对长时运行 agent 的研究，并经 Harness MVP 实际验证：

> **不要设计一个"产出更多"的 agent 系统，要设计一个"更难放过不合格产出"的工作系统。**

这从根本上倒转了常见的 agent 设计逻辑：

| 常见 agent 系统 | Vera |
|---|---|
| 模型直接调用工具 | 所有工具调用通过 Harness 调度 |
| 模型决定是否继续 | Harness 拥有 Flow State 转换权 |
| 模型自评是否完成 | Challenger 独立对每一步打分 |
| 安全 = prompt 约束 | 安全 = 架构层边界，非法跳转直接抛错 |
| 失败 = 再试一次 | 失败 = 归因 + 提案 + 回归验证后的修复 |

### Harness 六条核心原则

**原则一：先定义完成，再开始执行**
每个 Flow 都有明确的完成标准、必要交付物和失败条件。一个不知道"完成"长什么样的 agent，永远无法在正确的地方可靠地停下来。

**原则二：长任务必须阶段化——不能只靠长上下文**
长任务会漂移。把工作切成可独立验证的单元。每个单元产出结构化工件。即使会话中断、模型切换、上下文重置，任务依然保持连贯。

**原则三：外部批判——而非自我评估**
Challenger 角色在结构上是独立的。它不继承实现者的乐观。它依照预定义标准评估，产出带评分的结构化结果和具体 requiredFixes，并拥有否决权。

**原则四：验证必须贴近真实环境**
最弱的验证方式是阅读文字描述。Vera 实际运行代码、执行测试套件，在 P3 中还会操作真实 UI——而不只是检查输出文本。

**原则五：每次失败都必须归因**
是需求理解错了？实现做错了？还是验证太弱？每次失败都必须给出根因，而不只是重试。没有归因，恢复只是以更高代价重复同样的错误。

**原则六：上下文必须沉淀为工件——而非只留在对话历史里**
可靠的上下文是结构化工件，不是聊天日志。Plan、Step 执行结果、Critique 报告、Dream 报告、Proposal——全部持久化。任务可以经受 agent 切换、模型更换和上下文重置的考验。

---

## 独特价值主张

### 1. 认知职责分离——最重要的工程原则

```
Planner      读取 .flow/ 上下文 → 生成 ExecutionPlan → 按任务复杂度自适应
Role Agent   按准出标准执行步骤 → 产出具体交付物
Challenger   独立对每步产出打分 → 积累 lessons → 每次运行攻击更精准
Orchestrator 调度 agent → 管理 context reset → 执行审批门
```

**核心约束：** Role Agent 永远没有权利决定自己的工作"算完成了"。这个权力专属于 Challenger。

这种分离从根本上防止了 agent 系统中最常见的失效模式：同一个 agent 同时扮演实现者、评估者和裁判三重角色。

### 2. 无限上下文，不降质

Vera 把上下文作为生命周期来管理，而非一个需要绕过的限制：

| 层次 | 机制 | 触发时机 |
|---|---|---|
| 滑动窗口裁剪 | 丢弃最早轮次，保留任务定义锚点 | token 超过阈值 80% |
| 渐进压缩 | 轻量模型摘要旧轮次，注入 system 上下文 | 超过 token 阈值 |
| 微压缩 | 基于时间间隙启发式清理过期工具结果，无 LLM 调用 | 时间间隙触发 |
| 反应式压缩 | 遇到 `prompt-too-long` 错误时激进压缩并重试 | API 错误响应 |

**第一条消息（原始任务定义）始终保留。** agent 永远不会丢失自己的目标。

### 3. Subagent 的真实隔离

`agent` 工具支持三种隔离模式：

| 模式 | 机制 | 适用场景 |
|---|---|---|
| `none` | 共享上下文（默认） | 标准委托 |
| `try` | 独立 git worktree，变更可通过 `/merge` 审查后合并 | 实验性代码修改 |
| `remote` | 可插拔外部执行后端 | 分布式或沙箱执行 |

Subagent 继承父 agent 的 Harness 约束，无法提权。结果携带 transcript ID，支持完整审计。

### 4. 意图路由——合适的模型，合理的成本

轻量分类器（haiku/mini，~100ms）在路由前对每次输入分级：

| 级别 | 描述 | 默认模型 |
|---|---|---|
| L0 | 闲聊、简单问答 | claude-haiku / gpt-4o-mini |
| L1 | 单步任务 | claude-haiku / gpt-4o-mini |
| L2 | 多步任务 | claude-sonnet / gpt-4o |
| L3 | 复杂规划、深度推理 | claude-opus / o3 |

L3 任务自动激活 Plan Mode。目标：L0/L1 准确率 > 95%，整体成本降低 > 60%。

### 5. Challenger 会学习——攻击随时间越来越精准

每次运行后，Challenger 会把发现的失效模式追加到 `.flow/challenger/lessons/{step}.md`。下次运行时它读取这些 lessons 并以此为攻击角度。随着时间推移，系统越来越难被蒙混过关——不是因为模型变强了，而是因为框架积累了关于这个特定代码库或工作流容易在哪里失败的机构性知识。

### 6. 通过受治理的 Pipeline 实现自我进化

```
Dreaming（异步） → 提炼 episodic memory + benchmark 失败案例，生成洞察
       ↓
生成 Proposal → 结构化改进提案（prompt / 工具策略 / 工作流）
       ↓
人工审核 → Proposal 是建议，不是自动提交
       ↓
benchmark 门控 Rollout → 变更只有在提升可测量通过率后才能上线
       ↓
回归 → failure-to-benchmark 闭环完成
```

这**不是**"agent 自我重写"。这是一个有原则的进化 Pipeline——每一项拟议的改进都必须用证据赢得自己的位置。

---

## 架构概览

### 包结构

```
vera/                          ← pnpm workspace monorepo
├── packages/
│   ├── @vera/core             ← 无状态 runtime 基础层
│   ├── @vera/harness          ← 有状态编排内核
│   └── @vera/benchmark        ← 评测基础设施
└── apps/
    ├── harness-ui/server      ← Web UI 后端（vera-serve）
    └── harness-ui/web         ← Web UI 前端（Vue 3 + Vite）
```

**依赖方向严格单向：**
```
@vera/benchmark → @vera/harness → @vera/core
```
Core 永远不依赖 Harness。这保证了无状态 agent loop 可以独立于编排层使用。

---

### `@vera/core` — Agent Loop

单次 LLM 调用所需的一切。无状态，无编排逻辑。

| 模块 | 能力 |
|---|---|
| `adapters/` | 统一 `LLMAdapter` 接口——Anthropic、OpenAI、Gemini（DeepSeek / Groq / Azure 通过配置接入） |
| `agent/` | `streamAgent` / `runAgent`——多轮循环、工具调度、重试、压缩 |
| `agent/subagent.ts` | `agent` tool——Orchestrator/Worker 委托、隔离模式、后台任务 |
| `context/` | token 估算、窗口裁剪、渐进/微/反应式压缩、片段召回 |
| `intent/` | `classifyIntent` / `routeTarget`——L0–L3 分级、domain 识别 |
| `tools/` | 7 个内置工具：`read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| `tools/registry.ts` | ToolRegistry——注册、执行、生命周期 hook（SecurityPlugin、AnalyticsPlugin） |
| `tools/security.ts` | 路径边界强制、工具白名单、injection 防御、只读模式 |
| `tools/permission-rules.ts` | 持久化 allow/deny 规则、bash 风险确认 |
| `session/` | JSONL session 存储、成本追踪、session picker、AI 自动标题 |
| `repl/` | React + Ink 终端 UI——ConversationPanel、SessionPicker、DiffView、主题系统 |
| `repl/commands/` | `/branch` `/try` `/merge` `/sessions` `/subjobs` `/resume` `/model` 等命令 |
| `memory/` | 跨轮次记忆检测（detector / scanner / tracker） |
| `project-context/` | `.vera/rules.md` / `CLAUDE.md` 加载，按路径激活 scoped rules |
| `worktree/` | git worktree 创建与管理，支持 `isolation: "try"` |

---

### `@vera/harness` — 执行内核

多步任务所需的一切。有状态，拥有 Flow 编排权。

| 模块 | 能力 |
|---|---|
| `runtime/flow-state.ts` | Flow 状态机——11 个状态，合法转换强制，非法跳转直接抛错 |
| `runtime/runtime.ts` | `HarnessRuntime`——驱动 `Plan → Act → Critique → Replan` 闭环 |
| `runtime/planner.ts` | `planFromPrompt`——LLM → `ExecutionPlan`，含重试和 JSON 修复 |
| `runtime/critique.ts` | `critiquePlan` / `critiqueStep`——置信度 < 0.7 自动触发重规划 |
| `runtime/approval.ts` | 高风险操作门控——暂停 Flow，等待人工确认 |
| `skill/` | Skill 从 Markdown 加载，`SkillResolver`——按意图激活 |
| `agent/` | `AgentRunner` 接口 + `ExternalCLIRunner`——可插拔执行后端 |
| `evaluator.ts` | `exact` / `contains` / `tool_match` / `llm_judge` 评估，支持并发执行 |
| `cli/` | REPL Plan 执行器、`flow run` CLI、批量执行入口 |

---

### Flow 状态机

```
intaking（接收任务）
  → planning（规划）
    → dispatching（分发）
      → executing（执行中）
        → waiting_tool（等待工具）
        → waiting_approval（等待人工确认）← 审批门
        → critiquing（批判中）
          → replanning → dispatching（循环）
          → completed（完成）
          → failed（失败）
      → paused（暂停）
```

每次状态转换都经过校验。非法状态跳转直接抛错——runtime 不会漂移进不一致状态。

---

### 技术栈

| 层次 | 技术 | 版本 |
|---|---|---|
| 语言 | TypeScript（strict，ESM） | `^5.7.0` |
| 包管理 | pnpm workspace monorepo | — |
| LLM — Anthropic | `@anthropic-ai/sdk` | `^0.54.0` |
| LLM — OpenAI | `openai` | `^6.34.0` |
| LLM — Google | `@google/generative-ai` | `^0.24.1` |
| 终端 UI | React + Ink | React `^18.3.0`，Ink `^5.2.0` |
| Web UI | Vue 3 + Vite | Vue `^3.5.0`，Vite `^6.0.0` |
| 测试 | Vitest | `^4.1.4` |
| 静态分析 | oxlint + eslint-plugin-sonarjs + jscpd | — |

---

## 路线图

| 阶段 | 目标 | 状态 |
|---|---|---|
| **P0** | Harness 驱动的执行 runtime | ✅ 全部完成 |
| **P1** | 自循环与自我修正（checkpoint/resume、记忆、Critic agent、self-loop runtime） | 🔄 进行中 |
| **P2** | 自我进化（Dreaming、Proposal Pipeline、benchmark 门控 Rollout） | 📋 规划中 |
| **P3** | 通用 agent 平台（Computer Use、MCP、多 agent 协作网络、自适应策略） | 📋 规划中 |

### P0 已完成能力（完整清单）

- ✅ 意图路由（L0–L3 分级，自动模型选择）
- ✅ 工具运行时（7 个内置工具，SecurityPlugin，AnalyticsPlugin，生命周期 hook）
- ✅ 工具输出渲染（diff / code / bash / file-list / error 视图，RenderHint 系统）
- ✅ 无限上下文（渐进压缩、微压缩、反应式压缩、片段召回）
- ✅ Plan Mode（Planner、Parser、Flow 状态机、HarnessRuntime、REPL 接入）
- ✅ Critique 循环（逐步批判、置信度门控重规划、Retrospective 生成）
- ✅ Session 持久化（JSONL、成本追踪、resume、对话分支、AI 自动标题）
- ✅ Subagent 系统（general-purpose / explore / plan 内置类型，工具白名单，sidechain session）
- ✅ Subagent 隔离（try worktree、remote executor、后台模式、session resume）
- ✅ 权限系统（持久化工具规则、bash 风险门控、路径边界强制）
- ✅ 自定义 agent 定义（用户级 `~/.vera/agents/*.md`，项目级 `.vera/agents/*.md`）
- ✅ 多分支结果比较 UI（SessionPicker 分支比较面板）
- ✅ CLI 色彩主题（语义 token，对齐 Claude Code 暗色主题，`theme.ts`）
- ✅ 预提交安全扫描器（API Key 检测，credential 模式匹配）
- ✅ 项目上下文系统（`.vera/rules.md`，按路径激活 scoped rules，mtime 缓存）

---

## 快速开始

```bash
# 1. 复制配置模板
cp .vera/settings.example.json .vera/settings.json

# 2. 填入 API Key（此文件已 gitignore，永远不会提交）
#    编辑 .vera/settings.json：
#    {
#      "default_provider": "anthropic",
#      "providers": { "anthropic": { "api_key": "sk-ant-..." } },
#      "routing": { "enabled": true }
#    }

# 3. 启动 REPL
pnpm repl

# 4. 通过 CLI 运行 Flow
pnpm flow

# 5. 启动 Web UI
pnpm serve   # 后端
pnpm ui      # 前端
```

### 关键配置项

| 字段 | 说明 |
|---|---|
| `providers` | LLM 提供商配置：`anthropic` / `openai` / `gemini` / `deepseek` / `groq` / `azure` |
| `default_provider` | 未显式指定时使用的默认 provider |
| `routing` | 意图路由配置——开关、各级别模型覆盖 |
| `mcp_servers` | MCP server 定义，用于接入外部工具 |

---

## 文档导读

| 文档 | 说明 |
|---|---|
| [docs/roadmap.md](./roadmap.md) | 完整阶段路线图，已知缺陷，修复状态，P0 对齐清单 |
| [docs/architecture.md](./architecture.md) | Core 与 Harness 职责边界，依赖图 |
| [docs/harness/design.md](./harness/design.md) | Harness 设计：六条原则、角色分离、Challenger、Flow 结构 |
| [docs/core/agent-design.md](./core/agent-design.md) | Agent 能力版图：8 层模型、Hermes 精华、Dreaming、记忆系统 |
| [docs/core/subagent-design.md](./core/subagent-design.md) | Subagent 系统：Orchestrator/Worker、隔离模式、调度模式 |
| [docs/core/intent-routing.md](./core/intent-routing.md) | 意图路由：L0–L3 分级、模型路由、Plan Mode 触发条件 |
| [docs/core/infinite-context-implementation.md](./core/infinite-context-implementation.md) | 无限上下文：当前实现状态，压缩层详情 |
| [docs/core/plan-mode-implementation.md](./core/plan-mode-implementation.md) | Plan Mode：执行链路、状态机、REPL/CLI 接入 |
| [docs/eval/benchmark.md](./eval/benchmark.md) | Benchmark 体系：用例格式、评估方式、开源评测集、并发执行 |
| [docs/platform/computer-use.md](./platform/computer-use.md) | Computer Use：浏览器自动化、桌面操作（P3） |

---

## 更大的图景

我们正处于一个拐点。模型已经足够强大。瓶颈现在在于**执行框架**——让 agent 能力变得可靠、可验证、并随使用而持续复利增长的基础设施。

Vera 的架构为这个拐点而设计：

- **Harness 作为内核**，确保每一个 agent 动作都受治理，每一次状态转换都合法，每一次失败都留下可追溯的工件
- **Challenger 与 Critique**，确保质量门控是真实的，而非自我申报的
- **Proposal Pipeline**，确保改进由证据驱动，而非直觉驱动
- **完整的进化闭环**（P0 → P1 → P2），确保系统随使用而变好，而不只是随工程投入而变好

终态是一个 agent runtime：人类提供创意方向，系统可靠地、自主地、可验证地将这个方向转化为工作现实——以任何人工流程都无法企及的速度和质量。

**这就是我们加速人类创意落地的方式。这就是我们追求 SOTA AGI 的路径。**
