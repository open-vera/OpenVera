---
name: 软件功能开发流程
workspace: ..
max_retries: 2
---

# 目标

参考 task/goal.md

# 交付目录

所有代码、文档写入项目根目录。每个步骤的 `flows/*/output/` 只放执行摘要。

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
