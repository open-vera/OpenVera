# Vera — Roadmap

## 指挥纲领

这份 roadmap 不是普通功能清单，而是 Vera 的阶段性作战纲领。目标不是追赶已有 agent，而是做出一个**以 Harness 为内核、可自规划、自循环、自我批判、自我进化的 agent runtime**。

我们对 Vera 的目标定义是：

> 不只会执行任务，而且能在 Harness 约束下自己规划 flow、自己推进循环、自己批判结果、自己积累经验并推动系统进化。

术语约定：

- `Flow`：任务运行实例
- `Plan`：结构化执行方案
- `Step`：Plan 的最小执行单元
- `Critique`：结构化结果批判
- `Proposal`：策略提案
- `Rollout`：Proposal 生效前的小范围验证

具体定义以 [harness.md](./harness/design.md#2-统一术语) 为准。

因此路线图必须围绕 6 类核心能力推进：

| 核心能力 | 要回答的问题 |
|---|---|
| **执行能力** | agent 能不能真正完成文件、命令、检索、编辑任务 |
| **Flow 能力** | agent 能不能自己规划、推进、暂停、恢复任务流 |
| **记忆能力** | agent 能不能跨轮次、跨任务连续工作 |
| **Harness 能力** | agent 会不会越权、误执行、被注入，能否被 runtime 精确约束 |
| **运行能力** | agent 失败后能不能恢复、追踪、回放 |
| **进化能力** | agent 是否具备 Critique、benchmark、dreaming 和 Proposal 闭环 |

### Vera 的核心判断

我们不把 Harness 当作“安全壳”，而是当作**系统内核**。

也就是说：

- agent 不是直接碰工具，而是通过 harness 调度工具
- agent 不是直接决定是否继续，而是通过 harness 管理 Flow State
- agent 不是直接改自己，而是通过 harness 管理 Critique、Proposal、Rollout 和验证

没有这层内核设计，所谓自规划、自循环、自我进化都会变成不可控的 prompt 技巧，而不是工程系统能力。

---

## 阶段路线图

### P0 — 先做成”Harness 驱动的 agent runtime”

P0 的目标不是做一个会调工具的 assistant，而是建立最小可用自循环：`理解任务 → 建立 Flow → 调工具执行 → Critique → 在边界内继续或结束`

**1. 意图识别与模型路由** ✅ → 详见 [intent-routing.md](./core/intent-routing.md)
- 复杂度分级：L0 / L1 / L2 / L3
- `needs_tools` / `needs_planning` 判定
- 按任务复杂度自动选模型
- 为 Plan Mode 提供触发依据

**2. Tool Runtime 基础版** ✅ → 详见 [tool-runtime.md](./core/tool-runtime.md)
- ToolDef / ToolResult / ToolContext / ToolLifecycleHook 类型定义 ✅
- ToolRegistry：按名注册、查找、执行、hook 调度 ✅
- 内置 tool：`read_file`、`write_file`、`edit_file`、`list_dir`、`glob`、`bash`、`grep` ✅
- 工具标准返回格式：`ok/content/error/metadata/renderHint` ✅
- timeout、路径净化、输出截断、二进制检测 ✅

**3. Tool 生命周期 Hook 系统** ✅ → 详见 [tool-runtime.md](./core/tool-runtime.md)
- SecurityPlugin：路径越界 + 工具白名单 + 预算 + 只读模式 + injection 防御 ✅
- AnalyticsPlugin：session JSONL 写入 ✅
- `onBeforeToolCall` / `onAfterToolCall` hook 调度（Tier 3，ToolRegistry 插件层）✅
- `AgentHooks`（`packages/core/src/agent/loop.ts`）：分级 hook 体系，已接入两个主循环 ✅
  - Tier 1：`onTurnStart` / `onTurnEnd` / `onSessionEnd`（turn/session 生命周期）
  - Tier 2：`onCompression` / `onRetry`（压缩事件 + reactive retry 可观测性）

**4. Tool 输出渲染** ✅ → 详见 [tool-rendering.md](./core/tool-rendering.md)
- RenderHint 类型系统：`diff / code / bash-output / file-list / image / error / text` ✅
- ToolResultView 统一分发入口 ✅
- DiffView、CodeView、BashOutputView、FileListView、ErrorView、TextView ✅
- ConversationPanel 集成 toolUses 渲染 ✅

**5. Session 持久化与 Cost Tracking** ✅
- JSONL session 存储（append-only，崩溃安全）✅
- 完整 entry 链路：`session_start / user / assistant / tool_call / tool_result / session_end` ✅
- resume 支持：`/resume <prefix>` 恢复历史上下文 ✅
- cost 统计：按模型计费，累计汇总，`/status` 展示 ✅
- `/sessions` 列出历史会话，含 turn / cost / model ✅

**6. 无限上下文** ✅ → 详见 [infinite-context-implementation.md](./core/infinite-context-implementation.md)
- 渐进压缩（compressMessages）：token 超阈值自动摘要旧轮次 ✅
- 微压缩（microCompact）：时间间隙超阈值清理旧工具结果，纯启发式无 LLM 调用 ✅
- 反应式压缩（reactive compact）：prompt-too-long 错误时激进压缩重试，含熔断器 ✅
- 召回（findRelevantSegments / expandSegment）：搜索和还原已压缩片段 ✅
- 集成到 runAgent 和 streamAgent 两个主循环 ✅

**7. Plan Mode 基础版** ✅
- **AgentRunner 接口**（`packages/harness/src/agent/types.ts`）：`AgentRunner` + `StreamAgentRunner` ✅
- **ExecutionPlan 数据结构** + **Flow State Machine**（`packages/harness/src/runtime/`）✅
  - `FlowStatus: intaking → planning → dispatching → executing → critiquing → completed/failed`
- **Plan 解析器**（`harness/runtime/plan-parser.ts`）：JSON fence 或编号列表，失败降级单步 ✅
- **HarnessRuntime + runFlowLoop**（`harness/runtime/runtime.ts`）：Plan→Act→Critique→Replan 闭环 ✅
- **REPL 接入**（`harness/cli/repl-plan-executor.ts`）：`createHarnessPlanExecutor`，intent `needs_planning: true` 时触发 ✅

**8. Critique 基础版** ✅
- **Critique 数据结构**（`packages/core/src/types/runtime.ts`）
  - `CritiqueResult: { issues: string[], confidence: number (0-1), nextAction: "complete"|"replan"|"retry"|"ask_human" }`
- **CritiqueRunner**（`packages/harness/src/runtime/critique.ts`）
  - `critiquePlan` / `critiqueStep`：LLM 批判 Plan 或单个 Step 结果
  - `replanWithCritique`：根据 Critique 结果重新生成 Plan
  - `generateRetrospective`：从 Critique 中提取经验教训
  - `diffPlans` / `mergePlans`：对比和合并新旧 Plan
- `HarnessRuntime.runFlowLoop` 已串联：每步执行后自动 critiqueStep → confidence < 0.7 时 replan

**9. Harness Flow 控制** ✅
- **HarnessRuntime**（`packages/harness/src/runtime/runtime.ts`）：持有 ExecutionPlan，驱动 Plan → Act → Critique 闭环
- **Flow State 机器**（`packages/harness/src/runtime/flow-state.ts`）：
  - `intaking → planning → dispatching → executing → critiquing → (replanning → dispatching | completed)`
  - `waiting_approval` / `paused` 等待状态，`completed` / `failed` 终态
  - 所有状态转换有合法性校验，非法跳转抛错
- **高风险审批门**：`approval.ts` 中 `shouldPauseForApproval` / `createApprovalRecord`，高风险工具可暂停等确认
- SecurityPlugin 做参数级静态检查；FlowController 做流程级动态审批（两层各司其职）

**P0 验收标准**

- 给定一个中等复杂代码任务，agent 可以稳定完成 read → analyze → edit → test 闭环
- 执行完成后会主动做一次 Critique，并根据 Critique 决定是否进入下一轮
- 遇到超出目录、域名、预算的操作会停止并解释原因
- 每次运行都能留下可回放 trace

---

## 已知缺陷与技术债

> P0 全部实现完毕，但 2026-04-28 架构诊断发现若干已实现路径存在运行时缺陷或薄弱点，需在 P1 开工前修复。

### 🔴 Critical — 立即修复

**C1. Micro-compact 时间戳 bug（P0.6 无限上下文实际不工作）**

`compression.ts` 中 `lastAssistantTs = Date.now()` 在**每次调用**时重置，导致时间差永远趋近 0，基于时间间隙的清理条件永远不触发。微压缩功能已实现但运行时失效。

**C2. Tool 调用参数 `JSON.parse` 裸调用（`loop.ts`）**

```ts
const args = JSON.parse(tc.arguments)  // 无 try/catch
```

LLM 返回 malformed JSON → 整个 agent loop crash。LLM 输出是系统边界，必须防守。

**C3. Empty-after-tool-result 只有 1 次 retry**

`emptyAfterToolRetries < 1` 判断导致第二次空响应时静默 break loop 并返回空字符串，调用侧无任何通知。

**C4. Streaming 无错误恢复**

三个 adapter 的流式迭代无 try/catch，流中断直接 throw，无内置 retry，生产环境网络抖动必现。

**C5. Harness Step 依赖无环检测**

`dependsOn` 只做存在性校验，无拓扑排序，无循环依赖检测。Step A 依赖 B、B 依赖 A 可触发无限 dispatch 循环。

---

### 🟠 High — P1 开工前完成

**H1. 测试覆盖：~8.5%，核心路径全无保障**

| 未覆盖模块 | 风险 |
|---|---|
| Adapters（Anthropic / OpenAI / Gemini） | 接口变更无感知 |
| 内置 Tools（bash / read / write / edit） | 工具行为未验证 |
| Tool Registry / Executor | hook 调度正确性未验证 |
| Harness dispatch / replan 循环 | 状态机核心路径零测试 |
| Memory tracking | 功能存在但完全无测试 |
| Skill resolver | intent 路由最终落点未测试 |

**H2. Compression 状态变更非原子**

压缩 LLM 调用失败时异常已 catch，但 `messages` 可能已部分变更，下一轮使用被污染的 state，静默失败。

**H3. Gemini streaming 无 usage 上报**

`stream()` 返回 `{ type: “done”, usage: undefined }`，cost tracking 和 token budget 计算对 Gemini 完全失效。

**H4. Critique 无内部 retry 闭环**

Critique 结果返回外部调用方，由调用方决定是否 replan；Harness 不自我修正。Critique JSON 解析失败亦静默。

**H5. 审批流程（`waiting_approval`）不完整**

`shouldPauseForApproval` 返回 bool，但 flow state 未明确进入 `waiting_approval`，human-in-the-loop 路径存在竞态，未覆盖测试。

**H6. Step 级别无超时与预算强制**

`TaskScope` 有 `deadlineMs` / `budgetTokens`，但均未在 step 执行中检查，单个 step 可消耗整个 flow 的预算。

---

### 修复计划

| 编号 | 状态 | 改动点 |
|---|---|---|
| C1 | ✅ 已修 | `compression.ts`：移除扫描历史消息时的 `Date.now()` 调用；`loop.ts`：assistant 响应后即更新 `lastAssistantTs` |
| C2 | ✅ 已修 | `loop.ts`：`JSON.parse(tc.arguments)` 加 try/catch，malformed 时返回工具错误消息而非 crash |
| C3 | ✅ 已修 | `loop.ts`：引入 `MAX_EMPTY_AFTER_TOOL_RETRIES = 3`，替换原来硬编码的 `< 1` 判断 |
| C4 | ✅ 已修 | `adapters/anthropic.ts` / `openai.ts` / `gemini.ts`：stream 迭代加 try/catch 确保错误干净传播（SDK 层已有内置 retry） |
| C5 | ✅ 已修 | `harness/runtime/runtime.ts`：新增 `detectDependencyCycle` DFS 函数，`dispatchStep` 入口调用，发现环立即抛错 |
| H1 | ✅ 已修 | 新增核心路径测试（164 通过）：token 估算、window trimming、ToolRegistry、bashTool、loop 防御行为（C2/C3/M4） |
| H2 | ✅ 已验 | 代码复查确认 `compressMessages` 已在副本上操作（`slice` + spread），LLM 失败时返回原始对象，无需额外改动 |
| H3 | ✅ 已修 | `adapters/gemini.ts`：流结束后 `await result.response` 提取 `usageMetadata`，填入 `done` 事件 |
| H4 | ✅ 已修 | `runtime/json.ts`：`completeJson` 加 markdown fence 剥离 + JSON 提取 + 最多 2 次修正 retry |
| H5 | ✅ 已修 | `runtime/runtime.ts`：`dispatchStep` 和 `runAgentAssignment` 改用 `updateFlowState`，转换经状态机合法性校验 |
| H6 | ✅ 已修 | `agent/stream-runner.ts`：`deadlineMs > 0` 时用 `Promise.race` 强制超时，超时抛含 stepId 的 Error |
| M6 | ✅ 已修 | `runtime/planner.ts`：`planId` 降级时改用 `crypto.randomUUID()` 替代 `Date.now()` |

### 🟡 Medium — 技术债，计划改进

| 编号 | 状态 | 问题 | 影响 |
|---|---|---|---|
| M1 | ✅ 已修 | Token 估算粗糙（±10%，不计 role/tool_call 结构 overhead） | 压缩触发阈值不可靠 |
| M2 | ✅ 已修 | Window trimming 无信号感知，丢失首条用户消息（原始任务定义） | 压缩后 agent 失去任务定义锚点 |
| M3 | ✅ 已修 | Tool 结果在执行**后**才裁剪，大输出工具资源浪费 | bash 流式收集 + 512KB 阈值提前 kill 进程组 |
| M4 | ✅ 已修 | 压缩本身的 LLM 调用成本未计入 cost tracking | 高频压缩场景成本失控 |
| M5 | ✅ 已验 | AgentRunner 接口当前只有一个实现（过早抽象） | 已有 `external-cli-runner.ts`，多实现并存，抽象合理 |
| M6 | ✅ 已修 | `planId: \`plan-${Date.now()}\`` 同毫秒可碰撞 | 测试并发场景下会失效 |

**M1 修复**：`tokens.ts` 引入 role-specific overhead（user/assistant: 5，tool: 10）+ `TOOL_CALL_STRUCT_OVERHEAD = 12` + `DEFAULT_IMAGE_TOKENS = 1_000`，替换原来的平均 4 token/message。

**M2 修复**：`window.ts` `trimToWindow` 始终保留 `messages[0]`（原始任务定义），从第 2 条消息起才做丢弃。

**M4 修复**：`compression.ts` 返回类型追加 `usage?: Usage`，捕获压缩 LLM 响应的 usage；`loop.ts` 两个主循环在压缩后立即调用 `onUsage(compressed.usage)`。

---

### P1 — 补齐”自循环和自我修正”的能力

P1 的目标是让 Vera 从受控执行器，升级为能自己推进复杂 Flow 的 agent。

**1. Checkpoint / Resume**
- 在关键 Plan Step 后保存状态
- 进程中断后可恢复
- 支持从 Checkpoint Replay / Fork

**2. Memory 系统** → 详见 [agent-design.md](./core/agent-design.md#2-记忆系统memory-system)
- Working Memory：当前消息历史
- Episodic Memory：任务级结构化摘要
- Semantic Memory：长期知识与偏好
- `memory_write` / `memory_search` tool

**3. AgentRunner 接口**（随 Plan Mode 一起实现，在 P0.7 中完成）
- `packages/core/src/types/agent.ts` 定义接口
- `packages/core/src/agent/loop.ts` 导出默认实现（wrap `streamAgent`）
- Harness `PlanRunner` 通过接口调用，不直接依赖 `streamAgent`

**4. Tool Runtime 增强**
- 幂等控制
- 可重试错误分类
- dry-run / simulate 能力
- shell 输出截断与摘要

**5. Subagent 系统** → 详见 [subagent-design.md](./core/subagent-design.md)
- Orchestrator / Worker 模式
- 并行扇出、串行流水线
- 共享上下文层（key-value 按需同步）
- 权限继承与 usage 汇总
- 递归 subagent（maxDepth 限制）

**6. 语音输入** → 详见 [voice-input.md](./core/voice-input.md)
- 按住录音、释放提交的 push-to-talk 模式
- 音频采集：cpal native / arecord / SoX rec 多平台后端
- STT：WebSocket 流式语音识别（Deepgram Nova 3）
- 焦点模式：持续转录（terminal focus 场景）
- 限制：仅支持 Anthropic OAuth，远程环境禁用

**7. Self-Loop Runtime**（`packages/harness/src/flow/loop.ts`）
- `SelfLoopRunner`：在无用户输入的情况下驱动 `Plan → Act → Critique → Replan → Act` 循环
- 循环终止条件（任意一个触发即停）：
  - `CritiqueResult.next_action === "stop"`
  - `CritiqueResult.confidence >= 0.9`（认为已完成）
  - 达到 `maxCycles`（默认 5）
  - 累计费用超过 `budgetUsd`
  - 连续两次 Critique 结论相同（检测到死循环）
- Replan 时：把上一轮 Critique issues 追加进 prompt，重新生成 Plan
- 每个 cycle 写一条 `cycle_end` JSONL entry（含 critique 摘要、是否 replan）
- 人工接管点：`waitingApproval` 状态下挂起，收到确认信号后继续

**8. Critic Agent**
- 独立 critic agent 对执行结果做 Critique
- 发现 Plan 偏差、遗漏测试、风险点
- 支持主 agent 与 critic agent 的有限轮辩论

**9. Prompt 管理**
- System prompt 模板化
- 不同任务域的 prompt profile
- prompt 版本管理与 A/B 对比

**10. 失败恢复与归因**
- 失败任务自动记录 root cause
- 常见失败模式分类：模型、工具、权限、上下文、计划偏差
- 支持选定失败 case 的自动回放

### P0 后对齐项（当前进行中）

详见 [capability-gaps.md](./core/capability-gaps.md)。

- 状态基线（2026-04-28）详见：[p0-alignment-checklist.md](./core/p0-alignment-checklist.md)
- 权限与授权体验：✅ 已完成（持久化工具规则、bash 风险确认、命令 allow/deny pattern）
- 项目上下文：✅ 已完成（规则优先级、mtime 缓存、按路径激活 scoped rules）
- UI 展示：✅ 已完成（read/search/list grouped collapsed summary，子 agent summary + transcript）
- 子 agent（Claude Code 对齐）：
  - ✅ 已实现：`agent` tool 入参对齐 `description` / `prompt` / `subagent_type`
  - ✅ 已实现：内置 `general-purpose` / `explore` / `plan`，支持工具策略、sidechain session 和 summary 回传
  - ✅ 已实现：自定义 agent definitions，从 `~/.vera/agents/*.md` 与 `<project>/.vera/agents/*.md` 加载
  - ✅ 已实现：frontmatter 支持 `name` / `description` / `tools` / `disallowedTools` / `permissionMode` / `maxTurns`
  - ✅ 已实现：项目级 agent 覆盖用户级 agent，动态更新 `subagent_type` enum
  - ✅ 已实现：`/sub <id-prefix>` 通过 transcript id 查看子 agent sidechain transcript（`/transcript` 保留为兼容别名）
  - ✅ 已实现：`agent` tool 支持 `isolation: "try"`，子 agent 在独立 git worktree 中执行工具调用
  - ✅ 已实现：try-isolated 子 agent sidechain session 记录 `worktreePath` / `worktreeBranch` / `baseCommit`，可通过 `/merge <id-prefix>` 采纳
  - 说明：`/sub` 只查看子 agent 的 sidechain 记录；`/try` 会创建隔离 git worktree 并切换 REPL 到该工作区，`agent isolation: "try"` 则让子 agent 在隔离工作区内实验
  - ✅ 已实现：后台子 agent（`run_mode: "background"` + `/subjobs` 状态查询）
  - ✅ 已实现：resume subagent（`resume_session_id` / `resumeSessionId`）
  - ✅ 已实现：remote isolation（`isolation: "remote"`，支持 `remoteExecutor` 注入、external runner 和 local fallback）
  - 远程 runner 配置：
    - `VERA_SUBAGENT_REMOTE_RUNNER`：执行程序
    - `VERA_SUBAGENT_REMOTE_RUNNER_ARGS`：JSON 数组参数（可选）
    - stdin 输入任务 JSON，stdout 输出 result JSON（`content`、可选 `transcriptId`/`toolCalls`/`location`）
- Session UX（Claude Code 对齐）：
  - ✅ 已实现：session 列表按项目/worktree 扫描，支持 `--all`、`--limit`、`--offset`
  - ✅ 已实现：轻量 head/tail metadata 读取，过滤 metadata-only session
  - ✅ 已实现：`custom-title` / `ai-title` / `last-prompt` / `summary` / `tag` / `git-branch` / `pr-link` JSONL metadata
  - ✅ 已实现：summary 优先级 `customTitle > aiTitle > lastPrompt > summary > firstPrompt`
  - ✅ 已实现：自动生成 `aiTitle`、SessionPicker 搜索、分页加载、preview、恢复提示
  - ✅ 已实现：`/branch` / `/branches` / `/switch` / `/adopt` / `/drop` conversation branch 生命周期
  - ✅ 已实现：`/try [name]` 创建隔离 git worktree，并切换 REPL 的 cwd / ToolRegistry / SecurityPlugin
  - ✅ 已实现：branch metadata 记录 `worktreePath` / `worktreeBranch` / `baseCommit`，支持 `active` / `adopted` / `merged` / `discarded`
  - ✅ 已实现：`/merge [--check] [--drop] [id-prefix]` 将 try worktree diff 安全应用回原工作区，不自动提交
  - ✅ 已实现：`/merge` dirty target 检查、重复 merge 保护、clean worktree drop 清理、真实 git repo 单测覆盖
  - ✅ 已实现：SessionPreview 复用 `ConversationPanel` 完整渲染 transcript，支持滚动与工具输出展开
  - ✅ 已实现：恢复后把最近 N 条 transcript 注入可见消息列表，避免 UI history 与模型 history 分离
  - ✅ 已实现：resume / switch try branch 时校验 worktree 是否存在；缺失时回退原 cwd 并提示
  - ✅ 已实现：AI title 失败最多补试一次，首轮 assistant 为空时用工具摘要 fallback，并支持配置开关/标题模型
  - ✅ 已实现：搜索触发 debounce + 分批可取消的分页扫描，支持文本高亮和 `branch:` / `tag:` / `cost>` / `cost<` / `after:` / `before:` 过滤
  - ✅ 已实现：字段级 JSONL extractor、session_end 数字字段 fallback、canonical path/worktree fallback，提高大文件、截断行和 symlink 兼容性
  - ✅ 已实现：子 agent worktree isolation 与 `/merge` branch 生命周期打通
  - ✅ 已实现：子 agent remote isolation（结果输出包含 `Isolation: remote:<location>`）
  - ✅ 已实现：多分支结果比较 UI（SessionPicker 分支比较面板，`b` 键开关）
- 可靠性：✅ 已完成（session 隔离测试已覆盖；权限/上下文/UI/子 agent 组合 smoke + REPL loop smoke 已统一到 `test:smoke:suite` 入口）
- CLI 色彩主题：
  - ✅ 已实现：`repl/ui/theme.ts` — 统一语义 token（brand / success / error / warning / suggestion / diff 系列）
  - ✅ 已实现：所有 UI 组件（StatusBar、ConversationPanel、DiffView、ToolResultView、InputBar、WelcomeScreen、App 等）改用 `theme.*`，不再散落 inline 颜色字面量
  - ✅ 已实现：配色基准来自 Claude Code dark 主题，truecolor `rgb(r,g,b)` 替代 ANSI 名称
- 开发工具：
  - ✅ 已实现：`.hooks/pre-commit` 预提交密钥扫描器，检测 API Key 格式、credential 关键词
  - ✅ 已实现：公司内部标识符（敏感词）通过 `git config hooks.companyPatterns` 本地注入，扫描脚本不硬编码，不进 git 历史

**P1 验收标准**

- 长任务中断后可继续，不需要从头再跑
- 多个 worker 可并发完成非冲突子任务
- 一个复杂任务可在受控预算内自主运行多个 Critique/Replan 循环
- 同一类失败可以被归档、检索和复现

### P2 — 建立“自我进化”闭环

P2 的目标不是“多做点测试”，而是让 Vera 具备真正的受控进化机制。任何架构、prompt、tool policy 调整，都必须能量化验证，并通过 harness 管理 Rollout。

**1. 智能自动化测试** → 详见 [intelligent-testing.md](./platform/intelligent-testing.md)
- 用 AI agent 驱动对其他软件的 UI 测试
- 多策略元素定位：accessibility_id → xpath → css → text → visual fallback
- 截图验证 + 视觉模型语义断言
- 自愈测试：定位失败自动切换策略
- 自然语言描述测试意图，agent 自动拆解步骤

**2. Benchmark Harness**
- case 加载、agent 执行、结果评估、报告生成
- 支持 exact / contains / tool_match / llm_judge
- 并发执行、吞吐控制、失败重跑

**3. 智能测试（AI-generated cases）**
- 自动生成 edge case
- 语义变异测试
- 失败案例聚类与归因

**4. Dreaming 系统** → 详见 [agent-design.md](./core/agent-design.md#3-梦境系统dreaming)
- 聚合 episodic memory 和 benchmark failure
- 提炼高价值知识
- 产出 prompt / tool policy 改进建议

**5. Proposal Pipeline**
- Critique / dreaming 生成 Proposal
- Proposal 进入人工审核
- 审核通过后小流量 Rollout
- Rollout 结果回写 benchmark 和策略库

**6. 线上反馈闭环**
- 线上真实任务失败进入 benchmark 池
- 人工确认后的高价值 case 固化为回归用例

**P2 验收标准**

- 每次 agent loop / prompt / tool 策略变更都能触发回归评测
- 能看见 pass rate、tool accuracy、flaky rate 的趋势
- Dreaming 的产出能被 benchmark 验证是否有效
- Critique / Proposal / Rollout 有完整可审计链路

### P3 — 向通用 agent 平台扩展

P3 的目标不是立刻做，而是在 P0-P2 稳定后向更宽环境扩展。

**1. Computer Use** → 详见 [computer-use.md](./platform/computer-use.md)
- 浏览器自动化（Playwright / CDP）
- 桌面客户端操作（截图 + 鼠标键盘）
- 作为 tool 接入 loop

**2. MCP 支持**
- 作为 MCP client 接入第三方工具服务器
- 对 MCP tool 做统一 schema 和权限治理

**3. 多 agent 协作网络**
- 跨 agent 消息总线
- 任务调度与资源隔离
- 共享记忆与权限继承

**4. 自适应策略系统**
- 根据任务域选择 prompt / model / tool policy
- 基于历史成功率自动调优默认策略

---

## 建议执行顺序

```
[已完成] Intent Routing ✅
[已完成] Session 持久化 + Cost Tracking ✅
[已完成] Tool Runtime 基础版 ✅
         └── types / registry / executor / security / analytics / 7 内置工具 / index

[已完成] Tool 输出渲染 ✅
         ├── repl/ui/ToolResultView.tsx（统一分发入口）
         ├── renderers/ErrorView, TextView, CodeView, DiffView, BashOutputView, FileListView
         └── ConversationPanel 集成 toolUses 渲染

         → P0 工具链完整，工具结果可视化

[已完成] Plan Mode 基础版（P0.7）✅
         ├── harness/runtime/planner.ts ✅（planFromPrompt，LLM → ExecutionPlan）
         ├── harness/runtime/plan-parser.ts ✅（parseExecutionPlan，LLM 文本 → ExecutionPlan）
         ├── harness/runtime/flow-state.ts ✅（Flow State Machine，合法转换校验）
         ├── harness/runtime/runtime.ts ✅（HarnessRuntime + runFlowLoop + planAndStart）
         ├── harness/runtime/critique.ts ✅（critiquePlan / critiqueStep / replan）
         ├── harness/runtime/flow.ts ✅（createTaskFlow / updateFlowState）
         ├── harness/runtime/approval.ts ✅（审批门）
         ├── harness/agent/ ✅（AgentRunner 接口 + StreamAgentRunner）
         └── harness/cli/repl-plan-executor.ts ✅（REPL 接入：planFromPrompt + critique + state machine）

         → Plan→Act→Critique→Replan 闭环完成，REPL 已接入

[已完成] AgentHooks 分级 hook 体系 ✅
         ├── core/agent/loop.ts — AgentHooks 接口（Tier 1 + Tier 2）
         ├── Tier 1：onTurnStart / onTurnEnd / onSessionEnd（try/finally 保证触发）
         └── Tier 2：onCompression（progressive/micro/reactive）/ onRetry

[P1]     Self-Loop Runtime
         └── harness/flow/loop.ts（SelfLoopRunner，Plan→Act→Critique→Replan 自循环）

         Checkpoint / Resume（Plan Step 级别）
         Memory 系统
         Subagent 系统

[P2] Benchmark Harness → Dreaming → Proposal Pipeline

[P3] Computer Use / MCP
```

执行原则：

1. 先做 harness 内核，再做 agent 智能。没有内核，自循环和自进化只会失控。
2. 先做 runtime，再做更复杂的策略体。没有稳定执行层，记忆和 dreaming 都会变成空中楼阁。
3. 先做 Critique 和 benchmark，再做大规模优化。没有批判和评测，进化不可证伪。

---

## 架构备忘

记录关键架构决策，防止后续开发中重复踩坑。

### Core / Harness 边界

**Core** = 单次 LLM 调用的最小闭环：adapter → stream → tool call schema → ToolResult。  
**Harness** = 多步 workflow：ExecutionPlan 状态机、Flow State、Critique 循环、Checkpoint。

依赖方向：`harness → core`，Core 不感知 Harness 存在。

| 关注点 | 归属 |
|---|---|
| LLM adapter / streaming | Core |
| Tool schema + ToolResult 类型 | Core |
| ToolLifecycleHook 接口 | Core |
| ToolRegistry + 内置工具实现 | Core |
| HarnessPlugin（路径/预算/injection） | Core（作为 hook 注册，由 Harness 配置） |
| ExecutionPlan / Step / Flow State | Harness |
| Critique / Proposal / Rollout | Harness |
| Checkpoint / Resume（Plan 级别） | Harness |
| Session JSONL 持久化 | Core（供 Harness 读写） |

### 两个 Plan 的区分

容易混淆：LLM 说"我来制定一个 plan"，Harness 里也有 `ExecutionPlan`。

- **Agent Plan**（LLM 输出文本）：模型在 assistant 消息里描述的文字计划，非结构化，仅供用户阅读。
- **Harness ExecutionPlan**（运行时数据结构）：Harness 根据 Agent Plan 构建的状态机，有 `Step[]`、`currentStepIndex`、`status` 等字段，控制实际执行流程。

两者是同一件事的两个阶段：LLM 输出文本 Plan → Harness 解析成 ExecutionPlan → 按 Step 驱动工具调用。

### AgentRunner 接口

Harness 执行 Plan Step 时需要调 agent（让模型执行某个 step）。  
为避免 Harness 直接 `import { runAgent } from "@vera/core"`（导致紧耦合），在 Core 定义接口：

```ts
// packages/core/src/types/agent.ts
interface AgentRunner {
  run(prompt: string, tools: Tool[], ctx: RunContext): Promise<AgentResult>;
}
```

Harness 依赖 `AgentRunner` 接口，Core 提供默认实现，未来可替换为其他 agent 引擎（如 LangGraph、AutoGen）而无需改 Harness。

---

## 每阶段的北极星问题

### P0 北极星

> Vera 能不能在 Harness 约束下自己完成一个真实任务闭环，并知道什么时候该继续、什么时候该停？

### P1 北极星

> Vera 能不能在有限预算内自主运行多个 `Plan → Act → Critique → Replan` 循环，并持续推进复杂任务？

### P2 北极星

> Vera 能不能把自我批判转化成受控的策略提案，并用 benchmark / Rollout 证明自己真的进化了？

### P3 北极星

> Vera 能不能从代码场景扩展成跨工具、跨环境、跨 agent 的通用 Harness Runtime？

---

## Benchmark 方案

Benchmark 的目标不是"跑分"，是回答具体问题：这个 agent 在哪类任务上能稳定完成，在哪类任务上会失败，失败原因是什么。

详细设计见 [harness.md](./harness/design.md)。

### 评估维度

| 维度 | 衡量什么 | 怎么测 |
|---|---|---|
| **任务完成率** | 给定目标，能否完成 | Pass/Fail，N 次重复取均值 |
| **工具调用准确率** | 工具选对了吗，参数对吗 | 对比 golden tool call |
| **步骤效率** | 用了几步完成（越少越好） | 记录 turn 数 |
| **Token 效率** | 每个任务消耗多少 token | 从 usage 字段统计 |
| **稳定性** | 同一任务跑 5 次结果是否一致 | 方差/标准差 |

### 开源评测集

**通用 Agent 能力**

| 评测集 | 特点 | 推荐用途 |
|---|---|---|
| **GAIA**（HuggingFace） | 多步推理 + 工具使用，L1/L2/L3 三档，有社区排行榜 | 首选，优先跑 L1 |
| **AgentBench** | 8 种真实环境（OS、DB、Web、游戏等） | 测 agent 在真实任务里的综合表现 |
| **SWE-bench Verified** | 真实 GitHub issue 让 agent 修复 | 代码场景专项 |

**工具调用**

| 评测集 | 特点 |
|---|---|
| **ToolBench / ToolEval** | 16000+ 真实 API，测工具选择和参数生成 |
| **API-Bank** | 分层难度，测单次调用 vs 多步调用 |

**推理与规划**

| 评测集 | 特点 |
|---|---|
| **ALFWorld** | 文字游戏环境，测规划链 |
| **HotpotQA / MuSiQue** | 多跳问答，适合测带检索的 agent |

**Computer Use 专项** → 详见 [computer-use.md](./platform/computer-use.md#benchmark)

| 评测集 | 特点 |
|---|---|
| **WebArena** | 真实网站上的多步 web 任务 |
| **OSWorld** | 跨应用桌面操作，截图 + 动作序列 |
| **ScreenSpot** | GUI grounding，点击正确元素 |

**对 Vera 的建议策略**

1. 先跑 **GAIA L1**：题量适中，有标准答案，社区有排行榜可横向对比
2. 代码场景成熟后跑 **SWE-bench Verified**（子集）
3. Computer Use 场景上线后跑 **WebArena**
4. **自建 case** 补充开源集覆盖不到的业务场景

### 跑 Benchmark 的时机

- 改 prompt / 改 loop 逻辑后跑一次
- 切换模型（claude vs gpt vs gemini）时对比
- CI 里作为回归测试（只跑 L1，快且便宜）
