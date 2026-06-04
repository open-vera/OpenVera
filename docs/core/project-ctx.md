# Project Context

When Vera starts an agent, it loads project context from the filesystem and assembles it as part of the system prompt injected into the LLM. Context is composed of multi-level `VERA.md`, `CLAUDE.md`, and `.vera/rules/` rule files, supporting path scoping, priority ordering, file reference expansion, and git status injection.

---

## Architecture Overview

```
Loading flow
  User directory
    ├── ~/.vera/VERA.md              ← User-level context
    └── ~/.vera/rules/*.md           ← User-level rules
          │
  Project hierarchy (traversed upward from cwd to root)
    ├── <dir>/VERA.md                 ← Project-level context
    ├── <dir>/.vera/VERA.md           ← Project resource context
    ├── <dir>/.vera/rules/*.md        ← Project rules
    └── <dir>/VERA.local.md           ← Local private context (gitignored)
          │
  Git status snapshot
    └── branch + status + recent commits
          │
  Merge → Sort → Format → VeraContextFile[]
          │
  Inject into LLM system prompt
```

Core code is in `packages/core/src/project-context/loader.ts`.

---

## Context File Types

| Type | Value | Description |
|---|---|---|
| `user` | `"user"` | User private instructions (under `~/.vera/`), shared across all projects |
| `project` | `"project"` | Project instructions (`VERA.md`, `CLAUDE.md` under project directories) |
| `local` | `"local"` | Local private instructions (`VERA.local.md`, not version-controlled) |
| `rule` | `"rule"` | Path-scoped rules (`.vera/rules/*.md`) |

---

## Context File Format

### VERA.md / CLAUDE.md

Standard Markdown files, supporting YAML frontmatter:

```markdown
---
paths: src/**/*.ts, lib/**/*.ts
priority: -10
---

# Vera — Project Constraints

## Sensitive File Protection

The following files/directories contain local keys or temporary data and **must never be committed**:
...
```

### YAML Frontmatter Fields

| Field | Type | Description |
|---|---|---|
| `paths` | string | Comma/space-separated glob paths. Limits when this file takes effect (based on which files are modified) |
| `priority` | number | Integer sorting priority. Lower values appear first (ascending sort), default 0 |

- When `paths` is empty or absent, the context takes effect unconditionally (suitable for global project rules)
- `priority` controls the concatenation order of multiple files; files with lower priority values appear earlier in the prompt

### File Reference Expansion

The Markdown body supports `@path/to/file` syntax to reference other files. Referenced file content is automatically expanded recursively (max 5 nesting levels):

```markdown
Please refer to the following files:
@docs/api-design.md
@~/shared-conventions.md
```

- `@relative/path` resolves relative to the current file's directory
- `@/absolute/path` resolves as an absolute path
- `@~/path` expands from the user's home directory
- Referenced file frontmatter is also parsed
- Only text files are expanded (supports 60+ common extensions)

---

## Loading Order

### loadProjectContext

```typescript
import { loadProjectContext } from "@open-vera/core";

const ctx = loadProjectContext({
  cwd: "/path/to/project",
  includeUser: true,        // Whether to include user-level context, default true
  includeGitStatus: true,   // Whether to inject git status, default true
});

console.log(ctx.files.length); // Number of context files
console.log(ctx.gitStatus);    // Git status snapshot text
console.log(ctx.system);       // Formatted full system prompt
console.log(ctx.signature);    // Content signature (for detecting context changes)
```

**Loading order (top to bottom):**

1. User-level context
   - `~/.vera/VERA.md` (type: `user`)
   - `~/.vera/rules/*.md` (type: `user`)

2. Project-level context (traversed upward from cwd to root, performing the following at each level)
   - `<dir>/VERA.md` (type: `project`)
   - `<dir>/.vera/VERA.md` (type: `project`)
   - `<dir>/.vera/rules/*.md` (type: `rule`)
   - `<dir>/VERA.local.md` (type: `local`)

3. Git status snapshot (enabled by default)
   - Current branch name
   - `git status --short` (truncated to 2000 characters)
   - `git log --oneline -n 5`

All files are sorted by `priority` ascending (same priority by path alphabetically), then formatted into a single complete system prompt.

### loadNestedProjectContext

Used for loading local context during sub-directory or sub-agent execution, only loading context files along the path from cwd to targetPath:

```typescript
import { loadNestedProjectContext } from "@open-vera/core";

const nestedCtx = loadNestedProjectContext({
  cwd: "/path/to/project",
  targetPath: "packages/core/src/session/",
  loadedPaths: new Set(), // Already loaded file paths (to avoid duplicates)
});
```

Differences from `loadProjectContext`:
- Does not load user-level context (does not read `~/.vera/`)
- Does not inject git status
- Only traverses the `cwd -> targetPath` directory chain, not upward to filesystem root
- Applies glob matching filter to rules files (only includes rules matching `targetPath`)

---

## Path-Scoped Rules

### How They Work

Markdown files under `<dir>/.vera/rules/` can have a `paths` frontmatter field to limit their scope:

```markdown
---
paths: packages/core/src/**/*.ts, packages/core/src/**/*.tsx
---

# Core Package Development Conventions

- Use strict TypeScript
- All interfaces defined in types.ts
```

This file is only loaded into context when the agent operates on `.ts`/`.tsx` files under `packages/core/src/`. When operating on files in other directories, this rule is not injected.

### Glob Conversion Rules

| Pattern | Regex | Matches |
|---|---|---|
| `*.ts` | `[^/]*\.ts$` | .ts files in the current directory |
| `src/**/*.ts` | `(?:.*/)?[^/]*\.ts$` | .ts files at any depth under src |
| `config?.json` | `config[^/]\.json$` | config.json, configs.json, etc. |
| `lib/[a-z]*.js` | `lib/[a-z][^/]*\.js$` | .js files starting with lowercase letters under lib |

### Nested Directory Rules

In `loadNestedProjectContext`, each directory along the path chain loads its rules, but only rules whose glob matches `targetPath` take effect.

For example, with targetPath `packages/core/src/session/store.ts`, the path chain is:
```
/root -> /root/packages -> /root/packages/core -> /root/packages/core/src
```

The rules directory at each level is scanned, but a rule scoped to `packages/harness/**` would not be injected since it doesn't match the targetPath.

---

## Formatting Output

`formatVeraContext` concatenates the list of context files into a single text block:

```
Contents of /path/to/VERA.md (project instructions):

<file content>

Contents of /path/to/CLAUDE.md (project instructions):

<file content>

Contents of /path/to/.vera/rules/api-rules.md (project rule)
Applies to: packages/api/**/*.ts

<file content>

Vera project and user instructions are shown below. Follow them when working in this repository.
```

The format includes:
- Each file's `path`, `type` label
- `globs` shown with "Applies to: ..." when present
- `priority` shown with "Priority: ..." when present
- A leading instruction telling the LLM to follow these instructions
- Git status wrapped in a `<vera-git-status>` XML tag

### Content Truncation

Individual files exceeding 40,000 characters are automatically truncated with a `[truncated]` marker appended. Truncation occurs at whole-character boundaries, preserving UTF-8 encoding.

---

## Caching Mechanism

File reads have an in-memory cache based on `mtimeMs` (`fileCache`), avoiding repeated reads of the same file within a short time. This includes sub-files expanded via `@include`.

---

## Signature Mechanism

`signatureFor` generates a content signature string composed of each file's `path:type:priority:contentLength` and the gitStatus. The signature is used to detect context changes and trigger cache invalidation.

---

## Configuration Examples

### Global User Context

`~/.vera/VERA.md`:

```markdown
# My Coding Style Preferences

- Prefer async/await over raw Promises
- Functions should not exceed 50 lines
- All public APIs must have JSDoc comments
```

### Global Rules

`~/.vera/rules/security.md`:

```markdown
---
priority: -100
---

# Security Rules

All projects must follow:
- Do not hardcode API Keys in code
- Use environment variables for sensitive configuration
- All user input must be escaped
```

### Project-Level Context

`/project/VERA.md`:

```markdown
---
priority: 0
---

# MyProject — Project Constraints

- TypeScript strict mode
- pnpm monorepo
- Coverage >= 90%
```

### Path-Scoped Rules

`/project/.vera/rules/frontend.md`:

```markdown
---
paths: webapp/**/*.tsx, webapp/**/*.ts
priority: 10
---

# Frontend Development Conventions

- Use React 18 + hooks
- Component naming in PascalCase
- Styles use CSS Modules
```

### Local Private Context

`/project/VERA.local.md`:

```markdown
# Local Development Notes

- Test database connection: postgres://localhost:5432/testdb
- Set DEBUG=* for detailed logs when debugging
```

This file is gitignored and will not be committed to the repository.

---

## Relationship with Agent Execution

1. **Main Agent**: On each startup, `loadProjectContext(cwd)` loads full context and injects it into the system prompt
2. **Sub-agents**: During execution, `loadNestedProjectContext(cwd, targetPath)` loads local context containing only rules relevant to the target path
3. **Context signature**: Detects context changes via `signature` to decide whether the execution plan needs regeneration
