# RAG —— 检索增强生成

## 概述

RAG 系统为 Vera 提供**基于语料库的知识检索**能力，使 Agent 在执行任务时能够搜索项目文档、代码库、历史决策等本地知识。相关上下文被注入 LLM 提示词，提升回答准确性和任务完成质量。

RAG 不是 Vera 运行时的核心部分（Agent 循环可以在没有它的情况下工作）。它作为**能力增强层**存在：Agent 通过 `knowledge_search` 工具触发检索，RAG 流水线在后台处理嵌入和相似度搜索。

---

## 架构

```
+-----------------------------------------------------------+
| Agent Loop                                                |
|   |                                                       |
|   +-- tool_call: knowledge_search("如何添加工具")         |
|   v                                                       |
+-----------------------------------------------------------+
| RAG 流水线（packages/core/src/rag/）                       |
|                                                           |
|  DocumentLoader          EmbeddingAdapter                 |
|  +----------------+     +--------------------+            |
|  | scanDir()      |     | embed(text)        |            |
|  | chunkText()    |     | embedBatch(texts)  |            |
|  | load()         |     | dimensions         |            |
|  +-------+--------+     +---------+----------+            |
|          |                        |                       |
|          v                        v                       |
|  IncrementalIndexer       LocalVectorStore                |
|  +--------------------+   +------------------------+      |
|  | fullIndex()        |   | upsert() / search()    |      |
|  | incrementalIndex() |   | cosineSimilarity       |      |
|  | manifest（mtime）  |   | SQLite BLOB 存储       |      |
|  +--------------------+   +------------------------+      |
+-----------------------------------------------------------+
```

四层结构：

1. **DocumentLoader**：从文件系统读取文档，进行分块，提取元数据。
2. **EmbeddingAdapter**：将文本转换为向量（OpenAI / Voyage / local）。
3. **VectorStore**：存储向量并支持相似度搜索（SQLite 本地实现）。
4. **IncrementalIndexer**：按文件 mtime 增量更新索引。

---

## VectorStore 接口

### 接口定义

所有向量存储后端都实现 `VectorStore` 接口（`packages/core/src/rag/types.ts`）：

```ts
interface VectorStore {
  readonly name: string;

  initialize(): Promise<void>;
  close(): Promise<void>;
  isHealthy(): boolean;

  // 文档操作
  upsert(doc: VectorDocument): Promise<void>;
  upsertMany(docs: VectorDocument[]): Promise<void>;
  get(id: string): Promise<VectorDocument | undefined>;
  getMany(ids: string[]): Promise<VectorDocument[]>;
  delete(id: string): Promise<boolean>;
  deleteMany(ids: string[]): Promise<number>;
  has(id: string): Promise<boolean>;
  listIds(): Promise<string[]>;
  count(): Promise<number>;
  clear(): Promise<void>;

  // 相似度搜索
  search(query: VectorQuery): Promise<VectorQueryResult>;

  // 索引统计
  getStats(): Promise<VectorIndexStats>;
}
```

### 文档类型

```ts
interface VectorDocument {
  id: string;           // 唯一文档 ID，如 "docs/readme.md:0"
  content: string;      // 原始文本或分块片段
  embedding: number[];  // 预计算的嵌入向量
  metadata?: Record<string, unknown>;  // 来源文件、类型、分块索引等
  createdAt: string;
  updatedAt: string;
}
```

### 查询类型

```ts
interface VectorQuery {
  text?: string;         // 查询文本（由 adapter 转换为向量）
  embedding?: number[];  // 或直接提供预计算向量
  topK?: number;         // 结果数量（默认 10）
  minScore?: number;     // 最低相似度阈值（0-1）
  filter?: Record<string, unknown>;  // 精确元数据过滤
  includeEmbeddings?: boolean;       // 结果中是否包含向量
}
```

### 搜索结果

```ts
interface VectorQueryResult {
  results: VectorSearchResult[];  // 按得分降序排列
  total: number;                   // 参与搜索的文档总数
  durationMs: number;              // 搜索耗时
}

interface VectorSearchResult {
  document: VectorDocument;
  score: number;  // 余弦相似度（0-1）
}
```

### 当前实现：LocalVectorStore

`LocalVectorStore`（`packages/core/src/rag/local-vector-store.ts`）是唯一的 VectorStore 实现：

- **存储引擎**：SQLite（`better-sqlite3`）
- **向量存储**：Float64Array 二进制 BLOB
- **相似度计算**：余弦相似度（暴力全扫描）
- **预计算 L2 范数**：插入时计算并存储，避免搜索时重复计算
- **WAL 模式**：默认开启，支持并发读取
- **元数据过滤**：内存过滤（无 JSON 索引），适用于小型元数据集
- **容量**：适用于 10 万以下文档；超过此规模建议迁移到专用向量数据库（Pinecone、Milvus）

关键实现细节：

```ts
function cosineSimilarity(a: number[], b: number[], normA: number, normB: number): number {
  if (normA === 0 || normB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}
```

注意：
- `search()` 需要 `embedding`（预计算向量）；不接受原始文本查询。调用方必须先通过 `EmbeddingAdapter` 将文本转换为向量。
- 数据库路径由构造函数参数 `dbPath` 指定；目录创建由 `initialize()` 内部的 `mkdirSync` 处理。

---

## 嵌入适配器设计

### 接口

```ts
interface EmbeddingAdapter {
  readonly name: string;       // "openai" | "voyage" | "local-hash"
  readonly dimensions: number; // 向量维度

  initialize(): Promise<void>;
  close(): Promise<void>;
  embed(text: string): Promise<number[]>;         // 单文本嵌入
  embedBatch(texts: string[]): Promise<number[][]>;  // 批量嵌入
}
```

### 当前实现

三个适配器在 `packages/core/src/rag/embedding-adapter.ts` 中：

| 适配器 | 模型 | 维度 | 最大批量 | 说明 |
|--------|------|------|---------|------|
| `OpenAIEmbeddingAdapter` | text-embedding-3-small / large / ada-002 | 1536 / 3072 | 100 | 调用 OpenAI Embeddings API |
| `VoyageEmbeddingAdapter` | voyage-3 / voyage-3-lite / voyage-code-3 | 1024 / 512 | 128 | 调用 Voyage AI API |
| `LocalEmbeddingAdapter` | 无（哈希模拟） | 384 | 无限制 | 确定性哈希向量，仅用于测试 |

### 工厂函数

```ts
import { createEmbeddingAdapter } from "@vera/core";

const adapter = createEmbeddingAdapter({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
});
```

`provider` 支持 `"openai"` | `"voyage"` | `"local"`。

### 实现细节

- **批量处理**：`embedBatch` 自动按 `maxBatchSize` 拆分文本批次，避免超大请求。
- **超时控制**：每个 HTTP 请求使用 `AbortController` 设置超时（默认 30 秒）。
- **错误传播**：HTTP 错误和网络异常被包装为 `EmbeddingError`，不泄露实现细节。
- **本地适配器**：`LocalEmbeddingAdapter` 使用确定性哈希生成向量；哈希值经 L2 归一化，相同输入始终产生相同向量。仅用于测试/开发。

---

## DocumentLoader：加载与分块

### 功能

`DocumentLoader`（`packages/core/src/rag/document-loader.ts`）负责：

1. **目录扫描**：递归扫描指定目录，按扩展名过滤
2. **内容读取**：支持同步和异步读取模式
3. **文本分块**：将长文档拆分为有重叠的语义块
4. **元数据提取**：记录来源文件、文件类型和分块索引

### 支持的文件类型

| 类型 | 扩展名 |
|------|--------|
| Markdown | `.md`、`.mdx` |
| JSON | `.json`、`.jsonl` |
| TypeScript | `.ts`、`.tsx` |
| 文本 | `.js`、`.jsx`、`.mjs`、`.txt`、`.yaml`、`.yml`、`.toml`、`.py`、`.go`、`.rs`、`.java`、`.sh`、`.css`、`.html`、`.sql` 等 |

默认排除目录：`node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`。

### 分块策略

```ts
const loader = new DocumentLoader({
  rootDir: "./docs",
  chunkSize: 1500,        // 字符数（默认 1500）
  chunkOverlap: 200,      // 块间重叠字符数（默认 200）
  maxFileSize: 1_000_000, // 单文件最大字节数（默认 1MB）
});
```

分块算法优先在段落边界（`\n\n`）和句子边界（`. `）处切分，避免割裂语义单元。当找不到自然边界时，回退到按 `chunkSize` 硬切分。

### 文档 ID 格式

每个块的 ID 格式为 `{relPath}:{chunkIndex}`，如 `docs/readme.md:0`、`src/index.ts:3`。可通过 `idPrefix` 选项区分索引来源。

---

## IncrementalIndexer

`IncrementalIndexer`（`packages/core/src/rag/incremental-indexer.ts`）实现基于 mtime 的增量索引：

### 两种索引模式

1. **全量索引 `fullIndex()`**：清空现有索引，扫描所有文件，重新嵌入和 upsert。
2. **增量索引 `incrementalIndex()`**：将当前文件 mtime 与清单对比，仅索引新增和修改的文件，并移除已删除文件的旧向量。

### 清单

```ts
interface IndexManifestEntry {
  filePath: string;   // 相对于 rootDir 的路径
  mtimeMs: number;    // 最后修改时间
  docIds: string[];   // 该文件对应的向量文档 ID
}
```

清单在内存中维护，可通过 `exportManifest()` 导出为 JSON 进行持久化，通过 `loadManifest()` 在重启时恢复。

### 使用

```ts
import {
  LocalVectorStore,
  createEmbeddingAdapter,
  DocumentLoader,
  IncrementalIndexer,
} from "@vera/core";

// 1. 初始化组件
const store = new LocalVectorStore({
  dbPath: ".vera/vectors.db",
  dimensions: 1536,
});
await store.initialize();

const adapter = createEmbeddingAdapter({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
});

const loader = new DocumentLoader({ rootDir: "./docs" });

// 2. 创建增量索引器
const indexer = new IncrementalIndexer({
  vectorStore: store,
  embeddingAdapter: adapter,
  documentLoader: loader,
  rootDir: process.cwd(),
});

// 3. 首次全量索引
const result = await indexer.fullIndex();
console.log(`已索引 ${result.documentsUpserted} 个文档`);

// 4. 后续增量索引
const incResult = await indexer.incrementalIndex();
console.log(`更新 ${incResult.filesIndexed} 个文件，删除 ${incResult.filesDeleted} 个文件`);
```

---

## 检索流程

```
用户查询 "如何配置模型"
  |
  v
1. 查询嵌入：queryEmbedding = await adapter.embed("如何配置模型")
  |
  v
2. 向量搜索：results = await store.search({
     embedding: queryEmbedding,
     topK: 5,
     minScore: 0.6,
     filter: { fileType: "markdown" },  // 可选
   })
  |
  v
3. 结果排序：按得分降序，截取 topK
  |
  v
4. 上下文注入：将检索结果格式化为提示词片段
  |
  v
5. 注入 LLM 提示词 -> 生成增强答案
```

当前检索策略是**纯语义搜索**（余弦相似度）。混合搜索（关键词 + 语义）和重排序尚未实现（在 P3 路线图中）。

---

## 上下文注入格式

检索到的文档块被组装为 LLM 上下文，格式如下：

```
## 相关文档

### 文档 1：docs/config.md（相似度：0.92）
模型配置通过 VeraConfig 对象管理...

### 文档 2：docs/core/adapters.md（相似度：0.85）
每个适配器实现了统一的 LlmAdapter 接口...
```

注入格式由调用方（工具实现）负责。RAG 模块本身不关心格式，只返回结构化的 `RetrievedChunk[]`。

---

## 配置

### 完整 RAG 配置

```json
{
  "rag": {
    "enabled": true,
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKey": "$OPENAI_API_KEY"
    },
    "vectorStore": {
      "type": "local-sqlite",
      "dbPath": ".vera/vectors.db"
    },
    "indexing": {
      "directories": ["./docs", "./src"],
      "exclude": ["node_modules", ".git", "dist", "*.test.ts"],
      "chunkSize": 1500,
      "chunkOverlap": 200,
      "maxFileSize": 1048576
    },
    "retrieval": {
      "topK": 5,
      "minScore": 0.6,
      "rerank": false
    }
  }
}
```

### 环境变量

| 变量 | 用途 |
|------|------|
| `OPENAI_API_KEY` | OpenAI Embedding API 密钥 |
| `VOYAGE_API_KEY` | Voyage AI API 密钥 |

---

## 错误类型

RAG 模块定义了层级化错误类型系统（`packages/core/src/rag/types.ts`）：

| 错误类 | 错误码 | 触发条件 |
|--------|--------|---------|
| `RAGError` | Custom | 基类 |
| `VectorStoreError` | `VECTOR_STORE_ERROR` | 存储操作失败 |
| `VectorDimensionError` | `VECTOR_DIMENSION_ERROR` | 向量维度不匹配 |
| `EmbeddingError` | `EMBEDDING_ERROR` | API 调用失败 |
| `DocumentNotFoundError` | `DOCUMENT_NOT_FOUND` | 文档 ID 不存在 |
| `RAGNotInitializedError` | `RAG_NOT_INITIALIZED` | 初始化前调用 |

---

## 当前状态与路线图

### 已实现（P1）

- `VectorStore` 接口和 `LocalVectorStore`（SQLite）实现
- `EmbeddingAdapter` 接口及 OpenAI / Voyage / Local 后端
- `DocumentLoader`：目录扫描、文本分块、元数据提取
- `IncrementalIndexer`：基于 mtime 的全量和增量索引
- `knowledge_search` 工具（`packages/core/src/tools/knowledge-search.ts`）：Agent 循环的检索入口
- 错误类型系统

### 计划中（P2-P3）

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 混合搜索 | P2 | 结合 BM25 关键词 + 语义向量，提升精确匹配的召回率 |
| 重排序 | P2 | 对初步搜索结果进行 Cross-Encoder 二次排序 |
| 云端 VectorStore | P3 | 集成 Pinecone / Milvus / pgvector |
| 多模态嵌入 | P3 | 图片嵌入（CLIP），实现文本-图片混合搜索 |
| 自动索引调度 | P3 | Watch 模式：文件变更时自动触发增量索引 |
| 检索缓存 | P3 | 缓存高频查询结果，减少嵌入 API 调用 |
| 增强分块 | P3 | 语义分块（sentence-transformers）、递归分块、代码 AST 分块 |
