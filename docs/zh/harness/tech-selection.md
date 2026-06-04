# 多智能体协作系统 — 方案选型与技术决策

> 基于 PRD（mvp.prd.md）及 Anthropic Harness / OpenAI Codex 等参考资料，对 MVP 实现的关键技术选型进行调研、对比与决策。

---

## 一、选型总览

| 决策点 | 选择 | 备选 | 决策理由 |
|--------|------|------|----------|
| 运行时 | Node.js 20+ LTS | Python / Bun / Deno | TypeScript 类型安全、生态成熟、CLI 工具链天然兼容 |
| FSM 引擎 | 自定义轻量实现 | XState / Robot / Stately | PRD 的 FSM 语义简单（7 个状态、线性 + 条件分支），XState 过重 |
| YAML 解析 | `yaml` (v2) | js-yaml / fastyaml-rs | `yaml` 原生 TS、类型推断、规范合规、pnpm 已验证 |
| 子进程管理 | `execa` (v9) | 原生 child_process / zx | Promise API、流式 stdout、跨平台、错误处理优秀 |
| 条件表达式 | `expr-eval` | 手写解析器 / jsep / safe-eval | 安全（无 eval）、轻量、支持比较/逻辑运算 |
| Schema 校验 | `zod` | ajv / yup / io-ts | 运行时校验 + 类型推导一体化、TS 生态首选 |
| 日志 | `pino` | winston / bunyan | 性能最优（NDJSON 原生）、低开销、生态成熟 |
| 配置合并 | `deepmerge-ts` | lodash.merge | 零依赖、TS 友好、类型安全 |
| 测试框架 | `vitest` + `@testing-library` | jest / mocha | 与 Vite 生态统一、速度快、原生 TS |
| 构建工具 | `tsup` | tsc / esbuild / rollup | 零配置、esbuild 底层、dts 生成、CLI 友好 |

---

## 二、详细选型分析

### 2.1 运行时：Node.js 20+ LTS

**选择理由：**
- 目标 Agent（Claude Code、Codex、Gemini CLI、OpenCode）均为 Node.js 生态 CLI 工具
- `child_process.spawn` 提供原生 stdin/stdout/stderr 流控制
- npm 生态覆盖所有依赖
- LTS 版本（20.x / 22.x/ 24.x）长期支持

**对比分析：**

| | Node.js | Python | Bun | Deno |
|--|---------|--------|-----|------|
| 子进程控制 | spawn 原生支持 | subprocess 成熟 | 兼容 Node API | 权限模型限制多 |
| Agent 生态 | ✅ 原生兼容 | ❌ 需跨语言适配 | ⚠️ 兼容但不稳定 | ❌ 权限沙盒冲突 |
| 类型安全 | TypeScript | mypy/pyright | TypeScript | TypeScript |
| 部署复杂度 | 零额外依赖 | 需 venv/pip | 需安装 Bun | 需安装 Deno |
| 性能 | 足够（I/O 密集） | 足够 | 更快 | 相当 |

**决策：Node.js 20+ LTS，TypeScript 5.x**

---

### 2.2 FSM 编排引擎：自定义轻量实现

**PRD 需求：**
- 7 个状态（INIT → PROPOSE → CRITIQUE → REFINE → DECIDE → AWAITING_APPROVAL → END）
- 线性流程 + 条件分支 + 循环 + 并行（fan-out/fan-in）
- 配置驱动（YAML FlowConfig）

**候选方案对比：**

| 方案 | 包大小 | 学习成本 | 并行支持 | 配置驱动 | 适用度 |
|------|--------|----------|----------|----------|--------|
| **自定义实现** | 0 | 低 | 自行实现 | 天然支持 | ⭐⭐⭐⭐⭐ |
| XState v5 | ~15KB gzipped | 高 | 不原生支持 | 需转换层 | ⭐⭐ |
| `@xstate/fsm` | ~1KB gzipped | 中 | 不支持 | 不支持 | ⭐ |
| Robot | ~1KB | 低 | 不支持 | 不支持 | ⭐ |
| Stately (SaaS) | 云端依赖 | 中 | 支持 | 需 API | ⭐⭐ |

**决策：自定义轻量实现。**

理由：
1. PRD 的 FSM 语义是**配置驱动的调度器**，而非传统 UI 状态机
2. 核心逻辑 = 遍历 steps 数组 → 执行当前 step → 评估 condition → 转移状态
3. XState 的 statechart 概念（hierarchical states, history states, delayed transitions）对本场景是过度设计
4. 自定义实现可天然支持 YAML 配置、并行 fan-out、condition 表达式求值
5. 代码量预计 < 500 行，可维护性高

**实现要点：**
```typescript
class FSMOrchestrator {
  private currentStep: number;
  private state: FSMStateName;
  
  async step(): Promise<TransitionResult> {
    const stepDef = this.config.steps[this.currentStep];
    // 1. 评估 condition
    // 2. 执行 step（单步 or 并行 fan-out）
    // 3. 评估 break_condition
    // 4. 转移到下一状态
  }
}
```

---

### 2.3 YAML 解析：`yaml` (v2)

**候选方案对比：**

| 方案 | 下载量/周 | TS 支持 | 规范合规 | 类型推断 | 维护状态 |
|------|-----------|---------|----------|----------|----------|
| **`yaml` v2** | ~30M | ✅ 原生 | YAML 1.2 | ✅ 强类型 | 活跃（v3 RC 中） |
| js-yaml | ~40M | ❌ 需 @types | YAML 1.1 | ❌ 无 | 维护缓慢 |
| fastyaml-rs | 新兴 | ✅ 原生 | YAML 1.2.2 | ✅ | 早期 |

**决策：`yaml` v2。**

理由：
- pnpm 已从 js-yaml 迁移到 `yaml`，社区趋势明确
- 原生 TypeScript，类型推断优秀（`YAML.parse<FlowConfig>(str)`）
- YAML 1.2 规范，避免 js-yaml 的 1.1 兼容性问题
- 支持 `!!set`、`!!omap` 等高级类型（未来扩展用）

---

### 2.4 子进程管理：`execa` v9

**PRD 需求：**
- spawn 子进程，双向 stdin/stdout 流通信
- 超时控制、重试、优雅终止（SIGTERM → SIGKILL）
- 跨平台兼容（macOS/Linux/Windows）

**候选方案对比：**

| 方案 | 下载量/周 | Promise API | 流式输出 | 超时控制 | 优雅终止 | 跨平台 |
|------|-----------|-------------|----------|----------|----------|--------|
| **`execa` v9** | ~114M | ✅ | ✅ | ✅ | ✅ | ✅ |
| 原生 child_process | 内置 | ❌ 需封装 | ✅ | ❌ 需封装 | ⚠️ 需封装 | ✅ |
| zx | ~20M | ✅ | ⚠️ 有限 | ⚠️ 有限 | ❌ | ✅ |
| shelljs | ~5M | ❌ | ❌ | ❌ | ❌ | ✅ |

**决策：`execa` v9。**

理由：
- 114M 周下载量，事实标准
- 原生 Promise + async iterable stdout，完美适配 NDJSON 流式解析
- 内置 timeout、cleanup、graceful termination
- 跨平台路径处理

**关键用法：**
```typescript
const subprocess = execa('claude', ['--output-format', 'json', '-p', prompt], {
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 120_000,
  env: { ANTHROPIC_API_KEY }
});

// 流式读取 stdout
for await (const line of subprocess.iterable()) {
  // 启发式 JSON 提取
}
```

---

### 2.5 条件表达式：`expr-eval`

**PRD 需求：**
- 支持 `==`、`!=`、`>`、`>=`、`<`、`<=`、`&&`、`||`、`!`
- 变量从 Blackboard 状态派生
- **禁止使用 `eval()`**

**候选方案对比：**

| 方案 | 大小 | 安全性 | 运算符支持 | 维护状态 |
|------|------|--------|------------|----------|
| **`expr-eval`** | ~5KB | ✅ 沙盒 | ✅ 全部 | 活跃 |
| jsep | ~3KB | ✅ 沙盒 | ✅ 需插件 | 活跃 |
| safe-eval | ~10KB | ⚠️ 有限 | ❌ 有限 | 不活跃 |
| 手写解析器 | 自定义 | ✅ | 需实现 | 需维护 |

**决策：`expr-eval`。**

理由：
- 安全沙盒执行，无 `eval()` 风险
- 轻量（5KB），零依赖
- 支持所有 PRD 定义的运算符
- 变量注入简单：`Parser.parse(expr).evaluate(context)`

---

### 2.6 Schema 校验：`zod`

**PRD 需求：**
- 运行时校验 Agent 消息格式
- 与 TypeScript 类型联动
- 错误信息可读（用于 L2 错误处理）

**候选方案对比：**

| 方案 | 下载量/周 | 类型推导 | 运行时校验 | 错误信息 | bundle 大小 |
|------|-----------|----------|------------|----------|-------------|
| **`zod`** | ~25M | ✅ | ✅ | ✅ 详细 | ~13KB |
| ajv | ~15M | ❌ 需生成 | ✅ | ✅ 详细 | ~40KB |
| yup | ~5M | ⚠️ 有限 | ✅ | ✅ | ~15KB |
| io-ts | ~2M | ✅ | ✅ | ⚠️ 复杂 | ~10KB |

**决策：`zod`。**

理由：
- TS 生态事实标准，类型推导零成本
- `z.infer<typeof schema>` 直接从 schema 生成类型
- 错误信息结构化，可用于 L2 错误修正 prompt
- 与 PRD 的 TypeScript 类型定义可双向对齐

---

### 2.7 日志：`pino`

**PRD 需求：**
- NDJSON 格式（与传输协议一致）
- 低开销（Agent 调用密集）
- 支持脱敏（API Key 过滤）

**候选方案对比：**

| 方案 | 性能 | NDJSON 原生 | 生态 | 脱敏支持 |
|------|------|-------------|------|----------|
| **`pino`** | ⭐⭐⭐⭐⭐ | ✅ | 成熟 | ✅ 自定义 serializer |
| winston | ⭐⭐⭐ | ❌ 需配置 | 成熟 | ✅ 但配置复杂 |
| bunyan | ⭐⭐⭐ | ✅ | 不活跃 | ✅ |

**决策：`pino`。**

理由：
- 性能最优（异步写入、对象池）
- 原生 NDJSON 输出，与 PRD 的 trace log 格式天然一致
- 自定义 serializer 实现 API Key 脱敏
- pino-pretty 开发时可读输出

---

### 2.8 构建工具：`tsup`

**候选方案对比：**

| 方案 | 配置复杂度 | 构建速度 | d.ts 生成 | CLI 友好 |
|------|------------|----------|-----------|----------|
| **`tsup`** | 零配置 | ⭐⭐⭐⭐⭐ | ✅ | ✅ |
| tsc | 需 tsconfig | ⭐⭐ | ✅ | ⚠️ |
| esbuild | 需配置 | ⭐⭐⭐⭐⭐ | ❌ | ⚠️ |
| rollup | 复杂 | ⭐⭐⭐ | ✅ | ✅ |

**决策：`tsup`。**

理由：
- 零配置，基于 esbuild（极快）
- 自动生成 d.ts
- 原生支持 CLI 入口（`bin` 字段）
- 单行配置搞定

---

## 三、依赖清单

### 生产依赖

```json
{
  "dependencies": {
    "yaml": "^2.6.0",
    "execa": "^9.5.0",
    "zod": "^3.24.0",
    "pino": "^9.6.0",
    "expr-eval": "^2.0.2",
    "deepmerge-ts": "^7.1.0"
  }
}
```

### 开发依赖

```json
{
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.3.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "pino-pretty": "^13.0.0"
  }
}
```

### 依赖体积估算

| 依赖 | 包大小 | 解压后 | 说明 |
|------|--------|--------|------|
| yaml | 370KB | 1.2MB | YAML 解析 |
| execa | 50KB | 200KB | 子进程 |
| zod | 13KB | 60KB | Schema 校验 |
| pino | 80KB | 300KB | 日志 |
| expr-eval | 5KB | 20KB | 表达式求值 |
| deepmerge-ts | 10KB | 30KB | 深度合并 |
| **总计** | **~528KB** | **~1.8MB** | 轻量 |

---

## 四、架构决策记录（ADR）

### ADR-001：自定义 FSM 而非 XState

**状态：** 已采纳  
**上下文：** PRD 定义了 7 个状态的 FSM，支持条件分支、循环、并行。  
**决策：** 使用自定义轻量实现，不引入 XState。  
**理由：**
- XState 的 statechart 模型（嵌套状态、历史状态、延迟转移）对本场景是过度设计
- PRD 的 FSM 本质是**配置驱动的步骤调度器**，遍历 steps 数组即可
- 自定义实现可原生支持 YAML 配置和 condition 表达式
- 代码量 < 500 行，可维护性高  
**后果：** 需要自行实现并行 fan-out/fan-in 逻辑，但复杂度可控。

### ADR-002：NDJSON 而非 Length-Prefix Framing

**状态：** 已采纳  
**上下文：** PRD 定义了两种消息帧格式。  
**决策：** MVP 使用 NDJSON，Length-Prefix 作为备选。  
**理由：**
- NDJSON 人类可读，调试方便（`tail -f trace.ndjson`）
- CLI 工具天然支持行输出
- 启发式 JSON 提取器可处理噪音  
**后果：** 需要实现健壮的 JSON 提取管线（PRD 4.1.1 节已详细定义）。

### ADR-003：single-shot 优先于 long-running

**状态：** 已采纳  
**上下文：** PRD 定义了两种 Agent 接入模式。  
**决策：** MVP 仅实现 single-shot 模式，long-running（MCP）放入 v2。  
**理由：**
- single-shot 实现简单，无需心跳、持久化会话、增量上下文
- Claude Code / Gemini CLI 的 single-shot 模式已足够 MVP 验证
- 降低 MVP 复杂度，快速验证核心协议  
**后果：** 每次调用需重新启动进程，有启动开销。MVP 阶段可接受。

### ADR-004：文件级 Artifact 而非内存共享

**状态：** 已采纳  
**上下文：** Harness 文档强调 "Context must crystallize into artifacts"。  
**决策：** Blackboard 内存实现 + 异步持久化到文件（WAL 模式）。  
**理由：**
- 内存实现简单，满足 single-shot 模式需求
- WAL 持久化提供崩溃恢复能力（PRD 19 节）
- 文件级 handoff 为 v2 的 long-running 模式预留接口  
**后果：** 需要实现 WAL 写入和恢复逻辑，但复杂度可控。

### ADR-005：异构模型强制分离

**状态：** 已采纳  
**上下文：** PRD 13 节防止 Groupthink，要求 proposer 和 critic 使用不同模型。  
**决策：** 在 `role_mapping` 配置中强制校验，同一 session 中 proposer 和 critic 不可使用相同 provider。  
**理由：**
- 同源模型容易产生共识偏移
- 配置层校验比运行时检测更早发现问题  
**后果：** 用户需配置至少两个不同的 Agent provider。

---

## 五、从参考资料中提取的关键设计原则

### 5.1 Anthropic Harness 启示

| 原则 | 来源 | 在本系统中的体现 |
|------|------|-----------------|
| 角色分离 > 更多 Agent | Effective Agents | proposer / critic / judge 严格分离 |
| 独立评估 > 自我评估 | Harness Design | critic 不看 proposer reasoning |
| 上下文重置 > 长上下文 | Context Engineering | session 间 context reset |
| 失败归因 > 简单重试 | Harness Design | L1-L4 错误分类 + 归因 |
| 模型越强，harness 越简 | Harness Evolution | MVP 保持精简，随模型进化 |

### 5.2 OpenAI Codex 启示

| 原则 | 来源 | 在本系统中的体现 |
|------|------|-----------------|
| 代码库对 Agent 可读 | Engineering in Agentic World | AGENTS.md 入口文档、结构化 handoff 文件 |
| 机械编码架构不变量 | Engineering in Agentic World | Blackboard 写入约束 + Schema 校验 |
| 持续垃圾回收 | Engineering in Agentic World | Trace Log + 成本追踪 + 资源限制 |
| 环境设计 > 代码编写 | Engineering in Agentic World | FlowConfig 配置驱动、Adapter 抽象 |

### 5.3 Harness 方法论启示

| 原则 | 来源 | 在本系统中的体现 |
|------|------|-----------------|
| 先定义完成，再执行 | 00-整体方案 | `done-criteria` 在 session_init 时注入 |
| 长任务分阶段 | 00-整体方案 | FSM 步骤拆分 + max_rounds 硬终止 |
| 验证贴近真实使用 | 00-整体方案 | critic 评审贴近实际使用场景 |
| 上下文结晶为文件 | 00-整体方案 | Blackboard 持久化 + WAL |
| 不让不合格结果通过 | 03-反模式 | Human-in-the-Loop 审批 + Gate 机制 |

---

## 六、MVP 实现路线图

### Phase 1：核心协议（Week 1）

**目标：** 能跑通 single-shot 的线性流程

| 模块 | 文件 | 依赖 | 说明 |
|------|------|------|------|
| 类型定义 | `src/types/*.ts` | zod | PRD 第 20 章全部类型 |
| NDJSON 传输 | `src/transport/ndjson-stream.ts` | 无 | 编解码 + 启发式提取 |
| Claude Code Adapter | `src/adapters/claude-code.ts` | execa | single-shot 模式 |
| Gemini CLI Adapter | `src/adapters/gemini-cli.ts` | execa | single-shot 模式 |
| 基础 FSM | `src/orchestrator/fsm.ts` | expr-eval | 线性流程 |
| Blackboard | `src/blackboard/blackboard.ts` | zod | 内存实现 + 写入约束 |

**验收标准：**
```bash
vera run --flow minimal --task "Review this function"
# 输出: PROPOSE → CRITIQUE → DECIDE → END
# 生成 sessions/{id}/trace.ndjson
```

### Phase 2：健壮性（Week 2）

| 模块 | 文件 | 说明 |
|------|------|------|
| 错误重试 | `src/error/retry.ts` | L1/L2 重试策略 |
| 条件分支 | `src/orchestrator/fsm.ts` | condition / break_condition |
| 终止机制 | `src/orchestrator/termination.ts` | 硬/软终止 |
| YAML 加载 | `src/config/loader.ts` | FlowConfig / agents.yaml / adapters.yaml |
| Trace Log | `src/observability/tracer.ts` | pino + NDJSON 文件 |
| 成本追踪 | `src/observability/cost-tracker.ts` | token 统计 |

### Phase 3：可观测 + CLI（Week 3）

| 模块 | 文件 | 说明 |
|------|------|------|
| CLI 入口 | `src/cli/run.ts` | vera run 命令 |
| 运行时交互 | `src/cli/interactive.ts` | Ctrl+C / p / r / s |
| 审批 UI | `src/cli/approval.ts` | Diff / Accept / Reject / Edit / Skip |
| Replay | `src/observability/replay.ts` | trace.ndjson 回放 |
| 安全 | `src/security/sanitizer.ts` | API Key 脱敏 |

---

## 七、风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| Agent CLI 接口变更 | Adapter 失效 | 中 | 版本锁定 + 适配测试 |
| NDJSON 提取失败率高 | 流程中断 | 中 | 启发式提取管线 + L2 重试 |
| single-shot 启动慢 | 用户体验差 | 高 | 预热机制（并行 spawn） |
| 成本失控 | 财务风险 | 低 | 资源限制 + 成本预警 |
| 自定义 FSM 扩展困难 | 技术债 | 低 | 接口抽象 + 测试覆盖 |

---

## 八、参考文档索引

| 文档 | 路径 | 用途 |
|------|------|------|
| PRD 完整方案 | `mvp.prd.md` | 系统架构、协议、类型定义 |
| Anthropic Harness | `anthropic/` | 多 Agent 模式、Harness 设计 |
| Harness 方法论 | `harness/` | 角色分离、失败归因、成熟度模型 |
| OpenAI 实践 | `OpenAI/` | 大规模 Agent 工程实践 |
