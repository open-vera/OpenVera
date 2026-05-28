/**
 * TopicOrganizer — OC11
 *
 * Organizes memory files by topic under a directory structure:
 *   {baseDir}/{topic}.md
 *
 * Each topic file has a token limit to prevent unbounded growth.
 * When a topic file exceeds the limit, it's split into sub-topics
 * or the oldest entries are archived.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TopicOrganizerOptions {
  /** Base directory for topic files. Default: ~/.vera/memories */
  baseDir: string;
  /** Max tokens per topic file. Default: 4000 */
  maxTokensPerFile?: number;
  /** Estimate: chars per token (for token counting). Default: 4 */
  charsPerToken?: number;
}

export interface TopicFile {
  /** Topic name (derived from filename) */
  topic: string;
  /** Absolute path to the .md file */
  path: string;
  /** Current content */
  content: string;
  /** Estimated token count */
  estimatedTokens: number;
}

export interface TopicMemoryEntry {
  /** The key/label for this memory */
  key: string;
  /** The content/value */
  value: string;
  /** When it was added */
  addedAt: string;
  /** Importance score */
  importance: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_CHARS_PER_TOKEN = 4;
const MAX_FILENAME_LENGTH = 64;

// ── Helpers ────────────────────────────────────────────────────────────────

function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

function sanitizeFilename(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_FILENAME_LENGTH);
}

function formatEntry(entry: TopicMemoryEntry): string {
  const lines = [
    `### ${entry.key}`,
    `> importance: ${entry.importance.toFixed(2)} | added: ${entry.addedAt}`,
    "",
    entry.value,
    "",
    "---",
    "",
  ];
  return lines.join("\n");
}

function parseEntries(content: string): TopicMemoryEntry[] {
  const entries: TopicMemoryEntry[] = [];
  const sections = content.split(/^### /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const key = lines[0]?.trim();
    if (!key) continue;

    // Parse metadata from blockquote
    const metaLine = lines.find((l) => l.startsWith("> "));
    let importance = 0.5;
    let addedAt = new Date().toISOString();

    if (metaLine) {
      const impMatch = metaLine.match(/importance:\s*([\d.]+)/);
      const dateMatch = metaLine.match(/added:\s*(\S+)/);
      if (impMatch) importance = parseFloat(impMatch[1]!);
      if (dateMatch) addedAt = dateMatch[1]!;
    }

    // Extract value (lines between metadata and separator)
    const metaIdx = lines.findIndex((l) => l.startsWith("> "));
    const sepIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    const valueStart = metaIdx >= 0 ? metaIdx + 2 : 1;
    const valueEnd = sepIdx > 0 ? sepIdx : lines.length;
    const value = lines.slice(valueStart, valueEnd).join("\n").trim();

    if (key && value) {
      entries.push({ key, value, addedAt, importance });
    }
  }

  return entries;
}

// ── TopicOrganizer ─────────────────────────────────────────────────────────

export class TopicOrganizer {
  private readonly baseDir: string;
  private readonly maxTokens: number;
  private readonly charsPerToken: number;

  constructor(options: TopicOrganizerOptions) {
    this.baseDir = options.baseDir;
    this.maxTokens = options.maxTokensPerFile ?? DEFAULT_MAX_TOKENS;
    this.charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * List all topic files in the base directory.
   */
  listTopics(): TopicFile[] {
    if (!existsSync(this.baseDir)) return [];

    const files = readdirSync(this.baseDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    return files.map((filename) => {
      const path = join(this.baseDir, filename);
      const content = readFileSync(path, "utf-8");
      const topic = basename(filename, ".md");
      return {
        topic,
        path,
        content,
        estimatedTokens: estimateTokens(content, this.charsPerToken),
      };
    });
  }

  /**
   * Get a specific topic file by name.
   */
  getTopic(topic: string): TopicFile | null {
    const filename = `${sanitizeFilename(topic)}.md`;
    const path = join(this.baseDir, filename);
    if (!existsSync(path)) return null;

    const content = readFileSync(path, "utf-8");
    return {
      topic,
      path,
      content,
      estimatedTokens: estimateTokens(content, this.charsPerToken),
    };
  }

  /**
   * Add a memory entry to a topic file. If the file would exceed the token
   * limit, the oldest low-importance entries are archived first.
   *
   * Returns true if added successfully, false if the topic is full and
   * the new entry's importance is too low to displace existing ones.
   */
  addEntry(topic: string, entry: TopicMemoryEntry): boolean {
    const filename = `${sanitizeFilename(topic)}.md`;
    const path = join(this.baseDir, filename);

    // Read existing entries
    const existing = existsSync(path) ? parseEntries(readFileSync(path, "utf-8")) : [];

    // Check if we need to make room
    const newContent = formatEntry(entry);
    const existingContent = existing.map(formatEntry).join("");
    const totalTokens = estimateTokens(existingContent + newContent, this.charsPerToken);

    if (totalTokens > this.maxTokens) {
      // Try to make room by removing low-importance entries
      const sorted = [...existing].sort((a, b) => a.importance - b.importance);
      let removed = 0;

      while (
        sorted.length > removed &&
        estimateTokens(
          sorted.slice(removed).map(formatEntry).join("") + newContent,
          this.charsPerToken,
        ) > this.maxTokens
      ) {
        // Only remove entries with lower importance than the new entry
        if (sorted[removed]!.importance >= entry.importance) break;
        removed++;
      }

      if (removed === 0) {
        // Can't make room — new entry isn't important enough
        return false;
      }

      // Remove the low-importance entries
      const removedKeys = new Set(sorted.slice(0, removed).map((e) => e.key));
      const kept = existing.filter((e) => !removedKeys.has(e.key));
      const finalContent = kept.map(formatEntry).join("") + newContent;
      writeFileSync(path, finalContent);
    } else {
      // Append
      const finalContent = existingContent + newContent;
      writeFileSync(path, finalContent);
    }

    return true;
  }

  /**
   * Get total stats across all topic files.
   */
  stats(): { topics: number; totalEntries: number; totalTokens: number } {
    const topics = this.listTopics();
    let totalEntries = 0;
    let totalTokens = 0;

    for (const topic of topics) {
      const entries = parseEntries(topic.content);
      totalEntries += entries.length;
      totalTokens += topic.estimatedTokens;
    }

    return { topics: topics.length, totalEntries, totalTokens };
  }

  /**
   * Search across all topic files for entries matching a query.
   */
  search(query: string): { topic: string; entry: TopicMemoryEntry; score: number }[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (queryTerms.length === 0) return [];

    const results: { topic: string; entry: TopicMemoryEntry; score: number }[] = [];

    for (const topicFile of this.listTopics()) {
      const entries = parseEntries(topicFile.content);
      for (const entry of entries) {
        const text = `${entry.key} ${entry.value}`.toLowerCase();
        const matches = queryTerms.filter((t) => text.includes(t));
        if (matches.length > 0) {
          const score = matches.length / queryTerms.length;
          results.push({ topic: topicFile.topic, entry, score });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }
}
