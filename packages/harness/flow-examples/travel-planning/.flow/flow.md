---
name: 旅游计划规划流程
workspace: ../trip/
max_retries: 3
---

# 目标

参考 [task/goal.md](task/goal.md)

# 交付目录

所有步骤产物（行程方案、预算表、预订清单等）统一输出到 `../trip/`。

每个步骤的 `flows/*/output/` 仅存放**步骤执行记录**（做了什么、发现了什么、给下一步的注意事项）。

# 步骤

## 1. 目的地调研 → flows/research/
- 参与: researcher, planner
- 输入: task/goal.md
- 准出: 参考 flows/research/README.md

## 2. 行程规划 → flows/itinerary/
- 参与: planner
- 输入: flows/research/output/
- 准出: 参考 flows/itinerary/README.md

## 3. 预算估算 → flows/budget/
- 参与: budget-analyst, planner
- 输入: flows/itinerary/output/
- 准出: 参考 flows/budget/README.md

## 4. 预订安排 → flows/booking/
- 参与: planner
- 输入: flows/budget/output/
- 准出: 参考 flows/booking/README.md

## 5. 旅行手册 → flows/handbook/
- 参与: planner, researcher
- 输入: flows/booking/output/
- 准出: 参考 flows/handbook/README.md
