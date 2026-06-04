# Flow 配置与使用

Flow 是 Vera Harness 层的核心编排机制，将多步 agent 执行流程定义为声明式配置，由状态机驱动自动推进。

---

## 概念

### 什么是 Flow

Flow 是一个预定义的多步 agent 工作流。与单次 agent 对话不同，Flow：

- **多阶段串行/并行执行**：定义 N 个阶段（Stage），按依赖关系编排
- **多 Agent 协作**：每个阶段可指定不同的 agent 角色（如"编码"阶段用 coding agent，"审查"阶段用 review agent）
- **状态机保证**：通过 `FlowState` 严格的状态转换模型，确保流程完整性和可恢复性
- **自动 Critique**：内置批评-修正循环，使输出质量可控

### Flow vs 自由对话

| | 自由对话 | Flow |
|---|---|---|
| 执行路径 | 由 LLM 自行决定 | 预定义阶段顺序 |
| Agent 角色 | 单一 agent | 每阶段可不同 agent |
| 质量控制 | 依赖用户反馈 | 内置 Critique → Replan |
| 可重现性 | 低 | 高（配置即文档） |
| 适用场景 | 探索性任务、问答 | 标准化流程、CI/CD |

---

## 目录结构

Flow 定义存放在项目的 `.vera/flows/` 目录下：

```
.vera/flows/
├── flow/
│   └── <flow-name>/
│       └── main.md          # Flow 入口定义（YAML frontmatter + Markdown body）
├── agents/
│   └── <agent-name>/
│       └── main.md          # Agent 角色定义
└── stages/
    └── <stage-name>/
        └── main.md          # Stage 详细定义（可选，用于共享 stage）
```

- **flow/**：每个 Flow 一个子目录，`main.md` 是 Flow 定义的入口
- **agents/**：可复用的 Agent 角色定义，按名称对应
- **stages/**：可复用的 Stage 定义，可在多个 Flow 中引用

---

## Flow 定义格式

### main.md 结构

Flow 的 `main.md` 是标准的 Markdown 文件，使用 YAML frontmatter 声明元信息，Markdown body 定义 Stages。

```markdown
---
name: 代码审查流程
workspace: ../..
max_retries: 3
max_parallel: 3
---

# Goal

对全仓库进行一次全面的代码审查，生成审查报告。

## Stages

- id: explore
  stage: code-exploration
  agents: [explorer]

- id: review
  stage: code-review
  agents: [reviewer]
  depends_on: [explore]

- id: report
  stage: report-generation
  agents: [reporter]
  depends_on: [review]
```

### Frontmatter 字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | 否 | Flow 显示名称，默认使用目录名 |
| `workspace` | string | 否 | 相对工作区路径，默认 `../..` |
| `max_retries` | number | 否 | 单阶段最大重试次数，默认 3 |
| `max_parallel` | number | 否 | 最大并行 stage 数，默认 3 |

### Goal 定义

Flow body 中 `# Goal`（或 `# 目标`）段落定义 Flow 的总目标。第一行非空文本被提取为 goal，用于生成初始执行计划。

```markdown
# Goal

对全仓库进行一次全面的代码审查，生成审查报告。
```

### Stages 定义

`## Stages` 段落列出所有 stage 及其依赖关系。每个 stage 定义为 YAML 风格的列表项：

```markdown
## Stages

- id: explore
  stage: code-exploration
  agents: [explorer]

- id: review
  stage: code-review
  agents: [reviewer]
  depends_on: [explore]
```

**Stage 引用字段：**

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 该 stage 在本 Flow 中的唯一标识 |
| `stage` | string | 否 | 引用的 Stage 定义名称，默认使用 id |
| `agents` | string[] | 否 | 该 stage 可使用的 agent 角色列表 |
| `depends_on` | string[] | 否 | 依赖的前置 stage id 列表 |

**依赖关系：**
- 未声明 `depends_on` 的 stage 可以立即执行
- 有依赖的 stage 在所有前置 stage 完成后才开始执行
- 无依赖的多个 stage 可以并行执行（受 `max_parallel` 限制）

### Agent 定义格式

每个 agent 通过 `.vera/flows/agents/<name>/main.md` 定义：

```markdown
---
name: 代码审查员
model: claude-sonnet-4-6
skills: [code-review, static-analysis]
rules: [security-rules]
mcp: [github]
---

你是一个资深代码审查员。请你：

1. 仔细阅读提供的代码
2. 检查以下方面：
   - 安全漏洞
   - 性能问题
   - 代码风格
   - 架构合理性
3. 给出结构化的审查报告
```

**Agent frontmatter 字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | Agent 显示名称 |
| `model` | string | 使用的模型，覆盖全局默认 |
| `adapter` | string | 使用的 adapter，覆盖全局默认 |
| `skills` | string[] | 附加的技能/能力 |
| `rules` | string[] | 附加的规则文件 |
| `mcp` | string[] | MCP 服务连接 |
| systemPrompt | (body) | Agent 的系统提示词 |

### Stage 定义格式

Stage 可选地在 `.vera/flows/stages/<name>/main.md` 中定义，用于跨 Flow 复用：

```markdown
---
name: 代码探索
agents: [explorer]
---

分析代码库结构，识别关键模块、依赖关系和潜在的改进点。

## Exit Criteria

已识别出至少 5 个值得审查的模块，并生成了模块依赖图。
```

**Exit Criteria**（`## Exit Criteria` 或 `## 准出标准`）段落定义该 stage 的完成标准。Flow 引擎会在 stage 执行后检查是否满足准出条件。

---

## CLI 使用

### 运行 Flow

```bash
# 运行默认 Flow（当只有一个 Flow 时）
openvera run

# 运行指定 Flow
openvera run code-review

# 若有多个 Flow 且未指定名称，会报错提示
openvera run
# Error: Multiple flows found: code-review, deploy-check. Specify one with openvera run <name>.
```

### 编程接口

```typescript
import { loadFlowDefinition, listFlowDefinitions } from "@open-vera/harness";

// 列出所有 Flow
const flows = await listFlowDefinitions(".vera/flows");
console.log(flows); // ["code-review", "deploy-check"]

// 加载 Flow 定义
const flowDef = await loadFlowDefinition(".vera/flows", "code-review");
console.log(flowDef.stages);
// [{ id: "explore", stage: "code-exploration", agents: ["explorer"], dependsOn: [] }, ...]
```

---

## 状态机生命周期

Flow 执行由 `flow-state.ts` 中的状态机驱动。每个 Flow 实例在其生命周期中经历以下状态：

### 状态定义

```
intaking → planning → dispatching → executing → critiquing → completed
                ↓           ↓             ↓            ↓
              failed    completed     waiting_tool  completed
                           ↓              ↓
                      waiting_approval  failed
                           ↓
                      paused / executing / dispatching
```

### 有效状态转换表

| 当前状态 | 可转换至 |
|---|---|
| `intaking` | `planning`, `completed` |
| `planning` | `dispatching`, `failed` |
| `dispatching` | `executing`, `completed`, `waiting_approval`, `failed` |
| `executing` | `waiting_tool`, `waiting_approval`, `critiquing`, `failed` |
| `waiting_tool` | `executing`, `failed` |
| `waiting_approval` | `executing`, `dispatching`, `failed`, `paused` |
| `critiquing` | `dispatching`, `replanning`, `waiting_approval`, `completed` |
| `replanning` | `dispatching`, `failed` |
| `paused` | `dispatching`, `executing`, `failed` |
| `completed` | （终止状态） |
| `failed` | （终止状态） |

### 查询函数

```typescript
import {
  canTransition,
  assertTransition,
  transitionFlow,
  isTerminal,
  isFlowDone,
  isFlowPausable,
  isFlowWaiting,
} from "@open-vera/harness";

// 检查转换是否合法
canTransition("executing", "critiquing"); // true
canTransition("completed", "executing");  // false

// 断言转换合法性（不合法则抛异常）
assertTransition("executing", "critiquing");

// 执行不可变转换，返回新的 flow 对象
const newFlow = transitionFlow(flow, "critiquing");

// 链式转换
const finalFlow = transitionFlowPath(flow, ["executing", "critiquing", "completed"]);
```

### Plan Mode 集成

Flow 在 `dispatching` 阶段自动调用 Plan Mode（详见 `plan-mode.md`），生成结构化的执行计划：

1. **Task 拆分**：将 Goal 分解为可执行的子任务
2. **Agent 分配**：根据 stage 定义匹配 agent
3. **依赖管理**：保证按 `depends_on` 顺序执行
4. **并行调度**：无依赖的 stage 并行分派（受 `max_parallel` 限制）

当 `critiquing` 阶段发现问题时，会触发 `replanning`，重新规划后再次 `dispatching`。

---

## 配置示例

### 完整的多阶段 Flow

```markdown
---
name: 功能开发流程
max_retries: 2
max_parallel: 2
---

# Goal

实现一个新 API 端点 `/api/users/search`，包含完整的实现、测试和文档。

## Stages

- id: design
  stage: api-design
  agents: [architect]

- id: implement
  stage: code-implementation
  agents: [coder]
  depends_on: [design]

- id: test
  stage: test-generation
  agents: [tester]
  depends_on: [design]

- id: review
  stage: code-review
  agents: [reviewer]
  depends_on: [implement, test]

- id: docs
  stage: documentation
  agents: [writer]
  depends_on: [review]
```

此 Flow 的执行顺序：
1. `design` 首先执行
2. `implement` 和 `test` 并行执行（都依赖 `design`）
3. `review` 等待 `implement` 和 `test` 完成后执行
4. `docs` 最后执行
