# 代码质量扫描报告 — 2026-06-04（复扫）

> 扫描目标：`packages/` | 工具：oxlint + ESLint/sonarjs + jscpd

## 对比上一轮

| 指标 | 首轮 | 本轮 |
|---|---:|---:|
| oxlint warn | 1345 | 1418 |
| oxlint error | 0 | 0 |
| sonarjs | 0 | 0 |
| 重复率 | 5.09% | 5.54% |
| 重复块 | 655 | 749 |

## 结构性指标（oxlint）

| 规则 | warn | error |
|---|---:|---:|
| `max-lines` | 142 | 0 |
| `max-lines-per-function` | 684 | 0 |
| `complexity` | 195 | 0 |
| `max-depth` | 12 | 0 |
| `max-params` | 35 | 0 |
| `no-unused-vars` | 335 | 0 |

## 重复度（jscpd）

- **重复率**：5.54%
- **重复块数**：749
- **重复行数**：7997

## 治理第三批（同日）

- 拆分 `session-adapter.test.ts` → crud/write/transcript/advanced + `migrate-jsonl.test.ts`
- 拆分 `agent-context.test.ts` → `agent-stream-context` + `agent-subagent`
- `streamAgent` 复用 `resolveInsertCompressIfNeeded` / `finalizeNoToolCalls`

## 治理第四批（同日）

- **Session 模块拆分**：`store.ts`（~695 行，原 ~1064）→ `store-paths.ts`（路径）+ `jsonl-session-io.ts`（JSONL/摘要）+ `SessionStore` 类
- **ContentUploader 测试拆分**：原单文件 ~1358 行 → 6 个 test 文件 + `content-uploader-test-helpers.ts`（108 用例全过）
- **Agent loop**：`reactiveCompactOnError` + `streamTurnWithReactiveCompact`，与 `completeWithReactiveCompact` 对称

### 第四批局部复扫（`packages/core`）

| 指标 | 值 |
|---|---:|
| oxlint warn | 1240 |
| oxlint error | 0 |
| jscpd 重复率 | 6.17% |

仍待治理 Top 项：`store.ts` max-lines（611 有效行）、`jsonl-session-io.ts` 复杂度、`loop.ts` `streamAgent`/`runAgent` 复杂度。

> 优先处理 error；重复率目标 < 5%。
