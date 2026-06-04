# Apps — 应用层文档

应用层是面向用户的产品入口，基于 core / harness 构建。

## 应用列表

| 应用 | 路径 | 说明 |
|---|---|---|
| gateway-ui | `apps/gateway-ui/` | Vera Control Gateway——统一项目、能力、运行、费用、管理动作和执行闭环入口 |
| audio-label | `apps/audio-label/` | 音频标注工具（独立应用） |

## gateway-ui

### 架构

```
apps/gateway-ui/
  web/      Vue 前端
    src/
      views/                     Overview / Projects / Capabilities / Runs / Chat / Cost / Operations / Management / Execution / Doctor
      api.ts                     gatewayApi client（无旧 /api/admin 兼容层）
  server/   Node.js 后端
    src/
      index.ts           HTTP API entry
      state.ts           project/capability/doctor aggregation
      operations-store.ts host resources、项目活动、24h 热力图
      runtime-store.ts     runs/flows/cost/memory/checkpoints/subagents
      chat-runtime.ts      Core runAgent 对话
      timeline-stream.ts   SSE tail timeline
      rag-runtime.ts / mcp-runtime.ts
      actions.ts           POST /api/manage/* 与 /api/execute/*
```

### 文档待补充

- [ ] 本地启动指南
- [ ] API 接口文档
