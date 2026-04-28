# Vera — 项目约束

## 敏感文件保护

以下文件/目录包含本地密钥或临时数据，**任何情况下都不得提交**：

| 路径 | 原因 |
|---|---|
| `.vera/settings.json` | LLM API Key，已 gitignore |
| `.qwen/` | Qwen 本地配置，已 gitignore |
| `.claude/settings.local.json` | Claude Code 本地设置，已 gitignore |
| `.claude/worktrees/` | 临时 worktree，已 gitignore |
| `.gemini/` | Gemini 本地配置，已 gitignore |
| `*.orig` | 合并/备份临时文件 |

**规则：**
- 提交前检查 `git status`，确认上述文件不在 staged 中
- 不要 `git add .` 或 `git add -A` 无脑全加，按文件/目录选择性添加
- 如果 `git status` 显示上述文件有修改，用 `git restore` 丢弃或保持 unstaged
- 写 `.vera/settings.json` 时永远用 `settings.example.json` 的占位符，不要填入真实 Key
- 永远不要在 CLAUDE.md、README、代码注释、commit message 中粘贴 API Key

## 项目架构

Vera = Harness 为内核的 agent runtime。两层结构：

- **Core** (`packages/core`)：单次 LLM 调用闭环。adapter → loop → tool → result。不感知 Harness。
- **Harness** (`packages/harness`)：多步 workflow。ExecutionPlan 状态机 → Flow State → Critique → Replan。依赖 Core。

依赖方向：`harness → core`，Core 不可 import Harness。

## 技术栈

- TypeScript ESM（`module: "nodenext"`）
- pnpm workspace monorepo
- React + Ink（REPL UI）
- 默认 LLM adapter：Anthropic Claude API

## 提交风格

- 英文 commit message
- `feat:` / `fix:` / `docs:` / `chore:` 前缀
- 单次提交聚焦一个功能模块

## 文档

- 入口：`docs/README.md`
- 路线图：`docs/roadmap.md`
- 当前 P0 进度：Plan Mode 已完成，待做无限上下文
