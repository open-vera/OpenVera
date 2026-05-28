# 方案设计

## 职责

开发工程师设计技术方案，设计师设计 UI 交互。

## 参与角色

- **developer**: 系统架构、API 设计、数据模型
- **designer**: 交互设计、页面结构、组件规范

## 输入

- 需求文档: `docs/prd.md`
- 用户故事: `docs/user-stories.md`

## 必须产出的文件

用 write_file 创建：

1. `docs/architecture.md` — 技术架构
   - 模块划分
   - 技术栈选型
   - 数据流设计
   - API 接口列表

2. `docs/ui-design.md` — UI 设计
   - 页面结构
   - 交互流程
   - 组件规范

3. `flows/design/output/summary.md` — 执行摘要

## 准出标准

- 架构覆盖所有 P0 功能
- API 定义完整
- 技术选型有理由
- 最低得分: 0.7
