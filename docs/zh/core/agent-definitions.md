# 自定义 Agent 定义

> Vera 支持通过 Markdown 文件定义自定义 subagent，扩展 Vera 的能力板图。本文档解释 Agent 定义的格式、加载机制和配置方法。

---

## 概述

Vera 的 subagent 系统允许主 agent 将任务委派给专用的子 agent。子 agent 拥有独立的 system prompt、工具集、权限模式和执行隔离策略。

Agent 定义来源有三层，按加载优先级从低到高：

1. **内置定义**（`BUILTIN_AGENT_DEFINITIONS`）——代码中硬编码的三个默认 agent
2. **用户级定义**（`~/.vera/agents/*.md`）——跨项目共享
3. **项目级定义**（`<project>/.vera/agents/*.md`）——项目专属

高层级定义会覆盖低层级同 `agentType` 的定义。优先级：项目 > 用户 > 内置。

---

## Agent 定义格式

Agent 定义使用 Markdown 文件，包含 YAML front matter 和 Markdown 正文。

### 文件位置

- 用户级：`~/.vera/agents/<agent-name>.md`
- 项目级：`<project-root>/.vera/agents/<agent-name>.md`

### 文件结构

```markdown
---
name: my-agent
description: 我的自定义 agent 的描述
tools: read_file, write_file, bash
permissionMode: default
maxTurns: 100
disallowedTools: rm, sudo
---

你是一个自定义的 Vera subagent。

## 你的职责

- 专注于某个特定领域
- 使用可用的工具完成任务
- 返回简洁的最终报告

## 输出格式

- 结果：
- 关键证据或检查的文件：
- 阻塞项或风险：
```

### Front Matter 字段说明

| 字段 | 别名 | 类型 | 必需 | 说明 |
|---|---|---|---|---|
| `name` | `agentType`, `agent_type` | string | 否 | agent 类型标识符，默认取文件名（不含 .md 后缀） |
| `description` | `whenToUse` | string | 否 | agent 用途描述，默认自动生成一段描述 |
| `tools` | — | `"*"` 或逗号分隔的工具名列表 | 否 | 允许使用的工具列表，`"*"` 表示全部工具，默认 `"*"` |
| `disallowedTools` | `disallowed_tools` | string (列表) | 否 | 禁止使用的工具列表，即使 tools 为 `*` 也会生效 |
| `permissionMode` | `permission_mode` | `"readonly"` \| `"default"` | 否 | 权限模式，默认 `"default"` |
| `maxTurns` | `max_turns` | number | 否 | 最大对话轮数限制，正整数 |

**字段解析规则**：
- Front matter 以 `---` 开始和结束
- 每行格式为 `key: value`
- 字符串值支持单引号或双引号包裹
- 列表值支持方括号格式 `[a, b, c]` 或用逗号/空格分隔
- 未知字段静默忽略

**`agentType` 规范化**：
- 转为小写
- 所有下划线 `_` 替换为连字符 `-`
- `"general"` 自动映射为 `"general-purpose"`

### Markdown 正文

Front matter 之后的所有 Markdown 内容作为 subagent 的 system prompt。正文不能为空（仅空格会被忽略，导致定义被跳过）。

正文末尾会自动追加以下后缀 prompt：

```
你是一个在主 agent 轮次中运行的 Vera subagent。
只专注于委派的任务。根据需要使用的工具，然后返回简洁的最终报告，包含：
- 结果
- 关键证据或检查的文件
- 任何阻塞项或风险
除非无法继续否则不要向用户提问。
```

---

## 内置 Agent 类型

Vera 在代码中硬编码了三个内置 agent：

### general-purpose

```typescript
{
  agentType: "general-purpose",
  description: "通用 subagent，用于聚焦的多步骤任务。",
  systemPrompt: "You are a general-purpose Vera subagent.",
  tools: "*",              // 全部工具
  permissionMode: "default",
  maxTurns: 200,
}
```

最通用的 agent，拥有全部工具权限，适合大多数委派场景。

### explore

```typescript
{
  agentType: "explore",
  description: "只读 subagent，用于代码库探索和研究。",
  systemPrompt: "You are a read-only exploration subagent. Inspect and report; do not modify files.",
  tools: ["read_file", "list_dir", "glob", "grep"],  // 只读工具
  permissionMode: "readonly",
  maxTurns: 80,
}
```

只读探索型 agent，无法修改文件，适合代码分析、文档检索、依赖梳理。

### plan

```typescript
{
  agentType: "plan",
  description: "只读规划 subagent，用于设计和实施方案。",
  systemPrompt: "You are a planning subagent. Produce concise plans grounded in the available context.",
  tools: ["read_file", "list_dir", "glob", "grep"],  // 只读工具
  permissionMode: "readonly",
  maxTurns: 40,
}
```

专注于规划和设计，轮数限制最低（40），适合快速出方案。

### 覆盖内置定义

要覆盖内置 agent，在 `.vera/agents/` 中创建一个同 `agentType` 的 Markdown 文件即可。

例如，覆盖 `general-purpose` 的最大轮数和 system prompt：

```markdown
---
name: general-purpose
description: 增强版通用 agent
maxTurns: 300
---

你是 Vera 的增强版通用 subagent，拥有更深度的推理能力...
```

---

## Agent 隔离模式

Subagent 支持三种执行隔离模式，通过 `isolation` 参数控制：

### none（默认）

在当前工作区中直接执行 subagent。无文件系统隔离，子 agent 的修改直接影响当前工作区。适合代码分析、信息检索等读操作。

```markdown
---
name: code-reviewer
isolation: none  # 默认值，可省略
---
```

### try

为 subagent 创建独立的 git worktree。所有文件修改在隔离目录中进行，不影响原始工作区。

- Worktree 命名格式：`subagent-{agentType}-{slug}-{uuid8}`
- Subagent 的 session 存储于原始项目目录
- 可以通过 worktree diff 查看改动，手动合并

```markdown
---
name: experimenter
description: 实验性代码修改
tools: read_file, write_file, bash
maxTurns: 150
---

你是实验性修改 subagent。在隔离环境中安全地尝试代码改动。
```

调用时指定 `isolation: "try"`：

```json
{
  "subagent_type": "experimenter",
  "prompt": "尝试用 async/await 重写 callback 风格的代码",
  "isolation": "try"
}
```

### remote

将 subagent 发送到远程执行器执行。需要配置 `VERA_SUBAGENT_REMOTE_RUNNER` 环境变量指向远程执行命令。

- 远程执行器通过 stdin 接收 JSON 载荷
- 通过 stdout 输出 JSON 结果
- 适合需要特定硬件环境、长时间运行的任务

---

## 工具与权限约束

### 只读模式 (readonly)

当 `permissionMode: "readonly"` 时，自动将 tools 列表与内置只读工具集做交集：

```
允许的只读工具：read_file, list_dir, glob, grep
```

即使 `tools: "*"`，也只允许上述四个只读工具。

### 工具交集逻辑

Subagent 实际可用的工具 = `子 agent 定义的工具集 ∩ 调用时指定的 allowedTools`（排除 `disallowedTools` 和被禁用的根 agent 工具）。

`agent` 工具（subagent 自身）始终对子 agent 不可用，防止无限递归。

---

## Subagent 调用方式

主 agent 通过 `agent` 工具调用 subagent：

```json
{
  "prompt": "分析 packages/core/src/agent/loop.ts 的复杂度",
  "subagent_type": "explore",
  "description": "分析 loop.ts 复杂度",
  "context": "重点关注圈复杂度和函数长度",
  "allowedTools": ["read_file", "grep"],
  "maxTurns": 50
}
```

### 调用参数

| 参数 | 别名 | 必需 | 说明 |
|---|---|---|---|
| `prompt` | `task` | 是 | 委派任务描述 |
| `subagent_type` | `subagentType` | 否 | agent 类型，默认 `"general-purpose"` |
| `description` | — | 否 | 3-5 词的简短任务描述 |
| `context` | — | 否 | 额外的上下文、约束或路径信息 |
| `allowedTools` | — | 否 | 允许使用的工具白名单，与 agent 定义取交集 |
| `maxTurns` | — | 否 | 最大轮数限制，正整数（覆盖 agent 定义值） |
| `isolation` | — | 否 | 隔离模式：`"none"` / `"try"` / `"remote"` |
| `run_mode` | — | 否 | 执行模式：`"sync"` (默认) / `"background"` |
| `resume_session_id` | `resumeSessionId` | 否 | 恢复之前的 subagent 实录继续执行 |

### 后台模式 (background)

设置 `run_mode: "background"` 时，subagent 异步执行，立即返回 job ID。可通过 `/subjobs` 查看状态：

```
/subjobs                     # 列出所有后台任务
/subjobs subjob-abc123       # 查看特定任务详情
```

后台任务的三种状态：`running` / `succeeded` / `failed`。

---

## 完整示例

### 示例 1：自定义 Linter Agent

`.vera/agents/linter.md`：

```markdown
---
name: linter
description: 代码质量检查专用 agent，运行 lint 和静态分析
tools: bash, read_file, grep, glob
permissionMode: readonly
maxTurns: 60
disallowedTools: write_file, rm
---

你是 Vera 的代码检查 subagent。

## 你的职责

1. 运行项目的 lint 工具检查代码质量
2. 分析 lint 输出，按严重程度分类
3. 对每个 warning/error 给出修复建议

## 输出格式

- **概览**：总 warning/error 数量
- **Top 问题**：最重要的 3-5 个问题
- **修复建议**：每个问题的具体修改方案
- **风险提示**：修复可能引入的副作用

使用 `read_file` 查看问题文件，使用 `bash` 运行 lint 命令。
```

### 示例 2：自定义 Test Runner Agent

`.vera/agents/test-runner.md`：

```markdown
---
name: test-runner
description: 运行测试并分析失败用例
tools: bash, read_file, grep, glob, write_file
permissionMode: default
maxTurns: 120
---

你是 Vera 的测试运行 subagent。

## 工作流程

1. 运行测试套件：`pnpm test`
2. 分析失败用例，定位失败原因
3. 如果原因明确且修复简单，直接用 write_file 修复源文件
4. 如果原因复杂，列出需要人工排查的点

## 输出格式

- **测试概览**：通过/失败/跳过 数量
- **失败分析**：每个失败用例的根因判断
- **自动修复**：你做了哪些修改（如有）
- **待人工处理**：需要进一步调查的问题
```

### 示例 3：覆盖内置探索 Agent

`.vera/agents/explore.md`：

```markdown
---
name: explore
description: 增强版只读探索 agent，支持跨项目搜索
tools: read_file, list_dir, glob, grep, bash
maxTurns: 120
---

你是 Vera 的增强版探索 subagent。

与原版不同，你还可以使用 `bash` 运行搜索命令（如 `rg`、`find`），
但不能修改任何文件。始终以结构化报告输出你的发现。
```
