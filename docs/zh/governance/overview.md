# 评测与治理总览

> Vera 的质量保障体系涵盖 Benchmark 评测、测试覆盖率、静态代码分析、存储专项测试、Agent 工作审查五大子系统。本文档为总入口，介绍各子系统的定位与关系，并链接到详细文档。

---

## 体系全景

Vera 的评测与治理体系围绕"代码质量可量化、Agent 行为可复现、改进方向可追踪"三个目标构建：

```
+---------------------------------------------------------------------+
|                        评测与治理体系                                  |
+-----------------+-----------------+----------------+-----------------+
|  Benchmark      |  测试覆盖率       |  静态分析       |  Agent 工作审查  |
|  评测            |                  |                 |                 |
|  能力边界测量    |  代码级质量       |  结构健康度      |  AI 协作可追溯   |
|  回归对比        |  变更门禁         |  复杂度控制      |  变更审计        |
+-----------------+-----------------+----------------+-----------------+
|                        存储与 UI 专项测试                               |
|                 SQLite / 持久化 / API / 黑盒回归                        |
+---------------------------------------------------------------------+
```

各子系统定位：

| 子系统 | 关注点 | 触发时机 | 详细文档 |
|---|---|---|---|
| Benchmark 评测 | Agent 能力边界、任务完成率、模型对比 | 模型切换、prompt 变更 | [benchmark.md](./benchmark.md) |
| 测试覆盖率 | 代码行/分支/函数覆盖、未测路径 | 每次提交前（门禁） | [coverage.md](./coverage.md) |
| 静态代码分析 | 文件长度、圈复杂度、认知复杂度、重复代码 | 按需 / 定期 | [static.md](./static.md) |
| 存储专项测试 | SQLite、持久化、导出、UI/API 冒烟 | 存储相关变更 | 见第 4 节 |
| Agent 工作审查 | Claude Code / Cursor 工作记录、变更审计 | 按需查询 | 见第 5 节 |

---

## 1. Benchmark 评测

Benchmark 不是"刷榜"，而是回答三个问题：这个 Agent 能可靠完成哪些任务类别？哪些会失败，为什么？模型/prompt 变更后能力提升还是退化？

评测分三层：L1 原子任务（单步工具调用）、L2 多步任务（多工具串联）、L3 规划任务（自主规划步骤）。评测维度覆盖任务完成率、工具调用准确率、步骤效率、Token 效率和稳定性。

支持四种评测方法：`exact` 精确匹配、`contains` 关键词匹配、`tool_match` 工具调用校验（均已实现），以及 `llm_judge` 语义评分（待实现）。外部接入 GAIA、SWE-bench Verified、AgentBench 等基准套件作为参照。

**详细文档**：[benchmark.md](./benchmark.md)

---

## 2. 测试覆盖率

### 目标与门禁

| 目标 | 阈值 | 强制 |
|---|---|---|
| 全局 lines 覆盖率 | >= 90% | 提交前检查 |
| Core 核心模块 | >= 80% | CI 门禁 |
| 新增业务逻辑 | 必须有对应 unit test | 是 |

核心模块：`tools/` `storage/` `adapters/` `config/` `memory/` `context/` `utils/`。纯类型定义和配置文件可跳过。

### 技术栈

- **框架**：Vitest + v8 coverage，输出 text + lcov
- **规模**：Core ~75 文件 ~1054 用例，Harness ~15 文件 ~268 用例
- **状态**：核心模块覆盖率全部达标（98%+），全局聚合被 `worktree/`（~86%）和 `tools/index.ts`（~72%）拉低

**详细文档**：[coverage.md](./coverage.md)

---

## 3. 静态代码分析

三个工具并行运行，总耗时约 4 秒：

```
quality-scan
├── oxlint（结构指标）           ~0.1s ─┐
├── ESLint + sonarjs（认知复杂度） ~3s  ─┤─→ 合并报告
└── jscpd（重复度）               ~4s ─┘
```

### 阈值总表

| 指标 | 工具 | warn | error |
|---|---|---|---|
| 文件总行数 | oxlint | 300 | 600 |
| 函数体行数 | oxlint | 50 | 100 |
| 圈复杂度 | oxlint | 10 | 20 |
| 嵌套深度 | oxlint | 4 | 6 |
| 参数数量 | oxlint | 4 | 7 |
| 认知复杂度 | sonarjs | 15 | — |
| 重复 token | jscpd | 50 | — |

### 工具分工

- **oxlint**（Rust）：多线程并行，快 50-100x，与主 ESLint 配置隔离
- **sonarjs**（eslint-plugin-sonarjs）：纯 AST 解析，不开类型检查，快 10-20x。认知复杂度比圈复杂度更接近阅读难度
- **jscpd**（JS Copy-Paste Detector）：token 级匹配，变量重命名不影响检测

与日常 `pnpm lint` 的关系：日常 lint 关注正确性和风格（ESLint + 类型检查，阻断构建）；quality-scan 关注结构健康和重复度（仅报告，不阻断）。

**详细文档**：[static.md](./static.md)

---

## 4. 存储与 UI 专项测试

覆盖 Vera 持久化层的完整测试矩阵，按优先级分三层：

| 层级 | 内容 | 示例 |
|---|---|---|
| P0（立即） | DataExporter 单元测试、SQLite 迁移边界、Memory 搜索 | 损坏 JSONL 行处理、FTS 中文搜索 |
| P1（扩展） | User Data TTL、存储组合查询、API 路由冒烟 | 命名空间隔离、分页排序 |
| P2（加固） | 性能测试、WAL 模式、事务回滚 | 万级 session 列表、中断恢复 |

测试对象覆盖：SQLite 存储（CRUD/查询/TTL/标签/FTS/事务）、Session 迁移（JSONL 往返/去重/验证）、Memory 持久化（重启恢复/条目淘汰/中文搜索）、数据导出（JSONL/CSV/JSON/CSV 转义）、User Data（命名空间隔离/覆盖语义）、UI/API 冒烟（Harness UI + Admin UI 路由/空状态/CORS）。

每个子系统都有端到端黑盒验证流程，通过公开 API 验证行为而非实现细节。

---

## 5. Agent 工作审查

Vera 开发过程中大量使用 AI 辅助（Claude Code + Cursor），为此建立了 AI 工作记录可追溯体系。

### 数据源

| 来源 | 存储位置 |
|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Git | `git log --since --until` |

### 审查 Skill

| Skill | 功能 | 示例 |
|---|---|---|
| `claude-session-review` | Claude Code 工作记录 | `/claude-session-review --days 1` |
| `cursor-session-review` | Cursor 工作记录 | `/cursor-session-review --days 1` |
| `agent-changes-report` | 综合报告（两者 + git log） | `/agent-changes-report` |

报告输出到 `docs/agent-changes/`，包含 session 汇总、prompt 列表、修改文件、关键操作描述。

---

## 6. 治理流程

### 日常开发流程

```
写代码 → pnpm test → coverage >= 90% → scan.sh 无 error → git commit 规范格式
                ↓                                    ↓
           任何失败                              error 级别发现
                ↓                                    ↓
           修复后重跑 ←────────────────────────────────┘
```

### 质量门禁一览

| 门禁 | 工具 | 阻断条件 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 编译错误 |
| 单元测试 | `pnpm test` | 任何失败 |
| 覆盖率 | `pnpm run test:coverage` | lines < 90% |
| 静态分析 | `bash .claude/skills/quality-scan/scan.sh` | error 级别发现 |
| 提交规范 | Git hook | 格式不合规 |
| 敏感文件 | `git status` 检查 | API Key 在 staged 中 |

### 提交规范

```
feat(scope): description | fix(scope): description | refactor(scope): desc
test(scope): description | docs(scope): description | chore(scope): description
```

scope：`core` `harness` `tool` `agent` `memory` `rag` `sandbox` `channel`

### CI 集成（规划中）

- [ ] PR 自动运行覆盖率 + 质量扫描，结果贴到 PR comment
- [ ] 趋势追踪：多次扫描结果对比，观察质量变化曲线

---

## 相关文档

| 文档 | 路径 |
|---|---|
| Benchmark 评测体系 | [benchmark.md](./benchmark.md) |
| 测试覆盖率报告 | [coverage.md](./coverage.md) |
| 静态代码分析 | [static.md](./static.md) |
| 项目架构 | [../architecture.md](../architecture.md) |
| 项目路线图 | [../roadmap.md](../roadmap.md) |
| 变更日志 | [../changelog.md](../changelog.md) |
