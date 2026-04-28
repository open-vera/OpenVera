---
name: 软件功能开发流程
workspace: ../project/
max_retries: 5
---

# 目标

参考 [task/goal.md](task/goal.md)

# 交付目录

所有步骤产物（代码、文档、测试报告等）统一输出到 `../project/`，各 agent 在此目录协作。

每个步骤的 `flows/*/output/` 仅存放**步骤执行记录**（做了什么、改了什么、准出评分、给下一步的注意事项），不放交付产物本身。

# 步骤

## 1. 需求分析 → flows/requirement/
- 参与: pm, user
- 输入: task/goal.md
- 准出: 参考 flows/requirement/README.md

## 2. 方案设计 → flows/design/
- 参与: developer, designer
- 输入: flows/requirement/output/
- 准出: 参考 flows/design/README.md

## 3. 开发实现 → flows/implement/
- 参与: developer
- 输入: flows/design/output/
- 准出: 参考 flows/implement/README.md

## 4. 测试验证 → flows/testing/
- 参与: tester, developer
- 输入: flows/implement/output/
- 准出: 参考 flows/testing/README.md

## 5. 发布上线 → flows/deploy/
- 参与: developer, ops
- 输入: flows/testing/output/
- 准出: 参考 flows/deploy/README.md
