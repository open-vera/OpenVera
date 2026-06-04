# Static Code Quality Scanning

> Goal: Scan for structural issues (overly long files, overly complex functions, cross-file duplication) with a single command and produce a readable report.

---

## Tool Selection

Three tools, each with a distinct responsibility, running fully in parallel with no dependencies.

### Structural Metrics: oxlint

[oxlint](https://oxc.rs/docs/guide/usage/linter.html) is the linter component of the OXC (Oxidation Compiler) toolchain, implemented in Rust with **multi-threaded parallel** scanning, 50-100x faster than ESLint.

- Built-in multi-threading, naturally supports monorepo parallelism
- Covers file length, function length, cyclomatic complexity, nesting depth, and parameter count (see table below)
- Standalone binary, fully isolated from the main ESLint configuration

### Cognitive Complexity: ESLint + sonarjs (no type-checking mode)

[eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs) provides cognitive complexity rules. Cognitive complexity is closer to "readability difficulty" than cyclomatic complexity -- deeper nesting incurs heavier penalties, and `&&`/`||` chained conditions also amplify the score.

Key point: all sonarjs rules are **pure AST analysis** and do not need TypeScript type information. Therefore, using a minimal ESLint instance with only sonarjs rules and without `parserOptions.projectService` is **10-20x faster** than a full lint:

```js
// eslint.sonarjs.config.js (independent config, does not affect main eslint.config.js)
import sonarjs from "eslint-plugin-sonarjs";
import tsParser from "@typescript-eslint/parser";

export default [{
  plugins: { sonarjs },
  languageOptions: { parser: tsParser },   // parse only, skip type resolution
  rules: {
    "sonarjs/cognitive-complexity": ["warn", 15],
    "sonarjs/no-identical-functions": "warn",
    "sonarjs/no-duplicated-branches": "warn",
  },
}];
```

### Duplication Detection: jscpd

[jscpd](https://github.com/kucherenko/jscpd) (JS Copy-Paste Detector) is the most mature cross-file duplicate code detection tool in the JS/TS ecosystem.

- Supports `--workers N` multi-process parallel tokenization
- Token-level matching (unaffected by variable renaming)
- Output in JSON / Markdown / HTML formats

> The Rust ecosystem currently has no mature cross-file duplication detector; jscpd is the only option.

### Parallel Execution Strategy

The three tools scan **completely disjoint concerns** and are launched simultaneously in the skill script:

```
skill scan
├── oxlint (structural metrics)              ~0.1s ─┐
├── eslint + sonarjs (cognitive complexity)   ~3s  ─┤─→ Promise.all → merge reports
└── jscpd (duplication)                       ~4s ─┘
```

Total time ≈ max(all three) ≈ **4s**, not the sum of all three.

---

## Metrics and Thresholds

| Category | Metric | Tool | Rule Name | warn | error |
|---|---|---|---|---|---|
| File | Total file lines | oxlint | `max-lines` | 300 | 600 |
| Function | Function body lines | oxlint | `max-lines-per-function` | 50 | 100 |
| Complexity | Cyclomatic complexity (branch count) | oxlint | `complexity` | 10 | 20 |
| Nesting | Maximum block depth | oxlint | `max-depth` | 4 | 6 |
| Parameters | Function parameter count | oxlint | `max-params` | 4 | 7 |
| Cognitive Complexity | Readability difficulty score | sonarjs | `cognitive-complexity` | 15 | — |
| Duplication | Duplicate token block | jscpd | `--min-tokens` | 50 | — |

**Threshold design principles**:
- warn = worth attention, non-blocking; error = exceeds broad industry consensus, needs refactoring
- Thresholds reference Google/Airbnb standards and SonarQube default configurations
- Duplication only produces a report, no error level (assess the current state first)

---

## Skill Design

### Input

```bash
# Scan all packages (default)
/quality-scan

# Scan only specific packages
/quality-scan packages/core

# Verbose output (list each violation location)
/quality-scan --verbose
```

### Output

Terminal summary + write to `docs/code-governance/report-<date>.md`:

```
═══════════════════════════════════════
  Vera Code Quality Scan Report  2026-04-27
═══════════════════════════════════════

[Structural Metrics] oxlint
  ✓ File length      0 error  3 warn
  ✗ Function length  2 error  8 warn
  ✓ Cyclomatic complexity  0 error  1 warn
  ✓ Nesting depth    0 error  0 warn
  ✓ Parameter count  0 error  2 warn

  Top violations:
    packages/core/src/agent/loop.ts:47  function agentLoop() 113 lines (limit: 100)
    packages/core/src/plan/repl-runner.ts:12  function run() 108 lines (limit: 100)

[Duplication] jscpd
  Duplication rate: 4.2%  (recommended < 5%)
  Duplicate blocks: 7
  Largest block: packages/harness/src/executor.ts:80–120
                packages/harness/src/runner.ts:45–85  (40 lines)

═══════════════════════════════════════
  Summary: 2 error  14 warn  duplication rate 4.2%
═══════════════════════════════════════
```

### Skill Implementation Structure

```
.claude/skills/quality-scan/
├── skill.md              # skill metadata and entry prompt
├── scan.ts               # launch three tools in parallel, merge results
├── oxlint.config.json    # oxlint rule configuration (independent of main eslint.config.js)
├── eslint.sonarjs.config.js  # minimal ESLint, only sonarjs, no type checking
└── report.ts             # format output + write Markdown report
```

`oxlint.config.json`:

```json
{
  "rules": {
    "max-lines": ["warn", { "max": 300, "skipBlankLines": true, "skipComments": true }],
    "max-lines-per-function": ["warn", { "max": 50, "skipBlankLines": true }],
    "complexity": ["warn", 10],
    "max-depth": ["warn", 4],
    "max-params": ["warn", 4]
  }
}
```

`eslint.sonarjs.config.js` (AST-only, no projectService, 10-20x faster):

```js
import sonarjs from "eslint-plugin-sonarjs";
import tsParser from "@typescript-eslint/parser";

export default [{
  plugins: { sonarjs },
  languageOptions: { parser: tsParser },
  rules: {
    "sonarjs/cognitive-complexity": ["warn", 15],
    "sonarjs/no-identical-functions": "warn",
    "sonarjs/no-duplicated-branches": "warn",
  },
}];
```

---

## Relationship with Daily Lint

| | Daily `pnpm lint` | `quality-scan` |
|---|---|---|
| Purpose | Correctness, style | Structural complexity, duplication |
| Tools | ESLint + typescript-eslint (type checking) | oxlint + ESLint/sonarjs (no type checking) + jscpd |
| Trigger | Before every commit | On demand / periodically |
| Blocks build? | Yes (on error) | No (report only) |

The three configs (`eslint.config.js` / `oxlint.config.json` / `eslint.sonarjs.config.js`) are fully independent and do not interfere with each other.

---

## To Be Evaluated

- [ ] Cognitive complexity: once oxlint supports it, it can replace cyclomatic complexity
- [ ] CI integration: auto-run scan on PR and post report as PR comment
- [ ] Trend tracking: compare multiple scan results, observe quality change curve
