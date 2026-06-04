# 自定义 Agent 定义

Agent 定义是 Vera 子代理系统的配置核心。通过 Markdown frontmatter 格式，用户可以声明自定义 Agent 的角色、工具权限和执行策略。

---

## 概念

### 什么是 Agent 定义

Agent 定义描述一个子 agent 的身份、能力边界和执行策略。当主 agent 通过 `agent` 工具调起子 agent 时，根据 `subagent_type` 参数匹配对应的定义，从而：

- 使用自定义系统提示词（system prompt）
- 限制可用工具范围
- 设置权限模式（只读/完整）
- 控制最大执行轮次

### 定义来源

Agent 定义有三个来源，按优先级从低到高：

| 优先级 | 来源 | 目录 |
|---|---|---|
| 1（最低） | 内置定义 | `BUILTIN_AGENT_DEFINITIONS` 常量 |
| 2 | 用户级定义 | `~/.vera/agents/*.md` |
| 3（最高） | 项目级定义 | `.vera/agents/*.md` |

同名 agent（按 `agentType` 标准化后）后加载的覆盖先加载的，项目级定义可以覆盖用户级和内置定义。

---

## Agent 定义格式

### 文件结构

每个 Agent 以 `.md` 文件定义，文件名决定默认的 `agentType`：

```
.vera/agents/code-reviewer.md
```

文件使用 YAML frontmatter 声明元信息，正文为系统提示词：

```markdown
---
name: code-reviewer
description: 专注于代码审查和安全检查的子代理
tools: [read_file, list_dir, grep, glob]
disallowedTools: [write_file, edit_file]
permissionMode: readonly
maxTurns: 40
---

你是一个资深代码审查员。你的职责：

1. 仔细阅读提供的代码
2. 检查以下方面：
   - 安全漏洞（SQL 注入、XSS、CSRF）
   - 性能问题（不必要的循环、内存泄漏）
   - 代码风格（命名、职责单一）
   - 架构合理性（模块耦合度、接口设计）
3. 给出结构化的审查报告，包含严重程度评级

输出格式：以 Markdown 表格列出所有发现，每项标注等级（Critical/High/Medium/Low）。
```

### Frontmatter 字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` / `agentType` / `agent_type` | string | 否 | Agent 类型标识。默认取文件名（不含扩展名） |
| `description` / `whenToUse` | string | 否 | 简短描述，显示在工具 schema 中 |
| `tools` | string 或 string[] | 否 | 可用工具列表。`"*"` 表示全部工具，默认 `"*"` |
| `disallowedTools` / `disallowed_tools` | string[] | 否 | 禁止的工具列表 |
| `permissionMode` / `permission_mode` | `"readonly"` 或 `"default"` | 否 | 权限模式，默认 `"default"` |
| `maxTurns` / `max_turns` | number | 否 | 最大执行轮次， 必须 > 0 |
| 正文 | Markdown | 是 | 完整的系统提示词 |

### 字段解析细节

**agentType 标准化：**
- 统一转小写
- `_` 替换为 `-`
- `"general"` 等同于 `"general-purpose"`

**tools 字段：**
- 可以是字符串 `"*"`（全部工具）
- 可以是数组 `["read_file", "list_dir", "grep"]`
- 也可以是 YAML 内联格式 `[read_file, list_dir, grep]`

**permissionMode：**
- `"readonly"`：自动与只读工具（`read_file`, `list_dir`, `glob`, `grep`）取交集，即即使声明 `tools: "*"`，也只开放只读工具
- `"default"`：不做额外限制，完全按 `tools`/`disallowedTools` 配置

**maxTurns：**
- 未指定时无限轮次（直到 `end_turn`）
- 指定时限制子 agent 的 `streamAgent` 循环次数
- `runSubagentTool` 参数 `maxTurns` 可覆盖此值（取较小值）

---

## 内置 Agent

Vera 默认提供三个内置 Agent 定义：

### general-purpose

```typescript
{
  agentType: "general-purpose",
  description: "General-purpose subagent for focused multi-step tasks.",
  systemPrompt: "You are a general-purpose Vera subagent.",
  tools: "*",
  permissionMode: "default",
  maxTurns: 200,
}
```

通用子代理，拥有全部工具权限，适用于大部分多步任务。

### explore

```typescript
{
  agentType: "explore",
  description: "Read-only subagent for codebase exploration and research.",
  systemPrompt: "You are a read-only exploration subagent. Inspect and report; do not modify files.",
  tools: ["read_file", "list_dir", "glob", "grep"],
  permissionMode: "readonly",
  maxTurns: 80,
}
```

只读探索子代理，专用于代码分析和信息收集，不修改文件。

### plan

```typescript
{
  agentType: "plan",
  description: "Read-only planning subagent for design and implementation plans.",
  systemPrompt: "You are a planning subagent. Produce concise plans grounded in the available context.",
  tools: ["read_file", "list_dir", "glob", "grep"],
  permissionMode: "readonly",
  maxTurns: 40,
}
```

只读规划子代理，专用于设计方案和实施计划，轮次限制更紧。

---

## 工具 Schema

主 agent 通过 `agent` 工具调用子 agent。工具 schema 的关键参数：

```typescript
const subagentToolSchema: Tool = {
  name: "agent",
  parameters: {
    type: "object",
    properties: {
      description:    { type: "string", description: "A short 3-5 word description" },
      prompt:         { type: "string", description: "The task for the agent" },
      subagent_type:  { type: "string", enum: ["general-purpose", "explore", "plan", ...] },
      context:        { type: "string", description: "Optional relevant context" },
      allowedTools:   { type: "array",  items: { type: "string" } },
      maxTurns:       { type: "number" },
      isolation:      { type: "string", enum: ["none", "try", "remote"] },
      run_mode:       { type: "string", enum: ["sync", "background"] },
      resume_session_id: { type: "string" },
    },
    required: ["prompt"],
  },
};
```

**参数说明：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `prompt` | string（必填） | 子 agent 要执行的任务描述 |
| `description` | string | 简短描述（3-5 词） |
| `subagent_type` | string | Agent 类型，匹配定义中的 `agentType` |
| `context` | string | 额外上下文或约束信息 |
| `allowedTools` | string[] | 额外工具限制（与定义的 tools 取交集） |
| `maxTurns` | number | 最大执行轮次覆盖 |
| `isolation` | enum | 执行隔离模式 |
| `run_mode` | enum | 同步(`sync`)或后台(`background`) |
| `resume_session_id` | string | 恢复之前的子 agent session |

**枚举值动态生成：** `subagent_type` 的 `enum` 根据当前加载的所有定义动态构建，包括用户和项目自定义的 agent。

---

## 执行隔离

### isolation 模式

| 模式 | 说明 | 适用场景 |
|---|---|---|
| `"none"` | 无隔离，使用当前工作目录 | 只读探索、信息收集 |
| `"try"` | 创建独立 git worktree 执行 | 代码修改、实验性开发 |
| `"remote"` | 通过外部远程执行器执行 | 远程服务器、CI 环境 |

### try 模式

`isolation: "try"` 创建独立的 git worktree，worktree 分支名格式：`subagent-<agentType>-<description_slug>-<8-char-uuid>`

```typescript
// 主 agent 调用
{
  subagent_type: "coder",
  prompt: "实现 UserService 的单元测试",
  isolation: "try",
}
```

worktree 路径和分支信息记录在子 session 的 `branch` entry 中。

### remote 模式

`isolation: "remote"` 通过 `VERA_SUBAGENT_REMOTE_RUNNER` 环境变量指定的外部可执行文件执行。可执行文件通过 stdin 接收 JSON payload，通过 stdout 返回 JSON 结果。

```bash
export VERA_SUBAGENT_REMOTE_RUNNER="/usr/local/bin/vera-remote-runner"
export VERA_SUBAGENT_REMOTE_RUNNER_ARGS='["--workers=4"]'
```

若环境变量未设置，remote 模式回退到本地执行。

---

## 加载方式

### 编程接口

```typescript
import { loadAgentDefinitions, buildSubagentToolSchema } from "@open-vera/core";

// 加载所有定义（内置 + 用户 + 项目）
const definitions = loadAgentDefinitions({
  cwd: "/path/to/project",
  includeUser: true,  // 是否包含 ~/.vera/agents/ 下的定义
});

console.log(definitions.length);
// [
//   { agentType: "general-purpose", ..., source: "built-in" },
//   { agentType: "explore", ..., source: "built-in" },
//   { agentType: "plan", ..., source: "built-in" },
//   { agentType: "code-reviewer", ..., source: "project" },
// ]

// 构建带自定义 enum 的工具 schema
const toolSchema = buildSubagentToolSchema(definitions);
```

### 文件扫描

`loadAgentDefinitions` 扫描以下目录的 `.md` 文件：

1. `~/.vera/agents/*.md`（用户级，`source: "user"`）
2. `<cwd>/.vera/agents/*.md`（项目级，`source: "project"`）

每个 `.md` 文件按 frontmatter 解析，取正文作为 `systemPrompt`，文件名作为默认 `agentType`。同名 agent 后发现的覆盖先发现的。

---

## 子 Agent 系统提示词后缀

所有子 Agent 的系统提示词末尾自动追加 `SUBAGENT_SYSTEM_SUFFIX`：

```
You are a Vera subagent running inside a parent agent turn.
Focus only on the delegated task. Use tools as needed, then return a concise final report with:
- Result
- Key evidence or files checked
- Any blockers or risks
Do not ask the user questions unless the task is impossible without more input.
```

---

## 完整示例

### 安全审查 Agent

`.vera/agents/security-auditor.md`：

```markdown
---
name: security-auditor
description: 安全审计专用，扫描代码漏洞和依赖风险
tools: [read_file, list_dir, grep, glob, web_search]
disallowedTools: [write_file, edit_file, bash]
permissionMode: readonly
maxTurns: 60
---

你是一个 Web 安全审计专家。审查代码时关注：

1. **注入漏洞**：SQL 注入、命令注入、XSS
2. **认证与授权**：不安全的会话管理、权限绕过
3. **敏感信息**：硬编码的密钥、密码、token
4. **依赖风险**：已知漏洞的第三方库
5. **CSRF 防御**：是否正确使用 token

对每个发现给出：
- 严重等级（Critical/High/Medium/Low）
- 文件路径和行号
- 攻击场景描述
- 修复建议（附代码示例）
```

### 测试生成 Agent

`.vera/agents/test-writer.md`：

```markdown
---
name: test-writer
description: 自动生成单元测试和集成测试
tools: [read_file, write_file, list_dir, grep, glob]
permissionMode: default
maxTurns: 100
---

你是一个测试工程师。对于给定的源代码文件：

1. 分析代码结构和主要逻辑分支
2. 为每个公开函数生成单元测试（使用 Vitest）
3. 覆盖正常路径、边界条件和错误路径
4. 使用 mock 隔离外部依赖
5. 测试文件放在源文件的 tests/ 同级目录下
```
