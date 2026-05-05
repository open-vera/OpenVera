# Vera — 加速人类创意落地，实现 SOTA AGI

---

## Vera 是什么？

Vera 是一个**以 Harness 为内核的 agent runtime**——自主规划、自主循环、自主批判、自主进化。

大多数 agent 系统只是更聪明的助手：遵循指令、调用工具。Vera 不同——它的内核不是"安全壳"，而是**驱动一切运转的引擎**。每次工具调用、每次状态流转、每次自我改进，都穿过同一套有原则的执行框架，让 agent 既强大又可控。

我们不只执行任务。我们规划 Flow、驱动自主循环、批判自身输出，并把硬得来的经验沉淀成策略——让每一次运行都比上一次更好。

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

这不是工作流，而是一个**闭合的、自驱动的循环**——每一次状态转换都受框架治理。

---

## 我们要解决的问题

### 当前 agent 系统：强大但脆弱

今天的 agent 系统看似百花齐放，但面对复杂任务时，失败的根因高度一致：

| 问题 | 后果 |
|---|---|
| **缺乏结构化执行框架** | 复杂任务逐渐漂移、遗忘目标、中途卡死 |
| **自我评估不可靠** | Agent 天然乐观，擅长解释"为什么差不多了"，不擅长发现问题。没有独立验证，质量门控形同虚设 |
| **长任务上下文崩溃** | 早期推理被遗忘，与之前决策自相矛盾——不是模型太弱，而是没有机制在管理上下文生命周期 |
| **没有学习闭环** | 每次失败被丢弃，同样的错误在不同运行、不同用户、不同版本中反复出现。能力没有复利 |
| **无法受控进化** | 改进 agent 靠编辑 prompt 然后祈祷——没有 benchmark 衡量变化，没有 Rollout 控制影响范围，没有回归测试检测退化 |

结果：演示惊艳，生产不可靠。玩具任务上光芒四射，真实任务中悄然失败。

### 根本原因

> 没有有原则的运行时内核，agent 能力只是 prompt 技巧的层层堆叠。

没有 Harness 的自规划是失控的。没有结构独立性的自我批判是噪音。没有 benchmark 闭环的自我进化是一厢情愿。

**我们需要一种不同的架构。**

---

## 核心哲学：以 Harness 为内核

Vera 的基础性洞察：

> **不要设计一个"产出更多"的 agent 系统，要设计一个"更难放过不合格产出"的执行系统。**

这从根本上倒转了常见的 agent 设计逻辑：

| 常见 agent 系统 | Vera |
|---|---|
| 模型直接调用工具 | 所有工具调用通过 Harness 调度 |
| 模型决定是否继续 | Harness 拥有 Flow State 转换权 |
| 模型自评是否完成 | Challenger 独立对每一步打分 |
| 安全 = prompt 约束 | 安全 = 架构层边界，非法跳转直接抛错 |
| 失败 = 再试一次 | 失败 = 归因 + 提案 + 回归验证后的修复 |

### Harness 的六条核心原则

1. **先定义完成，再开始执行**——每个 Flow 有明确的完成标准、交付物和失败条件。一个不知道"完成"长什么样的 agent，永远无法在正确的地方可靠停下
2. **长任务必须阶段化**——拆成可独立验证的单元，消除上下文漂移。即使会话中断、模型切换、上下文重置，任务依然连贯
3. **外部批判，而非自评**——Challenger 角色在结构上独立，不继承实现者的乐观。按预定义标准评估，产出带评分的结构化结果，并拥有否决权
4. **验证必须贴近真实**——运行代码、执行测试、与真实界面交互，而非只看输出文本
5. **每次失败必须归因**——需求理解错了？实现做错了？验证太弱了？每次失败必须给出根因，而不只是重试。没有归因，恢复只是以更高代价重复同样的错误
6. **上下文必须沉淀为工件**——可靠的上下文是结构化工件，不是聊天日志。Flow、Step 结果、Critique 报告——全部持久化。任务可以经受 agent 切换、模型更换和上下文重置

---

## 架构

Vera 是一个职责清晰的 monorepo：

```
vera/                          ← pnpm workspace monorepo
├── packages/
│   ├── @vera/core             ← 无状态 runtime 基础层
│   ├── @vera/harness          ← 有状态编排内核
│   └── @vera/benchmark        ← 评测基础设施
└── apps/
    ├── harness-ui/server      ← Web UI 后端
    └── harness-ui/web         ← Web UI 前端（Vue 3 + Vite）
```

**依赖严格单向：** `benchmark → harness → core`。Core 永不依赖 Harness，保证无状态 agent loop 可独立使用。

### `@vera/core` — Agent Loop

单次 LLM 调用所需的一切。无状态，无编排逻辑。

| 模块 | 能力 |
|---|---|
| `adapters/` | 统一 `LLMAdapter` 接口——Anthropic、OpenAI、Gemini、DeepSeek、Groq、Azure |
| `agent/` | `streamAgent` / `runAgent`——多轮循环、工具调度、重试、压缩 |
| `agent/subagent.ts` | `agent` 工具——Orchestrator/Worker 委托、隔离模式、后台任务 |
| `context/` | Token 估算、窗口裁剪、渐进/微/反应式压缩、片段召回 |
| `intent/` | `classifyIntent` / `routeTarget`——L0–L3 分级、domain 识别 |
| `tools/` | 7 个内置工具：`read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| `tools/registry.ts` | ToolRegistry——注册、执行、生命周期 hook |
| `tools/security.ts` | 路径边界强制、工具白名单、injection 防御、只读模式 |
| `tools/permission-rules.ts` | 持久化 allow/deny 规则、bash 风险确认 |
| `session/` | JSONL session 存储、成本追踪、AI 自动标题 |
| `repl/` | React + Ink 终端 UI——ConversationPanel、SessionPicker、DiffView、主题系统 |
| `memory/` | 跨轮次记忆检测 |
| `project-context/` | `.vera/rules.md` / `CLAUDE.md` 加载，路径级规则激活 |
| `worktree/` | Git worktree 创建与管理 |

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
| `evaluator.ts` | `exact` / `contains` / `tool_match` / `llm_judge` 评估，支持并发执行 |

### Flow 状态机

```
intaking（接收任务）
  → planning（规划）
    → dispatching（分发）
      → executing（执行中）
        → waiting_tool（等待工具）
        → waiting_approval（等待人工确认） ← 审批门
        → critiquing（批判中）
          → replanning → dispatching（循环）
          → completed（完成）
          → failed（失败）
      → paused（暂停）
```

每次状态转换都经过校验。非法跳转直接抛错——runtime 不会漂移进不一致状态。

### 技术栈

| 层次 | 技术 |
|---|---|
| 语言 | TypeScript（strict，ESM） |
| 包管理 | pnpm workspace monorepo |
| LLM 适配器 | Anthropic、OpenAI、Gemini、DeepSeek、Groq、Azure |
| 终端 UI | React + Ink |
| Web UI | Vue 3 + Vite |
| 测试 | Vitest |
| 静态分析 | oxlint + eslint-plugin-sonarjs + jscpd |

---

## 意图路由——合适的模型，合理的成本

```
用户输入 → [分类，~100ms，haiku/mini] → 路由决策 → [目标模型]
```

| 级别 | 描述 | 模型 |
|---|---|---|
| L0 | 闲聊、简单问答 | claude-haiku / gpt-4o-mini |
| L1 | 单步任务 | claude-haiku / gpt-4o-mini |
| L2 | 多步任务 | claude-sonnet / gpt-4o |
| L3 | 复杂规划、深度推理 | claude-opus / o3 |

L3 自动激活 Plan Mode。目标：L0/L1 路由准确率 > 95%，整体成本降低 > 60%。

---

## Vera 与众不同的地方

### 1. 认知职责分离——最重要的工程原则

```
Planner      读取上下文 → 生成 ExecutionPlan → 按任务复杂度自适应
Role Agent   按准出标准执行步骤 → 产出具体交付物
Challenger   独立对每步产出打分 → 积累 lessons → 每次运行攻击更精准
Orchestrator 调度 agent → 管理 context reset → 执行审批门
```

**核心约束：** Role Agent 永远无权判定自己的工作"已完成"。这个权力专属于 Challenger。

这种分离从根本上防止了 agent 系统中最常见的失效模式：同一个 agent 同时扮演实现者、评估者和裁判三重角色。

### 2. Harness 是内核，不是约束层

其他系统把安全检查附加在外部。Vera 倒转了这个逻辑：Harness 驱动每一个动作，agent 是运行在其上的策略体。

- Agent 无法越权——靠架构设计，不靠 prompt 约束
- Flow 状态转换有校验——非法跳转会抛错
- Critique 在结构上独立——同一 agent 不能既是实现者又是裁判

### 3. 无限上下文，不降质

Vera 的三层上下文系统处理任意长度的任务：

| 层次 | 机制 | 触发时机 |
|---|---|---|
| 滑动窗口裁剪 | 丢弃最早轮次，保留任务定义锚点 | Token 超过阈值 80% |
| 渐进压缩 | 轻量模型摘要旧轮次，注入 system 上下文 | 超过 token 阈值 |
| 微压缩 | 基于时间间隙启发式清理过期工具结果，无 LLM 调用 | 时间间隙触发 |
| 反应式压缩 | 遇到 `prompt-too-long` 错误时激进压缩并重试，含熔断器 | API 错误响应 |

**第一条消息（原始任务定义）始终保留。** Agent 永远不会丢失自己的目标。

### 4. Subagent 的真实隔离

`agent` 工具支持三种隔离模式：

| 模式 | 机制 | 适用场景 |
|---|---|---|
| `none` | 共享上下文（默认） | 标准委托 |
| `try` | 独立 git worktree，变更可通过 `/merge` 审查后合并 | 实验性代码修改 |
| `remote` | 可插拔外部执行后端 | 分布式或沙箱执行 |

Subagent 继承父 agent 的 Harness 约束，无法提权。结果携带 transcript ID，支持完整审计。

### 5. Challenger 会学习——攻击随时间越来越精准

每次运行后，Challenger 把发现的失效模式追加到 `.flow/challenger/lessons/{step}.md`。下次运行时它读取这些 lessons 并以此为攻击角度。随着时间推移，系统越来越难被蒙混过关——不是因为模型变强了，而是因为框架积累了关于这个特定代码库或工作流容易在哪里失败的机构性知识。

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

## 路线图

| 阶段 | 目标 | 状态 |
|---|---|---|
| **P0** | Harness 驱动的执行 runtime | ✅ 全部完成 |
| **P1** | 自循环与自我修正（checkpoint/resume、记忆、Critic agent、self-loop runtime） | 🔄 进行中 |
| **P2** | 自我进化（Dreaming、Proposal Pipeline、benchmark 门控 Rollout） | 📋 规划中 |
| **P3** | 通用 agent 平台（Computer Use、MCP、多 agent 协作网络、自适应策略） | 📋 规划中 |

### P0 已完成能力

- ✅ 意图路由（L0–L3 分级，自动模型选择）
- ✅ 工具运行时（7 个内置工具，SecurityPlugin，生命周期 hook）
- ✅ 工具输出渲染（diff / code / bash / file-list / error 视图）
- ✅ 无限上下文（渐进压缩、微压缩、反应式压缩、片段召回）
- ✅ Plan Mode（Planner、Parser、Flow 状态机、HarnessRuntime、REPL 接入）
- ✅ Critique 循环（逐步批判、置信度门控重规划、Retrospective）
- ✅ Session 持久化（JSONL、成本追踪、resume、对话分支、AI 自动标题）
- ✅ Subagent 系统（general-purpose / explore / plan、工具白名单、sidechain session）
- ✅ Subagent 隔离（try worktree、remote executor、后台模式、session resume）
- ✅ 权限系统（持久化工具规则、bash 风险门控、路径边界强制）
- ✅ 自定义 agent 定义（`~/.vera/agents/*.md`、`.vera/agents/*.md`）
- ✅ 多分支结果比较 UI
- ✅ CLI 色彩主题（语义 token，对齐 Claude Code 暗色主题）
- ✅ 预提交安全扫描器（API Key 检测、credential 模式匹配）
- ✅ 项目上下文系统（`.vera/rules.md`，路径级规则激活）

---

## 快速开始

```bash
# 复制配置模板
cp .vera/settings.example.json .vera/settings.json

# 填入 API Key（此文件已 gitignore，永远不会提交）
# 编辑 .vera/settings.json：
# {
#   "default_provider": "anthropic",
#   "providers": { "anthropic": { "api_key": "***" } },
#   "routing": { "enabled": true }
# }

# 启动 REPL
pnpm repl

# 通过 CLI 运行 Flow
pnpm flow

# 启动 Web UI
pnpm serve   # 后端
pnpm ui      # 前端
```

### 关键配置项

| 字段 | 说明 |
|---|---|
| `providers` | LLM 提供商配置：anthropic / openai / gemini / deepseek / groq / azure |
| `default_provider` | 未显式指定时使用的默认 provider |
| `routing` | 意图路由配置——开关、各级别模型覆盖 |
| `mcp_servers` | MCP server 定义，用于接入外部工具 |

---

## 文档导读

| 文档 | 说明 |
|---|---|
| [docs/roadmap.md](./docs/roadmap.md) | 完整阶段路线图、已知缺陷、修复状态 |
| [docs/architecture.md](./docs/architecture.md) | Core 与 Harness 职责边界和依赖图 |
| [docs/harness/design.md](./docs/harness/design.md) | Harness 设计：六条原则、角色分离、Challenger、Flow 结构 |
| [docs/core/agent-design.md](./docs/core/agent-design.md) | Agent 能力版图：8 层模型、无限上下文、记忆、Dreaming |
| [docs/core/subagent-design.md](./docs/core/subagent-design.md) | Subagent 系统：Orchestrator/Worker、隔离模式、调度模式 |
| [docs/core/intent-routing.md](./docs/core/intent-routing.md) | 意图路由：L0–L3 分级、模型选择、Plan Mode 触发 |
| [docs/core/infinite-context-implementation.md](./docs/core/infinite-context-implementation.md) | 无限上下文：实现状态、压缩层详情 |
| [docs/core/plan-mode-implementation.md](./docs/core/plan-mode-implementation.md) | Plan Mode：执行链路、状态机、REPL/CLI 接入 |
| [docs/eval/benchmark.md](./docs/eval/benchmark.md) | Benchmark 体系：用例格式、评估方式、开源评测集 |

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


## Star History

<a href="https://www.star-history.com/?repos=open-vera%2FOpenVera&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&legend=bottom-right" />
 </picture>
</a>
