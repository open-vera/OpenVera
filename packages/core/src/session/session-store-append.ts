/**
 * Low-level JSONL append for session files.
 */
import { appendFileSync } from "node:fs";
import type { SessionEntry } from "./types.js";

export function appendSessionEntry(filePath: string, entry: SessionEntry): void {
  appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

export function sessionTimestamp(): string {
  return new Date().toISOString();
}
