import { diffWordsWithSpace, type StructuredPatchHunk } from "diff";
import { Box, Text } from "ink";
import React, { memo, useMemo } from "react";
import { theme } from "./theme.js";

// ── types ─────────────────────────────────────────────────────────────────────

interface DiffLine {
  code: string;
  type: "add" | "remove" | "nochange";
  lineNo: number; // new-file line number for add/nochange, old-file for remove
}

interface DiffHunkProps {
  hunk: StructuredPatchHunk;
  dim?: boolean;
  width: number;
}

interface DiffViewProps {
  /** File path shown in the header */
  filePath: string;
  /** Hunks from parseGitDiff / getPatchFromContents */
  hunks: StructuredPatchHunk[];
  /** Render at reduced brightness (e.g. historical diffs) */
  dim?: boolean;
  /** Terminal width available */
  width: number;
}

// ── word-level diff helpers ───────────────────────────────────────────────────

const WORD_DIFF_CHANGE_THRESHOLD = 0.4;

function classifyLines(hunk: StructuredPatchHunk): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const raw of hunk.lines) {
    if (raw.startsWith("+")) {
      result.push({ code: raw.slice(1), type: "add", lineNo: newLine++ });
    } else if (raw.startsWith("-")) {
      result.push({ code: raw.slice(1), type: "remove", lineNo: oldLine++ });
    } else {
      result.push({ code: raw.startsWith(" ") ? raw.slice(1) : raw, type: "nochange", lineNo: newLine });
      oldLine++;
      newLine++;
    }
  }
  return result;
}

function changeRatio(oldText: string, newText: string): number {
  const parts = diffWordsWithSpace(oldText, newText);
  const changed = parts.filter((p) => p.added || p.removed).reduce((n, p) => n + p.value.length, 0);
  const total = Math.max(oldText.length + newText.length, 1);
  return changed / total;
}

// ── rendering ─────────────────────────────────────────────────────────────────

function gutterWidth(hunk: StructuredPatchHunk): number {
  const maxNo = Math.max(hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1, 1);
  return maxNo.toString().length + 3; // marker(1) + space + digits + space
}

function fmtLineNo(no: number, width: number): string {
  return no.toString().padStart(width - 2, " ");
}

// Render a single remove+add pair with word-level highlighting
function WordDiffRow({
  removed,
  added,
  gutW,
  dim,
}: {
  removed: DiffLine;
  added: DiffLine;
  gutW: number;
  dim: boolean;
}) {
  const parts = useMemo(
    () => diffWordsWithSpace(removed.code, added.code),
    [removed.code, added.code]
  );

  const noW = gutW - 2;

  return (
    <>
      {/* remove row */}
      <Box flexDirection="row">
        <Text color={dim ? theme.textDim : theme.diffRemovedWord} dimColor={dim}>
          {`-${fmtLineNo(removed.lineNo, noW)} `}
        </Text>
        <Text>
          {parts.map((p, i) =>
            p.removed ? (
              <Text key={i} color={theme.diffRemovedWord} backgroundColor={dim ? undefined : theme.diffRemovedBg}>
                {p.value}
              </Text>
            ) : !p.added ? (
              <Text key={i} color={dim ? theme.textDim : theme.diffRemovedWord}>
                {p.value}
              </Text>
            ) : null
          )}
        </Text>
      </Box>
      {/* add row */}
      <Box flexDirection="row">
        <Text color={dim ? theme.textDim : theme.diffAddedWord} dimColor={dim}>
          {`+${fmtLineNo(added.lineNo, noW)} `}
        </Text>
        <Text>
          {parts.map((p, i) =>
            p.added ? (
              <Text key={i} color={theme.diffAddedWord} backgroundColor={dim ? undefined : theme.diffAddedBg}>
                {p.value}
              </Text>
            ) : !p.removed ? (
              <Text key={i} color={dim ? theme.textDim : theme.diffAddedWord}>
                {p.value}
              </Text>
            ) : null
          )}
        </Text>
      </Box>
    </>
  );
}

const DiffHunk = memo(function DiffHunk({ hunk, dim = false, width }: DiffHunkProps) {
  const gutW = gutterWidth(hunk);
  const lines = classifyLines(hunk);

  // Hunk header
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

  const rows: React.ReactNode[] = [
    <Box key="header">
      <Text color={theme.diffHunk} dimColor={dim}>
        {header}
      </Text>
    </Box>,
  ];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Pair adjacent remove+add for word-level diff
    if (
      line.type === "remove" &&
      i + 1 < lines.length &&
      lines[i + 1]!.type === "add"
    ) {
      const next = lines[i + 1]!;
      if (changeRatio(line.code, next.code) <= WORD_DIFF_CHANGE_THRESHOLD) {
        rows.push(
          <WordDiffRow
            key={i}
            removed={line}
            added={next}
            gutW={gutW}
            dim={dim}
          />
        );
        i += 2;
        continue;
      }
    }

    // Plain line
    const noW = gutW - 2;
    const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    const color =
      line.type === "add" ? theme.diffAddedWord :
      line.type === "remove" ? theme.diffRemovedWord : undefined;

    rows.push(
      <Box key={i} flexDirection="row">
        <Text color={color ?? theme.textDim} dimColor={dim || line.type === "nochange"}>
          {`${marker}${fmtLineNo(line.lineNo, noW)} `}
        </Text>
        <Text color={color} dimColor={dim || line.type === "nochange"}>
          {line.code}
        </Text>
      </Box>
    );
    i++;
  }

  return <Box flexDirection="column">{rows}</Box>;
});

// ── public component ──────────────────────────────────────────────────────────

export const DiffView = memo(function DiffView({
  filePath,
  hunks,
  dim = false,
  width,
}: DiffViewProps) {
  if (hunks.length === 0) return null;

  const { added, removed } = useMemo(() => {
    let a = 0, r = 0;
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.startsWith("+")) a++;
        else if (l.startsWith("-")) r++;
      }
    return { added: a, removed: r };
  }, [hunks]);

  const safeWidth = Math.max(1, Math.floor(width));

  return (
    <Box flexDirection="column" width={safeWidth}>
      {/* File header */}
      <Box>
        <Text bold dimColor={dim}>
          {filePath}{" "}
        </Text>
        <Text color={theme.diffAddedWord} dimColor={dim}>
          +{added}
        </Text>
        <Text dimColor> </Text>
        <Text color={theme.diffRemovedWord} dimColor={dim}>
          -{removed}
        </Text>
      </Box>

      {/* Hunks */}
      {hunks.map((hunk, idx) => (
        <DiffHunk key={idx} hunk={hunk} dim={dim} width={safeWidth} />
      ))}
    </Box>
  );
});
