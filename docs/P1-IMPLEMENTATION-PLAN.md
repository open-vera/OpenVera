# OpenVera Complete Implementation Plan

> Branch: feature/p1-checkpoint-resume
> Goal: Full implementation from P1 to P3, matching industry SOTA agent framework capabilities
> Ordered by priority; check off each item on completion

---

## Phase 0: P0 Wrap-Up (Clear Remaining Items)

- [x] **D4** Tool Middleware full pipeline tests — before->execute->after->onError full chain (10+ tests)
- [x] **E3** Unused import cleanup — grep and remove unused imports
- [x] **E2** CHANGELOG update — record all feature branch milestones
- [x] **E1** API documentation — generate README for checkpoint-store, memory store, subagent-pool/orchestrator

---

## Phase 1: Self-Loop Runtime (P1 Core) -- COMPLETE

- [x] **S1** Create `packages/harness/src/flow/self-loop.ts` — SelfLoopRunner class skeleton
- [x] **S2** Implement loop termination conditions: confidence >= 0.9 / maxCycles (default 5) / budgetUsd / consecutive duplicate critique detection
- [x] **S3** Implement cycle_end JSONL entry writing (with critique summary, whether replanned)
- [x] **S4** Integrate into HarnessRuntime — add `runSelfLoop()` entry point in runtime.ts
- [x] **S5** SelfLoopRunner unit tests (15+ tests: normal termination, budget exceeded, infinite loop detection, replan trigger)
- [x] **S6** E2E test: plan->self-loop->critique->replan->complete full chain

## Phase 2: Critic Agent (Independent Critique Capability) -- COMPLETE

- [x] **CR1** Create `packages/harness/src/critic/critic-agent.ts` — standalone CriticAgent class
- [x] **CR2** Implement critiquePrompt template — produce structured scoring per step (issues/confidence/nextAction)
- [x] **CR3** Implement limited-round debate between main agent and critic agent (max 3 rounds)
- [x] **CR4** Integrate CriticAgent into SelfLoopRunner — auto-critique at end of each cycle
- [x] **CR5** CriticAgent tests (10+ tests: scoring, debate convergence, edge cases)

## Phase 3: Failure Recovery & Attribution -- COMPLETE

- [x] **F1** Create `packages/harness/src/runtime/failure-attributor.ts` — failure attribution module
- [x] **F2** Define failure classification enum: model/tool/permission/context/plan_deviation
- [x] **F3** Implement root cause recording to JSONL session (failure entry with category + root_cause + step_id)
- [x] **F4** Implement failure case auto-replay — extract failed step from session and re-execute
- [x] **F5** Failure attribution tests (12 tests: classification accuracy, replay, edge cases)

## Phase 4: Tool Runtime Enhancements -- COMPLETE

- [x] **T1** Idempotency control — ToolDef adds `idempotent` flag, duplicate call detection
- [x] **T2** Retryable error classification — ToolResult adds `retryable` field, retry strategy integration
- [x] **T3** Dry-run/simulate capability — ToolContext adds `dryRun` flag, tool layer support
- [x] **T4** Shell output truncation & summary enhancement — bash tool auto-summarizes long output (integrates context compression)
- [x] **T5** Tool Runtime enhancement tests (12+ tests)

## Phase 5: Subagent System Enhancement -- COMPLETE

- [x] **SA1** Parallel fan-out — orchestrator supports parallel dispatch of multiple workers
- [x] **SA2** Shared context layer — key-value on-demand sync mechanism
- [x] **SA3** Permission inheritance & usage aggregation — child agents inherit parent permissions, token usage summed
- [x] **SA4** Recursive subagent — maxDepth limit (default 3), prevents infinite recursion
- [x] **SA5** Subagent enhancement tests (10+ tests)

---

## Phase 6: Session Auto-Compression & Smart Management -- COMPLETE

- [x] **SS1** Auto session compression — auto-summarize old turns when token threshold exceeded, no manual trigger needed
- [x] **SS2** Session dedup & merge — auto-merge similar sessions to reduce storage bloat
- [x] **SS3** Session indexing — fast lookup by topic/keyword/sessionId
- [x] **SS4** Session lifecycle management — auto-clean expired sessions (configurable TTL)
- [x] **SS5** Session compression tests (8+ tests)

## Phase 7: Memory System Enhancement (Auto-Extract/Organize/Compress) -- COMPLETE

- [x] **M1** Memory auto-extraction — automatically identify high-value info during agent execution, store in semantic memory
- [x] **M2** Memory auto-organization — periodic dedup, merge similar memories, clean expired memories
- [x] **M3** Memory compression — auto-cluster large memory volumes into high-level summaries
- [x] **M4** Memory decay — importance decay based on access frequency (unretrieved memories lose weight)
- [x] **M5** Memory relationship graph — build associations between memories, support relational retrieval
- [x] **M6** Memory enhancement tests (10+ tests: auto-extract accuracy, dedup, compression quality, decay curve)

## Phase 8: Skill Auto-Extraction & Management -- COMPLETE

- [x] **SK1** Skill auto-extraction — extract reusable skill templates from successful executions
- [x] **SK2** Skill auto-summary — auto-generate summary and effectiveness score after each skill execution
- [x] **SK3** Skill recommendation — auto-recommend matching skills based on current task
- [x] **SK4** Skill versioning — auto-record versions on skill changes, support rollback
- [x] **SK5** Skill hot-reload — runtime dynamic load/unload skills without restart
- [x] **SK6** Skill enhancement tests (8+ tests)

## Phase 9: Local Storage System (SQLite + File) -- COMPLETE

- [x] **SQ1** Storage abstraction layer — `packages/core/src/storage/types.ts`, define `StorageProvider` interface
- [x] **SQ2** SQLite adapter — `packages/core/src/storage/sqlite.ts`, wrap better-sqlite3
- [x] **SQ3** File storage adapter — `packages/core/src/storage/file-store.ts`, simple key-value file storage
- [x] **SQ4** Session storage migration — migrate from JSONL to SQLite (keep JSONL compatibility layer)
- [x] **SQ5** Memory storage — semantic/episodic memory in SQLite, full-text search (FTS5)
- [x] **SQ6** User data storage — `data_save` / `data_load` tools for arbitrary structured data
- [x] **SQ7** Query interface — query historical data by time/type/keyword/relation
- [x] **SQ8** Data export — export to JSONL/CSV/JSON
- [x] **SQ9** SQLite integration tests (12+ tests: CRUD, concurrency, migration, query performance, user data access)

## Phase 10: RAG Knowledge Base -- COMPLETE

- [x] **R1** Vector store interface — `packages/core/src/rag/types.ts`, define `VectorStore` abstract interface
- [x] **R2** Local vector store — SQLite-based with self-implemented vector index (no external deps)
- [x] **R3** Embedding adapter interface — `packages/core/src/rag/embedding-adapter.ts`, unified interface
- [x] **R4** Remote embedding — OpenAI/Anthropic embedding API adapters (default)
- [x] **R5** Local embedding — interface reserved for local small models (ONNX/GGML), optional plugin
- [x] **R6** Document loader — support Markdown/JSON/TypeScript/text file batch indexing
- [x] **R7** Retrieval tool — `knowledge_search` tool, registered in ToolRegistry
- [x] **R8** Incremental indexing — auto-update vector index on file changes (mtime-based detection)
- [x] **R9** RAG integration tests (12+ tests: index accuracy, retrieval quality, incremental updates, embedding switching)

## Phase 10.1: Agent Change Tracking & Knowledge Base (CT) -- COMPLETE

- [x] **CT1** Change tracker — hook agent tool calls, record each invocation automatically
- [x] **CT2** Change store — JSONL format by date: `~/.vera/changes/YYYY-MM-DD.jsonl`
- [x] **CT3** Change query skill — `change_query` skill for querying historical changes
- [x] **CT4** Change summary generation — periodic (hourly/daily) summaries stored in episodic memory
- [x] **CT5** New session prompt injection — add change query guidance to agent system prompt
- [x] **CT6** Change tracking tests (10+ tests: hook triggers, store queries, summary generation, skill interface)

## Phase 10.2: Agent Eval System (EV) -- COMPLETE

- [x] **EV1** Eval framework — `packages/harness/src/eval/harness.ts`
- [x] **EV2** GAIA integration — `packages/harness/src/eval/runners/gaia-runner.ts` (466 questions, 3 difficulty levels)
- [x] **EV3** SWE-bench integration — `packages/harness/src/eval/runners/swe-bench-runner.ts` (2294 GitHub issues)
- [x] **EV4** ToolBench integration — `packages/harness/src/eval/runners/toolbench-runner.ts` (16464 tasks)
- [x] **EV5** Custom eval set — `packages/harness/src/eval/cases/vera-custom.json`
- [x] **EV6** Eval report generation — `packages/harness/src/eval/reporter.ts` (markdown, comparison)
- [x] **EV7** Regression detection — auto-run eval on code changes, detect degradation
- [x] **EV8** Agent Eval tests (10+ tests: framework flow, case loading, scoring logic, report generation)

## Phase 10.3: Skill Pre-training (SP) -- COMPLETE

- [x] **SP1** SkillOpt integration layer — wrap external Python SkillOpt tool
- [x] **SP2** Data preparation — convert Vera task/eval data to SkillOpt format
- [x] **SP3** Training pipeline — call SkillOpt for skill training, support resume from checkpoint
- [x] **SP4** Eval integration — evaluate Vera capabilities using SkillOpt eval sets
- [x] **SP5** Skill import — import trained best_skill.md as Vera skill with versioning + A/B comparison
- [x] **SP6** WebUI integration — optional training monitoring dashboard (Gradio)
- [x] **SP7** Skill pre-training tests (8+ tests: data conversion, training flow, skill import, versioning)

## Phase 11: Benchmark Eval System (P2 Core) -- COMPLETE

- [x] **B1** Benchmark Harness — case loading + agent execution + evaluation + report generation
- [x] **B2** Evaluator enhancements — add llm_judge / tool_match / semantic_similarity
- [x] **B3** GAIA L1 integration — import eval set, auto-scoring
- [x] **B4** Custom eval set — Vera-specific benchmark cases
- [x] **B5** Report generation — auto-produce benchmark report (pass rate, tool accuracy, flaky rate)
- [x] **B6** Regression detection — auto-run benchmarks on code changes
- [x] **B7** Benchmark tests (8+ tests)

## Phase 12: Dreaming System (P2 Core) -- COMPLETE

- [x] **DR1** Dreaming Runner — `packages/harness/src/dreaming/runner.ts`, async trigger
- [x] **DR2** Experience extraction — extract high-value insights from episodic memory + benchmark failures
- [x] **DR3** Improvement suggestion generation — produce prompt/tool policy/workflow improvement Proposals
- [x] **DR4** Dreaming scheduling — auto-trigger when idle, don't interfere with normal tasks
- [x] **DR5** Dreaming tests (6+ tests: extraction quality, suggestion actionability)

## Phase 13: Proposal Pipeline (P2 Core) -- COMPLETE

- [x] **PP1** Proposal storage — structured storage of improvement proposals (prompt/tool/workflow)
- [x] **PP2** Human review interface — Proposal marked approved/rejected/deferred
- [x] **PP3** Limited Rollout — approved Proposals auto-apply within limited scope
- [x] **PP4** Effect verification — auto-run benchmark after Rollout to verify improvement
- [x] **PP5** Rollback mechanism — auto-rollback when results don't meet expectations
- [x] **PP6** Proposal Pipeline tests (8+ tests)

## Phase 14: MCP Client Support (P3) -- COMPLETE

- [x] **MC1** MCP Client — `packages/core/src/mcp/client.ts`, connect third-party MCP servers
- [x] **MC2** MCP Tool unification — MCP tools auto-register to ToolRegistry with unified schema
- [x] **MC3** MCP permission governance — MCP tools go through SecurityPlugin hooks, not bypassing Harness
- [x] **MC4** MCP discovery — support dynamic discovery and connection of MCP servers
- [x] **MC5** MCP integration tests (8+ tests: connection, tool registration, permissions, reconnection)

## Phase 15: Multi-Agent Collaboration Network (P3) -- COMPLETE

- [x] **MN1** Message bus — `packages/core/src/network/message-bus.ts`, cross-agent communication
- [x] **MN2** Task scheduling — distributed task assignment and load balancing
- [x] **MN3** Shared memory — multi-agent shared semantic memory layer
- [x] **MN4** Permission inheritance — cross-agent permission passing and isolation
- [x] **MN5** Collaboration network tests (8+ tests)

## Phase 16: Channel Integration (Multi-Platform Messaging) -- COMPLETE

- [x] **CH1** Channel abstraction layer — define `ChannelAdapter` interface
- [x] **CH2** Channel Gateway — unified multi-channel lifecycle management
- [x] **CH3** CLI Channel — command-line interaction (interactive/non-interactive/pipe modes)
- [x] **CH4** API Channel — REST/WebSocket API for external system integration
- [x] **CH5** Webhook Channel — HTTP webhook receiver with signature verification
- [x] **CH6** Channel plugin registry — runtime dynamic load/unload channel adapters
- [x] **CH7** Channel tests (8+ tests: Gateway lifecycle, message routing, multi-channel concurrency)
- [x] **CH-FEISHU/CH-WECOM/CH-TELEGRAM/CH-DISCORD/CH-SLACK/CH-WHATSAPP** — Reserved channel plugins

## Phase 17: Adaptive Strategy System (P3) -- COMPLETE

- [x] **AD1** Strategy store — store prompt/model/tool policy config by task domain
- [x] **AD2** Historical success rate — record pass/fail per strategy, auto-calculate success rate
- [x] **AD3** Auto-tuning — auto-select optimal strategy combination based on historical data
- [x] **AD4** A/B testing — compare different strategies in parallel, data-driven decisions
- [x] **AD5** Adaptive strategy tests (6+ tests)

## Phase 18: Computer Use (Browser + Desktop Automation) -- COMPLETE

### 18A: Browser Automation
- [x] **CU1-CU4** Playwright integration, CDP protocol, browser session management, tests (8+ tests)

### 18B: Desktop Operation (Mac)
- [x] **CU5-CU9** Screenshot tool, mouse/keyboard simulation, AppleScript, Accessibility API, tests (6+ tests)

### 18C: Computer Use Tool Integration
- [x] **CU10-CU14** `computer_use` meta-tool, visual understanding, multi-step orchestration, operation replay, E2E tests (5+ tests)

### 18D: WebArena Eval
- [x] **CU15-CU16** WebArena integration, eval report

## Phase 19: Sandbox Integration (Swarm Mode) -- COMPLETE

### 19A: Sandbox Abstraction Layer
- [x] **SB1-SB4** Sandbox interface, CubeSandbox adapter, Docker adapter, sandbox tools

### 19B: Swarm Mode
- [x] **SB5-SB9** Swarm scheduler, task decomposition, result merging, capacity control, tests (8+ tests)

### 19C: Sandbox Integration Tests
- [x] **SB10-SB12** CubeSandbox E2E, Docker local sandbox E2E, swarm stress test (10 concurrent sandboxes)

## Phase 19.5: Storage Plugins (OSS/S3/TOS) -- COMPLETE

- [x] **SP1-SP8** ObjectStore interface, Alibaba OSS adapter, AWS S3 adapter (MinIO compatible), Tencent TOS adapter, local filesystem adapter, storage tools (`file_upload`/`file_download`/`file_list`), auto-upload large files, tests (8+ tests)

## Phase 20: OpenClacky-Inspired Capabilities -- MOSTLY COMPLETE

### 20A: Insert-then-Compress Strategy
- [x] **OC1-OC4** Cache-friendly compression, single cache rebuild, `<topics>` + `<summary>` output, integration tests

### 20B: Idle Auto-Compression
- [x] **OC5-OC8** IdleCompressionTimer (314s), interruptible compression, persist results, idle compression tests

### 20C: Memory Auto-Update
- [x] **OC9-OC12** MemoryUpdater subagent, merge strategy, topic-organized memory files, memory update tests

### 20D: Skill Auto-Creation & Reflective Evolution
- [x] **OC13-OC17** SkillAutoCreator, SkillReflector, version updates, skip system skills, evolution tests

### 20E: Time Machine (Task-Level Undo/Redo) -- PENDING
- [ ] **OC18-OC21** TaskSnapshot, Undo, Redo, Time Machine tests

### 20F: invoke_skill Meta-Tool -- PENDING
- [ ] **OC22-OC24** invoke_skill tool, parameter passthrough, tests

---

## Remaining Verification

- [ ] **V4** Benchmark report — GAIA L1 pass rate >= 70%
- [ ] **V5** Final CHANGELOG + roadmap sync + version bump
- [ ] **V6** Release preparation — settings.example.json update, README update, dependency check

---

## Execution Rules

1. Execute by Phase order, within each Phase by numerical order
2. Check off each item immediately on completion
3. Run full test suite after each Phase to confirm no regression
4. Phase 1-5 is P1 core (self-loop), Phase 6-8 is capability enhancement, Phase 9-10 is data layer/RAG, Phase 11-13 is P2 (self-evolution), Phase 14-18 is P3 (general platform), Phase 19 is Sandbox Swarm, Phase 19.5 is storage plugins, Phase 20 is OpenClacky-inspired

## Industry Benchmarks

This plan covers mainstream agent capabilities:

| Capability | Reference Framework |
|-----------|-------------------|
| Self-Loop Runtime | LangGraph (Plan-Act-Observe loop), CrewAI (autonomous crew) |
| Critic Agent | AutoGen (critic agent pattern), MetaGPT (reviewer role) |
| Memory Auto-Extract/Compress | MemGPT (tiered memory), Letta (memory management) |
| RAG Knowledge Base | LlamaIndex, Haystack, LangChain RAG |
| SQLite + User Data Storage | Claude Code (session storage), Cursor (local DB) |
| Skill Auto-Extract/Evolution | OpenClacky (skill_evolution + skill_reflector), OpenClaw |
| Insert-then-Compress | OpenClacky (cache-friendly compression, saves 50% cold start) |
| Idle Auto-Compression | OpenClacky (IdleCompressionTimer, 314s idle trigger) |
| Memory Subagent Update | OpenClacky (MemoryUpdater, fork subagent async update) |
| Time Machine undo/redo | OpenClacky (TaskSnapshot + file-level rollback) |
| Sandbox Swarm | CubeSandbox (Tencent open-source, microVM isolation), E2B |
| OSS/S3/TOS Storage | Alibaba OSS SDK, AWS S3 SDK, Tencent TOS SDK |
| Channel Gateway | Hermes (Telegram/Discord/Slack/WhatsApp/Teams), OpenClaw (25+ channel) |
| Computer Use | Anthropic Computer Use, OpenAI Operator, Playwright |
| Benchmark | GAIA, SWE-bench, AgentBench, WebArena |
| Dreaming/Proposal | Voyager (skill library self-improve), SPRING (reflection) |
| MCP | Anthropic MCP protocol, OpenAI function calling |
