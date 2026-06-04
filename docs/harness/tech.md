# Multi-Agent Collaboration System -- Approach Selection and Technical Decisions

> Based on the PRD (mvp.prd.md) and references such as Anthropic Harness / OpenAI Codex, this document surveys, compares, and decides on key technical choices for MVP implementation.

---

## 1. Selection Overview

| Decision Point | Choice | Alternative | Rationale |
|--------|------|------|----------|
| Runtime | Node.js 20+ LTS | Python / Bun / Deno | TypeScript type safety, mature ecosystem, native CLI toolchain compatibility |
| FSM Engine | Custom lightweight implementation | XState / Robot / Stately | PRD's FSM semantics are simple (7 states, linear + conditional branching), XState is too heavy |
| YAML Parsing | `yaml` (v2) | js-yaml / fastyaml-rs | `yaml` is native TS, type inference, spec-compliant, pnpm-verified |
| Subprocess Management | `execa` (v9) | Native child_process / zx | Promise API, streaming stdout, cross-platform, excellent error handling |
| Condition Expressions | `expr-eval` | Handwritten parser / jsep / safe-eval | Safe (no eval), lightweight, supports comparison/logical operators |
| Schema Validation | `zod` | ajv / yup / io-ts | Integrated runtime validation + type inference, top choice in TS ecosystem |
| Logging | `pino` | winston / bunyan | Best performance (NDJSON native), low overhead, mature ecosystem |
| Config Merging | `deepmerge-ts` | lodash.merge | Zero dependencies, TS-friendly, type-safe |
| Test Framework | `vitest` + `@testing-library` | jest / mocha | Unified with Vite ecosystem, fast, native TS |
| Build Tool | `tsup` | tsc / esbuild / rollup | Zero config, esbuild under the hood, dts generation, CLI-friendly |

---

## 2. Detailed Selection Analysis

### 2.1 Runtime: Node.js 20+ LTS

**Selection rationale:**
- Target Agents (Claude Code, Codex, Gemini CLI, OpenCode) are all Node.js ecosystem CLI tools
- `child_process.spawn` provides native stdin/stdout/stderr stream control
- npm ecosystem covers all dependencies
- LTS versions (20.x / 22.x / 24.x) have long-term support

**Comparative analysis:**

| | Node.js | Python | Bun | Deno |
|--|---------|--------|-----|------|
| Subprocess control | spawn native support | subprocess mature | Compatible with Node API | Permission model imposes many restrictions |
| Agent ecosystem | Done natively compatible | No needs cross-language adaptation | Caution compatible but unstable | No permission sandbox conflicts |
| Type safety | TypeScript | mypy/pyright | TypeScript | TypeScript |
| Deployment complexity | Zero extra dependencies | Needs venv/pip | Needs Bun installed | Needs Deno installed |
| Performance | Sufficient (I/O bound) | Sufficient | Faster | Comparable |

**Decision: Node.js 20+ LTS, TypeScript 5.x**

---

### 2.2 FSM Orchestration Engine: Custom Lightweight Implementation

**PRD requirements:**
- 7 states (INIT -> PROPOSE -> CRITIQUE -> REFINE -> DECIDE -> AWAITING_APPROVAL -> END)
- Linear flow + conditional branching + looping + parallel (fan-out/fan-in)
- Config-driven (YAML FlowConfig)

**Candidate comparison:**

| Option | Bundle size | Learning curve | Parallel support | Config-driven | Suitability |
|------|--------|----------|----------|----------|--------|
| **Custom implementation** | 0 | Low | Self-implemented | Native support | Excellent |
| XState v5 | ~15KB gzipped | High | Not natively supported | Needs translation layer | Low |
| `@xstate/fsm` | ~1KB gzipped | Medium | Not supported | Not supported | Minimal |
| Robot | ~1KB | Low | Not supported | Not supported | Minimal |
| Stately (SaaS) | Cloud dependency | Medium | Supported | Needs API | Low |

**Decision: Custom lightweight implementation.**

Rationale:
1. The PRD's FSM semantics describe a **config-driven scheduler**, not a traditional UI state machine
2. The core logic = iterate over steps array -> execute current step -> evaluate condition -> transition state
3. XState's statechart concepts (hierarchical states, history states, delayed transitions) are over-engineering for this scenario
4. A custom implementation natively supports YAML config, parallel fan-out, and condition expression evaluation
5. Expected code size < 500 lines, highly maintainable

**Implementation outline:**
```typescript
class FSMOrchestrator {
  private currentStep: number;
  private state: FSMStateName;

  async step(): Promise<TransitionResult> {
    const stepDef = this.config.steps[this.currentStep];
    // 1. Evaluate condition
    // 2. Execute step (single or parallel fan-out)
    // 3. Evaluate break_condition
    // 4. Transition to next state
  }
}
```

---

### 2.3 YAML Parsing: `yaml` (v2)

**Candidate comparison:**

| Option | Weekly downloads | TS support | Spec compliance | Type inference | Maintenance status |
|------|-----------|---------|----------|----------|----------|
| **`yaml` v2** | ~30M | Done native | YAML 1.2 | Done strongly typed | Active (v3 RC in progress) |
| js-yaml | ~40M | No needs @types | YAML 1.1 | No none | Slow maintenance |
| fastyaml-rs | Emerging | Done native | YAML 1.2.2 | Done | Early stage |

**Decision: `yaml` v2.**

Rationale:
- pnpm has already migrated from js-yaml to `yaml`, clear community trend
- Native TypeScript, excellent type inference (`YAML.parse<FlowConfig>(str)`)
- YAML 1.2 spec, avoids js-yaml's 1.1 compatibility issues
- Supports `!!set`, `!!omap` and other advanced types (for future expansion)

---

### 2.4 Subprocess Management: `execa` v9

**PRD requirements:**
- Spawn subprocess, bidirectional stdin/stdout stream communication
- Timeout control, retry, graceful termination (SIGTERM -> SIGKILL)
- Cross-platform compatibility (macOS/Linux/Windows)

**Candidate comparison:**

| Option | Weekly downloads | Promise API | Streaming output | Timeout control | Graceful termination | Cross-platform |
|------|-----------|-------------|----------|----------|----------|--------|
| **`execa` v9** | ~114M | Done | Done | Done | Done | Done |
| Native child_process | Built-in | No needs wrapping | Done | No needs wrapping | Caution needs wrapping | Done |
| zx | ~20M | Done | Caution limited | Caution limited | No | Done |
| shelljs | ~5M | No | No | No | No | Done |

**Decision: `execa` v9.**

Rationale:
- 114M weekly downloads, de facto standard
- Native Promise + async iterable stdout, perfect fit for NDJSON streaming parse
- Built-in timeout, cleanup, graceful termination
- Cross-platform path handling

**Key usage:**
```typescript
const subprocess = execa('claude', ['--output-format', 'json', '-p', prompt], {
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 120_000,
  env: { ANTHROPIC_API_KEY }
});

// Stream stdout
for await (const line of subprocess.iterable()) {
  // Heuristic JSON extraction
}
```

---

### 2.5 Condition Expressions: `expr-eval`

**PRD requirements:**
- Support `==`, `!=`, `>`, `>=`, `<`, `<=`, `&&`, `||`, `!`
- Variables derived from Blackboard state
- **Forbid use of `eval()`**

**Candidate comparison:**

| Option | Size | Security | Operator support | Maintenance status |
|------|------|--------|------------|----------|
| **`expr-eval`** | ~5KB | Done sandboxed | Done all | Active |
| jsep | ~3KB | Done sandboxed | Done needs plugin | Active |
| safe-eval | ~10KB | Caution limited | No limited | Inactive |
| Handwritten parser | Custom | Done | Needs implementation | Needs maintenance |

**Decision: `expr-eval`.**

Rationale:
- Safe sandboxed execution, no `eval()` risk
- Lightweight (5KB), zero dependencies
- Supports all PRD-defined operators
- Simple variable injection: `Parser.parse(expr).evaluate(context)`

---

### 2.6 Schema Validation: `zod`

**PRD requirements:**
- Runtime validation of Agent message format
- Coupled with TypeScript types
- Readable error messages (for L2 error handling)

**Candidate comparison:**

| Option | Weekly downloads | Type inference | Runtime validation | Error messages | Bundle size |
|------|-----------|----------|------------|----------|-------------|
| **`zod`** | ~25M | Done | Done | Done detailed | ~13KB |
| ajv | ~15M | No needs generation | Done | Done detailed | ~40KB |
| yup | ~5M | Caution limited | Done | Done | ~15KB |
| io-ts | ~2M | Done | Done | Caution complex | ~10KB |

**Decision: `zod`.**

Rationale:
- De facto standard in TS ecosystem, zero-cost type inference
- `z.infer<typeof schema>` generates types directly from schema
- Structured error messages usable for L2 error correction prompts
- Two-way alignment possible with PRD TypeScript type definitions

---

### 2.7 Logging: `pino`

**PRD requirements:**
- NDJSON format (consistent with transport protocol)
- Low overhead (dense Agent invocations)
- Support sanitization (API Key filtering)

**Candidate comparison:**

| Option | Performance | NDJSON native | Ecosystem | Sanitization support |
|------|------|-------------|------|----------|
| **`pino`** | Best | Done | Mature | Done custom serializer |
| winston | Good | No needs config | Mature | Done but complex config |
| bunyan | Good | Done | Inactive | Done |

**Decision: `pino`.**

Rationale:
- Best performance (async writes, object pooling)
- Native NDJSON output, naturally consistent with PRD trace log format
- Custom serializer for API Key sanitization
- pino-pretty for readable output during development

---

### 2.8 Build Tool: `tsup`

**Candidate comparison:**

| Option | Config complexity | Build speed | d.ts generation | CLI-friendly |
|------|------------|----------|-----------|----------|
| **`tsup`** | Zero config | Best | Done | Done |
| tsc | Needs tsconfig | Slow | Done | Caution |
| esbuild | Needs config | Best | No | Caution |
| rollup | Complex | Good | Done | Done |

**Decision: `tsup`.**

Rationale:
- Zero config, based on esbuild (extremely fast)
- Auto-generates d.ts
- Native CLI entry support (`bin` field)
- Single-line config gets it done

---

## 3. Dependency List

### Production Dependencies

```json
{
  "dependencies": {
    "yaml": "^2.6.0",
    "execa": "^9.5.0",
    "zod": "^3.24.0",
    "pino": "^9.6.0",
    "expr-eval": "^2.0.2",
    "deepmerge-ts": "^7.1.0"
  }
}
```

### Dev Dependencies

```json
{
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.3.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "pino-pretty": "^13.0.0"
  }
}
```

### Dependency Size Estimates

| Dependency | Package size | Unpacked | Description |
|------|--------|--------|------|
| yaml | 370KB | 1.2MB | YAML parsing |
| execa | 50KB | 200KB | Subprocess |
| zod | 13KB | 60KB | Schema validation |
| pino | 80KB | 300KB | Logging |
| expr-eval | 5KB | 20KB | Expression evaluation |
| deepmerge-ts | 10KB | 30KB | Deep merge |
| **Total** | **~528KB** | **~1.8MB** | Lightweight |

---

## 4. Architecture Decision Records (ADR)

### ADR-001: Custom FSM instead of XState

**Status:** Accepted
**Context:** PRD defines a 7-state FSM supporting conditional branching, loops, and parallelism.
**Decision:** Use a custom lightweight implementation, not XState.
**Rationale:**
- XState's statechart model (nested states, history states, delayed transitions) is over-engineering for this scenario
- The PRD's FSM is essentially a **config-driven step scheduler** -- just iterate over the steps array
- Custom implementation natively supports YAML config and condition expressions
- Code size < 500 lines, highly maintainable
**Consequences:** Need to self-implement parallel fan-out/fan-in logic, but complexity is manageable.

### ADR-002: NDJSON instead of Length-Prefix Framing

**Status:** Accepted
**Context:** PRD defines two message framing formats.
**Decision:** Use NDJSON for MVP, Length-Prefix as alternative.
**Rationale:**
- NDJSON is human-readable, easy to debug (`tail -f trace.ndjson`)
- CLI tools natively support line output
- Heuristic JSON extractor can handle noise
**Consequences:** Need to implement a robust JSON extraction pipeline (already detailed in PRD section 4.1.1).

### ADR-003: single-shot prioritized over long-running

**Status:** Accepted
**Context:** PRD defines two Agent access modes.
**Decision:** MVP only implements single-shot mode; long-running (MCP) deferred to v2.
**Rationale:**
- Single-shot is simple to implement, no need for heartbeat, persistent sessions, or incremental context
- Claude Code / Gemini CLI single-shot mode is sufficient for MVP validation
- Reduces MVP complexity, quickly validates core protocol
**Consequences:** Each call requires restarting the process, incurring startup overhead. Acceptable for MVP phase.

### ADR-004: File-level Artifacts instead of in-memory sharing

**Status:** Accepted
**Context:** Harness documents emphasize "Context must crystallize into artifacts".
**Decision:** Blackboard in-memory implementation + async persistence to files (WAL mode).
**Rationale:**
- In-memory implementation is simple, meets single-shot mode requirements
- WAL persistence provides crash recovery capability (PRD section 19)
- File-level handoff reserves interface for v2 long-running mode
**Consequences:** Need to implement WAL write and recovery logic, but complexity is manageable.

### ADR-005: Enforced heterogeneous model separation

**Status:** Accepted
**Context:** PRD section 13 prevents Groupthink, requiring proposer and critic to use different models.
**Decision:** Enforce validation in `role_mapping` config; proposer and critic in the same session cannot use the same provider.
**Rationale:**
- Same-source models easily produce consensus drift
- Config-layer validation catches issues earlier than runtime detection
**Consequences:** Users must configure at least two different Agent providers.

---

## 5. Key Design Principles Extracted from References

### 5.1 Anthropic Harness Insights

| Principle | Source | Embodiment in this system |
|------|------|-----------------|
| Role separation > More Agents | Effective Agents | proposer / critic / judge strictly separated |
| Independent evaluation > Self-evaluation | Harness Design | critic does not see proposer reasoning |
| Context reset > Long context | Context Engineering | context reset between sessions |
| Failure attribution > Simple retry | Harness Design | L1-L4 error classification + attribution |
| Stronger model, simpler harness | Harness Evolution | MVP stays lean, evolves with model |

### 5.2 OpenAI Codex Insights

| Principle | Source | Embodiment in this system |
|------|------|-----------------|
| Codebase readable by Agent | Engineering in Agentic World | AGENTS.md entry document, structured handoff files |
| Mechanically encode architecture invariants | Engineering in Agentic World | Blackboard write constraints + Schema validation |
| Continuous garbage collection | Engineering in Agentic World | Trace Log + Cost tracking + Resource limits |
| Environment design > Code writing | Engineering in Agentic World | FlowConfig config-driven, Adapter abstraction |

### 5.3 Harness Methodology Insights

| Principle | Source | Embodiment in this system |
|------|------|-----------------|
| Define completion before execution | 00-overall-plan | `done-criteria` injected at session_init |
| Break long tasks into phases | 00-overall-plan | FSM step splitting + max_rounds hard termination |
| Validate close to real usage | 00-overall-plan | critic review mirrors real usage scenarios |
| Context crystallizes into files | 00-overall-plan | Blackboard persistence + WAL |
| Don't let substandard results through | 03-anti-patterns | Human-in-the-Loop approval + Gate mechanism |

---

## 6. MVP Implementation Roadmap

### Phase 1: Core Protocol (Week 1)

**Goal:** Get single-shot linear flow running

| Module | File | Dependencies | Description |
|------|------|------|------|
| Type definitions | `src/types/*.ts` | zod | All PRD chapter 20 types |
| NDJSON transport | `src/transport/ndjson-stream.ts` | None | Encoding/decoding + heuristic extraction |
| Claude Code Adapter | `src/adapters/claude-code.ts` | execa | single-shot mode |
| Gemini CLI Adapter | `src/adapters/gemini-cli.ts` | execa | single-shot mode |
| Basic FSM | `src/orchestrator/fsm.ts` | expr-eval | Linear flow |
| Blackboard | `src/blackboard/blackboard.ts` | zod | In-memory implementation + write constraints |

**Acceptance criteria:**
```bash
vera run --flow minimal --task "Review this function"
# Output: PROPOSE -> CRITIQUE -> DECIDE -> END
# Generates sessions/{id}/trace.ndjson
```

### Phase 2: Robustness (Week 2)

| Module | File | Description |
|------|------|------|
| Error retry | `src/error/retry.ts` | L1/L2 retry strategy |
| Conditional branching | `src/orchestrator/fsm.ts` | condition / break_condition |
| Termination mechanism | `src/orchestrator/termination.ts` | Hard/soft termination |
| YAML loading | `src/config/loader.ts` | FlowConfig / agents.yaml / adapters.yaml |
| Trace Log | `src/observability/tracer.ts` | pino + NDJSON file |
| Cost tracking | `src/observability/cost-tracker.ts` | Token statistics |

### Phase 3: Observability + CLI (Week 3)

| Module | File | Description |
|------|------|------|
| CLI entry | `src/cli/run.ts` | vera run command |
| Runtime interaction | `src/cli/interactive.ts` | Ctrl+C / p / r / s |
| Approval UI | `src/cli/approval.ts` | Diff / Accept / Reject / Edit / Skip |
| Replay | `src/observability/replay.ts` | trace.ndjson playback |
| Security | `src/security/sanitizer.ts` | API Key redaction |

---

## 7. Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|------|------|----------|
| Agent CLI interface changes | Adapter breakage | Medium | Version pinning + adaptation tests |
| High NDJSON extraction failure rate | Flow interruption | Medium | Heuristic extraction pipeline + L2 retry |
| Slow single-shot startup | Poor UX | High | Warm-up mechanism (parallel spawn) |
| Cost spiraling | Financial risk | Low | Resource limits + cost warnings |
| Custom FSM difficult to extend | Technical debt | Low | Interface abstraction + test coverage |

---

## 8. Reference Document Index

| Document | Path | Purpose |
|------|------|------|
| PRD full plan | `mvp.prd.md` | System architecture, protocol, type definitions |
| Anthropic Harness | `anthropic/` | Multi-agent patterns, Harness design |
| Harness methodology | `harness/` | Role separation, failure attribution, maturity model |
| OpenAI practices | `OpenAI/` | Large-scale Agent engineering practices |
