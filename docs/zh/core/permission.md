# 权限系统

Vera 权限系统基于 `SecurityPlugin` 实现，在每次工具调用前执行多层安全检查。权限规则按优先级逐层过滤，任一层拒绝则阻止工具执行。

## 架构

`SecurityPlugin` 实现 `ToolLifecycleHook` 接口，通过 `onBeforeToolCall` 钩子在工具执行前拦截所有调用：

```
工具调用请求
  → SecurityPlugin.onBeforeToolCall()
    → 0. 黑名单检查（deniedTools / deniedBashCommands）
    → 1. 白名单检查（allowedTools / allowedBashCommands）
    → 2. Bash 危险命令检测（DANGEROUS_BASH_PATTERNS）
    → 3. 只读模式检查（readonlyMode）
    → 4. 预算检查（budgetUsd）
    → 5. 路径边界检查（workdir → allowedPaths）
    → 6. 域名白名单检查（allowedDomains）
    → 7. 注入攻击检测（INJECTION_PATTERNS）
  → 返回 null（放行）或 ToolResult（拦截）
```

代码位于 `packages/core/src/tools/security.ts`。

## 权限层级详解

### 0. 黑名单检查（最高优先级）

黑名单优先于白名单。被 `deniedTools` 列入的工具直接拒绝，无论白名单如何配置。

```typescript
const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);
const FILE_PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "list_dir"]);
const NETWORK_TOOLS = new Set(["web_search", "fetch_url"]);
```

**适用范围：**
- `deniedTools`：按工具名称全局禁止
- `deniedBashCommands`：按 glob-like 模式禁止 bash 命令

```json
{
  "deniedTools": ["sandbox", "browser"],
  "deniedBashCommands": ["rm -rf *", "sudo *", "curl * | sh"]
}
```

### 1. 白名单检查

当 `allowedTools` 非空时，只有列表中的工具可以执行。空列表表示全部允许。

```json
{
  "allowedTools": [
    "read_file",
    "write_file",
    "edit_file",
    "grep",
    "glob",
    "list_dir",
    "bash"
  ]
}
```

Bash 命令白名单支持 glob-like 模式匹配：

```json
{
  "allowedBashCommands": [
    "npm test",
    "npm run build",
    "git diff",
    "git log *",
    "pnpm *"
  ]
}
```

### 2. Bash 危险命令检测

系统内置危险模式列表，匹配到则触发确认：

```typescript
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/,  // rm -rf 及其变体
  /\bsudo\b/,                                          // sudo 提权
  /\bchmod\s+(-R\s+)?777\b/,                          // 过宽权限
  /\bmkfs\b/,                                          // 格式化文件系统
  /\bdd\s+.*\bof=/,                                    // 磁盘写入
  /\bgit\s+(reset\s+--hard|clean\s+-[^\s]*f|push\s+--force)/,  // 破坏性 git 操作
];
```

**绕过机制：** 命令在 `allowedBashCommands` 白名单中时，不触发危险确认。或者在首次确认后，重试时带上 `__confirmedRisk: true` 标记跳过二次确认。

危险命令拦截返回的 `needsConfirm` 结构：

```typescript
{
  ok: false,
  error: { code: "PERMISSION_DENIED", message: "Bash command requires confirmation.", retryable: true },
  needsConfirm: {
    message: "Agent wants to run a potentially dangerous bash command:\n  rm -rf ./dist\n\nAllow this command once?",
    allowDir: "/path/to/cwd",        // 批准后白名单的目录
    retry: { name: "bash", args: { command: "rm -rf ./dist", __confirmedRisk: true } }
  }
}
```

### 3. 只读模式

开启 `readonlyMode` 后，`write_file`、`edit_file`、`bash` 三类写工具被禁止：

```typescript
const security = new SecurityPlugin({
  readonlyMode: true,
});
```

适用于代码审查、安全审计等场景。错误码：`PERMISSION_DENIED`。

### 4. 预算控制

设置费用上限，达到后拦截所有工具调用：

```typescript
const security = new SecurityPlugin({
  budgetUsd: 1.0,    // 1 美元上限
  usdUsed: 0,        // 从 0 开始（外部调用 updateBudgetUsed 更新）
});

// 执行过程中动态更新已用额度
security.updateBudgetUsed(0.85);  // 已用 $0.85
```

错误码：`BUDGET_EXCEEDED`。

### 5. 路径边界检查

所有涉及文件路径的工具（`FILE_PATH_TOOLS`）都会经过路径边界检查：

```typescript
function isInsideCwd(target: string, baseDir: string): boolean {
  const resolved = resolve(baseDir, target);
  const base = normalize(baseDir).replace(/\/?$/, "/");
  return resolved === normalize(baseDir) || (normalize(resolved) + "/").startsWith(base);
}
```

**边界规则：**

- `workdir`：默认从 `SecurityConfig.workdir` 获取，未设置时使用 `ToolContext.cwd`
- `allowedPaths`：用户批准额外访问的路径集合（每会话生命周期）
- 工具调用时合并：`[workdir, ...ToolContext.allowedPaths, ...SecurityPlugin.allowedPaths]`

当 Agent 尝试访问 `workdir` 外部的路径时，返回 `needsConfirm` 让用户决定是否授权：

```typescript
{
  ok: false,
  error: { code: "PATH_OUTSIDE_CWD", message: "Path is outside allowed workdir: /etc/hosts", retryable: true },
  needsConfirm: {
    message: "Agent wants to access a path outside the working directory:\n  /etc/hosts\n\nAllow access to \"/etc\"?",
    allowDir: "/etc",
    retry: { name, args }
  }
}
```

用户批准后，通过 `security.allowPath(dir)` 动态白名单该目录。

### 6. 域名白名单

限制网络工具（`web_search`、`fetch_url`）只能访问指定域名：

```typescript
const security = new SecurityPlugin({
  allowedDomains: [
    "github.com",
    "api.example.com",
    "docs.npmjs.com",
  ],
});
```

匹配规则：精确匹配或子域名匹配（如 `api.example.com` 匹配 `example.com` 通配规则）。URL 解析失败时（如搜索关键词而非完整 URL）放行。

### 7. 注入攻击检测

对所有字符串类型的工具参数执行注入模式匹配：

```typescript
const INJECTION_PATTERNS = [
  /ignore previous instructions/i,
  /disregard (all|your) (previous|prior|earlier)/i,
  /you are now/i,
  /new system prompt/i,
  /\bSYSTEM:\s/,
  /\bINSTRUCTION:\s/,
];
```

匹配到任一模式则拒绝执行，错误码 `PERMISSION_DENIED`。

## 权限规则文件

### 文件位置

| 路径 | 作用域 | 优先级 |
|------|--------|--------|
| `~/.vera/permissions.json` | 全局（所有项目） | 低 |
| `.vera/permissions.json` | 项目级 | 高 |

加载时合并：全局规则 + 项目规则。同名数组字段取并集。

### 文件格式

```json
{
  "allowedTools": ["read_file", "write_file", "grep", "bash"],
  "deniedTools": ["sandbox", "browser"],
  "allowedBashCommands": ["npm test", "pnpm *", "git diff *", "git log *"],
  "deniedBashCommands": ["rm -rf *", "sudo *", "curl * | sh"]
}
```

全部字段可选，空文件等价于全部放行。

### 加载逻辑

代码位于 `packages/core/src/tools/permission-rules.ts`：

```typescript
export function loadPermissionRules(cwd: string): PermissionRules {
  return mergeRules(
    readRulesFile(join(globalVeraDir(), "permissions.json")),   // 全局
    readRulesFile(projectResourcePath(cwd, "permissions.json")), // 项目
  );
}
```

## SecurityPlugin 配置

### 完整配置示例

```typescript
import { SecurityPlugin } from "@open-vera/core";

const security = new SecurityPlugin({
  // 工具白名单：只允许这些工具
  allowedTools: [
    "read_file",
    "write_file",
    "edit_file",
    "grep",
    "glob",
    "list_dir",
    "bash",
  ],

  // 工具黑名单：绝对禁止（优先于白名单）
  deniedTools: ["sandbox", "browser", "computer_use"],

  // Bash 命令白名单：匹配 glob 模式
  allowedBashCommands: [
    "npm test",
    "npm run build",
    "pnpm *",
    "git diff *",
    "git log *",
    "git status",
  ],

  // Bash 命令黑名单：禁止模式
  deniedBashCommands: [
    "rm -rf *",
    "sudo *",
    "chmod 777 *",
    "curl * | sh",
    "wget * -O *",
  ],

  // 文件操作限制在项目目录内
  workdir: "/home/user/my-project",

  // 网络工具只允许这些域名
  allowedDomains: ["github.com", "api.npmjs.org"],

  // 只读模式：禁止写操作
  readonlyMode: false,

  // 费用上限（美元）
  budgetUsd: 5.0,
});
```

### 在 Agent Loop 中使用

```typescript
import { AgentLoop } from "@open-vera/core";

const loop = new AgentLoop({
  adapter,
  security,           // SecurityPlugin 实例
  allowedTools: ["read_file", "bash", "grep"],
});
```

### 动态操作

```typescript
// 动态授权外部目录访问
security.allowPath("/tmp/build-output");

// 更新费用使用量
security.updateBudgetUsed(1.23);
```

## 错误码汇总

| 错误码 | 含义 | 可重试 |
|--------|------|--------|
| `PERMISSION_DENIED` | 工具被黑名单或注入检测拦截 | 否 |
| `PERMISSION_DENIED` | Bash 命令被黑名单拦截 | 否 |
| `PATH_OUTSIDE_CWD` | 路径超出工作目录边界 | 是（用户批准后） |
| `BUDGET_EXCEEDED` | 费用超过上限 | 否 |
| `TIMEOUT` | 工具执行超时 | 是 |
| `EXEC_ERROR` | 工具执行失败 | 是 |

## 配置最佳实践

1. **最小权限原则：** 使用 `allowedTools` 白名单而非依赖黑名单
2. **开发环境宽松，CI 环境严格：** 通过 `.vera/permissions.json` 按环境覆盖全局配置
3. **Bash 白名单要具体：** 避免 `*` 通配，使用 `git diff *` 而非 `git *`
4. **始终设置 `workdir`：** 防止 Agent 意外修改系统文件
5. **高风险操作用 `readonlyMode`：** 代码审查时开启，避免误改
6. **域名白名单覆盖 `allowedDomains`：** 防止 Agent 访问内网服务
7. **定期审计：** 检查 `allowedBashCommands` 中是否存在可被利用的宽泛模式
