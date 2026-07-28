# Loop Development Workflow

> 从 OpenVera 迭代开发中沉淀的经验和最佳实践。
> 每完成一个 Phase，由当前 agent 维护更新此文档。

---

## 项目关键路径

| 路径 | 说明 |
|------|------|
| `P1-IMPLEMENTATION-PLAN.md` | 主任务清单，checkbox 格式，loop 任务消费 |
| `P0-IMPROVEMENT-PLAN.md` | P0 遗留修复项 |
| `docs/changelog.md` | 变更索引 |
| `docs/changelog/<date-hour>.md` | 变更详情 |
| `docs/roadmap.md` | 项目路线图 |
| `AGENTS.md` | 项目规范（开发约束、测试要求、架构规则） |

## 踩坑记录（必读）

### 1. 构建顺序

```
pnpm --filter @open-vera/core build  # 必须先 build core
pnpm test                             # 再跑测试
```

**原因**：harness 包 import `@open-vera/core/tools` 等路径，依赖 core 的 `dist/` 输出。不先 build core 会报 `Cannot find package`。

### 2. 包名

- Core: `@open-vera/core`
- Harness: `@open-vera/openvera`
- 不是 `@vera/core`，filter 时注意。

### 3. 依赖方向

`harness → core`，Core 永不 import Harness。违反会编译报错。

### 4. ESM 导入

所有相对导入必须带 `.js` 后缀：`import { foo } from "./bar.js"`

### 5. 测试 Mock 规则

- Mock 仅用于外部 API（LLM adapter、网络请求）
- 不 mock 内部模块
- 用 Vitest 的 `vi.fn()` / `vi.mock()`

### 6. 常见错误

| 错误 | 原因 | 修复 |
|------|------|------|
| `Cannot find package @open-vera/core/tools` | core 未 build | `pnpm --filter @open-vera/core build` |
| `Author identity unknown` | git config 未设置 | `git config user.email/name` |
| `503 No available accounts` | API 服务临时不可用 | 等待重试，或直接手动实现 |

---

## 并行开发流程

```
1. 读 P1-IMPLEMENTATION-PLAN.md → 找当前 Phase 未完成项
2. 按依赖关系分组：
   - 修改不同文件 → 可并行
   - 修改同一文件同一函数 → 必须串行
3. 并行启动 Agent 工具，每个负责一个独立任务
4. 合并结果 → 解决冲突 → 跑全量测试
5. 测试通过 → git commit → 更新 changelog
```

### Agent Prompt 模板

启动子 agent 时必须包含：

```
1. 先读取相关文件了解上下文
2. 实现代码（遵循 AGENTS.md 规范）
3. **必须编写测试**（放在 tests/ 子目录，Vitest）
4. 确保 tsc --noEmit 通过
```

**关键**：不写"测试数量至少 X 个"，写"按实际代码内容、分支覆盖、改动点来决定"。

---

## 测试要求

- 无测试 = 未完成，不允许 commit
- 测试框架：Vitest（`describe` / `it` / `expect`）
- 覆盖：正常路径、边界条件、错误处理
- Mock 仅外部 API

---

## Commit 规范

```
<type>(<scope>): <description>

type: feat / fix / refactor / test / docs / chore
scope: core / harness / tool / agent / memory / rag / sandbox / channel
```

示例：`feat(harness): add SelfLoopRunner with termination conditions`

---

## Phase 完成后 Checklist

- [ ] 所有任务 checkbox 已勾选
- [ ] `pnpm --filter @open-vera/core build && pnpm test` 全部通过
- [ ] git commit 已完成
- [ ] `docs/changelog.md` 已更新
- [ ] `docs/changelog/<date-hour>.md` 已创建
- [ ] `docs/roadmap.md` 对应条目已标记 ✅
- [ ] **本 skill 已更新**（新增踩坑、优化流程、补充经验）

---

## 已完成 Phase 经验

### Phase 0 收尾（2026-05-27）

- D4 (Tool Middleware 测试) + E3 (未使用导入清理) + E2 (CHANGELOG) + E1 (API 文档)
- 经验：子 agent 可能因 503/504 超时失败，需要重试机制或手动接管
- 经验：并行 agent 修改不同文件时无冲突，合并很顺利
- 经验：agent 不会自动写测试，prompt 里必须明确要求

### Phase 1 SelfLoopRunner（2026-05-27，完成）

- S1-S6 全部完成：骨架、终止条件、JSONL 写入、runtime 集成、单元测试、E2E 测试
- SelfLoopRunner: 469 行，含 cycle 执行、4 种终止条件、JSONL 写入、duplicate detection
- CriticAgent: 317 行，独立批判 + 3 轮辩论机制，16 个单元测试
- 踩坑：duplicate detection 的 `critiqueSummary` 和 `critiqueKey` 格式不一致导致比较永远 false → 修复为统一 `entryKey()` 解析
- 经验：并行 agent 可能修改同一文件（如 changelog.md），需检查 diff 后合并
- 踩坑：loop agent 可能提前创建未实现模块的测试（如 Phase 3 的 failure-attributor.test.ts），导致 test suite 报错 → 删除未跟踪的过早测试文件

### Phase 3/4/5 并行完成（2026-05-27，完成）

- Phase 3 (F1-F5): FailureAttributor 失败归因模块，12 tests
- Phase 4 (T1-T5): Tool Runtime 增强 — 幂等控制、可重试错误、dry-run、输出截断，21 tests
- Phase 5 (SA1-SA5): Subagent 系统增强 — 并行扇出、SharedContext、权限继承、递归深度限制，37 tests
- 经验：Phase 4 和 Phase 5 可以并行开发，因为它们修改不同文件（core/tools vs core/agent）
- 经验：两个 agent 同时运行约 5 分钟完成，比串行快一倍
- 经验：并行完成后需要先 build core 再跑全量测试，确保无冲突
- 经验：T1-T3 已有部分字段（idempotent/dryRun/retryable），agent 正确识别并补充实现而非重复定义
- 测试总数：792 tests（Core 558 + Harness 234）

### Phase 6 Session Manager（2026-05-27，完成）

- SS1-SS5: SessionManager 类 — auto-compression、dedup (trigram similarity)、keyword index、lifecycle cleanup
- 23 tests, 871 lines added
- 踩坑：`tool-runtime.test.ts` 从 harness 导入 `truncateOutput`，违反 core→harness 依赖方向 → 移动函数到 core 的 `tools/utils/truncate.ts`
- 经验：SessionManager 复用了已有的 `compressMessages()` 和 `estimateMessageTokens()`，不需要重新实现压缩逻辑
- 经验：session.test.ts 有 flaky 测试（分页），单独跑通过、全量跑偶尔失败 — 已知问题，非本次引入
- 测试总数：815 tests（Core 581 + Harness 234）

### Phase 7 Memory Enhancement（2026-05-27，完成）

- M1-M6: auto-extract、auto-organize (dedup + TTL cleanup)、compress (union-find clustering)、decay (exponential half-life)、MemoryGraph (keyword/tag/co-occurrence relations)
- 28 tests, 1264 lines added, 1 new file (graph.ts)
- 经验：M1-M4 全部作为 MemoryStore 方法实现，不需要新文件；M5 (MemoryGraph) 因为是独立数据结构，值得单独文件
- 踩坑：MemoryGraph 的 co-occurrence 关系会在 entries 创建时间接近时自动建立，即使设置了高 keyword/tag 阈值。测试"disconnected entries"需要同时禁用 co-occurrence weight
- 经验：MemoryEntry 增加可选字段 `accessCount` / `lastAccessedAt` 时，需要同步更新 `isValidMemoryEntry` 验证函数，否则旧 JSONL 加载时这些字段会被丢弃
- 经验：trigram Jaccard similarity 对短文本（< 10 字符）效果不佳，但对 memory 内容长度（通常 20+ 字符）足够
- 测试总数：843 tests（Core 609 + Harness 234）

### Phase 8 Skill Enhancement（2026-05-27，完成）

- SK1-SK6: SkillAutoExtractor（从执行 trace 提取 skill 模板）、SkillAutoScorer（效果评分）、SkillRecommender（任务匹配推荐）、SkillVersionManager（版本管理 + 回滚）、SkillHotReloader（文件监视 + 去抖重载）
- 34 tests, 1632 lines added, 4 new files
- 经验：SK1-SK4 都是纯数据结构，不依赖文件系统，可以安全地在测试中覆盖所有分支
- 踩坑：SkillAutoScorer 的 composite score 计算需要仔细测试 — 50% 失败率但速度快且无成本时，分数仍然较高（0.8），因为 speed 和 cost 权重各 0.3。测试需要理解权重组合
- 经验：SkillHotReloader 使用 `fs.watch()`，在测试中不测试实际文件系统监视（避免 flaky），只测试手动 reload/unload/pin 逻辑
- 经验：SkillVersionManager 的 rollback 操作会创建一个新版本（记录 rollback 事件），而不是删除后续版本 — 这是设计决策，确保版本历史完整
- 经验：SkillRecommender 的 keyword overlap 使用 Jaccard similarity，对中英文混合文本需要 tokenize 为单词后再比较
- 测试总数：877 tests（Core 609 + Harness 268）

### Phase 9 Storage Layer — SQ1-SQ3（2026-05-27，完成）

- SQ1: StorageProvider 抽象层 — types.ts 定义接口、查询类型、错误层次
- SQ2: SqliteStorageProvider — better-sqlite3, WAL mode, prepared statements, FTS5, 53 tests
- SQ3: FileStore — per-namespace JSON files, atomic writes, in-memory cache, 55 tests
- 经验：SQ2 和 SQ3 可以并行开发，它们实现同一接口但修改不同文件
- 踩坑：better-sqlite3 需要 `pnpm approve-builds` 才能编译 native 模块，否则会报 "Ignored build scripts"
- 踩坑：`@types/better-sqlite3` 不会自动安装，需要 `pnpm add -D @types/better-sqlite3`
- 踩坑：ISO timestamp 字符串比较 `updatedAt >= createdAt` 在 Vitest 中不能用 `toBeGreaterThanOrEqual`（只接受 number/bigint），需要用 `>=` 运算符 + `toBe(true)`
- 经验：FileStore 的 TTL 清理用 `setInterval` + `unref()` 避免阻止进程退出
- 经验：SQLite 的 FTS5 需要手动创建触发器来保持索引同步（INSERT/UPDATE/DELETE）
- 测试总数：1093 tests（Core 825 + Harness 268）

### Phase 9 Storage Layer — SQ4（2026-05-27，完成）

- SQ4: Session 存储迁移 — 同步写入、importSession、exportJsonl、verifyMigration，10 tests
- 经验：fire-and-forget 异步写入（`.catch(() => {})`）在测试中极不稳定 — 改为同步 `storage.setSync()` 后所有测试稳定通过
- 踩坑：`migrateJsonlToSqlite` 原本用 `(adapter as unknown as {storage: ...}).storage.set()` 强转访问私有字段，需新增公共 `importSession()` 方法替代
- 踩坑：`ValidationError` 在 `errors.ts` 和 `storage/user-data.ts` 两处导出，导致 `src/index.ts` barrel 重导出冲突 — 重命名为 `UserDataValidationError`
- 踩坑：`Record<string, unknown>` 类型的 `entry` 字段访问 `entry.model as string` 等需要显式类型断言，TypeScript strict mode 不会自动 narrow
- 经验：`verifyMigration()` 比较条目数 + 逐行 JSON parse 计数（容忍损坏行），不需要字节级比较
- 经验：pre-existing test failure（session.test.ts 分页）与本次改动无关，可通过 `git stash` + 跑测试验证是否 pre-existing
- 测试总数：1103 tests（Core 835 + Harness 268）

### Phase 10 RAG — R1（2026-05-27，完成）

- R1: VectorStore + EmbeddingAdapter 抽象接口，16 tests
- 经验：RAG 类型文件（types.ts）只定义接口和错误类，不涉及任何实现，测试聚焦于错误类构造和接口结构合规性
- 经验：barrel export 在 `packages/core/src/rag/index.ts`，然后在 `packages/core/src/index.ts` 加一行 `export * from "./rag/index.js"` 即可
- 经验：类型测试用 mock implementation 验证接口结构，不需要实际向量计算
- 测试总数：1430 tests（Core 1162 + Harness 268）

### Phase 10 RAG — R2（2026-05-27，完成）

- R2: LocalVectorStore — SQLite-backed vector store with cosine similarity search, 59 tests
- 实现要点：embedding 存为 Float64 BLOB，upsert 时预计算 L2 norm 存入 DB，search 时直接用余弦公式
- 踩坑：`makeEmbedding` 测试辅助函数用 `Math.sin(seed * (i+1))` 生成向量，会产生负值分量，导致余弦相似度为负。默认 `minScore=0` 会过滤掉这些结果，造成 2 个测试失败 → 修复为 `Math.abs(Math.sin(...)) + 0.01` 确保全正
- 经验：LocalVectorStore 实现和测试文件在 R1 完成时已被创建（可能是之前 agent 的工作），本次主要是修复测试 bug
- 经验：brute-force 向量搜索适用于 <100k 文档场景，SQLite 单表存储即可，不需要外部向量索引库
- 经验：metadata 过滤通过 JS 层 JSON match 实现（SQLite 无 JSON 索引），对大量文档可能有性能问题，但当前规模可接受
- 测试总数：1489 tests（Core 1221 + Harness 268）

### Phase 10 RAG — R3-R8（2026-05-27，完成）

- R3: Embedding adapters (OpenAI/Voyage/Local + factory), 28 tests
- R6: DocumentLoader — batch file indexing with chunking, 22 tests
- R7: knowledge_search tool — RAG vector search via ToolRegistry, 9 tests
- R8: IncrementalIndexer — mtime-based change detection, 10 tests
- 踩坑：incremental-indexer.test.ts 使用 `filesScanned` 但接口定义为 `filesChecked`，TS 编译失败 → 统一字段名
- 踩坑：knowledge-search.test.ts 缺少 `afterEach` import，TS 编译失败 → 补充 import
- 踩坑：IncrementalIndexer 的 `loadManifest` 参数类型缺少 `version` 可选字段 → 添加 `version?: number`
- 经验：mtime 检测在快速连续写入时可能因文件系统时间粒度问题无法检测到变更 → 测试中使用 `utimesSync` 显式设置未来时间
- 经验：R3-R8 实现文件和测试由之前的 agent 创建但未提交，本次主要是修复 TS 错误、更新 checkbox、提交 changelog
- 测试总数：~1558 tests（Core 1290 + Harness 268）

### Phase 10.2 Eval — EV2+EV8（2026-05-27，完成）

- EV2: GAIA Runner — GAIA 原始格式转 EvalCase，按级别过滤，per-level 超时
- EV8: 52 tests — EvalHarness（所有 eval 类型、错误处理、report）、EvalReporter（markdown、comparison）、GaiaRunner
- 踩坑：`eval/index.ts` 的类型导出与 `types.ts` 的 `EvalResult` 冲突 → 不将 eval 子模块 re-export 到 harness 主 index，保持独立子路径
- 踩坑：`change-tracker.ts` 有两个 `generateSummary` 方法（public async + private），tsc 报 duplicate function → 重命名 private 为 `generateToolSummary`
- 经验：eval 框架（EV1）和 reporter（EV6）代码已存在但无测试，先补测试再做 EV2 更稳妥
- 经验：GAIA runner 设计为轻量包装层，核心逻辑（评分、report）全复用 EvalHarness，只做格式转换和配置
- 测试总数：~1610 tests（Core 1290 + Harness 320）

### Phase 10.2 Eval — EV3（2026-05-27，完成）

- EV3: SWE-bench Runner — GitHub issue 格式转 EvalCase，按 difficulty/repo 过滤，per-difficulty 超时
- 30 tests：loading/filtering、prompt building、evaluation、metrics
- 经验：SWE-bench Runner 和 GAIA Runner 结构几乎一致（都是 EvalHarness 的轻量包装），新增 `SweBenchMetrics` 提供 benchmark-specific 指标（resolved rate、patch rate、patch accuracy）
- 经验：SWE-bench 的评估核心是 patch 匹配，当前用 `contains` eval type 近似——真实场景需要沙箱环境应用 patch 并运行 test_patch
- 经验：`includeTestPatch` 和 `includeGoldPatch` 选项用于调试，生产评测默认关闭
- 测试总数：~1640 tests（Core 1408 + Harness 542）

### Phase 10.2 Eval — EV4（2026-05-27，完成）

- EV4: ToolBench Runner — 16464 任务的工具使用评测集，40 tests
- 实现要点：支持 single-tool / multi-tool / multi-turn 三类任务，optional tool 标记不计入必须匹配
- 踩坑：mock agent 的 prompt 匹配逻辑需要确保测试 fixture 中的 `expected_answer` 字段不会覆盖 evalType 选择——当 `expected_answer` 存在时 evalType 变为 `contains` 而非 `tool_match`，导致 partial match 测试失败
- 经验：ToolBenchMetrics 提供 per-category breakdown 和 avg API calls，比 GAIA/SWE-bench 更关注工具使用效率
- 经验：category→level 映射结合 category 和 difficulty 两个维度，multi-turn 直接映射到 L3
- 测试总数：~1680 tests（Core 1408 + Harness 582）

### Phase 10.2 Eval — EV7（2026-05-27，完成）

- EV7: Regression Detection — CIGate + CI workflow + 61 tests
- CIGate: 包装 RegressionDetector，提供 CI 友好的 run/check/formatReport API，返回 exit code
- ci-runner.ts: CLI 入口，加载 GAIA L1 cases，检查回归，写 report
- GitHub Actions workflow: eval-regression.yml，PR 合并前自动跑 GAIA L1，pass rate 下降 >5% 阻断
- 经验：RegressionDetector 和 BenchmarkHarness.checkRegression() 已存在但无测试——"代码存在"不等于"已测试"，always check test coverage
- 踩坑：CIGate 回归测试中，mock agent 的返回值必须匹配 EvalCase.expected，否则 pass rate 始终为 0，无法触发回归——确保 baseline agent 能真正通过评估
- 经验：CI runner 的 agent executor 当前为 mock，集成真实 agent runtime 后才能实际在 CI 中运行
- 测试总数：~1741 tests（Core 1408 + Harness 643）

### Phase 10.3 SP6 WebUI（2026-05-27，完成）

- SP6: TrainingMonitor — 轻量 HTTP 服务器，SSE 实时推送 + REST API + HTML Dashboard
- 25 tests, 731 lines added, 3 new files
- 实现要点：使用 Node 内置 `http` 模块，零新依赖；Chart.js 从 CDN 加载
- 踩坑：`server.listen(0, host, callback)` 后 `this.config.port` 仍为 0，必须从 `server.address()` 读取实际端口 → 修复为 listen callback 内更新 `this.config.port`
- 经验：SSE 测试需要控制超时——用 `setTimeout` 在客户端接收 init 事件后关闭连接，避免测试挂起
- 经验：XSS 测试验证 run name 中的 `<script>` 标签被正确转义为 `&lt;script&gt;`
- 经验：HTTP 测试 helper 应使用静态 `import http` 而非动态 `import()`，避免模块加载时序问题
- 测试总数：~1766 tests（Core 1525 + Harness 732）（含 1 个 pre-existing flaky session 分页测试）

### Phase 16 Channel — CH1（2026-05-27，完成）

- CH1: Channel 抽象层 — types.ts 定义 ChannelAdapter 接口、ChannelMessage 统一格式、连接状态、Gateway 事件类型、错误层次
- 32 tests, 743 lines added, 3 new files
- 实现要点：10 种 ChannelType（cli/api/webhook/feishu/wecom/telegram/discord/slack/whatsapp/custom），5 种 AttachmentType，4 种 ConnectionState
- 经验：Channel 模块放在 `packages/core/src/channel/`（与 rag/storage/network 同级），barrel export 到 core index.ts
- 经验：接口合规性测试用 mock implementation 验证结构，包含 connect/disconnect 生命周期、消息收发、历史检索的交互测试
- 经验：Gateway 事件类型用 discriminated union（`type` 字段区分），TypeScript 自动 narrow
- 测试总数：~1821 tests（Core 1557 + Harness 732）（含 1 个 pre-existing flaky session 分页测试）

### Phase 16 Channel — CH2（2026-05-27，完成）

- CH2: Channel Gateway — ChannelGateway 类管理多 adapter、连接生命周期、消息路由、session 绑定、自动重连
- 41 tests, 319 lines added, 1 new file (gateway.ts)
- 踩坑：`ChannelAdapter` 接口用 `state` 而非 `connectionState`，`sendMessage()` 接受 `SendMessageOptions` 而非 `ChannelMessage` — 必须先读实际接口再编码
- 踩坑：`GatewayEvent` 是 discriminated union，不能发明新的 event type（如 `adapter_added`），必须用已定义的类型
- 踩坑：`gateway.connect()` 是 async，测试中必须 `await`，否则 event callback 在断言时还未触发
- 经验：`dispatchMessage` 设计为 public，供外部系统注入消息到 gateway（不仅限内部路由）
- 经验：session binding 在 adapter 移除时自动清理，避免悬挂引用
- 经验：auto-reconnect 用 `setTimeout` + 递归重试，不阻塞 `connectAll()` 返回
- 测试总数：~1862 tests（Core 1598 + Harness 732）（含 1 个 pre-existing flaky session 分页测试）

### Phase 16 Channel — CH3（2026-05-27，完成）

- CH3: CLI Channel — CliChannelAdapter 实现 ChannelAdapter 接口，支持 interactive/pipe/non-interactive 三种模式
- 24 tests, 703 lines added, 2 new files (cli-channel.ts + cli-channel.test.ts)
- 实现要点：interactive 模式用 node:readline 的 createInterface，pipe 模式用 stream events 读取所有 stdin 直到 EOF，non-interactive 模式暴露 processInput() 供编程式调用
- 踩坑：pipe 模式下 connect() 是 async，必须等 stdin 'end' 事件后才 resolve——测试中用 PassThrough stream 模拟 stdin，写入后立即 end()
- 经验：CliChannelAdapter 的 sendMessage 用 output.write() 而非 console.log()，方便测试中捕获输出（PassThrough stream）
- 经验：interactive 模式 readline 的 'line' 事件回调中空行需要跳过（`if (trimmed)`），否则会产生空消息
- 经验：disconnect() 需要安全地支持多次调用（不抛错），因为 readline.close() 在已关闭的接口上可能抛异常
- 测试总数：~2474 tests（Core 1742 + Harness 732）

### Phase 16 Channel — CH4（2026-05-27，完成）

- CH4: API Channel — ApiChannelAdapter 实现 ChannelAdapter 接口，REST HTTP + WebSocket 双协议
- 30 tests, 482 lines added, 2 new files (api-channel.ts + api-channel.test.ts)
- 实现要点：REST 用 node:http createServer，WebSocket 用 RFC 6455 最小实现（frame parsing、mask/unmask、ping/pong/close），端口 0 自动分配
- 踩坑：`Array.push()` 返回 `number`，TypeScript strict mode 下作为 `MessageCallback`（返回 `void | Promise<void>`）的回调时会报类型错误 → 用 `{ arr.push(msg); }` 块语句替代表达式箭头
- 踩坑：WS 认证拒绝测试 — 服务端用 `socket.write()` + `socket.destroy()` 会导致客户端收到 ECONNRESET 而非 HTTP 401 → 改用 `socket.end()` 确保 401 响应被完整发送
- 踩坑：WS 认证拒绝测试中，客户端 `http.request` 的 `upgrade` 事件不会触发（因为服务端返回普通 HTTP 响应）→ 需要监听 `response` 事件而非 `upgrade`
- 经验：`node:crypto` 的 `createHash` 必须用 static import（ESM 不支持 `require()`）
- 经验：REST API 的 `readBody` 需要限制 body 大小（maxBodyBytes），防止 DoS
- 测试总数：~2534 tests（Core 1802 + Harness 732）

### Phase 16 Channel — CH5（2026-05-27，完成）

- CH5: Webhook Channel — WebhookChannelAdapter 实现 ChannelAdapter 接口，HTTP webhook 接收器 + HMAC-SHA256 签名验证
- 49 tests, 743 lines added, 2 new files (webhook-channel.ts + webhook-channel.test.ts)
- 实现要点：支持 4 种签名策略（GitHub/Stripe/Slack/Custom），timingSafeEqual 防时序攻击，内置 GitHub push/issue 和 Stripe payload parser
- 踩坑：签名验证测试中，`httpRequest` helper 发送 JSON body 时 Content-Length 由 helper 内部计算，但签名需要基于**原始 JSON 字符串**计算。如果先用 `httpRequest` 再用 `rawPost` 发两次请求，第一次会因签名校验失败导致服务器挂起 → 必须用 `rawPost` 一次发送，确保签名和 body 一致
- 经验：Webhook adapter 是纯 HTTP server（无 WebSocket），实现比 API Channel 简单，但签名验证逻辑需要仔细测试每种策略
- 经验：GitHub/Stripe payload parser 作为内部函数实现，通过 `STRATEGY_PARSERS` map 按 strategy name 查找，比 OOP 继承更灵活
- 经验：timingSafeEqual 要求两个 Buffer 长度相等，否则直接返回 false（不抛错），这是正确的安全行为
- 测试总数：~2632 tests（Core 1900 + Harness 732）

### Phase 16 Channel — CH6（2026-05-27，完成）

- CH6: ChannelPluginRegistry — 运行时动态加载/卸载 channel adapter
- 42 tests, 355 lines added, 2 new files (plugin-registry.ts + plugin-registry.test.ts)
- 实现要点：Plugin 注册/注销 + Adapter 实例加载/卸载 + 批量操作 + 按 plugin/channelType 查询
- 踩坑：测试中 `createMockAdapter()` 在外部创建，但 `factory` 函数内部又调用 `createMockAdapter()` 创建新实例 → 断言检查的是外部创建的 mock，而实际加载的是 factory 内部创建的新 mock → 断言永远失败。修复：让 factory 闭包捕获外部创建的 mock adapter
- 经验：Plugin 模式比直接 addAdapter 更灵活——metadata（name/version/channelType）支持运行时发现和批量管理，factory 函数支持延迟初始化和配置注入
- 测试总数：~2674 tests（Core 1942 + Harness 732）

### Phase 16 Channel — CH7（2026-05-27，完成）

- CH7: Channel Multi-Channel Concurrent Tests — 8 integration tests covering Gateway lifecycle, message routing, multi-channel concurrency
- 实现要点：在已有 gateway.test.ts（41 tests）基础上新增 `multi-channel lifecycle` describe block
- 测试覆盖：full lifecycle、correct channel routing、concurrent dispatch (Promise.all)、event ordering、error isolation、cross-channel session bindings、partial connect failures、adapter removal during active operation
- 踩坑：`Array.push()` 返回 `number`，TypeScript strict mode 下作为 `MessageCallback` / `GatewayEventCallback` 的表达式箭头函数返回值会报类型错误 → 用块语句 `{ arr.push(x); }` 替代
- 经验：CH1-CH6 各自已有独立测试文件（types/gateway/cli-channel/api-channel/webhook-channel/plugin-registry），CH7 聚焦于跨 channel 的集成场景（多 adapter 并发、错误隔离、session 跨 channel 绑定），不需要新文件
- 测试总数：~2732 tests（Core 2000 + Harness 732）

### Phase 17 Adaptive Strategy — AD1（2026-05-27，完成）

- AD1: Strategy Store — 按任务域存储策略配置 + 成果追踪 + 统计对比，44 tests
- 实现要点：策略类型（10 种 domain、4 种 status）+ JSON 持久化 + outcome-based 统计
- 踩坑：测试中用 `await import("node:fs")` 在非 async 回调中导致 parse error → 改用已 import 的 `writeFileSync`
- 经验：StrategyStore 模式与 ProposalStore 一致（JSON 文件持久化 + filter + CRUD），新模块可以快速复用模式
- 经验：outcomes 单独存储（strategy-outcomes.json）比嵌入 strategy 对象更好——策略配置变更不影响历史统计数据
- 测试总数：~2776 tests（Core 2000 + Harness 776）

### Phase 17 Adaptive Strategy — AD2（2026-05-27，完成）

- AD2: Historical Success Rate — 时间窗口统计、趋势检测、自动调优，17 tests
- 实现要点：`getStatsWindowed()` 按 TimeWindow（1h/6h/24h/7d/30d）过滤 outcomes 后复用 `computeStats()`；`getTrend()` 比较 recent vs older 两个窗口；`autoTune()` 自动 promote/deprecate
- 经验：AD1 已有 `getStats()`、`getBestForDomain()`、`findUnderperforming()` 等基础统计方法，AD2 是在此基础上增加时间维度和自动化——先检查已有代码再动手
- 经验：重构 `getStats()` 为 `computeStats(strategyId, outcomes[])` 私有方法，windowed 和 overall 统计共用同一逻辑，避免代码重复
- 经验：趋势检测的阈值（5% delta）和 auto-tune 的 promote/deprecate 阈值应可配置，不同场景需要不同灵敏度
- 测试总数：~2793 tests（Core 2000 + Harness 793）

### Phase 17 Adaptive Strategy — AD3（2026-05-27，完成）

- AD3: Auto-Tuner — UCB1 策略选择、复合评分、优化周期、推荐引擎，37 tests
- 实现要点：`AutoTuner` 类包装 `StrategyStore`，用 UCB1（Upper Confidence Bound）平衡探索与利用；复合评分 = successWeight×成功率 + speedWeight×速度 + costWeight×成本效率；`runOptimizationCycle()` 遍历所有 domain 生成推荐
- 踩坑：速度归一化用 `referenceDurationMs / avgDurationMs` 并 clamp 到 [0,1]，测试中 500ms 和 5000ms 都被 clamp 到 1（参考值 5000ms）→ 改为 500ms vs 50000ms 才能区分
- 经验：未尝试的策略（0 runs）获得无限探索奖励（`Infinity`），确保新策略有机会被试用
- 经验：`selectOptimal()` 只考虑 active 和 candidate 策略，deprecated/retired 自动排除
- 经验：推荐稳定性追踪最近 5 次 cycle 的推荐变化，用于检测 oscillation
- 测试总数：~2830 tests（Core 2000 + Harness 830）

---

*本文件由 loop 任务和手动开发共同维护。每完成一个 Phase 后必须更新。*
