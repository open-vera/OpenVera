/**
 * Document Loader — Read files from disk and prepare them for vector indexing.
 *
 * Supports: Markdown, JSON, TypeScript/JavaScript, and plain text files.
 * Automatically chunks large documents and preserves metadata (file path, type).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { VectorDocumentInput } from "./types.js";
import { RAGError } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SupportedFileType = "markdown" | "json" | "typescript" | "text";

export interface DocumentLoaderOptions {
  /** Root directory to scan */
  rootDir: string;
  /** File extensions to include (default: all supported) */
  extensions?: string[];
  /** Patterns to exclude (glob-like, matched against relative path) */
  exclude?: string[];
  /** Maximum file size in bytes (default: 1MB) */
  maxFileSize?: number;
  /** Chunk size in characters (default: 1500) */
  chunkSize?: number;
  /** Chunk overlap in characters (default: 200) */
  chunkOverlap?: number;
  /** Custom prefix for document IDs (default: relative file path) */
  idPrefix?: string;
}

export interface LoadedDocument {
  /** Unique document ID */
  id: string;
  /** Text content (or chunk) */
  content: string;
  /** Metadata */
  metadata: Record<string, unknown>;
}

export interface LoadResult {
  /** All loaded documents/chunks */
  documents: VectorDocumentInput[];
  /** Number of files scanned */
  filesScanned: number;
  /** Number of files loaded (passed filters) */
  filesLoaded: number;
  /** Number of chunks produced */
  chunksProduced: number;
}

// ── Extension Mapping ────────────────────────────────────────────────────────

const EXTENSION_MAP: Record<string, SupportedFileType> = {
  ".md": "markdown",
  ".mdx": "markdown",
  ".json": "json",
  ".jsonl": "json",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "text",
  ".jsx": "text",
  ".mjs": "text",
  ".cjs": "text",
  ".txt": "text",
  ".log": "text",
  ".yaml": "text",
  ".yml": "text",
  ".toml": "text",
  ".ini": "text",
  ".cfg": "text",
  ".env": "text",
  ".sh": "text",
  ".bash": "text",
  ".zsh": "text",
  ".py": "text",
  ".go": "text",
  ".rs": "text",
  ".java": "text",
  ".c": "text",
  ".cpp": "text",
  ".h": "text",
  ".css": "text",
  ".html": "text",
  ".xml": "text",
  ".sql": "text",
};

const DEFAULT_EXTENSIONS = Object.keys(EXTENSION_MAP);

// ── Document Loader ──────────────────────────────────────────────────────────

export class DocumentLoader {
  private rootDir: string;
  private extensions: Set<string>;
  private excludePatterns: string[];
  private maxFileSize: number;
  private chunkSize: number;
  private chunkOverlap: number;
  private idPrefix: string;

  constructor(options: DocumentLoaderOptions) {
    if (!options.rootDir) throw new RAGError("LOADER_ERROR", "rootDir is required");
    this.rootDir = options.rootDir;
    this.extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
    this.excludePatterns = options.exclude ?? [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      "coverage",
    ];
    this.maxFileSize = options.maxFileSize ?? 1_000_000; // 1MB
    this.chunkSize = options.chunkSize ?? 1500;
    this.chunkOverlap = options.chunkOverlap ?? 200;
    this.idPrefix = options.idPrefix ?? "";
  }

  /**
   * Load all matching files from the root directory.
   */
  load(): LoadResult {
    const files = this.scanDir(this.rootDir);
    const documents: VectorDocumentInput[] = [];
    let filesLoaded = 0;

    for (const filePath of files) {
      try {
        const content = this.readFile(filePath);
        if (!content) continue;

        filesLoaded++;
        const relPath = relative(this.rootDir, filePath);
        const fileType = this.getFileType(filePath);
        const chunks = this.chunkText(content);

        for (let i = 0; i < chunks.length; i++) {
          const id = this.idPrefix
            ? `${this.idPrefix}:${relPath}:${i}`
            : `${relPath}:${i}`;
          documents.push({
            id,
            content: chunks[i],
            metadata: {
              source: relPath,
              fileType,
              chunkIndex: i,
              totalChunks: chunks.length,
            },
          });
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return {
      documents,
      filesScanned: files.length,
      filesLoaded,
      chunksProduced: documents.length,
    };
  }

  /**
   * Load a single file and return its document inputs.
   */
  loadFile(filePath: string): VectorDocumentInput[] {
    const content = this.readFile(filePath);
    if (!content) return [];

    const relPath = relative(this.rootDir, filePath);
    const fileType = this.getFileType(filePath);
    const chunks = this.chunkText(content);

    return chunks.map((chunk, i) => ({
      id: this.idPrefix ? `${this.idPrefix}:${relPath}:${i}` : `${relPath}:${i}`,
      content: chunk,
      metadata: {
        source: relPath,
        fileType,
        chunkIndex: i,
        totalChunks: chunks.length,
      },
    }));
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private scanDir(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = relative(this.rootDir, fullPath);

        if (this.shouldExclude(relPath)) continue;

        if (entry.isDirectory()) {
          results.push(...this.scanDir(fullPath));
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (this.extensions.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }
    return results;
  }

  private shouldExclude(relPath: string): boolean {
    return this.excludePatterns.some((pattern) => {
      if (pattern.includes("*") || pattern.includes("?")) {
        // Simple glob: match against each path segment
        const segments = relPath.split("/");
        return segments.some((s) => this.simpleGlob(s, pattern));
      }
      return relPath.includes(pattern);
    });
  }

  private simpleGlob(text: string, pattern: string): boolean {
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    );
    return regex.test(text);
  }

  private readFile(filePath: string): string | null {
    try {
      const stat = statSync(filePath);
      if (stat.size > this.maxFileSize) return null;
      if (stat.size === 0) return null;
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private getFileType(filePath: string): SupportedFileType {
    const ext = extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext] ?? "text";
  }

  /**
   * Split text into overlapping chunks.
   * Tries to split at paragraph/sentence boundaries when possible.
   */
  chunkText(text: string): string[] {
    if (text.length <= this.chunkSize) return [text];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + this.chunkSize, text.length);

      // Try to find a natural break point (paragraph or sentence)
      if (end < text.length) {
        const slice = text.slice(start, end);
        const paragraphBreak = slice.lastIndexOf("\n\n");
        const sentenceBreak = slice.lastIndexOf(". ");

        if (paragraphBreak > this.chunkSize * 0.5) {
          end = start + paragraphBreak + 2;
        } else if (sentenceBreak > this.chunkSize * 0.5) {
          end = start + sentenceBreak + 2;
        }
      }

      chunks.push(text.slice(start, end).trim());

      // Move start forward, accounting for overlap
      const nextStart = end - this.chunkOverlap;
      if (nextStart <= start) {
        // Prevent infinite loop: force advance
        start = end;
      } else {
        start = nextStart;
      }
    }

    return chunks.filter((c) => c.length > 0);
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDocumentLoader(options: DocumentLoaderOptions): DocumentLoader {
  return new DocumentLoader(options);
}
