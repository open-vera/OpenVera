# 项目上下文系统

Vera 在启动时自动读取多层上下文文件，将它们拼装为 LLM 系统提示词的一部分。上下文系统让你在不用修改代码的情况下，为 Agent 注入项目约定、编码规范、和个人偏好。

## 上下文文件类型

| 类型 | 标识 | 位置 | 作用域 |
|------|------|------|--------|
| `user` | 全局用户上下文 | `~/.vera/VERA.md` | 所有项目 |
| `user` | 全局规则目录 | `~/.vera/rules/*.md` | 所有项目 |
| `project` | 项目上下文 | `<cwd>/VERA.md` 或 `<cwd>/.vera/VERA.md` | 当前项目 |
| `project` | 祖先目录上下文 | 从 cwd 向上遍历各层 `VERA.md` | 继承 |
| `rule` | 路径作用域规则 | `<cwd>/.vera/rules/*.md` | 匹配路径时激活 |
| `local` | 本地私有上下文 | `<cwd>/VERA.local.md` | 当前项目（gitignored） |

代码入口：`packages/core/src/project-context/loader.ts` 的 `loadProjectContext()` 和 `loadNestedProjectContext()`。

## 加载过程

### 主加载流程（loadProjectContext）

```
1. 加载全局用户上下文
   ~/.vera/VERA.md                    → type: "user"
   ~/.vera/rules/*.md                 → type: "user"

2. 从 cwd 逐层向上遍历祖先目录
   每个目录检查：
   <dir>/VERA.md                      → type: "project"
   <dir>/.vera/VERA.md                → type: "project"（.vera 目录下优先）
   <dir>/.vera/rules/*.md             → type: "rule"
   <dir>/VERA.local.md                → type: "local"

3. 收集 Git 状态（可选）
   当前分支、git status、最近 5 条 commit
```

### 排序规则

上下文文件按 `priority` 字段排序（默认 0，数值越小越靠前），同优先级按路径字母序排列。

### 格式化输出

加载完成后通过 `formatVeraContext()` 拼装为 LLM 可用的文本：

```
<vera-git-status>
Git status snapshot at conversation start.
...
</vera-git-status>

Vera project and user instructions are shown below. Follow them when working in this repository.

Contents of /home/user/.vera/VERA.md (private user instructions):

...content...

Contents of /home/user/project/.vera/VERA.md (project instructions):

...content...
```

### 签名机制

每次加载生成 `signature` 字符串（所有文件路径、类型、优先级、内容长度的哈希），用于检测上下文是否发生变化（如 Session 模块判断是否需要重新加载）。

## VERA.md — 全局用户上下文

位于 `~/.vera/VERA.md`，在所有项目中生效。适合放：

- 个人编程风格偏好
- 常用工具链约定
- Git 提交规范
- 用户名/邮箱等全局标识

示例：

```markdown
# 全局用户偏好

- 优先使用 async/await，避免 raw Promise 链
- 错误处理使用自定义错误类，不使用 throw new Error(string)
- 提交信息使用中文
- 注释使用中文
- 变量命名使用 camelCase
```

## .vera/VERA.md — 项目级上下文

位于项目根目录的 `.vera/VERA.md`（优先）或 `VERA.md`。定义项目级约定的主要入口。

```markdown
---
priority: 0
---

# 项目约束

## 技术栈
- TypeScript strict mode
- React + Vite 前端
- Express 后端

## 命名规范
- 文件名：kebab-case.ts
- 类型：PascalCase
- 函数：camelCase

## 提交规范
- feat: / fix: / refactor: 前缀
- 单次提交不超过 500 行
```

### Frontmatter 元数据

支持 YAML frontmatter 配置元信息：

```markdown
---
paths: ["src/auth/**", "src/api/**"]
priority: 10
---

# 认证模块规范
...
```

| 字段 | 说明 |
|------|------|
| `paths` | 逗号/空格分隔的 glob 模式，限制此规则的生效路径范围 |
| `priority` | 加载优先级，数字越小越靠前（默认 0） |

## .vera/rules/ — 路径作用域规则

`.vera/rules/` 目录下的 `.md` 文件按路径 glob 匹配激活。适用于不同模块有不同规范的项目。

### 目录结构

```
.vera/
  rules/
    general.md         # 全局生效（无 paths 限制）
    api-conventions.md # 仅 API 路由文件生效
    react-components.md # 仅 React 组件文件生效
    css-standards.md   # 仅样式文件生效
```

### 规则示例

```markdown
---
paths: ["src/api/**"]
priority: 5
---

# API 路由规范

- 所有 API 路由必须验证输入参数
- 返回格式统一使用 { code, data, message }
- 错误使用标准 HTTP 状态码
```

```markdown
---
paths: ["src/components/**/*.tsx"]
priority: 5
---

# React 组件规范

- 优先使用函数组件 + Hooks
- Props 类型定义放在组件文件顶部
- 每个组件文件只导出一个主组件
```

### 匹配逻辑

规则激活通过 `matchesGlobs()` 实现，将当前目标文件路径与规则中定义的 glob 匹配：

```typescript
function matchesGlobs(filePath: string, baseDir: string, globs?: string[]): boolean {
  if (!globs || globs.length === 0) return true;  // 无 globs → 全局生效
  const rel = relative(baseDir, filePath).replaceAll("\\", "/");
  return globs.some((glob) => globToRegex(glob).test(rel));
}
```

支持 `*`（单层匹配）、`**`（递归匹配）、`?`（单字符匹配）。

## VERA.local.md — 本地私有上下文

位于 `<cwd>/VERA.local.md`，已加入 `.gitignore`，不会提交到仓库。适合放：

- 本地开发环境配置
- 个人调试偏好
- 临时工作笔记

## 嵌套上下文加载

当 Agent 读取文件时，如果目标文件路径所在的目录链上有自己的 `.vera/` 配置，会自动加载嵌套上下文：

```typescript
export function loadNestedProjectContext(options: NestedProjectContextOptions): ProjectContext {
  const dirs = dirsFromCwdToTarget(cwd, targetPath);
  for (const dir of dirs) {
    // 加载每个中间目录的 VERA.md、.vera/VERA.md、.vera/rules/
  }
}
```

这保证了在 monorepo 中，当 Agent 读取 `packages/foo/src/bar.ts` 时，如果 `packages/foo/.vera/rules/` 中有针对 `src/**` 的规则，该规则会被自动激活。

### 深度和尺寸限制

```typescript
const MAX_INCLUDE_DEPTH = 5;       // 最大 @include 嵌套深度
const MAX_FILE_CHARS = 40_000;     // 单文件最大字符数（超出截断）
const MAX_GIT_STATUS_CHARS = 2_000; // Git 状态最大字符数
```

## @include 文件引用

上下文文件可以使用 `@path` 语法引用其他文件：

```markdown
# 项目规范

@docs/conventions.md
@.vera/rules/typescript.md
```

`@include` 支持相对路径、绝对路径和 `~/` 主目录路径，最大嵌套深度 5 层，循环引用自动检测跳过。

## Git 状态注入

`loadProjectContext` 默认收集 Git 状态并通过 `<vera-git-status>` 标签注入系统提示词：

- 当前分支名
- `git status --short` 输出（截断到 2000 字符）
- 最近 5 条 commit 的 oneline log

可通过 `includeGitStatus: false` 关闭。

## 与 CLAUDE.md 的关系

Vera 的上下文系统和 CLAUDE.md 是互补的概念：

| 维度 | CLAUDE.md | VERA.md |
|------|-----------|---------|
| 消费者 | Claude Code CLI | Vera 运行时 |
| 位置 | 项目根目录 `CLAUDE.md` | `~/.vera/VERA.md` 或 `.vera/VERA.md` |
| 格式 | 纯 Markdown | Frontmatter + Markdown |
| 作用域 | 无路径作用域 | 支持 glob 路径匹配 |
| 继承 | 不支持 | 祖先目录自动继承 |

**建议：** 将 CLAUDE.md 中的项目约定也写入 `.vera/VERA.md` 或对应的 rules 文件中，让 Vera 运行时也能遵循同样的规范。

## 配置完整示例

### 场景：一个 TypeScript monorepo

```
my-project/
  CLAUDE.md                   # Claude Code 读取
  VERA.md                     # 顶层项目规则（无路径限制）
  .vera/
    VERA.md                   # 项目级上下文（优先级更高）
    rules/
      api-conventions.md      # paths: ["packages/api/**"]
      frontend-standards.md   # paths: ["packages/web/**"]
      shared-utils.md         # paths: ["packages/shared/**"]
      testing.md              # 无 paths → 全部生效
    permissions.json          # 权限规则
  packages/
    api/
      .vera/
        rules/
          query-optimization.md  # paths: ["*.sql", "src/db/**"]
      src/
        routes/
          users.ts
```

### 上下文加载时序

1. 加载 `~/.vera/VERA.md`（全局用户）
2. 从 `my-project/` 逐层向上加载各目录的 `VERA.md` 和 `.vera/VERA.md`
3. 加载 `my-project/.vera/rules/` 中所有规则的元信息

### Agent 读取 `packages/api/src/routes/users.ts` 时的上下文

通过 `loadNestedProjectContext` 加载：

1. `my-project/.vera/VERA.md` — 项目全局
2. `my-project/.vera/rules/api-conventions.md` — paths 匹配 `packages/api/**`
3. `my-project/.vera/rules/testing.md` — 无 paths，全局生效
4. `my-project/packages/api/.vera/rules/query-optimization.md` — paths 不匹配 `src/routes/users.ts`，不加载
5. `my-project/.vera/rules/frontend-standards.md` — paths 不匹配，不加载
6. `my-project/.vera/rules/shared-utils.md` — paths 不匹配，不加载

### 编程方式加载

```typescript
import { loadProjectContext, loadNestedProjectContext } from "@open-vera/core";

// 主加载：启动时
const context = loadProjectContext({
  cwd: "/path/to/project",
  includeUser: true,         // 是否加载 ~/.vera/VERA.md
  includeGitStatus: true,    // 是否注入 Git 状态
});

console.log(context.system);     // 格式化后可用于 LLM 系统提示词
console.log(context.signature);  // 内容签名（检测变化）
console.log(context.files);      // 原始文件列表

// 嵌套加载：读取文件时
const nested = loadNestedProjectContext({
  cwd: "/path/to/project",
  targetPath: "packages/api/src/routes/users.ts",
  loadedPaths: new Set([...context.files.map(f => f.path)]),  // 避免重复
});
```

## 调试上下文

查看当前项目加载了哪些上下文文件：

```typescript
const context = loadProjectContext({ cwd: process.cwd() });
for (const file of context.files) {
  console.log(`[${file.type}] ${file.path}${file.globs ? ` (paths: ${file.globs.join(", ")})` : ""}`);
}
```

输出示例：

```
[user]   /Users/me/.vera/VERA.md
[project] /path/to/project/.vera/VERA.md
[rule]   /path/to/project/.vera/rules/api-conventions.md (paths: packages/api/**)
[rule]   /path/to/project/.vera/rules/testing.md
[local]  /path/to/project/VERA.local.md
```
