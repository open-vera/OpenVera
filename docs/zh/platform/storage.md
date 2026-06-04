# 存储架构

> 本文档描述 OpenVera 的持久化存储系统，包括 SQLite 存储引擎、数据模型、迁移策略和性能设计。

## 概述

OpenVera 的存储层提供统一的键值抽象接口，支持多种后端实现。当前主要后端为 SQLite（基于 `better-sqlite3`），提供 WAL 模式、FTS5 全文搜索、TTL 过期和事务支持。

核心代码位于 `packages/core/src/storage/`。

## 架构分层

```
Session / Memory / UserData  （业务层）
        |
SessionStorageAdapter / MemoryStorageAdapter / UserDataStore  （适配器层）
        |
SqliteStorageProvider / FileStorageProvider  （引擎层）
        |
better-sqlite3 / fs  （基础层）
```

- **引擎层**（`StorageProvider` 接口）：统一的键值 CRUD + 查询 + 事务抽象
- **适配器层**：将业务数据模型（Session、Memory、UserData）映射到键值存储
- **业务层**：`SessionStore`、`MemoryStore` 等，作为对外接口

## 核心接口：StorageProvider

```typescript
// packages/core/src/storage/types.ts
export interface StorageProvider {
  readonly name: string;
  initialize(): Promise<void>;
  close(): Promise<void>;
  isHealthy(): boolean;

  // 基本 KV 操作
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

所有后端都实现此接口。命名空间用于逻辑分区，如 `sessions`、`memories`、`user-data`。

## SQLite 引擎：SqliteStorageProvider

### 表结构

```sql
CREATE TABLE IF NOT EXISTS kv_entries (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,     -- JSON 序列化
  created_at TEXT NOT NULL,     -- ISO-8601
  updated_at TEXT NOT NULL,     -- ISO-8601
  ttl        INTEGER,           -- 过期秒数，NULL = 永不过期
  tags       TEXT,              -- JSON 数组
  PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_kv_ns ON kv_entries(namespace);
CREATE INDEX IF NOT EXISTS idx_kv_created ON kv_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv_entries(updated_at);
```

### FTS5 全文搜索（可选）

启用 `enableFts` 时创建：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS kv_fts USING fts5(
  namespace, key, value,
  content='kv_entries',
  content_rowid='rowid'
);
```

通过触发器自动保持同步：主表的 INSERT / DELETE / UPDATE 自动更新 FTS 索引。

### 性能配置

构造函数中自动设置的 pragmas：

```typescript
// WAL 模式：启用并发读写，提升写入性能
this.db.pragma("journal_mode = WAL");

// Busy timeout 5 秒：处理锁竞争（better-sqlite3 默认为立即失败）
this.db.pragma("busy_timeout = 5000");

// NORMAL 同步：平衡安全性和性能（在 WAL 模式下 FULL 不必要）
this.db.pragma("synchronous = NORMAL");
```

通过 `StorageOptions` 可选配置：

| 选项 | 默认值 | 描述 |
|------|--------|------|
| `walMode` | `true` | 启用 WAL 模式 |
| `enableFts` | `false` | 启用 FTS5 全文搜索 |
| `autoVacuum` | `false` | 启用自动空间回收 |
| `cacheSize` | - | SQLite 缓存页数 |
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
  hasTtl?: boolean;          // 是否设置了 TTL
  keyPrefix?: string;        // 键前缀匹配（LIKE）
  keyPattern?: string;       // 键 glob 匹配
  fullTextSearch?: string;   // FTS5 全文搜索（需要 enableFts）
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt" | "key";
  order?: "asc" | "desc";
}
```

### 同步 API

SQLite 引擎还提供同步方法（绕过异步包装），供 `SQLiteSessionBackend` 在同步接口中使用：

```typescript
setSync(namespace, key, value): void
getSync(namespace, key): StorageValue | undefined
listKeysSync(namespace): string[]
```

这些方法直接使用 `better-sqlite3` 的同步 API，适用于不需要事务隔离的快速读取。

### TTL 与自动清理

- 每条记录可设置 `ttl`（秒）
- 定时器每 60 秒扫描过期记录并自动删除
- 查询时也过滤过期记录（`isExpired()` 检查）
- 定时器使用 `unref()`，不会阻止进程退出

### 事务

```typescript
await storage.transaction(async (tx) => {
  tx.set("sessions", "id-1", sessionData);
  tx.delete("sessions", "id-2");
  // 事务自动提交；异常时回滚
});
```

事务实现使用 `better-sqlite3` 的 `db.transaction()`，自动管理提交/回滚。事务对象提供 `set`、`get` 和 `delete` 方法。

## 数据模型

### Session 存储

由 `SessionStorageAdapter` 管理，存储在 `sessions` 命名空间中。

```typescript
interface StoredSession {
  sessionId: string;
  content: string;         // 完整 JSONL 内容
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
  firstPrompt?: string;    // 第一条用户提示词（用于搜索）
  title?: string;          // AI 或用户定义的标题
}
```

**设计说明**：SQLite 后端保留完整的 JSONL `content` 字段以保持向后兼容。元数据从内容中提取并冗余存储，以便快速索引和过滤而不必解析 JSONL。

### Memory 存储

存储在 `memories` 命名空间中，横跨三个层级：

```typescript
interface StoredMemory {
  id: string;
  tier: "working" | "episodic" | "semantic";
  content: string;
  tags: string[];
  importance: number;          // 重要性分数（0-1）
  source?: string;             // 来源 Session ID
  createdAt: string;
  updatedAt: string;
  accessCount?: number;        // 访问次数（用于衰减）
  lastAccessedAt?: string;     // 最后访问时间
  taskSummary?: string;        // Episodic 特有
  outcome?: string;            // Episodic 特有
  lessons?: string[];          // Episodic 特有
  key?: string;                // Semantic 特有
  value?: string;              // Semantic 特有
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
console.log(`已迁移 ${count} 个 Session`);
```

迁移流程（`migrateJsonlToSqlite`）：
1. 扫描目标目录中所有 `.jsonl` 文件
2. 解析内容，提取元数据
3. 跳过已在 SQLite 中的 Session（按 sessionId 去重）
4. 跳过空文件或无法解析的文件
5. 将 `StoredSession` 写入 SQLite

### 迁移验证

`SessionStorageAdapter.verifyMigration()` 逐条比对源文件和数据库 JSONL 内容：

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

SQLite 中的 Session 可以随时导出回 JSONL 格式：

```typescript
const jsonl = await adapter.exportJsonl(sessionId);
// 与原始 JSONL 文件内容完全相同
```

## 文件路径与约定

```
~/.vera/
  sessions.db              # SQLite 数据库（启用 SQLite 后端时可选）
  projects/                # JSONL 文件存储目录
    <sanitized_cwd>/       # 项目目录，路径经 sanitizePath() 处理
      <uuid>.jsonl         # 单个 Session 文件
  settings.json            # 全局配置
  memories/                # 记忆文件（可选）
```

路径清理规则（`sanitizePath`）：
- 非字母数字字符替换为 `-`
- 过长路径（>80 字符）：截断并附加 djb2 哈希后缀以保证唯一性
- 路径先通过 `realpathSync` 解析，再进行 NFC 标准化

## 备份与恢复

### 备份

两种方式：

1. **SQLite 备份**：直接复制 `.db` 文件（WAL 模式下还需复制 `-wal` 和 `-shm` 文件，或使用 `sqlite3 .backup` 命令）
2. **JSONL 备份**：`~/.vera/projects/` 下的 `.jsonl` 文件可以用 `tar` / `rsync` 备份

### 恢复

- **SQLite**：恢复备份的 `.db` 文件；Vera 自动检测并加载
- **JSONL**：将 `.jsonl` 文件放回 `~/.vera/projects/<sanitized_cwd>/` 以发现 Session 列表

## 性能考量

### WAL 模式

启用 WAL（Write-Ahead Logging）后，读取不阻塞写入，显著提升并发场景下的性能。代价是数据库文件稍大（额外的 `.db-wal` 和 `.db-shm` 文件）。

### 索引策略

- `idx_kv_ns`：用于命名空间过滤，覆盖大多数业务查询
- `idx_kv_created` 和 `idx_kv_updated`：用于基于时间的排序和过滤
- FTS5 索引：仅在明确需要全文搜索时启用；会增加写入开销和存储

### 批量操作

对于大量写入，优先使用 `setMany()` 或事务，速度可以比逐个 `set()` 调用快数倍。

### Session 列表优化

Session 列表是高频操作。SQLite 后端直接从元数据中提取摘要，无需解析完整 JSONL 内容。JSONL 后端使用渐进式加载（仅读取首尾各 64KB）。

## 错误类型

```typescript
class StorageError extends Error          // STORAGE_BACKEND, STORAGE_NOT_FOUND, ...
class StorageNotFoundError extends StorageError
class StorageConflictError extends StorageError
class StorageTransactionError extends StorageError
class StorageBackendError extends StorageError
```

## 当前测试覆盖状态

根据 `docs/testing/storage/README.md` 中的测试计划：

**已验证基线**：
- Core：75 个测试文件，1054 个测试用例
- Harness：15 个测试文件，268 个测试用例
- 根级别类型检查通过

**已覆盖**：
- `SqliteStorageProvider`：基本 CRUD、查询过滤、TTL 过期、同步 API
- `SessionStorageAdapter`：Session CRUD、摘要提取、fork/branch
- `MemoryStorageAdapter`：三层存储、搜索
- `UserDataStore`：data_save/data_load/data_list/data_delete

**待完成（P0）**：
1. `DataExporter` JSONL/CSV/JSON 导出测试
2. SQLite 迁移边缘情况测试（损坏行处理、重复迁移、验证报告）
3. SQLite 分支错误路径（对非分支 Session 执行 adopt/merge 等）
4. 完整的内存持久化和搜索测试

**待完成（P1）**：
- 用户数据 TTL 过期和命名空间隔离
- 组合查询排序和分页
- 大规模数据性能测试（1K/10K Session、10K 记忆条目）

---

**相关文件**：
- `packages/core/src/storage/types.ts` -- 存储接口和数据模型
- `packages/core/src/storage/sqlite.ts` -- SQLite 引擎实现
- `packages/core/src/storage/session-adapter.ts` -- Session 存储适配器
- `packages/core/src/session/sqlite-backend.ts` -- Session SQLite 后端
- `docs/testing/storage/README.md` -- 测试覆盖计划
