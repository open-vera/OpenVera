# Skill 进化系统

Skill 进化系统是 Vera 让 skill 随时间自我优化的机制。通过执行后反思、版本管理和训练框架集成，skill 可以从实际使用中学习和改进。

---

## 1. 整体架构

```
Skill 执行
    │
    ▼
SkillReflector（反思）          ← LLM 分析执行质量，识别问题
    │
    ▼
VersionManager（版本管理）      ← 根据 bumpType 决定版本号
    │
    └─ major（破坏性变更）→ 1.0.0 → 2.0.0
    └─ minor（功能增强）    → 1.0.0 → 1.1.0
    └─ patch（修复）        → 1.0.0 → 1.0.1

SkillAutoCreator（自动创建）    ← 从执行历史中提取可复用模板
    │
    ▼
SkillFilter（过滤器）          ← 控制哪些 skill 允许进化
    │
    ▼
SkillOptAdapter（训练）        ← 连接 Python 训练框架做深度优化
```

---

## 2. SkillReflector

SkillReflector 是 skill 进化的核心组件——在 skill 执行后调用 LLM 分析执行质量并产出结构化反思。

**代码位置：** `packages/core/src/skill-evolution/skill-reflector.ts`

### 2.1 工作机制

`SkillReflector.reflect(skillName, skillContent, executionMessages)` 执行以下流程：

1. **读取 skill 内容**：获取 SKILL.md 的完整文本
2. **构建执行转录**：将消息历史中的 user/assistant 消息压缩为概要（每条最多 300 字符）
3. **调用 LLM 评估**：发送系统提示词 + skill 内容 + 转录摘要（各截断至 3000 字符）
4. **解析结构化反馈**：从 LLM 响应中提取 JSON，验证并返回 `SkillReflection`

### 2.2 评估维度

LLM 从四个维度评估 skill 质量：

| 维度 | 评估内容 | 典型问题示例 |
|------|----------|-------------|
| **Clarity**（清晰度） | 指令是否无歧义？agent 能否不出猜地执行？ | "步骤 3 没有说明用哪个文件路径" |
| **Coverage**（覆盖面） | 边界情况是否处理？是否缺少错误场景？ | "未处理 API 返回 429 的情况" |
| **Correctness**（正确性） | 步骤是否产生预期结果？ | "步骤 2 的输出格式与下游不兼容" |
| **Efficiency**（效率） | 是否有冗余步骤或重复检查？ | "步骤 4 和步骤 6 做了相同的事情" |

### 2.3 输出结构

```typescript
interface SkillReflection {
  skillName: string;
  qualityScore: number;            // 0-1，整体质量分
  issues: ReflectionIssue[];       // 发现的问题
  needsUpdate: boolean;            // 是否需要更新
  bumpType?: "major" | "minor" | "patch";  // 建议的版本升级类型
}

interface ReflectionIssue {
  severity: "high" | "medium" | "low";
  category: "clarity" | "coverage" | "correctness" | "efficiency";
  description: string;
  suggestion: string;
}
```

### 2.4 判断逻辑

- **qualityScore**：从 LLM 响应中解析，限定在 0-1 范围内；解析失败默认为 0.5
- **needsUpdate**：LLM 显式返回 `needsUpdate` 优先；否则由 `qualityScore < minQuality`（默认 0.8）判断
- **bumpType**：LLM 显式返回优先；否则根据 issue 严重级别推断：
  - 有 `high` 级 issue → `major`
  - 有 `medium` 级 issue → `minor`
  - 仅有 `low` 级 issue → `patch`

### 2.5 使用示例

```typescript
const reflector = new SkillReflector({
  adapter: new AnthropicAdapter({ apiKey: "..." }),
  model: "claude-sonnet-4-6",
  minQuality: 0.8,  // 低于此值触发 needsUpdate
});

const reflection = await reflector.reflect(
  "deploy-to-prod",
  skillMdContent,
  executionMessages,
);

if (reflection.needsUpdate) {
  console.log(`Skill ${reflection.skillName} needs update (${reflection.bumpType})`);
  for (const issue of reflection.issues) {
    console.log(`  [${issue.severity}] ${issue.category}: ${issue.description}`);
  }
}
```

### 2.6 触发时机

反思触发方式由上层 Harness 控制（不在 SkillReflector 内部）：

- skill 执行完成后自动触发（可配置阈值）
- skill 连续失败达到阈值后触发
- 手动触发（通过 CLI 或 API）

---

## 3. SkillAutoCreator

SkillAutoCreator 从 agent 执行历史中自动提取可复用的 skill 模板。

**代码位置：** `packages/core/src/skill-evolution/types.ts`

### 3.1 模板结构

```typescript
interface SkillTemplate {
  name: string;               // Skill 名称（kebab-case）
  description: string;        // 一句话描述
  triggers: string[];         // 触发条件
  steps: string[];            // 执行步骤
  allowedTools: string[];     // 需要的工具
  argumentHint?: string;      // 参数提示
  sourceTask: string;         // 来源任务 ID
  confidence: number;         // 模板可复用置信度（0-1）
}
```

### 3.2 提取条件

```typescript
interface AutoCreatorOptions {
  minRounds?: number;       // 最少执行轮次才触发提取（默认 3）
  minConfidence?: number;   // 最低置信度才输出模板（默认 0.6）
  adapter: LLMAdapter;
  model: string;
}
```

- 执行轮次不足 `minRounds` 时，`triggered = false`，不进行提取
- 只有置信度 >= `minConfidence` 的模板才会输出

---

## 4. VersionManager

版本管理器追踪 skill 的语义化版本及变更历史。

**代码位置：** `packages/core/src/skill-evolution/types.ts`

### 4.1 数据结构

```typescript
interface SkillVersion {
  version: string;          // 当前版本（semver）
  history: VersionEntry[];  // 版本历史
}

interface VersionEntry {
  version: string;
  changes: string[];        // 变更描述列表
  timestamp: string;
  source: "reflection" | "manual" | "auto-create";
}
```

### 4.2 版本升级

```typescript
interface VersionUpdateResult {
  updated: boolean;
  previousVersion?: string;
  newVersion?: string;
  changes?: string[];
}
```

版本升级遵循语义化版本规则：
- **major**：破坏性变更（如移除步骤、改变输出格式）
- **minor**：向后兼容的新功能（如新增覆盖场景）
- **patch**：修复性变更（如措辞优化、边界情况处理）

---

## 5. SkillFilter

SkillFilter 控制哪些 skill 允许参与自动进化，防止系统内置 skill 被意外修改。

**代码位置：** `packages/core/src/skill-evolution/types.ts`

```typescript
type SkillOrigin = "system" | "brand" | "user" | "marketplace";

interface SkillMetadata {
  name: string;
  origin: SkillOrigin;      // skill 来源
  evolvable: boolean;       // 是否允许进化
}

interface FilterOptions {
  evolvableOrigins?: SkillOrigin[];  // 默认 ["user", "marketplace"]
}
```

**默认策略：** 只有 `user` 和 `marketplace` 来源的 skill 可进化。`system` 和 `brand` 来源的 skill 受保护，避免框架核心 skill 被自动修改。

---

## 6. SkillOptAdapter

SkillOptAdapter 连接 Python 训练框架 SkillOpt，像训练神经网络一样训练 agent skill（epoch、batch、validation gate）。

**代码位置：** `packages/harness/src/training/skill-opt-adapter.ts`

### 6.1 训练流程

```typescript
const adapter = new SkillOptAdapter({
  skillOptPath: "/path/to/skill-opt",
  optimizerModel: "claude-opus-4-7",  // 优化器模型（负责改进 skill）
  targetModel: "claude-sonnet-4-6",   // 目标模型（被训练）
  numEpochs: 5,       // 训练 epoch 数
  batchSize: 8,       // batch 大小
  workers: 4,         // 并行 worker 数
  learningRate: 0.1,  // 学习率
});

const run = await adapter.train(dataDir, "my-skill-v2");
// run: { runName, status, currentEpoch, totalEpochs, history, bestSkill }
```

### 6.2 训练状态

```typescript
interface TrainingRun {
  runName: string;
  outputDir: string;                         // 输出目录
  status: "pending" | "running" | "completed" | "failed";
  currentEpoch: number;
  totalEpochs: number;
  bestSkill?: string;                        // 训练出的最佳 skill 内容
  history: TrainingEpoch[];                  // 每个 epoch 的指标
  error?: string;
}

interface TrainingEpoch {
  epoch: number;
  loss: number;
  accuracy: number;
  bestSkillUpdated: boolean;                 // 本次 epoch 是否找到更好的 skill
  durationMs: number;
}
```

### 6.3 评估模式

不用训练，仅评估已有 skill：

```typescript
const evalResult = await adapter.evaluate(
  "/path/to/skill.md",     // Skill 文件路径
  "/path/to/data",          // 评估数据目录
  "valid_unseen",           // 评估模式
);
// evalResult: { mode, passRate, accuracy, avgSteps, cases }
```

评估模式：
- `valid_unseen`：未见过的新测试数据
- `valid_seen`：训练中见过的验证数据
- `train`：训练数据
- `all`：全部数据

### 6.4 运行方式

SkillOptAdapter 内部通过 `python3` 子进程调用 SkillOpt 的 `train.py` 和 `eval_only.py` 脚本：
- 训练超时：1 小时（3600000ms）
- 评估超时：10 分钟（600000ms）
- 训练完成后从 `outputDir/best_skill.md` 提取最佳 skill
- 训练历史从 `outputDir/history.json` 解析

### 6.5 配置

```typescript
interface SkillOptConfig {
  skillOptPath: string;        // SkillOpt 安装目录（必填）
  optimizerModel: string;      // 优化器模型（必填）
  targetModel: string;         // 被训练的目标模型（必填）
  numEpochs?: number;          // 默认 5
  batchSize?: number;          // 默认 8
  workers?: number;            // 默认 4
  learningRate?: number;       // 默认 0.1
  apiKey?: string;             // API Key
  apiBaseUrl?: string;         // 自定义 API 端点
}
```

---

## 7. 进化触发策略

Skill 进化可以通过以下方式触发：

| 触发方式 | 说明 |
|----------|------|
| **执行后自动反思** | Skill 每次执行完毕后自动调用 SkillReflector 分析质量 |
| **失败率阈值** | 当某个 skill 的失败率超过阈值时触发深度分析 |
| **定期审查** | 定时任务对活跃 skill 执行批量反思 |
| **手动触发** | 开发者通过 CLI 或 API 手动触发特定 skill 的进化 |

---

## 8. 当前状态

Skill 进化系统属于 **Phase 20D**（OC13-OC16）：

| 组件 | 状态 | 说明 |
|------|------|------|
| SkillAutoCreator（OC13） | 类型已定义 | 接口和类型就绪，LLM 驱动的模板提取逻辑待实现 |
| SkillReflector（OC14） | 已实现 | LLM 驱动的执行后反思，四维度评估，结构化输出 |
| VersionManager（OC15） | 类型已定义 | 语义化版本和变更历史的数据结构就绪 |
| SkillFilter（OC16） | 类型已定义 | 按来源控制进化权限的过滤规则就绪 |
| SkillOptAdapter | 已实现 | Python 训练框架集成，支持训练和评估模式 |

### 8.1 与自进化管道的关系

Skill 进化是自进化管道的一个子集：
- DreamingRunner 可以产出 `type: "skill"` 的 Proposal
- SkillReflector 提供执行质量信号，可作为 Dreaming 的经验输入
- SkillOptAdapter 提供深度优化能力（迭代训练而非一次性 prompt 调整）
- StrategyStore 中每个 task domain 的实际策略可以是特定版本的 skill
