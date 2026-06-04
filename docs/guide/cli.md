# CLI Command Reference

Vera provides an interactive REPL interface with commands triggered by the `/` prefix. All commands are submitted by pressing Enter, and output is displayed as assistant messages in the conversation flow.

---

## Keyboard Shortcuts

Vera supports the following keyboard operations in the input field:

### Text Editing

| Shortcut | Function |
|---|---|
| `Ctrl+A` | Move cursor to beginning of line |
| `Ctrl+E` | Move cursor to end of line |
| `Ctrl+K` | Delete from cursor to end of line |
| `Ctrl+U` | Clear the entire line |
| `Ctrl+W` | Delete one word backward |
| `Ctrl+B` / `Ctrl+F` | Move cursor left/right by one character |
| `←` / `→` | Move cursor left/right by one grapheme |
| `Meta+←` / `Meta+→` | Move cursor left/right by one word |
| `Backspace` / `Delete` | Delete character before cursor |

### History and Search

| Shortcut | Function |
|---|---|
| `↑` / `↓` | Browse input history (when no command completion is active); navigate up/down in command completion list |
| `Ctrl+R` | Enter reverse search mode; type keywords to filter history |
| `Enter` | Accept the selected item in reverse search |
| `Esc` | Exit reverse search; close command completion list and clear input |

### Command Completion

| Shortcut | Function |
|---|---|
| `/` | Trigger command completion, showing a list of all available commands |
| `Tab` | Accept the current completion suggestion (command or file path); prioritize file path completion if candidates exist |
| `↑` / `↓` | Navigate the completion list |
| `Enter` | Accept the selected completion and submit |

### Interaction Controls

| Shortcut | Function |
|---|---|
| `Ctrl+C` | Clear input when non-empty; exit REPL when input is empty |
| `Esc` | Cancel the running request; clear input when no completion is active |
| `Enter` | Submit current input (use `Shift+Enter` or `Meta+Enter` for multi-line text) |
| `PgUp` / `PgDn` | Scroll conversation area up/down |
| `Ctrl+X` | Open current input in an external editor |
| `Meta+O` | Toggle tool output expand/collapse |

---

## Command Overview

| Command | Function | Category |
|---|---|---|
| `/help` | Show all commands | Info |
| `/status` | Show provider, model, token usage, and cost | Info |
| `/model [provider...]` | List available models | Config |
| `/provider [name]` | List or switch providers | Config |
| `/title <name>` | Set current session title | Session |
| `/sessions [--all] [--limit N] [--offset N]` | List historical sessions | Session |
| `/resume [id-prefix]` | Resume a historical session | Session |
| `/switch <id-prefix>` | Switch to a specified session | Session |
| `/branch [name]` | Create a branch from current session | Branch |
| `/try [name]` | Create a branch in an isolated git worktree | Branch |
| `/branches` | List all branches of current session | Branch |
| `/adopt <id-prefix>` | Adopt a branch and continue execution | Branch |
| `/merge [--check] [--drop] [id-prefix]` | Merge changes from a try branch | Branch |
| `/drop <id-prefix>` | Discard a branch | Branch |
| `/sub <id-prefix> [--all] [--limit N]` | View sub-agent conversation transcript | Sub-agent |
| `/subjobs [job-prefix]` | View background sub-agent tasks | Sub-agent |
| `/transcript <id-prefix>` | Same as `/sub`, view conversation transcript | Sub-agent |
| `/init` | Initialize new project config (reserved, not yet implemented) | Project |
| `/diff` | View uncommitted file changes | Tools |
| `/queue` | Show or edit queued input | Tools |
| `/exit`, `/quit` | Exit REPL | Process |

---

## Info and Config Commands

### `/help`

Display all available commands with brief descriptions.

```
/help
```

### `/status`

Display current session status: provider name, model name, cumulative token usage (input/output/cache write/cache read), API cost (broken down by model), memory usage (RSS/heap), CPU load.

```
/status
```

### `/model [provider...]`

List available models. Without arguments, lists models from all configured providers; with arguments, lists models from only the specified providers.

```
/model                        # All providers
/model anthropic              # anthropic only
/model anthropic openai       # Multiple providers
```

### `/provider [name]`

Without arguments, lists configured providers via an interactive overlay (highlighting default and adapter type). With arguments, switches to the specified provider, automatically resolves its default model, rebuilds the adapter connection, and persists the selection to `settings.json`.

```
/provider                     # Open interactive selector
/provider anthropic           # Switch to anthropic
```

---

## Session Management Commands

Vera automatically persists each conversation as a JSONL file stored under `~/.vera/projects/<encoded_cwd>/`. Each user message and assistant reply is written line by line, supporting checkpoint resume.

### `/title <name>`

Set a custom title for the current session, written as a `custom-title` entry in the JSONL.

```
/title Fix login page styling issues
```

### `/sessions [--all] [--limit N] [--offset N]`

List historical sessions, sorted by time descending. Output includes session ID, date, model, turn count, message count, file size, token usage (input/output/cache write/cache read), cumulative cost, and summary metadata.

```
/sessions                             # Current project
/sessions --all                       # All projects
/sessions --all --offset 30 --limit 20  # Paginated
```

Paginated results show a hint for calling the next page at the end.

### `/resume [id-prefix]`

Resume a historical session, loading all past messages into the current context to continue the conversation. The ID prefix must uniquely match one session.

```
/resume a1b2c3d4        # Resume by prefix
/resume                  # Open interactive session selector
```

The interactive selector supports: keyword search, arrow key navigation, Enter to confirm resume, `/` to enter filter search mode, `o` to view tool call comparison, `b` to compare branch differences, `pgup`/`pgdn` to load more pages, `u`/`d` to scroll message preview.

### `/switch <id-prefix>`

Fully switch to another session (unlike `/resume`, which restores historical context within the current session).

```
/switch a1b2c3d4
```

---

## Branch Management Commands

Vera provides a session-level branching mechanism: fork independent branches from any historical point, each with its own message history and file state, fully isolated from each other.

### `/branch [name]`

Fork a new branch from the current session and immediately switch to it. The new branch inherits the full history of the current session.

```
/branch
/branch Try rewriting the data layer with React Query
```

### `/try [name]`

Similar to `/branch`, but additionally creates a git worktree (filesystem-level isolation). Suitable for high-risk refactoring, parallel experiments, and temporary explorations.

```
/try Try upgrading to Next.js 14
```

**Process details**: Automatically creates git worktree directory, creates worktree branch, forks the session, and records the base commit SHA. Branch name format: `try-<slug>-<8-char-uuid>`.

### `/branches`

List all branches derived from the current session.

```
/branches
```

Output shows each branch's index, ID, date, status (`active`/`adopted`/`merged`/`discarded`), turn count, whether it has a worktree, and title.

### `/adopt <id-prefix>`

Adopt an existing branch, update its status to `adopted`, and switch to it to continue the conversation.

```
/adopt e5f6g7h8
```

### `/merge [--check] [--drop] [id-prefix]`

Merge file changes from a try branch (i.e., a branch with a worktree) back into the original workspace.

```
/merge e5f6g7h8             # Direct merge
/merge --check e5f6g7h8     # Dry run only
/merge --drop e5f6g7h8      # Merge and auto-cleanup worktree
```

**Limitations**: Only branches with worktrees can be merged; duplicate merges are not allowed; changes are left in the working directory without auto-commit.

### `/drop <id-prefix>`

Logically discard a branch (status marked as `discarded`, files not physically deleted). The currently active session cannot be dropped. If the worktree has no changes, the directory and git branch are automatically cleaned up; if there are changes, they are preserved.

```
/drop e5f6g7h8
```

---

## Sub-agent and Transcript

### `/sub <id-prefix> [--all] [--limit N]`

View sub-agent conversation transcript preview. Sub-agents are independent execution units launched by the main agent via the `agent` tool.

```
/sub x1y2z3w4             # View last 20 messages
/sub x1y2z3w4 --limit 50  # Up to 50 messages
/sub x1y2z3w4 --all       # Cross-project search
```

Output includes session title, branch status, turn count, cost, and truncated previews of user/assistant messages and tool calls/results.

### `/subjobs [job-prefix]`

View background sub-agent task status. Sub-agents support `run_mode: "background"` for asynchronous execution.

```
/subjobs                   # List all background tasks
/subjobs subjob-a1b2       # View specific task details
```

Task statuses: `running`, `succeeded`, `failed`.

### `/transcript <id-prefix>`

Alias for `/sub`, functionally identical.

```
/transcript x1y2z3w4
```

---

## Session Workflow Examples

### Scenario 1: Daily Conversation

```
> Help me refactor the error handling logic in this file
[agent makes changes...]
/title Refactor error handling
/status   # Check token consumption
/exit
```

### Scenario 2: Checkpoint Resume

```
# Back to the project the next day
/sessions              # Find yesterday's session ID
/resume a1b2c3d4       # Restore historical context
> Continuing from where we left off, review the remaining files
```

### Scenario 3: Branch Exploration

```
> Replace fetch with axios for the request layer
/branch replace-axios              # Fork branch to explore solution A
> Actually, let's try the ky library instead
/branch replace-ky                 # Fork branch to explore solution B
/branches                          # Compare both branches
/adopt <branch B ID>               # Choose solution B and continue
/drop <branch A ID>                # Discard solution A
```

### Scenario 4: High-Risk Refactoring (Worktree Isolation)

```
> This refactoring touches 20+ files, I'm a bit worried
/try Full data layer refactoring   # Work in isolated worktree
[agent executes in isolated worktree...]
/merge --check                     # First check if it merges cleanly
/merge --drop                      # Merge changes and clean up worktree
```

### Scenario 5: Interrupt and Continue

Press `Esc` during agent output to cancel the current request; the already-entered message goes into a queue:

```
> Help me migrate the entire project to TypeScript strict mode
[Esc — interrupted]
/queue              # View queued input
/queue drop 1       # Drop a queued item
/queue clear        # Clear the queue
> Let's skip this and try something else
```

---

## Bidirectional Interaction Flow

1. **Text Chat**: Input natural language task descriptions, press Enter to submit to the agent.
2. **Command Menu**: Type `/` to automatically show the command completion menu, supporting fuzzy matching and Tab completion.
3. **File Paths**: When typing tokens starting with `./`, `../`, `/`, or containing `/`, Tab triggers path completion.
4. **History Browsing**: Press up/down arrows on empty or existing input to browse previously submitted entries.
5. **Reverse Search**: `Ctrl+R` enters history search; type keywords to filter; use arrow keys to select; Enter to accept; Esc to exit.

---

## Implementation Summary

Commands are registered through the `COMMANDS` dictionary in `commands/index.ts`:

```typescript
const COMMANDS: Record<string, CommandFn> = {
  model: modelCommand,
  provider: providerCommand,
  help: helpCommand,
  // ...
};
```

Each command's metadata (name, description, aliases, scope) is defined in `metadata.ts` for UI-layer completion and hints. The `surface` property identifies command scope:
- `"ui"`: Pure UI commands (`/status`, `/diff`, `/queue`), do not trigger session writes
- `"runtime"`: Commands that change session or config state; output is written to JSONL
- `"process"`: Process-level commands (`/exit`, `/quit`), trigger `sessionEnd` write and exit
