# Vera CLI 命令参考

> Vera REPL 内的所有斜杠命令及其详细用法。在 REPL 中输入 `/help` 可查看简洁版命令列表。

---

## 概述

Vera REPL 是一个交互式对话终端，以 Ink (React TUI) 构建。所有命令以 `/` 开头，区分大小写。命令参数用空格分隔，多词参数直接拼接（如 `/title my new session`）。

**退出命令**：`/exit` 或 `/quit`（别称）均可退出 REPL。

---

## 会话管理命令

### /sessions

列出当前项目的历史会话。

```
/sessions [--all] [--offset N] [--limit N]
```

| 参数 | 说明 |
|---|---|
| `--all` | 跨所有项目搜索会话（默认只搜当前项目） |
| `--offset N` | 分页偏移量，从第 N 条开始 |
| `--limit N` | 每页显示条数，默认 30 |

输出表头：`# SESSION ID DATE MODEL TURNS MSGS SIZE IN OUT CACHE_W CACHE_R COST DETAILS`。当结果超过一页时，末尾会提示下一页命令。

### /resume

恢复一个历史会话。

```
/resume [session-id-prefix]
```

- **无参数**：如果有 session picker UI，则打开交互式选择器；否则列出前 10 个可用会话作为提示
- **带 ID 前缀**：按 session ID 前缀匹配并加载该会话的完整历史和上下文
- 前缀必须能唯一匹配一个会话；若有多个匹配则列出所有匹配项

示例：
```
/resume abc12345       # 恢复到 ID 以 abc12345 开头的会话
/resume                # 打开会话选择器或列出可用会话
```

### /switch

切换到指定的会话或分支。

```
/switch <session-id-prefix>
```

与 `/resume` 类似，但不加载历史（仅切换活动会话指针）。适用于分支间快速跳转。

示例：
```
/switch def67890       # 切换到 ID 以 def67890 开头的会话
```

### /title

设置当前会话的标题。

```
/title <session title>
```

标题将持久化到会话文件，在 `/sessions` 列表中可见。

示例：
```
/title 修复登录超时问题
```

---

## 分支管理命令

Vera 支持在会话中途创建分支，实现"假设性对话"（what-if exploration），分支之间可独立对话，最终选择合并或丢弃。

### /branch

从当前会话 fork 一个新分支。

```
/branch [name]
```

- fork 会复制当前会话的完整历史，新分支拥有独立的 session ID
- `name` 参数可选，用于设置分支标题
- fork 后 REPL 自动切换到新分支继续对话

示例：
```
/branch                       # 创建匿名分支
/branch 尝试异步方案           # 创建带标题的分支
```

### /try

从当前会话 fork 到隔离的 git worktree 中执行。与 `/branch` 不同，`/try` 会在物理文件系统中创建一个独立的 git worktree 目录，其中的文件修改不会影响原始工作区。

```
/try [name]
```

- 创建隔离的 git worktree 目录
- 自动创建对应的 git branch，命名格式为 `try-{slug}-{uuid8}`
- fork 会话并关联到该 worktree
- REPL 自动切换到新分支

示例：
```
/try 重构router
/try
```

### /branches

列出当前会话的所有分支。

```
/branches
```

输出格式：`序号 ID 日期 状态 对话轮数 worktree标记 标题`。

### /adopt

接管（adopt）一个分支，标记为已采纳并从该分支路线继续对话。

```
/adopt <branch-id-prefix>
```

- 只能 adopt 未被丢弃的分支
- adopt 后 REPL 切换到该分支继续

示例：
```
/adopt abc12345
```

### /merge

将 try 分支的 worktree 修改合并回原始工作区。

```
/merge [--check] [--drop] [branch-id-prefix]
```

| 参数 | 说明 |
|---|---|
| `--check` | 仅检查是否可以干净合并，不实际执行合并 |
| `--drop` | 合并成功后删除 worktree 目录和对应的 git branch |
| `branch-id-prefix` | 目标 try 分支的 ID 前缀（省略则使用当前会话） |

合并结果以未提交的改动形式留在原始工作区，由用户自行决定是否 git commit。已合并的分支会标记 `merged` 状态，不可重复合并。

示例：
```
/merge --check abc12345            # 检查分支是否可合并
/merge --drop abc12345             # 合并分支并删除 worktree
/merge                             # 合并当前 try 分支
```

### /drop

丢弃一个分支。

```
/drop <branch-id-prefix>
```

- 逻辑丢弃，标记分支为 `discarded` 状态
- 不会删除会话文件（可用于审计）
- 如果分支有关联 worktree 且无改动，自动清理 worktree
- 不能丢弃当前活跃会话

示例：
```
/drop abc12345
```

---

## Subagent 命令

### /sub

查看 subagent 的执行实录（transcript）预览。

```
/sub <session-id-prefix> [--all] [--limit N]
```

| 参数 | 说明 |
|---|---|
| `--all` | 跨所有项目搜索 |
| `--limit N` | 显示最后 N 条消息，默认 20 |

该命令常配合 subagent 返回的 Transcript ID 使用，用于事后检查 subagent 的推理过程。

### /subjobs

查看后台 subagent 任务状态。

```
/subjobs [job-id-prefix]
```

- **无参数**：列出所有后台任务（最近 20 个），格式 `Job ID Status AgentType Transcript Prompt`
- **带 ID 前缀**：显示指定任务的详细信息（状态、agent 类型、时间、结果/错误）

示例：
```
/subjobs                    # 列出所有后台任务
/subjobs subjob-abc123      # 查看特定任务详情
```

### /transcript

`/sub` 的别称，功能完全相同。

---

## 模型与 Provider 命令

### /model

列出可用的 LLM 模型。

```
/model [provider-name ...]
```

- **无参数**：列出所有已配置 provider 的模型
- **带 provider 名**：只列出指定 provider 的模型

每个模型显示其 ID、显示名（如有别名）和上下文窗口大小（如可用）。

示例：
```
/model                        # 列出所有模型
/model anthropic openai       # 只列 anthropic 和 openai
```

### /provider

列出或切换 LLM provider。

```
/provider           # 列出所有已配置的 provider
/provider <name>    # 切换到指定 provider
```

- **无参数**：列出 provider 列表，显示适配器类型、base_url、默认标记（◀ default）
- **带 name**：切换到该 provider 并自动选择默认模型
- 切换后会自动更新 `.vera/settings.json` 中的 `default_provider` 字段

示例：
```
/provider                     # 列出
/provider anthropic           # 切换到 anthropic
```

### /status

显示当前 provider、模型、token 使用量和费用。

```
/status
```

输出包括：当前 provider 名称、模型别名、已消耗的 input/output token 数、缓存 token 数、累计费用（USD）。

---

## 帮助与退出

### /help

显示所有可用命令的简明列表。

```
/help
```

### /exit, /quit

退出 REPL。

```
/exit
/quit
```

---

## 键盘快捷键

Vera REPL 基于 Ink 构建，支持标准终端输入控制：

| 按键 | 功能 |
|---|---|
| `Enter` | 发送消息 |
| `Ctrl+C` | 中断当前操作 / 退出 |
| `Esc` | 取消操作（双击 Esc 可触发双 Esc 事件） |
| `Tab` | 自动补全提示 |
| `Backspace` | 删除前一个字符 |
| `Delete` | 删除后一个字符 |
| `↑ / ↓` | 历史消息浏览（上下箭头） |
| `← / →` | 光标左右移动 |
| `PageUp / PageDown` | 页面上下滚动 |
| `Meta+Backspace` | 删除前一个单词 |

---

## 典型会话管理工作流

### 场景一：创建 → 分支 → 合并

```
# 1. 发起一段对话
用户: 帮我分析登录模块的性能瓶颈

# 2. 对分析结果满意后，起一个 try 分支做实验性修改
/try 性能优化实验

# 3. 在隔离 worktree 中修改代码
用户: 重构 login.ts，改用异步缓存

# 4. 确认修改有效后合并回原工作区
/merge --check     # 先检查
/merge --drop      # 合并并清理 worktree
```

### 场景二：探索多条路径

```
# 1. 主对话中发现问题
/branch 方案A-线程池

# 2. 回到主会话探讨另一个方案
/switch <main-session-id>

# 3. 再起一个分支
/branch 方案B-协程

# 4. 列出所有分支，比较结果
/branches

# 5. 选择最佳方案
/adopt <方案A的id>
```

### 场景三：跨会话继续工作

```
# 1. 启动 REPL 后查看历史
/sessions

# 2. 恢复昨天的会话
/resume <yesterday-id>

# 3. 查看该会话中的 subagent 执行记录
/sub <subagent-transcript-id>
```

---

## 其他命令

### /diff

查看当前工作区的未提交改动。属于 UI 层命令。

```
/diff
```

---

## 命令索引速查

| 命令 | 用途 | 参数 |
|---|---|---|
| `/help` | 显示帮助 | 无 |
| `/exit`, `/quit` | 退出 REPL | 无 |
| `/status` | 查看当前状态 | 无 |
| `/diff` | 查看未提交改动 | 无 |
| `/sessions` | 列出会话历史 | `--all`, `--offset N`, `--limit N` |
| `/resume` | 恢复会话 | `[id-prefix]` |
| `/switch` | 切换会话 | `<id-prefix>` |
| `/title` | 设置标题 | `<title>` |
| `/branch` | 创建分支 | `[name]` |
| `/try` | 创建worktree分支 | `[name]` |
| `/branches` | 列出分支 | 无 |
| `/adopt` | 接管分支 | `<id-prefix>` |
| `/merge` | 合并try分支 | `[--check] [--drop] [id-prefix]` |
| `/drop` | 丢弃分支 | `<id-prefix>` |
| `/sub` | 查看subagent实录 | `<id-prefix> [--all] [--limit N]` |
| `/subjobs` | 后台任务状态 | `[job-prefix]` |
| `/transcript` | `/sub` 别称 | 同 `/sub` |
| `/model` | 列出模型 | `[provider...]` |
| `/provider` | 切换provider | `[name]` |
