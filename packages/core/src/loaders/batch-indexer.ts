/**
 * Batch Indexer — Concurrent document loading and vector store indexing.
 *
 * Dispatches file paths to the appropriate loader based on extension,
 * processes them concurrently with configurable parallelism, and supports
 * incremental updates (only re-index files that have changed).
 */

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { VectorDocumentInput } from "../rag/types.js";
import { RAGError } from "../rag/types.js";
import { TypeScriptLoader, type TypeScriptLoaderOptions } from "./typescript-loader.js";
import { TextLoader, type TextLoaderOptions } from "./text-loader.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BatchIndexerOptions {
  /** Base path for resolving relative paths */
  basePath: string;
  /** Maximum concurrent file processing operations (default: 8) */
  concurrency?: number;
  /** Options passed to TypeScriptLoader */
  typescript?: Omit<TypeScriptLoaderOptions, "basePath">;
  /** Options passed to TextLoader */
  text?: Omit<TextLoaderOptions, "basePath">;
  /** Progress callback invoked after each file is processed */
  onFileIndexed?: (info: FileIndexedInfo) => void;
  /**
   * Error callback invoked when a file fails to load.
   * If not provided, errors are silently skipped.
   */
  onFileError?: (info: FileErrorInfo) => void;
}

export interface FileIndexedInfo {
  filePath: string;
  documentCount: number;
  filesProcessedSoFar: number;
  totalFiles: number;
}

export interface FileErrorInfo {
  filePath: string;
  error: unknown;
  filesProcessedSoFar: number;
  totalFiles: number;
}

export interface BatchIndexResult {
  /** All loaded document inputs, ready for embedding + upsert */
  documents: VectorDocumentInput[];
  /** Number of files successfully processed */
  filesProcessed: number;
  /** Number of files that failed */
  filesFailed: number;
  /** Number of files skipped (unsupported extension, empty, etc.) */
  filesSkipped: number;
  /** Total chunks produced */
  chunksProduced: number;
  /** Processing duration in milliseconds */
  durationMs: number;
}

/**
 * Tracks per-file change state for incremental indexing.
 * Key: file path, Value: mtimeMs at last successful index.
 */
export type FileChangeMap = Map<string, number>;

export interface IncrementalIndexResult extends BatchIndexResult {
  /** Files that were re-indexed due to changes */
  filesUpdated: number;
  /** Files unchanged since last index (skipped) */
  filesUnchanged: number;
}

export interface IncrementalIndexOptions extends BatchIndexerOptions {
  /** Previous change map from last indexing run */
  previousChanges?: FileChangeMap;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 8;
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

// ── Batch Indexer ────────────────────────────────────────────────────────────

export class BatchIndexer {
  private tsLoader: TypeScriptLoader;
  private textLoader: TextLoader;
  private concurrency: number;
  private onFileIndexed: ((info: FileIndexedInfo) => void) | null;
  private onFileError: ((info: FileErrorInfo) => void) | null;

  constructor(options: BatchIndexerOptions) {
    if (!options.basePath) {
      throw new RAGError("LOADER_ERROR", "basePath is required");
    }

    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.onFileIndexed = options.onFileIndexed ?? null;
    this.onFileError = options.onFileError ?? null;

    this.tsLoader = new TypeScriptLoader({
      basePath: options.basePath,
      ...options.typescript,
    });

    this.textLoader = new TextLoader({
      basePath: options.basePath,
      ...options.text,
    });
  }

  /**
   * Process all given file paths concurrently and return indexed documents.
   */
  async index(filePaths: string[]): Promise<BatchIndexResult> {
    const start = Date.now();
    const documents: VectorDocumentInput[] = [];
    let filesProcessed = 0;
    let filesFailed = 0;
    let filesSkipped = 0;

    await runConcurrent(filePaths, this.concurrency, async (filePath, i) => {
      const loader = this.selectLoader(filePath);
      if (!loader) {
        filesSkipped++;
        return;
      }

      try {
        const docs = await loader.load(filePath);
        if (docs.length === 0) {
          filesSkipped++;
          return;
        }

        filesProcessed++;
        documents.push(...docs);

        if (this.onFileIndexed) {
          this.onFileIndexed({
            filePath,
            documentCount: docs.length,
            filesProcessedSoFar: filesProcessed,
            totalFiles: filePaths.length,
          });
        }
      } catch (err) {
        filesFailed++;
        if (this.onFileError) {
          this.onFileError({
            filePath,
            error: err,
            filesProcessedSoFar: filesProcessed + filesFailed,
            totalFiles: filePaths.length,
          });
        }
      }
    });

    return {
      documents,
      filesProcessed,
      filesFailed,
      filesSkipped,
      chunksProduced: documents.length,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Incremental index — only re-index files whose mtime has changed.
   *
   * Returns the result plus an updated change map for the next run.
   */
  async indexIncremental(
    filePaths: string[],
    options?: IncrementalIndexOptions,
  ): Promise<{ result: IncrementalIndexResult; changes: FileChangeMap }> {
    const start = Date.now();
    const previousChanges = options?.previousChanges ?? new Map<string, number>();
    const currentChanges: FileChangeMap = new Map();
    const documents: VectorDocumentInput[] = [];
    let filesProcessed = 0;
    let filesFailed = 0;
    let filesSkipped = 0;
    let filesUpdated = 0;
    let filesUnchanged = 0;

    // Phase 1: Check which files have changed
    const filesToProcess: string[] = [];
    const mtimeResults = await Promise.allSettled(
      filePaths.map(async (fp) => {
        const s = await stat(fp);
        return { filePath: fp, mtimeMs: s.mtimeMs };
      }),
    );

    for (const result of mtimeResults) {
      if (result.status === "rejected") {
        filesSkipped++;
        continue;
      }

      const { filePath, mtimeMs } = result.value;
      currentChanges.set(filePath, mtimeMs);

      const previousMtime = previousChanges.get(filePath);
      if (previousMtime !== undefined && previousMtime >= mtimeMs) {
        filesUnchanged++;
        continue;
      }

      filesToProcess.push(filePath);
    }

    // Phase 2: Load only changed files concurrently
    await runConcurrent(filesToProcess, this.concurrency, async (filePath) => {
      const loader = this.selectLoader(filePath);
      if (!loader) {
        filesSkipped++;
        return;
      }

      try {
        const docs = await loader.load(filePath);
        if (docs.length === 0) {
          filesSkipped++;
          return;
        }

        filesProcessed++;
        filesUpdated++;
        documents.push(...docs);

        if (this.onFileIndexed) {
          this.onFileIndexed({
            filePath,
            documentCount: docs.length,
            filesProcessedSoFar: filesProcessed,
            totalFiles: filesToProcess.length,
          });
        }
      } catch (err) {
        filesFailed++;
        if (this.onFileError) {
          this.onFileError({
            filePath,
            error: err,
            filesProcessedSoFar: filesProcessed + filesFailed,
            totalFiles: filesToProcess.length,
          });
        }
      }
    });

    const result: IncrementalIndexResult = {
      documents,
      filesProcessed,
      filesFailed,
      filesSkipped,
      chunksProduced: documents.length,
      durationMs: Date.now() - start,
      filesUpdated,
      filesUnchanged,
    };

    return { result, changes: currentChanges };
  }

  /**
   * Select the appropriate loader for a file based on its extension.
   */
  private selectLoader(filePath: string): TypeScriptLoader | TextLoader | null {
    const ext = extname(filePath).toLowerCase();

    if (TS_EXTENSIONS.has(ext) && this.tsLoader.canHandle(filePath)) {
      return this.tsLoader;
    }

    if (this.textLoader.canHandle(filePath)) {
      return this.textLoader;
    }

    return null;
  }
}

// ── Concurrency Utility ──────────────────────────────────────────────────────

/**
 * Run async `task` over `items` with at most `limit` concurrent operations.
 * Preserves input order for results, not execution order.
 */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      await task(items[idx], idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createBatchIndexer(options: BatchIndexerOptions): BatchIndexer {
  return new BatchIndexer(options);
}
