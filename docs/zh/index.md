---
layout: home

hero:
  name: "OpenVera"
  text: "Harness 原生 Agent Runtime"
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

> **加速人类创造力，迈向 SOTA AGI。**

我们正站在拐点：模型能力已经足够，瓶颈是**执行框架**。Vera 的使命是构建一个**可靠、可验证、持续进化**的 agent runtime，让人类创意以手动流程无法匹敌的速度和质量，转化为可工作的现实。

### 核心价值观

- **Harness 是内核，不是安全壳。** 每次工具调用、每次状态转换、每次自我改进，都经过有原则的执行框架。
- **不设计产出更多的系统。设计更难让不合格输出通过的系统。**
- **批判必须结构独立。** 同一个 agent 不能同时是实施者、评估者和裁判。
- **失败必须产生归因，而不只是重试。** 没有根因分析，恢复只是更高成本的重复错误。
- **改进必须以证据驱动。** 每次变更都通过基准测试验证才能合入。

## 安装 {#install}

```bash
npm i @open-vera/openvera@latest -g
ai
```

`ai`、`vera`、`openvera` 三个命令等价。首次运行自动进入交互式配置向导。

```bash
ai init          # 重新运行配置向导
ai init --force  # 已有配置时强制重新初始化
```

## 快速配置

```jsonc
// .vera/settings.json
{
  "providers": {
    "compony": { "adapter": "anthropic", "api_key": "..." }
  },
  "default_model": "deepseek-v4-flash"
}
```

开启路由按任务复杂度自动切模型：

```jsonc
"routing": { "enabled": true, "classifier": "...", "l0": "...", "l1": "...", "l2": "..." }
```

| 字段 | 用途 |
|---|---|
| `providers` | 每个 provider 的连接配置（adapter、api_key、base_url） |
| `default_model` | 未开启路由时使用的默认模型 |
| `routing` | L0/L1/L2 按任务复杂度自动选择模型 |
| `session` | AI 标题生成、长会话自动压缩 |

[→ 完整配置指南](/zh/README)

## 功能

### Agent 运行时

| 能力 | 说明 |
|---|---|
| **意图路由** | L0/L1/L2 三级分类（约 100ms），按任务复杂度自动选模型 |
| **Plan Mode** | 结构化执行计划、11 状态机、嵌套规划、checkpoint/resume |
| **Critique 回路** | 独立 Challenger 每步打分，置信度 < 0.7 自动触发重规划 |
| **无限上下文** | 渐进压缩 + 微压缩 + 响应式压缩 + 召回；首条消息永远保留 |
| **Subagent 系统** | 编排器/工作器架构、依赖 DAG、3 种隔离模式（none / try / remote） |
| **Tool 中间件** | 多层 before/after/onError 管道，层间错误隔离 |

### 数据 & 持久化

| 能力 | 说明 |
|---|---|
| **Session 存储** | JSONL 持久化、AI 标题生成、成本追踪、分支（/try、/merge） |
| **Memory 系统** | 线程安全写入、崩溃安全、分层存储（语义 / 情景 / 工作） |
| **权限规则** | 持久化允许/拒绝（按工具/路径）、bash 风险确认门控 |
| **项目上下文** | `.vera/rules.md`、`CLAUDE.md`、路径作用域规则激活 |

### 工具 & 平台

| 能力 | 说明 |
|---|---|
| **7 个内置工具** | `read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| **自定义 Skill** | Markdown 定义 skill、意图驱动激活、热重载 |
| **Gateway UI** | 管理控制台：Run 工作区、能力管理、Doctor、项目管理 |
| **多端 Channel** | CLI REPL、HTTP API、Discord 机器人、飞书机器人 — 统一 ChannelAdapter 接口 |
| **Sandbox** | 代码执行隔离、路径边界管控、安全插件架构 |

## 架构

```
人类想法
  → 意图分类 & 模型路由 (L0 / L1 / L2)
  → 结构化 Flow → ExecutionPlan
  → 通过工具运行时逐步执行
  → 独立批判 (Challenger)
  → 失败归因 & 重规划
  → 经验持久化 → 记忆
  → 基准验证的 Proposal → Rollout
  → 下一轮循环，在边界内
```

**职责分离：**

```
packages/
├── core/        无状态 agent loop — adapters、tools、session、context
├── harness/     有状态编排 — flow 状态机、critique、skill
├── gateway/     能力注册、项目注册、健康检查
├── logger/      结构化日志（含脱敏）
└── shared/      共享类型与工具

apps/
├── gateway-ui/web/    Vue 3 管理控制台
└── gateway-ui/server/ API 服务端
```

> **关键约束：** Role Agent 不拥有"算不算完成"的决定权。该权利专属 Challenger。详见 [Harness 设计 →](/zh/harness/design)

## 路线图

| 阶段 | 目标 | 关键交付 | 状态 |
|---|---|---|---|
| **P0** | Harness 驱动的执行运行时 | 意图路由、7 工具、无限上下文、Plan Mode、Critique、Session、Subagent | ✅ 完成 |
| **P1** | 自循环 & 自修正 | Checkpoint/Resume、Memory 持久化、Subagent 编排器/池、Tool 中间件 | ✅ 完成 |
| **P2** | 自进化 | Dreaming → Proposal → 人工审核 → 基准门控 Rollout → 回归闭环 | 📋 规划中 |
| **P3** | 通用 agent 平台 | Computer Use、MCP、多 agent 网络、自适应策略 | 📋 规划中 |

[→ 完整路线图](/zh/roadmap)

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript（strict、ESM） |
| 包管理 | pnpm workspace monorepo |
| LLM 适配器 | Anthropic、OpenAI、Gemini、DeepSeek、Groq、Azure |
| 终端 UI | React + Ink |
| Web UI | Vue 3 + Vite |
| 测试 | Vitest（覆盖率 ≥ 90%） |
| 静态分析 | oxlint + eslint-plugin-sonarjs + jscpd |
