# Changelog — 入口索引

每次提交后，将本批次摘要追加到此文件，详细内容写入 `docs/changelog/<date>-<hour>.md`。

## 格式规则

- **date-hour**：取 commit 时间的 `YYYY-MM-DD-HH`（同一小时内多次提交合并为一条）
- **摘要**：一句话说明本批次做了什么，不超过 80 字
- **详细文件**：包含 commit 表格、Roadmap 同步说明、遗留事项

---

| 日期批次 | 摘要 | 详细 |
|---|---|---|
| 2026-05-28 · 19:xx | REPL live output + setup wizard + CubeSandbox + thinking/reasoning token 支持 | [→](./changelog/2026-05-28-19.md) |
| 2026-05-27 · 23:xx | Phase 17 AD4+AD5：A/B Testing — 并行策略对比 + 统计显著性检验（25 tests） | [→](./changelog/2026-05-27-23c.md) |
| 2026-05-27 · 23:xx | Phase 17 AD3：Auto-Tuner — UCB1 策略选择、复合评分、优化周期（37 tests） | [→](./changelog/2026-05-27-23b.md) |
| 2026-05-27 · 23:xx | Phase 17 AD2：Historical Success Rate — 时间窗口统计、趋势检测、自动调优（17 tests） | [→](./changelog/2026-05-27-23.md) |
| 2026-05-27 · 22:xx | Phase 17 AD1：Strategy Store — 策略仓库，按任务域存储配置 + 成果追踪 + 统计（44 tests） | [→](./changelog/2026-05-27-22.md) |
| 2026-05-27 · 22:xx | Phase 16 CH7：Channel Multi-Channel Concurrent Tests — Gateway 生命周期/消息路由/并发（8 tests） | [→](./changelog/2026-05-27-22.md) |
| 2026-05-27 · 22:xx | Phase 16 CH6：Channel Plugin Registry — 运行时动态加载/卸载 adapter（42 tests） | [→](./changelog/2026-05-27-22.md) |
| 2026-05-27 · 22:xx | Phase 16 CH5：Webhook Channel — HTTP webhook 接收器 + 签名验证（49 tests） | [→](./changelog/2026-05-27-22.md) |
| 2026-05-27 · 21:xx | Phase 16 CH4：API Channel — REST/WebSocket API（30 tests） | [→](./changelog/2026-05-27-21.md) |
| 2026-05-27 · 21:xx | Phase 16 CH3：CLI Channel — 命令行交互（interactive/pipe/non-interactive，24 tests） | [→](./changelog/2026-05-27-21.md) |
| 2026-05-27 · 20:xx | Phase 16 CH2：Channel Gateway — 多 channel 统一管理（41 tests） | [→](./changelog/2026-05-27-20c.md) |
| 2026-05-27 · 20:xx | Phase 16 CH1：Channel 抽象层 — 类型定义与接口（32 tests） | [→](./changelog/2026-05-27-20b.md) |
| 2026-05-27 · 20:xx | Phase 10.3 SP6：WebUI 集成 — 训练监控面板（25 tests） | [→](./changelog/2026-05-27-20.md) |
| 2026-05-27 · 19:xx | Phase 11 B3：GAIA L1 Benchmark Runner — GAIA 评测集自动跑分 | [→](./changelog/2026-05-27-19c.md) |
| 2026-05-27 · 19:xx | Phase 10.2 EV7：回归检测 — CIGate + CI workflow + 61 tests | [→](./changelog/2026-05-27-19b.md) |
| 2026-05-27 · 11:xx | UI Refinement：主题统一、Vue 3 生命周期修复、数据驱动图表、交互打磨、响应式布局 | [→](./changelog/2026-05-27-11.md) |
| 2026-05-27 · 08:xx | 完成全部管理端 UI 和 Core UI 开发，实现内存、检查点、子代理管理功能 | [→](./changelog/2026-05-27-08.md) |
| 2026-05-27 · 07:xx | 实现 Core UI 检查点管理和子代理管理页面，完成 Phase 7 和 Phase 8 前半部分 | [→](./changelog/2026-05-27-07.md) |
| 2026-04-28 · 12:xx | P0 对齐收尾：CLI 主题、pre-commit 扫描、background subagent 接口、quality-scan skill、docs 全面更新 | [→](./changelog/2026-04-28-12.md) |
| 2026-04-29 · 11:xx | Smoke 入口统一：修复 loop 空回复重试 bug、新增 REPL loop smoke test、统一 smoke suite 入口 | [→](./changelog/2026-04-29-11.md) |
| 2026-04-29 · 12:xx | M3 修复：bash 流式输出收集 + 512KB 阈值进程组提前终止，新增 5 个测试 | [→](./changelog/2026-04-29-12.md) |
| 2026-04-30 · 11:xx | TUI 控制器架构重构：controller 层拆分、queue dequeue 修复、slash command 重构 | [→](./changelog/2026-04-30-11.md) |
| 2026-05-04 · 17:xx | CLI 命令扩展 + star history | [→](./changelog/2026-05-04-17.md) |
| 2026-05-10 · 14:xx | Feature branch 核心实现：checkpoint/resume、memory 系统、tool runtime、P0 收尾测试（25 commits） | [→](./changelog/2026-05-10-14.md) |
| 2026-05-27 · 03:xx | P0 收尾 + P1 SelfLoopRunner & CriticAgent（11 commits） | [→](./changelog/2026-05-27-03.md) |
| 2026-05-27 · 08:xx | F1-F4 失败归因模块：分类、JSONL 记录、自动回放（12 tests） | [→](./changelog/2026-05-27-08.md) |
| 2026-05-27 · 08:xx | Phase 4+5 并行完成：Tool Runtime 增强（21 tests）+ Subagent 系统增强（37 tests） | [→](./changelog/2026-05-27-08.md) |
| 2026-05-11 · 01:xx | Bug 修复与类型安全：review fixes + TypeScript 严格模式零错误 | [→](./changelog/2026-05-11-01.md) |
| 2026-05-27 · 03:xx | P0 收尾 D4/E3 + P1 SelfLoopRunner(S1-S3) + CriticAgent(CR1-CR3) + 文档治理 | [→](./changelog/2026-05-27-03.md) |
| 2026-05-27 · 08:xx | Phase 6 SessionManager：auto-compress、dedup、keyword index、lifecycle cleanup（23 tests） | [→](./changelog/2026-05-27-09.md) |
| 2026-05-27 · 10:xx | Phase 7 Memory 增强：auto-extract、organize、compress、decay、graph（28 tests） | [→](./changelog/2026-05-27-10.md) |
| 2026-05-27 · 11:xx | Phase 8 Skill 增强：auto-extract、scoring、recommendation、versioning、hot-reload（34 tests） | [→](./changelog/2026-05-27-11.md) |
| 2026-05-27 · 09:xx | Phase 9 SQ1-SQ3：StorageProvider 抽象层 + SQLite 适配器 + 文件存储适配器（108 tests） | [→](./changelog/2026-05-27-09.md) |
| 2026-05-27 · 14:xx | Phase 9 SQ4：Session 存储迁移 — 同步写入、import/export、迁移验证（10 tests） | [→](./changelog/2026-05-27-14.md) |
| 2026-05-27 · 17:xx | Phase 10 R2：LocalVectorStore — SQLite 向量存储 + 余弦相似度搜索（59 tests） | [→](./changelog/2026-05-27-17.md) |
| 2026-05-27 · 18:xx | Phase 10 R3-R8：Embedding 适配器、文档加载器、knowledge_search 工具、增量索引器 | [→](./changelog/2026-05-27-18.md) |
| 2026-05-27 · 18:xx | Phase 10.2 EV2+EV8：GAIA Runner + Eval 框架测试（52 tests）+ change-tracker 修复 | [→](./changelog/2026-05-27-18b.md) |
| 2026-05-27 · 18:xx | Phase 10.2 EV3：SWE-bench 评测集集成 — SweBenchRunner + 30 tests | [→](./changelog/2026-05-27-18c.md) |
| 2026-05-27 · 19:xx | Phase 10.2 EV4：ToolBench 评测集集成 — ToolBenchRunner + 40 tests | [→](./changelog/2026-05-27-19.md) |
| 2026-05-27 · 15:xx | Phase 10 R1：RAG 向量存储抽象接口 — VectorStore / EmbeddingAdapter / 错误层次 | [→](./changelog/2026-05-27-15.md) |
