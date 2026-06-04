# 无限上下文 — 当前实现说明

> 本文档与 [roadmap.md P0.6](../roadmap.md) 和 [agent-design.md 第 1 节](./agent-design.md#1-infinite-context) 对齐，描述 2026-04-28 时间点的实际实现状态。

---

## 1. 概述

无限上下文的 P0 能力已实现并集成到 `runAgent`/`streamAgent` 主循环中：

- 窗口裁剪
- 渐进压缩
- 微压缩（micro-compact）
- 响应式压缩（reactive compact，遇 too-long 错误后压缩重试）
- 压缩段召回

---

## 2. 代码位置

| 文件 | 能力 |
|---|---|
| `packages/core/src/context/tokens.ts` | Token 估算和模型上下文限制 |
| `packages/core/src/context/window.ts` | `trimToWindow`（窗口裁剪，保留任务锚点） |
| `packages/core/src/context/compression.ts` | `compressMessages`、`microCompact`、分段索引和召回 |
| `packages/core/src/context/tool-budget.ts` | 工具输出预算和持久替换策略 |
| `packages/core/src/agent/loop.ts` | 在两个主循环中编排窗口/压缩/响应式压缩 |

---

## 3. 运行时机制（当前）

1. 每轮请求前，`trimToWindow` 控制窗口占用。
2. 达到阈值时，触发 `compressMessages`，保留近期上下文，压缩早期消息。
3. 根据时间间隔和消息模式，触发 `microCompact` 回收过期的工具输出。
4. 若模型返回 prompt-too-long 错误，触发响应式压缩并重试请求。
5. 压缩段保留分段元数据，可按相关性检索和展开。

---

## 4. P0 验收标准

- [x] 长对话自动裁剪窗口，避免直接触发上下文长度限制错误
- [x] 压缩已集成到 `runAgent` 和 `streamAgent`
- [x] Prompt-too-long 错误触发响应式压缩重试
- [x] 压缩段可检索和还原
- [x] 微压缩状态在主循环内保持和更新

---

## 5. 当前边界和后续方向

- 仍需持续优化：大工具输出的事后裁剪成本（roadmap 项 M3，状态 TBD）。
- 与长期记忆系统（P1）的集成在后续阶段：无限上下文当前解决的是会话内上下文容量，不是跨任务记忆。
- 相关对齐项和技术债参见 [roadmap.md#known-defects-and-technical-debt](../roadmap.md#known-defects-and-technical-debt) 和 [capability-gaps.md](./capability-gaps.md)。
