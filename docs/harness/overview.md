# Harness -- @vera/harness Module Docs

`@vera/harness` is Vera's runtime kernel, responsible for Flow lifecycle management, tool permission constraints, Critique loops, and approval gates.

## Document Index

| Document | Content |
|----------|---------|
| [design.md](./design.md) | Harness overall design -- terminology conventions, Flow State machine, permission boundaries, Proposal Pipeline |
| [runtime-implementation.md](./runtime-implementation.md) | Harness Runtime implementation details -- current code structure and module responsibilities |

## Main Package Structure

```
packages/harness/src/
  runtime/
    runtime.ts        HarnessRuntime -- Flow lifecycle controller
    flow.ts           TaskFlow creation and state management
    critique.ts       critiquePlan / critiqueStep / replanWithCritique
    approval.ts       Approval gate -- shouldPauseForApproval
    timeline.ts       appendTimeline -- NDJSON trace writing
    artifacts.ts      Artifact storage
    proposal.ts       PolicyProposal generation (stub)
    flow-config/      `.vera/flows` Flow/Stage/Agent config parsing
    planner.ts        planFromPrompt (LLM generates ExecutionPlan)
    plan-parser.ts    LLM plan parsing (JSON/list fallback)
    flow-state.ts     Flow state machine and valid transition checks
    json.ts           critique/planner JSON correction and retry
  cli/
    flow-run.ts       CLI entry point
    plan.ts           flowDefinitionToPlan
    adapter.ts        CLI adapter adaptation
    repl-plan-executor.ts REPL Plan Executor (plan -> act -> critique)
```

## P0 Implementation Summary

- P0 target capabilities are in place: `planFromPrompt`, `HarnessRuntime.runFlowLoop`, step critique/replan, approval gates, timeline/artifact.
- `runtime/executor.ts` is not a required file; Step execution responsibility is carried by `runtime.ts` (`dispatchStep`/`runAgentAssignment`).

## Still Needed (non-P0 feature gaps)

- P1 directions per [roadmap.md](../roadmap.md#p1--补齐自循环和自我修正的能力): checkpoint/resume, self-loop, critic agent, failure attribution.
- P0 post-alignment items per [capability-gaps.md](../core/capability-gaps.md): permissions/context/UI/sub-agent alignment.
