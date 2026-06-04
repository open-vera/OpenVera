---
layout: home

hero:
  name: "OpenVera"
  text: "Harness 原生 Agent Runtime"
  tagline: 自规划 · 自循环 · 自批判 · 自进化
  actions:
    - theme: brand
      text: 快速开始
      link: "#install"
    - theme: alt
      text: GitHub
      link: https://github.com/open-vera/OpenVera
    - theme: alt
      text: 路线图
      link: /zh/roadmap
---

## 为什么选择 Vera？ {#why}

大多数 agent 系统是更聪明的助手：遵循指令、调用工具。Vera 不同 —— 它的内核不是安全壳，而是**驱动一切的引擎**。每次工具调用、每次 flow 转换、每次自我改进，都经过一个有原则的执行框架，让 agent 既强大又可控。

::: tip 愿景
**加速人类创造力，迈向 SOTA AGI。** —— 不要设计一个产出更多输出的系统。设计一个更难让不合格输出通过的系统。
:::

## 安装 {#install}

```bash
npm i @open-vera/openvera@latest -g
```

启动 REPL：

```bash
ai
```

::: tip 提示
`ai`、`vera`、`openvera` 三个命令等价，任选其一即可。
:::

首次运行时，交互式配置向导会引导你选择 LLM provider 并输入 API key。

```bash
ai init          # 运行配置向导
ai init --force  # 已有配置时强制重新初始化
```

### 从源码安装

```bash
git clone https://github.com/open-vera/OpenVera.git
cd OpenVera
pnpm install && pnpm build
cp .vera/settings.example.json .vera/settings.json
# 编辑 .vera/settings.json，填入 API key
pnpm repl
```

## 配置 {#config}

配置文件查找顺序：项目配置 (`./.vera/settings.json`) → 全局配置 (`~/.vera/settings.json`)。

**最简单配置 —— 一个 provider，一个模型：**

```jsonc
{
  "providers": {
    "compony": {
      "adapter": "anthropic",
      "api_key": "...",
      "base_url": "https://gateway-claude-api.example.com"
    }
  },
  "default_model": "deepseek-v4-flash"
}
```

**开启路由 —— 按任务复杂度自动切模型：**

```jsonc
{
  "providers": {
    "compony": {
      "adapter": "anthropic",
      "api_key": "...",
      "base_url": "https://gateway-claude-api.example.com"
    }
  },
  "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "routing": {
    "enabled": true,
    "classifier": "deepseek-v4-flash",
    "l0": "deepseek-v4-flash",
    "l1": "deepseek-v4-flash",
    "l2": "deepseek-v4-pro"
  }
}
```

| 字段 | 说明 |
|---|---|
| `providers` | 连接配置：`adapter`、`api_key`、可选 `base_url` |
| `default_provider` | 默认 provider；仅多 provider 时需要 |
| `default_model` | 未开启 routing 时使用的模型 |
| `routing` | 可选。L0/L1/L2 按任务复杂度自动选模型 |
| `models` | 可选。模型别名，用于跨 provider 复用 |
| `session` | 可选。AI 标题生成、长会话压缩设置 |

支持 adapter：`anthropic`、`openai`（OpenAI 兼容协议，包括 DeepSeek/Groq/Azure）、`gemini`。

## Web UI（Gateway）

Vera 内置管理控制台 —— 启动服务端和前端即可：

```bash
pnpm serve   # 启动 API 服务，端口 :7720
pnpm ui      # 启动开发 UI，端口 :7704，API 代理到服务端
```

Gateway UI 提供：

| 功能 | 说明 |
|---|---|
| **总览仪表盘** | 活跃运行、会话统计、成本追踪 |
| **Run 工作区** | 单个 Run 详情：概览 / 记忆 / Checkpoint / 子 Agent / 时间线 |
| **能力管理** | Skills 目录、MCP 服务器、RAG 管道 —— 支持热重载 |
| **项目管理** | 多项目管理，上下文配置 |
| **Doctor** | 系统健康检查、配置诊断 |
| **Chat 控制台** | 直接对话 + 历史记录 |
| **设置** | Provider/Model 配置、路由、会话偏好 |

完整配置说明见 [docs/README](/zh/README)。

## 功能

::: tip 核心能力（P0 ✅）
- **意图路由** — L0/L1/L2 三级自动模型选择，分类延迟约 100ms
- **7 个内置工具** — read_file、write_file、edit_file、list_dir、glob、grep、bash
- **无限上下文** — 渐进压缩、微压缩、响应式压缩、上下文召回
- **Plan Mode** — 结构化执行计划、Flow 状态机（11 种状态）
- **Critique 回路** — 独立 Challenger 对每步打分，置信度 < 0.7 触发重规划
- **会话持久化** — JSONL 存储、成本追踪、恢复、分支、AI 标题
- **Subagent 系统** — 编排器/工作器、依赖 DAG、并行执行、3 种隔离模式
- **权限系统** — 持久化允许/拒绝规则、bash 风险确认、路径管控
- **项目上下文** — `.vera/rules.md`、`CLAUDE.md`、路径作用域规则
- **CLI 主题** — 语义色彩 token、暗色主题
- **自定义 Agent** — `~/.vera/agents/*.md`、`.vera/agents/*.md`
:::

::: info 自循环 & 自修正（P1 ✅）
- **Checkpoint & Resume** — JSONL checkpoint 存储、自动压缩、去重
- **Memory 持久化** — 线程安全写入、崩溃安全、分层（语义/情景/工作）
- **Subagent 编排器** — 依赖 DAG、并行执行、终止/超时
- **Subagent 池** — 并发限制、提交/完成/失败/取消追踪
- **Tool 中间件** — 多层 before/after/onError 管道
- **Agent Runner 注册表** — 多级降级链、基于能力的路由
:::

::: warning 自进化（P2 — 规划中）
Dreaming → 提炼情景记忆为洞察 → Proposal 生成 → 人工审核 → 基准门控 Rollout → 回归反馈闭环
:::

::: tip 平台化（P3 — 规划中）
Computer Use、MCP 协议、多 agent 网络、自适应策略、通用 agent 平台
:::

## 架构

```
人类想法
  → 意图分类 & 模型路由（L0/L1/L2）
  → 结构化 Flow（ExecutionPlan）
  → 通过工具运行时逐步执行
  → 独立批判（Challenger）
  → 失败归因 & 重规划
  → 经验持久化 → 记忆
  → 基准验证的 Proposal → Rollout
  → 下一轮循环，在边界内
```

**角色分离：**

| 角色 | 职责 | 关键约束 |
|---|---|---|
| **Planner** | 读取上下文，生成 ExecutionPlan | Flow 定义是建议不是命令 |
| **Role Agent** | 按准出标准执行，产出交付物 | 不拥有"算不算完成"的决定权 |
| **Challenger** | 独立评分每一步，积累 lessons | 必须给出分值和 requiredFixes，拥有否决权 |
| **Orchestrator** | 调度 agent、管理 context reset、执行门控 | 决定继续/返工/降级/转人工 |

## Vera 的不同之处

| 典型 Agent 系统 | Vera |
|---|---|
| 模型直接调用工具 | 所有工具调用通过 Harness 分发 |
| 模型决定是否继续 | Harness 拥有 Flow State 转换权 |
| 模型自我评估完成度 | Challenger 独立评分每一步 |
| 安全 = prompt 约束 | 安全 = 架构边界 |
| 失败 = 重试 | 失败 = 归因 + 提案 + 经验证修复 |

**Subagent 隔离模式：**

| 模式 | 机制 | 场景 |
|---|---|---|
| `none` | 共享上下文（默认） | 标准委派 |
| `try` | 隔离 git worktree，可通过 `/merge` 审查 | 实验性代码变更 |
| `remote` | 可插拔外部执行后端 | 分布式/沙箱执行 |

**三层上下文系统：**

| 层 | 机制 | 触发条件 |
|---|---|---|
| 滑动窗口裁剪 | 丢弃较早轮次，保留任务锚点 | 达到 80% token 阈值 |
| 渐进压缩 | LLM 摘要旧轮次，注入系统上下文 | 超过 token 阈值 |
| 微压缩 | 启发式清理过时工具结果（不调用 LLM） | 基于时间间隔 |
| 响应式压缩 | `prompt-too-long` 错误时激进压缩 | API 错误响应 |

> **第一条消息（原始任务定义）始终保留。** Agent 永远不会丢失目标。

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript（strict、ESM） |
| 包管理 | pnpm workspace monorepo |
| LLM 适配器 | Anthropic、OpenAI、Gemini、DeepSeek、Groq、Azure |
| 终端 UI | React + Ink |
| Web UI | Vue 3 + Vite |
| 测试 | Vitest |
| 静态分析 | oxlint + eslint-plugin-sonarjs + jscpd |
