# 权限系统 (Permission System)

Vera 的权限系统通过 `SecurityPlugin` 实现，在每次工具调用前执行多层安全检查，形成纵深防御体系。

---

## 架构

```
Agent 请求工具调用
       │
       ▼
┌──────────────────────────────────────┐
│   SecurityPlugin.onBeforeToolCall    │
│                                      │
│  L0: 黑名单（deniedTools）—— 最高优先级 │
│  L1: 白名单（allowedTools）            │
│  L2: Bash 命令安全检查                 │
│  L3: 只读模式                         │
│  L4: 预算上限                         │
│  L5: 路径边界                         │
│  L6: 域名白名单                        │
│  L7: Prompt Injection 检测            │
│                                      │
│  全部通过 → null（放行）               │
│  拒绝     → ToolResult（含错误码）     │
│  需确认   → needsConfirm（等待用户）    │
└──────────────────────────────────────┘
```

核心模块：
- `packages/core/src/tools/security.ts` — SecurityPlugin 实现
- `packages/core/src/tools/permission-rules.ts` — 规则文件加载与合并
- `packages/core/src/tools/utils/path.ts` — 路径边界判断

---

## SecurityPlugin 接口

```typescript
class SecurityPlugin implements ToolLifecycleHook {
  constructor(config: SecurityConfig = {});

  // 核心拦截方法。返回 null=放行，返回 ToolResult=拒绝/需确认
  async onBeforeToolCall(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult | null>;

  // 运行时动态授权目录（用户确认后调用）
  allowPath(dir: string): void;

  // 更新已消费金额（由计费模块持续调用）
  updateBudgetUsed(usdUsed: number): void;
}
```

### SecurityConfig 配置字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `allowedTools` | `string[]` | 工具白名单。空数组或未配置 = 全部允许 |
| `deniedTools` | `string[]` | 工具黑名单。优先级高于白名单 |
| `allowedBashCommands` | `string[]` | Bash 命令白名单规则（glob-like 模式） |
| `deniedBashCommands` | `string[]` | Bash 命令黑名单规则（glob-like 模式） |
| `workdir` | `string` | 文件操作的基准路径。默认取 `ctx.cwd` |
| `allowedDomains` | `string[]` | 网络工具（web_search, fetch_url）的域名白名单 |
| `readonlyMode` | `boolean` | 禁止所有写操作 |
| `budgetUsd` | `number` | 费用上限（USD） |
| `usdUsed` | `number` | 已使用费用（外部实时更新） |

---

## 各层详解

### L0: 黑名单（最高优先级）

工具名在 `deniedTools` 中直接拒绝，不受白名单影响。返回 `PERMISSION_DENIED` 错误。

```json
{ "deniedTools": ["bash", "sandbox_exec"] }
```

### L1: 白名单

配置了 `allowedTools` 且数组非空时，仅列表中的工具允许执行。未配置或空数组 = 全部允许。

```json
{ "allowedTools": ["read_file", "write_file", "edit_file", "list_dir", "grep"] }
```

注意：L0 已拒绝的工具不会被白名单"复活"。

### L2: Bash 命令安全检查

分三层检查：

**(a) 黑名单匹配** — 命令匹配 `deniedBashCommands` glob 模式，直接拒绝。

**(b) 白名单匹配** — 命令匹配 `allowedBashCommands` glob 模式，跳过危险检测直接放行。

**(c) 危险模式检测** — 以下 6 类硬编码正则匹配到，且未取得白名单豁免 → 返回 `needsConfirm`：

| 模式 | 正则 | 示例 |
|---|---|---|
| 递归强制删除 | `rm\s+(-[^\s]*[rf]\|-[^\s]*[fr])` | `rm -rf node_modules` |
| 提权操作 | `sudo` | `sudo systemctl restart` |
| 世界可写 | `chmod\s+(-R\s+)?777` | `chmod -R 777 /var/www` |
| 格式化文件系统 | `mkfs` | `mkfs.ext4 /dev/sdb` |
| 磁盘覆写 | `dd\s+.*\bof=` | `dd if=/dev/zero of=/dev/sda` |
| 破坏性 git 操作 | `git\s+(reset\s+--hard\|clean\s+-[^\s]*f\|push\s+--force)` | `git push --force origin main` |

用户确认后 REPL 层附加 `__confirmedRisk: true` 标记重试即可。

### L3: 只读模式

`readonlyMode: true` 时，禁止以下写入工具：`write_file`、`edit_file`、`bash`。

```json
{ "readonlyMode": true }
```

### L4: 预算上限

`usdUsed >= budgetUsd`（且两者均已配置）时，拒绝所有工具调用。返回 `BUDGET_EXCEEDED` 错误码。

```json
{ "budgetUsd": 5.0 }
```

```typescript
// 计费模块持续更新
security.updateBudgetUsed(currentTotalCost);
```

### L5: 路径边界

文件操作工具（`read_file`、`write_file`、`edit_file`、`list_dir`）检查目标路径是否在允许范围：

```
允许范围 = workdir ∪ ctx.allowedPaths ∪ securityPlugin.allowedPaths
```

1. **workdir 检查**：以配置的 `workdir`（或默认 `ctx.cwd`）为基准，检查路径是否在其子目录内
2. **动态白名单检查**：检查路径是否落在 `allowPath()` 授权过的目录内
3. **越界处理**：若两处都不在范围内，返回 `PATH_OUTSIDE_CWD` 错误并携带 `needsConfirm` 请求用户授权

越界时用户确认后调用 `security.allowPath(dir)`，该目录加入会话白名单。

路径解析使用 `path.resolve(ctx.cwd, pathArg)`，确保相对路径正确转换。`isInsideCwd` 函数将两个路径 normalize 后检查是否以前缀开始。

### L6: 域名白名单

对 `web_search`、`fetch_url` 等网络工具，检查目标域名是否在 `allowedDomains` 内。

- 匹配规则：精确匹配（`domain === allowedDomain`）或子域名匹配（`domain.endsWith("." + allowedDomain)`）
- 非完整 URL 的输入（如搜索查询词）自动豁免
- URL 解析失败也自动放行

```json
{ "allowedDomains": ["github.com", "api.anthropic.com", "docs.rs"] }
```

### L7: Prompt Injection 检测

对字符串类型参数扫描 6 组内置注入模式，匹配任一即拒绝，返回 `PERMISSION_DENIED` 错误：

| 模式 | 攻击类型 |
|---|---|
| `ignore previous instructions` | 指令覆盖 |
| `disregard (all\|your) (previous\|prior\|earlier)` | 历史擦除 |
| `you are now` | 角色劫持 |
| `new system prompt` | 提示词替换 |
| `SYSTEM: ` | 伪系统前缀 |
| `INSTRUCTION: ` | 伪指令前缀 |

这是基于正则的启发式检测，非完整安全方案。可能产生误报（如代码文档中含有匹配文本）。将此层放在最后，优先使用结构化的前六层做防御。

---

## 权限规则文件

### 加载与合并

从两个位置加载 JSON 规则，取并集合并：

| 路径 | 作用域 |
|---|---|
| `~/.vera/permissions.json` | 全局（所有项目共享） |
| `<project>/.vera/permissions.json` | 项目级（当前项目专用） |

合并策略：四个数组字段各自取并集（去重追加，不覆盖）。合并后数组为空则不限制。

```typescript
// 加载合并后的规则
import { loadPermissionRules } from "@open-vera/core";

const rules = loadPermissionRules("/path/to/project");
// → { allowedTools?, deniedTools?, allowedBashCommands?, deniedBashCommands? }
```

### 文件格式

```json
{
  "allowedTools": ["read_file", "write_file", "edit_file", "list_dir", "grep"],
  "deniedTools": ["bash", "sandbox_exec"],
  "allowedBashCommands": ["ls *", "git status", "git diff *"],
  "deniedBashCommands": ["rm *", "sudo *", "curl * | bash"]
}
```

### Glob 语法

Bash 命令规则使用简化版 glob：`*` 匹配任意字符序列，`?` 匹配单个字符。内部转换为正则后匹配。

| 模式 | 匹配 | 不匹配 |
|---|---|---|
| `ls *` | `ls -la`、`ls /tmp` | `lsa` |
| `rm -rf *` | `rm -rf node_modules` | `rm -r file` |
| `git push *` | `git push origin main` | `git push-force` |
| `npm test*` | `npm test`、`npm test:coverage` | `npm test`(完全相同的变体) |

---

## 错误码速查

| 错误码 | 触发层 | 说明 |
|---|---|---|
| `PERMISSION_DENIED` | L0, L1, L2a, L3, L6, L7 | 权限规则拒绝 |
| `PATH_OUTSIDE_CWD` | L5 | 路径超出允许范围 |
| `BUDGET_EXCEEDED` | L4 | 消费超预算 |

所有拒绝错误 `retryable: true`。`needsConfirm` 中包含 `retry` 字段（重新调用的参数），用户确认后带上放行标记重试。

---

## 配置示例

### 开发环境（宽松）

```typescript
new SecurityPlugin({
  deniedTools: ["sandbox_exec"],
  deniedBashCommands: ["rm -rf *", "sudo *", "mkfs.*"],
  budgetUsd: 10.0,
});
```

### 代码审查（只读）

```typescript
new SecurityPlugin({
  readonlyMode: true,
  allowedTools: ["read_file", "list_dir", "grep", "glob", "web_search", "fetch_url"],
  allowedDomains: ["github.com"],
  budgetUsd: 2.0,
});
```

### 受限沙箱

```typescript
new SecurityPlugin({
  deniedTools: ["bash"],
  allowedTools: ["read_file", "write_file", "edit_file", "list_dir", "grep"],
  allowedDomains: ["api.example.com"],
  workdir: "/home/user/sandbox",
  budgetUsd: 1.0,
});
```

### 全局 + 项目合并示例

全局 `~/.vera/permissions.json`：
```json
{
  "deniedTools": ["sandbox_exec"],
  "deniedBashCommands": ["sudo *", "mkfs.*"]
}
```

项目 `.vera/permissions.json`：
```json
{
  "deniedBashCommands": ["rm -rf *"],
  "allowedDomains": ["api.mycorp.com"]
}
```

合并后：`deniedTools=["sandbox_exec"]`、`deniedBashCommands=["sudo *","mkfs.*","rm -rf *"]`、`allowedDomains=["api.mycorp.com"]`

---

## 设计要点

1. **黑名单优先于白名单**：L0 在 L1 之前，同一工具同时出现在黑白名单时，黑名单生效
2. **Bash 三重保护**：静态 deny 模式 → 静态 allow 豁免 → 运行时危险检测 + 用户确认
3. **路径纵深防御**：`workdir` + 会话 `allowedPaths` + 用户 `allowPath()` 三者取并集
4. **Prompt Injection 是辅助防线**：启发式检测可能产生误报，不依赖它作为唯一安全保障
5. **预算检查在路径检查之前**：超预算时直接拦截，不触发不必要的路径确认交互
