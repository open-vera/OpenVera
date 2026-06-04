# Vera Plugin Lifecycle

> Maps out the lifecycle nodes that exist in Vera's runtime, serving as the basis for plugin system hook design.

## Overview: Three Runtime Tiers

```
Gateway   -- Start/stop, project discovery, capability registration
Harness   -- Flow orchestration, Critique, Replan, Swarm
Core      -- Agent loop, tool execution, Channel, Session
```

---

## 1. Core Layer

### 1.1 Startup Flow (main.ts)

```
loadConfig()                     <- config loading
  +-- isConfigEmpty? -> wizard   <- first run
  +-- normal load
buildAdapter(provider, model)    <- switch: anthropic/openai/gemini
resolveDefaultTarget()
loadTemplates()                  <- prompt templates
intentRouting?                   <- optional: single intent classification
  +-- resolveModel()
  +-- fallback to default on failure
|
single-run mode / REPL mode fork
```

**Plugin hook points**:

| Node | Type | Description |
|------|------|-------------|
| After config load | `transform` | Modify/inject config (model, provider, paths) |
| buildAdapter | `intercept` | Replace adapter factory, eliminate switch |
| After template load | `transform` | Inject custom prompt templates |
| intent routing | `intercept` | Custom routing logic |
| Mode fork | `observe` | Know whether entering single-run or REPL |

### 1.2 Agent Loop (loop.ts)

This is the core runtime, with each turn's full pipeline:

```
One turn's complete sequence:

proactiveCompress()              <- OC1: insert-then-compress / LLM compression
  +-- onCompression hook
selectAndRecordMemories()        <- select + inject memories
  +-- onMemorySelected callback
reapplyReplacements()            <- budget trimming
enforcePerTurnBudget()
microCompact()                   <- micro-compression
trimToWindow()                   <- sliding window
injectMemoryContext()            <- inject <dynamic-memory-context>
onTurnStart hook                 <- notify: new turn begins
----------------------------------------
API call (adapter.complete)      <- LLM invocation
  +-- reactive compact           <- triggered when prompt too long
     +-- onRetry hook
----------------------------------------
handleToolCalls()                <- parse tool calls
  for each tool_call:
    parse args                   <- JSON parsing (may fail -> error injection)
    onToolCall callback          <- pre-execution callback
    toolRegistry.execute()       <- actual execution (see 1.3)
    processToolResult()          <- result -> message, budget deduction
onTurnEnd hook                   <- notify: turn ends
----------------------------------------
empty assistant retry?           <- empty response retry (max 3 times)
OC1 resolve?                     <- single API compression
loop again / terminate
```

**Plugin hook points**:

| Node | Type | Description |
|------|------|-------------|
| Before/after compression | `observe` | Know compression happened |
| Memory selection | `transform` | Custom memory selection strategy |
| Window trimming | `observe` | Know which messages were trimmed |
| Turn start | `observe` | Audit, logging |
| Before LLM request | `intercept` | Modify messages, swap model, add headers |
| Before LLM request | `transform` | Modify system prompt / user message |
| After LLM response | `transform` | Post-process response content |
| After LLM response | `observe` | Record token usage |
| Tool call parse failure | `intercept` | Recover malformed tool calls |
| Before tool call | `intercept` | Block specific tools, replace args |
| After tool call | `transform` | Modify tool result |
| Turn end | `observe` | Stats, audit |
| Empty response retry | `observe` | Know agent is "stuck" |
| Retry/error | `observe` | Know an error occurred |

### 1.3 Tool Execution (registry.ts)

```
registry.execute(toolName, args, ctx)
  +-- find tool                     <- unknown tool -> errorResult
  +-- dryRun check                  <- simulation mode short-circuit
  +-- deprecation warning           <- deprecated tool
  +-- lifecycle hook onBeforeToolCall <- any hook can return ToolResult to short-circuit
  +-- middleware before             <- each mw can modify args or skip
  +-- idempotent cache check        <- hit -> return cached result directly
  +-- retry loop (max 3)            <- timeout, backoff
  |    +-- executeWithTimeout
  |    +-- mw.onError               <- middleware can recover from error
  +-- middleware after              <- each mw can transform result
  +-- lifecycle hook onAfterToolCall  <- notify: execution complete
  +-- idempotent cache write        <- cache result for idempotent tools
  +-- stats recording               <- fire-and-forget
```

**Existing built-in Hook instances**:
- `SecurityPlugin` -- deny/allow list, readonly mode, budget, path boundaries, domain allowlist, injection detection, dangerous command confirmation
- `AnalyticsPlugin` -- record tool_call and tool_result to JSONL

**Plugin hook points** (tools are the densest hook area):

| Node | Type | Description |
|------|------|-------------|
| Before execution | `intercept` | Security policy, permission check, short-circuit deny |
| Before execution | `transform` | Modify args (sanitization, path normalization) |
| After execution | `transform` | Modify result (formatting, truncation, translation) |
| After execution | `observe` | Logging, stats |
| On error | `intercept` | Error recovery, degradation |

### 1.4 Channel Lifecycle (channel/)

**ChannelGateway events**:

```
adapter added
  -> connect()
    -> channel_connected
    -> message_received    <- message received
    -> message_sent        <- message sent
    -> channel_error
    -> channel_disconnected
    -> reconnecting        <- auto-reconnect
  -> disconnect()
adapter removed
```

**ChannelPluginRegistry lifecycle**:

```
registerPlugin()    -> plugin registration
loadAdapter()       -> create adapter instance
unloadAdapter()     -> disconnect + remove
unregisterPlugin()  -> unload all adapters + remove plugin
```

**Plugin hook points**:

| Node | Type | Description |
|------|------|-------------|
| Message received | `intercept` | Filter/block messages |
| Message received | `transform` | Preprocess message content |
| Message sent | `transform` | Postprocess reply content |
| Connection state change | `observe` | Monitor channel health |
| Adapter creation | `intercept` | Replace adapter implementation |

### 1.5 Session Lifecycle (session/)

```
session:create          write session_start (model, provider, cwd)
  +-- user message       write user entry
  +-- assistant response write assistant entry (+ usage, model)
  +-- tool_call          write tool_call entry (+ tool name, args)
  +-- tool_result        write tool_result entry
  +-- session:end        write session_end (+ total usage, cost, turn count)

Auxiliary operations:
  session:fork       fork session
  session:branch     create branch
  session:merge      merge session
  session:cleanup    TTL expiry cleanup
  autoCompress       SS1: auto-compress when threshold exceeded
```

**Plugin hook points**:

| Node | Type | Description |
|------|------|-------------|
| Create | `observe` | Know a new session started |
| Per JSONL write | `observe` | Full audit |
| Fork | `intercept` | Custom fork logic |
| Compress | `transform` | Custom compression strategy |
| End | `observe` | Cost stats, notification |

---

## 2. Harness Layer

### 2.1 Flow State Machine

```
intaking -> planning -> dispatching -> executing -> critiquing
                ^           ^  |           |
                |      replanning  waiting_tool
                |           |           |
                |           |     waiting_approval
                |           |           |
                |           +------ paused
                |                       |
                +-----------------------+
                |
          completed / failed (terminal)
```

**11 states, approximately 20 valid transitions**, see `flow-state.ts:5-17`.

### 2.2 Flow Orchestration Loop (runtime.ts)

```
planAndStart(goal)                       <- generate plan from natural language
  -> startFlow(input)                    <- create TaskFlow + artifact store
    +-- runFlowLoop()
      loop:
        +-- find next pending step       <- topological sort by dependency graph
        +-- parallel batch dispatch      <- max maxParallel steps
        |    +-- dispatchStep()
        |         +-- runAgentAssignment() <- assign agent runner to execute
        |              +-- agent.run()     <- actual execution (internally core's agent loop)
        +-- runStepCritique()            <- LLM reviews step result
        |    +-- complete     -> mark done, retrospective, continue
        |    +-- ask_human    -> [waiting_approval] -> checkpoint -> pause
        |    +-- replan       -> [replanning] -> replanFlow() -> modify plan
        |    +-- retry        -> reset step state, retry
        |
        +-- no pending steps -> completeFlow()
```

**Decision fork points (most worthwhile for hooks)**:

| Node | State Transition | Plugin Capability |
|------|-----------------|-------------------|
| Plan generation | intaking->planning | `intercept` replace plan generator |
| Step assignment | dispatching->executing | `intercept` choose agent runner |
| Agent execution complete | executing->critiquing | `transform` modify step output |
| Critique verdict | critiquing->complete/replan/retry/ask_human | `intercept` override LLM verdict |
| Replan | replanning->dispatching | `intercept` audit plan changes |
| Human approval | waiting_approval->dispatching | `intercept` auto-approve |
| Complete | ->completed | `observe` notify |

### 2.3 Self-Loop (self-loop.ts)

```
run(handle)
  cycle loop:
    +-- runFlowLoop()              <- execute one flow round
    +-- cycleCritique()            <- LLM reviews overall result
    +-- evaluateDecision()         <- decision tree
    |    +-- high_confidence?      -> stop
    |    +-- max_cycles?           -> stop
    |    +-- budget_exceeded?      -> stop
    |    +-- duplicate_critique?   -> stop
    |    +-- critique suggests replan -> replan
    |    +-- otherwise             -> continue
    +-- replanForNextCycle()       <- modify plan and re-run
```

**Plugin hook points**:

| Node | Type | Description |
|------|------|-------------|
| Per-cycle start/end | `observe` | Progress monitoring |
| Cycle critique | `intercept` | Replace review logic |
| Decision | `intercept` | Custom termination conditions |
| Replan | `transform` | Modify new plan |

### 2.4 Agent Runner (agent/)

```
AgentRunnerRegistry
  +-- register(name, runner)
  +-- getAvailable(name, fallbacks[])    <- availability check + fallback chain
  +-- findByCapabilities(required)       <- capability matching

AgentRunner.run(assignment, options)
  +-- hooks.onStart?()
  +-- [actual execution]                 <- streamAgent / CLI process / remote
  +-- hooks.onComplete?()
  +-- hooks.onError?()
```

### 2.5 Swarm (swarm/)

```
submit(task)
  -> task:queued
  -> tryAssign()              <- assign idle sandbox
    -> sandbox:created?       <- create new sandbox if none idle
    -> task:assigned
    -> task:started
    -> executeTask()
        +-- upload files
        +-- execute command   <- retry logic
        +-- emit result
    -> task:completed / failed / cancelled
    -> sandbox:destroyed / recycled
  -> scheduler:drained        <- all complete
```

---

## 3. Gateway Layer

### 3.1 Startup and Discovery

```
Gateway startup
  +-- ProjectRegistry.discover()
  |    +-- scan roots -> find .vera / package.json -> GatewayProject[]
  +-- createProjectCapabilityInventory()
  |    +-- scan .vera/ directory -> CapabilityDescriptor[]
  |         +-- config     -> .vera/settings.json
  |         +-- prompt     -> CLAUDE.md
  |         +-- memory     -> .vera/memory
  |         +-- rag        -> .vera/rag
  |         +-- skill      -> .claude/skills
  |         +-- plugin     -> .vera/plugins      <- plugin discovery
  |         +-- mcp        -> .cursor/projects
  |         +-- channel    -> .vera/channels
  |         +-- sandbox    -> .vera/sandbox
  |         +-- flow       -> .vera/flows
  |         +-- ...
  +-- CapabilityRegistry.register() -> register each capability
```

---

## 4. Complete Event Inventory

Based on the above analysis, here is the full event set the plugin system needs to cover:

### Core Events

```
config:load          Config load complete
config:merge         All plugin.config() merges complete
plugin:install       Plugin installed
plugin:activate      Plugin activated
plugin:deactivate    Plugin deactivated
session:create       Session created
session:close        Session closed
session:fork         Session forked
turn:start           Agent new turn begins
turn:end             Agent turn ends
prompt:system        System prompt assembly (transformable)
prompt:user          User message assembly (transformable)
memory:select        Memory selection
memory:inject        Memory injection
llm:request          Before LLM request
llm:response         After LLM response
tool:before:*        Before tool execution (* = tool name, interceptable)
tool:after:*         After tool execution (result transformable)
tool:error:*         Tool execution error
message:receive      Channel message received
message:send         Channel message sent
channel:connect      Channel connected
channel:disconnect   Channel disconnected
channel:error        Channel error
channel:reconnect    Channel reconnection
compression:*        Compression events (progressive / insert-compress / micro)
error:*              Any error
```

### Harness Events

```
flow:start              Flow started
flow:plan:generate      Plan generated (natural language -> Plan)
flow:plan:change        Plan changed (replan / merge)
flow:step:start         Step started execution
flow:step:end           Step execution completed (with agent output)
flow:step:dispatch      Step assigned to agent runner
flow:step:critique      Step review completed
flow:step:retry         Step retried
flow:critique:decision  Review decision (complete/replan/retry/ask_human)
flow:replan             Re-plan triggered
flow:pause              Flow paused (awaiting human approval)
flow:resume             Flow resumed
flow:checkpoint         Checkpoint saved
flow:complete           Flow completed successfully
flow:fail               Flow failed
flow:error              Flow exception
agent:assign            Agent assigned to step
agent:start             Agent started execution
agent:end               Agent execution completed
agent:error             Agent execution error
self-loop:cycle:start   Self-loop cycle started
self-loop:cycle:end     Self-loop cycle ended
self-loop:decision      Self-loop termination decision
swarm:task:queued       Swarm task queued
swarm:task:started      Swarm task started
swarm:task:completed    Swarm task completed
swarm:task:failed       Swarm task failed
swarm:sandbox:created   Sandbox created
swarm:sandbox:destroyed Sandbox destroyed
swarm:drained           Swarm all complete
```

---

## 5. Hook Type Definitions

Based on all the above events, only four hook types are needed:

```ts
interface VeraPlugin {
  name: string;
  enforce?: "pre" | "post";

  // -- Declarative: what capabilities I provide --
  provides?: Partial<Record<ContractType, Record<string, unknown>>>;

  // -- Four universal hooks --
  config?(config, env): PartialConfig | null;
  intercept?(event: string, ctx: EventCtx): { handled: boolean; data?: unknown } | null;
  transform?(event: string, value: unknown, ctx: EventCtx): unknown;
  observe?(event: string, ctx: EventCtx): void;
}
```

**Four hook semantics**:

| Hook | Analogy | Execution | Can Short-Circuit | Typical Use Case |
|------|---------|-----------|-------------------|------------------|
| `config` | Vite config | sequential (pre->post) | Yes | Register models, modify system prompt |
| `intercept` | Vite resolveId | sequential (pre->post) | Yes (return {handled:true}) | Deny tools, replace adapter, approve |
| `transform` | Vite transform | sequential pipeline | No | Modify prompt, modify tool result, post-process |
| `observe` | Vite buildEnd | parallel | No | Logging, audit, stats, monitoring |

**Event matching**: glob patterns like `tool:before:*` match `tool:before:echo`, `tool:before:read_file`.

**Execution order**: pre -> normal -> post; same-type hooks in installation order.
