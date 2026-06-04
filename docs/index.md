---
layout: home

hero:
  name: "OpenVera"
  text: "Harness-native Agent Runtime"
  tagline: Self-planning · self-looping · self-critiquing · self-evolving
  actions:
    - theme: brand
      text: Install →
      link: "#install"
    - theme: alt
      text: Documentation
      link: /README
    - theme: alt
      text: GitHub
      link: https://github.com/open-vera/OpenVera
---

## Vision

> **Accelerate human creativity, achieve SOTA AGI.**

Models are capable enough — the bottleneck is the execution framework. Vera builds the **reliable, verifiable, compounding** agent runtime that turns ideas into working reality.

### Core Beliefs

- **Harness is the kernel, not a safety wrapper.** Every action passes through a principled execution framework.
- **Don't design for more output. Design to block unqualified output.**
- **Critique must be structurally independent.** No agent can be implementer, evaluator, and judge of its own work.
- **Every failure produces root-cause attribution, not just a retry.**
- **Improvement is evidence-driven.** Changes ship only through benchmark validation.

## Install {#install}

```bash
npm i @open-vera/openvera@latest -g
ai
```

`ai`, `vera`, and `openvera` are all aliases. First run launches an interactive setup wizard.

```bash
ai init          # re-run setup wizard  
ai init --force  # force re-run
```

## Quick Config

```jsonc
// .vera/settings.json
{
  "providers": {
    "compony": { "adapter": "anthropic", "api_key": "..." }
  },
  "default_model": "deepseek-v4-flash"
}
```

Auto-switch model by task complexity: `routing: { enabled: true, l0: "...", l1: "...", l2: "..." }`. [→ Full docs](/README)

## Features

| Category | Capability | Status |
|---|---|---|
| **Intent Routing** | L0/L1/L2 classification, ~100ms, auto model selection | ✅ |
| **Plan Mode** | ExecutionPlan, 11-state flow machine, nested planning | ✅ |
| **Critique** | Independent Challenger, confidence-gated replan | ✅ |
| **Infinite Context** | Progressive + micro + reactive compression, recall | ✅ |
| **Subagent Swarm** | Orchestrator/worker, DAG scheduling, 3 isolation modes | ✅ |
| **7 Built-in Tools** | read/write/edit/list/glob/grep/bash + middleware | ✅ |
| **Session** | JSONL, cost tracking, branching, AI titles | ✅ |
| **Memory** | Thread-safe, crash-safe, tiered (semantic/episodic/working) | ✅ |
| **Permission** | Allow/deny rules, path enforcement, bash gates | ✅ |
| **Multi-Channel** | CLI, HTTP API, Discord, Feishu | ✅ |
| **Gateway UI** | Run workspace, capabilities, doctor, project registry | ✅ |
| **MCP / RAG / Sandbox** | External tools, knowledge retrieval, code isolation | 📋 |

## Architecture

```
Human Idea
  → Intent routing (L0 / L1 / L2)
  → ExecutionPlan → Flow state machine
  → Step execution → Critique → Replan
  → Memory persistence → Proposal → Rollout
```

[→ Full roadmap](/roadmap) · [→ P0 Plan](/P0-IMPROVEMENT-PLAN) · [→ P1 Plan](/P1-IMPLEMENTATION-PLAN)
