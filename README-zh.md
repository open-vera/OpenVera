# Vera — 加速人类创造力，迈向 SOTA AGI

[English](./README.md)

[![npm](https://img.shields.io/npm/v/@open-vera/openvera?style=flat&color=6366f1&label=npm)](https://www.npmjs.com/package/@open-vera/openvera)
[![license](https://img.shields.io/npm/l/@open-vera/openvera?style=flat)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](#)
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
vera
```

首次运行时，交互式配置向导会引导你选择 LLM provider 并输入 API key。

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

配置文件路径：`.vera/settings.json`（首次运行时由 setup wizard 自动创建）。

```jsonc
{
  // LLM 提供商 —— 添加你需要的 API key
  "providers": {
    "anthropic": {
      "adapter": "anthropic",       // 或 "openai" / "gemini"
      "api_key": "sk-ant-..."
    },
    "openai": {
      "adapter": "openai",
      "api_key": "sk-..."
    },
    "deepseek": {
      "adapter": "openai",          // OpenAI 兼容协议
      "api_key": "...",
      "base_url": "https://api.deepseek.com/v1"
    }
  },

  // 默认 provider 和 model（routing 关闭时使用）
  "default_provider": "anthropic",
  "default_model": "claude-sonnet-4-6",

  // 意图路由 —— 按任务复杂度自动选择模型
  "routing": {
    "enabled": true,
    "classifier": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "l0": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" },    // 闲聊
    "l1": { "provider": "anthropic", "model": "claude-sonnet-4-6" },            // 单步任务
    "l2": { "provider": "anthropic", "model": "claude-sonnet-4-6" },            // 多步任务
    "l3": { "provider": "anthropic", "model": "claude-opus-4-6" }               // 复杂规划
  },

  // 会话 —— AI 自动生成会话标题
  "session": {
    "ai_title": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `providers` | LLM 提供商配置：anthropic / openai / gemini / deepseek / groq / azure |
| `default_provider` | 未指定时使用的默认 provider |
| `default_model` | 默认模型名称（与 provider 对应） |
| `routing` | 意图路由配置 —— 开关、每级模型覆盖 |
| `session` | 会话元数据设置（AI 标题生成） |

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
| `intent/` | `classifyIntent` / `routeTarget` — L0-L3 分类、领域检测 |
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
| L1 | 单步任务 | claude-haiku / gpt-4o-mini |
| L2 | 多步任务 | claude-sonnet / gpt-4o |
| L3 | 复杂规划、深度推理 | claude-opus / o3 |

L3 任务自动激活 Plan Mode。目标：L0/L1 路由准确率 > 95%，整体成本降低 > 60%。

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
