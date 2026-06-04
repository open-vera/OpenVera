# 自进化管道（Self-Evolution Pipeline）

自进化管道是 Vera 的 P2 核心能力，目标不是"多做点测试"，而是让 Vera 具备真正的受控进化机制。整个管道从经验蒸馏开始，经过提案生成、人工审核、基准门控发布，最终形成闭环的自我改进系统。

---

## 1. 整体架构

```
经验数据（Episodic Memory / 失败日志）
        │
        ▼
  DreamingRunner          ← 分析经验，提取 Insight，生成 Proposal
        │
        ▼
  ProposalStore           ← 持久化存储，生命周期管理
        │
        ▼
  人工审核                 ← pending → approved / rejected / deferred
        │
        ▼
  Benchmark-gated Rollout ← 通过 EvalHarness 验证改进是否有效
        │
        ├─ 通过 → applied  → 更新 StrategyStore
        └─ 失败 → rejected → 回写失败原因，触发下一轮 Dreaming
```

完整链路：**Critique / Dreaming → Proposal → Human Review → Benchmark Gate → Strategic Rollout → Feedback Loop**

---

## 2. Dreaming 系统

Dreaming 是自进化管道的入口——在 agent 空闲时运行，分析历史经验（episodic memory、benchmark 失败记录），提取可操作的改进建议。

**代码位置：** `packages/harness/src/dreaming/runner.ts`

### 2.1 DreamingRunner

`DreamingRunner` 是 dreaming 的核心类，接收经验列表，产出洞察（Insight）和提案（Proposal）。

```typescript
const runner = new DreamingRunner({
  maxExperiences: 100,   // 每次分析最多 100 条经验
  minConfidence: 0.5,    // 最低置信度阈值
  maxProposals: 10,      // 最多生成 10 条提案
  proposalTypes: ["prompt", "tool_policy", "workflow", "skill"],
});

const result = await runner.dream(experiences);
// result: { insights, proposals, experiencesAnalyzed, duration }
```

### 2.2 经验模型（Experience）

```typescript
interface Experience {
  id: string;
  type: "success" | "failure" | "partial";  // 执行结果
  taskDescription: string;
  toolCalls: string[];                        // 使用的工具列表
  duration: number;                           // 执行耗时（ms）
  outcome: string;                            // 结果描述
  metadata?: Record<string, unknown>;
}
```

### 2.3 洞察提取（Insight Extraction）

`extractInsights()` 执行四类分析：

| 分析类型 | 方法 | 产生的 Insight 类别 |
|----------|------|-------------------|
| 成功工具组合 | `findToolPatterns(experiences, "success")` | `pattern` |
| 失败工具组合 | `findToolPatterns(experiences, "failure")` | `anti_pattern` |
| 慢任务识别 | `findSlowTasks(experiences)` | `optimization` |
| 能力缺口 | `findGaps(experiences)` | `gap` |

**工具组合分析：** 将每条经验按工具调用排序后拼接为组合键（如 `"bash+read_file+write_file"`），统计同组合在成功/失败经验中的出现次数。至少出现 2 次才会生成洞察。置信度计算公式：`min(0.9, count / 10 + 0.3)`。

**慢任务识别：** 计算所有经验的平均耗时，将超过 2 倍平均耗时的任务标记为"慢任务"。置信度固定为 0.7。

**能力缺口识别：** 筛选所有失败经验，按工具组合分组。至少 2 次重复失败的组合被认为代表能力缺口。置信度计算公式：`min(0.85, count / 5 + 0.4)`。

### 2.4 提案生成（Proposal Generation）

`generateProposals()` 将每个过滤后的 Insight（置信度 >= `minConfidence`）映射为 `ImprovementProposal`：

| Insight 类别 | Proposal 类型 | 优先级 | 建议变更方向 |
|-------------|--------------|--------|-------------|
| `pattern`（成功模式） | `workflow` | medium | 创建组合这些工具的 skill 或 workflow 模板 |
| `anti_pattern`（反模式） | `tool_policy` | high | 遇到此工具组合时添加警告或替代策略 |
| `optimization`（优化） | `prompt` | low | 在 prompt 中加入时间感知或实现提前终止 |
| `gap`（缺口） | `skill` | critical | 开发新 skill 或工具来处理这类任务 |

### 2.5 提案数据结构

```typescript
interface ImprovementProposal {
  id: string;
  type: "prompt" | "tool_policy" | "workflow" | "skill";
  priority: "low" | "medium" | "high" | "critical";
  status: "pending" | "approved" | "rejected" | "deferred" | "applied";
  title: string;
  description: string;
  rationale: string;            // 为什么要这样改
  insights: string[];           // 关联的 insight ID
  suggestedChange: string;      // 具体变更建议
  expectedImpact: string;       // 预期效果
  createdAt: string;
}
```

---

## 3. Proposal Store

提案存储为有状态的生命周期管理提供持久化支持。

**代码位置：** `packages/harness/src/proposal/store.ts`

### 3.1 核心功能

| 方法 | 功能 |
|------|------|
| `add(proposal)` | 添加提案（按 ID 去重） |
| `addAll(proposals)` | 批量添加 |
| `updateStatus(id, status)` | 更新提案状态 |
| `list(filter?)` | 按状态/类型/优先级/时间过滤列表 |
| `getReadyForRollout()` | 获取所有已批准待上线的提案 |
| `getApplied()` | 获取所有已应用的提案（用于验证/回滚） |
| `countByStatus()` | 按状态统计数量 |
| `remove(id)` | 删除指定提案 |

### 3.2 生命周期

```
pending → approved → applied → verified（未来）
   ↓         ↓
rejected  deferred
```

- **pending**：DreamingRunner 产出或人工创建的初始状态
- **approved**：人工审核通过，等待 rollout
- **rejected**：人工驳回（含驳回原因）
- **deferred**：暂时搁置，后续再评估
- **applied**：已部署到生产环境

### 3.3 持久化

数据以 JSON 数组格式存储在指定路径，每次变更自动保存。支持幂等添加（相同 ID 不重复插入）。

---

## 4. Strategy Store

策略库（Strategy Store）是机构知识的积累层。每一个已验证生效的改进会固化为一条 Strategy，按任务域组织，并持续跟踪执行效果。

**代码位置：** `packages/harness/src/strategy/strategy-store.ts` 和 `types.ts`

### 4.1 Strategy 数据结构

```typescript
interface Strategy {
  id: string;
  name: string;
  domain: StrategyDomain;       // 适用任务域
  status: "active" | "deprecated" | "candidate" | "retired";
  version: number;              // 版本号，每次更新递增
  prompt: PromptTemplate;       // 提示词模板（含变量替换）
  model: ModelConfig;           // 模型配置
  toolPolicy: ToolPolicy;       // 工具策略（allow/deny/constraints）
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}
```

### 4.2 任务域（StrategyDomain）

```
coding | debugging | research | writing | data-analysis | planning | review | testing | devops | general
```

### 4.3 执行结果跟踪

每次策略被使用时，记录 `StrategyOutcome`：

```typescript
interface StrategyOutcome {
  strategyId: string;
  success: boolean;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
  error?: string;
  timestamp: string;
}
```

### 4.4 自动调优（autoTune）

`autoTune(promoteThreshold, deprecateThreshold, minRuns)` 根据历史成功率自动调整策略状态：

- **候选 → 激活**：成功率 >= `promoteThreshold`（默认 0.7）且运行次数 >= `minRuns`（默认 5）
- **激活 → 弃用**：成功率 < `deprecateThreshold`（默认 0.3）且运行次数 >= `minRuns`
- **弃用/退役**：不自动变更（仅手动操作）

### 4.5 统计与对比

| 方法 | 功能 |
|------|------|
| `getStats(strategyId)` | 获取策略聚合统计（成功率、平均耗时、Token 用量） |
| `compare(idA, idB)` | 对比两个策略，返回胜者与置信度 |
| `getBestForDomain(domain, minRuns)` | 获取某域最佳策略（按成功率排序） |
| `getDomainSummary(domain)` | 域级别汇总：策略数、总运行次数、整体成功率 |

### 4.6 趋势检测

`getTrend(strategyId, recentWindow, olderWindow)` 对比两个时间窗口的成功率变化：

| 趋势方向 | 判断条件 |
|----------|----------|
| `improving` | 近期成功率 - 历史成功率 > 5% |
| `declining` | 近期成功率 - 历史成功率 < -5% |
| `stable` | 差值在 ±5% 以内 |
| `insufficient_data` | 两个窗口的运行次数都低于 `minRunsForTrend`（默认 3） |

### 4.7 时间窗口统计

支持预定义窗口（`1h` / `6h` / `24h` / `7d` / `30d`）和自定义毫秒窗口，按时间过滤 outcomes 后重新计算统计。

---

## 5. Change Store

变更追踪系统以 JSONL 格式按天存储 agent 的工具调用记录，支持查询、过滤和归档。

**代码位置：** `packages/harness/src/tracking/change-store.ts`

### 5.1 数据结构

```typescript
interface ChangeRecord {
  timestamp: string;
  agentId: string;
  toolName: string;
  args: string;
  success: boolean;
  filesChanged: string[];
  summary: string;
  resultPreview?: string;
  error?: string;
}
```

### 5.2 存储格式

每日一个 JSONL 文件：`~/.vera/changes/YYYY-MM-DD.jsonl`，每行一条完整的 ChangeRecord JSON。

### 5.3 查询能力

`query(options)` 支持按时间范围、agent ID、工具名称、文件路径过滤，返回结果数可限制（默认 100）。

### 5.4 归档

`archive()` 将超过 `retentionDays`（默认 30 天）的日志文件移动到 `archive/` 子目录，并从主目录中移除原文件。

---

## 6. Eval Harness 集成

评测框架（Eval Harness）是推进化的"守门人"——任何 Proposal 在真正上线前必须通过基准测试验证。

**代码位置：** `packages/harness/src/eval/harness.ts`

### 6.1 核心组件

```typescript
class EvalHarness {
  constructor(agent: AgentExecutor, options: EvalRunnerOptions);
  loadCases(cases: EvalCase[]): void;
  runAll(): Promise<EvalReport>;
  runCase(evalCase: EvalCase): Promise<EvalResult>;
}
```

### 6.2 评测类型

| evalType | 判定逻辑 | 适用场景 |
|----------|----------|----------|
| `exact` | 响应与期望完全一致（不区分大小写） | 有精确答案的问答 |
| `contains` | 期望文本出现在响应中 | 关键信息提取 |
| `regex` | 响应匹配正则表达式 | 格式验证 |
| `tool_match` | 实际调用的工具与期望工具集匹配 | 工具选择正确性 |
| `llm_judge` | 预留接口（当前返回 0.5） | 主观质量评估 |

### 6.3 评测用例

```typescript
interface EvalCase {
  id: string;
  description: string;
  level: 1 | 2 | 3;           // 难度等级
  prompt: string;              // 发送给 agent 的提示词
  expected?: string;           // 期望答案
  evalType: EvalType;
  expectedTools?: string[];    // tool_match 类型的期望工具
  tags?: string[];             // 分类标签
  timeoutMs?: number;          // 超时（默认 60000ms）
  maxCostUsd?: number;         // 费用上限（默认 $1.0）
}
```

### 6.4 评测报告

```typescript
interface EvalReport {
  benchmark: string;
  model: string;
  passRate: number;            // 通过率
  avgScore: number;            // 平均分
  avgDurationMs: number;       // 平均耗时
  totalCostUsd: number;        // 总费用
  byLevel: Record<number, { total, passed, passRate }>;
  results: EvalResult[];       // 逐条结果
}
```

### 6.5 在自进化中的作用

1. Proposal 生成后 → 人工审核通过
2. → 在 EvalHarness 中跑完整 benchmark
3. → 对比 baseline（当前策略）的分数
4. → 有正向提升 → 标记 applied，更新 StrategyStore
5. → 无提升或降低 → 标记 rejected，回写失败原因

---

## 7. 配置

### 7.1 DreamingRunner

```typescript
interface DreamingConfig {
  maxExperiences?: number;    // 默认 100
  minConfidence?: number;     // 默认 0.5
  maxProposals?: number;      // 默认 10
  proposalTypes?: ProposalType[];  // 默认全部
}
```

### 7.2 ChangeStore

```typescript
interface ChangeStoreOptions {
  storeDir?: string;          // 默认 ~/.vera/changes
  retentionDays?: number;     // 默认 30
}
```

### 7.3 EvalHarness

```typescript
interface EvalRunnerOptions {
  name: string;               // Benchmark 名称
  casesPath?: string;         // 测试用例 JSON 文件路径
  concurrency?: number;       // 并发数（默认 1）
  timeoutMs?: number;         // 全局超时（默认 60000）
  model?: string;             // 模型/agent 名称
}
```

---

## 8. 当前状态

自进化管道属于 **P2 阶段**（roadmap 中的"建立自我进化闭环"）：

| 组件 | 状态 | 说明 |
|------|------|------|
| `DreamingRunner` | 已实现 | 规则驱动的经验分析，四类 Insight 提取，Proposal 映射 |
| `ProposalStore` | 已实现 | 持久化存储、生命周期管理、过滤查询 |
| `StrategyStore` | 已实现 | 策略 CRUD、成功率跟踪、自动调优、趋势检测、域汇总 |
| `ChangeStore` | 已实现 | JSONL 按天存储、时间/agent/工具/文件过滤、归档 |
| `EvalHarness` | 已实现 | 5 种评测类型、报告生成、AgentExecutor 接口解耦 |
| LLM-driven Dreaming | 待实现 | 当前 Dreaming 是规则驱动的，未来应由 LLM 进行更深度的经验分析 |
| 完整闭环自动化 | 待实现 | Proposal → 审核 → Benchmark → Rollout 链路目前需要人工触发，尚未全自动串联 |
| 线上反馈闭环 | 待实现 | 真实任务失败自动入 benchmark 池，人工确认后固化 |

---

## 9. 关键设计决策

1. **Dreaming 放在 Harness 层**：因为 Dreaming 依赖 episodic memory 和 benchmark 结果，这些都是 Harness 层面的概念。Core 层不感知经验的"成败"。
2. **Strategy 与 Proposal 分离**：Proposal 是"建议改什么"，Strategy 是"验证后沉淀的最佳实践"。两者是不同的生命周期阶段。
3. **EvalHarness 通过 AgentExecutor 接口解耦**：不直接依赖 Core 的 agent loop，可对接任意 agent 实现。
4. **变更追踪用 JSONL**：追加写入、崩溃安全、按天分片便于归档和并行查询。
5. **自动调优有最小样本保护**：`minRuns` 参数（默认 5）防止小样本情况下的误判。
