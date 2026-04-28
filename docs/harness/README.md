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
    planner.ts        ← 待建：planFromPrompt
    executor.ts       ← 待建：runStep
  cli/
    flow-run.ts       CLI 入口
    plan.ts           markdownToPlan
    adapter.ts        CLI adapter 适配
```

## 待实现（P0 剩余）

- `runtime/planner.ts` — LLM 主动生成 Plan（`planFromPrompt`）
- `runtime/executor.ts` — Step 执行引擎（`runStep`）
- `runtime.ts` 中 `runFlowLoop` 串联上面两者

参考：[plan-mode-implementation.md](../core/plan-mode-implementation.md)
