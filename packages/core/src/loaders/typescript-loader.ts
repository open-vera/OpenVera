/**
 * TypeScript Loader — Parse .ts/.tsx files with structural awareness.
 *
 * Extracts meaningful code blocks (exports, classes, functions, interfaces)
 * for high-quality vector embeddings.  Falls back to plain chunking for
 * files that cannot be structurally parsed.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { chunkText } from "./chunk-text.js";
import type { VectorDocumentInput } from "../rag/types.js";
import { RAGError } from "../rag/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TypeScriptLoaderOptions {
  /** Base path for computing relative paths and document IDs */
  basePath: string;
  /** Chunk size in characters for fallback chunking (default: 1500) */
  chunkSize?: number;
  /** Chunk overlap in characters (default: 200) */
  chunkOverlap?: number;
  /** Maximum file size in bytes (default: 2MB) */
  maxFileSize?: number;
  /** Custom prefix for document IDs */
  idPrefix?: string;
  /** Whether to extract structural blocks or use plain chunking (default: true) */
  structuralParsing?: boolean;
}

interface CodeBlock {
  /** Block type identifier */
  type: string;
  /** Optional name (function/class/interface name) */
  name?: string;
  /** Full text content of the block */
  content: string;
  /** Starting line number (1-based) */
  startLine: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_MAX_FILE_SIZE = 2_000_000;

/** Patterns that signal the start of an extractable code block */
const BLOCK_PATTERNS = [
  { regex: /^(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)/m, type: "class" },
  { regex: /^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/m, type: "function" },
  { regex: /^(export\s+)?interface\s+(\w+)/m, type: "interface" },
  { regex: /^(export\s+)?type\s+(\w+)/m, type: "type" },
  { regex: /^(export\s+)?enum\s+(\w+)/m, type: "enum" },
  { regex: /^(export\s+)?(const|let|var)\s+(\w+)/m, type: "variable" },
];

// ── TypeScript Loader ────────────────────────────────────────────────────────

export class TypeScriptLoader {
  private basePath: string;
  private chunkSize: number;
  private chunkOverlap: number;
  private maxFileSize: number;
  private idPrefix: string;
  private structuralParsing: boolean;

  constructor(options: TypeScriptLoaderOptions) {
    if (!options.basePath) {
      throw new RAGError("LOADER_ERROR", "basePath is required");
    }
    this.basePath = options.basePath;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.idPrefix = options.idPrefix ?? "";
    this.structuralParsing = options.structuralParsing ?? true;
  }

  /**
   * Check if this loader can handle the given file path.
   */
  canHandle(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  }

  /**
   * Load and parse a TypeScript file into document inputs.
   * Returns an empty array if the file cannot be read or exceeds size limits.
   */
  async load(filePath: string): Promise<VectorDocumentInput[]> {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size === 0 || fileStat.size > this.maxFileSize) {
      return [];
    }

    const content = await readFile(filePath, "utf-8").catch(() => null);
    if (!content) return [];

    const relPath = relative(this.basePath, filePath);
    const fileExt = extname(filePath).toLowerCase();

    if (this.structuralParsing) {
      const blocks = extractCodeBlocks(content);
      if (blocks.length > 0) {
        return this.buildDocumentsFromBlocks(relPath, fileExt, blocks);
      }
    }

    return this.buildDocumentsFromChunks(relPath, fileExt, content);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private buildDocumentsFromBlocks(
    relPath: string,
    fileExt: string,
    blocks: CodeBlock[],
  ): VectorDocumentInput[] {
    const docs: VectorDocumentInput[] = [];
    const docType = fileExt === ".tsx" ? "typescript-react" : "typescript";

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const id = this.makeId(relPath, `${block.type}:${block.name ?? i}`);

      docs.push({
        id,
        content: block.content,
        metadata: {
          source: relPath,
          fileType: docType,
          blockType: block.type,
          blockName: block.name,
          startLine: block.startLine,
          structuralParse: true,
        },
      });
    }

    return docs;
  }

  private buildDocumentsFromChunks(
    relPath: string,
    fileExt: string,
    content: string,
  ): VectorDocumentInput[] {
    const chunks = chunkText(content, this.chunkSize, this.chunkOverlap);
    const docType = fileExt === ".tsx" ? "typescript-react" : "typescript";

    return chunks.map((chunk, i) => ({
      id: this.makeId(relPath, `chunk:${i}`),
      content: chunk,
      metadata: {
        source: relPath,
        fileType: docType,
        chunkIndex: i,
        totalChunks: chunks.length,
        structuralParse: false,
      },
    }));
  }

  private makeId(relPath: string, suffix: string): string {
    return this.idPrefix
      ? `${this.idPrefix}:${relPath}:${suffix}`
      : `${relPath}:${suffix}`;
  }
}

// ── Structural Parsing ───────────────────────────────────────────────────────

/**
 * Extract top-level code blocks from TypeScript source.
 *
 * Uses brace-matching to determine block boundaries.  Falls back to
 * extracting the full line if no opening brace is found (e.g. type aliases).
 */
function extractCodeBlocks(content: string): CodeBlock[] {
  const lines = content.split("\n");
  const blocks: CodeBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of BLOCK_PATTERNS) {
      const match = line.match(pattern.regex);
      if (!match) continue;

      const name = match[match.length - 1];
      const blockContent = extractBlock(lines, i);

      blocks.push({
        type: pattern.type,
        name,
        content: blockContent.text,
        startLine: i + 1,
      });

      i = blockContent.endLine;
      break;
    }
  }

  return blocks;
}

/**
 * Extract a block starting from `startLine` using brace counting.
 * If no braces are found, returns the single declaration line.
 */
function extractBlock(
  lines: string[],
  startLine: number,
): { text: string; endLine: number } {
  const firstLine = lines[startLine];

  // Single-line declaration (no brace)
  if (!firstLine.includes("{") && firstLine.includes(";")) {
    return { text: firstLine.trim(), endLine: startLine };
  }

  let braceCount = 0;
  let foundOpen = false;
  let endLine = startLine;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") {
        braceCount++;
        foundOpen = true;
      } else if (ch === "}") {
        braceCount--;
      }
    }

    if (foundOpen && braceCount === 0) {
      endLine = i;
      break;
    }
    endLine = i;
  }

  const text = lines.slice(startLine, endLine + 1).join("\n").trim();
  return { text, endLine };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTypeScriptLoader(options: TypeScriptLoaderOptions): TypeScriptLoader {
  return new TypeScriptLoader(options);
}
