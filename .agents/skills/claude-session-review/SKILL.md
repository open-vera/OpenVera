---
name: Codex-session-review
description: Review what Codex did in recent sessions for this project. Use when the user asks "Codex 今天做了什么", "查看 Codex 的工作记录", "session 里改了什么", or similar. Outputs a markdown report to docs/agent-changes/.
user-invocable: true
allowed-tools: Bash, Read
argument-hint: "[--hours N | --days N | --since DATE] [--until DATE] [--print]"
---

# Codex Session Review

从本地 `~/.Codex/projects/<slug>/*.jsonl` 提取 Codex 在当前项目中的工作记录，并输出 Markdown 报告到 `docs/agent-changes/`。

## 执行

```bash
SKILL_SCRIPTS="$(realpath "$(dirname "$0")/scripts" 2>/dev/null || echo "/Users/yang.zhou/workspace/open-vera/.Codex/skills/Codex-session-review/scripts")"
python3 "$SKILL_SCRIPTS/session_review.py" [flags]
```

脚本位置: `.Codex/skills/Codex-session-review/scripts/session_review.py`

## 支持的参数

| 参数 | 说明 |
|---|---|
| `--hours N` | 最近 N 小时 |
| `--days N` | 最近 N 天 |
| `--since DATE` | 起始时间，如 `2026-04-27` 或 `2026-04-27T10:00` |
| `--until DATE` | 结束时间（默认：现在） |
| `--project PATH` | 项目路径（默认：当前目录） |
| `--output PATH` | 输出文件路径 |
| `--print` | 输出到 stdout 而非文件 |

默认不传参数 = 今天的记录。

## 报告内容

- 时间范围、session 数、操作轮次、触碰文件总数
- 每个 session 的任务列表（用户 prompt）
- 每个 session 修改的文件（含编辑次数）
- 关键操作描述（Bash 命令）
- 所有改动文件汇总

## 示例

```bash
# 今天的记录
/Codex-session-review

# 最近 24 小时
/Codex-session-review --hours 24

# 某一天
/Codex-session-review --since 2026-04-27 --until 2026-04-27

# 仅打印不写文件
/Codex-session-review --print
```

## 调用方式

直接运行脚本并展示输出路径给用户：

```bash
python3 /Users/yang.zhou/workspace/open-vera/.Codex/skills/Codex-session-review/scripts/session_review.py [用户传入的参数]
```

如果用户用了 `--print`，将脚本输出直接展示给用户。
否则告知用户报告写入的路径，并用 Read 读取文件内容摘要后展示给用户。
