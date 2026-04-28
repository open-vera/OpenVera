---
name: 文本与网页标注质检流程
workspace: ../dataset/
max_retries: 4
---

# 目标

参考 [task/goal.md](task/goal.md)

# 交付目录

所有步骤产物（标注结果、质检报告、最终数据集等）统一输出到 `../dataset/`。

每个步骤的 `flows/*/output/` 仅存放**步骤执行记录**（处理了什么、质量指标、给下一步的注意事项）。

# 步骤

## 1. 标注规范制定 → flows/spec/
- 参与: data-manager, annotator
- 输入: task/goal.md
- 准出: 参考 flows/spec/README.md

## 2. 数据预处理 → flows/preprocessing/
- 参与: data-manager
- 输入: flows/spec/output/
- 准出: 参考 flows/preprocessing/README.md

## 3. 内容标注 → flows/annotation/
- 参与: annotator
- 输入: flows/preprocessing/output/
- 准出: 参考 flows/annotation/README.md

## 4. 质量检验 → flows/qa/
- 参与: qa-inspector, annotator
- 输入: flows/annotation/output/
- 准出: 参考 flows/qa/README.md

## 5. 数据交付 → flows/delivery/
- 参与: data-manager, qa-inspector
- 输入: flows/qa/output/
- 准出: 参考 flows/delivery/README.md
