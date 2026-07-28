# Vera — 项目约束

## 敏感文件保护

以下文件/目录包含本地密钥或临时数据，**任何情况下都不得提交**：

| 路径 | 原因 |
|---|---|
| `.vera/settings.json` | LLM API Key，已 gitignore |
| `.qwen/` | Qwen 本地配置，已 gitignore |
| `.Codex/settings.local.json` | Codex 本地设置，已 gitignore |
| `.Codex/worktrees/` | 临时 worktree，已 gitignore |
| `.gemini/` | Gemini 本地配置，已 gitignore |
| `*.orig` | 合并/备份临时文件 |

**规则：**
- 提交前检查 `git status`，确认上述文件不在 staged 中
- 不要 `git add .` 或 `git add -A` 无脑全加，按文件/目录选择性添加
- 如果 `git status` 显示上述文件有修改，用 `git restore` 丢弃或保持 unstaged
- 写 `.vera/settings.json` 时永远用 `settings.example.json` 的占位符，不要填入真实 Key
- 永远不要在 AGENTS.md、README、代码注释、commit message 中粘贴 API Key

## 项目架构

Vera = Harness 为内核的 agent runtime。两层结构：

- **Core** (`packages/core`)：单次 LLM 调用闭环。adapter → loop → tool → result。不感知 Harness。
- **Harness** (`packages/harness`)：多步 workflow。ExecutionPlan 状态机 → Flow State → Critique → Replan。依赖 Core。

依赖方向：`harness → core`，Core 不可 import Harness。

## 技术栈

- TypeScript ESM（`module: "nodenext"`）
- pnpm workspace monorepo
- React + Ink（REPL UI）
- 默认 LLM adapter：Anthropic Codex API

## 提交风格

- 英文 commit message
- `feat:` / `fix:` / `docs:` / `chore:` 前缀
- 单次提交聚焦一个功能模块

## 文档

- 入口：`docs/README.md`
- 路线图：`docs/roadmap.md`
- 变更日志：`docs/changelog.md`（入口索引）+ `docs/changelog/<YYYY-MM-DD-HH>.md`（详细）
- 当前 P0 进度：全部完成 ✅（intent routing / tool runtime / rendering / session / infinite context / plan mode / critique / flow control）

## 提交前检查清单

提交代码前必须按顺序完成以下步骤：

### 1. 测试与质量

- **覆盖率 ≥ 90%**：运行 `pnpm --filter @vera/core run test:coverage`，确认 lines 覆盖率不低于 90%
- **无 error 级别质量问题**：运行 `bash .Codex/skills/quality-scan/scan.sh`，oxlint / sonarjs 不允许任何 `error` 级别发现（warning 可接受）
- 新增业务逻辑必须有对应 unit test；纯类型定义、配置文件、文档除外

### 2. Roadmap 同步

- 本次提交完成了 roadmap 中的某项能力 → 在 `docs/roadmap.md` 对应条目标记 ✅
- 发现新的遗留问题或技术债 → 追加到 roadmap 的"已知缺陷与技术债"或"P0 后对齐项"对应分区

### 3. Changelog 更新

- 在 `docs/changelog.md` 索引表追加一行（`YYYY-MM-DD · HH:xx` + 一句话摘要 + 链接）
- 在 `docs/changelog/<YYYY-MM-DD-HH>.md` 写入本批次详细记录，格式：
  - **变更**：commit 表格（hash / 模块 / 内容）
  - **Roadmap 同步**：标记了哪些条目
  - **遗留事项**：本次未完成、已知待修复的问题

## Skills 维护规则

项目 skills 位于 `.Codex/skills/`，索引文档为 `.Codex/skills/README.md`。

**每次新增或修改 skill 后，必须同步更新 `.Codex/skills/README.md`**，包括：
- 新增：在对应分类下追加条目（名称、描述、数据源、输出路径、用法示例）
- 修改：更新受影响的描述或参数说明
- 删除：移除对应条目并标注废弃原因（若有替代品）

当前 skills：`agent-changes-report` · `Codex-session-review` · `cursor-session-review` · `quality-scan`

## 开发规范与代码治理

### 模块划分原则

- **Core**（`packages/core`）：无状态、单次 LLM 调用闭环。不感知 Harness、Session、Flow。
- **Harness**（`packages/harness`）：有状态编排。Flow 状态机、Checkpoint、Critique、Self-Loop。
- **依赖方向**：`harness → core`，Core 永不 import Harness。违反即架构违规。

### 新模块创建规范

1. **先定义接口**（`types.ts`），再写实现。接口文件放在模块根目录。
2. **barrel export**：每个模块目录必须有 `index.ts`，统一导出公共 API。
3. **单一职责**：一个文件只做一件事。超过 300 行考虑拆分。
4. **命名规范**：
   - 文件名：`kebab-case.ts`（如 `self-loop.ts`、`vector-store.ts`）
   - 类型/接口：`PascalCase`（如 `SelfLoopRunner`、`VectorStore`）
   - 函数/变量：`camelCase`（如 `runSelfLoop`、`embeddingAdapter`）
   - 常量：`UPPER_SNAKE_CASE`（如 `MAX_CYCLES`、`DEFAULT_TIMEOUT`）

### 测试规范（强制）

- **无测试 = 未完成，不允许 commit。** 每项任务必须有对应测试用例。
- 测试文件与源文件同目录，放在 `tests/` 子目录下。
- 测试文件命名：`<module-name>.test.ts`
- 整体覆盖率 ≥ 70%，核心模块（`tools/` `storage/` `adapters/` `config/` `memory/` `context/` `utils/`）≥ 80%。
- 测试数量不卡死，按实际代码内容、分支覆盖、改动点来决定，确保所有关键路径都有覆盖。
- 测试用 Vitest，使用 `describe` / `it` / `expect`。
- Mock 仅用于外部 API 调用（LLM adapter、网络请求），不 mock 内部模块。
- E2E 测试放在 `packages/harness/tests/e2e-*.ts`。

### 代码风格

- TypeScript strict mode，禁止 `any`（用 `unknown` + 类型守卫）。
- 错误处理：使用类型化错误类（`packages/core/src/errors.ts`），不 `throw new Error(string)`。
- 异步：优先 `async/await`，避免 raw Promise 链。
- 注释：仅在 WHY 不明显时写注释，不写 WHAT 注释。
- 导入：使用 `.js` 后缀（ESM 要求），按 external → internal → relative 排序。

### 提交约束

- 单次提交聚焦一个模块，不超过 500 行 diff（文档/测试除外）。
- commit message 格式：`<type>(<scope>): <description>`
  - type: `feat` / `fix` / `refactor` / `test` / `docs` / `chore`
  - scope: `core` / `harness` / `tool` / `agent` / `memory` / `rag` / `sandbox` / `channel` 等
- 示例：`feat(memory): add auto-extraction from agent execution`

### 架构约束（硬性）

- Core 包不依赖 harness 包（`tsconfig` 已配置，违反会编译报错）。
- 新增外部依赖需在 PR 中说明理由，优先使用已有依赖。
- 存储层抽象接口化：所有持久化通过接口（`VectorStore`、`SessionStore`、`MemoryStore`），不硬编码具体实现。
- Sandbox 隔离：所有外部代码执行必须通过 Sandbox 抽象层，禁止直接 `child_process.exec` 用户代码。
- Channel 抽象：所有消息平台通过 `ChannelAdapter` 接口接入，不直接调用平台 SDK。

## Agent 工作流程（强制）

### 开始编码前

1. **读取 `docs/changelog.md`** — 了解最近变更，避免重复工作或踩同样的坑
2. **读取 `P1-IMPLEMENTATION-PLAN.md`** — 找到下一个未完成的 checkbox 任务
3. **读取 `P0-IMPROVEMENT-PLAN.md`** — 检查是否有遗留修复项

### 编码过程中

4. 每完成一项任务，立即勾选对应 checkbox
5. 每完成一个 Phase 或重要变更，运行 `pnpm --filter @open-vera/core build && pnpm test` 确认无 regression
6. 测试通过后 git commit，message 格式：`<type>(<scope>): <description>`

### 编码完成后

7. **更新 `docs/changelog.md`** — 追加本批次摘要行
8. **创建 `docs/changelog/<YYYY-MM-DD-HH>.md`** — 详细记录 commit 表格、Roadmap 同步、遗留事项
9. **更新 roadmap** — 在 `docs/roadmap.md` 标记已完成的条目

> **重要**：不读 changelog 就开始编码 = 违反项目规范。

### 并行开发策略（效率优先）

当一个 Phase 内有多个独立任务时，**必须使用并行子 agent** 开发：

1. **规划阶段**：主 agent 读取 P1-IMPLEMENTATION-PLAN.md，识别当前 Phase 内可并行的任务
2. **拆分阶段**：按依赖关系分组 — 无依赖的任务可并行，有依赖的串行
3. **并行执行**：用 Agent 工具同时启动多个子 agent，每个负责一个独立任务
4. **汇总合并**：所有子 agent 完成后，主 agent 合并代码、解决冲突、运行全量测试
5. **提交**：测试通过后统一提交，更新 changelog

**并行判断标准**：
- 修改不同文件 → 可并行
- 修改同一文件的不同函数 → 可并行（需手动合并）
- 修改同一文件的同一函数 → 必须串行
- 有数据依赖（A 的输出是 B 的输入）→ 必须串行

**示例**：Phase 1 的 S1-S3（SelfLoopRunner 骨架）和 Phase 2 的 CR1-CR2（CriticAgent 骨架）可以并行开发，因为它们修改不同的文件。
