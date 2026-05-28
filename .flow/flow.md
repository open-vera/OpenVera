---
name: 自动化开发流程
workspace: ..
max_retries: 2
---

# 目标

参考 task/goal.md

# 交付目录

所有步骤产物（代码、测试等）统一输出到项目根目录，各 agent 在此目录协作。

每个步骤的 `flows/*/output/` 仅存放步骤执行记录（做了什么、准出评分、给下一步的注意事项）。

# 步骤

## 1. 需求分析 → flows/requirement/
- 参与: pm
- 输入: task/goal.md
- 准出: 参考 flows/requirement/README.md

## 2. 架构分析 → flows/analyze/
- 参与: architect
- 输入: flows/requirement/output/
- 准出: 参考 flows/analyze/README.md

## 3. 接口设计 → flows/design/
- 参与: architect
- 输入: flows/analyze/output/
- 准出: 参考 flows/design/README.md

## 4. 编码实现 → flows/implement/
- 参与: engineer
- 输入: flows/design/output/
- 准出: 参考 flows/implement/README.md

## 5. 编写测试 → flows/test/
- 参与: tester
- 输入: flows/implement/output/
- 准出: 参考 flows/test/README.md

## 6. 代码审查 → flows/review/
- 参与: reviewer
- 输入: flows/implement/output/, flows/test/output/
- 准出: 参考 flows/review/README.md
