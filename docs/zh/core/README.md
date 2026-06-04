# Core — @vera/core 模块文档

`@vera/core` 是 Vera 的基础 runtime 层，负责 LLM 适配、agent loop、意图路由和上下文管理。

## 文档目录

| 文档 | 内容 |
|---|---|
| [agent-design.md](./agent-design.md) | Agent 能力版图与设计模式（Hermes 精华、Dreaming、Subagent、Plan Mode 总览） |
| [intent-routing.md](./intent-routing.md) | 意图识别与模型路由——L0/L1/L2/L3 复杂度分级、模型自动选择 |
| [runtime-design.md](./runtime-design.md) | Core runtime 设计——adapter 抽象、loop、streaming |
| [infinite-context-implementation.md](./infinite-context-implementation.md) | 无限上下文实现指南——token 估算、滑动窗口、工具输出截断 |
| [plan-mode-implementation.md](./plan-mode-implementation.md) | Plan Mode 实现指南——Planner、Step 执行引擎、与 harness 打通 |
| [subagent-design.md](./subagent-design.md) | Subagent 系统设计——通信协议、上下文共享、调度器、典型模式 |

## 主要包结构

```
packages/core/src/
  adapters/          LLM 适配层（Anthropic / OpenAI / Gemini）
  agent/loop.ts      runAgent / streamAgent（ReAct 循环）
  intent/            意图识别与复杂度分级
  context/           上下文管理（token/window/compression/tool-budget）
  types/             核心类型定义
  config/            配置加载
  repl/              交互式 REPL
  session/           会话持久化、恢复、成本统计、标题生成
  project-context/   项目规则加载与注入
  tools/             ToolRegistry、内置工具与安全/分析插件
```

## P0 实现结论

- P0 目标能力已落地：意图路由、工具运行时、会话持久化、无限上下文、Plan Mode。
- 代码入口：`context/tokens.ts`、`context/window.ts`、`context/compression.ts`、`plan/repl-runner.ts`、`agent/loop.ts` 已全部存在并接入主链路。

## 当前仍需补齐（非 P0 功能缺失）

- P0 后对齐项见 [capability-gaps.md](./capability-gaps.md)：权限体验、项目上下文规则、UI 信息密度、子 agent 远程隔离等。
- P1 方向见 [roadmap.md](../roadmap.md#p1--补齐自循环和自我修正的能力)：checkpoint/resume、memory、自循环与失败归因。
