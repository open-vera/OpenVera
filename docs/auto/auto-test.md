# 自动化测试方案（v2 — Flow 集成）

> 测试作为 Flow 的内置步骤，不是外部脚本

## 核心理念

测试不是事后跑的脚本，而是 **Flow 执行过程中的内置 Step**：

```
┌─────────────────────────────────────────────────────────┐
│                  DevFlow 步骤                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  analyze → implement → TEST → critique → fix → commit   │
│                          ↑                              │
│                          │                              │
│                    ┌─────┴─────┐                        │
│                    │           │                        │
│              ┌─────▼─────┐ ┌──▼──────────┐             │
│              │ Unit Test │ │ Coverage    │             │
│              │ vitest    │ │ ≥90% 门禁   │             │
│              └───────────┘ └─────────────┘             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 测试策略

### 1. 单元测试（开发时自动生成）

每个任务的实现代码会自动生成对应测试：

```
packages/harness/src/flow/self-loop.ts
packages/harness/src/flow/tests/self-loop.test.ts  ← 自动生成
```

### 2. 集成测试（Flow 完成后）

```typescript
// DevFlow 内置测试步骤
const testStep = {
  name: 'test',
  execute: async (context) => {
    // 1. 运行单元测试
    const unitResult = await runVitest(context.changedFiles);
    
    // 2. 检查覆盖率
    const coverage = await checkCoverage(context.changedFiles);
    
    // 3. 运行相关集成测试
    const integrationResult = await runIntegrationTests(context.task);
    
    return {
      passed: unitResult.passed && integrationResult.passed,
      coverage,
      failures: [...unitResult.failures, ...integrationResult.failures],
    };
  }
};
```

### 3. 回归测试（合并前）

```typescript
// Orchestrator 在合并 PR 前运行全量回归
const regressionStep = {
  name: 'regression',
  execute: async (results) => {
    // 运行所有包的测试
    const allPassed = await runAllTests();
    
    // 检查是否有破坏性变更
    const breakingChanges = detectBreakingChanges(results);
    
    return { allPassed, breakingChanges };
  }
};
```

## 覆盖率门禁

### 配置

```typescript
// packages/harness/src/auto-dev/config.ts

interface TestConfig {
  thresholds: {
    lines: 90;
    branches: 85;
    functions: 90;
    statements: 90;
  };
  
  // 自动补充测试直到达标
  autoSupplement: true;
  
  // 最大补充轮次
  maxSupplementRounds: 3;
}
```

### 自动补充测试

当覆盖率不达标时，SelfLoopRunner 会自动进入下一轮：

```
Iteration 1: 代码实现 → 测试覆盖率 78% → critique: 不够
Iteration 2: 补充测试 → 测试覆盖率 88% → critique: 还差一点
Iteration 3: 再补充 → 测试覆盖率 93% → critique: 达标 ✅
```

## 测试工具集成

### Vitest Runner

```typescript
// packages/harness/src/auto-dev/tools/vitest-runner.ts

interface VitestRunner {
  // 运行指定文件的测试
  run(files: string[]): Promise<TestResult>;
  
  // 运行带覆盖率的测试
  runWithCoverage(files: string[]): Promise<CoverageResult>;
  
  // 只运行失败的测试（快速重试）
  runFailed(): Promise<TestResult>;
  
  // 监听模式（开发时）
  watch(files: string[]): AsyncIterator<TestEvent>;
}
```

### 测试失败处理

```typescript
// 失败归因
const failure = failureAttributor.analyze(testError);

switch (failure.category) {
  case 'model':
    // LLM 生成的代码有 bug → 重新生成
    return { action: 'replan', reason: failure.rootCause };
    
  case 'tool':
    // 测试工具本身有问题 → 报告
    return { action: 'ask_human', reason: failure.rootCause };
    
  case 'context':
    // 上下文不足导致理解错误 → 补充上下文
    return { action: 'retry', context: failure.suggestedContext };
}
```

## 并行测试

当多个 Worker 并行开发时，测试也需要隔离：

```
Worker 1 (S1): worktree-1/ → vitest --project core
Worker 2 (S2): worktree-2/ → vitest --project harness
Worker 3 (S3): worktree-3/ → vitest --project core
```

### 隔离策略

1. **Git Worktree**: 每个 Worker 独立的工作目录
2. **端口分配**: 不同 Worker 使用不同端口（如有服务）
3. **数据库隔离**: 每个 Worker 使用独立的测试数据库
4. **报告聚合**: 所有 Worker 的覆盖率报告合并计算

## CI/CD 集成

### GitHub Actions

```yaml
# .github/workflows/auto-dev.yml
name: Auto Dev
on:
  workflow_dispatch:
    inputs:
      phase:
        description: 'Phase number'
        required: true

jobs:
  auto-dev:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        task: [S1, S2, S3]  # 并行
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      
      - name: Run DevFlow
        run: |
          vera auto-dev run ${{ matrix.task }} \
            --executor claude-code \
            --max-cycles 5
      
      - name: Upload Test Report
        uses: actions/upload-artifact@v4
        with:
          name: test-report-${{ matrix.task }}
          path: docs/auto/reports/
```

## 报告格式

### 单任务报告

```markdown
# DevFlow Report: S1

## 执行摘要
- 任务: 创建 self-loop.ts 骨架
- 迭代次数: 3
- 最终评分: 0.92
- 耗时: 4m 32s

## 测试结果
- 单元测试: 15/15 passed
- 覆盖率: 93.2% (lines), 87.5% (branches)

## 变更文件
- packages/harness/src/flow/self-loop.ts (新建)
- packages/harness/src/flow/tests/self-loop.test.ts (新建)

## Critique 记录
| Iteration | Score | Issues | Action |
|-----------|-------|--------|--------|
| 1 | 0.72 | 3 | replan |
| 2 | 0.85 | 1 | replan |
| 3 | 0.92 | 0 | complete |
```

### Phase 汇总报告

```markdown
# Phase 1 Auto-Dev Summary

## 任务完成情况
| Task | Status | Iterations | Score | Duration |
|------|--------|------------|-------|----------|
| S1 | ✅ | 3 | 0.92 | 4m 32s |
| S2 | ✅ | 2 | 0.95 | 3m 15s |
| S3 | ⏳ | 4 | 0.78 | 8m 20s |

## 整体统计
- 完成: 2/3
- 平均迭代: 3.0
- 平均评分: 0.88
- 总耗时: 16m 07s

## 覆盖率汇总
- @vera/core: 94.2%
- @vera/harness: 91.8%
- @vera/benchmark: 85.3% ⚠️
```
