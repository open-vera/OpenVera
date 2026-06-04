# Vera — 加速人类创造力，迈向 SOTA AGI

[English](./README.md)

[![npm](https://img.shields.io/npm/v/@open-vera/openvera?style=flat&color=6366f1&label=npm)](https://www.npmjs.com/package/@open-vera/openvera)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](#)
[![Coverage Status](https://coveralls.io/repos/github/open-vera/OpenVera/badge.svg)](https://coveralls.io/github/open-vera/OpenVera)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](./CONTRIBUTING.md)
[![stars](https://img.shields.io/github/stars/open-vera/OpenVera?style=flat&color=facc15)](https://github.com/open-vera/OpenVera)

---

## Vera 是什么？

Vera 是一个 **Harness 原生的 agent runtime** —— 自规划、自循环、自批判、自进化。

大多数 agent 系统是更聪明的助手：遵循指令、调用工具。Vera 不同 —— 它的内核不是安全壳，而是**驱动一切的引擎**。每次工具调用、每次 flow 转换、每次自我改进，都经过一个有原则的执行框架，让 agent 既强大又可控。

我们不只是执行任务。我们规划 Flow，驱动自主循环，批判自己的输出，把积累的教训沉淀为策略 —— 让每次运行都比上一次更好。

```
人类想法
  → 意图识别 & 模型路由
  → 结构化 Flow (ExecutionPlan)
  → 通过工具运行时逐步执行
  → 独立批判 (Challenger)
  → 失败归因 & 重规划
  → 经验持久化 → 记忆
  → 基准验证的 Proposal → Rollout
  → 下一轮循环，在边界内
```

这不是工作流。这是一个**封闭的自驱动循环** —— 每次转换都被治理。

---

## 安装

### 推荐方式

```bash
npm i @open-vera/openvera@latest -g
```

启动 REPL：

```bash
openvera
```

首次运行时，如果 `.vera/settings.json` 缺失或为空，交互式配置向导会引导你选择 LLM provider 并输入 API key。也可以主动运行初始化命令：

```bash
openvera init
openvera init --force   # 已有配置时也重新运行 setup
```

### 从源码安装

```bash
git clone https://github.com/open-vera/OpenVera.git
cd OpenVera
pnpm install
pnpm build
```

```bash
# 复制配置模板
cp .vera/settings.example.json .vera/settings.json

# 添加 API key（文件已 gitignore，不会被提交）
# 编辑 .vera/settings.json

# 启动 REPL
pnpm repl

# 通过 CLI 运行 Flow
pnpm flow

# 启动 Web UI
pnpm serve   # 后端
pnpm ui      # 前端
```

---

## 配置说明

配置文件路径按顺序查找：

1. 当前项目：`./.vera/settings.json`
2. 全局配置：`~/.vera/settings.json`

如果当前项目和全局都存在，使用当前项目配置；如果当前项目不存在但全局存在，使用全局配置；如果两边都不存在，`openvera init` 或首次启动时的 setup wizard 会在全局位置创建配置。显式传入配置路径或设置 `VERA_CONFIG_DIR` 时，以显式配置为准。

Vera 路径分三类：

| 类别 | 路径 | 规则 |
|---|---|---|
| 配置 | `./.vera/settings.json`、`~/.vera/settings.json` | 当前项目优先，全局兜底 |
| 运行时数据 | `~/.vera/projects`、`~/.vera/logs`、`~/.vera/memory`、`~/.vera/changes` | 默认写全局，不写入项目 `.vera/` |
| 上下文资源 | `~/.vera/VERA.md`、`~/.vera/rules`、`~/.vera/skills`、`~/.vera/agents` 与项目 `.vera/*` | 先加载全局，再加载项目；同 ID 项目覆盖全局 |

日志默认写 `~/.vera/logs/vera-YYYY-MM-DD-HH.log`；可用 `VERA_LOG_DIR` 显式指定日志目录。

大多数情况下，只需要配置一个 provider 和一个默认模型：

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

先按下面的顺序理解配置：

| 你想做什么 | 需要配置什么 |
|---|---|
| 只用一个模型 | 配 `providers` + `default_model`；只有多个 provider 时才需要 `default_provider` |
| 按任务复杂度自动换模型 | 用 `routing.classifier/l0/l1/l2`，不用再写 `default_model` |
| 不同级别用不同 provider | `routing` 里写 `{ "provider": "...", "model": "..." }` |
| 想给模型起短名字，或单个模型覆盖协议 | 再加可选的 `models` |

字段含义：

| 字段 | 说明 |
|---|---|
| `providers` | 连接配置。每个 provider 包含 `adapter`、`api_key`、可选 `base_url` |
| `default_provider` | 默认走哪个 provider；只有多个 provider 或字符串模型名无法推断时才需要 |
| `default_model` | 未开启 `routing` 时使用的模型。可以是具体模型名，也可以是 `models` 里的 alias |
| `routing` | 可选。按任务复杂度选择模型；开启后不需要 `default_model`，`l1` 是日常默认模型 |
| `models` | 可选。可以是模型名数组，也可以是 alias 对象；用于列出可选模型、跨 provider 复用或模型级协议覆盖 |
| `session` | 可选。会话元数据设置，例如 AI 标题生成 |

`session.ai_title` 用来自动给会话生成标题。默认会在会话前几轮尝试一次；如果手动使用 `/title <name>` 设置了标题，AI 标题不会覆盖手动标题。可以只写 `"enabled": true` 使用当前对话模型，也可以单独指定生成标题用的 provider/model。

```json
{
  "session": {
    "ai_title": {
      "enabled": true,
      "provider": "compony",
      "model": "deepseek-v4-flash"
    }
  }
}
```

如果不想自动生成标题，设置 `"enabled": false`。

`session.compact` 用来配置长会话自动压缩使用的模型。默认开启，并使用当前对话模型；如果希望用更便宜/更快的模型做 compact，可以单独指定 `provider/model`。如果只指定 `model`，会沿用当前对话的 provider/adapter；如果指定 `provider`，会用该 provider 构建独立 adapter。

```json
{
  "session": {
    "compact": {
      "enabled": true,
      "provider": "compony",
      "model": "deepseek-v4-flash"
    }
  }
}
```

如果不想自动压缩长会话，设置 `"enabled": false`。

支持的 adapter：`anthropic`（Claude 原生）、`openai`（OpenAI 兼容协议，包括 DeepSeek/Groq/Azure）、`gemini`。

使用自定义端点（如公司代理）时，在 provider 配置中添加 `"base_url": "https://your-proxy.com/v1"`。

---

## 核心理念：Harness 即内核

> **不要设计一个产出更多输出的系统。设计一个更难让不合格输出通过的系统。**

| 典型 Agent 系统 | Vera |
|---|---|
| 模型直接调用工具 | 所有工具调用通过 Harness 分发 |
| 模型决定是否继续 | Harness 拥有 Flow State 转换权 |
| 模型自我评估完成度 | Challenger 独立评分每一步 |
| 安全 = prompt 约束 | 安全 = 架构边界 + 合法转换强制执行 |
| 失败 = 重试 | 失败 = 归因 + 提案 + 回归验证修复 |

---

## 架构

```
vera/                          ← pnpm workspace monorepo
├── packages/
│   ├── @open-vera/core        ← 无状态运行时基础
│   ├── @open-vera/openvera    ← 有状态编排内核 (harness)
│   └── apps/
│       ├── admin-ui           ← 管理端 Web UI
│       ├── core-ui            ← 核心 Web UI
│       ├── harness-ui         ← Harness Web UI
│       └── audio-label        ← 音频标注工具
```

**依赖方向严格单向：** `harness → core`。Core 永不依赖 Harness，确保无状态 agent loop 可独立使用。

### `@open-vera/core` — Agent Loop

单次 LLM 调用闭环所需的一切。无状态。无编排逻辑。

| 模块 | 能力 |
|---|---|
| `adapters/` | 统一 `LLMAdapter` 接口 — Anthropic、OpenAI、Gemini、DeepSeek、Groq、Azure |
| `agent/` | `streamAgent` / `runAgent` — 多轮循环、工具分发、重试、压缩 |
| `context/` | Token 估算、窗口裁剪、渐进/微观/响应式压缩、召回 |
| `intent/` | `classifyIntent` / `routeTarget` — L0-L2 模型路由、领域检测 |
| `tools/` | 内置工具：`read_file` `write_file` `edit_file` `list_dir` `glob` `grep` `bash` |
| `session/` | JSONL session 存储、成本追踪、AI 生成标题 |
| `repl/` | React + Ink 终端 UI — 会话面板、SessionPicker、DiffView、主题系统 |
| `memory/` | 跨轮次记忆检测 |
| `sandbox/` | CubeSandbox / Docker 沙箱适配器 |

### `@open-vera/openvera` — 执行内核

多步任务所需的一切。有状态。拥有 flow 编排权。

| 模块 | 能力 |
|---|---|
| `runtime/flow-state.ts` | Flow 状态机 — 11 种状态、合法转换强制执行 |
| `runtime/runtime.ts` | `HarnessRuntime` — 驱动 `Plan → Act → Critique → Replan` 循环 |
| `runtime/critique.ts` | 置信度 < 0.7 自动触发重规划 |
| `skill/` | 从 Markdown 加载 Skill、意图驱动激活 |
| `evaluator.ts` | `exact` / `contains` / `tool_match` / `llm_judge` 评估 |

---

## 意图路由 —— 正确的模型，正确的成本

```
用户输入 → [分类: ~100ms, haiku/mini] → 路由决策 → [目标模型]
```

| 级别 | 描述 | 模型 |
|---|---|---|
| L0 | 闲聊、简单问答 | claude-haiku / gpt-4o-mini |
| L1 | 单步任务 | claude-sonnet / gpt-4o |
| L2 | 多步任务、复杂规划、深度推理 | claude-opus / o3 |

复杂任务仍会自动激活 Plan Mode，但模型路由只需要 `l0/l1/l2`。目标：L0/L1 路由准确率 > 95%，整体成本降低 > 60%。

### 模型配置示例

按复杂度从上到下选一种即可，不需要把所有 case 都写进自己的配置。`default_model` 和 `routing` 二选一：不开 routing 时用 `default_model`；开 routing 时，`routing.l1` 就是日常默认模型。

**Case 1：一个 provider + 一个默认模型**

最简单写法。只有一个 provider 时，不需要写 `default_provider`。

```json
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

**Case 2：一个 provider + 模型列表 + 默认模型**

想在同一个 provider 下提供可选模型，但暂时不开 routing，就加一个数组 `models`。数组项同时作为 alias 和真实上游模型名。

```json
{
  "providers": {
    "compony": {
      "adapter": "anthropic",
      "api_key": "...",
      "base_url": "https://gateway-claude-api.example.com"
    }
  },
  "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "default_model": "deepseek-v4-flash"
}
```

**Case 3：一个 provider + 模型列表 + routing**

同一个 provider 下按任务复杂度自动切模型。开了 routing 后不再写 `default_model`，日常默认模型就是 `routing.l1`。

```json
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

**Case 4：多个 provider + 模型对象 + default_provider + routing**

多个 provider 或模型级覆盖时，用对象写法。每个模型可以指定自己的 `provider`，也可以覆盖 `adapter`、`api_key`、`base_url`；没有写的字段继承 provider。`adapter` 用来覆盖协议，`api_key/base_url` 用来覆盖密钥和 endpoint。`default_provider` 用来给 routing 里的字符串模型名提供默认 provider。

```json
{
  "providers": {
    "gateway": {
      "adapter": "anthropic",
      "api_key": "...",
      "base_url": "https://gateway.example.com"
    },
    "openai": { "adapter": "openai", "api_key": "..." }
  },
  "default_provider": "gateway",
  "models": {
    "deepseek-v4-flash": { "provider": "gateway" },
    "strong": { "provider": "gateway", "model": "deepseek-v4-pro" },
    "openai-strong": { "provider": "openai", "model": "gpt-4.1" },
    "gateway-openai-compatible": {
      "provider": "gateway",
      "model": "custom-model",
      "adapter": "openai"
    },
    "custom-model-alias": {
      "provider": "openai",
      "model": "custom-model",
      "api_key": "...",
      "base_url": "https://openai-compatible.example.com/v1"
    }
  },
  "routing": {
    "enabled": true,
    "classifier": "deepseek-v4-flash",
    "l0": "deepseek-v4-flash",
    "l1": "strong",
    "l2": "openai-strong"
  }
}
```

完整模板见 `.vera/settings.example.json`。

---

## 路线图

| 阶段 | 目标 | 状态 |
|---|---|---|
| **P0** | Harness 驱动的执行运行时 | ✅ 完成 |
| **P1** | 自循环 & 自修正（checkpoint/resume、记忆、critic agent、self-loop） | ✅ 完成 |
| **P2** | 自进化（Dreaming、Proposal Pipeline、benchmark-gated Rollout） | 📋 规划中 |
| **P3** | 通用 agent 平台（Computer Use、MCP、多 agent 网络、自适应策略） | 📋 规划中 |

---

## 文档

| 文档 | 说明 |
|---|---|
| [docs/releases/v0.2.0-zh.md](./docs/releases/v0.2.0-zh.md) | v0.2.0 发布说明 |
| [docs/roadmap.md](./docs/roadmap.md) | 完整路线图、已知缺陷、修复状态 |
| [docs/architecture.md](./docs/architecture.md) | Core vs. Harness 职责边界和依赖图 |
| [docs/harness/design.md](./docs/harness/design.md) | Harness 设计：六大原则、角色分离、Challenger、Flow 结构 |
| [docs/core/agent-design.md](./docs/core/agent-design.md) | Agent 能力图谱：8 层模型、无限上下文、记忆、dreaming |

---

## Star History

<a href="https://www.star-history.com/?repos=open-vera%2FOpenVera&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=open-vera/OpenVera&type=date&legend=bottom-right" />
 </picture>
</a>
