---
name: quality-scan
description: 静态代码质量扫描。当用户说"扫描代码质量"、"质量扫描"、"跑 quality scan"、"代码整洁度" 时使用。
---

# Quality Scan

并行运行三个工具扫描代码结构质量，输出报告到 `docs/code-governance/`。

## 工具

| 工具 | 职责 |
|---|---|
| oxlint | 文件长度、函数长度、圈复杂度、嵌套深度、参数数量 |
| ESLint + sonarjs | 认知复杂度、相同函数、重复分支（纯 AST，无类型检查） |
| jscpd | 跨文件重复代码块 |

## 执行步骤

### 1. 确定扫描目标

- 默认：`packages/`（扫描所有 packages）
- 用户指定路径时替换，例如 `packages/core`

### 2. 运行并行扫描

```bash
bash .Codex/skills/quality-scan/scan.sh [target]
```

脚本并行启动三个进程，输出以 `=== TOOL_JSON_BEGIN ===` / `=== TOOL_JSON_END ===` 分隔的 JSON 块。

### 3. 解析 oxlint 输出

oxlint JSON 格式为诊断数组，每条诊断：
```json
{
  "filename": "packages/core/src/agent/loop.ts",
  "message": "Function has too many lines (113). Maximum allowed is 50.",
  "rule": "max-lines-per-function",
  "severity": "warning",
  "labels": [{ "span": { "start": 47, "end": 160 } }]
}
```

按 rule 分组统计 warning/error 数量，提取 Top 5 最严重的违规（行数最多 / 复杂度最高）。

### 4. 解析 ESLint/sonarjs 输出

ESLint JSON 格式为文件数组：
```json
[{
  "filePath": "/abs/path/to/file.ts",
  "messages": [{
    "ruleId": "sonarjs/cognitive-complexity",
    "severity": 1,
    "message": "Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed.",
    "line": 42
  }]
}]
```

提取所有非空 `messages`，按 ruleId 汇总，列出 Top 5。

### 5. 解析 jscpd 输出

jscpd JSON 格式：
```json
{
  "statistics": {
    "total": { "percentage": 4.2, "clones": 7, "duplicatedLines": 120 }
  },
  "duplicates": [{
    "firstFile": { "name": "packages/core/src/foo.ts", "start": 80, "end": 120 },
    "secondFile": { "name": "packages/harness/src/bar.ts", "start": 45, "end": 85 },
    "lines": 40
  }]
}
```

提取 `statistics.total.percentage`（重复率）和 `duplicates` 数组，列出最大 3 个重复块。

### 6. 生成报告

**写入文件**：`docs/code-governance/report-YYYY-MM-DD.md`（使用当天日期）

**同时在终端输出摘要**（让用户立即看到结果）。

报告格式：

```markdown
# 代码质量扫描报告 — YYYY-MM-DD

> 扫描目标：`packages/` | 工具：oxlint + ESLint/sonarjs + jscpd

---

## 结构性指标（oxlint）

| 规则 | warn | error |
|---|---|---|
| 文件长度 (max-lines) | N | N |
| 函数长度 (max-lines-per-function) | N | N |
| 圈复杂度 (complexity) | N | N |
| 嵌套深度 (max-depth) | N | N |
| 参数数量 (max-params) | N | N |

**Top 违规**

| 文件 | 行号 | 规则 | 详情 |
|---|---|---|---|
| `packages/core/src/agent/loop.ts` | 47 | max-lines-per-function | 113 行（限制 50） |
| ... | | | |

---

## 认知复杂度（ESLint/sonarjs）

| 规则 | 触发数 |
|---|---|
| cognitive-complexity | N |
| no-identical-functions | N |
| no-duplicated-branches | N |

**Top 违规**

| 文件 | 行号 | 详情 |
|---|---|---|
| `packages/core/src/...` | 42 | 认知复杂度 18（限制 15） |

---

## 重复度（jscpd）

- **重复率**：X.X%（建议 < 5%）
- **重复块数**：N
- **重复行数**：N

**最大重复块**

| 文件 A | 文件 B | 行数 |
|---|---|---|
| `packages/.../foo.ts:80-120` | `packages/.../bar.ts:45-85` | 40 |

---

## 总结

- oxlint：N error，N warn
- sonarjs：N 条提示
- 重复率：X.X%

> 本次扫描未阻断构建，以上为参考性指标，优先处理 error 级别条目。
```

### 7. 输出路径

告知用户报告已写入 `docs/code-governance/report-YYYY-MM-DD.md`。

## 注意事项

- jscpd 可能输出 `jscpd-report.json` 不存在（无重复时），此时重复率记为 0%
- ESLint/sonarjs 若 `messages` 全为空数组，说明认知复杂度均在阈值内
- oxlint JSON 在无违规时输出 `[]`
- 文件路径统一转为相对路径（去掉 `ROOT_DIR` 前缀）方便阅读
- 若用户传入 `--verbose`，透传给 scan.sh 打印 stderr 详情
