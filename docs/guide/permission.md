# Permission System

Vera's permission system is implemented through `SecurityPlugin`, which performs multi-layer security checks before each tool invocation, forming a defense-in-depth architecture.

---

## Architecture

```
Agent requests tool invocation
       │
       ▼
┌──────────────────────────────────────┐
│   SecurityPlugin.onBeforeToolCall    │
│                                      │
│  L0: Denylist (deniedTools) — highest priority │
│  L1: Allowlist (allowedTools)         │
│  L2: Bash command safety check        │
│  L3: Read-only mode                   │
│  L4: Budget cap                       │
│  L5: Path boundary                    │
│  L6: Domain allowlist                 │
│  L7: Prompt Injection detection       │
│                                      │
│  All pass → null (allow)             │
│  Denied    → ToolResult (with error code) │
│  Confirm   → needsConfirm (waiting for user) │
└──────────────────────────────────────┘
```

Core modules:
- `packages/core/src/tools/security.ts` — SecurityPlugin implementation
- `packages/core/src/tools/permission-rules.ts` — Rule file loading and merging
- `packages/core/src/tools/utils/path.ts` — Path boundary checks

---

## SecurityPlugin Interface

```typescript
class SecurityPlugin implements ToolLifecycleHook {
  constructor(config: SecurityConfig = {});

  // Core interception method. Returns null=allow, returns ToolResult=deny/needs confirm
  async onBeforeToolCall(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult | null>;

  // Runtime dynamic authorization of directories (called after user confirmation)
  allowPath(dir: string): void;

  // Update consumed cost (continuously called by the billing module)
  updateBudgetUsed(usdUsed: number): void;
}
```

### SecurityConfig Fields

| Field | Type | Description |
|---|---|---|
| `allowedTools` | `string[]` | Tool allowlist. Empty array or unset = allow all |
| `deniedTools` | `string[]` | Tool denylist. Higher priority than allowlist |
| `allowedBashCommands` | `string[]` | Bash command allowlist rules (glob-like patterns) |
| `deniedBashCommands` | `string[]` | Bash command denylist rules (glob-like patterns) |
| `workdir` | `string` | Base path for file operations. Defaults to `ctx.cwd` |
| `allowedDomains` | `string[]` | Domain allowlist for network tools (web_search, fetch_url) |
| `readonlyMode` | `boolean` | Deny all write operations |
| `budgetUsd` | `number` | Cost cap (USD) |
| `usdUsed` | `number` | Cost already used (updated externally in real time) |

---

## Layer Details

### L0: Denylist (Highest Priority)

If the tool name is in `deniedTools`, it is directly rejected regardless of the allowlist. Returns a `PERMISSION_DENIED` error.

```json
{ "deniedTools": ["bash", "sandbox_exec"] }
```

### L1: Allowlist

When `allowedTools` is configured and non-empty, only tools in the list are allowed. Unset or empty = allow all.

```json
{ "allowedTools": ["read_file", "write_file", "edit_file", "list_dir", "grep"] }
```

Note: Tools already denied by L0 cannot be "revived" by the allowlist.

### L2: Bash Command Safety Check

Three-tier check:

**(a) Denylist match** — If the command matches a `deniedBashCommands` glob pattern, reject immediately.

**(b) Allowlist match** — If the command matches an `allowedBashCommands` glob pattern, skip danger detection and allow directly.

**(c) Dangerous pattern detection** — If the command matches one of the following 6 hardcoded regex patterns without an allowlist exemption, return `needsConfirm`:

| Pattern | Regex | Example |
|---|---|---|
| Recursive force delete | `rm\s+(-[^\s]*[rf]\|-[^\s]*[fr])` | `rm -rf node_modules` |
| Privilege escalation | `sudo` | `sudo systemctl restart` |
| World-writable | `chmod\s+(-R\s+)?777` | `chmod -R 777 /var/www` |
| Format filesystem | `mkfs` | `mkfs.ext4 /dev/sdb` |
| Disk overwrite | `dd\s+.*\bof=` | `dd if=/dev/zero of=/dev/sda` |
| Destructive git operations | `git\s+(reset\s+--hard\|clean\s+-[^\s]*f\|push\s+--force)` | `git push --force origin main` |

After user confirmation, the REPL layer retries with the `__confirmedRisk: true` flag attached.

### L3: Read-only Mode

When `readonlyMode: true`, the following write tools are denied: `write_file`, `edit_file`, `bash`.

```json
{ "readonlyMode": true }
```

### L4: Budget Cap

When `usdUsed >= budgetUsd` (and both are configured), all tool invocations are rejected. Returns `BUDGET_EXCEEDED` error code.

```json
{ "budgetUsd": 5.0 }
```

```typescript
// Billing module continuously updates
security.updateBudgetUsed(currentTotalCost);
```

### L5: Path Boundary

File operation tools (`read_file`, `write_file`, `edit_file`, `list_dir`) check whether the target path is within the allowed range:

```
Allowed range = workdir ∪ ctx.allowedPaths ∪ securityPlugin.allowedPaths
```

1. **workdir check**: Uses the configured `workdir` (or default `ctx.cwd`) as the base; checks whether the path is within its subtree
2. **Dynamic allowlist check**: Checks whether the path falls within directories authorized via `allowPath()`
3. **Out-of-bounds handling**: If the path is not within either range, returns `PATH_OUTSIDE_CWD` error with `needsConfirm` to request user authorization

On out-of-bounds confirmation, `security.allowPath(dir)` is called, adding the directory to the session allowlist.

Path resolution uses `path.resolve(ctx.cwd, pathArg)` to ensure relative paths are correctly converted. The `isInsideCwd` function normalizes both paths and checks for prefix matching.

### L6: Domain Allowlist

For network tools like `web_search` and `fetch_url`, checks whether the target domain is in `allowedDomains`.

- Matching rules: exact match (`domain === allowedDomain`) or subdomain match (`domain.endsWith("." + allowedDomain)`)
- Non-full-URL input (e.g., search query strings) is automatically exempted
- URL parse failures are also automatically allowed

```json
{ "allowedDomains": ["github.com", "api.anthropic.com", "docs.rs"] }
```

### L7: Prompt Injection Detection

Scans string-type parameters against 6 built-in injection patterns; matching any results in rejection with a `PERMISSION_DENIED` error:

| Pattern | Attack Type |
|---|---|
| `ignore previous instructions` | Instruction override |
| `disregard (all\|your) (previous\|prior\|earlier)` | History erasure |
| `you are now` | Role hijacking |
| `new system prompt` | Prompt replacement |
| `SYSTEM: ` | Pseudo system prefix |
| `INSTRUCTION: ` | Pseudo instruction prefix |

This is regex-based heuristic detection, not a complete security solution. It may produce false positives (e.g., code documentation containing matching text). This layer is placed last; prefer the structured first six layers for defense.

---

## Permission Rule Files

### Loading and Merging

JSON rules are loaded from two locations and merged with a union strategy:

| Path | Scope |
|---|---|
| `~/.vera/permissions.json` | Global (shared across all projects) |
| `<project>/.vera/permissions.json` | Project-level (specific to current project) |

Merge strategy: The four array fields each take the union (deduplicated append, no overwrite). If the merged array is empty, no restriction is applied.

```typescript
// Load merged rules
import { loadPermissionRules } from "@open-vera/core";

const rules = loadPermissionRules("/path/to/project");
// → { allowedTools?, deniedTools?, allowedBashCommands?, deniedBashCommands? }
```

### File Format

```json
{
  "allowedTools": ["read_file", "write_file", "edit_file", "list_dir", "grep"],
  "deniedTools": ["bash", "sandbox_exec"],
  "allowedBashCommands": ["ls *", "git status", "git diff *"],
  "deniedBashCommands": ["rm *", "sudo *", "curl * | bash"]
}
```

### Glob Syntax

Bash command rules use simplified glob: `*` matches any character sequence, `?` matches a single character. Internally converted to regex for matching.

| Pattern | Matches | Does not match |
|---|---|---|
| `ls *` | `ls -la`, `ls /tmp` | `lsa` |
| `rm -rf *` | `rm -rf node_modules` | `rm -r file` |
| `git push *` | `git push origin main` | `git push-force` |
| `npm test*` | `npm test`, `npm test:coverage` | different variants of `npm test` |

---

## Error Code Quick Reference

| Error Code | Triggered By | Description |
|---|---|---|
| `PERMISSION_DENIED` | L0, L1, L2a, L3, L6, L7 | Permission rule denied |
| `PATH_OUTSIDE_CWD` | L5 | Path exceeds allowed range |
| `BUDGET_EXCEEDED` | L4 | Spending exceeds budget |

All denial errors have `retryable: true`. `needsConfirm` includes a `retry` field (parameters for re-invocation); after user confirmation, retry with the approval flag attached.

---

## Configuration Examples

### Development Environment (Relaxed)

```typescript
new SecurityPlugin({
  deniedTools: ["sandbox_exec"],
  deniedBashCommands: ["rm -rf *", "sudo *", "mkfs.*"],
  budgetUsd: 10.0,
});
```

### Code Review (Read-only)

```typescript
new SecurityPlugin({
  readonlyMode: true,
  allowedTools: ["read_file", "list_dir", "grep", "glob", "web_search", "fetch_url"],
  allowedDomains: ["github.com"],
  budgetUsd: 2.0,
});
```

### Restricted Sandbox

```typescript
new SecurityPlugin({
  deniedTools: ["bash"],
  allowedTools: ["read_file", "write_file", "edit_file", "list_dir", "grep"],
  allowedDomains: ["api.example.com"],
  workdir: "/home/user/sandbox",
  budgetUsd: 1.0,
});
```

### Global + Project Merge Example

Global `~/.vera/permissions.json`:
```json
{
  "deniedTools": ["sandbox_exec"],
  "deniedBashCommands": ["sudo *", "mkfs.*"]
}
```

Project `.vera/permissions.json`:
```json
{
  "deniedBashCommands": ["rm -rf *"],
  "allowedDomains": ["api.mycorp.com"]
}
```

After merging: `deniedTools=["sandbox_exec"]`, `deniedBashCommands=["sudo *","mkfs.*","rm -rf *"]`, `allowedDomains=["api.mycorp.com"]`

---

## Design Principles

1. **Denylist takes priority over allowlist**: L0 before L1; if a tool appears in both lists, the denylist wins
2. **Triple Bash protection**: Static deny pattern -> static allow exemption -> runtime danger detection + user confirmation
3. **Path defense in depth**: Union of `workdir` + session `allowedPaths` + user `allowPath()`
4. **Prompt Injection is a supplementary defense**: Heuristic detection may produce false positives; do not rely on it as the sole security guarantee
5. **Budget check before path check**: Intercept immediately when budget is exceeded to avoid unnecessary path confirmation interactions
