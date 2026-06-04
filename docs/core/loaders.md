# 文档加载与索引

Vera 的 Loaders 系统负责将多种格式的文件解析为结构化文档片段（chunk），为 RAG（检索增强生成）系统的向量索引提供高质量输入。

---

## 1. 整体架构

```
文件系统
    │
    ▼
BatchIndexer                     ← 目录扫描 + 并发调度 + 增量检测
    │
    ├── TextLoader                ← 通用文本文件（60+ 扩展名）
    ├── TypeScriptLoader          ← .ts/.tsx 结构化解析
    └── MarkdownLoader            ← .md/.mdx 标题感知分块
    │
    ▼
chunkText()                      ← 段落/句子边界感知的分块算法
    │
    ▼
VectorDocumentInput[]             ← 标准化的文档片段，送入 EmbeddingAdapter
    │
    ▼
VectorStore.upsertMany()          ← 写入向量数据库
```

所有 Loader 的产出都是 `VectorDocumentInput[]`——即包含 `content` 和 `metadata` 的标准文档片段数组，需要由 `EmbeddingAdapter` 生成向量后存入 `VectorStore`。

---

## 2. BatchIndexer

BatchIndexer 是全量索引和增量索引的统一入口，根据文件扩展名自动路由到合适的 Loader。

**代码位置:** `packages/core/src/loaders/batch-indexer.ts`

### 2.1 全量索引

```typescript
const indexer = new BatchIndexer({
  basePath: "/project",
  concurrency: 8,
  onFileIndexed: (info) => {
    console.log(`Indexed ${info.filePath} (${info.documentCount} chunks)`);
  },
});

const files = ["src/utils.ts", "docs/guide.md", "README.md"];
const result = await indexer.index(files);
// result: { documents, filesProcessed, filesFailed, filesSkipped, chunksProduced, durationMs }
```

### 2.2 增量索引

增量索引通过比较文件的 `mtimeMs`（修改时间）来判断文件是否需要重新索引：

```typescript
const { result, changes } = await indexer.indexIncremental(files, {
  previousChanges: lastChangeMap,  // 上次索引时的 FileChangeMap
});

// result.filesUpdated    — 本次重新索引的文件数
// result.filesUnchanged  — 未变动的文件数（跳过）
// changes                — 新的 FileChangeMap，供下次使用
```

两阶段流程：
1. 阶段 1：并发 `stat()` 所有文件，对比 `previousChanges` 中的 `mtimeMs`
2. 阶段 2：仅加载有变化的文件（并发处理）

### 2.3 并发控制

`runConcurrent(items, limit, task)` 工具函数使用 worker 模式控制并发：启动 N 个 worker（N = `min(limit, items.length)`），每个 worker 循环取下一个任务。这保证了：
- 最多同时有 `concurrency` 个文件被处理
- 任务顺序被保留用于结果，不用于执行顺序

### 2.4 Loader 路由

```typescript
private selectLoader(filePath: string): TypeScriptLoader | TextLoader | null {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return this.tsLoader;  // .ts/.tsx/.mts/.cts
  if (this.textLoader.canHandle(ext)) return this.textLoader;
  return null;  // 不支持的类型 → 跳过
}
```

注意：当前 `BatchIndexer` 仅内置了 `TypeScriptLoader` 和 `TextLoader` 两个 loader。`MarkdownLoader` 需要使用者单独实例化使用（`.md` 文件可通过 `TextLoader` 的 `.md` 扩展名支持来做纯文本分块，但如果需要标题感知分块，应单独使用 `MarkdownLoader`）。

### 2.5 结果统计

```typescript
interface BatchIndexResult {
  documents: VectorDocumentInput[];   // 所有加载的文档片段
  filesProcessed: number;             // 成功处理的文件数
  filesFailed: number;                // 失败的文件数
  filesSkipped: number;               // 跳过的文件数（不支持的类型、空文件等）
  chunksProduced: number;             // 产生的 chunk 总数
  durationMs: number;                 // 处理耗时
}
```

---

## 3. TextLoader

TextLoader 是最通用的 Loader，支持 60+ 种文件扩展名，覆盖纯文本、日志、配置、脚本、标记语言等多种格式。

**代码位置:** `packages/core/src/loaders/text-loader.ts`

### 3.1 支持的文件类型

| 类别 | 扩展名 | 是否去除注释 |
|------|--------|-------------|
| 纯文本 | `.txt` `.text` | 否 |
| 日志 | `.log` | 否 |
| 配置 | `.yaml` `.yml` `.toml` `.ini` `.cfg` `.env` `.properties` | 否 |
| Shell 脚本 | `.sh` `.bash` `.zsh` `.fish` | 是 |
| Python | `.py` | 是 |
| Ruby | `.rb` | 是 |
| Go | `.go` | 是 |
| Rust | `.rs` | 是 |
| Java | `.java` | 是 |
| C/C++ | `.c` `.cpp` `.h` `.hpp` | 是 |
| CSS | `.css` `.scss` `.less` | 否 |
| 标记语言 | `.html` `.xml` `.svg` | 否 |
| SQL | `.sql` | 否 |
| Schema | `.graphql` `.proto` | 部分 |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | 否 |
| 框架 | `.vue` `.svelte` | 否 |
| 构建 | `.dockerfile` `.makefile` `.cmake` `.gradle` | 部分 |

可通过 `extraExtensions` 选项扩展额外支持的扩展名。

### 3.2 二进制检测

在读取文件内容前，先嗅探文件前 8192 字节（`BINARY_SNIFF_SIZE`），检查是否存在空字节（`\0`）。包含空字节的文件被判定为二进制文件并跳过。

### 3.3 注释去除

对于 `stripComments: true` 的文件类型，`stripLeadingComments()` 函数去除文件开头的注释行：
- shebang 行（`#!`）
- 块注释（`/* ... */`）
- 行注释（`//` 或 `#`）

注释去除在遇到第一个非注释行时停止，保留代码主体。

### 3.4 预处理钩子

```typescript
const loader = new TextLoader({
  basePath: "/project",
  preprocess: (content, filePath) => {
    // 去除 ANSI 颜色码
    return content.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  },
});
```

### 3.5 配置

```typescript
interface TextLoaderOptions {
  basePath: string;              // 必填：基准路径
  chunkSize?: number;            // 分块大小（字符数，默认 1500）
  chunkOverlap?: number;         // 重叠字符数（默认 200）
  maxFileSize?: number;          // 最大文件大小（默认 1MB）
  idPrefix?: string;             // 文档 ID 前缀
  extraExtensions?: string[];    // 额外支持的扩展名（含点号）
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 4. TypeScriptLoader

TypeScriptLoader 对 `.ts`、`.tsx`、`.mts`、`.cts` 文件做结构化解析，将函数、类、接口等代码块独立提取为文档片段，而不是对整文件做无差别分块。

**代码位置:** `packages/core/src/loaders/typescript-loader.ts`

### 4.1 结构化解析

`extractCodeBlocks()` 按行扫描源码，使用预定义的 regex 模式匹配代码块起始行：

| Pattern | 匹配的内容 | Block 类型 |
|---------|-----------|-----------|
| `(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)` | 类声明 | `class` |
| `(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)` | 函数声明 | `function` |
| `(export\s+)?interface\s+(\w+)` | 接口声明 | `interface` |
| `(export\s+)?type\s+(\w+)` | 类型别名 | `type` |
| `(export\s+)?enum\s+(\w+)` | 枚举声明 | `enum` |
| `(export\s+)?(const\|let\|var)\s+(\w+)` | 顶层变量 | `variable` |

### 4.2 块边界检测

`extractBlock()` 使用大括号计数确定每个代码块的结束行：
- 从起始行开始逐行扫描，对 `{` 加计数，对 `}` 减计数
- 当找到第一个 `{` 后计数归零，即为块结束
- 如果声明行不包含 `{` 但以 `;` 结尾，则视为单行声明

### 4.3 Fallback 机制

如果结构化解析没有提取到任何代码块（如模板文件、类型定义文件），`TypeScriptLoader` 自动降级为普通文本分块（调用 `chunkText()`），并在 metadata 中标记 `structuralParse: false`。

### 4.4 元数据

每个结构化块附带：

```typescript
metadata: {
  source: "src/utils.ts",
  fileType: "typescript",       // 或 "typescript-react"（.tsx）
  blockType: "function",        // class/function/interface/type/enum/variable
  blockName: "calculateTotal",  // 函数/类名
  startLine: 42,                // 在源文件中的行号
  structuralParse: true,
}
```

### 4.5 配置

```typescript
interface TypeScriptLoaderOptions {
  basePath: string;              // 必填
  chunkSize?: number;            // fallback 分块大小（默认 1500）
  chunkOverlap?: number;         // 重叠字符数（默认 200）
  maxFileSize?: number;          // 最大文件大小（默认 2MB）
  idPrefix?: string;             // 文档 ID 前缀
  structuralParsing?: boolean;   // 是否启用结构化解析（默认 true）
}
```

---

## 5. MarkdownLoader

MarkdownLoader 对 `.md` 和 `.mdx` 文件做标题感知分块，按 `#` 标题层级切分章节，并自动去除 YAML frontmatter。

**代码位置:** `packages/core/src/loaders/markdown-loader.ts`

### 5.1 标题感知分块

`splitAtHeadings()` 将 Markdown 内容按标题行（`/^(#{1,6})\s+(.+)$/`）分割。每个章节包含：
- 标题文字（如 `"## Installation"`）
- 标题层级（1-6）
- 完整章节文本（含标题行）
- 起始行号

章节内如果内容超过 `chunkSize`，会对该章节进一步调用 `chunkText()` 分块。

### 5.2 Frontmatter 剥离

`stripYamlFrontmatter()` 识别并移除 `---` 包裹的 YAML frontmatter。解析出的 key-value 对（仅支持简单格式，不支持嵌套结构）会合并到每个 chunk 的 metadata 中，便于按 frontmatter 字段过滤检索结果。

```yaml
---
title: My Document
tags: guide, api
---
```

→ Metadata: `{ title: "My Document", tags: "guide, api" }`

### 5.3 处理流程

1. 读取文件（最大 2MB）
2. 剥离 YAML frontmatter
3. 执行可选的 `preprocess` 钩子
4. 分割为章节（按标题）
5. 对每个章节（如内容超长）分块
6. 生成带元数据的 `VectorDocumentInput[]`

如果文件只有一个章节（无标题或只有一个顶层标题），降级为普通分块模式。

### 5.4 配置

```typescript
interface MarkdownLoaderOptions {
  basePath: string;              // 必填
  chunkSize?: number;            // 分块大小（默认 1500）
  chunkOverlap?: number;         // 重叠字符数（默认 200）
  maxFileSize?: number;          // 最大文件大小（默认 2MB）
  idPrefix?: string;             // 文档 ID 前缀
  stripFrontmatter?: boolean;    // 是否剥离 frontmatter（默认 true）
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 6. chunkText 分块算法

`chunkText()` 是所有 Loader 共享的核心分块算法。

**代码位置:** `packages/core/src/loaders/chunk-text.ts`

### 6.1 算法

```typescript
function chunkText(text: string, chunkSize: number, overlap: number): string[]
```

1. 如果文本长度 <= `chunkSize`，直接返回原文本（单 chunk）
2. 否则循环分块：
   - 取 `[start, start + chunkSize)` 范围的文本
   - 在切片内寻找"自然断点"（优先级：段落边界 `\n\n` > 句子边界 `. `）
   - 只有断点位置 > `chunkSize * 50%` 才会使用——避免产生过小的 chunk
   - 找到断点时调整 end 位置到断点处
   - 按 `end - overlap` 计算下一个 start（确保重叠）
3. 过滤空 chunk

### 6.2 分块重叠

`overlap` 参数（默认 200）确保相邻 chunk 之间有内容重叠，这对于保持上下文的连贯性很重要：

```
Chunk 1: [0, 1500]
Chunk 2: [1300, 2800]    ← 200 字符重叠
Chunk 3: [2600, 4100]    ← 继续重叠
```

**临界保护：** 如果 `end - overlap <= start`（即重叠导致 start 不前进），直接跳到 `end` 继续，避免死循环。

### 6.3 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `chunkSize` | 1500 | 每个 chunk 的最大字符数 |
| `overlap` | 200 | 相邻 chunk 之间的重叠字符数 |

---

## 7. 与 RAG 系统的集成

Loaders 产出的 `VectorDocumentInput` 需要经过以下步骤最终进入向量检索系统：

```
VectorDocumentInput[]               ← Loader 产出
    │
    ▼
EmbeddingAdapter.embedBatch()       ← 为每个 content 生成向量
    │
    ▼
VectorDocument[]                    ← 组装完整文档（含 embedding）
    │
    ▼
VectorStore.upsertMany()            ← 写入向量数据库
    │
    ▼
VectorStore.search(query)           ← 相似度检索
    │
    ▼
RetrievedChunk[]                    ← 注入 agent 上下文
```

RAG 系统的核心类型定义在 `packages/core/src/rag/types.ts`：

```typescript
interface VectorDocumentInput {
  id?: string;                        // 自动生成的唯一 ID
  content: string;                    // 文本内容
  metadata?: Record<string, unknown>; // 元数据（来源、类型、行号等）
}
```

---

## 8. 使用示例

### 8.1 全量索引一个项目

```typescript
import { createBatchIndexer } from "@open-vera/core/loaders";
import { glob } from "node:fs/promises";

const files = await Array.fromAsync(glob("src/**/*.{ts,tsx}"));
const indexer = createBatchIndexer({
  basePath: "/project",
  concurrency: 4,
  typescript: { chunkSize: 2000, structuralParsing: true },
});

const result = await indexer.index(files);
console.log(`Indexed ${result.chunksProduced} chunks from ${result.filesProcessed} files`);
```

### 8.2 增量索引

```typescript
let changeMap;

// 首次全量索引
let { result, changes } = await indexer.indexIncremental(files);
changeMap = changes;  // 保存 mtime 快照

// ... 代码变更后 ...

// 增量索引：只处理变动的文件
let { result: incResult, changes: newChanges } = await indexer.indexIncremental(files, {
  previousChanges: changeMap,
});
console.log(`Updated: ${incResult.filesUpdated}, Unchanged: ${incResult.filesUnchanged}`);
changeMap = newChanges;
```

### 8.3 单独使用 MarkdownLoader

```typescript
import { MarkdownLoader } from "@open-vera/core/loaders";

const loader = new MarkdownLoader({
  basePath: "/project/docs",
  chunkSize: 2000,
  chunkOverlap: 300,
  stripFrontmatter: true,
});

const chunks = await loader.load("/project/docs/guide.md");
// chunks[0].metadata: { heading: "Introduction", headingLevel: 2, title: "..." }
```

### 8.4 注册额外文件扩展名

```typescript
import { TextLoader } from "@open-vera/core/loaders";

const loader = new TextLoader({
  basePath: "/project",
  extraExtensions: [".rs", ".kt", ".swift"],  // 注册额外扩展名
});
```

---

## 9. 错误处理

所有 Loader 遵循一致的错误处理策略：

- **不能读取的文件**（权限、不存在）：返回空数组 `[]`，不抛异常
- **超过大小限制的文件**：返回空数组 `[]`，静默跳过
- **空文件**：返回空数组 `[]`
- **二进制文件**：`TextLoader` 通过空字节检测跳过
- **结构性解析失败**：`TypeScriptLoader` 降级为普通文本分块
- **`BatchIndexer` 中的异常**：通过 `onFileError` 回调通知，不影响其他文件的处理

---

## 10. 当前状态

| 组件 | 状态 | 说明 |
|------|------|------|
| `TextLoader` | 已实现 | 60+ 文件类型、二进制检测、注释去除、预处理钩子 |
| `TypeScriptLoader` | 已实现 | 结构化解析（6 种块类型）+ fallback 分块 |
| `MarkdownLoader` | 已实现 | 标题感知分块、frontmatter 剥离、预处理钩子 |
| `chunkText` | 已实现 | 段落/句子边界感知、可配置 chunkSize/overlap |
| `BatchIndexer` | 已实现 | 并发控制、增量索引（mtime 比对）、错误回调 |
| 递归目录扫描 | 未集成 | 当前 `index()` / `indexIncremental()` 接收文件列表，目录扫描在上层 |
| 实时文件监视 | 未实现 | 无 fs.watch 集成，增量索引需手动调用 |
