import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export async function tryReadText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

export async function tryReadJson(filePath: string): Promise<unknown> {
  const text = await tryReadText(filePath);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Read a NDJSON file, return parsed lines (skip blank / invalid). */
export async function readNdjson(filePath: string): Promise<unknown[]> {
  const text = await tryReadText(filePath);
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/** Read bytes from offset, return new text and next offset. */
export async function readFromOffset(
  filePath: string,
  offset: number
): Promise<{ text: string; nextOffset: number }> {
  if (!existsSync(filePath)) return { text: "", nextOffset: offset };
  const { size } = await stat(filePath);
  if (size <= offset) return { text: "", nextOffset: offset };
  const buf = Buffer.alloc(size - offset);
  const { open } = await import("node:fs/promises");
  const fh = await open(filePath, "r");
  try {
    await fh.read(buf, 0, buf.length, offset);
  } finally {
    await fh.close();
  }
  return { text: buf.toString("utf-8"), nextOffset: size };
}

/** List immediate subdirectory names matching a prefix. */
export async function listDirs(dir: string, prefix = ""): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Resolve dir to absolute if relative (relative to cwd). */
export function resolvePath(p: string): string {
  return resolve(p);
}

export { join };
