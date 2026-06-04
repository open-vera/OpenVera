# Logger 包文档

> Package: `@open-vera/logger` | Source: `packages/logger/src/index.ts`
> 最后更新: 2025-06-04

## 概述

`@open-vera/logger` 是 OpenVera monorepo 的统一日志包，为 `core` 和 `harness` 提供结构化日志能力。零外部依赖，仅使用 Node.js 内置模块（`fs`、`os`、`path`），支持多级日志过滤、敏感数据自动脱敏、stderr + 文件双通道输出，通过环境变量控制行为。

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
log.error("不可恢复的错误", { code: "FATAL", stack: error.stack });

const agentLog = log.child("agent");
agentLog.debug("tool调用开始", { tool: "read_file" });
// 输出: [core:agent] tool调用开始

// 支持任意深度嵌套
createLogger("a").child("b").child("c").info("deep");
// 输出: [a:b:c] deep
```

---

## LogLevel 与级别过滤

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";
```

内部权重映射：`debug=0, info=1, warn=2, error=3`。日志条目权重 **>=** 当前配置级别时才输出。

| Level | 权重 | 适用场景 |
|---|---|---|
| `debug` | 0 | 开发调试信息 |
| `info`  | 1 | 常规运行信息（默认级别） |
| `warn`  | 2 | 需关注但不阻塞的警告 |
| `error` | 3 | 异常和错误 |

---

## 日志级别解析

`getConfiguredLevel()` 按优先级确定当前级别：

1. **`VERA_LOG_LEVEL`**（最高）—— 显式设置 `debug`/`info`/`warn`/`error` 之一
2. **`NODE_ENV`**—— `production` → `info`，`development` → `debug`
3. **默认** `info`

级别在首次调用时解析并缓存。使用 `resetLogLevel()` 清除缓存，强制重新读取环境变量——主要用于测试。

```typescript
import { resetLogLevel } from "@open-vera/logger";

process.env["VERA_LOG_LEVEL"] = "error";
resetLogLevel();
// 后续仅输出 error 级别
```

使用示例：

```bash
NODE_ENV=production node app.js          # 仅 info 及以上
VERA_LOG_LEVEL=error node app.js         # 仅 error
NODE_ENV=production VERA_LOG_LEVEL=debug node app.js  # VERA_LOG_LEVEL 覆盖 NODE_ENV
```

---

## LogEntry 结构

```typescript
export interface LogEntry {
  timestamp: string;    // ISO 8601，如 "2025-06-04T14:30:00.000Z"
  level: LogLevel;
  name: string;         // Logger 名称，如 "core:agent:tool"
  message: string;
  meta?: Record<string, unknown>;  // 可选元数据（已脱敏）
}
```

stderr 输出格式：

```
2025-06-04T14:30:00.000Z INFO  [core:agent] 模型调用完成 {"model":"claude-sonnet","tokens":1536}
```

文件输出为纯 JSON 行：

```json
{"timestamp":"2025-06-04T14:30:00.000Z","level":"info","name":"core:agent","message":"模型调用完成","meta":{"model":"claude-sonnet","tokens":1536}}
```

---

## 敏感数据脱敏

### SENSITIVE_KEY_PATTERN

```typescript
const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(api[_-]?key|token|secret|password|passwd|authorization|credential|private[_-]?key)($|[_-])/i;
```

匹配的键（不区分大小写，支持分隔符变体）：`apiKey`、`access_token`、`client_secret`、`password`、`Authorization`、`private_key` 等。匹配到的值替换为 `"[REDACTED]"`，嵌套对象中的敏感字段同样被脱敏。

### sanitizeForLog

```typescript
export function sanitizeForLog(value: unknown, maxStringLength?: number): unknown;
```

递归处理任意值，确保可安全写入日志：

| 输入类型 | 处理方式 |
|---|---|
| 字符串 | 超过 `maxStringLength`（默认 1000）则截断 |
| 原始类型（number/boolean/null/undefined） | 原样返回 |
| BigInt / Symbol | 转字符串 |
| Function | 替换为 `"[Function]"` |
| Error | 提取 `{ name, message, stack }`，message/stack 截断 |
| Date | 转 ISO 字符串 |
| Uint8Array | 替换为 `[Uint8Array N bytes]` |
| Array | 保留前 20 项，超出标记 `[... N more items]` |
| Object | 保留前 50 个键，超出标记 `__truncated_keys` |
| 嵌套 | 最深 5 层，超出返回 `"[MaxDepth]"` |
| 循环引用 | `WeakSet` 跟踪，检测到返回 `"[Circular]"` |

### truncateForLog

```typescript
export function truncateForLog(text: string, maxChars?: number): string;
```

超过 `maxChars`（默认 1000，可由 `VERA_LOG_PREVIEW_CHARS` 配置）时截断并追加 `"…[truncated N chars]"`。

### previewForLog

```typescript
export function previewForLog(value: unknown, maxStringLength?: number): string;
```

先 `sanitizeForLog` 再 JSON 序列化再截断，是输出日志预览的便捷入口。

---

## 传输通道

### stderr 输出

写入 `process.stderr`，格式为一人类可读行。级别标签右填充至 5 字符对齐：

```
2025-06-04T14:30:00.000Z DEBUG [core:config] 加载配置文件
2025-06-04T14:30:00.001Z INFO  [core:config] 配置加载完成 {"file":".vera/settings.json"}
2025-06-04T14:30:00.002Z WARN  [core:adapter] 模型响应超时 {"model":"claude-sonnet","timeout":30000}
2025-06-04T14:30:00.003Z ERROR [core:loop] Agent 循环异常 {"code":"LOOP_MAX_CYCLES"}
```

### 文件输出

日志目录解析顺序：

1. `VERA_LOG_DIR`（最高优先级）
2. `{VERA_CONFIG_DIR}/logs`
3. `{VERA_HOME}/.vera/logs`（默认，`VERA_HOME` 未设时回退到 `$HOME`）

目录首次写入时自动创建（含递归父目录）。文件名：`vera-YYYY-MM-DD-HH.log`，每小时滚动。

```
~/.vera/logs/
  vera-2025-06-04-14.log
  vera-2025-06-04-15.log
  vera-2025-06-04-16.log
```

文件内容为每行一条 JSON 格式的 `LogEntry`，可用 `jq` 等工具解析：

```bash
tail -100 ~/.vera/logs/vera-2025-06-04-14.log | jq 'select(.level=="error")'
cat ~/.vera/logs/vera-2025-06-04-14.log | jq -r '.level' | sort | uniq -c
```

写入失败（磁盘满、权限不足）静默丢弃，不抛异常。

---

## createLogger 工厂

```typescript
export function createLogger(name: string): Logger;
```

创建 `LoggerImpl` 实例。`name` 出现在日志输出的 `[name]` 字段中。

```typescript
import { createLogger } from "@open-vera/logger";

const log = createLogger("my-module");
log.debug("初始化完成");
log.info("处理请求", { requestId: "abc-123" });
log.warn("配置项缺失", { key: "timeout", default: 30000 });
```

---

## 配置参考

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `VERA_LOG_LEVEL` | 显式设置日志级别 | 由 NODE_ENV 推断 |
| `VERA_LOG_DIR` | 日志文件输出目录 | `~/.vera/logs/` |
| `VERA_CONFIG_DIR` | 配置目录，日志写入 `{dir}/logs` | 无 |
| `VERA_HOME` | Vera 主目录 | `$HOME` |
| `VERA_LOG_PREVIEW_CHARS` | 字符串截断阈值（字符数） | 1000 |
| `NODE_ENV` | production → info, development → debug | info |

---

## 消费方

| 包 | 用途 |
|---|---|
| `@open-vera/core` | Agent 循环、适配器、工具注册、配置加载等核心模块的日志 |
| `@open-vera/harness` | 运行时、计划器、Flow 状态机等编排层模块的日志 |
