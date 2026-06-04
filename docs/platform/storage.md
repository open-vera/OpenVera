# 存储架构

> 本文档描述 OpenVera 的持久化存储体系，包括 SQLite 存储引擎、数据模型、迁移策略和性能设计。

## 概述

OpenVera 的存储层提供统一的 key-value 抽象接口，支持多种后端实现。当前主力后端为 SQLite（基于 `better-sqlite3`），提供 WAL 模式、FTS5 全文搜索、TTL 过期和事务支持。

核心代码位于 `packages/core/src/storage/`。

## 架构层次

```
Session / Memory / UserData  (业务层)
        ↓
SessionStorageAdapter / MemoryStorageAdapter / UserDataStore  (适配层)
        ↓
SqliteStorageProvider / FileStorageProvider  (引擎层)
        ↓
better-sqlite3 / fs  (底层)
```

- **引擎层**（`StorageProvider` 接口）：统一的 key-value CRUD + 查询 + 事务抽象
- **适配层**：将业务数据模型（Session、Memory、UserData）映射到 key-value 存储
- **业务层**：`SessionStore`、`MemoryStore` 等对外接口

## 核心接口：StorageProvider

```typescript
// packages/core/src/storage/types.ts
export interface StorageProvider {
  readonly name: string;
  initialize(): Promise<void>;
  close(): Promise<void>;
  isHealthy(): boolean;

  // 基础 KV 操作
  set(namespace: string, key: string, value: StorageValue): Promise<void>;
  get(namespace: string, key: string): Promise<StorageValue | undefined>;
  has(namespace: string, key: string): Promise<boolean>;
  delete(namespace: string, key: string): Promise<boolean>;
  listKeys(namespace: string): Promise<string[]>;
  clear(namespace: string): Promise<void>;

  // 批量操作
  setMany(namespace: string, entries: Array<{ key: string; value: StorageValue }>): Promise<void>;
  getMany(namespace: string, keys: string[]): Promise<Array<{ key: string; value: StorageValue | undefined }>>;

  // 查询
  query(namespace: string, filter: StorageQuery): Promise<StorageQueryResult>;
  count(namespace: string, filter?: StorageQuery): Promise<number>;

  // 事务
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>;
}
```

所有后端实现此接口。命名空间（namespace）用于逻辑分区，如 `sessions`、`memories`、`user-data`。

## SQLite 引擎：SqliteStorageProvider

### 表结构

```sql
CREATE TABLE IF NOT EXISTS kv_entries (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,     -- JSON 序列化
  created_at TEXT NOT NULL,     -- ISO-8601
  updated_at TEXT NOT NULL,     -- ISO-8601
  ttl        INTEGER,           -- 过期时间（秒），NULL 表示永不过期
  tags       TEXT,              -- JSON 数组
  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_kv_ns ON kv_entries(namespace);
CREATE INDEX IF NOT EXISTS idx_kv_created ON kv_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv_entries(updated_at);
```

### FTS5 全文搜索（可选）

启用 `enableFts` 后创建：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS kv_fts USING fts5(
  namespace, key, value,
  content='kv_entries',
  content_rowid='rowid'
);
```

通过触发器自动同步：INSERT / DELETE / UPDATE 主表时自动更新 FTS 索引。

### 性能配置

构造函数中自动设置的 pragma：

```typescript
// WAL 模式：允许并发读写，提升写入性能
this.db.pragma("journal_mode = WAL");

// 忙等待 5 秒：应对锁冲突（better-sqlite3 默认是立即失败）
this.db.pragma("busy_timeout = 5000");

// NORMAL 同步：在安全性和性能间折中（WAL 下 FULL 不是必需的）
this.db.pragma("synchronous = NORMAL");
```

`StorageOptions` 支持的可选配置：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `walMode` | `true` | 启用 WAL 模式 |
| `enableFts` | `false` | 启用 FTS5 全文搜索 |
| `autoVacuum` | `false` | 启用自动回收空间 |
| `cacheSize` | - | SQLite 缓存页面数 |
| `maxSize` | - | 数据库文件最大大小（字节） |

### 查询能力

`StorageQuery` 支持的过滤条件：

```typescript
interface StorageQuery {
  tags?: string[];           // 精确标签匹配（AND 逻辑）
  createdAfter?: string;     // ISO 时间戳
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  hasTtl?: boolean;          // 是否有 TTL
  keyPrefix?: string;        // 键前缀匹配（LIKE）
  keyPattern?: string;       // 键 glob 匹配
  fullTextSearch?: string;   // FTS5 全文搜索（需 enableFts）
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt" | "key";
  order?: "asc" | "desc";
}
```

### 同步 API

SQLite 引擎额外提供同步方法（绕过 async 包装），供 `SQLiteSessionBackend` 在同步接口中使用：

```typescript
setSync(namespace, key, value): void
getSync(namespace, key): StorageValue | undefined
listKeysSync(namespace): string[]
```

这些方法直接操作 `better-sqlite3` 的同步 API，适合不需要事务隔离的快速读取场景。

### TTL 与自动清理

- 每条记录可将 `ttl` 设置为秒数
- 定时器每 60 秒扫描一次过期记录并自动删除
- 查询时也会过滤已过期的记录（`isExpired()` 检查）
- 定时器使用 `unref()` 不会阻止进程退出

### 事务

```typescript
await storage.transaction(async (tx) => {
  tx.set("sessions", "id-1", sessionData);
  tx.delete("sessions", "id-2");
  // 事务自动提交；如果抛出异常则回滚
});
```

事务实现使用 `better-sqlite3` 的 `db.transaction()`，自动管理 commit/rollback。事务对象提供 `set`、`get`、`delete` 方法。

## 数据模型

### 会话存储（Session）

由 `SessionStorageAdapter` 管理，存储在 `sessions` namespace 下。

```typescript
interface StoredSession {
  sessionId: string;
  content: string;         // 完整的 JSONL 内容
  createdAt: string;
  updatedAt: string;
  metadata: SessionMetadata;
}

interface SessionMetadata {
  model?: string;
  provider?: string;
  cwd?: string;
  turnCount?: number;
  totalCostUsd?: number;
  tags?: string[];
  firstPrompt?: string;    // 首条用户 prompt（用于搜索）
  title?: string;          // AI 或用户自定义标题
}
```

**设计要点**：SQLite 后端保留完整 JSONL `content` 字段，确保向下兼容。metadata 从 content 中提取并冗余存储，用于快速索引和过滤，无需解析 JSONL。

### 记忆存储（Memory）

存储在 `memories` namespace 下，分三个 tier：

```typescript
interface StoredMemory {
  id: string;
  tier: "working" | "episodic" | "semantic";
  content: string;
  tags: string[];
  importance: number;          // 重要性评分（0-1）
  source?: string;             // 来源 session ID
  createdAt: string;
  updatedAt: string;
  accessCount?: number;        // 访问次数（用于衰减）
  lastAccessedAt?: string;     // 最后访问时间
  taskSummary?: string;        // episodic 专用
  outcome?: string;            // episodic 专用
  lessons?: string[];           // episodic 专用
  key?: string;                // semantic 专用
  value?: string;              // semantic 专用
}
```

### 用户数据（UserData）

存储 `data_save` / `data_load` 工具写入的数据：

```typescript
interface UserDataEntry {
  key: string;                 // 用户定义的键
  value: StorageValue;         // 任意 JSON 值
  namespace?: string;          // 用户定义的命名空间
  createdAt: string;
  updatedAt: string;
  description?: string;
}
```

## 迁移策略

### JSONL 到 SQLite

```typescript
const backend = new SQLiteSessionBackend("~/.vera/sessions.db", true);
await backend.initialize();

// 迁移所有 JSONL 文件
const count = await backend.migrateFromJsonl("~/.vera/projects");
console.log(`Migrated ${count} sessions`);
```

迁移流程（`migrateJsonlToSqlite`）：
1. 扫描目标目录下所有 `.jsonl` 文件
2. 解析内容、提取 metadata
3. 跳过已在 SQLite 中的会话（按 sessionId 查重）
4. 跳过空文件或无法解析的文件
5. 将 `StoredSession` 写入 SQLite

### 迁移验证

`SessionStorageAdapter.verifyMigration()` 逐条比较源文件和数据库中的 JSONL 内容：

```typescript
const result = await adapter.verifyMigration(sessionId, sourceContent);
// MigrationVerificationResult {
//   ok: boolean,
//   sessionId,
//   sourceEntries: number,
//   migratedEntries: number,
//   contentMatch?: boolean,
//   sourceCorruptLines?: number,
//   reason?: string
// }
```

### 导出为 JSONL

SQLite 中的会话可以随时导出回 JSONL 格式：

```typescript
const jsonl = await adapter.exportJsonl(sessionId);
// 与原始 JSONL 文件内容完全一致
```

## 文件路径与约定

```
~/.vera/
  sessions.db              # SQLite 数据库（可选，启用 SQLite 后端时）
  projects/                # JSONL 文件存储目录
    <sanitized_cwd>/       # 项目目录，路径经 sanitizePath() 处理
      <uuid>.jsonl         # 单个会话文件
  settings.json            # 全局配置
  memories/                # 记忆文件（可选）
```

路径清理规则（`sanitizePath`）：
- 非字母数字字符替换为 `-`
- 超长路径（>80 字符）：截断并追加 djb2 hash 后缀确保唯一性
- 路径经 `realpathSync` 解析后做 NFC 规范化

## 备份与恢复

### 备份

两种方式：

1. **SQLite 备份**：直接复制 `.db` 文件（WAL 模式下需同时复制 `-wal` 和 `-shm` 文件，或用 `sqlite3 .backup` 命令）
2. **JSONL 备份**：`~/.vera/projects/` 目录下的 `.jsonl` 文件可直接用 `tar` / `rsync` 备份

### 恢复

- **SQLite**：将备份的 `.db` 文件恢复后，Vera 自动识别并加载
- **JSONL**：将 `.jsonl` 文件放回 `~/.vera/projects/<sanitized_cwd>/` 目录即可被会话列表发现

## 性能考虑

### WAL 模式

启用 WAL（Write-Ahead Logging）后，读取操作不会阻塞写入，显著提升并发场景下的性能。代价是数据库文件体积略大（多出 `.db-wal` 和 `.db-shm` 文件）。

### 索引策略

- `idx_kv_ns`：按 namespace 过滤时使用，覆盖大部分业务查询
- `idx_kv_created` 和 `idx_kv_updated`：按时间排序和过滤
- FTS5 索引：仅在明确需要全文搜索时启用，增加写入开销和存储空间

### 批次操作

大批量写入建议使用 `setMany()` 或事务，比逐条 `set()` 快数倍。

### 会话列表优化

会话列表是高频操作。SQLite 后端直接从 metadata 提取摘要，无需解析完整 JSONL 内容。JSONL 后端使用渐进式加载（仅读头尾各 64KB）。

## 错误类型

```typescript
class StorageError extends Error          // STORAGE_BACKEND, STORAGE_NOT_FOUND, ...
class StorageNotFoundError extends StorageError
class StorageConflictError extends StorageError
class StorageTransactionError extends StorageError
class StorageBackendError extends StorageError
```

## 当前测试覆盖状态

根据 `docs/testing/storage/README.md` 的测试计划：

**已验证的基线**：
- Core: 75 个测试文件，1054 个测试用例
- Harness: 15 个测试文件，268 个测试用例
- Root typecheck 通过

**已覆盖**：
- `SqliteStorageProvider`：基础 CRUD、查询过滤、TTL 过期、同步 API
- `SessionStorageAdapter`：session CRUD、摘要提取、fork/branch
- `MemoryStorageAdapter`：三 tier 存储、搜索
- `UserDataStore`：data_save/data_load/data_list/data_delete

**待补充（P0）**：
1. `DataExporter` 的 JSONL/CSV/JSON 导出测试
2. SQLite 迁移边缘情况测试（损坏行处理、重复迁移、验证报告）
3. SQLite 分支错误路径（adopt/merge 非分支会话等）
4. 记忆持久化与搜索的完整测试

**待补充（P1）**：
- 用户数据 TTL 过期和命名空间隔离
- 组合查询的排序和分页
- 大规模数据性能测试（1k/10k 会话、10k 记忆条目）

---

**相关文件**：
- `packages/core/src/storage/types.ts` — 存储接口和数据模型
- `packages/core/src/storage/sqlite.ts` — SQLite 引擎实现
- `packages/core/src/storage/session-adapter.ts` — 会话存储适配器
- `packages/core/src/session/sqlite-backend.ts` — 会话 SQLite 后端
- `docs/testing/storage/README.md` — 测试覆盖计划
