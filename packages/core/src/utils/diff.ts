import { structuredPatch, type StructuredPatchHunk } from "diff";

export const CONTEXT_LINES = 3;
export const DIFF_TIMEOUT_MS = 5_000;

const AMPERSAND_TOKEN = "<<:AMPERSAND:>>";
const DOLLAR_TOKEN = "<<:DOLLAR:>>";

function escapeForDiff(s: string): string {
  return s.replaceAll("&", AMPERSAND_TOKEN).replaceAll("$", DOLLAR_TOKEN);
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, "&").replaceAll(DOLLAR_TOKEN, "$");
}

/**
 * Generate structured patch hunks from two text contents.
 * Suitable for showing file edit diffs in the REPL.
 */
export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: {
  filePath: string;
  oldContent: string;
  newContent: string;
  ignoreWhitespace?: boolean;
  singleHunk?: boolean;
}): StructuredPatchHunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: singleHunk ? 100_000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    }
  );
  if (!result) return [];
  return result.hunks.map((h) => ({
    ...h,
    lines: h.lines.map(unescapeFromDiff),
  }));
}

/** Count added/removed lines in a set of hunks. */
export function countHunkLines(hunks: StructuredPatchHunk[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}
