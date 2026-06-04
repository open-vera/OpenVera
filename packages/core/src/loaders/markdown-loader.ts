/**
 * Markdown Loader — Parse .md/.mdx files with heading-aware chunking.
 *
 * Strips YAML frontmatter, preserves heading hierarchy in metadata,
 * and splits documents at heading boundaries for high-quality embeddings.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { chunkText } from "./chunk-text.js";
import type { VectorDocumentInput } from "../rag/types.js";
import { RAGError } from "../rag/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MarkdownLoaderOptions {
  /** Base path for computing relative paths and document IDs */
  basePath: string;
  /** Chunk size in characters for sections exceeding the limit (default: 1500) */
  chunkSize?: number;
  /** Chunk overlap in characters (default: 200) */
  chunkOverlap?: number;
  /** Maximum file size in bytes (default: 2MB) */
  maxFileSize?: number;
  /** Custom prefix for document IDs */
  idPrefix?: string;
  /** Whether to strip YAML frontmatter (default: true) */
  stripFrontmatter?: boolean;
  /**
   * Optional content preprocessor applied after frontmatter stripping.
   * Useful for removing HTML tags, normalizing links, etc.
   */
  preprocess?: (content: string, filePath: string) => string;
}

interface MarkdownSection {
  /** Heading text (e.g. "## Installation") */
  heading: string;
  /** Heading level (1-6) */
  level: number;
  /** Full text content including the heading line */
  content: string;
  /** Starting line number (1-based) */
  startLine: number;
}

interface FrontmatterResult {
  /** Content after frontmatter removal */
  content: string;
  /** Parsed frontmatter key-value pairs (values are strings) */
  metadata: Record<string, string>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx"]);

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_MAX_FILE_SIZE = 2_000_000;

// ── Markdown Loader ──────────────────────────────────────────────────────────

export class MarkdownLoader {
  private basePath: string;
  private chunkSize: number;
  private chunkOverlap: number;
  private maxFileSize: number;
  private idPrefix: string;
  private stripFrontmatter: boolean;
  private preprocess: ((content: string, filePath: string) => string) | null;

  constructor(options: MarkdownLoaderOptions) {
    if (!options.basePath) {
      throw new RAGError("LOADER_ERROR", "basePath is required");
    }
    this.basePath = options.basePath;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.idPrefix = options.idPrefix ?? "";
    this.stripFrontmatter = options.stripFrontmatter ?? true;
    this.preprocess = options.preprocess ?? null;
  }

  /**
   * Check if this loader can handle the given file path.
   */
  canHandle(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  }

  /**
   * Load and parse a Markdown file into document inputs.
   * Returns an empty array if the file cannot be read or exceeds size limits.
   */
  async load(filePath: string): Promise<VectorDocumentInput[]> {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size === 0 || fileStat.size > this.maxFileSize) {
      return [];
    }

    const rawContent = await readFile(filePath, "utf-8").catch(() => null);
    if (!rawContent) return [];

    const relPath = relative(this.basePath, filePath);

    let content = rawContent;
    let frontmatterMeta: Record<string, string> = {};

    if (this.stripFrontmatter) {
      const result = stripYamlFrontmatter(content);
      content = result.content;
      frontmatterMeta = result.metadata;
    }

    if (this.preprocess) {
      content = this.preprocess(content, filePath);
    }

    const sections = splitAtHeadings(content);

    if (sections.length <= 1) {
      return this.buildDocumentsFromChunks(relPath, content, frontmatterMeta);
    }

    return this.buildDocumentsFromSections(relPath, sections, frontmatterMeta);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private buildDocumentsFromSections(
    relPath: string,
    sections: MarkdownSection[],
    frontmatterMeta: Record<string, string>,
  ): VectorDocumentInput[] {
    const docs: VectorDocumentInput[] = [];

    for (const section of sections) {
      const sectionChunks = section.content.length > this.chunkSize
        ? chunkText(section.content, this.chunkSize, this.chunkOverlap)
        : [section.content];

      for (let i = 0; i < sectionChunks.length; i++) {
        const id = this.makeId(relPath, `heading:${section.heading}:${i}`);
        docs.push({
          id,
          content: sectionChunks[i],
          metadata: {
            source: relPath,
            fileType: "markdown",
            heading: section.heading,
            headingLevel: section.level,
            startLine: section.startLine,
            chunkIndex: i,
            totalChunks: sectionChunks.length,
            ...frontmatterMeta,
          },
        });
      }
    }

    return docs;
  }

  private buildDocumentsFromChunks(
    relPath: string,
    content: string,
    frontmatterMeta: Record<string, string>,
  ): VectorDocumentInput[] {
    const chunks = chunkText(content, this.chunkSize, this.chunkOverlap);

    return chunks.map((chunk, i) => ({
      id: this.makeId(relPath, `chunk:${i}`),
      content: chunk,
      metadata: {
        source: relPath,
        fileType: "markdown",
        chunkIndex: i,
        totalChunks: chunks.length,
        ...frontmatterMeta,
      },
    }));
  }

  private makeId(relPath: string, suffix: string): string {
    return this.idPrefix
      ? `${this.idPrefix}:${relPath}:${suffix}`
      : `${relPath}:${suffix}`;
  }
}

// ── Frontmatter Parsing ──────────────────────────────────────────────────────

/**
 * Strip YAML frontmatter delimited by `---` fences.
 * Only parses simple key: value pairs (no nested structures).
 */
function stripYamlFrontmatter(content: string): FrontmatterResult {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { content, metadata: {} };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { content, metadata: {} };
  }

  const frontmatterBlock = trimmed.slice(4, endIndex).trim();
  const remaining = trimmed.slice(endIndex + 4).trimStart();
  const metadata: Record<string, string> = {};

  for (const line of frontmatterBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key) metadata[key] = value;
  }

  return { content: remaining, metadata };
}

// ── Heading Splitting ────────────────────────────────────────────────────────

/**
 * Split Markdown content at heading boundaries (lines starting with `#`).
 * Each section includes its heading line and all content until the next heading.
 */
function splitAtHeadings(content: string): MarkdownSection[] {
  const lines = content.split("\n");
  const sections: MarkdownSection[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let currentLines: string[] = [];
  let currentStartLine = 1;

  function flushSection(endLine: number): void {
    if (currentLines.length === 0) return;
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      sections.push({
        heading: currentHeading,
        level: currentLevel,
        content: text,
        startLine: currentStartLine,
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      flushSection(i);
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentLines = [line];
      currentStartLine = i + 1;
    } else {
      currentLines.push(line);
    }
  }

  flushSection(lines.length);
  return sections;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createMarkdownLoader(options: MarkdownLoaderOptions): MarkdownLoader {
  return new MarkdownLoader(options);
}
