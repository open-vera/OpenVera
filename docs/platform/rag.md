# RAG — 检索增强生成

## 定位

RAG 系统为 Vera 提供**基于语料库的知识检索能力**，让 agent 在执行任务时能够搜索项目文档、代码库、历史决策等本地知识，并将相关上下文注入 LLM prompt，从而提升回答准确性和任务完成质量。

RAG 不是 Vera 的运行时核心（agent loop 无需 RAG 也可工作），而是作为**能力增强层**存在：agent 通过 `knowledge_search` 工具触发检索，RAG pipeline 在后台完成 embedding 和相似度搜索。

---

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│ Agent Loop                                              │
│   │                                                     │
│   ├─ tool_call: knowledge_search("how to add a tool")   │
│   ▼                                                     │
├─────────────────────────────────────────────────────────┤
│ RAG Pipeline (packages/core/src/rag/)                   │
│                                                         │
│  DocumentLoader          EmbeddingAdapter               │
│  ┌──────────────┐       ┌──────────────────┐           │
│  │ scanDir()    │       │ embed(text)      │           │
│  │ chunkText()  │       │ embedBatch(texts)│           │
│  │ load()       │       │ dimensions       │           │
│  └──────┬───────┘       └────────┬─────────┘           │
│         │                        │                      │
│         ▼                        ▼                      │
│  IncrementalIndexer        LocalVectorStore             │
│  ┌──────────────────┐     ┌──────────────────────┐     │
│  │ fullIndex()      │     │ upsert() / search()  │     │
│  │ incrementalIndex │     │ cosineSimilarity     │     │
│  │ manifest (mtime) │     │ SQLite BLOB storage  │     │
│  └──────────────────┘     └──────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

四层结构：

1. **DocumentLoader**：从文件系统读取文档，分块，提取元数据
2. **EmbeddingAdapter**：将文本转为向量（OpenAI / Voyage / 本地）
3. **VectorStore**：存储向量并支持相似度搜索（SQLite 本地实现）
4. **IncrementalIndexer**：按文件 mtime 增量更新索引

---

## VectorStore 接口

### 接口定义

所有向量存储后端实现 `VectorStore` 接口（`packages/core/src/rag/types.ts`）：

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
  id: string;        // 唯一文档 ID（如 "docs/readme.md:0"）
  content: string;   // 原始文本内容（或分块后的片段）
  embedding: number[];  // 预计算的嵌入向量
  metadata?: Record<string, unknown>;  // 来源文件、类型、分块索引等
  createdAt: string;
  updatedAt: string;
}
```

### 查询类型

```ts
interface VectorQuery {
  text?: string;       // 查询文本（由 adapter 转为向量）
  embedding?: number[]; // 或直接提供预计算向量
  topK?: number;        // 返回结果数量（默认 10）
  minScore?: number;    // 最低相似度阈值（0-1）
  filter?: Record<string, unknown>;  // 元数据精确过滤
  includeEmbeddings?: boolean;        // 是否在结果中包含向量
}
```

### 检索结果

```ts
interface VectorQueryResult {
  results: VectorSearchResult[];  // 按分数降序排列
  total: number;                   // 参与计算的总文档数
  durationMs: number;              // 搜索耗时
}

interface VectorSearchResult {
  document: VectorDocument;
  score: number;  // 余弦相似度 (0-1)
}
```

### 当前实现：LocalVectorStore

`LocalVectorStore`（`packages/core/src/rag/local-vector-store.ts`）是当前唯一的 VectorStore 实现：

- **存储引擎**：SQLite（`better-sqlite3`）
- **向量存储**：Float64Array 二进制 BLOB
- **相似度计算**：余弦相似度（brute-force 全量扫描）
- **预计算 L2 范数**：在 insert 时计算并存储，避免搜索时重复计算
- **WAL 模式**：默认启用，支持并发读取
- **元数据过滤**：内存侧过滤（无 JSON 索引），适用于元数据字段较少的场景
- **容量上限**：适合 10 万文档以下，超出建议迁移到专业向量数据库（如 Pinecone、Milvus）

关键实现细节：

```ts
// 相似度计算
function cosineSimilarity(a: number[], b: number[], normA: number, normB: number): number {
  if (normA === 0 || normB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}
```

注意事项：
- `search()` 要求提供 `embedding`（预计算向量），不接受纯文本查询。文本到向量的转换需由调用方通过 `EmbeddingAdapter` 完成后再调用。
- 数据库路径由构造参数 `dbPath` 指定，不会自动创建目录（但 `initialize()` 中已包含 `mkdirSync` 递归创建）。

---

## Embedding Adapter 设计

### 接口定义

```ts
interface EmbeddingAdapter {
  readonly name: string;          // "openai" | "voyage" | "local-hash"
  readonly dimensions: number;    // 向量维度

  initialize(): Promise<void>;
  close(): Promise<void>;
  embed(text: string): Promise<number[]>;          // 单文本嵌入
  embedBatch(texts: string[]): Promise<number[][]>;  // 批量嵌入
}
```

### 当前实现

三个 adapter 实现在 `packages/core/src/rag/embedding-adapter.ts`：

| Adapter | 模型 | 维度 | 批量上限 | 说明 |
|---------|------|------|---------|------|
| `OpenAIEmbeddingAdapter` | text-embedding-3-small / large / ada-002 | 1536 / 3072 | 100 | 调用 OpenAI Embeddings API |
| `VoyageEmbeddingAdapter` | voyage-3 / voyage-3-lite / voyage-code-3 | 1024 / 512 | 128 | 调用 Voyage AI API |
| `LocalEmbeddingAdapter` | 无（hash 模拟） | 384 | 无限制 | 确定性 hash 向量，仅测试用 |

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

### 内部实现细节

- **批量处理**：`embedBatch` 自动将文本按 `maxBatchSize` 分批，避免单次请求过大。
- **超时控制**：每个 HTTP 请求通过 `AbortController` 设置超时（默认 30s）。
- **错误传递**：HTTP 错误和网络异常均转为 `EmbeddingError`，不泄漏底层实现细节。
- **本地适配器**：`LocalEmbeddingAdapter` 使用确定性 hash 生成向量，hash 值经过 L2 归一化，确保相同输入始终得到相同向量。仅用于测试和开发环境。

---

## DocumentLoader：文档加载与分块

### 功能

`DocumentLoader`（`packages/core/src/rag/document-loader.ts`）负责：

1. **目录扫描**：递归扫描指定目录，按扩展名过滤
2. **内容读取**：支持同步和异步两种读取方式
3. **文本分块**：将长文档拆分为重叠的语义块
4. **元数据提取**：记录来源文件、文件类型、分块索引

### 支持的文件类型

| 类型 | 扩展名 |
|------|--------|
| Markdown | `.md`, `.mdx` |
| JSON | `.json`, `.jsonl` |
| TypeScript | `.ts`, `.tsx` |
| 文本 | `.js`, `.jsx`, `.mjs`, `.txt`, `.yaml`, `.yml`, `.toml`, `.py`, `.go`, `.rs`, `.java`, `.sh`, `.css`, `.html`, `.sql` 等 |

默认排除目录：`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`。

### 分块策略

```ts
const loader = new DocumentLoader({
  rootDir: "./docs",
  chunkSize: 1500,      // 字符数（默认 1500）
  chunkOverlap: 200,    // 块间重叠字符数（默认 200）
  maxFileSize: 1_000_000, // 单文件最大字节数（默认 1MB）
});
```

分块算法优先在段落边界（`\n\n`）和句子边界（`. `）处切分，避免截断语义单元。当无法找到自然边界时，回退到按 `chunkSize` 硬切分。

### 文档 ID 格式

每块的 ID 格式为 `{relPath}:{chunkIndex}`，例如 `docs/readme.md:0`、`src/index.ts:3`。可通过 `idPrefix` 选项添加前缀，用于区分不同索引来源。

---

## IncrementalIndexer：增量索引

`IncrementalIndexer`（`packages/core/src/rag/incremental-indexer.ts`）实现基于文件修改时间（mtime）的增量索引：

### 两种索引模式

1. **全量索引 `fullIndex()`**：清空现有索引，扫描所有文件，重新 embedding 和 upsert。
2. **增量索引 `incrementalIndex()`**：对比当前文件 mtime 与 manifest 记录，仅索引新增和修改的文件，同时删除已移除文件的旧向量。

### Manifest 机制

```ts
interface IndexManifestEntry {
  filePath: string;    // 相对于 rootDir 的路径
  mtimeMs: number;     // 文件最后修改时间
  docIds: string[];    // 该文件对应的向量文档 ID 列表
}
```

Manifest 存储在内存中，可通过 `exportManifest()` 导出 JSON 并持久化，下次启动时通过 `loadManifest()` 恢复。

### 使用示例

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
console.log(`Indexed ${result.documentsUpserted} documents`);

// 4. 后续增量索引
const incResult = await indexer.incrementalIndex();
console.log(`Updated ${incResult.filesIndexed}, deleted ${incResult.filesDeleted}`);
```

---

## 检索流程

完整的检索流程包含以下步骤：

```
用户查询 "如何配置模型"
  │
  ▼
1. 查询嵌入：queryEmbedding = await adapter.embed("如何配置模型")
  │
  ▼
2. 向量搜索：results = await store.search({
     embedding: queryEmbedding,
     topK: 5,
     minScore: 0.6,
     filter: { fileType: "markdown" },  // 可选
   })
  │
  ▼
3. 结果排序：按 score 降序，截断到 topK
  │
  ▼
4. 上下文注入：将检索结果格式化为 prompt 片段
  │
  ▼
5. 注入 LLM prompt → 生成增强回答
```

当前检索策略为**纯语义搜索**（余弦相似度）。暂未实现混合检索（关键词 + 语义）和重排序（re-rank），这些在 P3 路线图中。

---

## 上下文注入格式

检索到的文档块被组装为以下格式注入 LLM context：

```
## 相关文档

### 文档 1: docs/config.md (相似度: 0.92)
模型配置通过 VeraConfig 对象管理...

### 文档 2: docs/core/adapters.md (相似度: 0.85)
每个 adapter 实现统一的 LlmAdapter 接口...
```

注入格式由调用方（tool 实现）负责，RAG 模块本身不关心 prompt 格式，只返回结构化的 `RetrievedChunk[]`。

---

## 配置示例

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

RAG 模块定义了层级化的错误类型（`packages/core/src/rag/types.ts`）：

| 错误类 | Code | 触发条件 |
|--------|------|---------|
| `RAGError` | 自定义 | 基类 |
| `VectorStoreError` | `VECTOR_STORE_ERROR` | 存储操作失败 |
| `VectorDimensionError` | `VECTOR_DIMENSION_ERROR` | 向量维度不匹配 |
| `EmbeddingError` | `EMBEDDING_ERROR` | API 调用失败 |
| `DocumentNotFoundError` | `DOCUMENT_NOT_FOUND` | 文档 ID 不存在 |
| `RAGNotInitializedError` | `RAG_NOT_INITIALIZED` | 未初始化即调用 |

---

## 当前状态与路线图

### 已实现 (P1)

- `VectorStore` 接口与 `LocalVectorStore`（SQLite）实现
- `EmbeddingAdapter` 接口与 OpenAI / Voyage / Local 三个实现
- `DocumentLoader`：目录扫描、文本分块、元数据提取
- `IncrementalIndexer`：基于 mtime 的全量/增量索引
- `knowledge_search` 工具（`packages/core/src/tools/knowledge-search.ts`）：暴露给 agent loop 的检索入口
- 错误类型体系

### 计划实现 (P2-P3)

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 混合检索（hybrid search） | P2 | 结合 BM25 关键词 + 语义向量，提升精确匹配场景的召回率 |
| 重排序（re-rank） | P2 | 基于 Cross-Encoder 对初步检索结果二次排序 |
| 云端 VectorStore | P3 | 接入 Pinecone / Milvus / pgvector 等专业向量数据库 |
| 多模态嵌入 | P3 | 支持图片 embedding（CLIP 等）实现图文混合检索 |
| 自动索引调度 | P3 | 文件变更时自动触发增量索引（watch 模式） |
| 检索缓存 | P3 | 缓存高频查询的检索结果，减少 embedding API 调用 |
| 分块策略增强 | P3 | 语义分块（sentence-transformers）、递归分块、代码 AST 分块 |
