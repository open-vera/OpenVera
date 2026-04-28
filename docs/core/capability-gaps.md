# Vera — 当前能力差距与近期路线

本文记录 P0 完成后，Vera 对齐 Claude Code 风格 agent runtime 仍需补齐的能力。

## 当前重点

### 1. 权限与授权体验

目标：从“路径越界提示”升级为可持续的工具/命令权限系统。

- 持久化工具规则：支持 `.vera/permissions.json` 与 `~/.vera/permissions.json`
- 工具 allow/deny：按 tool name 控制可用工具
- Bash 风险确认：对破坏性命令先请求确认，再重试执行
- 命令规则：支持 bash command allow/deny pattern

### 2. 项目上下文

目标：让 `VERA.md` / `.vera/rules` 成为稳定、可缓存、可按路径激活的项目背景系统。

- 规则优先级：frontmatter 支持 `priority`
- mtime 缓存：同一轮内重复加载 project context 时复用缓存
- 路径规则：读取文件后按 `paths` frontmatter 注入 scoped rule
- 冲突处理：后加载高优先级规则覆盖/补充低优先级规则

### 3. UI 展示

目标：工具结果默认更接近 Claude Code 的 collapsed group。

- read/search/list 连续调用折叠成摘要
- `read_file` 默认仅显示 `Read N lines`
- bash/MCP/text 默认只显示少量行，可用快捷键展开
- 子 agent 显示为 summary + transcript id

### 4. 可靠性与测试

目标：把关键交互做成可重复 smoke。

- session 测试使用隔离临时 cwd，避免本地历史污染
- 覆盖权限确认、bash 风险确认、子 agent tool policy
- 覆盖 nested project context 与规则优先级
- 增加 REPL smoke 级测试入口，验证工具循环不会静默停在空 assistant

## 当前实现状态

- 子 agent：已有 `general` / `explore` / `plan` 内置定义，支持工具策略、sidechain session 和 summary 回传。
- 主 loop：默认不设 `maxTurns`，仅调用方显式设置时限制。
- 工具展示：基础 compact 已完成，仍需 grouped collapsed summary。
- session 测试：已改为临时 cwd，避免固定 `/test/project` 污染。
