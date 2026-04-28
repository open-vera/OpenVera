---
name: cursor-session-review
description: Query what Cursor AI did in recent work sessions. Use when the user asks "Cursor 今天做了什么", "看看 Cursor 的工作 session", "查询 Cursor 工作记录" or similar.
---

# Cursor Session Review

查询 Cursor AI Composer 在指定工作区今天或最近的工作内容，从本地 SQLite 跟踪数据库中提取。

## 数据源

Cursor 将 AI 编辑记录写入：
```
~/.cursor/ai-tracking/ai-code-tracking.db
```

关键表：
- `ai_code_hashes` — 每次 AI 生成的代码块，含 `fileName / conversationId / model / createdAt`
- `conversation_summaries` — 会话摘要（若有）
- `scored_commits` — commit 级别 AI 占比评分

## 执行步骤

### 1. 确认目标工作区路径

默认查当前项目：`/Users/yang.zhou/workspace/open-vera`
用户若指定其他项目，替换路径过滤条件。

### 2. 查询今天的 session 列表

```bash
sqlite3 ~/.cursor/ai-tracking/ai-code-tracking.db \
  "SELECT conversationId,
          count(DISTINCT fileName) as files,
          datetime(min(createdAt)/1000,'unixepoch','localtime') as start,
          datetime(max(createdAt)/1000,'unixepoch','localtime') as end
   FROM ai_code_hashes
   WHERE fileName LIKE '%open-vera%'
   AND createdAt > (strftime('%s','$(date +%Y-%m-%d)') * 1000)
   GROUP BY conversationId
   ORDER BY min(createdAt) ASC;"
```

### 3. 查询每个 session 改动的文件

```bash
CID="<conversationId>"
sqlite3 ~/.cursor/ai-tracking/ai-code-tracking.db \
  "SELECT DISTINCT fileName FROM ai_code_hashes
   WHERE conversationId = '$CID' AND fileName LIKE '%open-vera%'
   ORDER BY fileName;" \
  | sed 's|.*/open-vera/||'
```

### 4. 查询使用的模型

```bash
sqlite3 ~/.cursor/ai-tracking/ai-code-tracking.db \
  "SELECT DISTINCT model FROM ai_code_hashes
   WHERE fileName LIKE '%open-vera%'
   AND createdAt > (strftime('%s','$(date +%Y-%m-%d)') * 1000);"
```

### 5. （可选）查询所有工作区今天的活动

去掉 `fileName LIKE '%open-vera%'` 过滤，改为 group by workspace 前缀。

## 输出格式

按 session 分组，每个 session 输出：
- 时间段（start → end）
- 使用模型
- 改动文件列表（按功能区域归类：src / tests / docs）
- 一句话概括该 session 做了什么

## 注意事项

- `createdAt` 是毫秒时间戳，换算时需 `/1000`
- `conversation_summaries` 表通常为空（Cursor 不一定写入）
- `scored_commits` 的 `commitDate` 是 git author date 字符串，不适合用 `>=` 过滤今天
- `.vera/settings.json` 若出现在文件列表中，说明 AI 动过本地密钥文件，需警惕
