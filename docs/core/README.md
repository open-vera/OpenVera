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
  context/           上下文管理（待建）
  types/             核心类型定义
  config/            配置加载
  repl/              交互式 REPL
```

## 待实现（P0 剩余）

- `context/tokens.ts` — token 估算
- `context/window.ts` — trimToWindow（滑动窗口裁剪）
- 与 `@vera/harness` 的 Plan Mode 打通（planFromPrompt → runStep）
