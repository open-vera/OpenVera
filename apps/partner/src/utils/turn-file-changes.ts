import type { FileChange, ToolResult } from "@/types";

/** Merge per-tool fileChange payloads into one entry per path for a turn. */
export function aggregateTurnFileChanges(results: ToolResult[] | undefined): FileChange[] {
  const byPath = new Map<string, FileChange>();

  for (const result of results ?? []) {
    const change = result.fileChange;
    if (!change?.path) continue;

    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, {
        path: change.path,
        added: change.added,
        removed: change.removed,
        unifiedDiff: change.unifiedDiff,
      });
      continue;
    }

    existing.added += change.added;
    existing.removed += change.removed;
    if (change.unifiedDiff) {
      existing.unifiedDiff = existing.unifiedDiff
        ? `${existing.unifiedDiff}\n${change.unifiedDiff}`
        : change.unifiedDiff;
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function formatChangeCounts(change: Pick<FileChange, "added" | "removed">): string {
  return `+${change.added} -${change.removed}`;
}
