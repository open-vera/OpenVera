# 意图识别与模型路由（Intent Routing）

## 目标

用一次轻量模型调用，判断任务复杂度，自动选择合适的模型处理，在效果和成本之间取得最优平衡。

```
用户输入 → [意图识别，~100ms，haiku/mini] → 路由决策 → [对应模型处理任务]
```

---

## 复杂度分级

| 级别 | 描述 | 示例 | 推荐模型 |
|---|---|---|---|
| **L0** 闲聊/简单问答 | 单轮，无需工具，知识触手可及 | "hi"、"今天几号"、"谢谢" | haiku / gpt-4o-mini |
| **L1** 单步任务 | 需要 1 次工具调用或简单推理 | "查一下巴黎天气"、"翻译这句话" | haiku / gpt-4o-mini |
| **L2** 多步任务 | 需要多轮工具调用或中等推理 | "帮我写个排序函数并加测试" | sonnet / gpt-4o |
| **L3** 复杂任务 | 需要规划、长上下文、深度推理 | "修复这个 bug"、"重构这个模块" | opus / o3 |

---

## 意图识别实现

### 方案：单次轻量模型分类

用 haiku 或 gpt-4o-mini（每次 ~$0.0001）做分类，延迟约 300-500ms：

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

**Classifier Prompt**：

```
你是一个任务复杂度分类器。分析用户输入，返回 JSON（不要多余内容）：

{
  "level": 0|1|2|3,
  "needs_tools": true|false,
  "needs_planning": true|false,
  "domain": "chat|code|search|writing|analysis|other",
  "reason": "一句话说明判断依据"
}

分级标准：
- L0：闲聊、问候、简单事实问答，不需要工具
- L1：单一明确任务，最多调用 1 个工具
- L2：多步骤任务，需要调用多个工具或有中等推理
- L3：需要深度规划、复杂代码操作、长文档分析、跨多系统操作
```

### 路由决策

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

### 配置扩展（`.vera/settings.json`）

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

`routing.enabled = false` 时直接用 `default_model`，不走分类。

---

## 触发 Plan Mode 的条件

意图识别结果同时决定是否启用 Plan Mode：

```ts
function shouldPlan(intent: IntentResult): boolean {
  return intent.level >= 3 || intent.needs_planning;
}
```

见 [agent-design.md](./agent-design.md#4-plan-模式plan-mode)。

---

## 边界 case 处理

| 场景 | 处理方式 |
|---|---|
| 分类器本身失败/超时 | fallback 到 `default_model`，不阻塞主流程 |
| 分类为 L0 但用户追加了复杂内容 | 下一轮重新分类 |
| 用户显式指定模型（`--model opus`） | 跳过路由，直接使用 |
| 流式场景 | 分类和主流程串行，分类完成前显示 loading |

---

## 效果评估

路由准确率的衡量方式：

1. **标注集**：人工标注 200 条样本的正确级别，跑分类器，看 accuracy
2. **Cost 对比**：开启路由 vs 全用 opus，对比 token 花费
3. **质量对比**：L0/L1 任务用 haiku 回答 vs opus 回答，llm_judge 打分差值

理想目标：L0/L1 准确率 > 95%（这两级误判代价最高），整体 cost 降低 60%+。

---

## 示例

```
用户："hi"
  → 分类：L0, needs_tools=false
  → 路由：haiku
  → 直接回复，无需 agent loop

用户："帮我查一下明天北京天气"
  → 分类：L1, needs_tools=true, domain=search
  → 路由：haiku + get_weather tool

用户："帮我写一个带完整测试的 JWT 鉴权中间件"
  → 分类：L2, needs_tools=true, domain=code
  → 路由：sonnet

用户："分析这个仓库的架构并给出重构方案"
  → 分类：L3, needs_planning=true, domain=code
  → 路由：opus + Plan Mode 开启
```
