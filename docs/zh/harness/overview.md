# Harness -- @vera/harness 模块文档

`@vera/harness` 是 Vera 的运行时内核，负责 Flow 生命周期管理、工具权限约束、Critique 循环和审批门控。

## 文档索引

| 文档 | 内容 |
|----------|---------|
| [design.md](./design.md) | Harness 整体设计——术语约定、Flow 状态机、权限边界、Proposal Pipeline |
| [runtime-implementation.md](./runtime-implementation.md) | Harness Runtime 实现细节——当前代码结构和模块职责 |

## 主包结构

```
packages/harness/src/
  runtime/
    runtime.ts        HarnessRuntime -- Flow 生命周期控制器
    flow.ts           TaskFlow 创建与状态管理
    critique.ts       critiquePlan / critiqueStep / replanWithCritique
    approval.ts       审批门控 -- shouldPauseForApproval
    timeline.ts       appendTimeline -- NDJSON 追踪写入
    artifacts.ts      产物存储
    proposal.ts       PolicyProposal 生成（stub）
    flow-config/      `.vera/flows` Flow/Stage/Agent 配置解析
    planner.ts        planFromPrompt（LLM 生成 ExecutionPlan）
    plan-parser.ts    LLM 计划解析（JSON/列表 fallback）
    flow-state.ts     Flow 状态机与有效转换检查
    json.ts           critique/planner 的 JSON 纠正与重试
  cli/
    flow-run.ts       CLI 入口
    plan.ts           flowDefinitionToPlan
    adapter.ts        CLI adapter 适配
    repl-plan-executor.ts REPL 计划执行器（plan -> act -> critique）
```

## P0 实施摘要

- P0 目标能力已就位：`planFromPrompt`、`HarnessRuntime.runFlowLoop`、步骤 critique/replan、审批门控、timeline/artifact。
- `runtime/executor.ts` 不是必需文件；步骤执行职责由 `runtime.ts`（`dispatchStep`/`runAgentAssignment`）承担。

## 仍需补齐（非 P0 功能缺口）

- P1 方向见 [roadmap.md](../roadmap.md#p1--补齐自循环和自我修正的能力)：checkpoint/resume、self-loop、critic agent、failure attribution。
- P0 后对齐项见 [capability-gaps.md](../core/capability-gaps.md)：permissions/context/UI/sub-agent 对齐。
