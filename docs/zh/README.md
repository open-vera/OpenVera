# OpenVera 文档

> Harness 原生 agent 运行时——自规划、自循环、自批判、自进化。

OpenVera 是一个围绕 **Harness 内核** 构建的 TypeScript agent 运行时。Vera 不是让 LLM 直接访问工具，而是将每个动作通过结构化的执行框架来路由：意图路由选择正确的模型，流转状态机驱动执行，独立的 Challenger 批判每一步。结果是一个能自己规划工作、自己发现错误、并随时间自我改进的运行时——不是通过提示词技巧，而是通过工程化的系统能力。

文档为双语。英文页面位于 `/`，中文翻译位于 `/zh/`。

---

## 快速入门

初次接触 OpenVera？从这里开始。

| 文档 | 描述 |
|---|---|
| [安装](./guide/install.md) | 安装 CLI、运行配置向导、配置提供商和模型 |
| [CLI 参考](./guide/routing.md) | 意图路由——L0/L1/L2 分类，按任务复杂度自动选择模型 |
| [架构](./architecture.md) | Core 与 Harness 的职责边界、依赖方向、模块布局 |
| [路线图](./roadmap.md) | 分阶段计划：P0 运行时、P1 自循环、P2 自进化、P3 平台扩展 |

**快速安装：**

```bash
npm i @open-vera/openvera@latest -g
ai
```

`ai`、`vera` 和 `openvera` 均为别名。首次运行会启动交互式配置向导。

---

## 架构与设计

OpenVera 是一个分四层结构的 monorepo。依赖方向严格为：`harness -> core`，Core 绝不从 Harness 导入。

### Core（`packages/core`）

无状态、单次调用的 agent 循环。适配器、工具、上下文、会话——单次 LLM 调用所需的一切。

| 文档 | 描述 |
|---|---|
| [Agent](./core/agent.md) | Agent 能力全景、系统提示词组合、模型适配器 |
| [运行时](./core/runtime.md) | Core 运行时设计——适配器抽象、agent 循环、流式传输 |
| [计划模式](./core/plan-mode.md) | 结构化的 ExecutionPlan、11 状态流转机、嵌套规划、检查点/恢复 |
| [上下文](./core/context.md) | 上下文窗口管理、token 预算、消息排序 |
| [压缩](./core/compression.md) | 渐进压缩、微精简、响应精简、召回 |
| [子 Agent](./core/subagent.md) | 编排器/工作者模型、依赖 DAG、隔离模式、调度 |
| [工具](./core/tools.md) | 内置工具注册表、工具生命周期、参数验证 |
| [工具运行时](./core/tool-runtime.md) | 中间件管道、before/after/onError 钩子、错误隔离 |
| [工具渲染](./core/tool-render.md) | 输出渲染、RenderHint、渲染器组件 |
| [技能](./core/skill.md) | Markdown 定义的自定义技能、意图驱动激活、热重载 |
| [技能进化](./core/skill-evo.md) | 自我完善的技能定义、提案与发布管道 |
| [会话](./core/session.md) | 会话持久化、AI 生成标题、费用追踪、分支 |
| [加载器](./core/loaders.md) | 项目上下文加载、CLAUDE.md、按路径范围的规则 |
| [操作录制](./core/op-recorder.md) | 操作录制与回放，用于调试和评估 |
| [工作树](./core/worktree.md) | Git worktree 集成，用于隔离任务执行 |

### Harness（`packages/harness`）

有状态编排。流转状态机、批判循环、提案管道、技能进化——多步任务执行。

| 文档 | 描述 |
|---|---|
| [概览](./harness/overview.md) | Harness 在 Vera 技术栈中的角色——执行内核，不是安全外壳 |
| [设计](./harness/design.md) | 流转状态机、权限边界、Challenger 独立性、提案管道 |
| [运行时](./harness/runtime.md) | HarnessRuntime 实现、模块职责、代码结构 |
| [进化](./harness/evolution.md) | 自进化循环——基准测试把关的提案、证据驱动的改进 |
| [技术参考](./harness/tech.md) | 实现细节、数据结构、内部协议 |

### 平台（`packages/platform`）

扩展能力。渠道适配器、沙箱执行、MCP、RAG、多 Agent 网络。

| 文档 | 描述 |
|---|---|
| [概览](./platform/overview.md) | 平台层架构与扩展点 |
| [插件系统](./platform/plugin.md) | 插件 API、生命周期钩子、注册表 |
| [计算机使用](./platform/computer-use.md) | 浏览器与桌面自动化、基准测试集成 |
| [多 Agent](./platform/multi-agent.md) | 多 Agent 网络、通信协议、协调模式 |
| [MCP 集成](./platform/mcp.md) | 模型上下文协议、工具服务器、资源提供者 |
| [RAG](./platform/rag.md) | 检索增强生成、向量存储、嵌入管道 |
| [沙箱](./platform/sandbox.md) | 代码执行隔离、路径边界约束、安全插件 |
| [渠道](./platform/channel.md) | ChannelAdapter 接口、CLI/HTTP/Discord/飞书后端 |
| [存储](./platform/storage.md) | 持久化层——SQLite、JSONL、会话存储、向量存储 |

### Gateway（`apps/gateway-ui`）

管理控制台与 API 服务器。

| 文档 | 描述 |
|---|---|
| [控制面板](./gateway/control.md) | 运行工作区、能力管理器、项目注册中心、系统诊断 |
| [Harness UI](./gateway/harness-ui.md) | 可视化 Flow 运行、流式日志、产物浏览 |

---

## 治理与质量

| 文档 | 描述 |
|---|---|
| [概览](./governance/overview.md) | 代码治理理念、审查流程、质量关卡 |
| [基准测试](./governance/benchmark.md) | 评估框架——GAIA、SWE-bench、ToolBench、评分方法 |
| [覆盖率](./governance/coverage.md) | 测试覆盖率目标、测量工具、缺口分析 |
| [静态分析](./governance/static.md) | oxlint、eslint-plugin-sonarjs、jscpd——规则、阈值、CI 集成 |

---

## 参考

| 文档 | 描述 |
|---|---|
| [路线图](./roadmap.md) | 分阶段路线图，含交付跟踪、已知缺陷与技术债 |
| [变更日志](./changelog.md) | 按时间顺序的变更索引，链接到每批次详细记录 |
| [发布说明](./releases/v0.3.1.md) | 每个已发布版本的发布说明与迁移指南 |
| [GitHub](https://github.com/open-vera/OpenVera) | 源代码、issues、讨论 |

---

## 阅读顺序

如果你是初次接触此代码库，请按以下路径阅读：

1. **[路线图](./roadmap.md)** — 了解愿景、各阶段和当前状态
2. **[架构](./architecture.md)** — 学习 Core/Harness 边界和依赖规则
3. **[Harness 设计](./harness/design.md)** — 研究执行内核（最重要）
4. **[Core Agent](./core/agent.md)** — 理解 agent 能力全景
5. **[Core 运行时](./core/runtime.md)** — 查看单次调用如何在系统中流转
6. **[计划模式](./core/plan-mode.md)** — 结构化规划与流转状态机
7. **[压缩](./core/compression.md)** — 通过渐进精简实现无限上下文
8. **[治理概览](./governance/overview.md)** — 质量关卡与贡献期望
