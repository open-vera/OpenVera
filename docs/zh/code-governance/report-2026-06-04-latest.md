# 代码质量扫描报告 — 2026-06-04（最新）

> 扫描目标：`packages/` | 工具：oxlint + ESLint/sonarjs + jscpd  
> 背景：第五批治理后（`store.ts` 拆为门面 + writes/list/branch/load）

---

## 对比历史

| 指标 | 首轮 | 复扫 | **本轮** |
|---|---:|---:|---:|
| oxlint warn | 1345 | 1418 | **1418** |
| oxlint error | 0 | 0 | **0** |
| sonarjs | 0 | 0 | **0** |
| 重复率 | 5.09% | 5.54% | **5.49%** |
| 重复块 | 655 | 749 | **755** |

---

## 结构性指标（oxlint）

| 规则 | warn | error |
|---|---:|---:|
| `max-lines` | 141 | 0 |
| `max-lines-per-function` | 685 | 0 |
| `complexity` | 196 | 0 |
| `max-depth` | 10 | 0 |
| `max-params` | 38 | 0 |
| `no-unused-vars` | 333 | 0 |
| **合计** | **1418** | **0** |

### Top 违规

| 文件 | 行 | 规则 | 详情 |
|---|---:|---|---|
| `packages/core/src/storage/tests/data-exporter.test.ts` | 1394 | `max-lines` | File has too many lines (1058). |
| `packages/core/src/utils/tests/gitDiff.test.ts` | 1206 | `max-lines` | File has too many lines (1030). |
| `packages/core/src/storage/tests/s3-adapter.test.ts` | 1254 | `max-lines` | File has too many lines (957). |
| `packages/core/src/tools/tests/desktop-input.test.ts` | 1061 | `max-lines` | File has too many lines (917). |
| `packages/core/src/storage/tests/file-store.test.ts` | 1141 | `max-lines` | File has too many lines (906). |
| `packages/core/src/agent/loop.ts` | 1146 | `max-lines` | File has too many lines (906). |
| `packages/core/src/storage/tests/oss-adapter.test.ts` | 1233 | `max-lines` | File has too many lines (902). |
| `packages/core/src/storage/tests/s3-adapter.test.ts` | 81 | `max-lines-per-function` | The function has too many lines (899). Maximum allowed is 50. |
| `packages/core/src/storage/tests/file-store.test.ts` | 14 | `max-lines-per-function` | The function has too many lines (895). Maximum allowed is 50. |
| `packages/core/src/storage/tests/memory-adapter.test.ts` | 1207 | `max-lines` | File has too many lines (882). |

---

## 认知复杂度（sonarjs）

| 规则 | 触发数 |
|---|---:|
| （无） | 0 |

---

## 重复度（jscpd）

- **重复率**：5.49%（目标 < 5%）
- **重复块**：755
- **重复行**：8074

| 文件 A | 文件 B | 行 |
|---|---|---:|
| `packages/core/src/channel/slack-channel.ts:259-299` | `packages/core/src/channel/whatsapp-channel.ts:275-315` | 41 |
| `packages/core/src/channel/webhook-channel.ts:195-232` | `packages/core/src/channel/whatsapp-channel.ts:278-315` | 38 |
| `packages/core/src/channel/slack-channel.ts:457-491` | `packages/core/src/channel/whatsapp-channel.ts:487-521` | 35 |
| `packages/core/src/channel/telegram-channel.ts:461-494` | `packages/core/src/channel/whatsapp-channel.ts:486-519` | 34 |
| `packages/core/src/channel/wecom-channel.ts:505-537` | `packages/core/src/channel/whatsapp-channel.ts:487-519` | 33 |

---

## Session 模块

- `store.ts` 违规：**0** ✅

| 文件 | 违规 |
|---|---:|
| `packages/core/src/session/jsonl-session-io.ts` | 9 |
| `packages/core/src/session/session-manager.ts` | 9 |
| `packages/core/src/session/sqlite-backend.ts` | 8 |
| `packages/core/src/session/session-store-load.ts` | 2 |
| `packages/core/src/session/session-store-branch.ts` | 1 |
| `packages/core/src/session/backend.ts` | 1 |
| `packages/core/src/session/session-store-list.ts` | 1 |
| `packages/core/src/session/session-store-writes.ts` | 1 |

---

## 总结

- oxlint：**0** error / **1418** warn
- 重复率：**5.49%**

**下一批**：`loop.ts`、`jsonl-session-io.ts`、超大测试文件拆分。
