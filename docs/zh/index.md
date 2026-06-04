---
layout: home

hero:
  name: "OpenVera"
  text: "Harness 原生 Agent 运行时"
  tagline: 自规划 · 自循环 · 自批判 · 自进化
  actions:
    - theme: brand
      text: 安装 →
      link: "#install"
    - theme: alt
      text: 文档
      link: /zh/README
    - theme: alt
      text: GitHub
      link: https://github.com/open-vera/OpenVera
---

## 愿景

> **加速人类创造力，实现 SOTA AGI。**

我们正处于拐点：模型已经足够强大，但执行框架成了瓶颈。Vera 的使命是构建一个**可靠、可验证、可复利增长**的 agent 运行时，将人类想法转化为现实——其速度和质量是任何手动流程无法企及的。

### 核心理念

- **Harness 是内核，不是安全外壳。** 每次工具调用、每次状态转换、每次自我提升都经过原则性的执行框架。
- **不要设计一个产生更多输出的系统。设计一个让不合格输出更难通过的系统。**
- **批判必须在结构上独立。** 同一个 agent 不能同时是执行者、评估者和自身工作的裁判。
- **失败必须产生归因，而不仅仅是重试。** 没有根因分析，恢复不过是更高成本的重蹈覆辙。
- **改进必须由证据驱动。** 每一次变更都通过基准测试赢得入场券，而非凭直觉。

## 安装 {#install}

```bash
npm i @open-vera/openvera@latest -g
ai
```

`ai`、`vera` 和 `openvera` 均为别名。首次运行会启动交互式配置向导。

```bash
ai init          # 重新运行配置向导
ai init --force  # 强制重新运行，即使配置已存在
```

## 快速配置

```jsonc
// .vera/settings.json
{
  "providers": {
    "compony": {
      "adapter": "anthropic",
      "api_key": "...",
      "base_url": "https://your-api-gateway.example.com"
    }
  },
  "default_model": "deepseek-v4-flash"
}
```

`base_url` 用于指向公司 API 网关或自定义端点，不填则使用各 adapter 默认地址。

### 模型路由

模型路由按任务复杂度自动选择最合适的模型——简单问题用便宜模型，复杂任务用强大模型。分类延迟约 100ms，通常可降低 60%+ 的成本而不牺牲质量。

```jsonc
"routing": { "enabled": true, "classifier": "deepseek-v4-flash", "l0": "...", "l1": "...", "l2": "..." }
```

| 级别 | 任务类型 | 示例 |
|---|---|---|
| L0 | 闲聊、简单问答 | "TypeScript 是什么？" |
| L1 | 单步任务 | "写一个解析 CSV 的函数" |
| L2 | 多步、深度推理 | "设计一个分布式锁系统" |

| 字段 | 用途 |
|---|---|
| `providers` | 每个提供商的连接配置（adapter、api_key、base_url） |
| `default_model` | 路由禁用时使用的模型 |
| `routing` | 按任务复杂度自动选择 L0/L1/L2 模型 |
| `session` | AI 标题生成、长会话精简 |

[→ 完整配置指南](/zh/README)

## 功能特性

### Agent 运行时

| 能力 | 描述 |
|---|---|
| **意图路由** | L0/L1/L2 分类（约 100ms），按任务复杂度自动选择模型 |
| **计划模式** | 结构化的 ExecutionPlan，11 状态流转机，嵌套规划，检查点/恢复 |
| **批判循环** | 独立的 Challenger 对每一步打分，信心度 < 0.7 自动触发重规划 |
| **无限上下文** | 渐进压缩 + 微精简 + 响应精简 + 召回；首条消息始终保留 |
| **子 Agent 系统** | 编排器/工作者架构，依赖 DAG，3 种隔离模式（无/尝试/远程） |
| **工具中间件** | 多层 before/after/onError 管道，每层错误隔离 |

### 数据与持久化

| 能力 | 描述 |
|---|---|
| **会话存储** | JSONL 持久化，AI 生成标题，费用追踪，分支（/try、/merge） |
| **记忆系统** | 线程安全写入，崩溃安全，层级分离（语义/情景/工作） |
| **权限规则** | 按工具/路径的持久化允许/拒绝，bash 风险确认关卡 |
| **项目上下文** | `.vera/rules.md`、`CLAUDE.md`，按路径范围激活规则 |

### 工具与平台

| 能力 | 描述 |
|---|---|
| **7 个内置工具** | `read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| **自定义技能** | Markdown 定义的技能，意图驱动激活，热重载 |
| **Gateway 控制台** | 管理面板：运行工作区、能力管理器、诊断、项目注册 |
| **多渠道** | CLI REPL、HTTP API、Discord 机器人、飞书机器人——通过统一的 ChannelAdapter 接口 |
| **沙箱** | 代码执行隔离，路径边界约束，安全插件架构 |

## 架构

```
人类想法
  → 意图分类与模型路由（L0 / L1 / L2）
  → 结构化 Flow → ExecutionPlan
  → 通过工具运行时分步执行
  → 独立批判（Challenger）
  → 失败归因与重规划
  → 经验沉淀 → 记忆
  → 基准测试把关的提案 → 发布上线
  → 下一个周期，在边界内运行
```

**关注点分离：**

```
packages/
├── core/        无状态 agent 循环——adapters、tools、session、context
├── harness/     有状态编排——flow 状态机、critique、skill
├── gateway/     能力注册中心、项目注册中心、诊断
├── logger/      带脱敏的结构化日志
└── shared/      共享类型与工具

apps/
├── gateway-ui/web/    Vue 3 管理控制台
└── gateway-ui/server/ API 服务
```

> **关键约束：** 角色 Agent 绝不能自行决定其工作是否完成。该权利专属于 Challenger。详见 [Harness 设计 →](/zh/harness/design)

## 路线图

| 阶段 | 目标 | 关键交付 | 状态 |
|---|---|---|---|
| **P0** | Harness 驱动的执行运行时 | 意图路由、7 个工具、无限上下文、计划模式、批判、会话、子 Agent | ✅ 已完成 |
| **P1** | 自循环与自纠正 | 检查点/恢复、记忆持久化、子 Agent 编排器/池、工具中间件 | ✅ 已完成 |
| **P2** | 自进化 | Dreaming、提案管道、技能进化、策略存储、变更追踪 | 🏗️ 进行中 |
| **P3** | 通用 Agent 平台 | 计算机使用、MCP、多 Agent 网络、RAG、沙箱、渠道适配器 | 🏗️ 进行中 |

[→ 完整路线图](/zh/roadmap)

## 技术栈

| 层级 | 技术 |
|---|---|
| 语言 | TypeScript（strict、ESM） |
| 包管理器 | pnpm workspace monorepo |
| LLM 适配器 | Anthropic、OpenAI、Gemini、DeepSeek、Groq、Azure |
| 终端 UI | React + Ink |
| Web UI | Vue 3 + Vite |
| 测试运行器 | Vitest（核心模块 ≥ 90%，整体约 80%） |
| 静态分析 | oxlint + eslint-plugin-sonarjs + jscpd |
