# 2026-07-25 · 16:xx — 上下文占用对齐远端窗口

## 变更

| Hash | 模块 | 内容 |
|---|---|---|
| (pending) | core | `estimateContextUsedFromUsage` / `lastContextUsed`：压缩阈值优先用 API 回报的窗口占用 |
| (pending) | partner-sidecar | 启用 progressive compress + micro-compact；按 session 记忆 `lastContextUsed` |
| (pending) | partner | 圆环保留远端窗口占用；文案标明与本地压缩同口径 |

## Roadmap 同步

- 无

## 遗留事项

- compression segments 尚未跨 Partner 进程持久化（仅 lastContextUsed 在 sidecar session 内）
- runAgent（非 stream）路径仍未统一上报 onUsage
