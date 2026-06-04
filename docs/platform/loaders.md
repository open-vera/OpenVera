# Document Loading and Indexing

Vera's Loaders system is responsible for parsing files of various formats into structured document chunks, providing high-quality input for the RAG (Retrieval-Augmented Generation) system's vector indexing.

---

## 1. Overall Architecture

```
File system
    |
    v
BatchIndexer                     <- Directory scanning + concurrency scheduling + incremental detection
    |
    ├── TextLoader                <- General-purpose text files (60+ extensions)
    ├── TypeScriptLoader          <- .ts/.tsx structured parsing
    └── MarkdownLoader            <- .md/.mdx heading-aware chunking
    |
    v
chunkText()                      <- Paragraph/sentence boundary-aware chunking algorithm
    |
    v
VectorDocumentInput[]             <- Standardized document chunks, fed into EmbeddingAdapter
    |
    v
VectorStore.upsertMany()          <- Written to vector database
```

All Loader output is `VectorDocumentInput[]` -- i.e., standard document chunk arrays containing `content` and `metadata`, which need to be vectorized by `EmbeddingAdapter` before being stored in `VectorStore`.

---

## 2. BatchIndexer

BatchIndexer is the unified entry point for full indexing and incremental indexing, automatically routing to the appropriate Loader based on file extension.

**Code location:** `packages/core/src/loaders/batch-indexer.ts`

### 2.1 Full Indexing

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

### 2.2 Incremental Indexing

Incremental indexing determines whether a file needs re-indexing by comparing its `mtimeMs` (modification time):

```typescript
const { result, changes } = await indexer.indexIncremental(files, {
  previousChanges: lastChangeMap,  // FileChangeMap from last indexing
});

// result.filesUpdated    -- Files re-indexed this run
// result.filesUnchanged  -- Files unchanged (skipped)
// changes                -- New FileChangeMap for next run
```

Two-phase flow:
1. Phase 1: Concurrently `stat()` all files, compare against `mtimeMs` in `previousChanges`
2. Phase 2: Only load changed files (concurrent processing)

### 2.3 Concurrency Control

The `runConcurrent(items, limit, task)` utility function uses a worker pattern for concurrency control: launch N workers (N = `min(limit, items.length)`), each worker loops to take the next task. This ensures at most `concurrency` files are processed simultaneously.

### 2.4 Loader Routing

```typescript
private selectLoader(filePath: string): TypeScriptLoader | TextLoader | null {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return this.tsLoader;  // .ts/.tsx/.mts/.cts
  if (this.textLoader.canHandle(ext)) return this.textLoader;
  return null;  // Unsupported type -> skip
}
```

Currently `BatchIndexer` only has built-in `TypeScriptLoader` and `TextLoader`. `MarkdownLoader` needs to be instantiated separately (`.md` files can be plain-text chunked via `TextLoader`, but heading-aware chunking requires standalone `MarkdownLoader`).

### 2.5 Result Statistics

```typescript
interface BatchIndexResult {
  documents: VectorDocumentInput[];   // All loaded document chunks
  filesProcessed: number;             // Successfully processed files
  filesFailed: number;                // Failed files
  filesSkipped: number;               // Skipped files
  chunksProduced: number;             // Total chunks produced
  durationMs: number;                 // Processing duration
}
```

---

## 3. TextLoader

TextLoader is the most general-purpose Loader, supporting 60+ file extensions covering plain text, logs, configs, scripts, markup languages, and more.

**Code location:** `packages/core/src/loaders/text-loader.ts`

### 3.1 Supported File Types

| Category | Extensions | Strip Comments? |
|------|--------|-------------|
| Plain text | `.txt` `.text` | No |
| Logs | `.log` | No |
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

Additional extensions can be added via the `extraExtensions` option.

### 3.2 Binary Detection

Before reading file content, the first 8192 bytes (`BINARY_SNIFF_SIZE`) are sniffed to check for null bytes (`\0`). Files containing null bytes are identified as binary and skipped.

### 3.3 Comment Stripping

For `stripComments: true` file types, the `stripLeadingComments()` function removes leading comment lines (shebang, block comments, line comments). It stops upon encountering the first non-comment line, preserving the code body.

### 3.4 Preprocessing Hook

```typescript
const loader = new TextLoader({
  basePath: "/project",
  preprocess: (content, filePath) => {
    // Remove ANSI color codes
    return content.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  },
});
```

### 3.5 Configuration

```typescript
interface TextLoaderOptions {
  basePath: string;              // Required: base path
  chunkSize?: number;            // Chunk size (characters, default 1500)
  chunkOverlap?: number;         // Overlap characters (default 200)
  maxFileSize?: number;          // Max file size (default 1MB)
  idPrefix?: string;             // Document ID prefix
  extraExtensions?: string[];    // Additional supported extensions (with dot)
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 4. TypeScriptLoader

TypeScriptLoader performs structured parsing on `.ts`, `.tsx`, `.mts`, `.cts` files, independently extracting functions, classes, interfaces, and other code blocks as document chunks.

**Code location:** `packages/core/src/loaders/typescript-loader.ts`

### 4.1 Structured Parsing

`extractCodeBlocks()` scans source code line by line, using predefined regex patterns to match code block start lines:

| Pattern | Matches | Block Type |
|---------|-----------|-----------|
| `class\s+(\w+)` | Class declaration | `class` |
| `function\s+(\w+)` | Function declaration | `function` |
| `interface\s+(\w+)` | Interface declaration | `interface` |
| `type\s+(\w+)` | Type alias | `type` |
| `enum\s+(\w+)` | Enum declaration | `enum` |
| `(const\|let\|var)\s+(\w+)` | Top-level variable | `variable` |

### 4.2 Block Boundary Detection

`extractBlock()` uses brace counting to determine the end line of each code block. Starting from the declaration line, it scans line by line, incrementing the counter for `{` and decrementing for `}`. When the counter reaches zero after finding the first `{`, the block ends. If the declaration line does not contain `{` but ends with `;`, it is treated as a single-line declaration.

### 4.3 Fallback Mechanism

If structured parsing does not extract any code blocks, `TypeScriptLoader` automatically falls back to plain text chunking (calling `chunkText()`), marking `structuralParse: false` in the metadata.

### 4.4 Metadata

Each structured block carries metadata including source file path, type (`typescript` or `typescript-react`), block type (`class`/`function`/`interface` etc.), block name, and starting line number.

### 4.5 Configuration

```typescript
interface TypeScriptLoaderOptions {
  basePath: string;              // Required
  chunkSize?: number;            // Fallback chunk size (default 1500)
  chunkOverlap?: number;         // Overlap characters (default 200)
  maxFileSize?: number;          // Max file size (default 2MB)
  idPrefix?: string;             // Document ID prefix
  structuralParsing?: boolean;   // Enable structured parsing (default true)
}
```

---

## 5. MarkdownLoader

MarkdownLoader performs heading-aware chunking on `.md` and `.mdx` files, splitting by `#` heading hierarchy and automatically stripping YAML frontmatter.

**Code location:** `packages/core/src/loaders/markdown-loader.ts`

### 5.1 Heading-Aware Chunking

`splitAtHeadings()` splits Markdown content by heading lines (`/^(#{1,6})\s+(.+)$/`). Each section contains heading text, heading level (1-6), full section text, and starting line number. If a section's content exceeds `chunkSize`, it is further chunked via `chunkText()`.

### 5.2 Frontmatter Stripping

`stripYamlFrontmatter()` identifies and removes YAML frontmatter wrapped in `---`. Parsed key-value pairs (only simple formats supported, no nested structures) are merged into each chunk's metadata, enabling filtered retrieval by frontmatter fields.

### 5.3 Processing Flow

1. Read file (max 2MB) -> 2. Strip YAML frontmatter -> 3. Execute optional `preprocess` hook -> 4. Split into sections (by headings) -> 5. Chunk oversized sections -> 6. Generate `VectorDocumentInput[]` with metadata

If a file has only one section (no headings or a single top-level heading), it falls back to plain chunking mode.

### 5.4 Configuration

```typescript
interface MarkdownLoaderOptions {
  basePath: string;              // Required
  chunkSize?: number;            // Chunk size (default 1500)
  chunkOverlap?: number;         // Overlap characters (default 200)
  maxFileSize?: number;          // Max file size (default 2MB)
  idPrefix?: string;             // Document ID prefix
  stripFrontmatter?: boolean;    // Strip frontmatter (default true)
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 6. chunkText Chunking Algorithm

`chunkText()` is the shared core chunking algorithm used by all Loaders.

**Code location:** `packages/core/src/loaders/chunk-text.ts`

### 6.1 Algorithm

```typescript
function chunkText(text: string, chunkSize: number, overlap: number): string[]
```

1. If text length <= `chunkSize`, return the original text directly (single chunk)
2. Otherwise loop chunking: take the `[start, start + chunkSize)` range, find a "natural breakpoint" within the slice (priority: paragraph boundary `\n\n` > sentence boundary `. `)
3. Only use the breakpoint if its position > `chunkSize * 50%` -- avoids producing overly small chunks
4. Calculate next start as `end - overlap` (ensuring overlap)
5. Filter empty chunks

### 6.2 Chunk Overlap

The `overlap` parameter (default 200) ensures content overlap between adjacent chunks:

```
Chunk 1: [0, 1500]
Chunk 2: [1300, 2800]    <- 200 character overlap
Chunk 3: [2600, 4100]    <- continuing overlap
```

Edge protection: if `end - overlap <= start` (i.e. overlap causes start not to advance), jump directly to `end` to continue, avoiding infinite loops.

### 6.3 Parameter Descriptions

| Parameter | Default | Description |
|------|--------|------|
| `chunkSize` | 1500 | Max characters per chunk |
| `overlap` | 200 | Overlap characters between adjacent chunks |

---

## 7. Integration with RAG System

`VectorDocumentInput` produced by Loaders goes through the following steps to enter the vector retrieval system:

```
VectorDocumentInput[]               <- Loader output
    |
    v
EmbeddingAdapter.embedBatch()       <- Generate vectors for each content
    |
    v
VectorDocument[]                    <- Assemble full documents (with embedding)
    |
    v
VectorStore.upsertMany()            <- Write to vector database
    |
    v
VectorStore.search(query)           <- Similarity retrieval
    |
    v
RetrievedChunk[]                    <- Injected into agent context
```

The RAG system's core types are defined in `packages/core/src/rag/types.ts`.

---

## 8. Usage Examples

### 8.1 Full Index a Project

```typescript
import { createBatchIndexer } from "@open-vera/core/loaders";

const files = ["src/utils.ts", "src/app.ts", "src/types.ts"];
const indexer = createBatchIndexer({
  basePath: "/project",
  concurrency: 4,
  typescript: { chunkSize: 2000, structuralParsing: true },
});

const result = await indexer.index(files);
console.log(`Indexed ${result.chunksProduced} chunks from ${result.filesProcessed} files`);
```

### 8.2 Incremental Indexing

```typescript
let changeMap;

// First full index
let { result, changes } = await indexer.indexIncremental(files);
changeMap = changes;  // Save mtime snapshot

// ... after code changes ...

// Incremental index: only process changed files
let { result: incResult, changes: newChanges } = await indexer.indexIncremental(files, {
  previousChanges: changeMap,
});
console.log(`Updated: ${incResult.filesUpdated}, Unchanged: ${incResult.filesUnchanged}`);
changeMap = newChanges;
```

### 8.3 Standalone MarkdownLoader Usage

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

### 8.4 Register Additional File Extensions

```typescript
import { TextLoader } from "@open-vera/core/loaders";

const loader = new TextLoader({
  basePath: "/project",
  extraExtensions: [".rs", ".kt", ".swift"],
});
```

---

## 9. Error Handling

All Loaders follow a consistent error handling strategy:

- **Unreadable files** (permissions, not found): Return empty array `[]`, do not throw
- **Files exceeding size limit**: Return empty array `[]`, silently skipped
- **Empty files**: Return empty array `[]`
- **Binary files**: `TextLoader` skips via null byte detection
- **Structural parse failure**: `TypeScriptLoader` falls back to plain text chunking
- **Exceptions in `BatchIndexer`**: Notified via `onFileError` callback, do not affect other files

---

## 10. Current Status

| Component | Status | Description |
|------|------|------|
| `TextLoader` | Implemented | 60+ file types, binary detection, comment stripping, preprocessing hook |
| `TypeScriptLoader` | Implemented | Structured parsing (6 block types) + fallback chunking |
| `MarkdownLoader` | Implemented | Heading-aware chunking, frontmatter stripping, preprocessing hook |
| `chunkText` | Implemented | Paragraph/sentence boundary-aware, configurable chunkSize/overlap |
| `BatchIndexer` | Implemented | Concurrency control, incremental indexing (mtime comparison), error callbacks |
| Recursive directory scanning | Not integrated | Current `index()` / `indexIncremental()` receive file lists; directory scanning is done at a higher layer |
| Real-time file watching | Not implemented | No fs.watch integration; incremental indexing requires manual invocation |
