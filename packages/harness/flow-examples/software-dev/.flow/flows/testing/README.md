# 测试验证

## 职责

测试工程师编写并运行测试。

## 参与角色

- **tester**: 编写测试、运行测试、输出报告
- **developer**: 协助问题定位

## 输入

- 实现代码: `src/`
- 需求文档: `docs/prd.md`

## 必须产出的文件

用 write_file 创建：

1. `tests/` — 测试代码
   - Vitest 框架
   - 覆盖核心功能

2. `docs/test-report.md` — 测试报告
   - 用例清单
   - 通过率
   - 覆盖率

3. `flows/testing/output/summary.md` — 执行摘要

## 运行验证

用 bash 执行：
- `pnpm test` — 运行测试
- 检查覆盖率报告

## 准出标准

- 所有测试通过
- 覆盖率 ≥ 70%
- 无 P0 缺陷
- 最低得分: 0.7
