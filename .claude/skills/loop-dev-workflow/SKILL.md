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
| `CLAUDE.md` | 项目规范（开发约束、测试要求、架构规则） |

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
2. 实现代码（遵循 CLAUDE.md 规范）
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

---

*本文件由 loop 任务和手动开发共同维护。每完成一个 Phase 后必须更新。*
