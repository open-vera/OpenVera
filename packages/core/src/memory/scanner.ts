import { readdir } from "fs/promises";
import { basename, join } from "path";
import type { MemoryFile, MemoryType } from "./types.js";

const MAX_SCAN_FILES = 200;
const FRONTMATTER_READ_LINES = 30;

/**
 * Parse YAML-style frontmatter from the start of a markdown file.
 * Looks for `---` delimiters. Returns null if no frontmatter found.
 */
function parseFrontmatter(
  content: string,
): { fields: Record<string, string>; body: string } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { fields: {}, body: content };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { fields: {}, body: content };

  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) fields[key] = value;
  }

  return { fields, body: lines.slice(end + 1).join("\n") };
}

function isValidMemoryType(s: string | undefined): MemoryType | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (
    lower === "user" ||
    lower === "project" ||
    lower === "feedback" ||
    lower === "reference"
  ) {
    return lower as MemoryType;
  }
  return undefined;
}

/**
 * Read the first N lines of a file. Returns content and mtime.
 * Uses a simple approach: read a chunk of bytes and split.
 */
async function readFrontmatterChunk(
  filePath: string,
): Promise<{ content: string; mtimeMs: number } | null> {
  try {
    const { readFile, stat } = await import("fs/promises");
    const [raw, st] = await Promise.all([
      readFile(filePath, "utf-8"),
      stat(filePath),
    ]);
    // Only read first ~30 lines worth
    const lines = raw.split("\n");
    const head = lines.slice(0, FRONTMATTER_READ_LINES).join("\n");
    return { content: head, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Scan a memory directory for .md files (excluding MEMORY.md index),
 * parse their frontmatter, and return metadata sorted newest-first.
 *
 * Single-pass: reads the first ~30 lines of each file to extract
 * frontmatter + mtime, then sorts. Capped at MAX_SCAN_FILES.
 */
export async function scanMemoryDir(
  memoryDir: string,
): Promise<MemoryFile[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true });
    const mdFiles = entries
      .filter((f) => f.endsWith(".md") && basename(f) !== "MEMORY.md")
      .slice(0, MAX_SCAN_FILES);

    const results: MemoryFile[] = [];

    for (const relativePath of mdFiles) {
      const filePath = join(memoryDir, relativePath);
      const chunk = await readFrontmatterChunk(filePath);
      if (!chunk) continue;

      const { fields } = parseFrontmatter(chunk.content);

      results.push({
        path: filePath,
        filename: relativePath,
        type: isValidMemoryType(fields["type"]),
        description: fields["description"] || null,
        mtimeMs: chunk.mtimeMs,
      });
    }

    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}
