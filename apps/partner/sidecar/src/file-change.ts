import type { ToolResult } from "@open-vera/core/tools";

/** Max chars of unified diff shipped over IPC per tool result. */
const MAX_UNIFIED_DIFF_CHARS = 200_000;

export interface PartnerFileChange {
  path: string;
  added: number;
  removed: number;
  unifiedDiff: string;
}

type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

function countHunkLines(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

function hunksToUnifiedDiff(filePath: string, hunks: DiffHunk[]): string {
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  for (const hunk of hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    lines.push(...hunk.lines);
  }
  return lines.join("\n");
}

/** Extract a file-change summary from write_file / edit_file tool metadata. */
export function extractFileChange(result: ToolResult): PartnerFileChange | undefined {
  if (!result.ok) return undefined;
  const diff = result.metadata?.diff;
  if (!diff?.filePath || !Array.isArray(diff.hunks) || diff.hunks.length === 0) {
    return undefined;
  }

  const hunks = diff.hunks as DiffHunk[];
  const { added, removed } = countHunkLines(hunks);
  let unifiedDiff = hunksToUnifiedDiff(diff.filePath, hunks);
  if (unifiedDiff.length > MAX_UNIFIED_DIFF_CHARS) {
    unifiedDiff = `${unifiedDiff.slice(0, MAX_UNIFIED_DIFF_CHARS)}\n\n… (diff truncated)`;
  }

  return {
    path: diff.filePath,
    added,
    removed,
    unifiedDiff,
  };
}
