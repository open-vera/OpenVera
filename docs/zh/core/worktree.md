# Worktree Management（工作树管理）

> 基于 Git worktree 的会话隔离机制，支持 `/try` 分支、变更合并与清理。

---

## 概述

Vera 利用 Git 原生的 `git worktree` 功能实现会话隔离。当用户通过 `/try` 命令创建实验分支时，Vera 会在 Git 仓库中创建一个独立的工作树（worktree），将分支的代码变更与主工作区完全隔离。Subagent 在执行隔离任务时也会自动创建 worktree。

这种机制确保：
- 实验性修改不影响主工作区
- 多个 `/try` 分支可以并行存在，互不干扰
- Subagent 的代码变更可追溯、可合并、可丢弃

## 核心数据结构

### BranchWorktree

```typescript
interface BranchWorktree {
  worktreePath: string;   // 工作树的文件系统路径
  worktreeBranch: string; // 对应的 Git 分支名
  baseCommit: string;     // 创建时的基准 commit SHA
  gitRoot: string;        // Git 仓库根路径
}
```

- `worktreePath`：工作树在 `.vera/worktrees/<slug>` 下的物理路径。
- `worktreeBranch`：Git 分支名，格式为 `vera-try-<slug>`。
- `baseCommit`：创建 worktree 时的 HEAD commit，用于后续 diff 计算和变更检测。

### 在 Session 中的体现

当 Session 包含分支信息时，`types.ts` 中的 `SessionBranch` 会携带：

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `"active" \| "discarded" \| "merged"` | 分支状态 |
| `worktreePath` | `string`（可选） | worktree 路径 |
| `worktreeBranch` | `string`（可选） | Git 分支名 |
| `baseCommit` | `string`（可选） | 基准 commit |

## 工作树命名与验证

### Slug 规则

worktree 名称（slug）必须通过 `validateWorktreeSlug` 验证：

- 长度限制：1-64 个字符
- 允许的字符：字母、数字、点 (`.`)、下划线 (`_`)、短横线 (`-`)
- 支持 `/` 嵌套（如 `try/experiment`），但每个段都不能是 `.` 或 `..`
- 无效 slug 会抛出 `ValidationError`

### 路径与分支名

```typescript
// slug: "try-experiment-a1b2c3d4"
// flattenSlug: "try-experiment-a1b2c3d4"  （将 / 替换为 +）
// worktreePath:  "<gitRoot>/.vera/worktrees/try-experiment-a1b2c3d4"
// worktreeBranch: "vera-try-try-experiment-a1b2c3d4"
```

`flattenSlug` 将 slug 中的 `/` 替换为 `+`，确保路径和分支名中不会出现嵌套目录。

## 使用场景与命令

### /try —— 创建实验分支

在 REPL 中输入 `/try <name>` 会将当前会话 fork 到一个隔离的 worktree 中：

```bash
> /try refactor-auth
Started try branch a1b2c3d4 in an isolated worktree.
Worktree: /path/to/repo/.vera/worktrees/try-refactor-auth-a1b2c3d4
Git branch: vera-try-try-refactor-auth-a1b2c3d4
```

内部流程：

1. 通过 `slugify(title)` 生成唯一 slug（基于名称 + UUID 前 8 位）
2. 调用 `createBranchWorktree(cwd, slug)` 执行 `git worktree add -B <branch> <path> HEAD`
3. 在 `.vera/worktrees/` 目录下创建 worktree 物理目录
4. 通过 `SessionStore.forkSession` 创建分支记录，关联 worktree 信息
5. 调用 `ctx.onResume` 切换到新分支

### /merge —— 合并实验分支的变更

将 `/try` 分支中产生的代码变更合并回原工作区：

```bash
# 合并指定分支
> /merge a1b2c3d4
Merged try branch a1b2c3d4 into /path/to/repo. Changes are left uncommitted.

# 检查合并是否会有冲突（不影响文件）
> /merge a1b2c3d4 --check
Try branch a1b2c3d4 can be merged cleanly.

# 合并后自动删除 worktree
> /merge a1b2c3d4 --drop
Merged try branch a1b2c3d4 into /path/to/repo. Changes are left uncommitted. Worktree removed.
```

合并流程：

1. `collectWorktreeDiff`：在 worktree 中执行 `git add -N .`（包含未跟踪文件），然后 `git diff --binary <baseCommit>` 生成二进制 diff
2. `checkWorktreeDiff`（`--check` 模式）：用 `git apply --check --3way` 预检查冲突
3. `applyWorktreeDiff`（正常模式）：用 `git apply --3way --binary` 应用 diff
4. 可选 `--drop`：合并后自动调用 `removeBranchWorktree` 清理

安全机制：

- `requireCleanTarget`：目标工作区如有未提交变更（`.vera/worktrees` 目录除外），合并会被拒绝。用户需先 commit、stash 或 clean。
- 变更保持 uncommitted，由用户自行决定是否提交。
- 已经 merged 的分支不能重复合并。

### /drop —— 丢弃实验分支

```bash
> /drop a1b2c3d4
Dropped branch a1b2c3d4 and removed its clean worktree.
```

丢弃逻辑：

1. 调用 `SessionStore.discardBranch` 将分支状态标记为 `discarded`
2. 检查 worktree 是否有未合并的变更（`hasWorktreeChanges`）：
   - 无变更（no dirty files, no new commits）→ 自动删除 worktree 目录和 Git 分支
   - 有变更 → worktree 保留在磁盘上，防止误删重要代码
3. 不能丢弃当前活动会话

### 变更检测

`hasWorktreeChanges(worktreePath, baseCommit)` 判断 worktree 是否包含未合并的修改：

- 执行 `git status --porcelain` 检查是否有 dirty files
- 执行 `git rev-list --count <baseCommit>..HEAD` 检查是否有新 commit
- 任一条件满足即返回 `true`

## Subagent 的 Worktree 隔离

Subagent 在执行任务时，可通过 `isolation: "try"` 选项自动创建 worktree：

```typescript
// subagent.ts 内部逻辑
if (isolation === "try") {
  worktree = createBranchWorktree(cwd, subagentTrySlug(description, agentType));
  childCwd = worktree.worktreePath;
}
```

Subagent worktree 的特点：

- 自动生成 slug：基于描述和 agent 类型
- `childCwd` 指向 worktree 路径，subagent 的所有文件操作都在隔离环境中执行
- 执行完成后，worktree 信息写入 subagent 的返回结果（`SubagentResult`），包含 `worktreePath`、`worktreeBranch`、`baseCommit`
- 支持 `remote` 隔离方式作为 alternative（通过远程执行器而非本地 worktree）

## Session Store 集成

Worktree 信息在 session 存储层的贯穿路径：

1. **创建时**：`forkSession` → `createBranch` → `sqlite-backend.ts` / `session-adapter.ts` 将 `worktreePath`、`worktreeBranch`、`baseCommit` 存入持久化存储
2. **查询时**：`listSessions` 读取分支信息，REPL `/branches` 命令会显示有 worktree 的 session（标注 "worktree" 标记）
3. **跨 worktree 查询**：`sessionDirsFor(cwd, includeWorktrees=true)` 会扫描 `git worktree list --porcelain` 输出，将所有 worktree 路径纳入 session 搜索范围

## 工作区导航

REPL 中的 workspace 模块（`repl/workspace.ts`）处理 `/try` 分支的工作目录切换：

- 从 session summary 读取 `branch.worktreePath`
- 如果 worktree 路径存在（`existsSync`），返回 `{ cwd: worktreePath }`
- 如果 worktree 路径缺失（被手动删除或磁盘故障），输出警告并回退到原 cwd

## 当前状态

- `/try` 命令：已完成
- `/merge` 命令（含 `--check` 和 `--drop`）：已完成
- `/drop` 命令：已完成
- Subagent worktree 隔离（`isolation: "try"`）：已完成
- Session store 中的 worktree 持久化：已完成（SQLite + JSONL 双后端）
- 跨 worktree session 查询：已完成
- 尚未实现的功能：
  - Worktree 列表的可视化管理界面
  - Worktree 之间的 cherry-pick 合并
  - 自动过期清理策略（一定天数未操作的 worktree 自动提醒）
