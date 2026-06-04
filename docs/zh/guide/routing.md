# 意图识别与模型路由 (Intent Routing)

## 目标

使用一次轻量模型调用来评估任务复杂度，自动选择合适的模型，在效果与成本之间达到最优平衡。

```
用户输入 -> [意图分类器, ~100ms, haiku/mini] -> 路由决策 -> [对应模型处理任务]
```

---

## 复杂度层级

| 层级 | 说明 | 示例 | 推荐模型 |
|---|---|---|---|
| **L0** 闲聊/简单问答 | 单轮、无需工具、常识性 | "你好"、"今天星期几"、"谢谢" | haiku / gpt-4o-mini |
| **L1** 单步任务 | 需要 1 次工具调用或简单推理 | "查一下巴黎天气"、"翻译这句话" | haiku / gpt-4o-mini |
| **L2** 多步任务 | 需要多次工具调用或中等推理 | "写一个带测试的排序函数" | sonnet / gpt-4o |
| **L3** 复杂任务 | 需要规划、长上下文、深度推理 | "修复这个 bug"、"重构这个模块" | opus / o3 |

---

## 意图识别实现

### 方案：单次轻量模型分类

使用 haiku 或 gpt-4o-mini（约 $0.0001/次调用）进行分类，延迟约 300-500ms：

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

**分类器 Prompt**：

```
你是一个任务复杂度分类器。分析用户输入，返回 JSON（不要输出其他内容）：

{
  "level": 0|1|2|3,
  "needs_tools": true|false,
  "needs_planning": true|false,
  "domain": "chat|code|search|writing|analysis|other",
  "reason": "一句话说明分类依据"
}

分类标准：
- L0：闲聊、打招呼、简单事实问答、不需要工具
- L1：单一明确任务、最多 1 次工具调用
- L2：多步任务、需要多次工具或中等推理
- L3：需要深度规划、复杂代码操作、长文档分析、跨系统操作
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

### 配置扩展 (`.vera/settings.json`)

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

当 `routing.enabled = false` 时，直接使用 `default_model`，不进行分类。

---

## Plan Mode 触发条件

意图识别结果同时决定是否启用 Plan Mode：

```ts
function shouldPlan(intent: IntentResult): boolean {
  return intent.level >= 3 || intent.needs_planning;
}
```

参见 [agent-design.md](./agent-design.md#4-plan-mode)。

---

## 边界情况处理

| 场景 | 处理方式 |
|---|---|
| 分类器本身失败/超时 | 回退到 `default_model`，不阻塞主流程 |
| 分类为 L0 但用户添加了复杂内容 | 在下一轮重新分类 |
| 用户显式指定模型 (`--model opus`) | 跳过路由，直接使用 |
| 流式场景 | 分类和主流程序列执行；分类完成前显示加载状态 |

---

## 效果评估

如何衡量路由准确性：

1. **标注集**：人工标注 200 条样本的正确层级，运行分类器，检查准确率
2. **成本对比**：路由启用 vs. 全量使用 opus，比较 token 支出
3. **质量对比**：L0/L1 任务分别用 haiku 和 opus 回答，用 llm_judge 衡量得分差异

理想目标：L0/L1 准确率 > 95%（这些层级的误分类代价最大），整体成本降低 60%+。

---

## 示例

```
用户："你好"
  -> 分类：L0, needs_tools=false
  -> 路由：haiku
  -> 直接回复，无需 agent 循环

用户："查一下明天北京的天气"
  -> 分类：L1, needs_tools=true, domain=search
  -> 路由：haiku + get_weather 工具

用户："写一个完整的 JWT 认证中间件，包含测试"
  -> 分类：L2, needs_tools=true, domain=code
  -> 路由：sonnet

用户："分析这个仓库的架构，提出重构方案"
  -> 分类：L3, needs_planning=true, domain=code
  -> 路由：opus + 启用 Plan Mode
```
