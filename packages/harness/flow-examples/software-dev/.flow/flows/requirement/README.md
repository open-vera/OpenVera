# 需求分析

## 职责

产品经理分析任务目标，明确功能范围、优先级和验收标准。用户代表从用户视角评审。

## 参与角色

- **pm**: 主导需求分析，功能拆解，优先级排序
- **user**: 从用户视角评估需求合理性

## 输入

- 任务目标: [task/goal.md](../../task/goal.md)

## 必须产出的文件

用 write_file 创建以下文件（相对于项目根目录）：

1. `docs/prd.md` — 产品需求文档
   - 功能列表（P0/P1/P2/P3）
   - 每个功能的验收标准
   - MVP 范围

2. `docs/user-stories.md` — 用户故事
   - As a / I want / So that 格式
   - 每个故事的验收标准

3. `docs/user-feedback.md` — 用户视角评审

4. `flows/requirement/output/summary.md` — 执行摘要

## 准出标准

- 覆盖 goal.md 中全部核心功能
- 每个功能有 P0-P3 优先级
- 每个用户故事有验收标准
- MVP 范围清晰
- 最低得分: 0.7
