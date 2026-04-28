# Vera — 文档目录

> Vera 是以 Harness 为内核、可自规划、自循环、自我批判、自我进化的 agent runtime。

---

## 快速开始

1. 复制配置模板并填入 API Key：

```bash
cp .vera/settings.example.json .vera/settings.json
# 编辑 .vera/settings.json，填入各 provider 的 api_key
```

2. 启动 REPL：

```bash
pnpm repl
```

配置说明：
- `providers`：LLM 提供商配置（anthropic / openai / gemini / deepseek / groq / azure）
- `default_provider`：默认使用的提供商
- `routing`：意图路由配置，按 L0-L3 复杂度自动选择模型
- `.vera/settings.json` 包含密钥，已加入 `.gitignore`，不会提交到仓库

---

## 项目介绍

| 文档 | 说明 |
|---|---|
| [PROJECT_INTRO.md](./PROJECT_INTRO.md) | 项目说明文档（英文）——理念、愿景、架构、价值主张 |
| [PROJECT_INTRO_CN.md](./PROJECT_INTRO_CN.md) | 项目说明文档（中文）——理念、愿景、架构、价值主张 |

---

## 整体规划

| 文档 | 说明 |
|---|---|
| [roadmap.md](./roadmap.md) | 阶段路线图——P0 核心 runtime → P1 自循环 → P2 自进化 → P3 平台扩展 |
| [roadmap.md#已知缺陷与技术债](./roadmap.md#已知缺陷与技术债) | 2026-04-28 架构诊断——5 个 Critical、6 个 High、6 个 Medium 问题 |

---

## 模块文档

### Core — `@vera/core`

基础 runtime 层：LLM 适配、agent loop、意图路由、上下文管理。

| 文档 | 说明 |
|---|---|
| [agent-design.md](./core/agent-design.md) | Agent 能力版图、Hermes 精华、Dreaming、Subagent、Plan Mode 总览 |
| [subagent-design.md](./core/subagent-design.md) | Subagent 系统设计——何时使用、通信协议、上下文共享、调度模式 |
| [intent-routing.md](./core/intent-routing.md) | 意图识别与模型路由——L0/L1/L2/L3 分级 |
| [runtime-design.md](./core/runtime-design.md) | Core runtime 设计——adapter 抽象、loop、streaming |
| [tool-rendering.md](./core/tool-rendering.md) | Tool 输出渲染——RenderHint、ToolResultView、各渲染组件 ✅ |
| [capability-gaps.md](./core/capability-gaps.md) | 当前能力差距与近期实现路线——权限、上下文、UI、可靠性 |
| [p0-alignment-checklist.md](./core/p0-alignment-checklist.md) | P0 后对齐项代码核验清单——已完成/部分完成/未完成 |
| [plan-mode-implementation.md](./core/plan-mode-implementation.md) | **[P0 已完成]** Plan Mode——planner、parser、state machine、REPL 接入 ✅ |
| [infinite-context-implementation.md](./core/infinite-context-implementation.md) | **[P0 已完成]** 无限上下文——progressive compression、micro-compact、reactive compact ✅ |

→ [core/README.md](./core/README.md)

---

### Harness — `@vera/harness`

运行内核：Flow 生命周期、工具权限约束、Critique 回路、审批门。

| 文档 | 说明 |
|---|---|
| [design.md](./harness/design.md) | Harness 整体设计——术语、Flow State 机器、权限边界、Proposal Pipeline |
| [runtime-implementation.md](./harness/runtime-implementation.md) | Harness Runtime 实现细节——各模块职责与当前代码结构 |
| [plan-mode-implementation.md](./core/plan-mode-implementation.md) | Plan Mode 实现——planner、parser、state machine、HarnessRuntime ✅ |
| [tool-rendering.md](./core/tool-rendering.md) | Tool 输出渲染——RenderHint、ToolResultView、各渲染组件 ✅ |

→ [harness/README.md](./harness/README.md)

---

### Eval — `@vera/benchmark` + 评测体系

量化 Vera 的任务完成率、工具准确率和稳定性。

| 文档 | 说明 |
|---|---|
| [benchmark.md](./eval/benchmark.md) | Benchmark 方案——评估维度、GAIA/SWE-bench/ToolBench 开源集、运行时机 |

→ [eval/README.md](./eval/README.md)

---

### Platform — 平台扩展能力

Computer Use、MCP 接入、智能 UI 测试等 P2/P3 能力。

| 文档 | 说明 |
|---|---|
| [computer-use.md](./platform/computer-use.md) | Computer Use——浏览器自动化、桌面操作、Benchmark 接入 |
| [intelligent-testing.md](./platform/intelligent-testing.md) | 智能自动化测试——AI 驱动 UI 测试、多策略定位、自愈测试 |

→ [platform/README.md](./platform/README.md)

---

### Apps — 应用层

| 应用 | 说明 |
|---|---|
| harness-ui | Harness Web UI——可视化 Flow runs、流式日志、Artifact 浏览 |
| audio-label | 音频标注工具 |

→ [apps/README.md](./apps/README.md)

---

### Code Governance — 代码治理

| 文档 | 说明 |
|---|---|
| [static-analysis.md](./code-governance/static-analysis.md) | 静态代码质量扫描——oxlint + jscpd 并行方案、指标阈值、Skill 设计 |

---

## 参考资料

精选外部文章，按来源整理：

| 目录 | 内容 |
|---|---|
| [refrence/anthropic/](./refrence/anthropic/) | Anthropic 官方文章（含 zh 译文）——Agent 设计、工具使用、Harness、Evals 等 |
| [refrence/harness/](./refrence/harness/) | Harness 专项参考——整体方案、扩展实践、多 agent 模式、反模式 |
| [refrence/OpenAI/](./refrence/OpenAI/) | Codex 工程实践 |

---

## 推荐阅读顺序

```
roadmap.md                          了解全局目标和阶段（含 P0 完成状态与已知技术债）
  ↓
harness/design.md                   理解 Harness 内核设计（最重要）
  ↓
core/agent-design.md                理解 Agent 能力版图
  ↓
core/intent-routing.md              意图路由（已完成，可快速过）
  ↓
core/plan-mode-implementation.md        P0 已完成——Plan Mode 基础版
  ↓
core/infinite-context-implementation.md   P0 已完成——无限上下文
  ↓
core/capability-gaps.md             查看 P0 后对齐项（权限/上下文/UI/子 agent）
  ↓
eval/benchmark.md                   了解评测体系（P2 准备）
```
