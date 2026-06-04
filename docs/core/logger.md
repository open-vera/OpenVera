# Logger 包文档

> Package: `@open-vera/logger` | Source: `packages/logger/src/index.ts`
> 最后更新: 2025-06-04

## 概述

`@open-vera/logger` 是 OpenVera monorepo 的统一日志包，为 `core` 和 `harness` 提供结构化日志能力。它提供一套轻量、零依赖的 Logger 实现，支持多级日志过滤、敏感数据自动脱敏、双通道输出（stderr + 文件），并通过环境变量控制行为——无需配置文件即可在生产环境和开发环境之间切换。

核心设计原则：

- **零外部依赖**：仅使用 Node.js 内置模块（`fs`、`os`、`path`）
- **结构化输出**：每条日志均为 JSON 格式的 `LogEntry`，便于机器解析
- **自动脱敏**：识别 API Key、Token、Password 等敏感字段并替换为 `[REDACTED]`
- **按小时滚动**：文件名包含时间戳（`vera-YYYY-MM-DD-HH.log`），自然切分

---

## Logger 接口

```typescript
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(name: string): Logger;
}
```

每个方法接收一条消息和可选的结构化元数据。`child()` 创建子 Logger，名称以冒号分隔继承父名。

```typescript
const log = createLogger("core");
log.info("模型调用完成", { model: "claude-sonnet-4-20250514", tokens: 1536 });

const agentLog = log.child("agent");
agentLog.debug("tool调用开始", { tool: "read_file" });
// 输出: [core:agent] tool调用开始
```

子 Logger 支持任意深度嵌套：

```typescript
createLogger("a").child("b").child("c").info("deep");
// 输出: [a:b:c] deep
```

---

## LogLevel 定义

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";
```

级别权重映射（高权重表示更严重）：

| Level | 权重 | 用途 |
|---|---|---|
| `debug` | 0 | 开发调试信息，默认在非 production 环境输出 |
| `info` | 1 | 常规运行信息，production 环境默认级别 |
| `warn` | 2 | 警告信息，需关注但不阻塞流程 |
| `error` | 3 | 错误信息，通常伴随异常 |

日志级别过滤规则：当日志条目的权重 **大于或等于** 当前配置级别时，该条目才会被输出。

---

## 日志级别解析

`getConfiguredLevel()` 按以下优先级确定当前级别：

1. **`VERA_LOG_LEVEL` 环境变量**（最高优先级）：显式设置为 `debug`/`info`/`warn`/`error` 之一
2. **`NODE_ENV` 环境变量**：`production` -> `info`；`development` -> `debug`
3. **默认值**：`info`

```
VERA_LOG_LEVEL  (显式)   → 直接使用（值必须在 LEVEL_WEIGHT 中存在）
  ↓ 未设置或无效
NODE_ENV        (推断)   → production → info / development → debug
  ↓ 未设置
默认值           (兜底)   → info
```

示例：

```bash
# 开发环境输出所有日志（含 debug）
NODE_ENV=development node app.js

# 生产环境只输出 info 及以上
NODE_ENV=production node app.js

# 显式设置为 error，只输出 error
VERA_LOG_LEVEL=error node app.js

# VERA_LOG_LEVEL 覆盖 NODE_ENV
NODE_ENV=production VERA_LOG_LEVEL=debug node app.js
```

级别在首次调用 `getLevel()` 时解析并缓存。使用 `resetLogLevel()` 可强制下一次调用重新解析环境变量——主要用于测试场景。

```typescript
import { resetLogLevel } from "@open-vera/logger";

// 测试用例中切换日志级别
process.env["VERA_LOG_LEVEL"] = "error";
resetLogLevel();
// 后续 log 调用使用 error 级别
```

---

## LogEntry 结构

每条日志输出为以下结构的 JSON 行：

```typescript
export interface LogEntry {
  timestamp: string;    // ISO 8601 格式，例如 "2025-06-04T14:30:00.000Z"
  level: LogLevel;      // "debug" | "info" | "warn" | "error"
  name: string;         // Logger 名称，如 "core:agent:tool"
  message: string;      // 日志消息正文
  meta?: Record<string, unknown>;  // 可选结构化元数据（已脱敏）
}
```

stderr 输出格式为：

```
2025-06-04T14:30:00.000Z INFO  [core:agent] 模型调用完成 {"model":"claude-sonnet-4-20250514","tokens":1536}
```

文件输出为纯 JSON 行（每行一条 `LogEntry`）：

```json
{"timestamp":"2025-06-04T14:30:00.000Z","level":"info","name":"core:agent","message":"模型调用完成","meta":{"model":"claude-sonnet-4-20250514","tokens":1536}}
```

---

## 结构化日志与脱敏

### 敏感字段匹配

Logger 在输出 meta 之前自动调用 `sanitizeForLog()` 对元数据进行脱敏。敏感字段由正则 `SENSITIVE_KEY_PATTERN` 匹配：

```typescript
const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(api[_-]?key|token|secret|password|passwd|authorization|credential|private[_-]?key)($|[_-])/i;
```

匹配规则覆盖以下键名（不区分大小写，支持下划线/连字符分隔）：

| 匹配类别 | 示例键名 |
|---|---|
| API Key | `apiKey`, `api_key`, `API-KEY`, `x-api-key` |
| Token | `token`, `access_token`, `refresh-token` |
| Secret | `secret`, `client_secret`, `secret_key` |
| Password | `password`, `passwd` |
| Authorization | `authorization`, `Authorization` |
| Credential | `credential`, `credentials` |
| Private Key | `privateKey`, `private_key` |

匹配的字段值被替换为 `"[REDACTED]"`，嵌套对象中的敏感字段同样被脱敏。

### sanitizeForLog 函数

```typescript
export function sanitizeForLog(value: unknown, maxStringLength?: number): unknown;
```

对任意值进行安全化处理，使其可安全写入日志：

- **字符串**：超过 `maxStringLength`（默认 1000）则截断
- **原始类型**（number, boolean, null, undefined）：原样返回
- **BigInt / Symbol**：转为字符串
- **Function**：替换为 `"[Function]"`
- **Error**：提取 `{ name, message, stack }`，对 message 和 stack 做截断
- **Date**：转为 ISO 字符串
- **Uint8Array**：替换为 `[Uint8Array N bytes]`
- **Array**：保留前 20 项（`MAX_ARRAY_ITEMS`），超出部分标记 `[... N more items]`
- **Object**：保留前 50 个键（`MAX_OBJECT_KEYS`），超出标记 `__truncated_keys`
- **嵌套深度**：最深 5 层（`MAX_DEPTH`），超出返回 `"[MaxDepth]"`
- **循环引用**：使用 `WeakSet` 跟踪，检测到循环返回 `"[Circular]"`

### truncateForLog 函数

```typescript
export function truncateForLog(text: string, maxChars?: number): string;
```

若字符串长度超过 `maxChars`（默认 1000，可通过 `VERA_LOG_PREVIEW_CHARS` 配置），则截断并在末尾追加截断信息：

```
"这是一段很长的文本…[truncated 5000 chars]"
```

### previewForLog 函数

```typescript
export function previewForLog(value: unknown, maxStringLength?: number): string;
```

将任意值转换为适合日志预览的字符串表示。内部先对值执行 `sanitizeForLog()` 再 JSON 序列化，最后截断。这是输出日志预览的便捷入口。

---

## 传输通道

### stderr 输出

所有日志写入 `process.stderr`，格式化为一行人类可读的文本：

```
{timestamp} {LEVEL} [{name}] {message} {meta_json}
```

级别标签右填充至 5 字符宽度，保证对齐：

```
2025-06-04T14:30:00.000Z DEBUG [core:config] 加载配置文件
2025-06-04T14:30:00.001Z INFO  [core:config] 配置加载完成 {"file":".vera/settings.json"}
2025-06-04T14:30:00.002Z WARN  [core:adapter] 模型响应超时 {"model":"claude-sonnet","timeout":30000}
2025-06-04T14:30:00.003Z ERROR [core:loop] Agent 循环异常 {"code":"LOOP_MAX_CYCLES"}
```

### 文件输出

日志同时写入文件系统。文件路径解析顺序：

1. **`VERA_LOG_DIR` 环境变量**（最高优先级）：直接作为日志目录
2. **`VERA_CONFIG_DIR` 环境变量**：取 `{VERA_CONFIG_DIR}/logs`
3. **`VERA_HOME` 环境变量或 `$HOME`**：取 `{VERA_HOME}/.vera/logs`

日志目录在首次写入时自动创建（含递归父目录）。文件名格式为：

```
vera-YYYY-MM-DD-HH.log
```

每小时自动切换新文件。例如：

```
~/.vera/logs/
  vera-2025-06-04-14.log
  vera-2025-06-04-15.log
  vera-2025-06-04-16.log
```

文件内容为每行一条 JSON 格式的 `LogEntry`，便于后续使用 `jq` 或其他工具解析：

```bash
# 查看最近 10 条错误日志
tail -100 ~/.vera/logs/vera-2025-06-04-14.log | jq 'select(.level=="error")'

# 统计各级别日志数量
cat ~/.vera/logs/vera-2025-06-04-14.log | jq -r '.level' | sort | uniq -c
```

文件写入失败（如磁盘满、权限不足）不会抛出异常，静默丢弃该条日志，保证应用正常运行。

---

## createLogger 工厂函数

```typescript
export function createLogger(name: string): Logger;
```

创建并返回一个 `Logger` 实例。`name` 参数用于标识日志来源，出现在日志输出的 `[name]` 字段中。

```typescript
import { createLogger } from "@open-vera/logger";

const log = createLogger("my-module");
log.debug("初始化完成");
log.info("处理请求", { requestId: "abc-123" });
log.warn("配置项缺失，使用默认值", { key: "timeout", default: 30000 });
log.error("不可恢复的错误", { code: "FATAL", stack: error.stack });
```

内部实现为 `LoggerImpl` 类，每个实例持有自己的 `name` 字段。调用 `child()` 时创建新的 `LoggerImpl`，名称拼接为 `parent:child`。

---

## resetLogLevel 工具函数

```typescript
export function resetLogLevel(): void;
```

清除缓存的日志级别和文件路径，强制下一次 `getLevel()` 或文件写入重新读取环境变量。主要用于测试场景，允许同一进程内切换日志配置。

```typescript
// 测试用例切换日志级别
process.env["VERA_LOG_LEVEL"] = "error";
resetLogLevel();
// 后续调用仅输出 error 级别
```

---

## 配置参考

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `VERA_LOG_LEVEL` | 显式设置日志级别（debug/info/warn/error） | 由 NODE_ENV 推断 |
| `VERA_LOG_DIR` | 日志文件输出目录 | `~/.vera/logs/` |
| `VERA_CONFIG_DIR` | 配置目录，日志写入 `{dir}/logs` | 无 |
| `VERA_HOME` | Vera 主目录，日志写入 `{dir}/.vera/logs` | `$HOME` |
| `VERA_LOG_PREVIEW_CHARS` | 字符串截断阈值（字符数） | 1000 |
| `NODE_ENV` | production → info, development → debug | info |

---

## 依赖方

| 包 | 用途 |
|---|---|
| `@open-vera/core` | Agent 循环、适配器、工具注册、配置加载等核心模块的日志输出 |
| `@open-vera/harness` | 运行时、计划器、Flow 状态机等编排层模块的日志输出 |
