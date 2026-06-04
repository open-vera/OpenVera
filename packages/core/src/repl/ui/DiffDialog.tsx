import React, { useState, useEffect } from "react";
import { useInput, Box, Text } from "ink";
import type { StructuredPatchHunk } from "diff";
import { fetchGitDiff, fetchGitDiffHunks } from "../../utils/gitDiff.js";
import type { GitDiffStats, PerFileStats } from "../../utils/gitDiff.js";
import { DiffView } from "./DiffView.js";

// ── types ─────────────────────────────────────────────────────────────────────

interface DiffDialogProps {
  cwd: string;
  width: number;
  height: number;
  onClose: () => void;
}

interface FileEntry {
  path: string;
  stats: PerFileStats;
  hunks: StructuredPatchHunk[];
}

type ViewMode = "list" | "detail";

// ── helpers ───────────────────────────────────────────────────────────────────

function StatsSummary({ stats }: { stats: GitDiffStats }) {
  return (
    <Box gap={1}>
      <Text dimColor>
        {stats.filesCount} {stats.filesCount === 1 ? "file" : "files"} changed
      </Text>
      {stats.linesAdded > 0 && <Text color="green">+{stats.linesAdded}</Text>}
      {stats.linesRemoved > 0 && <Text color="red">-{stats.linesRemoved}</Text>}
    </Box>
  );
}

function FileListRow({
  file,
  selected,
}: {
  file: FileEntry;
  selected: boolean;
}) {
  const { path, stats } = file;
  const marker = selected ? "▶ " : "  ";
  return (
    <Box gap={1}>
      <Text color={selected ? "cyan" : undefined} bold={selected}>
        {marker}{path}
      </Text>
      {stats.isUntracked ? (
        <Text color="yellow" dimColor>untracked</Text>
      ) : stats.isBinary ? (
        <Text dimColor>binary</Text>
      ) : (
        <Box gap={1}>
          {stats.added > 0 && <Text color="green">+{stats.added}</Text>}
          {stats.removed > 0 && <Text color="red">-{stats.removed}</Text>}
        </Box>
      )}
    </Box>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function DiffDialog({ cwd, width, height, onClose }: DiffDialogProps) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<GitDiffStats | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  // Fetch on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [diffResult, hunksMap] = await Promise.all([
        fetchGitDiff(cwd),
        fetchGitDiffHunks(cwd),
      ]);
      if (cancelled) return;

      if (!diffResult) {
        setLoading(false);
        return;
      }

      setStats(diffResult.stats);

      const entries: FileEntry[] = [];
      for (const [path, fileStats] of diffResult.perFileStats) {
        entries.push({
          path,
          stats: fileStats,
          hunks: hunksMap.get(path) ?? [],
        });
      }
      // Also include files that have hunks but weren't in numstat (edge case)
      for (const [path, hunks] of hunksMap) {
        if (!diffResult.perFileStats.has(path)) {
          entries.push({ path, stats: { added: 0, removed: 0, isBinary: false }, hunks });
        }
      }

      setFiles(entries);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [cwd]);

  // Keyboard navigation
  useInput((input, key) => {
    if (key.escape) {
      if (viewMode === "detail") setViewMode("list");
      else onClose();
      return;
    }

    if (viewMode === "list") {
      if (key.upArrow) {
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIdx((i) => Math.min(files.length - 1, i + 1));
      } else if (key.return) {
        const f = files[selectedIdx];
        if (f && f.hunks.length > 0) setViewMode("detail");
      } else if (input === "q") {
        onClose();
      }
    } else {
      // detail view — any left arrow or q goes back
      if (key.leftArrow || input === "q") {
        setViewMode("list");
      }
    }
  });

  // ── render ──────────────────────────────────────────────────────────────────

  const selectedFile = files[selectedIdx];

  const header = (
    <Box flexDirection="row" gap={2} borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">diff</Text>
      {stats ? <StatsSummary stats={stats} /> : loading ? <Text dimColor>loading…</Text> : <Text dimColor>no changes</Text>}
      <Box flexGrow={1} />
      <Text dimColor>
        {viewMode === "list"
          ? "↑↓ navigate  enter detail  esc/q close"
          : "esc/q back"}
      </Text>
    </Box>
  );

  if (loading) {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box paddingLeft={2}><Text dimColor>Fetching diff…</Text></Box>
      </Box>
    );
  }

  if (files.length === 0) {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box paddingLeft={2}><Text dimColor>No uncommitted changes.</Text></Box>
      </Box>
    );
  }

  if (viewMode === "detail" && selectedFile) {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box paddingLeft={1} flexDirection="column">
          {selectedFile.hunks.length === 0 ? (
            <Text dimColor>
              {selectedFile.stats.isUntracked
                ? "Untracked file — not yet staged."
                : selectedFile.stats.isBinary
                  ? "Binary file changed."
                  : "No hunk data available (file may exceed size limit)."}
            </Text>
          ) : (
            <DiffView
              filePath={selectedFile.path}
              hunks={selectedFile.hunks}
              width={width - 2}
            />
          )}
        </Box>
      </Box>
    );
  }

  // List view — show up to (height - 4) files
  const visibleCount = Math.max(1, height - 6);
  const windowStart = Math.max(0, Math.min(selectedIdx - Math.floor(visibleCount / 2), files.length - visibleCount));
  const visible = files.slice(windowStart, windowStart + visibleCount);

  return (
    <Box flexDirection="column" width={width}>
      {header}
      <Box flexDirection="column" paddingLeft={1}>
        {visible.map((file, i) => (
          <FileListRow
            key={file.path}
            file={file}
            selected={windowStart + i === selectedIdx}
          />
        ))}
        {files.length > visibleCount && (
          <Text dimColor>
            … {files.length - visibleCount} more file{files.length - visibleCount === 1 ? "" : "s"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
