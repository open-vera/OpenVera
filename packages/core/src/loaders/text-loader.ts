/**
 * Text Loader — Read plain-text files (txt, log, yaml, sh, py, go, …)
 * and prepare them for vector indexing.
 *
 * Handles encoding detection, binary filtering, and content normalization
 * for a wide range of text-based file formats.
 */

import { open, readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import type { VectorDocumentInput } from "../rag/types.js";
import { RAGError } from "../rag/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TextLoaderOptions {
  /** Base path for computing relative paths and document IDs */
  basePath: string;
  /** Chunk size in characters (default: 1500) */
  chunkSize?: number;
  /** Chunk overlap in characters (default: 200) */
  chunkOverlap?: number;
  /** Maximum file size in bytes (default: 1MB) */
  maxFileSize?: number;
  /** Custom prefix for document IDs */
  idPrefix?: string;
  /**
   * Additional extensions to treat as text (beyond the built-in set).
   * Values should include the dot, e.g. [".rs", ".kt"].
   */
  extraExtensions?: string[];
  /**
   * Optional content preprocessor applied after reading.
   * Useful for stripping ANSI codes, normalizing whitespace, etc.
   */
  preprocess?: (content: string, filePath: string) => string;
}

interface FileTypeInfo {
  category: string;
  /** Whether to strip comment headers (e.g. shebang lines) */
  stripComments: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_MAX_FILE_SIZE = 1_000_000;

/** Bytes to sniff for binary detection */
const BINARY_SNIFF_SIZE = 8192;

const EXTENSION_INFO: Record<string, FileTypeInfo> = {
  ".txt": { category: "plaintext", stripComments: false },
  ".text": { category: "plaintext", stripComments: false },
  ".log": { category: "log", stripComments: false },
  ".yaml": { category: "config", stripComments: false },
  ".yml": { category: "config", stripComments: false },
  ".toml": { category: "config", stripComments: false },
  ".ini": { category: "config", stripComments: false },
  ".cfg": { category: "config", stripComments: false },
  ".env": { category: "config", stripComments: false },
  ".properties": { category: "config", stripComments: false },
  ".sh": { category: "shell", stripComments: true },
  ".bash": { category: "shell", stripComments: true },
  ".zsh": { category: "shell", stripComments: true },
  ".fish": { category: "shell", stripComments: true },
  ".py": { category: "python", stripComments: true },
  ".rb": { category: "ruby", stripComments: true },
  ".go": { category: "go", stripComments: true },
  ".rs": { category: "rust", stripComments: true },
  ".java": { category: "java", stripComments: true },
  ".c": { category: "c", stripComments: true },
  ".cpp": { category: "cpp", stripComments: true },
  ".h": { category: "c-header", stripComments: true },
  ".hpp": { category: "cpp-header", stripComments: true },
  ".css": { category: "style", stripComments: false },
  ".scss": { category: "style", stripComments: false },
  ".less": { category: "style", stripComments: false },
  ".html": { category: "markup", stripComments: false },
  ".xml": { category: "markup", stripComments: false },
  ".svg": { category: "markup", stripComments: false },
  ".sql": { category: "sql", stripComments: false },
  ".graphql": { category: "schema", stripComments: false },
  ".proto": { category: "schema", stripComments: true },
  ".js": { category: "javascript", stripComments: false },
  ".jsx": { category: "javascript-react", stripComments: false },
  ".mjs": { category: "javascript", stripComments: false },
  ".cjs": { category: "javascript", stripComments: false },
  ".vue": { category: "vue", stripComments: false },
  ".svelte": { category: "svelte", stripComments: false },
  ".dockerfile": { category: "docker", stripComments: false },
  ".makefile": { category: "build", stripComments: true },
  ".cmake": { category: "build", stripComments: true },
  ".gradle": { category: "build", stripComments: true },
};

// ── Text Loader ──────────────────────────────────────────────────────────────

export class TextLoader {
  private basePath: string;
  private chunkSize: number;
  private chunkOverlap: number;
  private maxFileSize: number;
  private idPrefix: string;
  private extensions: Set<string>;
  private preprocess: ((content: string, filePath: string) => string) | null;

  constructor(options: TextLoaderOptions) {
    if (!options.basePath) {
      throw new RAGError("LOADER_ERROR", "basePath is required");
    }
    this.basePath = options.basePath;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.idPrefix = options.idPrefix ?? "";
    this.preprocess = options.preprocess ?? null;

    this.extensions = new Set(Object.keys(EXTENSION_INFO));
    if (options.extraExtensions) {
      for (const ext of options.extraExtensions) {
        this.extensions.add(ext.startsWith(".") ? ext : `.${ext}`);
      }
    }
  }

  /**
   * Check if this loader can handle the given file path.
   */
  canHandle(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return this.extensions.has(ext);
  }

  /**
   * Load and parse a text file into document inputs.
   * Returns an empty array if the file cannot be read, is binary, or exceeds size limits.
   */
  async load(filePath: string): Promise<VectorDocumentInput[]> {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size === 0 || fileStat.size > this.maxFileSize) {
      return [];
    }

    // Binary sniff — read first N bytes and check for null bytes
    const buffer = Buffer.alloc(Math.min(fileStat.size, BINARY_SNIFF_SIZE));
    const fh = await open(filePath, "r");
    try {
      await fh.read(buffer, 0, buffer.length, 0);
    } finally {
      await fh.close();
    }

    if (isBinaryContent(buffer)) return [];

    const content = await readFile(filePath, "utf-8").catch(() => null);
    if (!content) return [];

    const relPath = relative(this.basePath, filePath);
    const ext = extname(filePath).toLowerCase();
    const typeInfo = EXTENSION_INFO[ext] ?? { category: "text", stripComments: false };

    let processed = content;
    if (typeInfo.stripComments) {
      processed = stripLeadingComments(processed);
    }
    if (this.preprocess) {
      processed = this.preprocess(processed, filePath);
    }

    const chunks = chunkText(processed, this.chunkSize, this.chunkOverlap);

    return chunks.map((chunk, i) => ({
      id: this.makeId(relPath, i),
      content: chunk,
      metadata: {
        source: relPath,
        fileType: "text",
        textCategory: typeInfo.category,
        chunkIndex: i,
        totalChunks: chunks.length,
        extension: ext,
      },
    }));
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private makeId(relPath: string, chunkIndex: number): string {
    return this.idPrefix
      ? `${this.idPrefix}:${relPath}:${chunkIndex}`
      : `${relPath}:${chunkIndex}`;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Detect binary content by checking for null bytes in the buffer.
 */
function isBinaryContent(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Strip leading comment lines (shebang, block comments) from source text.
 * Preserves content after the initial comment block.
 */
function stripLeadingComments(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  let inBlockComment = false;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith("#!")) {
      i++;
      continue;
    }

    if (trimmed.startsWith("/*")) {
      inBlockComment = true;
      if (trimmed.includes("*/")) {
        inBlockComment = false;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      i++;
      continue;
    }

    if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    break;
  }

  return lines.slice(i).join("\n");
}

/**
 * Split text into overlapping chunks, breaking at paragraph/sentence boundaries.
 */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const slice = text.slice(start, end);
      const paragraphBreak = slice.lastIndexOf("\n\n");
      const sentenceBreak = slice.lastIndexOf(". ");

      if (paragraphBreak > chunkSize * 0.5) {
        end = start + paragraphBreak + 2;
      } else if (sentenceBreak > chunkSize * 0.5) {
        end = start + sentenceBreak + 2;
      }
    }

    chunks.push(text.slice(start, end).trim());

    const nextStart = end - overlap;
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }

  return chunks.filter((c) => c.length > 0);
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTextLoader(options: TextLoaderOptions): TextLoader {
  return new TextLoader(options);
}
