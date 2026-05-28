# 发布上线

## 职责

运维工程师编写部署和运维文档。

## 参与角色

- **developer**: 发布脚本、配置管理
- **ops**: 部署方案、监控配置

## 输入

- 测试报告: `docs/test-report.md`
- 实现代码: `src/`

## 必须产出的文件

用 write_file 创建：

1. `docs/deploy-guide.md` — 部署手册
   - 环境要求
   - 部署步骤
   - 配置说明

2. `docs/runbook.md` — 运维手册
   - 监控指标
   - 告警处理
   - 回滚流程

3. `flows/deploy/output/summary.md` — 执行摘要

## 准出标准

- 部署文档完整可复现
- 回滚方案就绪
- 最低得分: 0.7
