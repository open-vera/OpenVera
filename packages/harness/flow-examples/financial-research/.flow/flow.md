---
name: 上市公司财务研究流程
workspace: ../report/
max_retries: 3
---

# 目标

参考 [task/goal.md](task/goal.md)

# 交付目录

所有步骤产物（分析报告、数据表格、投资建议等）统一输出到 `../report/`。

每个步骤的 `flows/*/output/` 仅存放**步骤执行记录**（分析了什么、关键发现、给下一步的注意事项）。

# 步骤

## 1. 基础信息收集 → flows/info-gathering/
- 参与: researcher
- 输入: task/goal.md
- 准出: 参考 flows/info-gathering/README.md

## 2. 财务报表分析 → flows/financial-analysis/
- 参与: analyst, researcher
- 输入: flows/info-gathering/output/
- 准出: 参考 flows/financial-analysis/README.md

## 3. 行业对标研究 → flows/industry-benchmark/
- 参与: analyst, researcher
- 输入: flows/financial-analysis/output/
- 准出: 参考 flows/industry-benchmark/README.md

## 4. 风险评估 → flows/risk-assessment/
- 参与: risk-officer, analyst
- 输入: flows/industry-benchmark/output/
- 准出: 参考 flows/risk-assessment/README.md

## 5. 投资研究报告 → flows/research-report/
- 参与: analyst, risk-officer
- 输入: flows/risk-assessment/output/
- 准出: 参考 flows/research-report/README.md
