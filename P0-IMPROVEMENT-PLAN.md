# OpenVera P0 完善方案 — 持续改进计划

> 生成时间：2026-05-10 16:07 | 分支：feature/p1-checkpoint-resume
> 当前状态：56 测试文件 | 430 passed / 0 failed | 225 源文件

---

## 一、已知问题（必须修复）

### 1. CLI 测试失败（3 个）✅ 已修复
- **文件**: `packages/harness/tests/cli-flags.test.ts`
- **修复**: 将 `flow-run.ts` 和 `repl-run.ts` 的静态 import 改为动态 `await import()`，避免 `-v`/`-h` 时加载不必要的模块导致 ERR_MODULE_NOT_FOUND

### 2. P1 #5 Subagent 增强代码未提交
- `subagent-pool.ts` 和 `subagent-orchestrator.ts` 已写但未测试、未提交
- 需要：编写测试 → 修复问题 → 提交

---

## 二、P0 功能完善清单

### A. 代码质量 & 健壮性

| # | 项目 | 说明 | 状态 |
|---|------|------|------|
| A1 | CLI flags 修复 | 修复 `-v`/`--version`/`-h` 使其通过测试 | ✅ |
| A2 | Subagent Pool 测试 | 为 `subagent-pool.ts` 编写完整测试 | ❌ |
| A3 | Subagent Orchestrator 测试 | 为 `subagent-orchestrator.ts` 编写完整测试 | ❌ |
| A4 | Memory Store 持久化验证 | 验证 Episodic/Semantic JSONL 文件读写在并发场景下的安全性 | ❌ |
| A5 | Checkpoint Store 边界测试 | 空 checkpoint、损坏 JSONL、超大 checkpoint 的处理 | ❌ |
| A6 | Tool Registry 中间件错误隔离 | 一个 middleware 抛异常不影响其他 middleware | ❌ |

### B. 性能优化

| # | 项目 | 说明 | 状态 |
|---|------|------|------|
| B1 | Memory Search 性能 | 当前 O(n) 扫描，大数据量下可能慢，考虑索引或限制 | ❌ |
| B2 | Checkpoint 压缩 | checkpoint JSONL 可能无限增长，需要定期 compaction | ❌ |
| B3 | Tool Stats 内存控制 | ToolStatsCollector 已有 maxRecords，确认默认值合理 | ❌ |

### C. 架构改进

| # | 项目 | 说明 | 状态 |
|---|------|------|------|
| C1 | Agent index 导出补全 | `packages/core/src/agent/index.ts` 需要导出 pool/orchestrator | ❌ |
| C2 | 类型安全加强 | 全局搜索 `any` 类型使用，逐步替换为具体类型 | ❌ |
| C3 | 错误处理统一 | 确保所有模块使用统一的错误类型，不混用 Error + string | ❌ |

### D. 测试覆盖

| # | 项目 | 说明 | 状态 |
|---|------|------|------|
| D1 | Memory Store 并发写入测试 | 多个 async 写入不丢失数据 | ❌ |
| D2 | Checkpoint resume 完整流程测试 | plan → checkpoint → resume → verify | ❌ |
| D3 | AgentRunnerRegistry fallback 测试 | 多个 runner 的 fallback chain | ❌ |
| D4 | Tool Middleware 完整管线测试 | before → execute → after → onError 全链路 | ❌ |
| D5 | 端到端冒烟测试 | 模拟完整 agent 循环：plan → dispatch → execute → checkpoint | ❌ |

### E. 文档 & 清理

| # | 项目 | 说明 | 状态 |
|---|------|------|------|
| E1 | API 文档 | 为新增模块生成 TypeDoc 或写 README | ❌ |
| E2 | CHANGELOG 更新 | 记录 P1 里程碑 | ❌ |
| E3 | 未使用导入清理 | grep 检查未使用的 import | ❌ |

---

## 三、执行策略

1. **每 5 分钟自动检查**，按优先级执行：
   - 修复失败测试（A1）→ 补测试（A2-A6）→ 架构（C1-C3）→ 测试覆盖（D1-D5）→ 性能（B1-B3）→ 文档（E1-E3）
2. **每轮完成一项**，提交后继续下一项
3. **当所有项目完成**，取消定时任务

---

## 四、进度追踪

| 时间 | 完成项 | 测试变化 |
|------|--------|----------|
| 2026-05-10 16:16 | A1 | 430/0 (CLI flags 修复: 延迟导入 flow-run/repl-run) |

---

*本文档由自动改进流程维护，每轮更新。*
