# 静态代码质量扫描

> 目标：用一条命令扫出文件过长、函数过复杂、跨文件重复等结构性问题，输出可读报告。

---

## 工具选型

三工具各司其职，完全并行，无依赖关系。

### 结构性指标：oxlint

[oxlint](https://oxc.rs/docs/guide/usage/linter.html) 是 OXC（Oxidation Compiler）工具链的 linter 组件，Rust 实现，**多线程并行**扫描，速度比 ESLint 快 50–100x。

- 内置多线程，天然支持 monorepo 并行
- 覆盖文件长度、函数长度、圈复杂度、嵌套深度、参数数量（见下表）
- 独立二进制，与主 ESLint 配置完全隔离

### 认知复杂度：ESLint + sonarjs（无类型检查模式）

[eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs) 提供认知复杂度（cognitive complexity）规则。认知复杂度比圈复杂度更接近"阅读难度"——嵌套越深惩罚越重，`&&`/`||` 链式判断也会放大得分。

关键：sonarjs 所有规则是**纯 AST 分析**，不需要 TypeScript 类型信息。因此配置一个极简 ESLint 实例，只挂 sonarjs 规则、不开 `parserOptions.projectService`，速度比完整 lint 快 **10–20x**：

```js
// eslint.sonarjs.config.js（独立配置，不影响主 eslint.config.js）
import sonarjs from "eslint-plugin-sonarjs";
import tsParser from "@typescript-eslint/parser";

export default [{
  plugins: { sonarjs },
  languageOptions: { parser: tsParser },   // 只解析，跳过类型解析
  rules: {
    "sonarjs/cognitive-complexity": ["warn", 15],
    "sonarjs/no-identical-functions": "warn",
    "sonarjs/no-duplicated-branches": "warn",
  },
}];
```

### 重复度检测：jscpd

[jscpd](https://github.com/kucherenko/jscpd)（JS Copy-Paste Detector）是目前 JS/TS 生态最成熟的跨文件重复代码检测工具。

- 支持 `--workers N` 多进程并行 tokenize
- token 级别匹配（不受变量名重命名影响）
- 输出 JSON / Markdown / HTML 多种格式

> Rust 生态目前尚无成熟的跨文件 duplication detector，jscpd 是唯一选择。

### 并行执行策略

三个工具扫描的是**完全不相交的关注点**，在 skill 脚本里同时启动：

```
skill scan
├── oxlint（结构指标）         ~0.1s ─┐
├── eslint + sonarjs（认知复杂度）~3s ─┤─→ Promise.all → 合并报告
└── jscpd（重复度）            ~4s ─┘
```

总耗时 ≈ max(三者) ≈ **4s**，而非三者之和。

---

## 指标与阈值

| 类别 | 指标 | 工具 | 规则名 | warn | error |
|---|---|---|---|---|---|
| 文件 | 文件总行数 | oxlint | `max-lines` | 300 | 600 |
| 函数 | 函数体行数 | oxlint | `max-lines-per-function` | 50 | 100 |
| 复杂度 | 圈复杂度（分支数） | oxlint | `complexity` | 10 | 20 |
| 嵌套 | 最深 block 层数 | oxlint | `max-depth` | 4 | 6 |
| 参数 | 函数参数数量 | oxlint | `max-params` | 4 | 7 |
| 认知复杂度 | 阅读难度评分 | sonarjs | `cognitive-complexity` | 15 | — |
| 重复 | 重复 token 块 | jscpd | `--min-tokens` | 50 | — |

**阈值设计原则**：
- warn = 值得关注，不阻断；error = 超出业界普遍共识，需重构
- 阈值参考 Google/Airbnb 规范及 SonarQube 默认配置
- 重复度只输出报告，不设 error 等级（先摸清现状）

---

## Skill 设计

### 输入

```bash
# 扫描全部 packages（默认）
/quality-scan

# 只扫指定包
/quality-scan packages/core

# 输出详细模式（列出每个违规位置）
/quality-scan --verbose
```

### 输出

终端打印摘要 + 写入 `docs/code-governance/report-<date>.md`：

```
═══════════════════════════════════════
  Vera 代码质量扫描报告  2026-04-27
═══════════════════════════════════════

【结构性指标】oxlint
  ✓ 文件长度   0 error  3 warn
  ✗ 函数长度   2 error  8 warn
  ✓ 圈复杂度   0 error  1 warn
  ✓ 嵌套深度   0 error  0 warn
  ✓ 参数数量   0 error  2 warn

  Top 违规：
    packages/core/src/agent/loop.ts:47  函数 agentLoop() 113 行 (limit: 100)
    packages/core/src/plan/repl-runner.ts:12  函数 run() 108 行 (limit: 100)

【重复度】jscpd
  重复率：4.2%  (建议 < 5%)
  重复块：7 处
  最大块：packages/harness/src/executor.ts:80–120
          packages/harness/src/runner.ts:45–85  (40 lines)

═══════════════════════════════════════
  总结：2 error  14 warn  重复率 4.2%
═══════════════════════════════════════
```

### Skill 实现结构

```
.claude/skills/quality-scan/
├── skill.md              # skill 元信息与入口提示词
├── scan.ts               # 并行启动三工具，合并结果
├── oxlint.config.json    # oxlint 规则配置（独立于主 eslint.config.js）
├── eslint.sonarjs.config.js  # 极简 ESLint，只跑 sonarjs，无类型检查
└── report.ts             # 格式化输出 + 写 Markdown 报告
```

`oxlint.config.json`：

```json
{
  "rules": {
    "max-lines": ["warn", { "max": 300, "skipBlankLines": true, "skipComments": true }],
    "max-lines-per-function": ["warn", { "max": 50, "skipBlankLines": true }],
    "complexity": ["warn", 10],
    "max-depth": ["warn", 4],
    "max-params": ["warn", 4]
  }
}
```

`eslint.sonarjs.config.js`（只解析 AST，不挂 projectService，快 10–20x）：

```js
import sonarjs from "eslint-plugin-sonarjs";
import tsParser from "@typescript-eslint/parser";

export default [{
  plugins: { sonarjs },
  languageOptions: { parser: tsParser },
  rules: {
    "sonarjs/cognitive-complexity": ["warn", 15],
    "sonarjs/no-identical-functions": "warn",
    "sonarjs/no-duplicated-branches": "warn",
  },
}];
```

---

## 与日常 lint 的关系

| | 日常 `pnpm lint` | `quality-scan` |
|---|---|---|
| 目的 | 正确性、风格 | 结构复杂度、重复度 |
| 工具 | ESLint + typescript-eslint（类型检查） | oxlint + ESLint/sonarjs（无类型检查）+ jscpd |
| 触发时机 | 每次提交前 | 按需 / 定期 |
| 阻断构建？ | 是（error 时） | 否（只报告） |

三份配置（`eslint.config.js` / `oxlint.config.json` / `eslint.sonarjs.config.js`）完全独立，互不干扰。

---

## 待评估

- [ ] 认知复杂度（cognitive complexity）：oxlint 支持后可替换圈复杂度
- [ ] CI 集成：PR 时自动跑扫描，将报告贴到 PR comment
- [ ] 趋势追踪：多次扫描结果对比，观察质量变化曲线
