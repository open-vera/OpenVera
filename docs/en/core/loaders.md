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

const files = ["src/utils.ts", "docs/guide.md", "README.md"];
const result = await indexer.index(files);
// result: { documents, filesProcessed, filesFailed, filesSkipped, chunksProduced, durationMs }
```

### 2.2 Incremental Indexing

Incremental indexing determines whether a file needs re-indexing by comparing its `mtimeMs` (modification time):

```typescript
const { result, changes } = await indexer.indexIncremental(files, {
  previousChanges: lastChangeMap,  // FileChangeMap from the last indexing run
});

// result.filesUpdated    — Number of files re-indexed this run
// result.filesUnchanged  — Number of unmodified files (skipped)
// changes                — New FileChangeMap for the next run
```

Two-phase flow:
1. Phase 1: Concurrent `stat()` on all files, comparing `mtimeMs` against `previousChanges`
2. Phase 2: Load only changed files (processed concurrently)

### 2.3 Concurrency Control

The `runConcurrent(items, limit, task)` utility uses a worker pattern to control concurrency: N workers are spawned (N = `min(limit, items.length)`), each looping to pull the next task. This guarantees:
- At most `concurrency` files processed simultaneously
- Input order is preserved for results, not for execution order

### 2.4 Loader Routing

```typescript
private selectLoader(filePath: string): TypeScriptLoader | TextLoader | null {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return this.tsLoader;  // .ts/.tsx/.mts/.cts
  if (this.textLoader.canHandle(ext)) return this.textLoader;
  return null;  // Unsupported type → skip
}
```

Note: The current `BatchIndexer` only includes `TypeScriptLoader` and `TextLoader` internally. `MarkdownLoader` requires separate instantiation for heading-aware chunking (`.md` files can still be processed via `TextLoader` for plain text chunking).

### 2.5 Result Statistics

```typescript
interface BatchIndexResult {
  documents: VectorDocumentInput[];   // All loaded document chunks
  filesProcessed: number;             // Successfully processed files
  filesFailed: number;                // Files that failed
  filesSkipped: number;               // Files skipped (unsupported type, empty, etc.)
  chunksProduced: number;             // Total chunks produced
  durationMs: number;                 // Processing duration
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

For file types with `stripComments: true`, the `stripLeadingComments()` function removes leading comment lines:
- Shebang lines (`#!`)
- Block comments (`/* ... */`)
- Line comments (`//` or `#`)

Stripping stops at the first non-comment line, preserving the code body.

### 3.4 Preprocessing Hook

```typescript
const loader = new TextLoader({
  basePath: "/project",
  preprocess: (content, filePath) => {
    // Strip ANSI color codes
    return content.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  },
});
```

### 3.5 Configuration

```typescript
interface TextLoaderOptions {
  basePath: string;              // Required: base path
  chunkSize?: number;            // Chunk size in characters (default 1500)
  chunkOverlap?: number;         // Overlap in characters (default 200)
  maxFileSize?: number;          // Maximum file size (default 1MB)
  idPrefix?: string;             // Document ID prefix
  extraExtensions?: string[];    // Additional extensions (including dot)
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 4. TypeScriptLoader

TypeScriptLoader performs structural parsing on `.ts`, `.tsx`, `.mts`, and `.cts` files, extracting functions, classes, and interfaces as independent document chunks rather than blindly splitting the entire file.

**Source:** `packages/core/src/loaders/typescript-loader.ts`

### 4.1 Structural Parsing

`extractCodeBlocks()` scans source code line by line, using predefined regex patterns to match code block start lines:

| Pattern | What it matches | Block Type |
|---------|----------------|------------|
| `(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)` | Class declaration | `class` |
| `(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)` | Function declaration | `function` |
| `(export\s+)?interface\s+(\w+)` | Interface declaration | `interface` |
| `(export\s+)?type\s+(\w+)` | Type alias | `type` |
| `(export\s+)?enum\s+(\w+)` | Enum declaration | `enum` |
| `(export\s+)?(const\|let\|var)\s+(\w+)` | Top-level variable | `variable` |

### 4.2 Block Boundary Detection

`extractBlock()` uses brace counting to determine the end line of each code block:
- Scans line by line from the start, incrementing on `{`, decrementing on `}`
- The block ends when the count returns to zero after finding the first opening brace
- If the declaration line has no `{` but ends with `;`, it is treated as a single-line declaration

### 4.3 Fallback Mechanism

If structural parsing extracts no code blocks (e.g., type definition files, template files), `TypeScriptLoader` automatically falls back to plain text chunking via `chunkText()`, marking metadata with `structuralParse: false`.

### 4.4 Metadata

Each structural block carries:

```typescript
metadata: {
  source: "src/utils.ts",
  fileType: "typescript",       // or "typescript-react" for .tsx
  blockType: "function",        // class/function/interface/type/enum/variable
  blockName: "calculateTotal",  // Function/class name
  startLine: 42,                // Line number in source file
  structuralParse: true,
}
```

### 4.5 Configuration

```typescript
interface TypeScriptLoaderOptions {
  basePath: string;              // Required
  chunkSize?: number;            // Fallback chunk size (default 1500)
  chunkOverlap?: number;         // Overlap in characters (default 200)
  maxFileSize?: number;          // Maximum file size (default 2MB)
  idPrefix?: string;             // Document ID prefix
  structuralParsing?: boolean;   // Enable structural parsing (default true)
}
```

---

## 5. MarkdownLoader

MarkdownLoader performs heading-aware chunking on `.md` and `.mdx` files, splitting at `#` heading boundaries and automatically stripping YAML frontmatter.

**Source:** `packages/core/src/loaders/markdown-loader.ts`

### 5.1 Heading-Aware Chunking

`splitAtHeadings()` splits Markdown content at heading lines (`/^(#{1,6})\s+(.+)$/`). Each section contains:
- Heading text (e.g., `"## Installation"`)
- Heading level (1-6)
- Full section text (including the heading line)
- Starting line number

If a section's content exceeds `chunkSize`, it is further split via `chunkText()`.

### 5.2 Frontmatter Stripping

`stripYamlFrontmatter()` identifies and removes YAML frontmatter delimited by `---` fences. Parsed key-value pairs (simple format only, no nested structures) are merged into each chunk's metadata, enabling frontmatter-based filtering of retrieval results.

```yaml
---
title: My Document
tags: guide, api
---
```

→ Metadata: `{ title: "My Document", tags: "guide, api" }`

### 5.3 Processing Flow

1. Read file (max 2MB)
2. Strip YAML frontmatter
3. Run optional `preprocess` hook
4. Split into sections (by headings)
5. For each section, chunk if content exceeds `chunkSize`
6. Generate `VectorDocumentInput[]` with metadata

If the file has only one section (no headings or single top-level heading), it falls back to plain chunking mode.

### 5.4 Configuration

```typescript
interface MarkdownLoaderOptions {
  basePath: string;              // Required
  chunkSize?: number;            // Chunk size (default 1500)
  chunkOverlap?: number;         // Overlap in characters (default 200)
  maxFileSize?: number;          // Maximum file size (default 2MB)
  idPrefix?: string;             // Document ID prefix
  stripFrontmatter?: boolean;    // Strip frontmatter (default true)
  preprocess?: (content: string, filePath: string) => string;
}
```

---

## 6. chunkText Algorithm

`chunkText()` is the core chunking algorithm shared by all loaders.

**Source:** `packages/core/src/loaders/chunk-text.ts`

### 6.1 Algorithm

```typescript
function chunkText(text: string, chunkSize: number, overlap: number): string[]
```

1. If text length <= `chunkSize`, return the original text as a single chunk
2. Otherwise, loop:
   - Take the slice `[start, start + chunkSize)`
   - Look for a "natural breakpoint" within the slice (priority: paragraph boundary `\n\n` > sentence boundary `. `)
   - Only use a breakpoint if its position is > `chunkSize * 50%` -- avoids producing chunks that are too small
   - When a breakpoint is found, adjust the end position to it
   - Calculate the next start as `end - overlap` (ensuring overlap between chunks)
3. Filter out empty chunks

### 6.2 Chunk Overlap

The `overlap` parameter (default 200) ensures content overlap between adjacent chunks, which is critical for maintaining context continuity:

```
Chunk 1: [0, 1500]
Chunk 2: [1300, 2800]    ← 200-character overlap
Chunk 3: [2600, 4100]    ← continued overlap
```

**Guard clause:** If `end - overlap <= start` (i.e., overlap would prevent start from advancing), jump directly to `end` to avoid an infinite loop.

### 6.3 Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `chunkSize` | 1500 | Maximum characters per chunk |
| `overlap` | 200 | Overlap characters between adjacent chunks |

---

## 7. RAG System Integration

`VectorDocumentInput` produced by loaders goes through the following steps to enter the vector retrieval system:

```
VectorDocumentInput[]               ← Loader output
    │
    ▼
EmbeddingAdapter.embedBatch()       ← Generate vectors for each chunk's content
    │
    ▼
VectorDocument[]                    ← Assemble full documents (with embeddings)
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

Core RAG types are defined in `packages/core/src/rag/types.ts`:

```typescript
interface VectorDocumentInput {
  id?: string;                        // Auto-generated unique ID
  content: string;                    // Text content
  metadata?: Record<string, unknown>; // Metadata (source, type, line numbers, etc.)
}
```

---

## 8. Usage Examples

### 8.1 Full Index a Project

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

### 8.2 Incremental Indexing

```typescript
let changeMap;

// First full index
let { result, changes } = await indexer.indexIncremental(files);
changeMap = changes;  // Save mtime snapshot

// ... after code changes ...

// Incremental: only process changed files
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

### 8.4 Registering Extra File Extensions

```typescript
import { TextLoader } from "@open-vera/core/loaders";

const loader = new TextLoader({
  basePath: "/project",
  extraExtensions: [".rs", ".kt", ".swift"],  // Register additional extensions
});
```

---

## 9. Error Handling

All loaders follow a consistent error handling strategy:

- **Unreadable files** (permissions, not found): Return empty array `[]`, no exception thrown
- **Files exceeding size limit**: Return empty array `[]`, silently skipped
- **Empty files**: Return empty array `[]`
- **Binary files**: `TextLoader` skips via null-byte detection
- **Structural parse failure**: `TypeScriptLoader` falls back to plain text chunking
- **Exceptions in `BatchIndexer`**: Reported via `onFileError` callback, other files continue processing unaffected

---

## 10. Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| `TextLoader` | Implemented | 60+ file types, binary detection, comment stripping, preprocessing hook |
| `TypeScriptLoader` | Implemented | Structural parsing (6 block types) + fallback chunking |
| `MarkdownLoader` | Implemented | Heading-aware chunking, frontmatter stripping, preprocessing hook |
| `chunkText` | Implemented | Paragraph/sentence boundary-aware, configurable chunkSize/overlap |
| `BatchIndexer` | Implemented | Concurrency control, incremental indexing (mtime comparison), error callbacks |
| Recursive directory scanning | Not integrated | `index()` / `indexIncremental()` accept file lists; directory scanning is at a higher layer |
| Real-time file watching | Not implemented | No fs.watch integration; incremental indexing requires manual invocation |
