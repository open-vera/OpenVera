# 代码治理规范

> Vera monorepo 强制性代码规范。违反标注"强制"的条目将导致 PR 被拒绝。

## 1. 模块划分（强制）

Vera 采用两层 pnpm workspace monorepo 结构：

| 包 | 职责 | 依赖方向 |
|---|---|---|
| `packages/core` | 单次 LLM 调用闭环，**无状态**。不感知 Harness、Session、Flow。 | 不依赖内部包 |
| `packages/harness` | 多步 workflow 编排，**有状态**。ExecutionPlan -> Flow State -> Critique -> Replan。 | `harness -> core` |

**硬性约束**：`harness -> core`，Core 永不 import Harness。`tsconfig` 已配置检测，违反编译报错。

模块内部组织：
1. **接口先行**：先定义 `types.ts`，再写实现。
2. **barrel export**：每个目录必须有 `index.ts`，只导出公共 API。
3. **单一职责**：一个文件只做一件事，超过 300 行考虑拆分。
4. **测试就近**：测试文件放 `tests/` 子目录。

## 2. 命名规范（强制）

| 类别 | 风格 | 示例 |
|---|---|---|
| 文件名 | `kebab-case.ts` | `self-loop.ts`、`vector-store.ts` |
| 类型 / 接口 | `PascalCase` | `SelfLoopRunner`、`VectorStore` |
| 函数 / 变量 | `camelCase` | `runSelfLoop`、`embeddingAdapter` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_CYCLES`、`DEFAULT_TIMEOUT` |
| 枚举成员 | `PascalCase` | `FlowStatus.Running` |
| 泛型参数 | 单字母大写 | `T`（通用）、`K`（键）、`V`（值） |

## 3. TypeScript 严格规则（强制）

- `tsconfig.json` 必须 `"strict": true`
- **禁止 `any`**：一律使用 `unknown` + 类型守卫替代
- **ESM 模块**（`"module": "nodenext"`）：导入路径必须带 `.js` 后缀

```typescript
// 错误
function parse(data: any): any { ... }

// 正确
function parse(data: unknown): ParsedResult {
  if (typeof data !== 'object' || data === null) {
    throw new ValidationError('expected object');
  }
  return data as ParsedResult;
}
```

## 4. 错误处理（强制）

**禁止 `throw new Error(string)`**，必须使用 `packages/core/src/errors.ts` 中定义的类型化错误类：

```typescript
// 错误
throw new Error('invalid state');

// 正确
import { ValidationError, StateError } from '../errors.js';
throw new ValidationError('FlowState requires at least one step');
```

## 5. 异步编程（强制）

优先 `async/await`，禁止 raw Promise 链（`.then().catch()`）：

```typescript
// 错误
function load(): Promise<Data> { return fetch().then(parse).catch(handle); }

// 正确
async function load(): Promise<Data> {
  try { return parse(await fetch()); }
  catch (err) { return handle(err); }
}
```

独立操作用 `Promise.all` 并发，有依赖的保持顺序 `await`。

## 6. 导入顺序（强制）

按 external -> internal -> relative 排列，组间空一行：

```typescript
import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

import { FlowRunner } from '@open-vera/core';

import { harnessConfig } from '../config.js';
import type { SessionStore } from './types.js';
```

## 7. 注释规范

- **只写 WHY，不写 WHAT**。代码本身说明做什么，注释解释为什么。
- 公共 API 使用 JSDoc 标注参数和返回值。
- 临时方案用 `// TODO(username): description`。

## 8. 提交格式（强制）

格式：**`<type>(<scope>): <description>`**

| type | 含义 | scope | 含义 |
|---|---|---|---|
| `feat` | 新功能 | `core` / `harness` | 核心包 |
| `fix` | 修复 | `tool` / `agent` | 工具/代理 |
| `refactor` | 重构 | `memory` / `rag` | 记忆/检索 |
| `test` | 测试 | `sandbox` / `channel` | 沙箱/通道 |
| `docs` | 文档 | — | — |
| `chore` | 杂项 | — | — |

约束：
- description 英文、小写开头、不加句号
- 单次提交聚焦一个模块，diff <= 500 行（文档/测试除外）
- 提交前检查 `git status`，禁止 `git add -A` 无脑全加

示例：`feat(memory): add auto-extraction from agent execution`

## 9. 测试规范（强制）

**无测试 = 未完成，不允许 commit。**

| 要求 | 说明 |
|---|---|
| 框架 | Vitest，使用 `describe` / `it` / `expect` |
| 文件命名 | `<module-name>.test.ts`，放 `tests/` 子目录 |
| 整体覆盖率 | >= 70% |
| 核心模块覆盖率 | >= 80%（`tools/` `storage/` `adapters/` `config/` `memory/` `context/` `utils/`） |
| Core 包 lines 覆盖率 | **>= 90%** |
| Mock 策略 | 仅 mock 外部 API（LLM adapter、网络），不 mock 内部模块 |
| E2E 测试 | 放在 `packages/harness/tests/e2e-*.ts` |

验证命令：

```bash
pnpm --filter @open-vera/core run test:coverage
```

## 10. PR 检查清单

### 代码质量
- [ ] 无 `any`（必要时用 `unknown` + 类型守卫）
- [ ] 错误处理使用类型化错误类
- [ ] 异步用 `async/await`，无 raw Promise 链
- [ ] 导入路径有 `.js` 后缀，顺序 external -> internal -> relative

### 测试与构建
- [ ] `pnpm --filter @open-vera/core run test:coverage` 覆盖率 >= 90%
- [ ] 新增业务逻辑有对应 unit test
- [ ] `pnpm typecheck` && `pnpm test` && Core build 全部通过

### 质量扫描
- [ ] `bash .claude/skills/quality-scan/scan.sh` 无 error

### 文档同步
- [ ] roadmap 完成条目标记 `✅`，新遗留项追加到对应分区
- [ ] `docs/changelog.md` 追加摘要，`docs/changelog/<YYYY-MM-DD-HH>.md` 写详细记录

### 安全检查
- [ ] `git status` 无敏感文件在 staged 中
- [ ] 无 API Key 残留、无冲突标记（`<<<<<<<` / `=======` / `>>>>>>>`）

## 11. 敏感文件保护（强制）

以下**任何情况下都不得提交**：

| 路径 | 原因 |
|---|---|
| `.vera/settings.json` | LLM API Key |
| `.qwen/` | Qwen 本地配置 |
| `.claude/settings.local.json` | Claude Code 本地设置 |
| `.claude/worktrees/` | 临时 worktree |
| `.gemini/` | Gemini 本地配置 |
| `*.orig` | 合并/备份临时文件 |

操作守则：
1. 禁止 `git add .` / `git add -A`，按文件选择性添加
2. 敏感文件有修改时用 `git restore` 丢弃
3. 写 `.vera/settings.json` 用 `settings.example.json` 的占位符
4. **永远不要**在 CLAUDE.md、README、注释、commit message 中粘贴 API Key

## 12. 静态分析工具

| 工具 | 用途 | 通过标准 |
|---|---|---|
| **oxlint** | TS/JS 语法与风格检查 | 0 error |
| **sonarjs** | 代码质量与安全（认知复杂度、漏洞模式） | 0 error |
| **jscpd** | 重复代码检测 | 重复率 > 10% 需评估 |
| **TypeScript Compiler** | 类型检查 | 0 error |

运行命令：

```bash
bash .claude/skills/quality-scan/scan.sh   # 完整扫描
pnpm typecheck                              # 仅类型检查
```

质量门禁：
- **oxlint / sonarjs error**：必须修复，阻塞提交
- **warning**：建议修复，不阻塞，但不应持续增长
- **jscpd 高重复率**：评估是否可抽取公共逻辑

## 13. 架构约束（强制）

1. **依赖方向**：`harness -> core`，反向禁止
2. **外部依赖**：新增需在 PR 中说明理由，优先复用已有
3. **存储层抽象**：持久化通过接口（`VectorStore`、`SessionStore`、`MemoryStore`），不硬编码实现
4. **Sandbox 隔离**：外部代码执行必须通过 Sandbox 抽象层，严禁 `child_process.exec` 直接执行用户代码
5. **Channel 抽象**：消息平台通过 `ChannelAdapter` 接口接入，不直接调用平台 SDK

---

## 附录：快速自检脚本

```bash
#!/bin/bash
set -e
echo "=== TypeCheck ===" && pnpm typecheck
echo "=== Test ===" && pnpm test
echo "=== Core Build ===" && pnpm --filter @open-vera/core build
echo "=== Core Coverage ===" && pnpm --filter @open-vera/core run test:coverage
echo "=== Quality Scan ===" && bash .claude/skills/quality-scan/scan.sh
echo "=== Sensitive Files ===" && git status --short | grep -qE '\.vera/settings\.json|\.qwen/|settings\.local\.json|\.gemini/' && echo "WARNING!" || echo "OK"
echo "=== Conflict Markers ===" && rg -n "<<<<<<<|=======|>>>>>>>" . && echo "WARNING!" || echo "OK"
echo "=== Done ==="
```
