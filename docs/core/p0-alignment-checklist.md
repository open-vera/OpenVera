# P0 后对齐 Checklist（代码核验版）

> 核验日期：2026-04-28  
> 目的：把 roadmap 中 “P0 后对齐项” 从叙述改为可跟踪清单。  
> 结论口径：仅按仓库当前代码与测试判断。

---

## 1. 权限与授权体验

- [x] 持久化工具规则（`~/.vera/permissions.json` + `<project>/.vera/permissions.json`）
  - 代码：`packages/core/src/tools/permission-rules.ts`
- [x] 工具 allow/deny（按 tool name）
  - 代码：`packages/core/src/tools/security.ts`
- [x] bash 风险确认（危险命令先确认，再重试）
  - 代码：`packages/core/src/tools/security.ts`
  - 测试：`packages/core/tests/intent-tool-runtime.test.ts`
- [x] bash 命令 allow/deny pattern（glob-like）
  - 代码：`packages/core/src/tools/permission-rules.ts`、`packages/core/src/tools/security.ts`

## 2. 项目上下文

- [x] 规则优先级（frontmatter `priority`）
  - 代码：`packages/core/src/project-context/loader.ts`
  - 测试：`packages/core/tests/project-context.test.ts`
- [x] mtime 缓存
  - 代码：`packages/core/src/project-context/loader.ts`（`fileCache`）
- [x] 按路径激活 scoped rules（frontmatter `paths` + 读取文件后注入 nested context）
  - 代码：`packages/core/src/project-context/loader.ts`、`packages/core/src/repl/ui/App.tsx`
  - 测试：`packages/core/tests/project-context.test.ts`

## 3. UI 展示

- [x] read/search/list grouped collapsed summary
  - 代码：`packages/core/src/repl/ui/ConversationPanel.tsx`（`compactGroupedToolUses`）
- [x] `read_file` 默认摘要展示（非展开态）
  - 代码：`packages/core/src/repl/ui/ToolResultView.tsx`（`Read N lines`）
- [x] 子 agent summary + transcript id
  - 代码：`packages/core/src/agent/subagent.ts`（结果包含 `Transcript: <sessionId>`）

## 4. 子 Agent（Claude Code 对齐）

- [x] `agent` tool 参数对齐、内置类型、自定义 definitions、project override、`isolation: "try"`
  - 代码：`packages/core/src/agent/subagent.ts`
  - 测试：`packages/core/tests/agent-context.test.ts`
- [x] 后台子 agent（`run_mode: "background"` + `/subjobs`）
  - 代码：`packages/core/src/agent/subagent.ts`、`packages/core/src/repl/commands/subjobs.ts`
  - 测试：`packages/core/tests/agent-context.test.ts`
- [x] resume subagent（`resume_session_id` / `resumeSessionId`）
  - 代码：`packages/core/src/agent/subagent.ts`
  - 测试：`packages/core/tests/agent-context.test.ts`
- [x] remote isolation（`isolation: "remote"`，支持 external runner + local fallback）
  - 代码：`packages/core/src/agent/subagent.ts`
  - 测试：`packages/core/tests/agent-context.test.ts`

## 5. Session UX（Claude Code 对齐）

- [x] session 列表/分页/过滤、title metadata、SessionPicker、branch/try/merge 生命周期
  - 代码：`packages/core/src/session/store.ts`、`packages/core/src/repl/commands/*.ts`、`packages/core/src/repl/ui/SessionPicker.tsx`
  - 测试：`packages/core/tests/session.test.ts`、`packages/core/tests/session-picker.test.ts`、`packages/core/tests/merge-command.test.ts`、`packages/core/tests/worktree.test.ts`
- [x] 子 agent remote isolation
- [x] 多分支结果比较 UI（SessionPicker 分支比较面板，`b` 键开关）
  - 代码：`packages/core/src/repl/ui/SessionPicker.tsx`

## 6. 可靠性与测试

- [x] session 隔离相关测试（临时 cwd/worktree）
  - 测试：`packages/core/tests/session.test.ts`、`packages/core/tests/repl-workspace.test.ts`、`packages/core/tests/merge-command.test.ts`
- [~] 权限/上下文/UI/子 agent 组合 smoke（部分覆盖，未形成统一 smoke 套件入口）
  - 已有：`intent-tool-runtime.test.ts`、`project-context.test.ts`、`agent-context.test.ts`
  - 缺口：端到端组合 smoke 编排（单入口）

---

## 汇总

- 已完成：21
- 部分完成：1
- 未完成：0
