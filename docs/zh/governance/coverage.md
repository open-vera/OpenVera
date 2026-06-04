# 测试覆盖率总览

> 项目：open-vera（monorepo） | 测试框架：Vitest + v8 coverage
> 最后更新：2026-06-04

## 概述

Vera 项目使用 Vitest 作为测试框架，v8 作为覆盖率提供者。测试是提交的前置条件，覆盖率阈值检查在 CI 中强制执行。

## 覆盖率目标与阈值

根据项目 CLAUDE.md 要求：

| 目标 | 阈值 |
|--------|-----------|
| 全局 lines 覆盖率 | >= 90% |
| 核心模块（tools/ storage/ adapters/ config/ memory/ context/ utils/） | >= 80% |
| E2E 测试 | 位于 `packages/harness/tests/e2e-*.ts` |

> 注意：CLAUDE.md 要求 >= 90% 覆盖率。`vitest.config.ts` 中未设置硬性 `thresholds` 配置——阈值通过 CI 脚本和提交前检查强制执行。

### 提交前检查清单

1. 运行 `pnpm --filter @open-vera/core run test:coverage`，确认 lines 覆盖率 >= 90%
2. 运行 `bash .claude/skills/quality-scan/scan.sh`，oxlint / sonarjs 不得有 `error` 级别发现
3. 新增业务逻辑必须有对应单元测试
4. 纯类型定义、配置文件和文档可跳过测试

## 运行覆盖率

```bash
# Core 包覆盖率（最常用）
pnpm --filter @open-vera/core run test:coverage

# 全量覆盖率（所有包）
pnpm test:coverage

# 仅运行测试（无覆盖率）
pnpm test
pnpm --filter @open-vera/core test
pnpm --filter @open-vera/harness test
```

### Vitest 配置

**文件**：`packages/core/vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    globals: true,
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
    },
  },
});
```

输出格式：
- `text`：终端表格输出（按模块汇总）
- `lcov`：生成 `coverage/lcov.info`，可通过 VS Code 插件查看，或使用 `lcov-html` 查看详细的行级覆盖率

## 当前覆盖率状态

以下为最近一次运行的覆盖率快照（按模块）：

| 模块 | Statements | Branches | Functions | Lines |
|--------|-----------|----------|-----------|-------|
| **全局聚合** | 78.39% | 69.88% | 79.97% | 79.76% |
| **src/tools/** | 98.28% | 95.18% | 99.14% | 98.45% |
| **src/storage/** | 97.70% | 92.93% | 98.64% | 98.71% |
| **src/context/** | 94.96% | 89.91% | 100% | 95.99% |
| **src/config/** | 98.90% | 96.23% | 100% | 100% |
| **src/memory/** | 96.79% | 89.54% | 100% | 97.39% |
| **src/adapters/** | 97.24% | 88.32% | 100% | 98.09% |
| **src/session/** | ~97% | ~92% | ~100% | ~97% |
| **src/agent/** | ~94% | ~83% | ~100% | ~96% |
| **src/utils/** | 97.12% | 88.13% | 100% | 100% |
| **src/rag/** | ~98% | ~92% | ~90% | ~98% |
| **src/sandbox/** | ~95% | ~86% | ~100% | ~96% |
| **src/worktree/** | 83.33% | 68.57% | 100% | 85.96% |
| **src/tools/index.ts** | 71.79% | 55.55% | 100% | 71.79% |

> 注意：全局聚合 78.39% 低于 90% 目标，主要被 `src/worktree/` 和 `src/tools/index.ts` 拉低（后者是一个包含大量条件分支的工厂函数，测试覆盖率为 71.79%）。

### 核心模块阈值达标情况

| 核心模块 | Lines 覆盖率 | >= 80% 阈值？ |
|-------------|---------------|-------------------|
| tools/ | 98.45% | 通过 |
| storage/ | 98.71% | 通过 |
| adapters/ | 98.09% | 通过 |
| config/ | 100% | 通过 |
| memory/ | 97.39% | 通过 |
| context/ | 95.99% | 通过 |
| utils/ | 100% | 通过 |

所有核心模块均超过 80% 阈值。

## 测试文件结构

```
packages/core/src/
  context/tests/           # compression.test.ts、tokens.test.ts、window.test.ts
  tools/tests/             # 每个工具的测试文件（20+）
  storage/tests/           # 存储层测试（SQLite、session、data-exporter 等）
  memory/tests/            # 记忆系统测试
  adapters/tests/          # LLM adapter 测试
  rag/tests/               # RAG vector store 测试
  sandbox/tests/           # Sandbox 测试
  session/tests/           # Session 管理测试
  agent/tests/             # Agent Loop 测试

packages/harness/tests/    # Harness 集成测试
  e2e-*.ts                 # E2E 测试
```

测试框架约定：
- 测试文件与源文件同目录，放在 `tests/` 子目录下
- 测试文件命名：`<module-name>.test.ts`
- 使用 `describe` / `it` / `expect`
- 仅 mock 外部 API 调用（LLM adapter、网络请求），不 mock 内部模块

## 覆盖率缺口与已知不足

### 主要缺口

1. **`src/worktree/`**（Lines: 85.96%）—— Git worktree 管理，错误处理和边界情况的分支未完全覆盖。
2. **`src/tools/index.ts`**（Lines: 71.79%）—— `createToolRegistry()` 工厂函数包含大量条件分支（`if (opts.memoryStore) ...` 等），每个 `if` 分支需要独立的测试场景。
3. **`src/tools/computer-use.ts`**（Lines: 94.96%）—— Computer Use 中部分错误路径和超时场景未覆盖。
4. **`src/tools/bash.ts`**（Lines: 98.59%）—— 进程组 kill 信号路径和 spawn 错误边界情况未完全覆盖（第 13 行和 75-84 行）。

### 计划补充的测试

根据 `docs/testing/storage/README.md` 中的覆盖率计划：

- **P0**：DataExporter 单元测试、SQLite 迁移边界情况、分支错误路径、Memory 持久化/搜索测试
- **P1**：User Data TTL/命名空间测试、存储组合查询筛选、UI/API 路由冒烟测试
- **P2**：性能测试（大 session 列表、memory 搜索）、可靠性测试（SQLite 关闭/重开、WAL、事务回滚）

### 工具文件测试清单

每个工具文件都有对应的测试文件。当前状态：

| 工具文件 | 测试文件 | Lines 覆盖率 |
|-----------|-----------|----------------|
| `read-file.ts` | `read-file.test.ts` | 100% |
| `write-file.ts` | `write-file.test.ts` | ~99% |
| `edit-file.ts` | `edit-file.test.ts` | 100% |
| `list-dir.ts` | `list-dir.test.ts` | ~98% |
| `glob.ts` | `glob.test.ts` | ~97% |
| `grep.ts` | `grep.test.ts` | 97.43% |
| `bash.ts` | `bash.test.ts` | 98.59% |
| `security.ts` | `security.test.ts` | 100% |
| `registry.ts` | `registry.test.ts` | 99.23% |
| `tool-stats.ts` | `tool-stats.test.ts` | 97.61% |

## 静态分析工具

除了覆盖率，项目还使用三种静态分析工具进行质量保障（详见 `docs/code-governance/static-analysis.md`）：

### oxlint -- 结构指标

Rust 实现，多线程并行，极快（~0.1s）。

| 指标 | 规则 | Warn | Error |
|--------|------|------|-------|
| 文件总行数 | `max-lines` | 300 | 600 |
| 函数体行数 | `max-lines-per-function` | 50 | 100 |
| 圈复杂度 | `complexity` | 10 | 20 |
| 嵌套深度 | `max-depth` | 4 | 6 |
| 参数数量 | `max-params` | 4 | 7 |

### eslint-plugin-sonarjs -- 认知复杂度

仅解析 AST（无 projectService），比完整 lint 快 10-20 倍。

| 规则 | 阈值 |
|------|-----------|
| `cognitive-complexity` | 15 时 warn |
| `no-identical-functions` | warn |
| `no-duplicated-branches` | warn |

### jscpd -- 重复度检测

Token 级别匹配（不受变量重命名影响）。阈值：min-tokens = 50。

### 执行方式

```bash
# 一键完整静态分析 + 覆盖率
bash .claude/skills/quality-scan/scan.sh
```

输出终端摘要 + `docs/code-governance/report-<date>.md`。

## 测试运行管线

### 本地开发

```bash
# 类型检查
pnpm typecheck

# Core 包测试
pnpm --filter @open-vera/core test

# Core 包覆盖率
pnpm --filter @open-vera/core run test:coverage

# Harness 测试
pnpm --filter @open-vera/harness test

# 全量测试套件
pnpm test

# 质量扫描（oxlint + sonarjs + jscpd）
bash .claude/skills/quality-scan/scan.sh
```

### 强制提交前流程

```
1. pnpm --filter @open-vera/core run test:coverage  # lines >= 90%
2. bash .claude/skills/quality-scan/scan.sh          # 无 error
3. git add <specific files>                          # 禁止 git add -A
4. git commit -m "feat(scope): description"          # 遵循规范
```

### CI 集成（规划中）

根据 static-analysis.md 中的待办项：

- [ ] PR 自动运行覆盖率 + 质量扫描
- [ ] 将覆盖率报告和扫描摘要贴到 PR comment
- [ ] 趋势追踪：多次扫描结果对比，观察质量变化曲线

## 测试规模

| 包 | 测试文件 | 测试用例 |
|---------|-----------|------------|
| @open-vera/core | ~75 | ~1054 |
| @open-vera/harness | ~15 | ~268 |

## 常见问题

### 覆盖率数值似乎不准确？

确保运行的是 `test:coverage` 而非 `test`。`vitest.config.ts` 设置 `coverage.include` 为 `["src/**"]`，排除了测试文件和配置文件。

### 如何查看哪些具体行未被覆盖？

```bash
pnpm --filter @open-vera/core run test:coverage
npx lcov-html coverage/lcov.info -o coverage/html
open coverage/html/index.html
```

或安装 Coverage Gutters VS Code 插件，它会自动读取 `lcov.info` 并在编辑器中高亮未覆盖的行。

### 需要写测试但不知道从哪开始？

1. 查看覆盖率报告，找到覆盖率最低的模块
2. 阅读该模块的源码和已有测试，了解测试风格
3. 重点关注边界情况：错误路径、空输入、极端值、并发等
4. 纯类型定义文件（如 `types.ts`）不需要测试
