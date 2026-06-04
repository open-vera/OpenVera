# Worktree Management

> Git worktree-based session isolation, supporting `/try` branches, change merging, and cleanup.

---

## Overview

Vera leverages Git's native `git worktree` functionality to implement session isolation. When a user creates an experiment branch via the `/try` command, Vera creates an isolated working tree (worktree) within the Git repository, keeping the branch's code changes completely separate from the main workspace. Subagents also automatically create worktrees when running isolated tasks.

This mechanism ensures:

- Experimental changes never affect the main workspace
- Multiple `/try` branches can coexist without interfering with each other
- Subagent code changes are traceable, mergeable, and discardable

## Core Data Structure

### BranchWorktree

```typescript
interface BranchWorktree {
  worktreePath: string;   // Filesystem path of the worktree
  worktreeBranch: string; // Corresponding Git branch name
  baseCommit: string;     // Base commit SHA at creation time
  gitRoot: string;        // Git repository root path
}
```

- `worktreePath`: The physical path under `.vera/worktrees/<slug>`.
- `worktreeBranch`: Git branch name, formatted as `vera-try-<slug>`.
- `baseCommit`: The HEAD commit when the worktree was created, used for subsequent diff calculation and change detection.

### Session Integration

When a session carries branch information, `SessionBranch` in `types.ts` includes:

| Field | Type | Description |
|---|---|---|
| `status` | `"active" \| "discarded" \| "merged"` | Branch status |
| `worktreePath` | `string` (optional) | Worktree path |
| `worktreeBranch` | `string` (optional) | Git branch name |
| `baseCommit` | `string` (optional) | Base commit |

## Worktree Naming and Validation

### Slug Rules

Worktree names (slugs) must pass `validateWorktreeSlug` validation:

- Length limit: 1-64 characters
- Allowed characters: letters, digits, dots (`.`), underscores (`_`), dashes (`-`)
- Supports `/` nesting (e.g., `try/experiment`), but each segment must not be `.` or `..`
- Invalid slugs throw a `ValidationError`

### Path and Branch Naming

```typescript
// slug: "try-experiment-a1b2c3d4"
// flattenSlug: "try-experiment-a1b2c3d4"  (replaces / with +)
// worktreePath:  "<gitRoot>/.vera/worktrees/try-experiment-a1b2c3d4"
// worktreeBranch: "vera-try-try-experiment-a1b2c3d4"
```

`flattenSlug` replaces `/` with `+` in the slug to ensure paths and branch names do not create nested directories.

## Commands and Use Cases

### /try -- Create an Experiment Branch

Entering `/try <name>` in the REPL forks the current session into an isolated worktree:

```bash
> /try refactor-auth
Started try branch a1b2c3d4 in an isolated worktree.
Worktree: /path/to/repo/.vera/worktrees/try-refactor-auth-a1b2c3d4
Git branch: vera-try-try-refactor-auth-a1b2c3d4
```

Internal flow:

1. Generate a unique slug via `slugify(title)` (based on name + first 8 chars of UUID)
2. Call `createBranchWorktree(cwd, slug)` to execute `git worktree add -B <branch> <path> HEAD`
3. Create the worktree physical directory under `.vera/worktrees/`
4. Use `SessionStore.forkSession` to create a branch record, linking the worktree info
5. Switch to the new branch by calling `ctx.onResume`

### /merge -- Merge Experiment Branch Changes

Apply changes made in a `/try` branch back to the original workspace:

```bash
# Merge a specific branch
> /merge a1b2c3d4
Merged try branch a1b2c3d4 into /path/to/repo. Changes are left uncommitted.

# Dry-run: check for conflicts without modifying files
> /merge a1b2c3d4 --check
Try branch a1b2c3d4 can be merged cleanly.

# Merge and auto-remove the worktree
> /merge a1b2c3d4 --drop
Merged try branch a1b2c3d4 into /path/to/repo. Changes are left uncommitted. Worktree removed.
```

Merge flow:

1. `collectWorktreeDiff`: Runs `git add -N .` (includes untracked files) in the worktree, then `git diff --binary <baseCommit>` to generate a binary diff
2. `checkWorktreeDiff` (`--check` mode): Pre-checks for conflicts using `git apply --check --3way`
3. `applyWorktreeDiff` (normal mode): Applies the diff using `git apply --3way --binary`
4. Optional `--drop`: Auto-cleans up by calling `removeBranchWorktree` after merging

Safety mechanisms:

- `requireCleanTarget`: If the target workspace has uncommitted changes (excluding `.vera/worktrees`), the merge is rejected. The user must commit, stash, or clean first.
- Changes remain uncommitted; the user decides whether to commit.
- Already-merged branches cannot be merged again.

### /drop -- Discard an Experiment Branch

```bash
> /drop a1b2c3d4
Dropped branch a1b2c3d4 and removed its clean worktree.
```

Drop logic:

1. Call `SessionStore.discardBranch` to mark the branch status as `discarded`
2. Check whether the worktree has unmerged changes (`hasWorktreeChanges`):
   - No changes (no dirty files, no new commits) -> auto-delete the worktree directory and Git branch
   - Has changes -> keep the worktree on disk to prevent accidental data loss
3. The active session cannot be dropped

### Change Detection

`hasWorktreeChanges(worktreePath, baseCommit)` determines whether a worktree contains unmerged modifications:

- Runs `git status --porcelain` to check for dirty files
- Runs `git rev-list --count <baseCommit>..HEAD` to check for new commits
- Returns `true` if either condition is met

## Subagent Worktree Isolation

When a subagent executes a task, it can automatically create a worktree via the `isolation: "try"` option:

```typescript
// Inside subagent.ts
if (isolation === "try") {
  worktree = createBranchWorktree(cwd, subagentTrySlug(description, agentType));
  childCwd = worktree.worktreePath;
}
```

Subagent worktree characteristics:

- Auto-generated slug: based on description and agent type
- `childCwd` points to the worktree path -- all subagent file operations run in the isolated environment
- On completion, worktree info is included in the subagent result (`SubagentResult`), containing `worktreePath`, `worktreeBranch`, and `baseCommit`
- `remote` isolation is also supported as an alternative (via a remote executor instead of a local worktree)

## Session Store Integration

The path of worktree information through the session storage layer:

1. **Creation**: `forkSession` -> `createBranch` -> `sqlite-backend.ts` / `session-adapter.ts` persists `worktreePath`, `worktreeBranch`, and `baseCommit` into durable storage
2. **Querying**: `listSessions` reads branch info; the REPL `/branches` command displays sessions with worktrees (marked with a "worktree" label)
3. **Cross-worktree querying**: `sessionDirsFor(cwd, includeWorktrees=true)` scans `git worktree list --porcelain` output and includes all worktree paths in the session search scope

## Workspace Navigation

The workspace module in the REPL (`repl/workspace.ts`) handles working directory switching for `/try` branches:

- Reads `branch.worktreePath` from the session summary
- If the worktree path exists (`existsSync`), returns `{ cwd: worktreePath }`
- If the worktree path is missing (manually deleted or disk failure), outputs a warning and falls back to the original cwd

## Current Status

- `/try` command: complete
- `/merge` command (including `--check` and `--drop`): complete
- `/drop` command: complete
- Subagent worktree isolation (`isolation: "try"`): complete
- Worktree persistence in session store: complete (both SQLite and JSONL backends)
- Cross-worktree session querying: complete
- Features not yet implemented:
  - Visual management interface for worktree listing
  - Cherry-pick merging between worktrees
  - Auto-expiry cleanup policy (auto-reminder for worktrees untouched for N days)
