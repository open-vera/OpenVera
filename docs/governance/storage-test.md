# 存储测试覆盖

> 模块: `packages/core/src/storage/` | 测试框架: Vitest
> 最后更新: 2026-06-04

## 概述

Vera 的存储层基于抽象接口 `StorageProvider` 设计，当前主实现为 SQLite（通过 `better-sqlite3`），同时提供文件存储（`FileStore`）、对象存储（`ObjectStore` + 多云适配器）等辅助存储能力。存储层承载 session、memory、user-data 三大业务域，是整个 agent runtime 的数据底座。

测试目录 `packages/core/src/storage/tests/` 包含 **26 个测试文件**，合计约 **14,000 行**测试代码（源文件约 6,300 行），测试/源码比约 **2.2:1**。

## 测试分层策略

存储测试分为四层，由内向外逐层集成：

| 层次 | 测试文件 | 关注点 |
|---|---|---|
| **单元测试** | `sqlite.test.ts`、`entry-filter.test.ts` | SQLite 提供者的独立行为、过滤函数纯逻辑 |
| **适配器测试** | `session-adapter.*.test.ts`、`memory-adapter.test.ts`、`user-data.test.ts`、`data-exporter.test.ts`、`file-store.test.ts` | 业务适配器在其语义层的正确性 |
| **对象存储测试** | `object-store.test.ts`、`local-fs-adapter.test.ts`、`s3-adapter.test.ts`、`oss-adapter.test.ts`、`tos-adapter.test.ts` | 多云对象存储适配器 |
| **集成测试** | `integration.test.ts`、`migrate-jsonl.test.ts` | 跨层交互、并发压力、数据迁移 |

## SQLite 测试方法

### 核心策略

SQLite 测试采用 **真实数据库 + 临时目录** 策略，不使用 mock：

```
beforeEach: mkdtemp() 创建临时目录 → 创建 SqliteStorageProvider → initialize()
afterEach:  provider.close() → rm(tmpDir, { recursive: true })
```

选型理由：
- `better-sqlite3` 是同步 C++ binding，mock 成本高且意义有限
- 临时目录确保测试隔离，无需 mock 文件系统
- WAL 模式开箱测试，与生产环境一致

### 测试覆盖矩阵

#### SqliteStorageProvider 核心 CRUD（sqlite.test.ts，586 行）

| 能力 | 测试用例数 | 覆盖细节 |
|---|---|---|
| `set` / `get` | 6 | string、number、boolean、null、object、array — 覆盖所有 `StorageValue` 类型 |
| `has` | 2 | 存在返回 true，缺失返回 false |
| `delete` | 2 | 删除已有返回 true，删除不存在返回 false |
| `listKeys` | 2 | 多 key 排序对比、空 namespace 返回 [] |
| `clear` | 1 | 仅清目标 namespace，不影响其他 namespace |
| 覆盖写 | 1 | 同 key 二次 set 更新旧值 |
| 缺失读 | 1 | 不存在 key 返回 undefined |

**状态**: 已完成，覆盖充分。

#### Namespace 隔离（sqlite.test.ts）

| 能力 | 测试用例数 |
|---|---|
| 不同 namespace 同 key 独立 | 1 |
| clear 影响范围限定 | 1 |

**状态**: 已完成。

#### 批量操作（sqlite.test.ts）

| 能力 | 测试用例数 |
|---|---|
| `setMany` 原子批量写入 | 1 |
| `setMany` 空数组（no-op） | 1 |
| `getMany` 批量读取（含缺失 key） | 1 |
| `getMany` 空 keys 返回 [] | 1 |

**状态**: 已完成。

#### 查询与过滤（sqlite.test.ts + entry-filter.test.ts）

| 能力 | 测试用例数 | 覆盖细节 |
|---|---|---|
| 全量查询 | 1 | 空 filter，验证 entries / total / hasMore |
| `keyPrefix` 过滤 | 1 | 前缀过滤，验证返回 key 列表 |
| `keyPattern` glob 过滤 | 1 | `file.*` 模式匹配 |
| 分页（limit + offset） | 1 | 4 页遍历，验证 hasMore 边界 |
| `orderBy` key asc/desc | 2 | 字母序正序/倒序 |
| `orderBy` createdAt | 1 | 时间序 |
| `createdAfter` 过滤 | 1 | 未来时间返回空 |
| metadata（createdAt/updatedAt） | 1 | 验证 ISO 格式 |
| `count` 全量 | 1 | 总数匹配 |
| `count` 过滤 | 1 | keyPrefix 下计数 |
| entry-filter 纯函数 | 3 | prefix+tags+FTS 组合、过期排除、glob 模式 |

**状态**: 已完成。query 动态 SQL 构建路径（含 tags、hasTtl、updatedAfter/Before）由集成测试补充覆盖。

#### 事务支持（sqlite.test.ts）

| 能力 | 测试用例数 | 覆盖细节 |
|---|---|---|
| 正常提交 | 1 | tx.set → commit → 外部可见 |
| 回滚 | 1 | set + delete → rollback → 无副作用 |
| 事务内读 | 1 | tx.get 读到外部已提交数据 |
| 事务内删除 | 1 | tx.delete → commit → 外部不可见 |
| 双重提交抛错 | 1 | 第二次 commit 抛出 StorageTransactionError |
| 双重回滚抛错 | 1 | 第二次 rollback 抛出 StorageTransactionError |
| commit 后 set 抛错 | 1 | 检查 ensureActive 守卫 |

**状态**: 已完成，覆盖事务生命周期的所有状态转换。

#### TTL 过期机制（sqlite.test.ts）

| 能力 | 测试用例数 | 测试方式 |
|---|---|---|
| 已过期 entry `get` | 1 | 手动插入 expired entry（ttl=1，2 秒前），验证返回 undefined |
| 已过期 entry `has` | 1 | 同场景，has 返回 false |
| 未过期 entry（未来 TTL） | 1 | ttl=86400，验证正常返回 |
| TTL=null（永久） | 1 | 远古时间戳，验证不回收 |

**状态**: 已完成。过期数据通过 `get`/`has` 的惰性删除触发。

**已知局限**: 没有直接测试 `cleanupExpired` 定时清理（`startCleanupTimer`），清理逻辑仅依赖内部 `setInterval` + `unref()`，测试依赖时间等待。

#### FTS5 全文搜索（sqlite.test.ts）

| 能力 | 测试用例数 |
|---|---|
| 关键词匹配多条目 | 1 |
| 排除不匹配条目 | 1 |
| FTS 启用时无关键词查询正常 | 1 |

**状态**: 基础覆盖完成。

**已知局限**:
- 未覆盖 FTS5 中文分词能力（better-sqlite3 默认 tokenizer 为 `unicode61`，中文支持有限）
- 未覆盖 FTS5 未启用时 `fullTextSearch` 参数的降级行为（目前静默忽略，由 buildQuery 中的 `isFts` 标志控制，非 FTS 路径不会进入 MATCH 子句）
- 未覆盖 FTS 触发器的正确性（INSERT/UPDATE/DELETE 后 FTS 索引同步）

#### 错误处理（sqlite.test.ts）

| 场景 | 测试 |
|---|---|
| 构造时缺少 `dbPath` | 抛出 `StorageBackendError` |
| close 后所有操作报错 | 覆盖 set / get / has / delete / listKeys / clear / setMany / getMany / query / count 共 10 个方法 |
| close 幂等 | 二次 close 不抛错 |
| isHealthy 状态 | close 前后正确切换 |

**状态**: 已完成。

#### 并发访问（sqlite.test.ts + integration.test.ts）

| 场景 | 数据量 | 测试文件 |
|---|---|---|
| 50 并发 set → 逐 key 校验 | 50 | sqlite.test.ts |
| 5 并发 getMany（同 key 集） | 20×5 | sqlite.test.ts |
| 100 并发 write | 100 | integration.test.ts |
| 5 并发 setMany（各 10 条） | 50 | integration.test.ts |
| 并发读写混合 | 7 操作并发 | integration.test.ts |

**状态**: 轻量级并发测试完成。SQLite WAL 模式 + `busy_timeout=5000` 提供了基础并发安全。

**已知局限**: 未实现多连接并发测试（当前始终用单个 `Database` 实例）、未模拟 WAL 文件增长或 checkpoint 场景。

## 迁移测试

### JSONL → SQLite 迁移（migrate-jsonl.test.ts + integration.test.ts）

JSONL 迁移是 Vera 从早期文件存储过渡到 SQLite 的关键路径。

| 测试场景 | 用例数 |
|---|---|
| 基本迁移（单文件） | 1 |
| 跳过已迁移 session | 1 |
| 空目录 | 1 |
| 不存在目录 | 1 |
| 空文件 | 1 |
| 多文件批量迁移 | 1 |
| 不可解析内容跳过 | 1 |
| 混合有效/无效行 | 1 |
| session_end 提取 metadata（turnCount/costUsd） | 1 |
| custom-title 提取 title | 1 |
| ai-title 提取 title | 1 |
| tag 提取 | 1 |
| 集成：迁移后内容完整性验证 | 1 |

**状态**: 已完成，覆盖正常路径和异常路径。

**已知局限**:
- 未测试大规模迁移（>1000 个 session 文件）的性能
- 未测试迁移过程中的中断恢复（crash-consistency）
- 未测试 `MigrationVerificationResult` 中 `contentMatch` 的深度对比（目前仅验证 entryCount）

## 备份与恢复测试

**状态: 未实现（计划中）。**

当前代码库中不存在显式的备份/恢复机制：

- `StorageOptions` 定义了 `autoVacuum?: boolean`，但 `SqliteStorageProvider` 的 `initialize()` 方法未使用该参数
- 不存在 `backup()` / `restore()` API
- 不存在 WAL checkpoint 或 `VACUUM` 的调用代码
- 不存在 point-in-time recovery 概念

现有的"恢复"能力依赖于：
- WAL 模式提供的 crash-safe 保证（写入不丢）
- `DataExporter` 可导出全量数据（JSONL/CSV/JSON），可作为半自动备份手段

**计划中的测试**:
- `PRAGMA integrity_check` 数据库健康检查
- `PRAGMA wal_checkpoint` 手动 checkpoint 测试
- `VACUUM` 回收空间测试
- 模拟 WAL 崩溃恢复（写入中途杀进程，验证重开后数据不丢）
- API-based backup（`sqlite3_backup_init` 或 `.dump` 导出测试）

## 性能基准

**状态: 基础覆盖（未建立正式基准体系）。**

### 现有性能相关测试

| 测试 | 数据量 | 验证方式 |
|---|---|---|
| count 操作耗时 | 500 条 | `elapsed < 1000ms`（宽松上限） |
| keyPrefix 查询 + orderBy | 500 条 | 正确性验证（不测耗时） |
| 全量分页遍历 | 500 条，pageSize=50 | 正确性 + 排序完整性 |
| 100 并发写 | 100 条 | 无数据损坏 |

**已知局限**:
- 500 条数据无法反映真实生产负载（预期单用户 session 可达数万条 message）
- 没有大规模数据插入基准（10K、100K、1M 条）
- 没有 WAL vs DELETE journal mode 对比
- 没有 FTS5 索引对查询性能的影响测试
- 没有 batch insert（事务 vs 逐条 insert）性能对比
- 没有跨平台性能一致性验证

### 计划中的性能测试体系

| 场景 | 数据规模 | 关注指标 |
|---|---|---|
| 批量插入 | 1K / 10K / 100K 条 | tps、内存峰值 |
| 分页查询 | 100K 条中查询 | P50/P99 延迟 |
| FTS5 全文搜索 | 10K 条文本 | 搜索延迟 vs 无索引 |
| WAL checkpoint | 10K 次写入后 | checkpoint 耗时、WAL 文件大小 |
| 并发读写 | 5 读 + 5 写 goroutine | 吞吐量、busy 重试次数 |

## 测试覆盖总览

### SQLite 核心（sqlite.ts）

| 能力 | 覆盖 | 状态 |
|---|---|---|
| CRUD 基本操作 | 全面 | 已完成 |
| Namespace 隔离 | 全面 | 已完成 |
| 批量操作 | 全面 | 已完成 |
| 查询 + 过滤（8 种 filter） | 全面 | 已完成 |
| 事务（7 种状态） | 全面 | 已完成 |
| TTL 过期（4 场景） | 全面 | 已完成 |
| FTS5 全文搜索 | 基础 | 已完成（待扩展中文/性能） |
| 错误处理（11 场景） | 全面 | 已完成 |
| 并发访问 | 基础 | 已完成（待扩展多连接） |
| sync 辅助方法（setSync/getSync/listKeysSync） | 未覆盖 | 由 SessionAdapter / MemoryAdapter 间接使用 |
| setWithMeta / getRow / deleteRow | 未覆盖 | 由 Transaction 实现内部使用 |

### 适配器层

| 适配器 | 测试文件 | 测试行数 | 状态 |
|---|---|---|---|
| SessionStorageAdapter | 4 文件（crud / write / transcript / advanced） | 1,447 | 已完成 |
| MemoryStorageAdapter | memory-adapter.test.ts | 1,207 | 已完成 |
| UserDataStore | user-data.test.ts | 601 | 已完成 |
| DataExporter | data-exporter.test.ts | 1,394 | 已完成 |
| FileStore | file-store.test.ts | 1,141 | 已完成 |
| ContentUploader | 6 文件 | 1,600+ | 已完成 |
| ArtifactUploader | 未有独立测试 | 0 | 计划中 |

### 对象存储适配器

| 适配器 | 测试文件 | 测试行数 | 状态 |
|---|---|---|---|
| ObjectStore 接口 | object-store.test.ts | 987 | 已完成 |
| LocalFsAdapter | local-fs-adapter*.test.ts | 759 | 已完成 |
| S3Adapter | s3-adapter.test.ts | 1,254 | 已完成 |
| OssAdapter | oss-adapter.test.ts | 1,233 | 已完成 |
| TosAdapter | tos-adapter.test.ts | 1,042 | 已完成 |

### 集成

| 测试 | 行数 | 状态 |
|---|---|---|
| 跨层集成（SQ9） | 719 | 已完成 |
| JSONL 迁移（SQ4） | 190 | 已完成 |

## 测试运行

```bash
# 运行全部存储测试
pnpm --filter @open-vera/core test -- src/storage/

# 仅运行 SQLite 核心测试
pnpm --filter @open-vera/core test -- src/storage/tests/sqlite.test.ts

# 运行集成测试
pnpm --filter @open-vera/core test -- src/storage/tests/integration.test.ts

# 运行覆盖率
pnpm --filter @open-vera/core run test:coverage
```

## 待办与改进项

| 优先级 | 项目 | 说明 |
|---|---|---|
| P1 | 备份/恢复 API | 提供 `backup(destPath)` / `restore(srcPath)` API + 测试 |
| P1 | 数据库完整性检查 | `PRAGMA integrity_check` 定期校验 + 测试 |
| P1 | WAL checkpoint | 手动触发 + 自动阈值 checkpoint 测试 |
| P2 | 大规模性能基准 | 10K/100K 级别数据的插入和查询基准 |
| P2 | FTS5 中文搜索 | 中文分词 tokenizer 验证 |
| P2 | 多连接并发 | 多个 Database 实例并发读写的安全性测试 |
| P2 | ArtifactUploader 测试 | 补充独立单元测试 |
| P3 | 跨平台兼容性 | Windows 路径、大小写敏感测试 |
| P3 | 磁盘满 / 写失败模拟 | 错误恢复路径测试 |
| P3 | Schema 版本升级 | 未来表结构变更的迁移测试 |
