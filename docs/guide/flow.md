# Flow 配置与使用

> Flow 是 Vera Harness 的多阶段任务编排框架。通过声明式 Markdown 定义阶段、Agent 分工和依赖关系，由状态机驱动的运行时自动执行、评估、重试和恢复。

---

## 概述

Flow 将复杂任务拆解为有序的阶段流水线（Pipeline），每个阶段由指定 Agent 执行，阶段间通过 DAG 控制并行度。运行时内置 Plan Mode 生成执行计划，Critique 循环评估结果，Checkpoint 机制保障断点续跑。

| 能力 | 说明 |
|---|---|
| 声明式定义 | Markdown frontmatter + 结构化正文，无需写代码 |
| 多 Agent 协作 | 不同阶段可指派不同 Agent（独立 model / skills / rules / mcp） |
| DAG 调度 | 通过 `dependsOn` 声明依赖，无依赖的阶段自动并行 |
| 自动评估 | 每阶段执行后进入 Critiquing 状态，LLM 评估是否通过 |
| 重试与重规划 | 未通过可 retry，严重偏离触发 replan |
| Checkpoint 持久化 | 阶段边界自动保存 JSONL Checkpoint，中断后可恢复 |

---

## 目录结构

所有 Flow 定义存放在项目的 `.vera/flows/` 下：

```
.vera/flows/
├── flow/                          # Flow 定义（可以有多个）
│   └── <name>/
│       └── main.md                # Flow 入口定义（必须）
├── stages/                        # 可复用阶段模板（可选）
│   └── <name>/
│       └── main.md
├── agents/                        # Agent 角色定义（可选）
│   └── <name>/
│       └── main.md
└── iterations/                    # 执行产物输出（自动生成）
    └── <flow-name>/<flow-id>/     # 每次运行唯一 ID
```

- **flow/** — 每个 Flow 一个子目录。只有存在至少一个含 `main.md` 的子目录，CLI 才识别为有效的 Flow 项目。
- **stages/** — 可复用阶段模板。Flow 中通过 `stage` 字段引用此处的目录名，运行时加载 `stages/<name>/main.md` 中的指令正文。
- **agents/** — 可复用 Agent 角色。每个 Agent 可指定独立 model、adapter、skills、rules、mcp 和 systemPrompt。
- **iterations/** — 自动生成的产物目录，含 timeline、plan JSON、step results、critique 结果等。

---

## Flow 定义格式 (main.md)

### 完整结构

```markdown
---
name: 代码审查流水线
max_retries: 3
max_parallel: 2
workspace: ../..
---

# Goal

审查当前分支相对于 main 的代码变更，检查安全性、性能和代码风格。

## Stages

- id: security-scan
  stage: analyze
  agents: [security-bot]
  dependsOn: []

- id: code-review
  stage: review
  agents: [reviewer]
  dependsOn: [security-scan]
```

### Frontmatter 字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `name` | string | 否 | 目录名 | Flow 显示名称 |
| `max_retries` | number | 否 | `3` | 阶段失败时的最大重试次数 |
| `max_parallel` | number | 否 | `3` | 同时并行执行的阶段数上限 |
| `workspace` | string | 否 | `../..` | 工作目录相对于 `.vera/flows/` 的路径 |

### # Goal / 目标

一级标题 `# Goal` 或 `# 目标` 段落声明核心目标。运行时提取第一行非空文本作为 `ExecutionPlan.goal`。

解析代码（`parser.ts`）：
```typescript
function extractGoal(body: string): string {
  const match = body.match(/(?:^|\n)#\s+(?:Goal|目标)\s*\n([\s\S]*?)(?=\n#|$)/);
  const first = match?.[1]?.split("\n").find((line) => line.trim());
  return first?.trim() ?? "Execute flow";
}
```

### ## Stages

YAML 风格列表，每项定义一个阶段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 阶段唯一标识，用于依赖引用和日志追踪 |
| `stage` | string | 否 | 引用的阶段模板名（`stages/` 目录下子目录名），省略时等于 `id` |
| `agents` | string[] | 否 | 该阶段绑定的 Agent 列表。优先级高于阶段模板中定义的 `agents` |
| `depends_on` / `dependsOn` | string[] | 否 | 依赖的前置阶段 ID 列表 |

依赖关系形成 DAG，运行时在 `dispatchStep()` 中检测循环依赖并抛错。无依赖的阶段可并行，`max_parallel` 控制并发上限。

---

## 阶段模板 (stages/<name>/main.md)

```markdown
---
name: 代码分析
agents: [analyzer]
---

请对代码进行以下检查：
1. 安全漏洞（SQL 注入、XSS、CSRF）
2. 敏感信息泄露（API Key 硬编码）
3. 依赖风险（已知漏洞版本）

## Exit Criteria

所有检查项必须通过。如有 high/critical 发现，本阶段视为未通过。
```

| Frontmatter 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 阶段显示名称 |
| `agents` | string[] | 默认 Agent 列表（Flow 中 Stage 级别的 `agents` 会覆盖） |

### Exit Criteria

`## Exit Criteria` 或 `## 准出标准` 段落定义阶段通过条件。运行时将其注入步骤提示词（`stepPromptByStepId`），LLM 在 Critique 阶段据此评估。未定义则使用默认启发式评估。

---

## Agent 定义 (agents/<name>/main.md)

```markdown
---
name: 安全检查员
model: claude-sonnet-4-20250514
adapter: anthropic
skills: [quality-scan, security-review]
rules: [coding-standards]
mcp: [km-mcp-server]
---

你是一位资深安全工程师，专注于 Web 应用安全审查。

职责：
1. 检查代码变更中的安全漏洞
2. 评估第三方依赖的安全性
3. 输出结构化审查报告
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 否 | Agent 显示名称 |
| `model` | string | 否 | 指定模型，不指定则使用 CLI 全局 `--model` |
| `adapter` | string | 否 | LLM 适配器，不指定则使用 CLI 全局 `--provider` |
| `skills` | string[] | 否 | 可见 skill 列表，限制可用工具范围 |
| `rules` | string[] | 否 | 可见规则文件列表 |
| `mcp` | string[] | 否 | 可访问的 MCP 服务器列表 |
| 正文 | - | 是 | 完整系统提示词（systemPrompt） |

skills/rules/mcp 定义了 Agent 的可见性边界。未配置时继承全局默认 SkillBundle（所有资源均可用）。运行时在加载阶段打印每个 Agent 配置：

```
  Loading 3 agent roles from .vera/flows/agents/...
  ✓ analyzer: 安全检查员 (model: claude-sonnet-4-20250514)
  ✓ coder: 代码实现者
  ✓ reviewer: 代码审查员
```

---

## CLI 命令

### openvera run

```bash
openvera run                  # 只有 1 个 Flow 时自动选择
openvera run code-review      # 指定 Flow 名称
openvera run --dir /path/to/project --model claude-sonnet-4-20250514
openvera run --max-steps 20 --skip-plan-critique
```

| 参数 | 说明 |
|---|---|
| `--dir` | 项目根目录（默认当前目录） |
| `--flow` | Flow 名称（默认自动检测唯一的 Flow） |
| `--model` | 覆盖全局模型 |
| `--provider` | 覆盖全局 LLM 提供商 |
| `--api-key` | API Key（也可通过 settings.json 配置） |
| `--artifacts-dir` | 产物输出目录 |
| `--max-steps` | 最大执行步数上限 |
| `--skip-plan-critique` | 跳过执行前的 Plan Critique 评估 |

多个 Flow 时未指定名称会报错：
```
Multiple flows found: code-review, deploy. Specify one with openvera run <name>.
```

### 输出示例

```
  Vera Harness — Flow Runner
  Flow:      code-review
  Plan:      3 steps — 审查当前分支代码变更
  Model:     claude-sonnet-4-20250514

  Critiquing plan...
  ✓ Plan critique passed  score=0.85

  [1/3] security-scan
  ✓   score=0.92
  [2/3] code-review
  ✓   score=0.78
  [3/3] test-verify
  ✓   score=0.88

  ✓ Flow completed — 3/3 steps
      ✓ security-scan
      ✓ code-review
      ✓ test-verify
```

---

## 状态机

Flow 执行流转于 11 个状态，转换由 `flow-state.ts` 的 `VALID_TRANSITIONS` 表严格约束。

### 完整状态转换表

| 当前状态 | 含义 | 可跳转到 |
|---|---|---|
| `intaking` | 入口：接收输入，解析目标 | `planning`, `completed` |
| `planning` | 规划中：生成 ExecutionPlan | `dispatching`, `failed` |
| `dispatching` | 调度中：选择下一个待执行步骤 | `executing`, `completed`, `waiting_approval`, `failed` |
| `executing` | 执行中：Agent 执行步骤 | `waiting_tool`, `waiting_approval`, `critiquing`, `failed` |
| `waiting_tool` | 等待工具：工具调用进行中 | `executing`, `failed` |
| `waiting_approval` | 等待审批：高风险操作需确认 | `executing`, `dispatching`, `failed`, `paused` |
| `critiquing` | 评估中：LLM 评估步骤结果 | `dispatching`, `replanning`, `waiting_approval`, `completed` |
| `replanning` | 重规划：偏离目标，重新生成 | `dispatching`, `failed` |
| `paused` | 已暂停：人工介入中 | `dispatching`, `executing`, `failed` |
| `completed` | **终态**：全部成功 | - |
| `failed` | **终态**：失败或不可修复 | - |

### 正常执行路径

```
intaking -> planning -> dispatching -> executing <-> waiting_tool
                                             |
                                         critiquing -> dispatching -> ... -> completed
```

### Critique 分支

```
critiquing -> replanning -> dispatching -> ...
critiquing -> waiting_approval -> (人工审批) -> dispatching
```

### 状态查询 API

```typescript
import {
  canTransition,        // (from, to) => boolean
  assertTransition,     // (from, to) => void，非法跳转抛异常
  transitionFlow,       // (flow, to) => TaskFlow，不可变更新
  transitionFlowPath,   // (flow, path[]) => TaskFlow，链式跳转
  isTerminal,           // (state) => boolean
  isFlowDone,           // (flow) => boolean
  isFlowPausable,       // (flow) => boolean — executing 或 dispatching
  isFlowWaiting,        // (flow) => boolean — waiting_approval 或 paused
} from "@open-vera/harness";
```

---

## Plan Mode 集成

Flow 执行建立在 Plan Mode 之上。`openvera run` 的内部流程：

### 1. 解析 -> 2. 生成计划

`loadFlowDefinition()` 加载 Flow 文件，`flowDefinitionToPlan()`（`cli/plan.ts`）将 `FlowDefinition` 转换为 `ExecutionPlan`：
- 每个 Stage 成为 `PlanStep`（`type: "delegate"`）
- `stage` 引用解析为阶段模板的 `body`，注入步骤指令
- `dependsOn` 直接映射为步骤依赖关系
- Agent 指派优先级：Stage 级别 `agents` > 阶段模板 `agents` > 默认 Agent

### 3. Plan Critique

除非指定 `--skip-plan-critique`，运行时先对计划进行 LLM 评估。`confidence` 低于 0.5 直接终止：

```
Critiquing plan...
✗ Plan critique: score=0.42 — 阶段划分不合理...
Plan score too low, aborting. Fix .../main.md and retry.
```

### 4. 动态重规划

Critique 评估未通过时触发 replan：`critiquing` 状态调用 `replanWithCritique()` 重新生成计划。CLI 输出中显示变化摘要：

```
↻ replan  modified=[step-a]  added=[step-d]  removed=[]
```

### 5. 免 Flow 文件的快捷入口

```typescript
const handle = await runtime.planAndStart(
  "审查 src/ 目录下最近 3 次 commit 的安全性",
  "quick-review-001"
);
// planAndStart 内部调 planFromPrompt() 自动生成 ExecutionPlan
// 然后继续走正常的 runFlowLoop
```

---

## Checkpoint 与恢复

### 存储格式

Checkpoint 持久化目录：`<checkpointsDir>/<flowId>.checkpoints.jsonl`。每行是一个 `FlowCheckpoint` JSON：

| 字段 | 说明 |
|---|---|
| `checkpointId` | 唯一 ID，格式 `cp-<timestamp36>-<random4>` |
| `flowId` | 所属 Flow ID |
| `state` | 当前 HarnessState |
| `plan` | 完整 ExecutionPlan（含每步 status） |
| `activeStepId` | 当前活跃步骤 |
| `loopCount` | dispatching 循环次数 |
| `budget` | Token / USD 消耗累计 |
| `artifacts` | 已产生产物列表 |

### 自动保存时机

在 `runFlowLoop()` 中以下时机自动触发（需配置 `checkpointsDir`）：

1. 每次 dispatching 循环开始前
2. 步骤执行并 Critique 完成后
3. replan 完成后
4. Flow `completed` 或 `failed` 时（终态 Checkpoint）

采用 append-only 写入，崩溃安全。超出阈值时自动 compact（去重、清理损坏行、按 `compactToKeep` 裁剪）。

### 断点恢复

```typescript
const handle = await runtime.resumeFromCheckpoint("my-flow-id");
// 重建 TaskFlow，恢复 plan/budget/loopCount
// skipCompleted 默认 true，自动跳到下一个 pending 步骤
// failed 状态重置为 dispatching
// maxLoops 自动 +3 留出重试空间
if (handle) {
  await runtime.runFlowLoop(handle, loopOptions);
}

// 指定恢复参数
const handle = await runtime.resumeFromCheckpoint("my-flow-id", {
  fromStepId: "test-verify",
  skipCompleted: false,
});
```

### Fork（分支执行）

```typescript
const forked = await runtime.forkFromCheckpoint("source-flow-id", {
  newFlowId: "fix-safety-issues-001",
  newGoal: "只修复 security-scan 发现的高危问题",
  resetSteps: ["code-review", "test-verify"],  // 重置为 pending
});
// Fork 特点：新 flowId、独立 Checkpoint 文件、budget 归零、loopCount 重新计数
if (forked) {
  await runtime.runFlowLoop(forked, loopOptions);
}
```

### Checkpoint 管理 API

```typescript
const store = runtime.getCheckpointStore();
if (store) {
  store.listFlows();              // 列出所有有 Checkpoint 的 Flow
  store.list("my-flow-id");       // 列出某 Flow 的所有 Checkpoint 索引
  store.count("my-flow-id");      // 数量
  store.loadLatest("my-flow-id"); // 读取最新 Checkpoint
  store.compact("my-flow-id");    // 去重 + 裁剪
  store.clear("my-flow-id");      // 清除所有 Checkpoint
}
```

---

## 常见问题

**多个 Flow 必须指定名称。** 当 `flow/` 下有多个子目录时，`openvera run` 不传名称会报错列出所有可用 Flow。

**Stage agents 覆盖规则。** Flow 文件 Stage 级别的 `agents` 覆盖阶段模板的 `agents`，允许同一模板在不同 Flow 中由不同 Agent 执行。

**循环依赖检测。** 运行时在 `dispatchStep()` 中检测。如果 A 依赖 B、B 依赖 A，抛出 `"Circular dependency detected in plan steps: A → B → A"`。

**Checkpoint 必须显式启用。** 默认不启用。需要在 `RuntimeOptions` 中传入 `checkpointsDir`：
```typescript
const runtime = new HarnessRuntime(adapter, model, {
  artifactsRootDir: "...",
  checkpointsDir: join(homedir(), ".vera", "checkpoints"),
});
```

**Flow 目录不存在。** CLI 报错：`Error: No .vera/flows/ directory found. Create .vera/flows/flow/<name>/main.md to define a flow.`

---

## 相关源码

| 文件 | 职责 |
|---|---|
| `packages/harness/src/flow-config/types.ts` | FlowDefinition / FlowStageRef / StageDefinition / FlowAgentDefinition 类型 |
| `packages/harness/src/flow-config/parser.ts` | Markdown 解析：frontmatter、Stage 引用、stages/ agents/ 目录加载 |
| `packages/harness/src/runtime/flow-state.ts` | 11 状态状态机：VALID_TRANSITIONS 表、跳转断言、状态查询 |
| `packages/harness/src/runtime/flow.ts` | TaskFlow 创建、Checkpoint 构建、状态更新、产物附加 |
| `packages/harness/src/runtime/runtime.ts` | HarnessRuntime：调度循环、Critique/Replan、Checkpoint 保存/恢复/Fork |
| `packages/harness/src/runtime/checkpoint-store.ts` | JSONL CheckpointStore：append 写、loadLatest、compact、去重 |
| `packages/harness/src/cli/flow-run.ts` | `openvera run` CLI 命令：加载 flow、事件回调、结果输出 |
| `packages/harness/src/cli/plan.ts` | `flowDefinitionToPlan()`：FlowDefinition -> ExecutionPlan |
