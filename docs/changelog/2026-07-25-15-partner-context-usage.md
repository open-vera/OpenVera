# 2026-07-25 · 15:xx — Partner 上下文窗口圆环展示

## 变更

| Hash | 模块 | 内容 |
|---|---|---|
| (pending) | partner | ToolProgress「推进任务」旁展示 context used/max 圆环；hover tooltip 含总耗时、token 分类、TTFB/TTFT、turns、tool_use |
| (pending) | partner-sidecar | `run-metrics`：累计 usage + context_max（模型窗口）+ 时延/轮次统计，经 usage/done 事件下发 |

## Roadmap 同步

- 无

## 遗留事项

- web-search / server tool 用量尚未单独上报（当前无对应 usage 字段）
- 历史 progress 块不回放当时的 runUsage（仅最新一轮）
