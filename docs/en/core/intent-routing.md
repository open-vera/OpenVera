# Intent Recognition and Model Routing (Intent Routing)

## Goal

Use a single lightweight model call to assess task complexity and automatically select the appropriate model, achieving an optimal balance between effectiveness and cost.

```
User input -> [Intent classifier, ~100ms, haiku/mini] -> Routing decision -> [Corresponding model handles task]
```

---

## Complexity Levels

| Level | Description | Example | Recommended Model |
|---|---|---|---|
| **L0** Chat/Simple Q&A | Single turn, no tools needed, common knowledge | "hi", "what day is it", "thanks" | haiku / gpt-4o-mini |
| **L1** Single-step task | Needs 1 tool call or simple reasoning | "check Paris weather", "translate this sentence" | haiku / gpt-4o-mini |
| **L2** Multi-step task | Needs multiple tool calls or medium reasoning | "write a sort function with tests" | sonnet / gpt-4o |
| **L3** Complex task | Needs planning, long context, deep reasoning | "fix this bug", "refactor this module" | opus / o3 |

---

## Intent Recognition Implementation

### Approach: Single Lightweight Model Classification

Use haiku or gpt-4o-mini (~$0.0001 per call) for classification, with ~300-500ms latency:

```ts
async function classifyIntent(input: string): Promise<IntentResult> {
  const response = await lightweightAdapter.complete({
    model: "claude-haiku-4-5",
    max_tokens: 64,
    system: CLASSIFIER_PROMPT,
    messages: [{ role: "user", content: input }],
  });
  return JSON.parse(extractText(response.message));
}
```

**Classifier Prompt**:

```
You are a task complexity classifier. Analyze the user input and return JSON (no extra content):

{
  "level": 0|1|2|3,
  "needs_tools": true|false,
  "needs_planning": true|false,
  "domain": "chat|code|search|writing|analysis|other",
  "reason": "one sentence explaining the classification basis"
}

Classification criteria:
- L0: Chitchat, greetings, simple factual Q&A, no tools needed
- L1: Single clear task, at most 1 tool call
- L2: Multi-step task, requires multiple tools or medium reasoning
- L3: Requires deep planning, complex code operations, long document analysis, cross-system operations
```

### Routing Decision

```ts
interface IntentResult {
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
  needs_planning: boolean;
  domain: string;
  reason: string;
}

function routeModel(intent: IntentResult, config: VeraConfig): string {
  const routing = config.routing ?? defaultRouting;
  return routing[`l${intent.level}`] ?? defaultModels[intent.level];
}

const defaultRouting = {
  l0: "claude-haiku-4-5",
  l1: "claude-haiku-4-5",
  l2: "claude-sonnet-4-6",
  l3: "claude-opus-4-6",
};
```

### Configuration Extension (`.vera/settings.json`)

```json
{
  "routing": {
    "enabled": true,
    "classifier_model": "claude-haiku-4-5",
    "l0": "claude-haiku-4-5",
    "l1": "claude-haiku-4-5",
    "l2": "claude-sonnet-4-6",
    "l3": "claude-opus-4-6"
  }
}
```

When `routing.enabled = false`, the `default_model` is used directly without classification.

---

## Plan Mode Trigger Condition

The intent recognition result also determines whether to enable Plan Mode:

```ts
function shouldPlan(intent: IntentResult): boolean {
  return intent.level >= 3 || intent.needs_planning;
}
```

See [agent-design.md](./agent-design.md#4-plan-mode).

---

## Edge Case Handling

| Scenario | Handling |
|---|---|
| Classifier itself fails/times out | Fallback to `default_model`, do not block the main flow |
| Classified as L0 but user adds complex content | Re-classify in the next round |
| User explicitly specifies model (`--model opus`) | Skip routing, use directly |
| Streaming scenario | Classification and main flow run serially; show loading until classification completes |

---

## Effectiveness Evaluation

How to measure routing accuracy:

1. **Labeled set**: Manually label 200 samples with correct levels, run the classifier, check accuracy
2. **Cost comparison**: Routing enabled vs. all-opus, compare token expenditure
3. **Quality comparison**: L0/L1 tasks answered by haiku vs. opus, measure score difference with llm_judge

Ideal goals: L0/L1 accuracy > 95% (misclassification cost is highest at these levels), overall cost reduction of 60%+.

---

## Examples

```
User: "hi"
  -> Classification: L0, needs_tools=false
  -> Route: haiku
  -> Direct reply, no agent loop needed

User: "Check tomorrow's weather in Beijing"
  -> Classification: L1, needs_tools=true, domain=search
  -> Route: haiku + get_weather tool

User: "Write a complete JWT authentication middleware with tests"
  -> Classification: L2, needs_tools=true, domain=code
  -> Route: sonnet

User: "Analyze this repository's architecture and propose a refactoring plan"
  -> Classification: L3, needs_planning=true, domain=code
  -> Route: opus + Plan Mode enabled
```
