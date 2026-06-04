# Worktree 管理

> 基于 Git worktree 的会话隔离，支持 `/try` 分支、变更合并和清理。

---

## 概述

Vera 利用 Git 原生的 `git worktree` 功能实现会话隔离。当用户通过 `/try` 命令创建实验分支时，Vera 会在 Git 仓库内创建独立的工作树（worktree），使分支的代码变更与主工作区完全分离。子 agent 在执行隔离任务时也会自动创建 worktree。

该机制确保：

- 实验性变更不会影响主工作区
- 多个 `/try` 分支可共存，互不干扰
- 子 agent 的代码变更可追踪、可合并、可丢弃

## 核心数据结构

### BranchWorktree

```typescript
interface BranchWorktree {
  worktreePath: string;   // Worktree 的文件系统路径
  worktreeBranch: string; // 对应的 Git 分支名
  baseCommit: string;     // 创建时的基准提交 SHA
  gitRoot: string;        // Git 仓库根路径
}
```

- `worktreePath`：物理路径，位于 `.vera/worktrees/<slug>`。
- `worktreeBranch`：Git 分支名，格式为 `vera-try-<slug>`。
- `baseCommit`：Worktree 创建时的 HEAD 提交，用于后续 diff 计算和变更检测。

### 会话集成

当会话携带分支信息时，`types.ts` 中的 `SessionBranch` 包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `"active" \| "discarded" \| "merged"` | 分支状态 |
| `worktreePath` | `string`（可选） | Worktree 路径 |
| `worktreeBranch` | `string`（可选） | Git 分支名 |
| `baseCommit` | `string`（可选） | 基准提交 |

## Worktree 命名与校验

### Slug 规则

Worktree 名称（slug）必须通过 `validateWorktreeSlug` 校验：

- 长度限制：1-64 字符
- 允许字符：字母、数字、点（`.`）、下划线（`_`）、短横线（`-`）
- 支持 `/` 嵌套（如 `try/experiment`），但每段不能是 `.` 或 `..`
- 无效 slug 抛出 `ValidationError`

### 路径与分支命名

```typescript
// slug: "try-experiment-a1b2c3d4"
// flattenSlug: "try-experiment-a1b2c3d4"  （将 / 替换为 +）
// worktreePath:  "<gitRoot>/.vera/worktrees/try-experiment-a1b2c3d4"
// worktreeBranch: "vera-try-try-experiment-a1b2c3d4"
```

`flattenSlug` 将 slug 中的 `/` 替换为 `+`，确保路径和分支名不会创建嵌套目录。

## 命令与使用场景

### /try -- 创建实验分支

在 REPL 中输入 `/try <name>` 将当前会话分叉到隔离 worktree：

```bash
> /try refactor-auth
Started try branch a1b2c3d4 in an isolated worktree.
Worktree: /path/to/repo/.vera/worktrees/try-refactor-auth-a1b2c3d4
Git branch: vera-try-try-refactor-auth-a1b2c3d4
```

内部流程：

1. 通过 `slugify(title)` 生成唯一 slug（基于名称 + UUID 前 8 位）
2. 调用 `createBranchWorktree(cwd, slug)` 执行 `git worktree add -B <branch> <path> HEAD`
3. 在 `.vera/worktrees/` 下创建 worktree 物理目录
4. 使用 `SessionStore.forkSession` 创建分支记录，关联 worktree 信息
5. 通过 `ctx.onResume` 切换到新分支

### /merge -- 合并实验分支变更

将 `/try` 分支中的变更应用到原始工作区：

```bash
# 合并指定分支
> /merge a1b2c3d4
Merged try branch a1b2c3d4 into /path/to/repo. Changes are left uncommitted.

# 干跑：检查冲突而不修改文件
> /merge a1b2c3d4 --check
Try branch a1b2c3d4 can be merged cleanly.

# 合并并自动移除 worktree
> /merge a1b2c3d4 --drop
Merged try branch a1b2c3d4 into /path/to/repo. Changes are left uncommitted. Worktree removed.
```

合并流程：

1. `collectWorktreeDiff`：在 worktree 中运行 `git add -N .`（包含未跟踪文件），然后 `git diff --binary <baseCommit>` 生成二进制 diff
2. `checkWorktreeDiff`（`--check` 模式）：使用 `git apply --check --3way` 预检冲突
3. `applyWorktreeDiff`（普通模式）：使用 `git apply --3way --binary` 应用 diff
4. 可选 `--drop`：合并后自动调用 `removeBranchWorktree` 清理

安全机制：

- `requireCleanTarget`：如果目标工作区有未提交的变更（排除 `.vera/worktrees`），拒绝合并。用户必须先提交、stash 或清理。
- 变更保持未提交状态，由用户决定是否提交。
- 已合并的分支不能再次合并。

### /drop -- 丢弃实验分支

```bash
> /drop a1b2c3d4
Dropped branch a1b2c3d4 and removed its clean worktree.
```

丢弃逻辑：

1. 调用 `SessionStore.discardBranch` 将分支状态标记为 `discarded`
2. 检查 worktree 是否有未合并的变更（`hasWorktreeChanges`）：
   - 无变更（无脏文件、无新提交）→ 自动删除 worktree 目录和 Git 分支
   - 有变更 → 保留 worktree 在磁盘上，防止意外数据丢失
3. 当前活跃会话不能被丢弃

### 变更检测

`hasWorktreeChanges(worktreePath, baseCommit)` 判断 worktree 是否包含未合并的修改：

- 运行 `git status --porcelain` 检查脏文件
- 运行 `git rev-list --count <baseCommit>..HEAD` 检查新提交
- 任一条件满足则返回 `true`

## 子 Agent 的 Worktree 隔离

子 agent 执行任务时，可通过 `isolation: "try"` 选项自动创建 worktree：

```typescript
// 在 subagent.ts 内部
if (isolation === "try") {
  worktree = createBranchWorktree(cwd, subagentTrySlug(description, agentType));
  childCwd = worktree.worktreePath;
}
```

子 agent worktree 的特点：

- 自动生成 slug：基于描述和 agent 类型
- `childCwd` 指向 worktree 路径——所有子 agent 文件操作在隔离环境中运行
- 完成时，worktree 信息包含在子 agent 结果中（`SubagentResult`），包含 `worktreePath`、`worktreeBranch` 和 `baseCommit`
- `remote` 隔离也作为替代方案支持（通过远程执行器而非本地 worktree）

## 会话存储集成

Worktree 信息通过会话存储层的路径：

1. **创建**：`forkSession` -> `createBranch` -> `sqlite-backend.ts` / `session-adapter.ts` 将 `worktreePath`、`worktreeBranch` 和 `baseCommit` 持久化
2. **查询**：`listSessions` 读取分支信息；REPL 的 `/branches` 命令展示带 worktree 的会话（标记 "worktree" 标签）
3. **跨 worktree 查询**：`sessionDirsFor(cwd, includeWorktrees=true)` 扫描 `git worktree list --porcelain` 输出，将所有 worktree 路径纳入会话搜索范围

## 工作区导航

REPL 中的工作区模块（`repl/workspace.ts`）处理 `/try` 分支的工作目录切换：

- 从会话摘要中读取 `branch.worktreePath`
- 如果 worktree 路径存在（`existsSync`），返回 `{ cwd: worktreePath }`
- 如果 worktree 路径缺失（手动删除或磁盘故障），输出警告并回退到原始 cwd

## 当前状态

- `/try` 命令：已完成
- `/merge` 命令（含 `--check` 和 `--drop`）：已完成
- `/drop` 命令：已完成
- 子 agent worktree 隔离（`isolation: "try"`）：已完成
- Worktree 在会话存储中的持久化：已完成（SQLite 和 JSONL 双后端）
- 跨 worktree 会话查询：已完成
- 尚未实现的功能：
  - Worktree 列表的可视化管理界面
  - Worktree 之间的 cherry-pick 合并
  - 自动过期清理策略（N 天未操作的 worktree 自动提醒）
