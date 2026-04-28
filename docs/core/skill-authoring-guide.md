# Skill 编写指南

> 面向 skill 作者。运行时实现见 [skill-tool-integration.md](./skill-tool-integration.md)。

---

## 核心思路：声明，不是实现

Skill 作者写的是 **markdown 文件**，声明这个 skill 能做什么、需要什么资源。
Harness 的 skill-loader 负责把声明编译成运行时对象。

作者不需要写 TypeScript executor，不需要知道 MCP 协议细节，不需要手动拼 system prompt。

---

## 1. 文件结构

一个 skill 就是一个 `.md` 文件，放在约定目录下：

```
.vera/skills/           ← 项目级 skill
~/.vera/skills/         ← 用户级 skill（全局）
packages/harness/skills/ ← 内置 skill
```

文件由两部分组成：

```markdown
---
（frontmatter：声明元数据和资源依赖）
---

（body：注入 system prompt 的文本，就是普通 markdown）
```

---

## 2. Frontmatter 字段

### 基础字段

```yaml
---
id: github                        # 唯一标识，用于显式引用
name: GitHub 操作                  # 展示名
description: 管理 PR、issues、分支  # 一句话描述，用于渐进式披露
---
```

### 触发条件（何时自动激活）

```yaml
---
triggers:
  - always                        # 每次对话都加载（基础 skill）
  - domain: code                  # intent.domain 匹配时
  - domain: [code, analysis]      # 多个 domain
  - level: 2                      # intent.level >= 2 时
  - needs_tools: true             # 需要工具时
  # 不写 triggers 或写 explicit：只能通过 /skill <id> 显式激活
---
```

### 引入 MCP 服务

```yaml
---
mcp:
  - server: github                # 引用已在 vera.config 里注册的 MCP server
  - server: filesystem
    tools: [read_file, write_file] # 可选：只暴露部分工具
---
```

loader 会在启动时 connect MCP server，把拿到的 tool definitions 注入给 agent。
作者不需要写任何连接代码。

### 引入内置工具集

```yaml
---
tools:
  - bash                          # 内置工具组的 id
  - web_search
  - read_file
---
```

内置工具组由 harness 维护，skill 作者直接引用 id 即可。

### 声明 rules（约束）

rules 不是单独字段，直接写在 body 里即可 —— body 的内容会作为 system prompt 片段注入。

但如果想让 rules 在 body 之前以结构化方式声明：

```yaml
---
rules:
  - 操作前先确认目标资源存在
  - 高风险操作（删除、force push）必须获得用户确认
---
```

两种方式等价，推荐用 body 写，更自然。

---

## 3. 完整示例

### 示例一：纯指令型（coding rules）

```markdown
---
id: coding-rules
name: 编码约束
description: 写代码时的基础规范
triggers:
  - domain: code
---

## 编码规范

- 修改前先 read 文件，确认上下文
- 不添加未被要求的错误处理和注释
- 优先复用已有函数，不重复造轮子
- 函数不超过 40 行，超出考虑拆分
```

### 示例二：MCP 工具型（GitHub）

```markdown
---
id: github
name: GitHub 操作
description: 管理 PR、issues、分支、代码审查
triggers:
  - domain: code
  - needs_tools: true
mcp:
  - server: github
---

你可以操作 GitHub 仓库。常见操作：

- 查看 PR 列表和详情
- 创建、合并、关闭 PR
- 管理 issues
- 查看文件历史

**注意**：合并 PR 前确认 CI 通过；删除分支前确认已合并。
```

### 示例三：内置工具型（文件操作）

```markdown
---
id: filesystem
name: 文件系统操作
description: 读写本地文件和目录
triggers:
  - domain: code
tools:
  - read_file
  - write_file
  - list_directory
---

你可以读写本地文件。操作原则：

- 写入前先读取，了解现有内容
- 不删除文件，除非用户明确要求
```

### 示例四：组合型（代码任务完整支持）

```markdown
---
id: code-full
name: 完整代码任务支持
description: 代码编写、文件操作、GitHub 集成的完整工具集
triggers:
  - level: 2
  - domain: code
mcp:
  - server: github
tools:
  - read_file
  - write_file
  - bash
---

你是一个有完整工具支持的代码助手。

处理代码任务时：
1. 先理解现有代码结构（read 相关文件）
2. 制定修改方案，说明影响范围
3. 逐步执行，每步验证结果
4. 涉及 GitHub 操作时，确认 repo 状态后再执行
```

---

## 4. 渐进式披露的实现方式

用户不需要手动激活大部分 skill。系统在 intent 分类后自动决定加载哪些。

用户侧的感知：

```
# 自动激活（无感知）
用户：帮我把这个函数重构一下
→ intent.domain=code，自动加载 coding-rules、filesystem skill

# 显式激活（用 / 命令）
用户：/skill github
→ 本次对话追加 github skill 的工具和指令

# skill 描述作为元能力披露
用户：你能做什么？
→ agent 可以列举当前已激活的 skill 的 name + description
   对于未激活的 skill，只展示 description，用户可按需 /skill <id> 激活
```

---

## 5. Skill 作者不需要关心的事

| 关心 | 不关心 |
|------|--------|
| 这个 skill 什么时候应该激活 | MCP 协议怎么连接 |
| 给 agent 什么指令 | tool executor 怎么实现 |
| 暴露哪些工具（引用 id） | system prompt 怎么拼接 |
| rules 是什么 | intent 分类怎么做 |

---

## 6. settings.json 中注册 MCP server

Skill 里引用的 `server: github` 需要在 `.vera/settings.json` 里预先注册：

```json
{
  "mcp_servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

和 `providers`、`routing` 同级，只需配置一次，之后 skill 文件里直接引用 server 名字。

---

## 7. Skill Loader 编译流程（概述）

```
.md 文件
  ↓ parseFrontmatter()
  frontmatter + body
  ↓ resolveTools()        ← 内置工具 id → Tool + executor
  ↓ resolveMCP()          ← server name → MCPClient.listTools()
  ↓ buildSystemFragment() ← rules frontmatter + body → string
  ↓
Skill { id, trigger, systemFragment, tools[] }
  ↓ 注册到 SkillResolver
```

详细运行时接口见 [skill-tool-integration.md](./skill-tool-integration.md)。
