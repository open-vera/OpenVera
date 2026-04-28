# 无限上下文 — 当前实现说明

> 本文档对齐 [roadmap.md P0.6](../roadmap.md) 和 [agent-design.md §1](./agent-design.md#1-无限上下文infinite-context)，描述 2026-04-28 的实际实现状态。

---

## 1. 结论

无限上下文的 P0 能力已实现并接入 `runAgent`/`streamAgent` 主循环：

- 滑动窗口裁剪（window trimming）
- 渐进压缩（progressive compression）
- 微压缩（micro-compact）
- reactive compact（超长报错后重试压缩）
- 压缩片段召回（segment recall）

---

## 2. 代码落点

| 文件 | 能力 |
|---|---|
| `packages/core/src/context/tokens.ts` | token 估算与模型上下文上限 |
| `packages/core/src/context/window.ts` | `trimToWindow`（窗口裁剪，保留任务锚点） |
| `packages/core/src/context/compression.ts` | `compressMessages`、`microCompact`、segment 索引与召回 |
| `packages/core/src/context/tool-budget.ts` | tool 输出预算与持久化替换策略 |
| `packages/core/src/agent/loop.ts` | 在两个主循环中编排 window/compression/reactive compact |

---

## 3. 运行机制（当前）

1. 每轮请求前，先做 `trimToWindow` 控制窗口占用。
2. 达到阈值时触发 `compressMessages`，保留近期上下文并压缩旧消息。
3. 根据时间间隙与消息形态触发 `microCompact`，回收陈旧工具输出。
4. 如模型返回 prompt-too-long 错误，进入 reactive compact 并重试。
5. 被压缩片段保留 segment 元数据，可按相关性检索并展开。

---

## 4. P0 验收对齐

- [x] 长对话可自动窗口裁剪，避免直接撞上 context length 上限
- [x] 压缩已集成到 `runAgent` 和 `streamAgent`
- [x] 超长错误可触发 reactive compact 重试
- [x] 压缩片段可检索与还原
- [x] micro-compact 状态在主循环内持有并更新

---

## 5. 当前边界与后续

- 仍需持续优化：大体量工具输出的执行后裁剪成本（roadmap 中 M3，状态待定）。
- 与长期记忆系统（P1）的融合仍在后续阶段：当前无限上下文解决的是会话内上下文容量，不替代跨任务记忆。
- 相关对齐与技术债统一见 [roadmap.md#已知缺陷与技术债](../roadmap.md#已知缺陷与技术债) 与 [capability-gaps.md](./capability-gaps.md)。

