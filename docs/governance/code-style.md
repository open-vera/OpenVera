# Code Governance Standards

> Mandatory code standards for the Vera monorepo. Violating any entry marked "mandatory" will result in PR rejection.

## 1. Module Organization (Mandatory)

Vera uses a two-tier pnpm workspace monorepo structure:

| Package | Responsibility | Dependency Direction |
|---|---|---|
| `packages/core` | Single LLM call loop, **stateless**. Unaware of Harness, Session, Flow. | No internal dependencies |
| `packages/harness` | Multi-step workflow orchestration, **stateful**. ExecutionPlan -> Flow State -> Critique -> Replan. | `harness -> core` |

**Hard constraint**: `harness -> core`, Core must never import Harness. `tsconfig` is configured to detect this; violations cause compilation errors.

Internal module organization:
1. **Interface first**: define `types.ts` first, then write implementation.
2. **Barrel export**: every directory must have an `index.ts` exporting only public API.
3. **Single responsibility**: one file does one thing. Consider splitting beyond 300 lines.
4. **Tests nearby**: test files go in the `tests/` subdirectory.

## 2. Naming Conventions (Mandatory)

| Category | Style | Example |
|---|---|---|
| File name | `kebab-case.ts` | `self-loop.ts`, `vector-store.ts` |
| Type / Interface | `PascalCase` | `SelfLoopRunner`, `VectorStore` |
| Function / Variable | `camelCase` | `runSelfLoop`, `embeddingAdapter` |
| Constant | `UPPER_SNAKE_CASE` | `MAX_CYCLES`, `DEFAULT_TIMEOUT` |
| Enum member | `PascalCase` | `FlowStatus.Running` |
| Generic parameter | Single uppercase letter | `T` (generic), `K` (key), `V` (value) |

## 3. TypeScript Strict Rules (Mandatory)

- `tsconfig.json` must have `"strict": true`
- **No `any`**: always use `unknown` + type guard as replacement
- **ESM modules** (`"module": "nodenext"`): import paths must include `.js` extension

```typescript
// Wrong
function parse(data: any): any { ... }

// Correct
function parse(data: unknown): ParsedResult {
  if (typeof data !== 'object' || data === null) {
    throw new ValidationError('expected object');
  }
  return data as ParsedResult;
}
```

## 4. Error Handling (Mandatory)

**No `throw new Error(string)`**. Must use typed error classes defined in `packages/core/src/errors.ts`:

```typescript
// Wrong
throw new Error('invalid state');

// Correct
import { ValidationError, StateError } from '../errors.js';
throw new ValidationError('FlowState requires at least one step');
```

## 5. Async Programming (Mandatory)

Prefer `async/await`. No raw Promise chains (`.then().catch()`):

```typescript
// Wrong
function load(): Promise<Data> { return fetch().then(parse).catch(handle); }

// Correct
async function load(): Promise<Data> {
  try { return parse(await fetch()); }
  catch (err) { return handle(err); }
}
```

Use `Promise.all` for independent concurrent operations; keep sequential `await` for dependent ones.

## 6. Import Order (Mandatory)

Order as external -> internal -> relative, with blank lines between groups:

```typescript
import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

import { FlowRunner } from '@open-vera/core';

import { harnessConfig } from '../config.js';
import type { SessionStore } from './types.js';
```

## 7. Comment Standards

- **Only write WHY, not WHAT**. Code itself explains what it does; comments explain why.
- Public API uses JSDoc to annotate parameters and return values.
- Temporary workarounds use `// TODO(username): description`.

## 8. Commit Format (Mandatory)

Format: **`<type>(<scope>): <description>`**

| type | Meaning | scope | Meaning |
|---|---|---|---|
| `feat` | New feature | `core` / `harness` | Core packages |
| `fix` | Bug fix | `tool` / `agent` | Tools/agents |
| `refactor` | Refactoring | `memory` / `rag` | Memory/retrieval |
| `test` | Tests | `sandbox` / `channel` | Sandbox/channel |
| `docs` | Documentation | — | — |
| `chore` | Miscellaneous | — | — |

Constraints:
- description in English, lowercase start, no ending period
- Single commit focuses on one module, diff <= 500 lines (except docs/tests)
- Check `git status` before committing; no `git add -A` without careful review

Example: `feat(memory): add auto-extraction from agent execution`

## 9. Test Standards (Mandatory)

**No tests = not done. Commits are not allowed.**

| Requirement | Description |
|---|---|
| Framework | Vitest, using `describe` / `it` / `expect` |
| File naming | `<module-name>.test.ts`, placed in `tests/` subdirectory |
| Overall coverage | >= 70% |
| Core module coverage | >= 80% (`tools/` `storage/` `adapters/` `config/` `memory/` `context/` `utils/`) |
| Core package lines coverage | **>= 90%** |
| Mock strategy | Only mock external APIs (LLM adapter, network), do not mock internal modules |
| E2E tests | Placed in `packages/harness/tests/e2e-*.ts` |

Verification command:

```bash
pnpm --filter @open-vera/core run test:coverage
```

## 10. PR Checklist

### Code Quality
- [ ] No `any` (use `unknown` + type guard when needed)
- [ ] Error handling uses typed error classes
- [ ] Async uses `async/await`, no raw Promise chains
- [ ] Import paths have `.js` extension, order external -> internal -> relative

### Test & Build
- [ ] `pnpm --filter @open-vera/core run test:coverage` coverage >= 90%
- [ ] New business logic has corresponding unit tests
- [ ] `pnpm typecheck` && `pnpm test` && Core build all pass

### Quality Scan
- [ ] `bash .claude/skills/quality-scan/scan.sh` has no errors

### Doc Sync
- [ ] Roadmap completed items marked `✅`, new leftover items appended to corresponding sections
- [ ] `docs/changelog.md` summary appended, `docs/changelog/<YYYY-MM-DD-HH>.md` detailed record written

### Security Check
- [ ] `git status` shows no sensitive files in staged
- [ ] No API Key residue, no conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`)

## 11. Sensitive File Protection (Mandatory)

The following **must never be committed under any circumstances**:

| Path | Reason |
|---|---|
| `.vera/settings.json` | LLM API Key |
| `.qwen/` | Qwen local config |
| `.claude/settings.local.json` | Claude Code local settings |
| `.claude/worktrees/` | Temporary worktrees |
| `.gemini/` | Gemini local config |
| `*.orig` | Merge/backup temp files |

Operating rules:
1. No `git add .` / `git add -A`; add files selectively
2. If sensitive files have modifications, use `git restore` to discard
3. When writing `.vera/settings.json`, use placeholders from `settings.example.json`
4. **Never** paste API Keys in CLAUDE.md, README, code comments, or commit messages

## 12. Static Analysis Tools

| Tool | Purpose | Pass Criteria |
|---|---|---|
| **oxlint** | TS/JS syntax and style checking | 0 error |
| **sonarjs** | Code quality and security (cognitive complexity, vulnerability patterns) | 0 error |
| **jscpd** | Duplicate code detection | Duplication rate > 10% needs evaluation |
| **TypeScript Compiler** | Type checking | 0 error |

Run commands:

```bash
bash .claude/skills/quality-scan/scan.sh   # full scan
pnpm typecheck                              # type check only
```

Quality gates:
- **oxlint / sonarjs error**: must fix, blocks commit
- **warning**: recommended to fix, non-blocking, but should not keep growing
- **jscpd high duplication rate**: evaluate whether common logic can be extracted

## 13. Architecture Constraints (Mandatory)

1. **Dependency direction**: `harness -> core`, reverse is forbidden
2. **External dependencies**: new additions require justification in PR; prefer reusing existing ones
3. **Storage layer abstraction**: persistence through interfaces (`VectorStore`, `SessionStore`, `MemoryStore`), no hardcoded implementations
4. **Sandbox isolation**: external code execution must go through the Sandbox abstraction layer; `child_process.exec` directly on user code is strictly forbidden
5. **Channel abstraction**: message platforms connected through the `ChannelAdapter` interface, no direct platform SDK calls

---

## Appendix: Quick Self-Check Script

```bash
#!/bin/bash
set -e
echo "=== TypeCheck ===" && pnpm typecheck
echo "=== Test ===" && pnpm test
echo "=== Core Build ===" && pnpm --filter @open-vera/core build
echo "=== Core Coverage ===" && pnpm --filter @open-vera/core run test:coverage
echo "=== Quality Scan ===" && bash .claude/skills/quality-scan/scan.sh
echo "=== Sensitive Files ===" && git status --short | grep -qE '\.vera/settings\.json|\.qwen/|settings\.local\.json|\.gemini/' && echo "WARNING!" || echo "OK"
echo "=== Conflict Markers ===" && rg -n "<<<<<<<|=======|>>>>>>>" . && echo "WARNING!" || echo "OK"
echo "=== Done ==="
```
