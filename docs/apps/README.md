# Apps — 应用层文档

应用层是面向用户的产品入口，基于 core / harness 构建。

## 应用列表

| 应用 | 路径 | 说明 |
|---|---|---|
| harness-ui | `apps/harness-ui/` | Harness Web UI——可视化 Flow runs、Artifact 浏览、流式日志 |
| audio-label | `apps/audio-label/` | 音频标注工具（独立应用） |

## harness-ui

### 架构

```
apps/harness-ui/
  web/      Vue 前端
    src/
      composables/useStream.ts   SSE 流式日志
      composables/useRuns.ts     runs 列表
      api.ts                     API client
  server/   Node.js 后端
    src/
      handlers/
        runs.ts      runs 列表 API
        flows.ts     flow 详情 API
        spawn.ts     触发新 run
        stream.ts    SSE 代理
        steps.ts     Step 详情
        artifacts.ts Artifact 浏览
```

### 文档待补充

- [ ] 本地启动指南
- [ ] API 接口文档
