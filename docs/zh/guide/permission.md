# 权限系统 (Permission System)

## 概述

Vera 的权限系统在工具执行前作为统一安全门禁，对所有工具调用进行多层检查。核心组件 `SecurityPlugin` 实现 `ToolLifecycleHook` 接口，在 `onBeforeToolCall` 中以固定流水线顺序拦截和审查每次调用。

设计目标：纵深防御、最小权限、用户知情、可审计。

---

## 架构总览

```
Agent 请求工具调用
       │
       ▼
┌──────────────────────────────────────┐
│   SecurityPlugin.onBeforeToolCall    │
│                                      │
│  L0: 黑名单检查（deniedTools）         │
│  L1: 白名单检查（allowedTools）        │
│  L2: Bash 命令安全检查                 │
│  L3: 只读模式检查                     │
│  L4: 预算上限检查                     │
│  L5: 路径边界检查                     │
│  L6: 域名白名单检查                    │
│  L7: Prompt Injection 检测            │
│                                      │
│  全部通过 → null（放行）               │
│  拒绝     → ToolResult（含错误码）     │
│  需确认   → needsConfirm（等待用户）    │
└──────────────────────────────────────┘
```

核心文件：`packages/core/src/tools/security.ts`（SecurityPlugin）、`packages/core/src/tools/permission-rules.ts`（规则文件加载）、`packages/core/src/tools/utils/path.ts`（路径边界判断）。

---

## SecurityPlugin 接口

```ts
class SecurityPlugin implements ToolLifecycleHook {
  constructor(config: SecurityConfig);
  onBeforeToolCall(name, args, ctx): Promise<ToolResult | null>;
  allowPath(dir: string): void;          // 运行时动态授权目录
  updateBudgetUsed(usdUsed: number): void; // 外部更新已消费金额
}
```

- `onBeforeToolCall` 返回 `null` 表示放行，返回 `ToolResult` 表示拒绝或需确认。
- `allowPath` 用于用户确认后扩展路径白名单。
- `updateBudgetUsed` 由计费模块持续调用，供 L4 预算检查使用。

### SecurityConfig 配置结构

```ts
interface SecurityConfig {
  allowedTools?: string[];          // 工具白名单（空=全部允许）
  deniedTools?: string[];           // 工具黑名单（优先于白名单）
  allowedBashCommands?: string[];   // Bash 命令白名单（glob-like）
  deniedBashCommands?: string[];    // Bash 命令黑名单（glob-like）
  workdir?: string;                 // 限制文件操作根目录
  allowedDomains?: string[];        // 网络工具域名白名单
  readonlyMode?: boolean;           // 禁止所有写操作
  budgetUsd?: number;               // 费用上限（USD）
  usdUsed?: number;                 // 已使用费用（外部更新）
}
```

---

## 7 层安全流水线

### L0: 黑名单检查（deniedTools）

优先级最高。工具名在 `deniedTools` 列表中 → 直接拒绝，不检查后续白名单。

```json
{ "deniedTools": ["bash", "sandbox_exec"] }
```

错误码：`PERMISSION_DENIED`

### L1: 白名单检查（allowedTools）

配置了白名单且列表非空时，仅列表中的工具允许执行。未配置或空数组表示全部允许。

```json
{ "allowedTools": ["read_file", "write_file", "edit_file", "list_dir", "search_code"] }
```

注意：L0 的黑名单不会被 L1 覆盖 —— 已拒绝的工具不会因白名单复活。

### L2: Bash 命令安全检查

分三步：

**a. 黑名单匹配**：命令匹配 `deniedBashCommands` 中的 glob 模式 → 直接拒绝。

**b. 白名单匹配**：命令匹配 `allowedBashCommands` 中的模式 → 跳过危险检测，直接放行。

**c. 危险模式检测**：以下 6 类内置模式命中且未被白名单豁免时，返回 `needsConfirm` 要求用户确认：

| 模式 | 示例 |
|---|---|
| `rm -rf` / `rm -fr` | `rm -rf node_modules` |
| `sudo` | `sudo systemctl restart` |
| `chmod 777` | `chmod -R 777 /var/www` |
| `mkfs` | `mkfs.ext4 /dev/sdb` |
| `dd ... of=` | `dd if=/dev/zero of=/dev/sda` |
| `git reset --hard` / `push --force` | `git push --force origin main` |

用户确认后，REPL 层附加 `__confirmedRisk: true` 重试即可执行。

### L3: 只读模式检查

`readonlyMode: true` 时，禁止以下写入工具：`write_file`、`edit_file`、`bash`。

```json
{ "readonlyMode": true }
```

### L4: 预算上限检查

`usdUsed >= budgetUsd` 时拒绝所有工具调用。由外部计费模块通过 `updateBudgetUsed()` 持续更新。

```json
{ "budgetUsd": 5.0 }
```

错误码：`BUDGET_EXCEEDED`

### L5: 路径边界检查

对文件操作工具（`read_file`、`write_file`、`edit_file`、`list_dir`）检查目标路径是否在允许范围内：

```
允许范围 = workdir ∪ ctx.allowedPaths ∪ securityPlugin.allowedPaths
```

判断逻辑（`isInsideCwd`）：将路径 normalize 后检查是否以基准目录为前缀。

路径越界时返回 `needsConfirm`：

```ts
{
  needsConfirm: {
    message: "Agent wants to access a path outside the working directory:\n  /etc/hosts\n\nAllow access to \"/etc\"?",
    allowDir: "/etc",
    retry: { name: "read_file", args: { path: "/etc/hosts" } }
  }
}
```

用户确认后调用 `securityPlugin.allowPath("/etc")`，该目录加入会话白名单。

错误码：`PATH_OUTSIDE_CWD`

### L6: 域名白名单检查

对网络工具（`web_search`、`fetch_url`）检查 URL 域名是否在 `allowedDomains` 内。支持精确匹配和子域名匹配（`sub.example.com` 匹配 `example.com`）。

```json
{ "allowedDomains": ["github.com", "api.anthropic.com"] }
```

未配置或空数组时不检查。非完整 URL（纯搜索词）和解析失败的 URL 自动放行。

### L7: Prompt Injection 检测

对所有字符串类型参数扫描以下注入模式（基于正则，启发式，非完整安全方案）：

| 模式 | 针对攻击 |
|---|---|
| `ignore previous instructions` | 指令覆盖 |
| `disregard (all\|your) (previous\|prior\|earlier)` | 历史擦除 |
| `you are now` | 角色劫持 |
| `new system prompt` | 提示词替换 |
| `SYSTEM: ` / `INSTRUCTION: ` | 伪系统/指令前缀 |

任一字符串参数命中即拒绝。

---

## 权限规则文件

### 加载与合并

Vera 从两个位置加载权限规则，取并集合并：

| 文件 | 作用域 |
|---|---|
| `~/.vera/permissions.json` | 全局（所有工程共享） |
| `<project>/.vera/permissions.json` | 项目级（当前工程） |

合并策略：同名数组字段=取并集（去重，不覆盖）。合并后数组为空则不限制。

### 文件格式

```json
{
  "allowedTools": ["read_file", "write_file", "edit_file", "list_dir", "search_code"],
  "deniedTools": ["bash", "sandbox_exec"],
  "allowedBashCommands": ["ls *", "git status", "git diff *", "npm test *"],
  "deniedBashCommands": ["rm *", "sudo *", "curl * | bash"]
}
```

### Glob 模式语法

Bash 命令规则使用简化版 glob：`*` 匹配任意字符序列、`?` 匹配单个字符，其余按字面量匹配。

| 模式 | 匹配 | 不匹配 |
|---|---|---|
| `ls *` | `ls -la`、`ls /tmp` | `lsa` |
| `rm -rf *` | `rm -rf node_modules` | `rm -r file` |
| `git push *` | `git push origin main` | `git push-force` |
| `chmod ??? *` | `chmod 755 script` | `chmod 644 something` |

---

## 配置示例

### 场景 1：开发环境（宽松）

```json
{
  "deniedTools": ["sandbox_exec"],
  "deniedBashCommands": ["rm -rf *", "sudo *", "mkfs.*"],
  "budgetUsd": 10.0
}
```

### 场景 2：代码审查（只读）

```json
{
  "readonlyMode": true,
  "allowedTools": ["read_file", "list_dir", "search_code", "grep", "web_search", "fetch_url"],
  "allowedDomains": ["github.com"],
  "budgetUsd": 2.0
}
```

### 场景 3：受限沙箱

```json
{
  "deniedTools": ["bash"],
  "allowedTools": ["read_file", "write_file", "edit_file", "list_dir", "search_code"],
  "allowedDomains": ["api.example.com"],
  "workdir": "/home/user/sandbox",
  "budgetUsd": 1.0
}
```

### 场景 4：代码方式初始化

```ts
import { SecurityPlugin } from "@open-vera/core";

const security = new SecurityPlugin({
  allowedTools: ["read_file", "write_file", "edit_file", "bash", "list_dir", "search_code"],
  deniedTools: ["sandbox_exec"],
  allowedBashCommands: ["npm *", "pnpm *", "git *", "ls *"],
  deniedBashCommands: ["rm -rf *", "sudo *", "git push --force *"],
  workdir: "/home/user/my-project",
  budgetUsd: 5.0,
});

security.updateBudgetUsed(1.23);      // 更新消费
security.allowPath("/etc/config");     // 用户确认后授权目录
```

### 场景 5：全局 + 项目级合并

全局 `~/.vera/permissions.json`：
```json
{ "deniedTools": ["sandbox_exec"], "deniedBashCommands": ["sudo *", "mkfs.*"] }
```

项目级 `my-project/.vera/permissions.json`：
```json
{ "deniedBashCommands": ["rm -rf *"], "allowedDomains": ["api.mycorp.com"] }
```

合并后：`deniedTools=["sandbox_exec"]`、`deniedBashCommands=["sudo *","mkfs.*","rm -rf *"]`、`allowedDomains=["api.mycorp.com"]`

---

## 错误码速查

| 错误码 | 触发层 | 含义 |
|---|---|---|
| `PERMISSION_DENIED` | L0, L1, L2, L3, L6, L7 | 权限规则拒绝 |
| `PATH_OUTSIDE_CWD` | L5 | 文件路径超出允许范围 |
| `BUDGET_EXCEEDED` | L4 | 消费超过预算上限 |

所有权限错误在 `ToolResult.error` 中标记 `retryable: true`，表示通过 `allowPath` 或用户确认后可以重试。

---

## 设计要点

1. **黑名单优先于白名单**：L0 在 L1 之前执行，同一工具在黑白名单并存时黑名单生效。
2. **Bash 三重保护**：静态 deny 规则 → 静态 allow 豁免 → 运行时危险检测 + 用户确认。
3. **路径纵深防御**：配置 `workdir` + 会话 `allowedPaths` + 用户 `allowPath()` 三者取并集。
4. **Prompt Injection 是辅助防线**：L7 的简单正则可能产生误报（如代码注释中含 "ignore"），不应作为唯一安全保障。
5. **预算检查在路径检查之前**：确保超预算时不触发不必要的路径确认交互。

---

## 相关文件

| 文件 | 说明 |
|---|---|
| `packages/core/src/tools/security.ts` | SecurityPlugin 实现 |
| `packages/core/src/tools/permission-rules.ts` | 规则文件加载与合并、glob 匹配 |
| `packages/core/src/tools/utils/path.ts` | `isInsideCwd` 路径边界判断 |
| `packages/core/src/tools/types.ts` | `ToolLifecycleHook`、`ToolResult`、`ToolContext` |
