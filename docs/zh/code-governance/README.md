# 代码治理规范

> OpenVera 项目的代码约定、质量标准和提交流程。所有贡献者必须遵守。

---

## 项目架构约束

### Core 与 Harness 边界（硬性）

Vera 采用两层架构，依赖方向严格单向：

| 包 | 职责 | 依赖规则 |
|---|---|---|
| `@vera/core` (`packages/core`) | 无状态、单次 LLM 调用闭环。adapter -> loop -> tool -> result。不感知 Harness、Session、Flow。 | 不可 import `@vera/harness`（tsconfig 已配置，违反即编译报错） |
| `@vera/harness` (`packages/harness`) | 有状态编排。Flow 状态机、Checkpoint、Critique、Self-Loop。依赖 Core。 | 可 import `@vera/core` |

### 其他架构约束

- **存储层抽象接口化**：所有持久化通过接口（`VectorStore`、`SessionStore`、`MemoryStore`），不硬编码具体实现。
- **Sandbox 隔离**：所有外部代码执行必须通过 Sandbox 抽象层，禁止直接 `child_process.exec` 用户代码。
- **Channel 抽象**：所有消息平台通过 `ChannelAdapter` 接口接入，不直接调用平台 SDK。
- **新增外部依赖需在 PR 中说明理由**，优先使用已有依赖。

---

## 模块与文件规范

### 新模块创建规范

1. **先定义接口**（`types.ts`），再写实现。接口文件放在模块根目录。
2. **barrel export**：每个模块目录必须有 `index.ts`，统一导出公共 API。
3. **单一职责**：一个文件只做一件事。超过 300 行考虑拆分。

### 命名规范

| 类别 | 风格 | 示例 |
|---|---|---|
| 文件名 | `kebab-case.ts` | `self-loop.ts`、`vector-store.ts`、`intent-router.ts` |
| 类型/接口 | `PascalCase` | `SelfLoopRunner`、`VectorStore`、`ExecutionPlan` |
| 函数/变量 | `camelCase` | `runSelfLoop`、`embeddingAdapter`、`resolveTarget` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_CYCLES`、`DEFAULT_TIMEOUT`、`READONLY_TOOLS` |

### 导入顺序

使用 `.js` 后缀（ESM 要求），按以下顺序排列：

1. Node.js 内置模块
2. 外部依赖（npm 包）
3. 内部包（`@vera/core`、`@vera/harness`）
4. 相对路径导入

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";
```

---

## TypeScript 规范

### strict mode（强制）

项目启用 TypeScript strict mode。所有代码必须通过严格类型检查。

### 禁止 `any`

使用 `unknown` + 类型守卫替代 `any`：

```typescript
// 禁止
function process(data: any) { ... }

// 正确
function process(data: unknown) {
  if (typeof data === "string") {
    // data 缩窄为 string
  }
}
```

### 错误处理

使用类型化错误类，定义在 `packages/core/src/errors.ts`。不 `throw new Error(string)`：

```typescript
// 禁止
throw new Error("something went wrong");

// 正确
throw new AdapterError("ADAPTER_NO_LISTMODELS", "listModels not supported for this adapter");
```

### 异步

优先 `async/await`，避免 raw Promise 链：

```typescript
// 推荐
const data = await fetchData();
const result = await process(data);
return result;

// 避免
return fetchData().then(data => process(data));
```

### 注释原则

- 仅在 **WHY 不明显**时写注释，不写 WHAT 注释
- WHAT 由代码本身和类型签名表达
- 复杂算法的关键步骤可以加简短注释

---

## 提交规范

### Commit Message 格式

```bash
<type>(<scope>): <description>
```

| 组成部分 | 说明 | 可选值 |
|---|---|---|
| `type` | 变更类型 | `feat` / `fix` / `refactor` / `test` / `docs` / `chore` |
| `scope` | 影响范围 | `core` / `harness` / `tool` / `agent` / `memory` / `rag` / `sandbox` / `channel` 等 |
| `description` | 简要说明 | 英文，现在时，首字母小写，不加句号 |

示例：

```
feat(memory): add auto-extraction from agent execution
fix(core): preserve provider model fallback behavior
refactor(agent): extract shared context to separate module
test(harness): add e2e tests for self-loop termination
docs(core): add CLI reference documentation
chore(deps): bump vitest to 2.x
```

### 提交约束

- 单次提交聚焦一个模块，不超过 500 行 diff（文档/测试除外）
- 英文 commit message
- 禁止提交敏感文件（见下方敏感文件保护）

### 敏感文件保护

以下文件/目录包含本地密钥或临时数据，**任何情况下都不得提交**：

| 路径 | 原因 |
|---|---|
| `.vera/settings.json` | LLM API Key，已 gitignore |
| `.qwen/` | Qwen 本地配置，已 gitignore |
| `.claude/settings.local.json` | Claude Code 本地设置，已 gitignore |
| `.claude/worktrees/` | 临时 worktree，已 gitignore |
| `.gemini/` | Gemini 本地配置，已 gitignore |
| `*.orig` | 合并/备份临时文件 |

规则：
- 提交前检查 `git status`，确认上述文件不在 staged 中
- 不要 `git add .` 或 `git add -A` 无脑全加，按文件/目录选择性添加
- 写 `.vera/settings.json` 时永远用 `settings.example.json` 的占位符，不要填入真实 Key
- 永远不要在 CLAUDE.md、README、代码注释、commit message 中粘贴 API Key

---

## 测试规范（强制）

### 覆盖率要求

- 整体覆盖率 **>= 90%**（运行 `pnpm --filter @vera/core run test:coverage`）
- 核心模块（`tools/` `storage/` `adapters/` `config/` `memory/` `context/` `utils/`）>= 80%

### 测试规则

| 规则 | 说明 |
|---|---|
| 测试框架 | Vitest，使用 `describe` / `it` / `expect` |
| 文件位置 | 源文件同目录的 `tests/` 子目录 |
| 文件命名 | `<module-name>.test.ts` |
| Mock 范围 | 仅用于外部 API 调用（LLM adapter、网络请求），不 mock 内部模块 |
| E2E 测试 | 放在 `packages/harness/tests/e2e-*.ts` |
| 无测试 | **= 未完成，不允许 commit** |

### 测试覆盖原则

- 新增业务逻辑必须有对应 unit test
- 纯类型定义、配置文件、文档除外
- 测试数量不卡死，按实际代码内容、分支覆盖、改动点来决定
- 确保所有关键路径都有覆盖

---

## 提交前检查清单

提交代码前必须按顺序完成以下步骤：

### 1. 测试与质量

- [ ] 运行 `pnpm --filter @vera/core run test:coverage`，确认 lines 覆盖率 >= 90%
- [ ] 运行 `bash .claude/skills/quality-scan/scan.sh`，oxlint / sonarjs 无 `error` 级别发现（warning 可接受）
- [ ] 新增业务逻辑有对应 unit test

### 2. Roadmap 同步

- [ ] 本次提交完成了 roadmap 中的某项能力 => 在 `docs/roadmap.md` 对应条目标记 checkbox
- [ ] 发现新的遗留问题或技术债 => 追加到 roadmap 的对应分区

### 3. Changelog 更新

- [ ] 在 `docs/changelog.md` 索引表追加一行（`YYYY-MM-DD · HH:xx` + 一句话摘要 + 链接）
- [ ] 在 `docs/changelog/<YYYY-MM-DD-HH>.md` 写入本批次详细记录：
  - **变更**：commit 表格
  - **Roadmap 同步**：标记了哪些条目
  - **遗留事项**：本次未完成、已知待修复的问题

### 4. PR 检查

- [ ] PR 标题简洁（< 70 字符），格式为 `<type>(<scope>): <description>`
- [ ] PR 描述包含 Summary（1-3 条）和 Test plan（checkbox 清单）
- [ ] 如果新增外部依赖，已在 PR 中说明理由
- [ ] Core 包没有 import `@vera/harness`

---

## 静态分析工具

项目使用三组独立工具并行扫描代码质量。详见 [static-analysis.md](./static-analysis.md)。

### 工具一览

| 工具 | 关注点 | 扫描速度 | 配置位置 |
|---|---|---|---|
| **oxlint** | 结构指标（文件长度、函数长度、圈复杂度、嵌套深度、参数数量） | ~0.1s | `.claude/skills/quality-scan/oxlint.config.json` |
| **ESLint + sonarjs** | 认知复杂度、重复函数、重复分支（纯 AST 分析，无类型检查） | ~3s | `.claude/skills/quality-scan/eslint.sonarjs.config.js` |
| **jscpd** | 跨文件重复代码检测（token 级别匹配） | ~4s | CLI 参数 |

三者完全并行执行，总耗时约 4 秒（三者中最大值）。

### 质量阈值

| 类别 | 指标 | warn | error |
|---|---|---|---|
| 文件 | 文件总行数 | 300 | 600 |
| 函数 | 函数体行数 | 50 | 100 |
| 复杂度 | 圈复杂度（分支数） | 10 | 20 |
| 嵌套 | 最深 block 层数 | 4 | 6 |
| 参数 | 函数参数数量 | 4 | 7 |
| 认知复杂度 | 阅读难度评分 | 15 | — |
| 重复 | 重复 token 块 | 50 tokens | — |

### 运行方式

```bash
# 全量扫描（通过 quality-scan skill）
/quality-scan

# 扫描指定包
/quality-scan packages/core

# 详细模式（列出每个违规位置）
/quality-scan --verbose
```

输出终端摘要 + 写入 `docs/code-governance/report-<date>.md`。

### 与日常 lint 的关系

| | 日常 `pnpm lint` | `quality-scan` |
|---|---|---|
| 目的 | 正确性、风格 | 结构复杂度、重复度 |
| 工具 | ESLint + typescript-eslint（类型检查） | oxlint + ESLint/sonarjs（无类型检查）+ jscpd |
| 触发时机 | 每次提交前 | 按需 / 定期 |
| 阻断构建 | 是（error 时） | 否（只报告） |

三份配置（`eslint.config.js` / `oxlint.config.json` / `eslint.sonarjs.config.js`）完全独立，互不干扰。

---

## Skills 维护规则

项目 skills 位于 `.claude/skills/`，索引文档为 `.claude/skills/README.md`。

**每次新增或修改 skill 后，必须同步更新 `.claude/skills/README.md`**：
- 新增：在对应分类下追加条目（名称、描述、数据源、输出路径、用法示例）
- 修改：更新受影响的描述或参数说明
- 删除：移除对应条目并标注废弃原因（若有替代品）

---

## 文档规范

| 文档 | 说明 |
|---|---|
| `docs/README.md` | 文档入口，含推荐阅读顺序 |
| `docs/roadmap.md` | 阶段路线图——P0/P1/P2/P3 以及已知技术债 |
| `docs/changelog.md` | 变更日志索引（入口） |
| `docs/changelog/<YYYY-MM-DD-HH>.md` | 单批次详细变更记录 |

---

## 技术栈

| 组件 | 技术 |
|---|---|
| 语言 | TypeScript ESM（`module: "nodenext"`） |
| 包管理 | pnpm workspace monorepo |
| REPL UI | React + Ink |
| 测试 | Vitest |
| 代码风格 | ESLint + typescript-eslint |
| 默认 LLM adapter | Anthropic Claude API |

---

## 常见问题

### Q: 什么时候需要创建新的 Agent 定义？

当你需要让 Vera 在特定领域有专业化的行为时。例如，为代码审查、测试分析、安全检查各自创建专门的 subagent。

### Q: Core 和 Harness 的边界如何判断？

简单判断：如果你的代码只涉及单次 LLM 调用、工具执行、结果返回，应该放 Core。如果涉及多步骤编排、状态转换、自我批判循环，应该放 Harness。

### Q: 什么情况下可以 mock 内部模块？

不可以。Mock 仅用于外部 API 调用（LLM adapter、网络请求）。测试应该验证内部模块的真实交互行为。
