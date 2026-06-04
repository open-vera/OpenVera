# Harness Web UI Plan

## Overview

Harness Web UI is Vera's graphical management interface, providing project discovery, capability inventory, run monitoring, health checks, conversation interactions, and more. It consists of two independent processes: a Node.js HTTP backend (Express) and a Vue 3 single-page application frontend. The frontend and backend communicate via REST API and SSE. The backend reads filesystem data directly from the local `.vera` directory without requiring an additional database.

**Code locations:**

- Backend: `apps/gateway-ui/server/`
- Frontend: `apps/gateway-ui/web/`
- Shared types and core logic: `packages/gateway/`

**How to start:**

```bash
# Backend (default port 7720)
npx vera-gateway-serve --root /path/to/project1 --root /path/to/project2

# Frontend dev mode
cd apps/gateway-ui/web && pnpm dev
```

The backend uses the `--root` parameter to specify one or more workspace root directories. `ProjectRegistry` recursively scans these directories and their subdirectories, discovering all projects that contain `.vera` or `package.json`.

---

## Overall Architecture

```
Browser (Vue 3 SPA)
  │
  │  REST + SSE
  ▼
Express Server (port 7720)
  │
  ├─ GatewayState ─────────────────────────────┐
  │   ├─ ProjectRegistry.discover()            │  Scan filesystem
  │   ├─ CapabilityRegistry.registerMany()     │  Enumerate project capabilities
  │   └─ DoctorService.run()                   │  Run health checks
  │
  ├─ Runtime Stores ───────────────────────────┐
  │   ├─ runtime-store   (runs/flows/checkpoints)│  Read .vera/flows/
  │   ├─ conversation-store  (in-memory convos)  │  Map in-memory storage
  │   ├─ operations-store   (ops monitoring)     │  CPU/memory/activity
  │   └─ timeline-stream    (SSE real-time push) │  ndjson polling
  │
  ├─ Execution Runtimes ───────────────────────┐
  │   ├─ chat-runtime    (@open-vera/core)     │  Multi-provider adapter
  │   ├─ mcp-runtime     (MCP config parser)    │  .mcp-servers.json
  │   └─ rag-runtime     (keyword retrieval)    │  .vera/rag/ full-text scan
  │
  └─ Action Dispatcher ────────────────────────┐
      ├─ /api/manage/:action   Management actions │  Synchronous, returns accepted
      └─ /api/execute/:action  Execution actions  │  Async execution, returns result
```

### Technology Choices

| Layer | Technology | Reason |
|---|---|---|
| Frontend framework | Vue 3 + Vue Router | SPA routing, component-based views |
| Build tool | Vite | Fast HMR, native ESM support |
| Backend framework | Express | Lightweight HTTP service, middleware ecosystem |
| Data persistence | Filesystem (ndjson) | No external dependencies, reads `.vera` directory directly |
| Real-time communication | SSE (Server-Sent Events) | Unidirectional timeline event push, simpler than WebSocket |
| Conversation storage | In-memory Map | Lightweight sessions, cleared on process restart |

### Design Principles

1. **Zero-config database**: all data sources are filesystem-based (ndjson, json files under `.vera/`). No need to install external storage like PostgreSQL or Redis.
2. **Read-first**: except for conversation creation and run triggering, all query endpoints are GET, never modifying source files.
3. **GatewayState instant scan**: `loadGatewayState()` rescans the filesystem on every request, ensuring data is always up-to-date (filesystem scanning overhead is low enough that in-memory caching is unnecessary).
4. **Process separation**: backend and frontend are deployed independently, communicating cross-origin via CORS. The backend can run standalone without the frontend as a headless API service.

---

## Backend Modules

### Entry File: `server/src/index.ts`

Express application defining all API routes. Core flow:

1. Parse CLI arguments (`--port`, `--root`)
2. Register CORS and JSON body parsing middleware
3. Register all REST routes (see API Design below)
4. Start HTTP listener

On each incoming request, `loadGatewayState(args.roots)` is called to get the latest project, capability, and health check snapshot.

### GatewayState (`server/src/state.ts`)

```typescript
interface GatewayState {
  projects: GatewayProject[];              // Discovered project list
  capabilities: CapabilityDescriptor[];    // Capability inventory of all projects
  doctor: DoctorReport;                    // Health check report
}
```

`loadGatewayState()` execution order: first scan projects via `ProjectRegistry.discover()`, then generate capability lists for each project via `createProjectCapabilityInventory()`, and finally run `DoctorService.run()` to generate the health check report.

### Runtime Store (`server/src/runtime-store.ts`)

The most critical data-reading module, responsible for reading run data from the `.vera/flows/iterations/` directory.

**Data structure:**

```
.vera/flows/iterations/
  iter-2026-06-04T10-30-00-000Z/
    timeline.ndjson     ← Run event stream (one JSON event per line)
    checkpoints.ndjson  ← Checkpoint index
    subagents.json      ← Sub-agent invocation tree
    memory/             ← Layered memory
      episodic.jsonl
      semantic.jsonl
      working.jsonl
    artifacts/          ← Step artifacts
      plan-001.json
      step-001.json
      ...
```

**Key functions:**

| Function | Purpose |
|---|---|
| `listRuns()` | List run history for all projects, sorted by start time descending |
| `getRun()` | Get single run details (including timeline, step aggregation, artifact list) |
| `getTimeline()` | Read raw ndjson event stream |
| `getMemory()` | Read layered memory, supports tier filtering and keyword search |
| `getCheckpoints()` | Read flow checkpoint index |
| `getSubagents()` | Read sub-agent pool state and invocation tree |
| `getCostSummary()` | Aggregate costs (USD) across all runs |
| `spawnRun()` | Start a new `openvera flow run` process via `child_process.spawn` |
| `listFlows()` | Parse flow definitions (Markdown frontmatter) under `.vera/flows/flow/` |

**Run status inference:**

Inferred by parsing the timeline event stream:
- Contains `flow_completed` event → `completed`
- Contains `flow_failed` event → `failed`
- Contains `approval_requested` event → `paused`
- Otherwise → `running`

### Timeline Stream (`server/src/timeline-stream.ts`)

Provides real-time SSE event push. Workflow:

1. Read the current content of the timeline ndjson file, parse into an event array, and push events one by one
2. If the run is in `running` state (or request parameter `live=1`), start 1-second interval polling
3. Each poll reads new content from the file (based on offset), incrementally pushing new events
4. When detecting `flow_completed` or `flow_failed` terminal events, send a `done` event and close the connection

The frontend can consume this endpoint via `EventSource` or `fetch` + ReadableStream.

### Conversation Store (`server/src/conversation-store.ts`)

Pure in-memory storage, using a `Map<string, Conversation>` structure. Supports creating conversations, appending messages, and listing filtered by project.

Conversation lifecycle is entirely in-process; they disappear on service restart. This is intentional -- conversations are transient interaction interfaces; persistence is handled by flow run records.

### Chat Runtime (`server/src/chat-runtime.ts`)

LLM conversation invocation layer. Reads provider configuration from the project's `.vera/settings.json`, supporting Anthropic, OpenAI, and Gemini adapters. Returns placeholder text ("LLM not configured") when no API Key is set, rather than throwing an error.

### Operations Store (`server/src/operations-store.ts`)

Operations monitoring module, providing host resource metrics (CPU core count, memory usage, disk usage) and project activity heatmaps (run launch count grouped by hour).

### Action Dispatcher (`server/src/actions.ts`)

Unified action dispatch mechanism, divided into two categories:

- **ManagementAction**: management actions (`config.edit`, `mcp.reload`, `skill.reload`, `rag.reindex`, `channel.connect/disconnect`, `sandbox.test`), synchronously returning `accepted` confirmation
- **ExecutionAction**: execution actions (`chat.send`, `flow.run`, `rag.search`, `mcp.tool.call`, `sandbox.run`), executed asynchronously and returns results

---

## Frontend Modules

### Route Design (`web/src/router.ts`)

| Path | Component | Description |
|---|---|---|
| `/` | OverviewView | Gateway overview: project count, capability summary, Doctor status |
| `/projects` | ProjectsView | Project list |
| `/projects/:projectId` | ProjectDetailView | Project details: capability inventory, run activity |
| `/capabilities` | CapabilitiesView | Full capability list, filterable by kind |
| `/skills` | CapabilityKindView | Skill catalog (filtered view for kind=skill) |
| `/mcp` | McpView | MCP server and tool list (lazy loaded) |
| `/rag` | RagView | RAG knowledge base search interface (lazy loaded) |
| `/cost` | CostView | Cost summary |
| `/chat` | ChatView | Conversation interface |
| `/chat/:conversationId` | ChatView | Specific conversation detail |
| `/runs` | RunsWorkspaceView | Run workspace (sidebar + detail) |
| `/runs/:runId` | RunShell | Single run detail shell |
| `/runs/:runId/memory` | RunMemoryTab | Run memory panel |
| `/runs/:runId/checkpoints` | RunCheckpointsTab | Run checkpoint panel |
| `/runs/:runId/subagents` | RunSubagentsTab | Sub-agent panel |
| `/runs/:runId/timeline` | RunTimelineTab | Timeline real-time event panel |
| `/management` | ManagementView | Management action triggers |
| `/execution` | ExecutionView | Execution action triggers |
| `/operations` | OperationsView | Operations monitoring panel |
| `/doctor` | DoctorView | Health check results table |
| `/settings` | SettingsView | Settings page |

### RunsWorkspaceView (Run Workspace)

Left sidebar: Flow launch panel (select project and Flow → Start run) + run history list (color-coded by status).

Right detail area: nested route `<router-view>`, renders corresponding tab based on selected run:
- **Overview** (RunOverviewTab): run summary, step list, artifact IDs
- **Memory** (RunMemoryTab): layered memory viewer, supports tier filtering and full-text search
- **Checkpoints** (RunCheckpointsTab): flow checkpoint list, expandable to view raw data
- **Subagents** (RunSubagentsTab): sub-agent pool state (active/queued) and invocation tree
- **Timeline** (RunTimelineTab): receives and displays timeline event stream in real-time via SSE

Running status auto-refreshes every 5 seconds; polling stops on completion.

### Unified API Client (`web/src/api.ts`)

The frontend calls backend endpoints through the `gatewayApi` object, which encapsulates a type-safe `getJson<T>()` function and all endpoint methods. Return types align fully with the backend, catching mismatches at compile time.

The `useStream` composable (`web/src/composables/useStream.ts`) encapsulates SSE consumption logic for timeline real-time push scenarios.

---

## Core Concepts

### Project Registry

`packages/gateway/src/project-registry.ts`

Responsible for discovering and validating projects in the workspace. Scanning logic:

1. Iterate over root directories specified by `--root`
2. If `includeChildren: true` (default), recursively scan one level of subdirectories
3. Detection criteria: `.vera/` or `package.json` exists under the directory
4. Generate unique ID for each project: `{name}-{sha1(rootDir)[:8]}`
5. Record source: `"explicit"` (specified via CLI) or `"discovered"` (subdirectory scan)

### Capability Manager

`packages/gateway/src/capability-registry.ts`

Each project automatically generates 15 capability descriptors:

| Kind | Name | Source Path | Available Actions |
|---|---|---|---|
| `config` | Vera config | `.vera/settings.json` | view, edit, test |
| `prompt` | Workspace prompt | `CLAUDE.md` | view, edit, reload |
| `context` | Project context | `.vera/context` | view, reload |
| `memory` | Project memory | `.vera/memory` | view, edit, reload |
| `rag` | RAG index | `.vera/rag` | view, reindex, test |
| `skill` | Project skills | `.claude/skills` | view, edit, reload |
| `plugin` | Plugin registry | `.vera/plugins` | view, enable, disable, reload |
| `mcp` | MCP servers | `.cursor/projects` | view, test, reload |
| `channel` | Channels | `.vera/channels` | view, connect, disconnect, test |
| `sandbox` | Sandbox providers | `.vera/sandbox` | view, test |
| `flow` | Flows | `.vera/flows` | view, edit, reload |
| `conversation` | Conversations | `.vera/conversations` | view, edit |
| `tool` | Tool policies | `.vera/permissions.json` | view, edit, reload |
| `log` | Runtime logs | `.vera/logs` | view |
| `cost` | Cost management | `.vera/cost` | view, test |

Each capability has four possible statuses: `available` (file exists), `disabled`, `error` (health check failed), `unknown` (file does not exist).

### Doctor (Health Check)

`packages/gateway/src/doctor.ts`

`DoctorService` performs three tiers of checks for each project and capability:

1. **Gateway level**: project registry check (whether any projects were discovered)
2. **Project level**: existence of project root directory, `.vera` directory, flow directory
3. **Capability level**: whether each capability's corresponding source file/directory exists

Check status: `pass` / `warn` / `fail`. Aggregation rules:
- Any `fail` → overall `fail`
- Any `warn` and no `fail` → overall `warn`
- All `pass` → overall `pass`

---

## API Design

All endpoints prefixed with `/api`, return JSON. HTTP 200/201/202 on success; `{ error: string }` with appropriate status code on failure.

### Gateway-level

| Method | Path | Description |
|---|---|---|
| GET | `/api/gateway/overview` | Gateway overview (project count, capability summary, Doctor status) |
| GET | `/api/gateway/doctor` | Full health check report |
| GET | `/api/gateway/operations/summary` | Operations summary (running/completed/failed counts + project activity) |
| GET | `/api/gateway/operations/resources` | Host resources (CPU, memory, disk) |
| GET | `/api/gateway/operations/activity` | 24-hour run activity heatmap |

### Projects

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | Project list |
| GET | `/api/projects/:projectId` | Project details (including capability inventory and activity) |
| GET | `/api/projects/:projectId/capabilities` | Project capability inventory |
| GET | `/api/projects/:projectId/runs` | Project run history |
| GET | `/api/projects/:projectId/flows` | Project flow template list |
| GET | `/api/projects/:projectId/rag/search?q=` | Project RAG retrieval |
| GET | `/api/projects/:projectId/mcp/servers` | Project MCP server list |
| GET | `/api/projects/:projectId/mcp/tools` | Project MCP tool list |

### Capabilities

| Method | Path | Description |
|---|---|---|
| GET | `/api/capabilities` | Full capability list |
| GET | `/api/capabilities?kind=skill` | Filter capabilities by kind |

### Runs

| Method | Path | Description |
|---|---|---|
| GET | `/api/runs` | Run list (supports `?projectId=` filter) |
| POST | `/api/runs` | Start a run (body: `{ projectId, flowDir, model, provider }`) |
| GET | `/api/runs/:runId` | Run details (including timeline, steps, artifacts) |
| GET | `/api/runs/:runId/timeline` | Run timeline raw events |
| GET | `/api/runs/:runId/stream?live=1` | SSE real-time event stream |
| GET | `/api/runs/:runId/steps/:stepId` | Step details |
| GET | `/api/runs/:runId/artifacts/:artifactId` | Step artifact content |
| GET | `/api/runs/:runId/memory?tier=&search=` | Run memory (supports tier filtering and search) |
| GET | `/api/runs/:runId/checkpoints` | Run checkpoint list |
| GET | `/api/runs/:runId/checkpoints/:checkpointId` | Single checkpoint details |
| GET | `/api/runs/:runId/subagents` | Sub-agent pool state and invocation tree |

### Flows

| Method | Path | Description |
|---|---|---|
| GET | `/api/flows` | Flow template list (supports `?projectId=` filter) |

### Conversations

| Method | Path | Description |
|---|---|---|
| GET | `/api/conversations` | Conversation list (supports `?projectId=` filter) |
| POST | `/api/conversations` | Create conversation (body: `{ projectId, title }`) |
| GET | `/api/conversations/:conversationId` | Conversation details |
| POST | `/api/conversations/:conversationId/messages` | Send message (body: `{ role, content }`) |

When sending a message, if role is `user`, the backend automatically invokes the LLM to generate an assistant reply and appends it to the conversation.

### Action Dispatch

| Method | Path | Description |
|---|---|---|
| POST | `/api/manage/:action` | Management actions (synchronously returns accepted) |
| POST | `/api/execute/:action` | Execution actions (async execution, returns result) |

### Cost

| Method | Path | Description |
|---|---|---|
| GET | `/api/cost` | Cost summary (total cost + per-run breakdown) |

---

## Data Flow Illustration

### Full Data Flow of Starting a Run

```
1. User clicks "Start run" in the frontend
2. POST /api/runs  { projectId, flowDir }
3. server/runtime-store.spawnRun()
   ├─ Generate runId: iter-{ISO timestamp}
   ├─ child_process.spawn("openvera", ["flow", "run", "--dir", flowDir])
   │    └─ @open-vera/harness HarnessRuntime.run()
   │         ├─ Planner: generate ExecutionPlan
   │         ├─ Agent:   execute steps → write to artifacts/
   │         ├─ Memory:  extract memories → write to memory/
   │         ├─ Checkpoint: save checkpoint → write to checkpoints.ndjson
   │         └─ Timeline: record events → append to timeline.ndjson
   └─ Return { runId, startedAt }
4. Frontend navigates to /runs/:runId
5. RunTimelineTab connects to GET /api/runs/:runId/stream?live=1
6. Backend reads timeline.ndjson increments every second, pushes new events via SSE
7. Detects flow_completed or flow_failed → sends done, closes SSE
```

### Timeline Event Types

Key event types recorded in timeline ndjson:

| Event Type | Meaning | Key Fields |
|---|---|---|
| `flow_started` | Flow started | goal, ts |
| `step_dispatched` | Step dispatched for execution | stepId, agent |
| `step_start` | Step formally started | stepId, step |
| `agent_call` | Agent invoked | agent, model |
| `step_done` | Step completed | stepId, status, score |
| `step_failed` | Step failed | stepId, error |
| `approval_requested` | Human approval requested | stepId, message |
| `approval_granted` | Approval granted | stepId |
| `checkpoint_created` | Checkpoint created | checkpointId, state |
| `flow_completed` | Flow completed | goal, totalUsd |
| `flow_failed` | Flow failed | error, totalUsd |

---

## Extension Points

The current Web UI is at v0.3. Below are identified but not yet implemented improvement directions:

1. **WebSocket replacing SSE polling**: current timeline real-time push is based on per-second file polling. For high-frequency event scenarios, switching to `fs.watch` + WebSocket push could reduce latency.
2. **Conversation persistence**: currently conversations are stored in process memory, lost on restart. Could persist to ndjson files under `.vera/conversations/`.
3. **Authentication and multi-user**: currently no authentication mechanism; all visitors can see all project data. Suitable for local development; production deployment needs OAuth or API Key authentication integration.
4. **Vector retrieval enhancement**: current RAG retrieval falls back to keyword matching, needs embedding adapter integration for true semantic search.
5. **Async status query for execution actions**: current `/api/execute/:action` is request-response mode; long-running actions (e.g. flow.run) have no progress query capability, requiring a task queue and status polling interface.
6. **Real-time capability health detection**: current health check "resource existence" judgment is static (file exists or not). Could extend to actual connectivity tests (e.g. MCP connection test, Provider API connectivity test).
