# 自动化开发、测试、迭代方案

> 基于 Vera Harness 的自动化闭环系统

## 📁 目录结构

```
docs/auto/
├── README.md              # 本文件
├── auto-dev.md            # 自动化开发方案
├── auto-test.md           # 自动化测试方案
├── auto-iterate.md        # 自动化迭代方案
├── scripts/               # 可执行脚本
│   ├── extract-tasks.sh   # 提取未完成任务
│   ├── auto-dev.sh        # 自动开发单个任务
│   ├── auto-dev-batch.sh  # 批量开发（整个 Phase）
│   ├── run-tests.sh       # 自动化测试运行器
│   ├── critique.sh        # 运行 Critique 评估
│   ├── auto-iterate.sh    # 自动迭代单个任务
│   ├── auto-iterate-batch.sh  # 批量迭代（整个 Phase）
│   └── auto-rollback.sh   # 自动回滚
└── reports/               # 自动生成的报告
    ├── test-report-*.md
    ├── iterate-*.md
    └── phase-iterate-summary-*.md
```

## 🚀 快速开始

### 1. 查看待完成任务

```bash
cd /Users/yang.zhou/workspace/open-vera
./docs/auto/scripts/extract-tasks.sh
```

### 2. 自动开发单个任务

```bash
./docs/auto/scripts/auto-dev.sh S1
```

### 3. 运行测试

```bash
./docs/auto/scripts/run-tests.sh
```

### 4. 自动迭代直到达标

```bash
./docs/auto/scripts/auto-iterate.sh S1
```

### 5. 批量处理整个 Phase

```bash
# 批量开发
./docs/auto/scripts/auto-dev-batch.sh 1

# 批量迭代
./docs/auto/scripts/auto-iterate-batch.sh 1
```

## 📊 核心流程

### 自动化开发流程

```
提取任务 → 创建分支 → LLM 生成代码 → 运行测试 → 提交 PR
```

### 自动化测试流程

```
覆盖率检查 → 回归测试 → 失败回滚 → 通知报告
```

### 自动化迭代流程

```
Critique 评估 → 发现问题 → Replan → 执行修复 → 验证 → 循环直到达标
```

## 🎯 终止条件

### 迭代终止条件

- `score >= 0.9`：质量达标，完成
- `iterations >= 5`：达到最大迭代次数，人工介入
- `confidence >= 0.95`：高置信度，可接受
- `no_critical_issues`：无 critical 问题

### 测试覆盖率门禁

- Lines: ≥ 90%
- Branches: ≥ 85%
- Functions: ≥ 90%
- Statements: ≥ 90%

## ⚙️ 配置

在 `.vera/settings.json` 中配置：

```json
{
  "auto_dev": {
    "model": "claude-sonnet-4",
    "max_retries": 3,
    "test_threshold": 90,
    "auto_pr": true
  },
  "auto_iterate": {
    "max_iterations": 5,
    "target_score": 0.9,
    "critique_model": "claude-sonnet-4",
    "replan_model": "claude-sonnet-4",
    "auto_fix": true
  }
}
```

## 📝 报告

所有报告自动保存到 `docs/auto/reports/`：

- **测试报告**: `test-report-YYYYMMDD-HHMMSS.md`
- **迭代报告**: `iterate-<task-id>-YYYYMMDD-HHMMSS.md`
- **失败报告**: `test-failure-YYYYMMDD-HHMMSS.md`
- **汇总报告**: `phase-iterate-summary-YYYYMMDD-HHMMSS.md`

## 🔧 CI/CD 集成

### GitHub Actions

```yaml
# .github/workflows/auto-test.yml
name: Auto Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: ./docs/auto/scripts/run-tests.sh
```

### 本地 Git Hook

```bash
# .git/hooks/pre-push
#!/bin/bash
./docs/auto/scripts/run-tests.sh --changed || exit 1
```

## 🎓 与 Vera Harness 集成

自动化迭代利用 Vera 自身的 Critique 能力：

```typescript
import { CriticAgent } from '@vera/harness/critic';
import { SelfLoopRunner } from '@vera/harness/flow';

const critic = new CriticAgent();
const loop = new SelfLoopRunner({
  maxCycles: 5,
  targetConfidence: 0.9,
  critic
});

await loop.run(task);
```

## ⚠️ 注意事项

1. **代码审查**: 自动生成的代码需要人工 review
2. **测试验证**: 所有改动必须通过测试门禁
3. **渐进式采用**: 建议先在小任务上试验
4. **监控迭代**: 关注迭代次数和评分趋势
5. **备份重要**: 回滚前会自动保存失败报告

## 📚 详细文档

- [自动化开发方案](auto-dev.md)
- [自动化测试方案](auto-test.md)
- [自动化迭代方案](auto-iterate.md)
