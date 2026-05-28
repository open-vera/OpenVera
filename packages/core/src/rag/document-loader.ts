/**
 * Document Loader — Read files from disk and prepare them for vector indexing.
 *
 * Supports: Markdown, JSON, TypeScript/JavaScript, and plain text files.
 * Automatically chunks large documents and preserves metadata (file path, type).
 *
 * Provides both synchronous (`load` / `loadFile`) and asynchronous
 * (`loadAsync` / `loadFileAsync`) variants.  Async methods use
 * `node:fs/promises` and are recommended for large codebases to avoid
 * blocking the event loop.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { Dirent } from "node:fs";
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
  /**
   * Optional content preprocessor.  Receives raw file content and file type;
   * return the transformed text (e.g. strip frontmatter, normalize whitespace).
   */
  preprocess?: (content: string, fileType: SupportedFileType) => string;
  /**
   * Progress callback invoked after each file is loaded.
   */
  onFileLoaded?: (info: FileLoadedInfo) => void;
}

export interface FileLoadedInfo {
  /** Absolute path of the loaded file */
  filePath: string;
  /** Relative path from rootDir */
  relPath: string;
  /** Detected file type */
  fileType: SupportedFileType;
  /** Number of chunks produced for this file */
  chunkCount: number;
  /** Running count of files loaded so far */
  filesLoadedSoFar: number;
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
  private preprocess: ((content: string, fileType: SupportedFileType) => string) | null;
  private onFileLoaded: ((info: FileLoadedInfo) => void) | null;

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
    this.preprocess = options.preprocess ?? null;
    this.onFileLoaded = options.onFileLoaded ?? null;
  }

  // ── Synchronous API ──────────────────────────────────────────────────────

  /**
   * Load all matching files from the root directory (synchronous).
   */
  load(): LoadResult {
    const files = this.scanDir(this.rootDir);
    const documents: VectorDocumentInput[] = [];
    let filesLoaded = 0;

    for (const filePath of files) {
      try {
        const result = this.processFile(filePath, filesLoaded);
        if (!result) continue;

        filesLoaded++;
        documents.push(...result.docs);
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
   * Load a single file and return its document inputs (synchronous).
   */
  loadFile(filePath: string): VectorDocumentInput[] {
    const result = this.processFile(filePath, 0);
    return result?.docs ?? [];
  }

  // ── Asynchronous API ─────────────────────────────────────────────────────

  /**
   * Load all matching files from the root directory (async).
   *
   * Uses `node:fs/promises` so the event loop is not blocked during I/O.
   */
  async loadAsync(): Promise<LoadResult> {
    const files = await this.scanDirAsync(this.rootDir);
    const documents: VectorDocumentInput[] = [];
    let filesLoaded = 0;

    for (const filePath of files) {
      try {
        const result = await this.processFileAsync(filePath, filesLoaded);
        if (!result) continue;

        filesLoaded++;
        documents.push(...result.docs);
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
   * Load a single file and return its document inputs (async).
   */
  async loadFileAsync(filePath: string): Promise<VectorDocumentInput[]> {
    const result = await this.processFileAsync(filePath, 0);
    return result?.docs ?? [];
  }

  // ── Chunking (public for direct use) ─────────────────────────────────────

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

  // ── Internal ─────────────────────────────────────────────────────────────

  private processFile(
    filePath: string,
    loadedSoFar: number,
  ): { docs: VectorDocumentInput[] } | null {
    const content = this.readAndPreprocess(filePath);
    if (!content) return null;

    const relPath = relative(this.rootDir, filePath);
    const fileType = this.getFileType(filePath);
    const chunks = this.chunkText(content);
    const docs = this.buildDocuments(relPath, fileType, chunks);

    if (this.onFileLoaded) {
      this.onFileLoaded({
        filePath,
        relPath,
        fileType,
        chunkCount: chunks.length,
        filesLoadedSoFar: loadedSoFar + 1,
      });
    }

    return { docs };
  }

  private async processFileAsync(
    filePath: string,
    loadedSoFar: number,
  ): Promise<{ docs: VectorDocumentInput[] } | null> {
    const content = await this.readAndPreprocessAsync(filePath);
    if (!content) return null;

    const relPath = relative(this.rootDir, filePath);
    const fileType = this.getFileType(filePath);
    const chunks = this.chunkText(content);
    const docs = this.buildDocuments(relPath, fileType, chunks);

    if (this.onFileLoaded) {
      this.onFileLoaded({
        filePath,
        relPath,
        fileType,
        chunkCount: chunks.length,
        filesLoadedSoFar: loadedSoFar + 1,
      });
    }

    return { docs };
  }

  private buildDocuments(
    relPath: string,
    fileType: SupportedFileType,
    chunks: string[],
  ): VectorDocumentInput[] {
    return chunks.map((chunk, i) => ({
      id: this.idPrefix
        ? `${this.idPrefix}:${relPath}:${i}`
        : `${relPath}:${i}`,
      content: chunk,
      metadata: {
        source: relPath,
        fileType,
        chunkIndex: i,
        totalChunks: chunks.length,
      },
    }));
  }

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

  private async scanDirAsync(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries as Dirent[]) {
        const fullPath = join(dir, entry.name);
        const relPath = relative(this.rootDir, fullPath);

        if (this.shouldExclude(relPath)) continue;

        if (entry.isDirectory()) {
          results.push(...await this.scanDirAsync(fullPath));
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

  private readAndPreprocess(filePath: string): string | null {
    try {
      const fileStat = statSync(filePath);
      if (fileStat.size > this.maxFileSize) return null;
      if (fileStat.size === 0) return null;
      let content = readFileSync(filePath, "utf-8");
      if (this.preprocess) {
        content = this.preprocess(content, this.getFileType(filePath));
      }
      return content;
    } catch {
      return null;
    }
  }

  private async readAndPreprocessAsync(filePath: string): Promise<string | null> {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > this.maxFileSize) return null;
      if (fileStat.size === 0) return null;
      let content = await readFile(filePath, "utf-8");
      if (this.preprocess) {
        content = this.preprocess(content, this.getFileType(filePath));
      }
      return content;
    } catch {
      return null;
    }
  }

  getFileType(filePath: string): SupportedFileType {
    const ext = extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext] ?? "text";
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDocumentLoader(options: DocumentLoaderOptions): DocumentLoader {
  return new DocumentLoader(options);
}
