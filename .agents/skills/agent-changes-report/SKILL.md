---
name: agent-changes-report
description: Generate a unified report of all AI agent activity (Codex + Cursor) for this project in a given time range. Use when the user asks "今天 AI 做了什么", "生成变更报告", "agent changes report", or similar. Outputs to docs/agent-changes/.
user-invocable: true
allowed-tools: Bash, Read
argument-hint: "[--hours N | --days N | --since DATE] [--until DATE] [--print]"
---

# Agent Changes Report (Unified)

综合查询 **Codex** 和 **Cursor** 在当前项目中的 AI 工作记录，结合 `git log`，生成统一 Markdown 报告输出到 `docs/agent-changes/`。

## 数据源

| 来源 | 位置 |
|---|---|
| Codex | `~/.Codex/projects/<slug>/*.jsonl` |
| Cursor (主要) | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` → `composer.composerHeaders` |
| Cursor (备用) | `~/.cursor/ai-tracking/ai-code-tracking.db` |
| Git | `git log --since --until` |

## 执行

```bash
SKILL_SCRIPTS="/Users/yang.zhou/workspace/open-vera/.Codex/skills/agent-changes-report/scripts"
python3 "$SKILL_SCRIPTS/unified_report.py" [flags]
```

## 支持的参数

| 参数 | 说明 |
|---|---|
| `--hours N` | 最近 N 小时 |
| `--days N` | 最近 N 天 |
| `--since DATE` | 起始时间，如 `2026-04-27` 或 `2026-04-27T10:00` |
| `--until DATE` | 结束时间（默认：现在） |
| `--project PATH` | 项目路径（默认：当前目录） |
| `--output PATH` | 输出文件路径 |
| `--print` | 输出到 stdout |

默认不传参数 = 今天。

## 报告结构

1. **汇总表格**：Codex sessions / Cursor sessions / git commits 数量对比
2. **Codex Sessions**：每个 session 的 prompt 列表 + 修改文件
3. **Cursor Sessions**：session 名称、首条 prompt、行数变化、文件数
4. **Git Commits**：时间范围内的所有 commit
5. **所有改动文件汇总**（Codex 侧）

## 示例

```bash
# 今天的完整报告
/agent-changes-report

# 最近 48 小时
/agent-changes-report --hours 48

# 某一天
/agent-changes-report --since 2026-04-27 --until 2026-04-27

# 只打印
/agent-changes-report --print
```

## 调用方式

```bash
python3 /Users/yang.zhou/workspace/open-vera/.Codex/skills/agent-changes-report/scripts/unified_report.py [用户传入的参数]
```

执行后：
- 告知用户报告写入路径
- 用 Read 读取报告内容并展示摘要（汇总表 + session 标题列表）给用户
