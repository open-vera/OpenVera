# 方案设计

## 职责

开发工程师和设计师共同制定技术方案和 UI 设计方案。

## 参与角色

- **developer**: 系统架构设计、技术选型、API 设计
- **designer**: 交互设计、视觉规范、组件设计

## 输入

- 需求分析产物: [flows/requirement/output/](../requirement/output/)

## 交付产物（写入项目目录）

写入 `../project/docs/`：

- `architecture.md` — 系统架构设计文档（模块划分、数据流、技术栈）
- `api-design.md` — API 接口设计文档
- `ui-design.md` — UI 交互设计说明、组件规范

## 步骤记录（写入 output/）

写入本目录 `output/`：

- `summary.md` — 执行摘要（方案要点、关键决策、给开发的注意事项）

## 准出标准

- 架构覆盖所有 P0 功能模块
- API 定义完整（请求/响应格式、状态码、鉴权方式）
- UI 设计覆盖核心页面和交互流程
- 技术选型有明确的理由说明
- 最低得分: 0.75
