# Harness — @vera/harness 模块文档

`@vera/harness` 是 Vera 的运行内核，负责 Flow 生命周期管理、工具权限约束、Critique 回路和审批门。

## 文档目录

| 文档 | 内容 |
|---|---|
| [design.md](./design.md) | Harness 整体设计——术语约定、Flow State 机器、权限边界、Proposal Pipeline |
| [runtime-implementation.md](./runtime-implementation.md) | Harness Runtime 实现细节——当前代码结构与各模块职责 |

## 主要包结构

```
packages/harness/src/
  runtime/
    runtime.ts        HarnessRuntime——Flow 生命周期主控
    flow.ts           TaskFlow 创建与状态管理
    critique.ts       critiquePlan / critiqueStep / replanWithCritique
    approval.ts       审批门——shouldPauseForApproval
    timeline.ts       appendTimeline——NDJSON trace 写入
    artifacts.ts      Artifact 存储
    proposal.ts       PolicyProposal 生成（stub）
    markdown.ts       Markdown Flow 格式解析
    planner.ts        planFromPrompt（LLM 生成 ExecutionPlan）
    plan-parser.ts    LLM 计划解析（JSON/list fallback）
    flow-state.ts     Flow 状态机与合法迁移校验
    json.ts           critique/planner JSON 纠错与重试
  cli/
    flow-run.ts       CLI 入口
    plan.ts           markdownToPlan
    adapter.ts        CLI adapter 适配
    repl-plan-executor.ts REPL Plan Executor（plan → act → critique）
```

## P0 实现结论

- P0 目标能力已落地：`planFromPrompt`、`HarnessRuntime.runFlowLoop`、step critique/replan、审批门、timeline/artifact。
- `runtime/executor.ts` 并非必需文件；Step 执行责任已由 `runtime.ts`（`dispatchStep`/`runAgentAssignment`）承载。

## 当前仍需补齐（非 P0 功能缺失）

- P1 方向见 [roadmap.md](../roadmap.md#p1--补齐自循环和自我修正的能力)：checkpoint/resume、self-loop、critic agent、失败归因。
- P0 后对齐项见 [capability-gaps.md](../core/capability-gaps.md)：权限/上下文/UI/子 agent 对齐。
