# Document Loaders and Indexing

Vera's Loaders system converts files in various formats into structured document chunks, providing high-quality input for the RAG (Retrieval-Augmented Generation) system's vector indexing.

---

## 1. Architecture Overview

```
File System
    │
    ▼
BatchIndexer                     ← Directory scanning + concurrency + incremental detection
    │
    ├── TextLoader                ← General text files (60+ extensions)
    ├── TypeScriptLoader          ← .ts/.tsx structural parsing
    └── MarkdownLoader            ← .md/.mdx heading-aware chunking
    │
    ▼
chunkText()                      ← Paragraph/sentence boundary-aware chunking algorithm
    │
    ▼
VectorDocumentInput[]             ← Normalized document chunks, fed to EmbeddingAdapter
    │
    ▼
VectorStore.upsertMany()          ← Written to vector database
```

All loaders produce `VectorDocumentInput[]` -- an array of standard document chunks with `content` and `metadata`, ready to be embedded by an `EmbeddingAdapter` and stored in a `VectorStore`.

---

## 2. BatchIndexer

The BatchIndexer is the unified entry point for both full and incremental indexing, automatically routing files to the appropriate loader based on extension.

**Source:** `packages/core/src/loaders/batch-indexer.ts`

### 2.1 Full Indexing

```typescript
const indexer = new BatchIndexer({
  basePath: "/project",
  concurrency: 8,
  onFileIndexed: (info) => {
    console.log(`Indexed ${info.filePath} (${info.documentCount} chunks)`);
  },
});

const result = await indexer.index(["src/utils.ts", "docs/guide.md", "README.md"]);
// result: { documents, filesProcessed, filesFailed, filesSkipped, chunksProduced, durationMs }
```

### 2.2 Incremental Indexing

Incremental indexing determines whether a file needs re-indexing by comparing its `mtimeMs` (modification time):

```typescript
const { result, changes } = await indexer.indexIncremental(files, {
  previousChanges: lastChangeMap,  // FileChangeMap from the last indexing run
});
// result.filesUpdated / result.filesUnchanged / changes
```

Two-phase flow:
1. Phase 1: Concurrent `stat()` on all files, comparing `mtimeMs` against `previousChanges`
2. Phase 2: Load only changed files (processed concurrently)

### 2.3 Concurrency Control

The `runConcurrent(items, limit, task)` utility uses a worker pattern: N workers are spawned (N = `min(limit, items.length)`), each looping to pull the next task.

### 2.4 Loader Routing

```typescript
private selectLoader(filePath: string): TypeScriptLoader | TextLoader | null {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return this.tsLoader;  // .ts/.tsx/.mts/.cts
  if (this.textLoader.canHandle(ext)) return this.textLoader;
  return null;  // Unsupported type → skip
}
```

Note: The current `BatchIndexer` only includes `TypeScriptLoader` and `TextLoader` internally. `MarkdownLoader` requires separate instantiation for heading-aware chunking.

### 2.5 Result Statistics

```typescript
interface BatchIndexResult {
  documents: VectorDocumentInput[];
  filesProcessed: number;
  filesFailed: number;
  filesSkipped: number;
  chunksProduced: number;
  durationMs: number;
}
```

---

## 3. TextLoader

TextLoader is the most general loader, supporting 60+ file extensions covering plain text, logs, config, scripts, markup, and more.

**Source:** `packages/core/src/loaders/text-loader.ts`

### 3.1 Supported File Types

| Category | Extensions | Strips Comments |
|----------|-----------|----------------|
| Plain text | `.txt` `.text` | No |
| Log | `.log` | No |
| Config | `.yaml` `.yml` `.toml` `.ini` `.cfg` `.env` `.properties` | No |
| Shell scripts | `.sh` `.bash` `.zsh` `.fish` | Yes |
| Python | `.py` | Yes |
| Ruby | `.rb` | Yes |
| Go | `.go` | Yes |
| Rust | `.rs` | Yes |
| Java | `.java` | Yes |
| C/C++ | `.c` `.cpp` `.h` `.hpp` | Yes |
| CSS | `.css` `.scss` `.less` | No |
| Markup | `.html` `.xml` `.svg` | No |
| SQL | `.sql` | No |
| Schema | `.graphql` `.proto` | Partial |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | No |
| Frameworks | `.vue` `.svelte` | No |
| Build | `.dockerfile` `.makefile` `.cmake` `.gradle` | Partial |

Additional extensions can be registered via the `extraExtensions` option.

### 3.2 Binary Detection

Before reading file content, the first 8192 bytes (`BINARY_SNIFF_SIZE`) are sniffed for null bytes (`\0`). Files containing null bytes are classified as binary and skipped.

### 3.3 Comment Stripping

For file types with `stripComments: true`, the `stripLeadingComments()` function removes leading comment lines (shebang, block comments, line comments). Stripping stops at the first non-comment line, preserving the code body.

### 3.4 Preprocessing Hook

```typescript
const loader = new TextLoader({
  basePath: "/project",
  preprocess: (content, filePath) => {
    return content.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");  // Strip ANSI codes
  },
});
```

### 3.5 Configuration

```typescript
interface TextLoaderOptions {
  basePath: string;              // Required
  chunkSize?: number;            // Default 1500
  chunkOverlap?: number;         // Default 200
  maxFileSize?: number;          // Default 1MB
  idPrefix?: string;
  extraExtensions?: string[];    // Additional extensions (with dot)
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 4. TypeScriptLoader

TypeScriptLoader performs structural parsing on `.ts`, `.tsx`, `.mts`, and `.cts` files, extracting functions, classes, and interfaces as independent document chunks.

**Source:** `packages/core/src/loaders/typescript-loader.ts`

### 4.1 Structural Parsing

`extractCodeBlocks()` scans source code line by line, using predefined regex patterns to match code block start lines:

| Pattern | What it matches | Block Type |
|---------|----------------|------------|
| `class\s+(\w+)` | Class declaration | `class` |
| `function\s+(\w+)` | Function declaration | `function` |
| `interface\s+(\w+)` | Interface declaration | `interface` |
| `type\s+(\w+)` | Type alias | `type` |
| `enum\s+(\w+)` | Enum declaration | `enum` |
| `(const\|let\|var)\s+(\w+)` | Top-level variable | `variable` |

### 4.2 Block Boundary Detection

`extractBlock()` uses brace counting to determine block end lines. Scanning line by line, incrementing on `{`, decrementing on `}`. Block ends when count returns to zero after the first opening brace. Single-line declarations (no `{`, ends with `;`) are returned as-is.

### 4.3 Fallback Mechanism

If structural parsing extracts no code blocks, the loader falls back to plain `chunkText()` with `structuralParse: false` in metadata.

### 4.4 Metadata

Each structural block carries: source path, file type, block type (`class`/`function`/`interface`/etc.), block name, and starting line number.

### 4.5 Configuration

```typescript
interface TypeScriptLoaderOptions {
  basePath: string;              // Required
  chunkSize?: number;            // Fallback chunk size (default 1500)
  chunkOverlap?: number;         // Default 200
  maxFileSize?: number;          // Default 2MB
  idPrefix?: string;
  structuralParsing?: boolean;   // Default true
}
```

---

## 5. MarkdownLoader

MarkdownLoader performs heading-aware chunking on `.md` and `.mdx` files, splitting at `#` heading boundaries and automatically stripping YAML frontmatter.

**Source:** `packages/core/src/loaders/markdown-loader.ts`

### 5.1 Heading-Aware Chunking

`splitAtHeadings()` splits content at heading lines (`/^(#{1,6})\s+(.+)$/`). Each section contains heading text, heading level (1-6), full section text, and starting line number. Oversized sections are further split via `chunkText()`.

### 5.2 Frontmatter Stripping

`stripYamlFrontmatter()` removes `---` delimited YAML frontmatter. Parsed key-value pairs (simple format only) are merged into each chunk's metadata for field-based filtering.

### 5.3 Processing Flow

1. Read file (max 2MB) → 2. Strip frontmatter → 3. Optional `preprocess` → 4. Split into sections → 5. Chunk oversized sections → 6. Generate `VectorDocumentInput[]`

Single-section files fall back to plain chunking mode.

### 5.4 Configuration

```typescript
interface MarkdownLoaderOptions {
  basePath: string;              // Required
  chunkSize?: number;            // Default 1500
  chunkOverlap?: number;         // Default 200
  maxFileSize?: number;          // Default 2MB
  idPrefix?: string;
  stripFrontmatter?: boolean;    // Default true
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 6. chunkText Algorithm

`chunkText()` is the core chunking algorithm shared by all loaders.

**Source:** `packages/core/src/loaders/chunk-text.ts`

### 6.1 Algorithm

1. If text length <= `chunkSize`, return as single chunk
2. Otherwise loop: take slice `[start, start + chunkSize)`, find natural breakpoints (priority: `\n\n` > `. `)
3. Only use breakpoints > 50% of chunkSize (prevents tiny chunks)
4. Calculate next start as `end - overlap` for overlap between chunks
5. Filter empty chunks

### 6.2 Chunk Overlap

```
Chunk 1: [0, 1500]
Chunk 2: [1300, 2800]    ← 200-char overlap
Chunk 3: [2600, 4100]
```

Guard: if `end - overlap <= start`, jump to `end` (prevents infinite loop).

### 6.3 Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `chunkSize` | 1500 | Maximum characters per chunk |
| `overlap` | 200 | Overlap characters between adjacent chunks |

---

## 7. RAG System Integration

```
VectorDocumentInput[]               ← Loader output
    │
    ▼
EmbeddingAdapter.embedBatch()       ← Generate vectors
    │
    ▼
VectorDocument[]                    ← Full documents with embeddings
    │
    ▼
VectorStore.upsertMany()            ← Write to vector database
    │
    ▼
VectorStore.search(query)           ← Similarity search
    │
    ▼
RetrievedChunk[]                    ← Injected into agent context
```

Core RAG types are defined in `packages/core/src/rag/types.ts`.

---

## 8. Usage Examples

### 8.1 Full Index a Project

```typescript
import { createBatchIndexer } from "@open-vera/core/loaders";

const indexer = createBatchIndexer({
  basePath: "/project",
  concurrency: 4,
  typescript: { chunkSize: 2000, structuralParsing: true },
});
const result = await indexer.index(files);
```

### 8.2 Incremental Indexing

```typescript
let changeMap;
let { result, changes } = await indexer.indexIncremental(files);
changeMap = changes;  // Save mtime snapshot

// ... later, after changes ...
let { result: incResult, changes: newChanges } = await indexer.indexIncremental(files, {
  previousChanges: changeMap,
});
```

### 8.3 Standalone MarkdownLoader

```typescript
import { MarkdownLoader } from "@open-vera/core/loaders";
const loader = new MarkdownLoader({ basePath: "/project/docs", chunkSize: 2000 });
const chunks = await loader.load("/project/docs/guide.md");
```

### 8.4 Extra File Extensions

```typescript
import { TextLoader } from "@open-vera/core/loaders";
const loader = new TextLoader({ basePath: "/project", extraExtensions: [".rs", ".kt"] });
```

---

## 9. Error Handling

All loaders follow a consistent strategy:

- **Unreadable files**: Return `[]`, no exception thrown
- **Over-size files**: Return `[]`, silently skipped
- **Empty files**: Return `[]`
- **Binary files**: Skipped via null-byte detection
- **Parse failure**: TypeScriptLoader falls back to plain text chunking
- **BatchIndexer exceptions**: Reported via `onFileError` callback

---

## 10. Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| `TextLoader` | Implemented | 60+ file types, binary detection, comment stripping, preprocessing hook |
| `TypeScriptLoader` | Implemented | Structural parsing (6 block types) + fallback chunking |
| `MarkdownLoader` | Implemented | Heading-aware chunking, frontmatter stripping, preprocessing hook |
| `chunkText` | Implemented | Paragraph/sentence boundary-aware, configurable chunkSize/overlap |
| `BatchIndexer` | Implemented | Concurrency control, incremental indexing (mtime comparison), error callbacks |
| Recursive directory scanning | Not integrated | `index()` / `indexIncremental()` accept file lists; scanning is at a higher layer |
| Real-time file watching | Not implemented | No fs.watch integration; incremental indexing requires manual invocation |
