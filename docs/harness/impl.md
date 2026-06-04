# Multi-Agent MVP Implementation Record

## Implemented (P0 MVP)

### Monorepo Architecture

pnpm workspace monorepo, 4 packages:

| Package | Description | Status |
|----|------|------|
| `@vera/types` | Shared types + Zod Schemas | Done |
| `@vera/core` | Orchestration engine + Agent adapters + CLI | Done |
| `@vera/server` | HTTP API Server (browser mode) | Done |
| `@vera/web-ui` | Vue 3 frontend + Tauri desktop app | Done |

### Core Engine (@vera/core)

- **TypeScript types + Zod Schema** -- All protocol, Agent, Blackboard, Flow, Session type definitions in `packages/types/src/`
- **NDJSON Transport** -- ANSI stripping, heuristic JSON extraction, streaming parse
- **Blackboard** -- In-memory implementation, role-based write constraints, critic reasoning isolation, optimistic-lock version control
- **FSM Orchestrator** -- State machine orchestration, condition expression evaluation (expr-eval), termination judgment, system prompt template injection
- **Config Loader** -- YAML FlowConfig + adapters + agents loading and validation, credentials.json credential injection, variable substitution
- **Trace Log + Cost Tracking** -- pino NDJSON trace, per-agent/per-role cost statistics
- **CLI** -- `vera run` command, Ctrl+C graceful termination, session data persistence

### Agent Adapters (5)

| Adapter | Method | Status |
|---------|------|------|
| Claude Code | CLI `--settings` | Done verified |
| Claude Code Bare | CLI `--bare --settings` | Done verified |
| Gemini API | HTTP Vertex AI REST API | Done verified |
| Gemini CLI | CLI (has subprocess hang bug) | Pending fix |
| OpenCode | CLI `--pure --format json` | Done verified |

### Verified Flows

| Flow | Proposer | Critic | Judge | Result |
|------|----------|--------|-------|------|
| `cc-only.yaml` | Claude | Claude | Claude | Done score 0.85 |
| `cc-mixed.yaml` | Claude(full) | Claude(bare) | Claude(bare) | Done score 0.88 |
| `minimal.yaml` | Claude | Gemini API | Claude | Done score 0.88 |
| `heterogeneous.yaml` | Claude | Kimi(OpenCode) | Gemini API | Done score 0.90 |

### HTTP API Server (@vera/server)

| Endpoint | Method | Description |
|----------|--------|------|
| `/api/sessions` | GET | Session list |
| `/api/sessions/:id` | GET | Session details |
| `/api/sessions/:id/blackboard` | GET | Blackboard state |
| `/api/flows` | GET | Available flow list |
| `/api/run` | POST | Start orchestration |

### Web UI (@vera/web-ui)

| Component | Function |
|------|------|
| FlowRunner | Select flow + input task + start orchestration + real-time progress |
| SessionList | Session card list + search/filter/sort |
| SessionDetail | Session detail modal + Trace timeline + Blackboard viewer |
| FlowVisualizer | FSM flow visualization (Mermaid integration pending) |
| StatsPanel | Cost/Token/Duration statistics charts |

**Dual mode support:**
- Browser mode: `pnpm dev` (Vite) + `@vera/server` (HTTP API)
- Tauri desktop mode: `pnpm dev:tauri` (Tauri IPC, Rust backend reads files directly)

### Tauri Rust Backend

Tauri Commands implement session reading and flow execution:
- `list_sessions()` -- Read sessions/ directory
- `get_session(id)` -- Read result.json
- `get_blackboard(id)` -- Read blackboard.json
- `list_flows()` -- List configs/flows/
- `run_flow(flow, task)` -- spawn vera-core process

### Tests

- 28 unit tests all passing (ndjson, blackboard, condition eval, config loader)

---

## Demo Usage

### Quick Start (Browser Mode)

```bash
# One-click start
bash demo/start.sh

# Or manually:
pnpm build
node packages/server/dist/index.js --port 3000 --sessions-dir ./sessions &
cd packages/web-ui && pnpm dev
# Open http://localhost:5173
```

### Run Orchestration

```bash
# Use default flow + task
bash demo/run-flow.sh

# Custom
bash demo/run-flow.sh --flow configs/flows/cc-only.yaml --task "your task description"

# Or use CLI directly
node packages/core/dist/index.js run \
  --flow configs/flows/cc-mixed.yaml \
  --task "Review this code: ..." \
  --config-dir configs/
```

### Tauri Desktop Mode

```bash
cd packages/web-ui
pnpm dev:tauri
```

---

## Known Issues

1. **Gemini CLI subprocess hang** -- Freezes in non-TTY, replaced with `gemini-api` (HTTP)
2. **confidence fixed at 0.50** -- Agent returned JSON does not always include confidence field
3. **Incomplete token statistics** -- Claude CLI token data not correctly extracted
4. **FlowVisualizer incomplete** -- Mermaid.js integration pending

### Context Window Management Issues

All current agent calls are single-shot, concatenating the full context into one prompt each time. The following issues exist:

**Issue 1: No context size control**
- `context-assembler.ts` concatenates goal.md + role description + all knowledge base files + step definitions + all previous handoffs + all project directory source code
- When project files are many or knowledge base files are many, it easily exceeds model context window
- No token counting or truncation mechanism

**Issue 2: Full knowledge base read, no on-demand filtering**
- `readAgentKnowledge()` reads all .md files under the agent directory
- Design steps do not need test-strategy.md, requirement steps do not need code-standards.md
- Should let the orchestration agent or step definition specify which knowledge base files to read for this step

**Issue 3: No summary/compression of prior context**
- The more steps, the longer the prior handoff.md
- Step 5 agent receives all handoff content from the previous 4 steps
- Should summarize and compress distant prior steps, only keeping full handoff of the last 1-2 steps

**Issue 4: Agent stateless, loses context on redo**
- Each call is a fresh single-shot, no conversation history
- Redo only passes context via retryHint (challenge feedback text)
- Does not know what approaches were previously attempted and rejected, may repeat mistakes

**Issue 5: Orchestration agent context is heaviest**
- `gatherFlowContext()` reads flow/<name>/main.md + goal.md + all agents/*/main.md + all flows/*/README.md at once
- As roles and steps increase, a single call's prompt becomes very large

**Issue 6: Full project directory read**
- `readProjectFiles()` reads all .md/.ts/.json files under the workspace
- As steps progress, project directory files increase
- No filtering by step relevance (testing steps do not need full PRD document text)

**Optimization directions (future):**
- Token counting + dynamic truncation (trim context by priority)
- Orchestration agent specifies per-step knowledge base file list
- Prior step summary compression (only keep last N steps' complete handoff)
- Agent conversation history (long-running mode or history injection)
- Project file filtering by step relevance (declare required file paths in step definition)

---

## Future Plans

### P0 (Urgent -- Context Management Optimization)

The biggest current bottleneck: every agent call is single-shot with full context, no historical memory on redo, challenger scores persistently fail to rise.

- [ ] **Context compression and summarization** -- Intelligent summarization of long text (prior outputs, knowledge base) to control prompt size
- [ ] **Inject full history on redo** -- Include all previous attempt outputs + challenge feedback, not just the most recent one
- [ ] **On-demand project file reading** -- Reference grep/search mechanism, only read files relevant to the current step
- [ ] **Token counting and dynamic trimming** -- Trim context by priority (goal > role > knowledge base > prior outputs > project files)
- [ ] **On-demand knowledge base filtering** -- Orchestration agent specifies per-step knowledge base file list

### P1 (Near-term)

- [ ] **Conditional jumps** -- flow/<name>/main.md steps support optional `skip_condition` (e.g. "previous step score > 0.9"), orchestration agent references it for execution
- [x] **Challenge failure human intervention** -- Pause and wait for human decision after max_retries exhausted (implemented)
- [x] **Step-level human approval** -- README.md marks `require_approval`, pause and wait for human confirmation after challenge passes (implemented)
- [x] **Ctrl+C safe pause** -- Save state, --resume to recover (implemented)
- [ ] Node.js SEA packaging -- Package @vera/core as standalone binary sidecar
- [ ] Real-time orchestration progress -- Tauri events push step progress to frontend

### P2 (Medium-term)

- [ ] Parallel steps (fan-out / fan-in) -- Multiple agents execute same step in parallel
- [ ] Long-running mode (MCP Server stdio) -- Process reuse, incremental context
- [ ] Memory system -- Session/Working/Knowledge Memory
- [ ] Multi-session concurrency
- [ ] Flow visual editor (drag-and-drop flow config)
