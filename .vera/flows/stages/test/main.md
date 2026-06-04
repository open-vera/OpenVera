---
name: 测试验证
agents: [tester]
---

# 测试验证

## 职责

测试工程师编写并运行测试，确保功能质量。

## 参与角色

- **tester**: 编写测试、运行测试、检查覆盖率

## 输入

- 实现代码: [stages/implement/output/](../implement/output/)

## 交付产物（写入项目目录）

- `packages/*/src/tests/` — 测试代码

## 步骤记录（写入 output/）

- `summary.md` — 测试报告（测试用例数、通过率、覆盖率）

## 准出标准

- 测试全部通过
- 覆盖率 ≥ 90%
- 覆盖边界条件和错误路径
- 最低得分: 0.7
