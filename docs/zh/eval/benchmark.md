# Benchmark — Agent 能力评测

## 定位

`@vera/benchmark` 是衡量 Vera agent 能力的评测基础设施。输入是"一批测试用例 + 一个 agent 实现"，输出是结构化评测报告。目标不是"跑分"，而是回答：这个 agent 在哪类任务上能稳定完成，在哪类任务上会失败，失败原因是什么。

---

## 架构

```
@vera/harness           ← 评测执行引擎（通用，可测任何 LLMAdapter）
  src/
    types.ts            # TestCase、RunResult、EvalResult
    runner.ts           # 执行 agent，记录 tool call / token / 耗时
    evaluator.ts        # 按 eval method 打分
    reporter.ts         # 生成 JSONL / Markdown 报告（待实现）
    generator.ts        # 智能生成 case（待实现）

@vera/benchmark         ← 具体用例集 + 报告入口
  src/
    index.ts            # 组装 adapter + cases，调 harness，打印报告
  cases/
    l1_atomic/          # 单步任务
    l2_multi_step/      # 多步任务
    l3_planning/        # 规划类任务
```

---

## TestCase 格式

```json
{
  "id": "weather_umbrella",
  "input": "What's the weather in Paris and should I bring an umbrella?",
  "expected_tools": ["get_weather"],
  "eval": "llm_judge",
  "criteria": "mentions weather condition and gives umbrella recommendation"
}
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，用于报告索引 |
| `input` | 发给 agent 的用户消息 |
| `expected_tools` | 期望调用的工具名列表（tool_match 用） |
| `eval` | 评估方式，见下节 |
| `criteria` | llm_judge 的评判标准（自然语言描述） |
| `expected_output` | exact / contains 的期望字符串 |

---

## 评估方式

| 方式 | 适用场景 | 实现状态 |
|---|---|---|
| `exact` | 结构化输出，完全匹配 | ✅ |
| `contains` | 输出中包含关键字/短语 | ✅ |
| `tool_match` | 验证工具调用是否符合预期 | ✅ |
| `llm_judge` | 开放性任务，语义打分 | 🔲 待实现 |

### llm_judge 实现方案

用轻量模型（claude-haiku / gpt-4o-mini）作为裁判：

```
system: 你是一个严格的评测员。根据给定标准，判断 agent 的回答是否通过。
        只回答 JSON：{"passed": true/false, "score": 0.0-1.0, "reason": "..."}

user:   标准：{criteria}
        Agent 回答：{output}
```

`score >= 0.7` 视为 passed，阈值可配置。

---

## 并发执行

```ts
const results = await runSuite(cases, options, concurrency = 3);
```

建议：
- L1（atomic）：concurrency = 10
- L2/L3：concurrency = 3，防止工具副作用相互干扰

---

## RunResult 格式

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

输出格式：
- **JSONL**：每行一条，方便 grep / jq 分析
- **Markdown 表格**：CI 评论用
- **HTML**（待实现）：可视化 dashboard

---

## 评估维度

| 维度 | 衡量什么 | 怎么测 |
|---|---|---|
| **任务完成率** | 给定目标，能否完成 | Pass/Fail，N 次重复取均值 |
| **工具调用准确率** | 工具选对了吗，参数对吗 | 对比 golden tool call |
| **步骤效率** | 用了几步完成（越少越好） | 记录 turn 数 |
| **Token 效率** | 每个任务消耗多少 token | 从 usage 字段统计 |
| **稳定性** | 同一任务跑 5 次结果是否一致 | 方差/标准差 |

---

## 开源评测集

**通用 Agent 能力**

| 评测集 | 特点 | 推荐用途 |
|---|---|---|
| **GAIA**（HuggingFace） | 多步推理 + 工具使用，L1/L2/L3 三档 | 首选，优先跑 L1 |
| **AgentBench** | 8 种真实环境（OS、DB、Web、游戏等） | 综合表现 |
| **SWE-bench Verified** | 真实 GitHub issue 让 agent 修复 | 代码场景专项 |

**工具调用**

| 评测集 | 特点 |
|---|---|
| **ToolBench / ToolEval** | 16000+ 真实 API，测工具选择和参数生成 |
| **API-Bank** | 分层难度，单次调用 vs 多步调用 |

**推理与规划**

| 评测集 | 特点 |
|---|---|
| **ALFWorld** | 文字游戏环境，测规划链 |
| **HotpotQA / MuSiQue** | 多跳问答，适合测带检索的 agent |

**Computer Use 专项** → 详见 [computer-use.md](../platform/computer-use.md#benchmark)

---

## 智能测试

### 自动生成 case

```
prompt: 给定以下工具列表：{tools}
        生成 20 个测试用例，覆盖：
        1. 正常使用
        2. 参数边界（空值、超长、特殊字符）
        3. 多工具组合调用
        4. 模糊意图（用户说的不清楚）
        以 JSON 数组返回，格式为 TestCase[]
```

生成后人工审核，通过的加入 `cases/` 作为固定回归集。

### 变异测试

对已有 case 做语义变体，测试 agent 稳定性：

| 变异类型 | 示例 |
|---|---|
| 同义替换 | "天气" → "气象" → "今天外面怎么样" |
| 语气变化 | 命令句 → 疑问句 → 口语化 |
| 信息增减 | 去掉/加上无关信息 |
| 多语言 | 中文 → 英文 → 中英混合 |

稳定性分数 = 变体 case 通过率，理想值 > 90%。

### 失败归因

case 失败后自动分析，分四类：

1. **工具选错**：调了不该调的工具，或漏调
2. **参数错误**：工具对但参数格式/内容有误
3. **推理错误**：工具结果正确但最终回答有误
4. **拒绝回答**：模型 refusal 或超出 maxTurns

---

## 建议运行时机

- 改 prompt / 改 loop 逻辑后跑一次
- 切换模型（claude vs gpt vs gemini）时对比
- CI 里作为回归测试（只跑 L1，快且便宜）
