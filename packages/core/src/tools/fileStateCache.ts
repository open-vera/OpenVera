/**
 * fileStateCache — 追踪已读取文件的状态（mtime + content）。
 *
 * read_file 执行后写入；write_file / edit_file 执行前校验。
 * 这是 optimistic locking 的基础：如果文件在读取后被外部修改，
 * 则写入前的 mtime 校验会检测到变化并拒绝操作，要求重新读取。
 *
 * 模块级单例 — 与 claude-code-source 的 fileStateCache 设计相同。
 */

import { statSync, readFileSync } from "node:fs";

export interface FileState {
  /** Math.floor(stats.mtimeMs) at read time */
  mtime: number;
  /** Full file content at read time (undefined for partial reads) */
  content: string | undefined;
  /** Whether this was a partial read (offset/limit specified) */
  isPartialRead: boolean;
}

const cache = new Map<string, FileState>();

/** Record file state after a successful read. */
export function setFileState(
  absolutePath: string,
  content: string,
  isPartialRead = false
): void {
  const mtime = getFileMtime(absolutePath);
  if (mtime === null) return;
  cache.set(absolutePath, {
    mtime,
    content: isPartialRead ? undefined : content,
    isPartialRead,
  });
}

/** Retrieve recorded state for a file, or null if never read. */
export function getFileState(absolutePath: string): FileState | null {
  return cache.get(absolutePath) ?? null;
}

/** Clear state for a file (e.g. after successful write). */
export function clearFileState(absolutePath: string): void {
  cache.delete(absolutePath);
}

/** Get current mtime for a file, or null if it doesn't exist. */
export function getFileMtime(absolutePath: string): number | null {
  try {
    return Math.floor(statSync(absolutePath).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Check whether a file has been externally modified since it was last read.
 *
 * Returns:
 *  - "not_read"    — file was never read via read_file (write should be blocked)
 *  - "partial_read" — only a slice was read; staleness can't be content-verified
 *  - "stale"       — mtime advanced AND content differs (genuine external edit)
 *  - "ok"          — safe to write
 */
export type StalenessResult = "not_read" | "partial_read" | "stale" | "ok";

export function checkStaleness(absolutePath: string): StalenessResult {
  const state = cache.get(absolutePath);

  // New file being created — no prior read required
  const currentMtime = getFileMtime(absolutePath);
  if (currentMtime === null) return "ok"; // file doesn't exist yet

  if (!state) return "not_read";
  if (state.isPartialRead) return "partial_read";

  if (currentMtime <= state.mtime) return "ok";

  // mtime advanced — check whether content actually changed.
  // (Cloud sync / antivirus can bump mtime without changing content.)
  try {
    const current = readFileSync(absolutePath, "utf8");
    if (current === state.content) return "ok"; // mtime bumped but content identical
    return "stale";
  } catch {
    return "stale";
  }
}
