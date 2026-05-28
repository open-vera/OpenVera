# 编码实现

## 职责

开发工程师根据设计方案编写代码。

## 参与角色

- **developer**: 编写功能代码和技术文档

## 输入

- 架构文档: `docs/architecture.md`
- UI 设计: `docs/ui-design.md`

## 必须产出的文件

用 write_file 创建：

1. `src/` — 源代码
   - 按架构文档的模块结构组织
   - TypeScript strict mode
   - ESM 模块

2. `docs/dev-notes.md` — 开发说明
   - 本地运行步骤
   - 环境配置
   - 重要实现细节

3. `flows/implement/output/summary.md` — 执行摘要

## 准出标准

- P0 功能全部实现
- 代码能通过 TypeScript 编译
- 无明显安全漏洞
- 最低得分: 0.7
