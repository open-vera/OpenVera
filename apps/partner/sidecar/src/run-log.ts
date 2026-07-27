import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalDataPath } from "@open-vera/core/config";
import { projectSlug } from "@open-vera/core/session";

export const RUN_LOG_DIRNAME = "partner-runs";

/** Log lines that carry no task id land here, one file per day. */
export const RUN_LOG_UNTASKED_FILE = "general.jsonl";

const MAX_SEGMENT_LENGTH = 120;

/**
 * Derive the per-project directory name from an absolute project root.
 *
 * Reuses core's session-store convention so `~/.vera/partner-runs/<slug>` and
 * `~/.vera/projects/<slug>` name the same project identically. `paths.rs` in
 * src-tauri mirrors this algorithm — the sidecar writes these paths and the
 * Rust host resolves them, so a divergence silently hides every log.
 */
export function runLogProjectSlug(projectRoot: string): string {
  return projectSlug(projectRoot);
}

export function runLogSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, MAX_SEGMENT_LENGTH);
}

export function runLogRoot(): string {
  return globalDataPath(RUN_LOG_DIRNAME);
}

export function runLogProjectDir(projectRoot: string): string {
  return join(runLogRoot(), runLogProjectSlug(projectRoot));
}

export function buildRunLogPath(
  projectRoot: string,
  date: Date,
  taskId?: string | null,
): string {
  const day = date.toISOString().slice(0, 10);
  const dir = join(runLogProjectDir(projectRoot), day);
  return taskId
    ? join(dir, `${runLogSegment(taskId)}.jsonl`)
    : join(dir, RUN_LOG_UNTASKED_FILE);
}

export function formatRunLogLine(
  record: Record<string, unknown>,
  taskId?: string | null,
  date = new Date(),
): string {
  return `${JSON.stringify({
    timestamp: date.toISOString(),
    ...(taskId ? { taskId } : {}),
    ...record,
  })}\n`;
}

/** Append one JSONL record; returns the path written to. */
export function appendRunLogLine(
  projectRoot: string,
  record: Record<string, unknown>,
  taskId?: string | null,
  date = new Date(),
): string {
  const path = buildRunLogPath(projectRoot, date, taskId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, formatRunLogLine(record, taskId, date), "utf-8");
  return path;
}
