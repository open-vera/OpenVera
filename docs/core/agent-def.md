# Custom Agent Definitions

Agent definitions form the configuration core of Vera's sub-agent system. Using the Markdown frontmatter format, users can declare custom agent roles, tool permissions, and execution strategies.

---

## Concepts

### What is an Agent Definition

An agent definition describes a sub-agent's identity, capability boundary, and execution strategy. When the main agent invokes a sub-agent via the `agent` tool, it matches the corresponding definition by the `subagent_type` parameter, enabling:

- Use of a custom system prompt
- Restriction of available tool scope
- Setting permission modes (read-only / full)
- Controlling maximum execution turns

### Definition Sources

Agent definitions have three sources, ordered by priority from low to high:

| Priority | Source | Directory |
|---|---|---|
| 1 (lowest) | Built-in definitions | `BUILTIN_AGENT_DEFINITIONS` constant |
| 2 | User-level definitions | `~/.vera/agents/*.md` |
| 3 (highest) | Project-level definitions | `.vera/agents/*.md` |

For agents with the same name (after `agentType` normalization), later-loaded definitions override earlier ones. Project-level definitions can override user-level and built-in definitions.

---

## Agent Definition Format

### File Structure

Each agent is defined as a `.md` file, with the filename determining the default `agentType`:

```
.vera/agents/code-reviewer.md
```

The file uses YAML frontmatter for metadata declarations and the body as the system prompt:

```markdown
---
name: code-reviewer
description: Sub-agent focused on code review and security inspection
tools: [read_file, list_dir, grep, glob]
disallowedTools: [write_file, edit_file]
permissionMode: readonly
maxTurns: 40
---

You are a senior code reviewer. Your responsibilities:

1. Carefully read the provided code
2. Check the following aspects:
   - Security vulnerabilities (SQL injection, XSS, CSRF)
   - Performance issues (unnecessary loops, memory leaks)
   - Code style (naming, single responsibility)
   - Architectural soundness (module coupling, interface design)
3. Produce a structured review report with severity ratings

Output format: List all findings in a Markdown table, each annotated with level (Critical/High/Medium/Low).
```

### Frontmatter Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` / `agentType` / `agent_type` | string | No | Agent type identifier. Defaults to filename (without extension) |
| `description` / `whenToUse` | string | No | Short description, displayed in the tool schema |
| `tools` | string or string[] | No | Available tool list. `"*"` means all tools, default `"*"` |
| `disallowedTools` / `disallowed_tools` | string[] | No | Disallowed tool list |
| `permissionMode` / `permission_mode` | `"readonly"` or `"default"` | No | Permission mode, default `"default"` |
| `maxTurns` / `max_turns` | number | No | Maximum execution turns, must be > 0 |
| body | Markdown | Yes | Full system prompt |

### Field Parsing Details

**agentType normalization:**
- Lowercased
- `_` replaced with `-`
- `"general"` is equivalent to `"general-purpose"`

**tools field:**
- Can be a string `"*"` (all tools)
- Can be an array `["read_file", "list_dir", "grep"]`
- Also supports YAML inline format `[read_file, list_dir, grep]`

**permissionMode:**
- `"readonly"`: Automatically intersects with read-only tools (`read_file`, `list_dir`, `glob`, `grep`), meaning even if `tools: "*"` is declared, only read-only tools are exposed
- `"default"`: No additional restrictions, fully follows the `tools`/`disallowedTools` configuration

**maxTurns:**
- When unset, unlimited turns (until `end_turn`)
- When set, limits the sub-agent's `streamAgent` loop count
- The `runSubagentTool` parameter `maxTurns` can override this value (taking the smaller value)

---

## Built-in Agents

Vera provides three built-in agent definitions by default:

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

A general-purpose sub-agent with full tool permissions, suitable for most multi-step tasks.

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

A read-only exploration sub-agent, dedicated to code analysis and information gathering, does not modify files.

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

A read-only planning sub-agent, dedicated to designing solutions and implementation plans, with tighter turn limits.

---

## Tool Schema

The main agent invokes sub-agents via the `agent` tool. Key parameters of the tool schema:

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

**Parameter descriptions:**

| Parameter | Type | Description |
|---|---|---|
| `prompt` | string (required) | Task description for the sub-agent to execute |
| `description` | string | Short description (3-5 words) |
| `subagent_type` | string | Agent type, matching the `agentType` in the definition |
| `context` | string | Additional context or constraint information |
| `allowedTools` | string[] | Additional tool restrictions (intersected with the definition's tools) |
| `maxTurns` | number | Override for maximum execution turns |
| `isolation` | enum | Execution isolation mode |
| `run_mode` | enum | Synchronous (`sync`) or background (`background`) |
| `resume_session_id` | string | Resume a previous sub-agent session |

**Dynamic enum generation:** The `enum` for `subagent_type` is dynamically built from all currently loaded definitions, including user and project custom agents.

---

## Execution Isolation

### isolation Modes

| Mode | Description | Use Case |
|---|---|---|
| `"none"` | No isolation, uses current working directory | Read-only exploration, information gathering |
| `"try"` | Creates an isolated git worktree for execution | Code modification, experimental development |
| `"remote"` | Executes via an external remote executor | Remote servers, CI environments |

### try Mode

`isolation: "try"` creates an independent git worktree, with worktree branch name format: `subagent-<agentType>-<description_slug>-<8-char-uuid>`

```typescript
// Main agent call
{
  subagent_type: "coder",
  prompt: "Implement unit tests for UserService",
  isolation: "try",
}
```

The worktree path and branch info are recorded in the sub-session's `branch` entry.

### remote Mode

`isolation: "remote"` executes via an external executable specified by the `VERA_SUBAGENT_REMOTE_RUNNER` environment variable. The executable receives a JSON payload via stdin and returns a JSON result via stdout.

```bash
export VERA_SUBAGENT_REMOTE_RUNNER="/usr/local/bin/vera-remote-runner"
export VERA_SUBAGENT_REMOTE_RUNNER_ARGS='["--workers=4"]'
```

If the environment variable is not set, remote mode falls back to local execution.

---

## Loading

### Programmatic Interface

```typescript
import { loadAgentDefinitions, buildSubagentToolSchema } from "@open-vera/core";

// Load all definitions (built-in + user + project)
const definitions = loadAgentDefinitions({
  cwd: "/path/to/project",
  includeUser: true,  // Whether to include definitions under ~/.vera/agents/
});

console.log(definitions.length);
// [
//   { agentType: "general-purpose", ..., source: "built-in" },
//   { agentType: "explore", ..., source: "built-in" },
//   { agentType: "plan", ..., source: "built-in" },
//   { agentType: "code-reviewer", ..., source: "project" },
// ]

// Build tool schema with custom enum
const toolSchema = buildSubagentToolSchema(definitions);
```

### File Scanning

`loadAgentDefinitions` scans `.md` files in the following directories:

1. `~/.vera/agents/*.md` (user-level, `source: "user"`)
2. `<cwd>/.vera/agents/*.md` (project-level, `source: "project"`)

Each `.md` file is parsed by frontmatter, with the body taken as `systemPrompt` and the filename as the default `agentType`. For agents with the same name, later-discovered ones override earlier ones.

---

## Sub-agent System Prompt Suffix

All sub-agents automatically get `SUBAGENT_SYSTEM_SUFFIX` appended to the end of their system prompt:

```
You are a Vera subagent running inside a parent agent turn.
Focus only on the delegated task. Use tools as needed, then return a concise final report with:
- Result
- Key evidence or files checked
- Any blockers or risks
Do not ask the user questions unless the task is impossible without more input.
```

---

## Complete Examples

### Security Audit Agent

`.vera/agents/security-auditor.md`:

```markdown
---
name: security-auditor
description: Dedicated security auditor, scans code vulnerabilities and dependency risks
tools: [read_file, list_dir, grep, glob, web_search]
disallowedTools: [write_file, edit_file, bash]
permissionMode: readonly
maxTurns: 60
---

You are a web security audit expert. When reviewing code, focus on:

1. **Injection vulnerabilities**: SQL injection, command injection, XSS
2. **Authentication and authorization**: Insecure session management, privilege bypass
3. **Sensitive information**: Hardcoded keys, passwords, tokens
4. **Dependency risks**: Third-party libraries with known vulnerabilities
5. **CSRF defense**: Whether tokens are used correctly

For each finding, provide:
- Severity level (Critical/High/Medium/Low)
- File path and line number
- Attack scenario description
- Fix recommendation (with code example)
```

### Test Generation Agent

`.vera/agents/test-writer.md`:

```markdown
---
name: test-writer
description: Auto-generate unit tests and integration tests
tools: [read_file, write_file, list_dir, grep, glob]
permissionMode: default
maxTurns: 100
---

You are a test engineer. For the given source code file:

1. Analyze the code structure and main logic branches
2. Generate unit tests for each public function (using Vitest)
3. Cover happy paths, boundary conditions, and error paths
4. Use mocks to isolate external dependencies
5. Place test files in the tests/ sibling directory of the source file
```
