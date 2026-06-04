# Skill System

Skills are Vera's pluggable capability extension mechanism — Markdown files that declare agent behavioral instructions, tool permissions, and trigger conditions. They are automatically activated at runtime based on intent, without modifying core code.

---

## 1. Skill Definition Format

A skill is a `.md` file consisting of **frontmatter (YAML metadata)** and **body (Markdown instructions)**. The body content is injected directly into the system prompt.

```
.vera/skills/            ← Project-level skills
~/.vera/skills/          ← User-level skills (global)
packages/harness/skills/ ← Built-in skills
```

### 1.1 Frontmatter Fields

```yaml
---
id: github                        # Unique identifier
name: GitHub Operations            # Display name
description: Manage PRs and issues # One-line description
triggers:                         # Trigger conditions
  - always                        #   Load on every conversation
  - domain: code                  #   When intent.domain matches
  - domain: [code, analysis]      #   Multiple domains
  - level: 2                      #   When intent.level >= 2
  - needs_tools: true             #   When tools are needed
  # No triggers → only activatable via /skill <id>
tools:                            # Reference built-in tool IDs
  - read_file
  - bash
rules:                            # Constraint rules (injected alongside body)
  - High-risk operations must require user confirmation
---
```

`triggers` supports five types: `always` (unconditional), `domain` (domain match), `level` (complexity threshold), `needs_tools` (tools needed), `explicit` (explicit activation only).

### 1.2 Full Example

```markdown
---
id: coding-rules
name: Coding Constraints
description: Basic conventions when writing code
triggers:
  - domain: code
tools:
  - read_file
  - bash
rules:
  - Read files before modifying to confirm context
  - Functions should not exceed 40 lines
---

## Coding Conventions

- Prefer reusing existing functions; don't reinvent the wheel
- Do not add unrequested error handling and comments
- Run tests after each change to confirm no regressions
```

---

## 2. Intent-Driven Activation

The system uses **intent classification -> trigger matching -> on-demand assembly** to decide which skills to activate.

### 2.1 IntentSignal

The upstream intent classifier produces an `IntentSignal`, which is the sole input to SkillResolver:

```typescript
type IntentDomain = "chat" | "code" | "search" | "writing" | "analysis" | "other";

interface IntentSignal {
  domain: IntentDomain;
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
  explicitIds?: string[];  // From /skill <id> command
}
```

### 2.2 SkillResolver Matching

`SkillResolver.resolve(intent, baseSystem)` iterates over all registered skills and matches each against triggers. A skill can have multiple triggers; matching any one activates it.

| trigger Type | Match Condition |
|-------------|----------------|
| `always` | Always matches |
| `domain` | `intent.domain` is in the domains list |
| `level` | `intent.level >= minLevel` |
| `needs_tools` | `intent.needs_tools === true` |
| `explicit` | `intent.explicitIds` contains the current skill.id |

### 2.3 SkillBundle Assembly

After matching, the Resolver assembles a `SkillBundle` passed directly to `streamAgent`:

```typescript
interface SkillBundle {
  system: string;                          // base system + each skill's systemFragment
  tools: Tool[];                           // Merged tool definitions
  executors: Map<string, ToolExecutor>;    // toolName → executor mapping
}
```

- `systemFragment` is injected into the system prompt with the `## Skill: <name> (<id>)` header
- Tools are deduplicated by name; later-registered skills do not override tools with the same name
- Lazy-loaded skills complete hydration at this stage via `skill.load()`

### 2.4 Progressive Disclosure

- Skills with `auto: true` (have non-explicit triggers) are activated automatically, transparent to the user
- Skills with `auto: false` (only explicit triggers) show only their description
- Users explicitly activate via `/skill <id>`, effective for the current conversation

---

## 3. Loading and Hot Reload

### 3.1 Loading Pipeline

```
.md file
  ↓ parseFrontmatter()    — Minimal YAML parser (no external dependencies)
  ↓ parseTriggers()       — Parse triggers list
  ↓ resolveTools()        — Resolve IDs to Tool + executor via BuiltinToolProvider
  ↓ buildSystemFragment() — Concatenate rules + body
  ↓
Skill object → Register with SkillResolver
```

### 3.2 Metadata-First + Lazy Loading

Directory scanning only parses frontmatter, not the body, reducing startup overhead:

- `loadSkillMetadataFile()` returns a Skill object with an empty `systemFragment` but carries a `load()` closure
- Only matched and activated skills call `load()` during the `hydrate()` phase to get the full content

```typescript
interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: SkillTrigger[];
  sourcePath?: string;
  load?: () => Skill;           // Lazy load: returns full Skill
  systemFragment?: string;      // Text injected into system prompt
  tools?: SkillTool[];          // { definition: Tool, executor: ToolExecutor }[]
}
```

### 3.3 Hot Reload

When skill files change, re-call `loadSkillDir()` and `registerAll()`. The Resolver's internal `Map<string, Skill>` is fully replaced; the next `resolve()` call takes effect without restarting the process.

---

## 4. Built-in Skills and Custom Skills

### 4.1 Origin Classification

```typescript
type SkillOrigin = "system" | "brand" | "user" | "marketplace";
```

| Origin | Location | Description |
|--------|----------|-------------|
| `system` | `packages/harness/skills/` | Framework built-in, shipped with Vera |
| `brand` | Organization-level directory | Team-shared brand convention skills |
| `user` | `.vera/skills/` / `~/.vera/skills/` | User-authored |
| `marketplace` | External registry | Community or third-party published |

### 4.2 Evolution Permission Control

`SkillFilter` controls automatic evolution permissions by origin:

```typescript
interface FilterOptions {
  evolvableOrigins?: SkillOrigin[];  // Default: ["user", "marketplace"]
}
```

By default, only `user` and `marketplace` skills can evolve automatically. `system` and `brand` skills are protected, preventing framework core capabilities from being accidentally modified.

### 4.3 Built-in Tool References

Built-in tool IDs are maintained by harness; skill authors reference them directly via the `tools` field:

```typescript
interface BuiltinToolProvider {
  resolve(name: string): { definition: Tool; executor: ToolExecutor } | null;
}
```

The loader calls `toolProvider.resolve(id)` at compile time, resolving string IDs into executable `SkillTool` instances.

---

## 5. Skill Authoring Guide

### 5.1 Declare, Don't Implement

Skill authors write **declaration files** responsible for defining "when to activate, what instructions to give the agent, which tools to expose"; Harness handles compilation and runtime execution.

| Author Cares About | Author Doesn't Care About |
|-------------------|--------------------------|
| When this skill activates | How MCP protocol connects |
| What instructions to give the agent | How tool executors are implemented |
| Which tools to expose (reference IDs) | How system prompts are assembled |
| What rules exist | How intent classification works |

### 5.2 File Organization

One skill per `.md` file. Group by functional domain into different directories, tiered by origin (project / user / built-in).

### 5.3 Authoring Principles

- **Use kebab-case for IDs**: `github-pr`, `coding-rules`
- **One-line description that's clear**: Used for capability list display, affects progressive disclosure experience
- **Precise trigger matching**: Avoid overusing `always` to prevent irrelevant skills from polluting the system prompt
- **Write clear boundaries in body**: Don't just cover happy paths; also specify what cannot be done
- **Iterate and improve**: Use SkillReflector's post-execution reflection for continuous improvement

---

## 6. Version Management

### 6.1 Semantic Versioning

Skills use semver, tracked via `VersionManager`:

```typescript
interface SkillVersion {
  version: string;           // Current version
  history: VersionEntry[];   // Change history
}

interface VersionEntry {
  version: string;
  changes: string[];         // Change descriptions
  timestamp: string;
  source: "reflection" | "manual" | "auto-create";
}
```

Version bump rules:
- **major**: Breaking changes (removing steps, changing output format)
- **minor**: Backward-compatible feature enhancements (adding coverage scenarios)
- **patch**: Fixes (wording improvements, edge case fixes)

### 6.2 SkillReflector — Driving Version Bumps

`SkillReflector` calls an LLM after skill execution to analyze quality and produce a `SkillReflection`:

**Four-dimension assessment:**
- **Clarity**: Are instructions unambiguous
- **Coverage**: Are edge and error scenarios covered
- **Correctness**: Do steps produce expected results
- **Efficiency**: Are there redundant steps

**Output:**
```typescript
interface SkillReflection {
  skillName: string;
  qualityScore: number;    // 0-1
  issues: ReflectionIssue[];
  needsUpdate: boolean;    // Automatically true when qualityScore < 0.8
  bumpType?: "major" | "minor" | "patch";
}
```

bumpType inference logic: has high severity issue -> major, has medium -> minor, only low -> patch.

### 6.3 SkillAutoCreator

Automatically extracts reusable skill templates from agent execution history. Produces a `SkillTemplate` when execution rounds >= `minRounds` (default 3) and confidence >= `minConfidence` (default 0.6).

---

## 7. Related Documentation

| Document | Content |
|----------|---------|
| [skill-evo.md](./skill-evo.md) | Skill evolution details (SkillReflector, SkillOptAdapter training framework) |
| [tool-runtime.md](./tool-runtime.md) | Tool runtime model, lifecycle |
| [runtime.md](./runtime.md) | Agent runtime overall architecture |

---

## 8. Current Status

| Capability | Status |
|------------|--------|
| Markdown format definition + frontmatter parsing | Implemented |
| IntentSignal-driven activation + SkillResolver | Implemented |
| Metadata-first + lazy loading | Implemented |
| Hot reload (directory rescan) | Implemented |
| Built-in tool references (BuiltinToolProvider) | Implemented |
| Evolution permission control (SkillFilter) | Types defined |
| SkillReflector four-dimension reflection | Implemented |
| SkillAutoCreator template extraction | Types defined |
| VersionManager semantic versioning | Types defined |
