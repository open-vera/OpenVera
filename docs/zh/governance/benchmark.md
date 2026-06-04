# Benchmark -- Agent 能力评测

## 概述

`@vera/benchmark` 是用于衡量 Vera agent 能力的评测基础设施。输入为"一批测试用例 + 一个 agent 实现"，输出为结构化评测报告。目标不是"刷榜单分数"，而是回答：该 agent 能可靠完成哪些任务类别、哪些会失败、以及为什么。

---

## 架构

```
@vera/harness           <- 评测执行引擎（通用，可测试任意 LLMAdapter）
  src/
    types.ts            # TestCase、RunResult、EvalResult
    runner.ts           # 执行 agent，记录 tool calls / tokens / 耗时
    evaluator.ts        # 按评测方法打分
    reporter.ts         # 生成 JSONL / Markdown 报告（待实现）
    generator.ts        # 智能用例生成（待实现）

@vera/benchmark         <- 具体用例集 + 报告入口
  src/
    index.ts            # 组装 adapter + 用例，调用 harness，打印报告
  cases/
    l1_atomic/          # 单步任务
    l2_multi_step/      # 多步任务
    l3_planning/        # 规划任务
```

---

## TestCase 格式

```json
{
  "id": "weather_umbrella",
  "input": "巴黎天气怎么样？需要带伞吗？",
  "expected_tools": ["get_weather"],
  "eval": "llm_judge",
  "criteria": "提到天气状况并给出带伞建议"
}
```

| 字段 | 说明 |
|-------|-------------|
| `id` | 唯一标识符，用于报告索引 |
| `input` | 发送给 agent 的用户消息 |
| `expected_tools` | 预期调用的工具名称（用于 tool_match） |
| `eval` | 评测方法，见下文 |
| `criteria` | llm_judge 的评判标准（自然语言） |
| `expected_output` | 用于 exact / contains 匹配的预期字符串 |

---

## 评测方法

| 方法 | 适用场景 | 状态 |
|--------|----------|--------|
| `exact` | 结构化输出，精确匹配 | 已完成 |
| `contains` | 输出包含特定关键词/短语 | 已完成 |
| `tool_match` | 验证工具调用与预期一致 | 已完成 |
| `llm_judge` | 开放式任务，语义评分 | 待实现 |

### llm_judge 实现方案

使用轻量模型（claude-haiku / gpt-4o-mini）作为裁判：

```
system: 你是一名严格的评审员。根据给定标准判断 agent 的回复是否通过。
        只回复 JSON：{"passed": true/false, "score": 0.0-1.0, "reason": "..."}

user:   标准：{criteria}
        Agent 回复：{output}
```

`score >= 0.7` 视为通过，阈值可配置。

---

## 并发执行

```ts
const results = await runSuite(cases, options, concurrency = 3);
```

建议：
- L1（原子任务）：concurrency = 10
- L2/L3：concurrency = 3，避免工具副作用相互干扰

---

## RunResult 格式

```json
{
  "case_id": "weather_umbrella",
  "output": "巴黎晴天，不需要带伞。",
  "tool_calls": [
    { "name": "get_weather", "arguments": { "location": "Paris" }, "result": "..." }
  ],
  "turns": 2,
  "usage": { "input_tokens": 312, "output_tokens": 48 },
  "duration_ms": 1840
}
```

输出格式：
- **JSONL**：每行一个用例，方便 grep / jq 分析
- **Markdown 表格**：用于 CI comment
- **HTML**（待实现）：可视化仪表盘

---

## 评测维度

| 维度 | 衡量指标 | 方式 |
|-----------|----------|-----|
| **任务完成率** | 目标是否达成 | Pass/Fail，多次重复取均值 |
| **工具调用准确率** | 工具选择和参数是否正确 | 与 golden tool call 对比 |
| **步骤效率** | 完成需要的轮次（越少越好） | 记录轮次数 |
| **Token 效率** | 单任务消耗的 token 数 | 从 usage 字段统计 |
| **稳定性** | 同一任务 5 次运行是否一致 | 方差 / 标准差 |

---

## 开源基准套件

**通用 Agent 能力**

| 基准 | 特点 | 推荐用途 |
|-----------|----------------|-----------------|
| **GAIA**（HuggingFace） | 多步推理 + 工具使用，L1/L2/L3 分层 | 首选，从 L1 开始 |
| **AgentBench** | 8 种真实环境（OS、DB、Web、游戏等） | 综合能力评估 |
| **SWE-bench Verified** | 真实 GitHub Issue 供 agent 修复 | 代码专项场景 |

**工具调用**

| 基准 | 特点 |
|-----------|----------------|
| **ToolBench / ToolEval** | 16000+ 真实 API，测试工具选择和参数生成 |
| **API-Bank** | 难度分层，单次调用 vs 多步调用 |

**推理与规划**

| 基准 | 特点 |
|-----------|----------------|
| **ALFWorld** | 文字游戏环境，测试规划链 |
| **HotpotQA / MuSiQue** | 多跳问答，适合检索增强型 agent |

**Computer Use 专项基准** --> 参见 [computer-use.md](../platform/computer-use.md#benchmarks)

---

## 智能测试

### 自动生成用例

```
prompt: 给定以下工具列表：{tools}
        生成 20 个测试用例，覆盖：
        1. 正常使用
        2. 参数边界情况（空值、超长、特殊字符）
        3. 多工具组合调用
        4. 意图模糊（用户表述不清）
        以 JSON 数组格式返回，遵循 TestCase[] 格式
```

生成的用例需人工审核，通过的用例加入 `cases/` 作为固定回归集。

### 变异测试

对已有用例创建语义变体，测试 agent 稳定性：

| 变异类型 | 示例 |
|---------------|---------|
| 同义词替换 | "天气" -> "气候" -> "外面怎么样" |
| 语气变化 | 祈使句 -> 疑问句 -> 口语化 |
| 信息增减 | 添加/删除无关信息 |
| 多语言 | 中文 -> 英文 -> 中英混合 |

稳定性得分 = 变体用例通过率，理想值 > 90%。

### 失败归因

失败用例自动归入四类：

1. **工具错误**：调用了非预期的工具，或遗漏了工具
2. **参数错误**：工具正确但参数格式/内容有误
3. **推理错误**：工具结果正确但最终答案错误
4. **拒绝回答**：模型拒绝或超过 maxTurns

---

## 推荐运行时机

- 修改 prompt / 循环逻辑后
- 切换模型时（claude vs gpt vs gemini）进行对比
- CI 中作为回归测试（仅 L1，快速且成本低）
