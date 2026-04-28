# Project Skills Index

本项目在 `.claude/skills/` 下维护以下 **Claude Code 项目级 skill**，可通过 `/skill-name` 直接调用。

> **维护规则（给 Claude）**：新增或修改任何 skill 后，必须同步更新本文件。包括：新增条目、更新描述、更新参数、标记废弃。

---

## 可用 Skills

### `/agent-changes-report`
**综合 AI 变更报告（Claude Code + Cursor + Git）**

从三个数据源汇总当前项目在指定时间段内的所有 AI 工作记录，输出统一 Markdown 报告到 `docs/agent-changes/report-YYYY-MM-DD.md`。

| 项 | 内容 |
|---|---|
| 数据源 | Claude JSONL sessions · Cursor composer headers · `git log` |
| 输出 | `docs/agent-changes/report-YYYY-MM-DD.md` |
| 脚本 | `agent-changes-report/scripts/unified_report.py` |

```
/agent-changes-report                        # 今天
/agent-changes-report --hours 24            # 最近 24 小时
/agent-changes-report --since 2026-04-27    # 指定日期起
/agent-changes-report --print               # 只打印，不写文件
```

---

### `/claude-session-review`
**Claude Code session 工作记录**

读取 `~/.claude/projects/<slug>/*.jsonl`，提取 user prompt、文件改动、关键 bash 操作，输出到 `docs/agent-changes/claude-YYYY-MM-DD.md`。

| 项 | 内容 |
|---|---|
| 数据源 | `~/.claude/projects/<project-slug>/*.jsonl` |
| 输出 | `docs/agent-changes/claude-YYYY-MM-DD.md` |
| 脚本 | `claude-session-review/scripts/session_review.py` |

```
/claude-session-review                       # 今天
/claude-session-review --hours 12           # 最近 12 小时
/claude-session-review --since 2026-04-27   # 指定日期起
/claude-session-review --print              # 只打印
```

---

### `/cursor-session-review`
**Cursor Composer session 工作记录**

查询 Cursor 在当前工作区今天或最近的 AI 编辑 session，从本地 SQLite 数据库提取 session 列表、改动文件、使用模型。

| 项 | 内容 |
|---|---|
| 数据源（主）| `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| 数据源（备）| `~/.cursor/ai-tracking/ai-code-tracking.db` |
| 输出 | 终端展示（无文件输出） |

```
/cursor-session-review                       # 今天的 Cursor session
/cursor-session-review --days 3             # 最近 3 天（若 skill 支持）
```

---

### `/quality-scan`
**静态代码质量扫描**

并行运行 oxlint + ESLint/sonarjs + jscpd，检查函数长度、圈复杂度、认知复杂度、重复代码等，输出报告到 `docs/code-governance/report-YYYY-MM-DD.md`。

| 项 | 内容 |
|---|---|
| 工具 | oxlint · ESLint + sonarjs · jscpd |
| 输出 | `docs/code-governance/report-YYYY-MM-DD.md` |
| 脚本 | `quality-scan/scan.sh` |

```
/quality-scan                                # 扫描 packages/
/quality-scan packages/core                 # 指定目录
```

---

## 输出目录约定

| Skill | 输出路径 |
|---|---|
| `agent-changes-report` | `docs/agent-changes/report-YYYY-MM-DD.md` |
| `claude-session-review` | `docs/agent-changes/claude-YYYY-MM-DD.md` |
| `cursor-session-review` | 终端（无文件） |
| `quality-scan` | `docs/code-governance/report-YYYY-MM-DD.md` |

---

## 新增 Skill 模板

新增 skill 时在 `.claude/skills/<name>/SKILL.md` 中填写以下 frontmatter，然后在本文件对应位置追加条目：

```markdown
---
name: <skill-name>
description: <一句话描述，用于触发词匹配>
user-invocable: true
allowed-tools: Bash, Read
argument-hint: "[--flag value]"
---
```
