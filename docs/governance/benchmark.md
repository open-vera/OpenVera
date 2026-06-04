# Benchmark -- Agent Capability Evaluation

## Overview

`@vera/benchmark` is the evaluation infrastructure for measuring Vera agent capabilities. Input is "a batch of test cases + an agent implementation"; output is a structured evaluation report. The goal is not "benchmark scores" but answering: which task categories can this agent complete reliably, which does it fail on, and why.

---

## Architecture

```
@vera/harness           <- Evaluation execution engine (generic, can test any LLMAdapter)
  src/
    types.ts            # TestCase, RunResult, EvalResult
    runner.ts           # Execute agent, record tool calls / tokens / duration
    evaluator.ts        # Score by eval method
    reporter.ts         # Generate JSONL / Markdown reports (pending)
    generator.ts        # Intelligent case generation (pending)

@vera/benchmark         <- Specific case sets + report entry points
  src/
    index.ts            # Assemble adapter + cases, invoke harness, print report
  cases/
    l1_atomic/          # Single-step tasks
    l2_multi_step/      # Multi-step tasks
    l3_planning/        # Planning tasks
```

---

## TestCase Format

```json
{
  "id": "weather_umbrella",
  "input": "What's the weather in Paris and should I bring an umbrella?",
  "expected_tools": ["get_weather"],
  "eval": "llm_judge",
  "criteria": "mentions weather condition and gives umbrella recommendation"
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for report indexing |
| `input` | User message sent to the agent |
| `expected_tools` | Expected tool names to be invoked (for tool_match) |
| `eval` | Evaluation method, see below |
| `criteria` | llm_judge criteria (natural language) |
| `expected_output` | Expected string for exact / contains matching |

---

## Evaluation Methods

| Method | Use Case | Status |
|--------|----------|--------|
| `exact` | Structured output, exact match | Done |
| `contains` | Output contains a keyword/phrase | Done |
| `tool_match` | Verify tool calls match expectations | Done |
| `llm_judge` | Open-ended tasks, semantic scoring | Pending |

### llm_judge Implementation Plan

Use a lightweight model (claude-haiku / gpt-4o-mini) as the judge:

```
system: You are a strict evaluator. Judge whether the agent's response passes based on
        the given criteria. Reply only with JSON: {"passed": true/false, "score": 0.0-1.0, "reason": "..."}

user:   Criteria: {criteria}
        Agent response: {output}
```

`score >= 0.7` is considered passed; the threshold is configurable.

---

## Concurrent Execution

```ts
const results = await runSuite(cases, options, concurrency = 3);
```

Recommendations:
- L1 (atomic): concurrency = 10
- L2/L3: concurrency = 3, to avoid tool side effects interfering with each other

---

## RunResult Format

```json
{
  "case_id": "weather_umbrella",
  "output": "It's sunny in Paris, no umbrella needed.",
  "tool_calls": [
    { "name": "get_weather", "arguments": { "location": "Paris" }, "result": "..." }
  ],
  "turns": 2,
  "usage": { "input_tokens": 312, "output_tokens": 48 },
  "duration_ms": 1840
}
```

Output formats:
- **JSONL**: one line per case, easy for grep / jq analysis
- **Markdown table**: for CI comments
- **HTML** (pending): visual dashboard

---

## Evaluation Dimensions

| Dimension | Measures | How |
|-----------|----------|-----|
| **Task completion rate** | Can the goal be achieved | Pass/Fail, average over N repeated runs |
| **Tool call accuracy** | Are tools selected correctly with correct params | Compare against golden tool call |
| **Step efficiency** | How many turns to complete (fewer is better) | Record turn count |
| **Token efficiency** | How many tokens consumed per task | Stats from usage field |
| **Stability** | Are 5 runs of the same task consistent | Variance / standard deviation |

---

## Open-Source Benchmark Suites

**General Agent Capability**

| Benchmark | Characteristics | Recommended Use |
|-----------|----------------|-----------------|
| **GAIA** (HuggingFace) | Multi-step reasoning + tool use, L1/L2/L3 tiers | First choice, start with L1 |
| **AgentBench** | 8 real environments (OS, DB, Web, games, etc.) | Comprehensive performance |
| **SWE-bench Verified** | Real GitHub issues for agent to fix | Code-specific scenarios |

**Tool Calling**

| Benchmark | Characteristics |
|-----------|----------------|
| **ToolBench / ToolEval** | 16000+ real APIs, tests tool selection and parameter generation |
| **API-Bank** | Tiered difficulty, single call vs. multi-step calls |

**Reasoning and Planning**

| Benchmark | Characteristics |
|-----------|----------------|
| **ALFWorld** | Text game environment, tests planning chains |
| **HotpotQA / MuSiQue** | Multi-hop Q&A, suitable for retrieval-augmented agents |

**Computer Use specialist benchmarks** --> see [computer-use.md](../platform/computer-use.md#benchmarks)

---

## Intelligent Testing

### Auto-Generate Cases

```
prompt: Given the following tool list: {tools}
        Generate 20 test cases covering:
        1. Normal usage
        2. Parameter edge cases (empty, overlong, special chars)
        3. Multi-tool combined calls
        4. Ambiguous intent (user is unclear)
        Return as JSON array in TestCase[] format
```

Generated cases are manually reviewed; passing cases are added to `cases/` as a fixed regression set.

### Mutation Testing

Create semantic variants of existing cases to test agent stability:

| Mutation Type | Example |
|---------------|---------|
| Synonym substitution | "weather" -> "climate" -> "what's it like outside today" |
| Tone variation | Imperative -> interrogative -> colloquial |
| Information addition/removal | Add/remove irrelevant information |
| Multilingual | Chinese -> English -> mixed |

Stability score = variant case pass rate, ideal value > 90%.

### Failure Attribution

Failed cases are auto-analyzed into four categories:

1. **Wrong tool**: Called an unintended tool, or missed a tool
2. **Wrong parameters**: Correct tool but incorrect parameter format/content
3. **Reasoning error**: Tool results correct but final answer wrong
4. **Refusal**: Model refusal or exceeded maxTurns

---

## Recommended Run Timing

- After modifying prompts / loop logic
- When switching models (claude vs gpt vs gemini) for comparison
- In CI as a regression test (L1 only, fast and cheap)
