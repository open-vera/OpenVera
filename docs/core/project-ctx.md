# 项目上下文

Vera 在启动 agent 时，从文件系统加载项目上下文（Project Context），将其拼接为系统提示词（system prompt）的一部分注入 LLM。上下文由多层级的 `VERA.md`、`CLAUDE.md` 和 `.vera/rules/` 规则文件组成，支持路径作用域、优先级排序、文件引用展开和 Git 状态注入。

---

## 架构总览

```
加载流程
  用户目录
    ├── ~/.vera/VERA.md              ← 用户级上下文
    └── ~/.vera/rules/*.md           ← 用户级规则
          │
  项目层级（从 cwd 向上遍历到根）
    ├── <dir>/VERA.md                 ← 项目级上下文
    ├── <dir>/.vera/VERA.md           ← 项目资源上下文
    ├── <dir>/.vera/rules/*.md        ← 项目规则
    └── <dir>/VERA.local.md           ← 本地私有上下文（已 gitignore）
          │
  Git 状态快照
    └── branch + status + recent commits
          │
  合并 → 排序 → 格式化 → VeraContextFile[]
          │
  注入 LLM system prompt
```

核心代码在 `packages/core/src/project-context/loader.ts` 中。

---

## 上下文文件类型

| 类型 | 值 | 说明 |
|---|---|---|
| `user` | `"user"` | 用户私有指令（`~/.vera/` 下），所有项目共享 |
| `project` | `"project"` | 项目指令（项目目录下的 `VERA.md`、`CLAUDE.md`） |
| `local` | `"local"` | 本地私有指令（`VERA.local.md`，不入版本控制） |
| `rule` | `"rule"` | 路径作用域规则（`.vera/rules/*.md`） |

---

## 上下文文件格式

### VERA.md / CLAUDE.md

标准 Markdown 文件，支持 YAML frontmatter：

```markdown
---
paths: src/**/*.ts, lib/**/*.ts
priority: -10
---

# Vera — 项目约束

## 敏感文件保护

以下文件/目录包含本地密钥或临时数据，**任何情况下都不得提交**：
...
```

### YAML Frontmatter 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `paths` | string | 逗号/空格分隔的 glob 路径。限定此文件在哪些文件修改时生效 |
| `priority` | number | 整数排序优先级。越小越靠前（排序时升序），默认 0 |

- `paths` 为空或不包含 `paths` 字段时，上下文无条件生效（适用于全局项目规则）
- `priority` 用于控制多文件拼接顺序，优先级值小的排在提示词前面

### 文件引用展开

Markdown 正文中支持 `@path/to/file` 语法引用其他文件，引用的文件内容会自动递归展开插入（最多嵌套 5 层）：

```markdown
请参考以下文件：
@docs/api-design.md
@~/shared-conventions.md
```

- `@relative/path` 相对于当前文件的目录解析
- `@/absolute/path` 解析为绝对路径
- `@~/path` 从用户 home 目录展开
- 被引用文件的 frontmatter 同样会被解析
- 只展开文本文件（支持 60+ 常见扩展名）

---

## 加载顺序

### loadProjectContext

```typescript
import { loadProjectContext } from "@open-vera/core";

const ctx = loadProjectContext({
  cwd: "/path/to/project",
  includeUser: true,        // 是否包含用户级上下文，默认 true
  includeGitStatus: true,   // 是否注入 Git 状态，默认 true
});

console.log(ctx.files.length); // 上下文文件数
console.log(ctx.gitStatus);    // Git 状态快照文本
console.log(ctx.system);       // 格式化后的完整系统提示词
console.log(ctx.signature);    // 内容签名（用于检测上下文变化）
```

**加载顺序（自上而下）：**

1. 用户级上下文
   - `~/.vera/VERA.md`（type: `user`）
   - `~/.vera/rules/*.md`（type: `user`）

2. 项目级上下文（从 cwd 向上遍历到根目录，每层执行以下步骤）
   - `<dir>/VERA.md`（type: `project`）
   - `<dir>/.vera/VERA.md`（type: `project`）
   - `<dir>/.vera/rules/*.md`（type: `rule`）
   - `<dir>/VERA.local.md`（type: `local`）

3. Git 状态快照（默认开启）
   - 当前分支名
   - `git status --short`（截断到 2000 字符）
   - `git log --oneline -n 5`

所有文件加载后按 `priority` 升序排序（同 priority 按路径字母序），最终格式化为一条完整的系统提示词。

### loadNestedProjectContext

用于子目录或子 agent 执行时的局部上下文加载，只加载从 cwd 到 targetPath 路径上的上下文文件：

```typescript
import { loadNestedProjectContext } from "@open-vera/core";

const nestedCtx = loadNestedProjectContext({
  cwd: "/path/to/project",
  targetPath: "packages/core/src/session/",
  loadedPaths: new Set(), // 已加载的文件路径（避免重复）
});
```

与 `loadProjectContext` 的区别：
- 不加载用户级上下文（不读 `~/.vera/`）
- 不注入 Git 状态
- 只遍历 `cwd → targetPath` 的目录链，不向上到文件系统根
- 对 rules 文件应用 glob 匹配过滤（仅含匹配 `targetPath` 的规则）

---

## 路径作用域规则

### 工作原理

`<dir>/.vera/rules/` 目录下的 Markdown 文件可以有 `paths` frontmatter 字段限定生效范围：

```markdown
---
paths: packages/core/src/**/*.ts, packages/core/src/**/*.tsx
---

# Core 包开发规范

- 使用 strict TypeScript
- 所有接口定义在 types.ts 中
```

此文件仅在 agent 操作 `packages/core/src/` 下的 `.ts`/`.tsx` 文件时才会加载到上下文中。操作其他目录的文件时，此规则不注入。

### Glob 转换规则

| 模式 | 正则 | 匹配 |
|---|---|---|
| `*.ts` | `[^/]*\.ts$` | 当前目录下的 .ts 文件 |
| `src/**/*.ts` | `(?:.*/)?[^/]*\.ts$` | src 下任意层级的 .ts 文件 |
| `config?.json` | `config[^/]\.json$` | config.json, configs.json 等 |
| `lib/[a-z]*.js` | `lib/[a-z][^/]*\.js$` | lib 下小写字母开头的 .js 文件 |

### 嵌套目录规则

在 `loadNestedProjectContext` 中，沿路径链的每个目录都加载其规则，但只有 glob 匹配 `targetPath` 的规则才会生效。

例如，targetPath 为 `packages/core/src/session/store.ts`，路径链为：
```
/root → /root/packages → /root/packages/core → /root/packages/core/src
```

每层的 rules 目录都会被扫描，但 `packages/harness/**` 的规则不会注入，因为它不匹配 targetPath。

---

## 格式化输出

`formatVeraContext` 将上下文文件列表拼接为一段完整文本：

```
Contents of /path/to/VERA.md (project instructions):

<文件内容>

Contents of /path/to/CLAUDE.md (project instructions):

<文件内容>

Contents of /path/to/.vera/rules/api-rules.md (project rule)
Applies to: packages/api/**/*.ts

<文件内容>

Vera project and user instructions are shown below. Follow them when working in this repository.
```

格式包含：
- 每个文件的 `path`、`type` 标签
- 有 `globs` 的显示 "Applies to: ..."
- 有 `priority` 的显示 "Priority: ..."
- 开头有引导语提示 LLM 遵守这些指令
- Git 状态包裹在 `<vera-git-status>` XML 标签中

### 内容截断

单个文件超过 40,000 字符时自动截断并追加 `[truncated]` 标记。截断在整字符边界，不破坏 UTF-8 编码。

---

## 缓存机制

文件读取有基于 `mtimeMs` 的内存缓存（`fileCache`），避免短时间内重复读取同一文件。包括 `@include` 展开后的子文件在内都会得到缓存。

---

## 签名机制

`signatureFor` 生成内容签名字符串，由各文件的 `path:type:priority:contentLength` 和 gitStatus 拼接而成。签名用于检测上下文变化，触发缓存失效等场景。

---

## 配置示例

### 全局用户上下文

`~/.vera/VERA.md`：

```markdown
# 我的编码风格偏好

- 优先使用 async/await，避免 raw Promise
- 函数不超过 50 行
- 所有公共 API 必须有 JSDoc 注释
```

### 全局规则

`~/.vera/rules/security.md`：

```markdown
---
priority: -100
---

# 安全规则

所有项目都必须遵循：
- 不在代码中硬编码 API Key
- 敏感配置使用环境变量
- 所有用户输入必须转义
```

### 项目级上下文

`/project/VERA.md`：

```markdown
---
priority: 0
---

# MyProject — 项目约束

- TypeScript strict mode
- pnpm monorepo
- 覆盖率 ≥ 90%
```

### 路径作用域规则

`/project/.vera/rules/frontend.md`：

```markdown
---
paths: webapp/**/*.tsx, webapp/**/*.ts
priority: 10
---

# 前端开发规范

- 使用 React 18 + hooks
- 组件命名用 PascalCase
- 样式使用 CSS Modules
```

### 本地私密上下文

`/project/VERA.local.md`：

```markdown
# 本地开发笔记

- 测试数据库连接：postgres://localhost:5432/testdb
- 调试时设置 DEBUG=* 查看详细日志
```

此文件已 gitignore，不会提交到仓库。

---

## 与 Agent 执行的关系

1. **主 Agent**：每次启动时，`loadProjectContext(cwd)` 加载完整上下文注入 system prompt
2. **子 Agent**：执行时 `loadNestedProjectContext(cwd, targetPath)` 加载局部上下文，只包含目标路径相关的规则
3. **上下文签名**：通过 `signature` 检测上下文变化，决定是否需要重新生成执行计划
