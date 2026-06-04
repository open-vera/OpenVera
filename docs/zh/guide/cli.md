# CLI 命令参考

Vera 提供交互式 REPL 界面，通过 `/` 前缀触发命令。所有命令输入后按 Enter 提交，输出以 assistant 消息形式展示在对话流中。

---

## 键盘快捷键

Vera 在输入框中支持以下键盘操作：

### 文本编辑

| 快捷键 | 功能 |
|---|---|
| `Ctrl+A` | 光标移至行首 |
| `Ctrl+E` | 光标移至行尾 |
| `Ctrl+K` | 删除从光标到行尾的内容 |
| `Ctrl+U` | 清空整行 |
| `Ctrl+W` | 向前删除一个单词 |
| `Ctrl+B` / `Ctrl+F` | 光标向左/右移动一个字符 |
| `←` / `→` | 光标向左/右移动一个 grapheme |
| `Meta+←` / `Meta+→` | 光标向左/右移动一个单词 |
| `Backspace` / `Delete` | 删除光标前一个字符 |

### 历史与搜索

| 快捷键 | 功能 |
|---|---|
| `↑` / `↓` | 浏览历史输入（无命令补全时）；在命令补全列表中上下选择 |
| `Ctrl+R` | 进入反向搜索模式，输入关键词筛选历史 |
| `Enter` | 在反向搜索中接受选中项 |
| `Esc` | 退出反向搜索；关闭命令补全列表并清空输入 |

### 命令补全

| 快捷键 | 功能 |
|---|---|
| `/` | 触发命令补全，显示所有可用命令列表 |
| `Tab` | 接受当前补全建议（命令或文件路径）；如有文件路径候选则优先完成路径 |
| `↑` / `↓` | 在补全列表中选择 |
| `Enter` | 接受选中的补全并提交 |

### 交互控制

| 快捷键 | 功能 |
|---|---|
| `Ctrl+C` | 输入非空时清空输入；输入为空时退出 REPL |
| `Esc` | 取消正在运行的请求；无补全时清空输入 |
| `Enter` | 提交当前输入（多行文本需 `Shift+Enter` 或 `Meta+Enter`） |
| `PgUp` / `PgDn` | 向上/向下滚动对话区 |
| `Ctrl+X` | 在外部编辑器中打开当前输入 |
| `Meta+O` | 切换工具输出的展开/折叠 |

---

## 命令总览

| 命令 | 功能 | 类别 |
|---|---|---|
| `/help` | 显示所有命令 | 信息 |
| `/status` | 显示 provider、model、token 用量和费用 | 信息 |
| `/model [provider...]` | 列出可用模型 | 配置 |
| `/provider [name]` | 列出或切换 provider | 配置 |
| `/title <name>` | 设置当前 session 标题 | Session |
| `/sessions [--all] [--limit N] [--offset N]` | 列出历史 session | Session |
| `/resume [id-prefix]` | 恢复历史 session 继续对话 | Session |
| `/switch <id-prefix>` | 切换到指定 session | Session |
| `/branch [name]` | 从当前 session 创建分支 | 分支 |
| `/try [name]` | 在独立 git worktree 中创建分支 | 分支 |
| `/branches` | 列出当前 session 的所有分支 | 分支 |
| `/adopt <id-prefix>` | 接管一个分支继续执行 | 分支 |
| `/merge [--check] [--drop] [id-prefix]` | 合并 try 分支改动 | 分支 |
| `/drop <id-prefix>` | 丢弃一个分支 | 分支 |
| `/sub <id-prefix> [--all] [--limit N]` | 查看子 agent 对话记录 | 子 Agent |
| `/subjobs [job-prefix]` | 查看后台子 agent 任务 | 子 Agent |
| `/transcript <id-prefix>` | 同 `/sub`，查看对话记录 | 子 Agent |
| `/init` | 初始化新项目配置（预留，暂未实现） | 项目 |
| `/diff` | 查看未提交的文件变更 | 工具 |
| `/queue` | 显示或编辑排队输入 | 工具 |
| `/exit`, `/quit` | 退出 REPL | 进程 |

---

## 信息与配置命令

### `/help`

显示所有可用命令的列表及简要说明。

```
/help
```

### `/status`

显示当前会话状态：provider 名称、模型名称、累计 token 用量（输入/输出/缓存读写）、API 费用（按模型分列）、内存占用（RSS/堆）、CPU 负载。

```
/status
```

### `/model [provider...]`

列出可用模型。不带参数时列出所有已配置 provider 的模型；带参数时只列出指定 provider 的模型。

```
/model                        # 所有 provider
/model anthropic              # 仅 anthropic
/model anthropic openai       # 多个 provider
```

### `/provider [name]`

不带参数时通过交互式浮层列出已配置的 provider（标注默认项和 adapter 类型）。带参数时切换到指定 provider，自动解析其默认模型并重建 adapter 连接，同时将选择持久化到 `settings.json`。

```
/provider                     # 打开交互式选择器
/provider anthropic           # 切换到 anthropic
```

---

## Session 管理命令

Vera 将每次对话自动持久化为 JSONL 文件，存储在 `~/.vera/projects/<encoded_cwd>/` 下。每条用户消息和 assistant 回复逐行写入，支持断点续接。

### `/title <name>`

为当前 session 设置自定义标题，写入 JSONL 的 `custom-title` 条目。

```
/title 修复登录页面样式问题
```

### `/sessions [--all] [--limit N] [--offset N]`

列出历史 session，按时间倒序排列。输出包含 session ID、日期、模型、轮次数、消息总数、文件大小、token 用量（输入/输出/缓存写入/缓存读取）、累计费用、摘要元信息。

```
/sessions                             # 当前项目
/sessions --all                       # 所有项目
/sessions --all --offset 30 --limit 20  # 分页
```

分页结果末尾会提示下一页的调用方式。

### `/resume [id-prefix]`

恢复一个历史 session，将全部历史消息加载到当前 context 中继续对话。ID 前缀必须唯一匹配。

```
/resume a1b2c3d4        # 通过前缀恢复
/resume                  # 打开交互式 session 选择器
```

交互式选择器支持：输入关键词搜索、上下键选择、Enter 确认恢复、`/` 进入过滤搜索模式、`o` 查看工具调用对比、`b` 比较分支差异、`pgup`/`pgdn` 翻页加载更多、`u`/`d` 预览消息滚动。

### `/switch <id-prefix>`

彻底切换到另一个 session（与 `/resume` 不同，`/resume` 是在当前 session 内恢复历史上下文）。

```
/switch a1b2c3d4
```

---

## 分支管理命令

Vera 提供 session 级别的分支机制：从任意历史点 fork 出独立分支，各分支拥有独立的消息历史和文件状态，互不干扰。

### `/branch [name]`

从当前 session fork 新分支并立即切换过去。新分支继承当前 session 全部历史。

```
/branch
/branch 尝试用 React Query 改写数据层
```

### `/try [name]`

与 `/branch` 类似，但额外创建 git worktree（文件系统级隔离）。适用于高风险重构、并行实验、临时探索等场景。

```
/try 尝试升级到 Next.js 14
```

**流程细节**：自动创建 git worktree 目录、创建 worktree 分支、fork session 并记录 base commit SHA。分支名格式为 `try-<slug>-<8-char-uuid>`。

### `/branches`

列出从当前 session 派生的所有分支。

```
/branches
```

输出各分支的序号、ID、日期、状态（`active`/`adopted`/`merged`/`discarded`）、轮次数、是否有 worktree、标题。

### `/adopt <id-prefix>`

接管一个已存在的分支，将其状态更新为 `adopted` 并切换过去继续对话。

```
/adopt e5f6g7h8
```

### `/merge [--check] [--drop] [id-prefix]`

将 try 分支（即带有 worktree 的分支）的文件变更合并回原工作区。

```
/merge e5f6g7h8             # 直接合并
/merge --check e5f6g7h8     # 仅 dry run 检查
/merge --drop e5f6g7h8      # 合并后自动清理 worktree
```

**限制**：只能合并有 worktree 的分支；重复合并不允许；改动留在工作区不自动 commit。

### `/drop <id-prefix>`

逻辑丢弃一个分支（状态标记为 `discarded`，不物理删除文件）。不允许丢弃当前活跃 session。若 worktree 无改动则会自动清理目录和 git 分支；有改动则保留。

```
/drop e5f6g7h8
```

---

## 子 Agent 与对话记录

### `/sub <id-prefix> [--all] [--limit N]`

查看子 agent 的对话记录预览。子 agent 是主 agent 通过 `agent` 工具调起的独立执行单元。

```
/sub x1y2z3w4             # 查看最近 20 条消息
/sub x1y2z3w4 --limit 50  # 最多 50 条
/sub x1y2z3w4 --all       # 跨项目搜索
```

输出内容包括 session 标题、分支状态、轮次数、费用，以及 user/assistant 消息和 tool 调用/结果的截断预览。

### `/subjobs [job-prefix]`

查看后台子 agent 任务状态。子 agent 支持 `run_mode: "background"` 异步执行模式。

```
/subjobs                   # 列出所有后台任务
/subjobs subjob-a1b2       # 查看指定任务详情
```

任务状态：`running`（执行中）、`succeeded`（已完成）、`failed`（执行失败）。

### `/transcript <id-prefix>`

`/sub` 的别名，功能完全相同。

```
/transcript x1y2z3w4
```

---

## Session 工作流案例

### 场景一：日常对话

```
> 帮我重构这个文件的错误处理逻辑
[agent 执行更改...]
/title 重构错误处理
/status   # 查看 token 消耗
/exit
```

### 场景二：断点续接

```
# 第二天回到项目
/sessions              # 找到昨天的 session ID
/resume a1b2c3d4       # 恢复历史上下文
> 继续之前的工作，你来 review 一下剩下几个文件
```

### 场景三：分支探索

```
> 用 axios 替换 fetch 请求层
/branch 替换 axios              # fork 分支探索方案 A
> 撤回，我们试试用 ky 库
/branch 替换 ky                 # fork 分支探索方案 B
/branches                       # 对比两个分支
/adopt <分支B的ID>              # 选择方案 B 继续
/drop <分支A的ID>               # 丢弃方案 A
```

### 场景四：高风险重构（worktree 隔离）

```
> 这个重构涉及 20 多个文件，我有点担心
/try 全面重构数据层            # 在隔离 worktree 中操作
[agent 在独立 worktree 中执行...]
/merge --check                  # 先检查是否能干净合入
/merge --drop                   # 合并改动并清理 worktree
```

### 场景五：中断后继续

在 agent 输出期间按 `Esc` 取消当前请求，已输入的消息会进入排队队列：

```
> 帮我把整个项目迁移到 TypeScript strict mode
[Esc — 中断]
/queue              # 查看排队输入
/queue drop 1       # 删除某个排队项
/queue clear        # 清空队列
> 这个先不做了，换个需求
```

---

## 双向交互流程

1. **文本聊天**：直接输入自然语言描述任务，按 Enter 提交给 agent。
2. **命令菜单**：输入 `/` 自动弹出命令补全菜单，支持模糊匹配和 Tab 补全。
3. **文件路径**：输入以 `./`、`../`、`/` 开头或包含 `/` 的 token 时，Tab 键触发路径补全。
4. **历史回溯**：在空输入或已有输入上按上下键浏览历史提交记录。
5. **反向搜索**：`Ctrl+R` 进入历史搜索，输入关键词过滤，上下键选择，Enter 接受，Esc 退出。

---

## 实现概要

命令通过 `commands/index.ts` 的 `COMMANDS` 字典注册：

```typescript
const COMMANDS: Record<string, CommandFn> = {
  model: modelCommand,
  provider: providerCommand,
  help: helpCommand,
  // ...
};
```

每条命令的元数据（名称、描述、别名、作用域）定义在 `metadata.ts` 中，用于 UI 层的补全和提示。`surface` 属性标识命令作用域：
- `"ui"`：纯 UI 命令（`/status`、`/diff`、`/queue`），不触发 session 写入
- `"runtime"`：涉及 session 或配置状态变更的命令，输出写入 JSONL
- `"process"`：进程级命令（`/exit`、`/quit`），触发 `sessionEnd` 写入并退出
