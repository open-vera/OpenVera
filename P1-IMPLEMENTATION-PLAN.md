# OpenVera 完整实现计划

> 分支：feature/p1-checkpoint-resume
> 目标：从 P1 到 P3 全面实现，对标行业 SOTA agent 框架能力
> 按优先级排列，每项完成后勾选 checkbox
> loop 定时任务每 12 分钟自动执行一项

---

## Phase 0: P0 收尾（先清遗留）

- [x] **D4** Tool Middleware 完整管线测试 — before→execute→after→onError 全链路（10+ tests）
- [x] **E3** 未使用导入清理 — grep 检查并移除未使用的 import
- [x] **E2** CHANGELOG 更新 — 记录 feature 分支所有里程碑
- [x] **E1** API 文档 — 为 checkpoint-store、memory store、subagent-pool/orchestrator 生成 README

---

## Phase 1: Self-Loop Runtime（P1 核心）

- [x] **S1** 创建 `packages/harness/src/flow/self-loop.ts` — SelfLoopRunner 类骨架
- [x] **S2** 实现循环终止条件：confidence≥0.9 / maxCycles(默认5) / budgetUsd / 连续重复critique检测
- [x] **S3** 实现 cycle_end JSONL entry 写入（含 critique 摘要、是否 replan）
- [x] **S4** 集成到 HarnessRuntime — 在 runtime.ts 中增加 `runSelfLoop()` 入口
- [x] **S5** SelfLoopRunner 单元测试（15+ tests：正常终止、budget 超限、死循环检测、replan 触发）
- [x] **S6** E2E 测试：plan→self-loop→critique→replan→complete 全链路

## Phase 2: Critic Agent（独立批判能力）

- [x] **CR1** 创建 `packages/harness/src/critic/critic-agent.ts` — 独立 CriticAgent 类
- [x] **CR2** 实现 critiquePrompt 模板 — 按 step 产出结构化评分（issues/confidence/nextAction）
- [x] **CR3** 实现主 agent 与 critic agent 的有限轮辩论（max 3 轮）
- [x] **CR4** CriticAgent 集成到 SelfLoopRunner — 每个 cycle 结束自动 critique
- [x] **CR5** CriticAgent 测试（10+ tests：评分、辩论收敛、边界 case）

## Phase 3: 失败恢复与归因

- [x] **F1** 创建 `packages/harness/src/runtime/failure-attributor.ts` — 失败归因模块
- [x] **F2** 定义失败分类枚举：model/tool/permission/context/plan_deviation
- [x] **F3** 实现 root cause 记录到 JSONL session（failure entry 含 category + root_cause + step_id）
- [x] **F4** 实现失败 case 自动回放 — 从 session 中提取失败 step 重新执行
- [x] **F5** 失败归因测试（12 tests：分类准确性、回放、边界）

## Phase 4: Tool Runtime 增强

- [x] **T1** 幂等控制 — ToolDef 增加 `idempotent` 标记，重复调用检测
- [x] **T2** 可重试错误分类 — ToolResult 增加 `retryable` 字段，retry 策略整合
- [x] **T3** dry-run/simulate 能力 — ToolContext 增加 `dryRun` 标记，工具层支持
- [x] **T4** shell 输出截断与摘要增强 — bash 工具超长输出自动摘要（接入 context 压缩）
- [x] **T5** Tool Runtime 增强测试（12+ tests）

## Phase 5: Subagent 系统增强

- [x] **SA1** 并行扇出 — orchestrator 支持 parallel dispatch 多个 worker
- [x] **SA2** 共享上下文层 — key-value 按需同步机制
- [x] **SA3** 权限继承与 usage 汇总 — 子 agent 继承父 agent 权限，token 用量汇总
- [x] **SA4** 递归 subagent — maxDepth 限制（默认 3），防止无限递归
- [x] **SA5** Subagent 增强测试（10+ tests）

---

## Phase 6: Session 自动压缩与智能管理

- [x] **SS1** 自动 session 压缩 — 超过 token 阈值自动摘要旧轮次，无需手动触发
- [x] **SS2** Session 去重与合并 — 相似 session 自动归并，减少存储膨胀
- [x] **SS3** Session 索引 — 按 topic/keyword/sessionId 快速检索历史 session
- [x] **SS4** Session 生命周期管理 — 自动清理过期 session（可配置 TTL）
- [x] **SS5** Session 压缩测试（8+ tests）

## Phase 7: 记忆系统增强（自动提取/整理/压缩）

- [x] **M1** 记忆自动提取 — agent 执行过程中自动识别高价值信息存入 semantic memory
- [x] **M2** 记忆自动整理 — 定期去重、合并相似记忆、清理过期记忆
- [x] **M3** 记忆压缩 — 大量记忆自动聚类压缩为高层摘要
- [x] **M4** 记忆衰减 — 基于访问频率的重要性衰减机制（未被检索的记忆权重降低）
- [x] **M5** 记忆关联图谱 — 记忆之间建立关联关系，支持关联检索
- [x] **M6** 记忆增强测试（10+ tests：自动提取准确性、去重、压缩质量、衰减曲线）

## Phase 8: Skill 自动提取与管理

- [x] **SK1** Skill 自动提取 — 从成功执行中提取可复用的 skill 模板
- [x] **SK2** Skill 自动总结 — 每个 skill 执行后自动生成摘要和效果评分
- [x] **SK3** Skill 推荐 — 根据当前任务自动推荐匹配的 skill
- [x] **SK4** Skill 版本管理 — skill 变更自动记录版本，支持回滚
- [x] **SK5** Skill 热更新 — 运行时动态加载/卸载 skill，无需重启
- [x] **SK6** Skill 增强测试（8+ tests）

## Phase 9: 本地存储系统（SQLite + 文件）

- [x] **SQ1** 存储抽象层 — `packages/core/src/storage/types.ts`，定义 `StorageProvider` 接口
- [x] **SQ2** SQLite 适配器 — `packages/core/src/storage/sqlite.ts`，封装 better-sqlite3
- [x] **SQ3** 文件存储适配器 — `packages/core/src/storage/file-store.ts`，简易 key-value 文件存储
- [x] **SQ4** Session 存储迁移 — 从 JSONL 迁移到 SQLite（保留 JSONL 兼容层）
- [x] **SQ5** 记忆存储 — semantic/episodic memory 存入 SQLite，支持全文搜索（FTS5）
- [x] **SQ6** 用户数据存储 — 用户可通过 `data_save` / `data_load` 工具存取任意结构化数据
- [x] **SQ7** 查询接口 — 按时间/类型/关键词/关联查询历史数据
- [x] **SQ8** 数据导出 — 支持导出为 JSONL/CSV/JSON
- [x] **SQ9** SQLite 集成测试（12+ tests：CRUD、并发、迁移、查询性能、用户数据存取）

## Phase 10: RAG 知识库能力

- [x] **R1** 向量存储接口 — `packages/core/src/rag/types.ts`，定义 `VectorStore` 抽象接口
- [x] **R2** 本地向量存储 — `packages/core/src/rag/local-vector-store.ts`，基于 SQLite + 自实现向量索引（无需外部依赖）
- [x] **R3** Embedding 适配器接口 — `packages/core/src/rag/embedding-adapter.ts`，统一接口
- [x] **R4** 远程 Embedding — OpenAI/Anthropic embedding API 适配器（默认）
- [x] **R5** 本地 Embedding — 留接口支持本地小模型（ONNX/GGML），可选插件
- [ ] **R6** 文档加载器 — 支持 Markdown/JSON/TypeScript/文本文件批量索引
- [ ] **R7** 检索工具 — `knowledge_search` tool，集成到 ToolRegistry
- [ ] **R8** 增量索引 — 文件变更自动更新向量索引（基于 mtime 检测）
- [ ] **R9** RAG 集成测试（12+ tests：索引准确性、检索质量、增量更新、embedding 切换）

## Phase 10.1: Agent 变更追踪与知识库（CT）

> 核心思想：hook agent 的工具调用，自动记录变更，形成可查询的项目变更知识库。
> 新会话时 agent 可以通过 change_query skill 快速了解项目变更历史，无需遍历 git log。

- [ ] **CT1** 变更追踪器 — `packages/harness/src/tracking/change-tracker.ts`
  - 在 ToolRegistry 的 `execute()` 方法中添加 hook，记录每次工具调用
  - 记录字段：`timestamp, agentId, toolName, args, result, filesChanged[], summary`
  - 支持配置：`trackReads`（是否记录读操作）、`maxResultLength`（截断阈值）
- [ ] **CT2** 变更存储 — `packages/harness/src/tracking/change-store.ts`
  - JSONL 格式存储，按日期分文件：`~/.vera/changes/YYYY-MM-DD.jsonl`
  - 支持按时间范围、agent、工具名、文件路径查询
  - 支持压缩：超过 30 天的记录自动归档
- [ ] **CT3** 变更查询 skill — `.claude/skills/change-query/SKILL.md`
  - 提供 `change_query` skill，让 agent 可以查询历史变更
  - 支持查询模式：
    - 最近 N 小时的变更
    - 某个文件的修改历史
    - 某个 agent 的操作记录
    - 某个工具的调用统计
  - 输出格式：markdown 表格，含时间、agent、工具、文件、摘要
- [ ] **CT4** 变更摘要生成 — 定期（每小时/每天）生成变更摘要，存入 episodic memory
  - 摘要包含：修改了哪些文件、哪些模块、主要变更点
  - 用于 agent 快速了解项目近期动态
- [ ] **CT5** 新会话提示词注入 — 在 agent 系统提示中添加变更查询指引
  - "除了查看 git commit 历史，你还可以调用 change_query skill 获取详细的 agent 变更记录"
  - "变更记录包含每个 agent 的工具调用、修改的文件、执行时间等详细信息"
- [ ] **CT6** 变更追踪测试（10+ tests：hook 触发、存储查询、摘要生成、skill 接口）

## Phase 10.2: Agent Eval 评测系统（EV）

> 引入业界主流 agent 评测集，建立标准化评测流程，量化 agent 能力。
> 评测维度：工具使用准确性、多步推理、代码生成、信息检索、任务完成率。

- [ ] **EV1** 评测框架 — `packages/harness/src/eval/harness.ts`
  - 评测流程：加载 case → 执行 agent → 收集结果 → 评分 → 生成报告
  - 支持配置：超时、重试、并发数、评测集路径
  - 评测结果格式：`EvalResult { caseId, status, score, duration, toolCalls[], error? }`
- [ ] **EV2** GAIA 评测集集成 — `packages/harness/src/eval/runners/gaia-runner.ts`
  - GAIA (General AI Assistants)：466 个问题，3 个难度级别
  - L1：单步任务（简单工具调用）
  - L2：多步任务（需要组合多个工具）
  - L3：复杂任务（需要多轮推理 + 工具使用）
  - 评测指标：pass rate、avg steps、avg cost
- [ ] **EV3** SWE-bench 评测集集成 — `packages/harness/src/eval/runners/swe-bench-runner.ts`
  - SWE-bench：2294 个 GitHub issue，评测代码修复能力
  - 评测流程：读 issue → 定位代码 → 生成 patch → 验证测试通过
  - 评测指标：pass rate、patch accuracy、test pass rate
- [ ] **EV4** ToolBench 评测集集成 — `packages/harness/src/eval/runners/toolbench-runner.ts`
  - ToolBench：16464 个任务，评测工具使用能力
  - 评测维度：API 调用准确性、参数正确性、多步工具链
  - 评测指标：tool accuracy、pass rate、avg API calls
- [ ] **EV5** 自建评测集 — `packages/harness/src/eval/cases/vera-custom.json`
  - 针对 Vera 特有能力的 custom benchmark cases
  - 覆盖：checkpoint/resume、self-loop、critic agent、failure recovery、memory
  - 至少 20 个 case，覆盖核心功能
- [ ] **EV6** 评测报告生成 — `packages/harness/src/eval/reporter.ts`
  - 报告格式：markdown，含总分、分维度得分、失败 case 分析
  - 支持对比：不同模型/配置的评测结果对比
  - 输出到 `docs/eval-reports/<date>-<model>.md`
- [ ] **EV7** 回归检测 — 代码变更后自动跑评测，检测退化
  - 集成到 CI：PR 合并前自动跑 GAIA L1
  - 退化阈值：pass rate 下降 > 5% 则阻断
- [ ] **EV8** Agent Eval 测试（10+ tests：框架流程、case 加载、评分逻辑、报告生成）

## Phase 10.3: Skill 预训练（SP — Skill Pre-training）

> 引入微软 SkillOpt 框架，实现 skill 自动训练与优化。
> SkillOpt 像训练神经网络一样训练 agent skills — 使用 epochs、batch size、learning rates、validation gates。
> 训练出的最优 skill（best_skill.md）可直接导入为 Vera skill。

- [ ] **SP1** SkillOpt 集成层 — `packages/harness/src/training/skill-opt-adapter.ts`
  - 将 SkillOpt 作为外部 Python 工具集成
  - 封装 `train.py` 和 `eval_only.py` 的调用接口
  - 支持配置：optimizer_model、target_model、num_epochs、batch_size、workers
  - 支持多种 LLM：Azure OpenAI、OpenAI、Anthropic、Qwen
- [ ] **SP2** 数据准备 — `packages/harness/src/training/data-preparer.ts`
  - 将 Vera 的任务/评测数据转换为 SkillOpt 格式
  - 支持的数据格式：SearchQA、ALFWorld、DocVQA、LiveMathematicianBench、OfficeQA
  - 生成 train/val/test split 目录结构
- [ ] **SP3** 训练流程 — `packages/harness/src/training/trainer.ts`
  - 调用 SkillOpt 进行 skill 训练
  - 支持断点续训：从 runtime_state.json 恢复
  - 训练监控：实时获取 loss、accuracy、best_skill 更新
  - 输出结构：outputs/<run_name>/（best_skill.md、history.json、config.json）
- [ ] **SP4** 评测集成 — `packages/harness/src/training/eval-runner.ts`
  - 使用 SkillOpt 的评测集评估 Vera 能力
  - 支持评测模式：valid_unseen（测试集）、valid_seen（验证集）、train（训练集）、all（全部）
  - 评测指标：pass rate、accuracy、avg steps
- [ ] **SP5** Skill 导入 — `packages/harness/src/training/skill-importer.ts`
  - 将训练出的 best_skill.md 导入为 Vera skill
  - 自动生成 SKILL.md 元数据（名称、描述、用法）
  - 支持版本管理：每次训练生成新版本
  - 支持 A/B 对比：对比新旧 skill 的效果
- [ ] **SP6** WebUI 集成 — 可选的训练监控面板
  - 基于 SkillOpt 的 Gradio WebUI
  - 实时显示训练进度、loss 曲线、best_skill 更新
  - 支持远程访问（`--share` 模式）
- [ ] **SP7** Skill 预训练测试（8+ tests：数据转换、训练流程、skill 导入、版本管理）

## Phase 11: Benchmark 评测系统（P2 核心）

- [ ] **B1** Benchmark Harness — `packages/harness/src/benchmark/harness.ts`，case 加载 + agent 执行 + 评估
- [ ] **B2** 评估器增强 — 在 evaluator.ts 基础上增加 llm_judge / tool_match / semantic_similarity
- [ ] **B3** GAIA L1 集成 — 导入 GAIA 评测集，自动跑分
- [ ] **B4** 自建评测集 — 针对 Vera 特有能力的 custom benchmark cases
- [ ] **B5** 报告生成 — 自动产出 benchmark 报告（pass rate、tool accuracy、flaky rate）
- [ ] **B6** 回归检测 — 代码变更后自动跑 benchmark，检测退化
- [ ] **B7** Benchmark 测试（8+ tests）

## Phase 12: Dreaming 系统（P2 核心）

- [ ] **DR1** Dreaming Runner — `packages/harness/src/dreaming/runner.ts`，异步触发
- [ ] **DR2** 经验提炼 — 从 episodic memory + benchmark failure 中提取高价值洞察
- [ ] **DR3** 改进建议生成 — 产出 prompt/tool policy/workflow 改进 Proposal
- [ ] **DR4** Dreaming 调度 — 空闲时自动触发，不干扰正常任务
- [ ] **DR5** Dreaming 测试（6+ tests：提炼质量、建议可执行性）

## Phase 13: Proposal Pipeline（P2 核心）

- [ ] **PP1** Proposal 存储 — 结构化存储改进提案（prompt/tool/workflow）
- [ ] **PP2** 人工审核接口 — Proposal 标记 approved/rejected/deferred
- [ ] **PP3** 小流量 Rollout — approved Proposal 在限定范围内自动生效
- [ ] **PP4** 效果验证 — Rollout 后自动跑 benchmark 验证改进是否有效
- [ ] **PP5** 回滚机制 — 效果不达预期时自动回滚
- [ ] **PP6** Proposal Pipeline 测试（8+ tests）

## Phase 14: MCP Client 支持（P3）

- [ ] **MC1** MCP Client — `packages/core/src/mcp/client.ts`，连接第三方 MCP server
- [ ] **MC2** MCP Tool 统一 — MCP tool 自动注册到 ToolRegistry，统一 schema
- [ ] **MC3** MCP 权限治理 — MCP tool 走 SecurityPlugin hook，不绕过 Harness
- [ ] **MC4** MCP 发现 — 支持动态发现和连接 MCP server
- [ ] **MC5** MCP 集成测试（8+ tests：连接、tool 注册、权限、断线重连）

## Phase 15: 多 Agent 协作网络（P3）

- [ ] **MN1** 消息总线 — `packages/core/src/network/message-bus.ts`，跨 agent 通信
- [ ] **MN2** 任务调度 — 分布式任务分配与负载均衡
- [ ] **MN3** 共享记忆 — 多 agent 共享 semantic memory 层
- [ ] **MN4** 权限继承 — 跨 agent 权限传递与隔离
- [ ] **MN5** 协作网络测试（8+ tests）

## Phase 16: Channel 接入（多平台消息，参考 Hermes/OpenClaw Gateway 架构）

> 设计参考：Hermes Agent（Telegram/Discord/Slack/WhatsApp/Teams 单网关）、OpenClaw（25+ channel 本地 Gateway）
> 核心思想：一个 Gateway 统一接入所有平台，Channel 通过 Adapter 插件化

- [ ] **CH1** Channel 抽象层 — `packages/core/src/channel/types.ts`，定义 `ChannelAdapter` 接口
  - 接口：`connect()` / `disconnect()` / `sendMessage()` / `onMessage(callback)` / `getHistory()`
  - 消息统一格式：`ChannelMessage { id, channelType, senderId, content, attachments[], replyTo?, timestamp }`
- [ ] **CH2** Channel Gateway — `packages/core/src/channel/gateway.ts`，统一管理多 channel 生命周期
  - 多 channel 并发连接、消息路由、session 绑定
- [ ] **CH3** CLI Channel — 命令行交互（已有 REPL，补全 CLI 非交互模式 + pipe 模式）
- [ ] **CH4** API Channel — REST/WebSocket API，支持外部系统集成
- [ ] **CH5** Webhook Channel — HTTP webhook 接收器，支持签名验证
- [ ] **CH6** Channel 插件注册 — 运行时动态加载/卸载 channel adapter
- [ ] **CH7** Channel 测试（8+ tests：Gateway 生命周期、消息路由、多 channel 并发）

### 预留 Channel 插件（框架就绪后社区可扩展）

- [ ] **CH-FEISHU** 飞书 Channel — 飞书机器人消息接收/发送（参考 OpenClaw 飞书集成）
- [ ] **CH-WECOM** 企业微信 Channel
- [ ] **CH-TELEGRAM** Telegram Bot Channel
- [ ] **CH-DISCORD** Discord Bot Channel
- [ ] **CH-SLACK** Slack App Channel
- [ ] **CH-WHATSAPP** WhatsApp Business API Channel

## Phase 17: 自适应策略系统（P3）

- [ ] **AD1** 策略仓库 — 按任务域存储 prompt/model/tool policy 配置
- [ ] **AD2** 历史成功率统计 — 每个策略记录 pass/fail，自动计算成功率
- [ ] **AD3** 自动调优 — 基于历史数据自动选择最优策略组合
- [ ] **AD4** A/B 测试 — 不同策略并行对比，数据驱动决策
- [ ] **AD5** 自适应测试（6+ tests）

## Phase 18: Computer Use（浏览器 + 桌面自动化）

> 方案研究：Mac 上可用 Playwright（浏览器）、AppleScript/osascript（桌面）、Accessibility API（GUI 操作）
> 目标：agent 能操作浏览器和桌面应用，完成多步任务

### 18A: 浏览器自动化

- [ ] **CU1** Playwright 集成 — `packages/core/src/tools/browser.ts`，封装 Playwright 为 tool
  - 支持：navigate / click / type / screenshot / evaluate / waitForSelector
  - headless 模式（默认）+ headed 模式（调试用）
- [ ] **CU2** CDP 协议支持 — 连接已有 Chrome 实例（调试场景）
- [ ] **CU3** 浏览器 Session 管理 — cookie 持久化、多 tab 管理
- [ ] **CU4** 浏览器工具测试（8+ tests：导航、点击、截图、表单填写）

### 18B: 桌面操作（Mac）

- [ ] **CU5** 截图工具 — `screencapture` 命令封装，支持全屏/窗口/区域截图
- [ ] **CU6** 鼠标键盘模拟 — 通过 osascript / cliclick 实现点击、输入、快捷键
- [ ] **CU7** AppleScript 执行 — 封装 osascript，支持操作 Finder/Safari/Terminal 等
- [ ] **CU8** Accessibility API — 通过 `osascript -l JavaScript` 访问 UI 元素（识别按钮/输入框/文本）
- [ ] **CU9** 桌面操作测试（6+ tests：截图、点击、AppleScript 执行）

### 18C: Computer Use 工具集成

- [ ] **CU10** `computer_use` 元工具 — 统一入口，自动选择浏览器/桌面/CLI 子工具
- [ ] **CU11** 视觉理解 — 截图后送 LLM 分析，生成下一步操作建议
- [ ] **CU12** 多步操作编排 — 支持 "打开网站 → 登录 → 下载文件 → 解析" 等复合任务
- [ ] **CU13** 操作回放 — 记录操作序列，支持重放和调试
- [ ] **CU14** Computer Use E2E 测试（5+ tests：浏览器任务、桌面任务、复合任务）

### 18D: WebArena 评测

- [ ] **CU15** WebArena 集成 — 导入评测集，自动跑分
- [ ] **CU16** 评测报告 — pass rate、步骤效率、截图对比

## Phase 19: Sandbox 沙箱集成（蜂群模式，极高产能）

> 方案：CubeSandbox（腾讯开源，Apache 2.0，microVM 隔离，E2B 兼容）
> 核心思想：文件在本地，沙箱读取工作并产出结果，多个沙箱并发（蜂群模式）

### 19A: Sandbox 抽象层

- [ ] **SB1** Sandbox 接口 — `packages/core/src/sandbox/types.ts`，定义 `SandboxProvider` 接口
  - 接口：`create()` / `exec()` / `upload()` / `download()` / `destroy()` / `list()`
  - 沙箱生命周期：创建 → 上传文件 → 执行命令 → 下载产物 → 销毁
- [ ] **SB2** CubeSandbox 适配器 — `packages/core/src/sandbox/cubesandbox.ts`，对接 CubeSandbox API
- [ ] **SB3** 本地 Docker 适配器 — `packages/core/src/sandbox/docker.ts`，本地 Docker 容器作为沙箱（开发/测试用）
- [ ] **SB4** Sandbox 工具 — `sandbox_exec` / `sandbox_upload` / `sandbox_download` tool，注册到 ToolRegistry

### 19B: 蜂群模式（Swarm）

- [ ] **SB5** Swarm 调度器 — `packages/harness/src/swarm/scheduler.ts`，管理多个并发沙箱
  - 任务队列 → 分配到空闲沙箱 → 并发执行 → 收集结果 → 汇总
- [ ] **SB6** 任务拆分 — 自动将大任务拆分为可并行的子任务
- [ ] **SB7** 结果合并 — 多个沙箱的结果自动合并（文件合并、报告汇总）
- [ ] **SB8** 产能控制 — 可配置最大并发数、总预算、超时策略
- [ ] **SB9** 蜂群模式测试（8+ tests：并发执行、任务拆分、结果合并、产能限制）

### 19C: Sandbox 集成测试

- [ ] **SB10** CubeSandbox E2E — 真实沙箱创建/执行/销毁全流程
- [ ] **SB11** Docker 本地沙箱 E2E
- [ ] **SB12** 蜂群压力测试 — 10 个并发沙箱执行同一任务

## Phase 19.5: 存储插件（OSS/S3/TOS）

- [ ] **SP1** 存储插件接口 — `packages/core/src/storage/object-store.ts`，定义 `ObjectStore` 接口
  - 接口：`put()` / `get()` / `delete()` / `list()` / `presignUrl()`
- [ ] **SP2** 阿里云 OSS 适配器 — `packages/core/src/storage/oss-adapter.ts`
- [ ] **SP3** AWS S3 适配器 — `packages/core/src/storage/s3-adapter.ts`（兼容 MinIO）
- [ ] **SP4** 腾讯 TOS 适配器 — `packages/core/src/storage/tos-adapter.ts`
- [ ] **SP5** 本地文件系统适配器 — `packages/core/src/storage/local-fs-adapter.ts`（开发/测试用）
- [ ] **SP6** 存储工具 — `file_upload` / `file_download` / `file_list` tool，注册到 ToolRegistry
- [ ] **SP7** 自动上传 — agent 产出的大文件（报告/数据集/截图）自动上传到对象存储
- [ ] **SP8** 存储插件测试（8+ tests：CRUD、presign URL、多适配器切换）

- [ ] **V1** 全量测试通过 — `pnpm test` 无 failure
- [ ] **V2** E2E 完整冒烟 — plan→self-loop→critique→replan→checkpoint→resume→memory→RAG
- [ ] **V3** 覆盖率检查 — core 包 ≥ 90%，harness 包 ≥ 85%
- [ ] **V4** Benchmark 报告 — GAIA L1 pass rate ≥ 70%
- [ ] **V5** 最终 CHANGELOG + roadmap 同步 + 版本号 bump
- [ ] **V6** 发布准备 — settings.example.json 更新、README 更新、依赖检查

---

## Phase 20: OpenClacky 借鉴能力（从 openclacky 项目移植的关键设计）

> 源项目：https://github.com/clacky-ai/openclacky (Ruby)
> 以下能力经分析后认为值得借鉴到 OpenVera TypeScript 实现中

### 20A: Insert-then-Compress 策略（缓存友好压缩）

- [ ] **OC1** 压缩指令注入 — 不单独调 API 压缩，而是在当前对话流中插入压缩指令消息，复用已有 cache
- [ ] **OC2** 压缩后只重建一次 cache — 对比旧方案（两次 cache rebuild），节省 ~50% 冷启动成本
- [ ] **OC3** `<topics>` + `<summary>` 结构化压缩输出 — 压缩结果带 topics 标签，支持后续检索
- [ ] **OC4** 压缩集成测试（5+ tests：缓存命中、压缩质量、topics 提取）

### 20B: 空闲自动压缩（IdleCompressionTimer）

- [ ] **OC5** IdleCompressionTimer — agent 空闲 314 秒后自动触发压缩（低于 5 分钟 cache TTL）
- [ ] **OC6** 压缩可中断 — 新用户输入到达时取消正在进行的压缩，确保 history 一致性
- [ ] **OC7** 压缩结果持久化 — 压缩完成后自动 save session
- [ ] **OC8** 空闲压缩测试（5+ tests：定时触发、中断、并发安全）

### 20C: Memory 自动更新（子 agent 异步更新）

- [ ] **OC9** MemoryUpdater 子 agent — 任务完成后 fork 子 agent 更新长期记忆（≥10 轮迭代才触发）
- [ ] **OC10** 记忆合并策略 — LLM 决定哪些 topic 需要更新、如何与已有记忆合并、哪些需要丢弃
- [ ] **OC11** 记忆文件按 topic 组织 — `~/.vera/memories/{topic}.md`，每个文件有 token 上限
- [ ] **OC12** 记忆更新测试（5+ tests：触发条件、合并质量、token 限制）

### 20D: Skill 自动创建与反思进化

- [ ] **OC13** SkillAutoCreator — 从复杂任务中自动提取可复用 skill 模板（非 skill 执行场景，≥N 轮迭代）
- [ ] **OC14** SkillReflector — skill 执行后自动反思：指令是否清晰？边界 case 是否覆盖？
- [ ] **OC15** Skill 版本更新 — 反思发现改进时自动更新 SKILL.md（版本号递增）
- [ ] **OC16** 跳过系统 skill — default/brand skill 不允许自动进化，只进化用户自定义 skill
- [ ] **OC17** Skill 进化测试（6+ tests：自动创建准确性、反思质量、版本管理）

### 20E: Time Machine（任务级 undo/redo）

- [ ] **OC18** TaskSnapshot — 每个 task 完成后保存修改文件的快照（AFTER 状态）
- [ ] **OC19** Undo — 回滚到指定 task 的文件状态
- [ ] **OC20** Redo — 从 undo 状态恢复
- [ ] **OC21** Time Machine 测试（5+ tests：快照、回滚、redo、跨 task）

### 20F: invoke_skill 元工具

- [ ] **OC22** invoke_skill tool — 单一元工具调用所有 skill，减少 ToolRegistry 工具数量
- [ ] **OC23** Skill 参数透传 — 支持 argument-hint 解析和透传
- [ ] **OC24** invoke_skill 测试（4+ tests：调用、参数、错误处理）

---

## 执行规则

1. 按 Phase 顺序执行，每 Phase 内按编号顺序
2. 每完成一项立即勾选 checkbox
3. 每完成一个 Phase 运行一次全量测试确认无 regression
4. Phase 1-5 是 P1 核心（自循环），Phase 6-8 是能力增强，Phase 9-10 是数据层/RAG，Phase 11-13 是 P2（自我进化），Phase 14-18 是 P3（通用平台），Phase 19 是 Sandbox 蜂群，Phase 19.5 是存储插件，Phase 20 是 OpenClacky 借鉴
5. 定时任务使用主模型运行

## 行业对标

本计划覆盖的行业主流 agent 能力：

| 能力 | 对标框架 |
|------|----------|
| Self-Loop Runtime | LangGraph (Plan-Act-Observe loop), CrewAI (autonomous crew) |
| Critic Agent | AutoGen (critic agent pattern), MetaGPT (reviewer role) |
| Memory 自动提取/压缩 | MemGPT (tiered memory), Letta (memory management) |
| RAG 知识库 | LlamaIndex, Haystack, LangChain RAG |
| SQLite + 用户数据存储 | Claude Code (session storage), Cursor (local DB) |
| Skill 自动提取/进化 | **OpenClacky** (skill_evolution + skill_reflector), OpenClaw |
| Insert-then-Compress | **OpenClacky** (缓存友好压缩，节省 50% 冷启动) |
| Idle 自动压缩 | **OpenClacky** (IdleCompressionTimer, 314s 空闲触发) |
| Memory 子 agent 更新 | **OpenClacky** (MemoryUpdater, fork subagent 异步更新) |
| Time Machine undo/redo | **OpenClacky** (TaskSnapshot + 文件级回滚) |
| Sandbox 蜂群 | **CubeSandbox** (腾讯开源，microVM 隔离)，E2B |
| OSS/S3/TOS 存储 | 阿里云 OSS SDK, AWS S3 SDK, 腾讯 TOS SDK |
| Channel 网关 | **Hermes** (Telegram/Discord/Slack/WhatsApp/Teams)，**OpenClaw** (25+ channel) |
| Computer Use | Anthropic Computer Use, OpenAI Operator, Playwright |
| Benchmark | GAIA, SWE-bench, AgentBench, WebArena |
| Dreaming/Proposal | Voyager (skill library self-improve), SPRING (reflection) |
| MCP | Anthropic MCP protocol, OpenAI function calling |
