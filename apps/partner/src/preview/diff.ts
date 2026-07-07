export interface ParsedUnifiedDiff {
  oldText: string;
  newText: string;
  filePath: string;
  isDiff: boolean;
}

function stripDiffPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

function pushLine(lines: string[], line: string) {
  lines.push(line);
}

export function parseUnifiedDiff(source: string, fallbackPath = ""): ParsedUnifiedDiff {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const lines = source.split(/\r?\n/);
  let inHunk = false;
  let filePath = fallbackPath;
  let isDiff = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      isDiff = true;
      const parts = line.trim().split(/\s+/);
      filePath = stripDiffPrefix(parts[3] ?? parts[2] ?? fallbackPath);
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      isDiff = true;
      const nextPath = line.slice(4).trim().split(/\s+/)[0] ?? "";
      if (nextPath && nextPath !== "/dev/null") filePath = stripDiffPrefix(nextPath);
      continue;
    }
    if (line.startsWith("@@")) {
      isDiff = true;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;

    if (line.startsWith("+")) {
      pushLine(newLines, line.slice(1));
    } else if (line.startsWith("-")) {
      pushLine(oldLines, line.slice(1));
    } else if (line.startsWith(" ")) {
      const text = line.slice(1);
      pushLine(oldLines, text);
      pushLine(newLines, text);
    } else if (line === "") {
      pushLine(oldLines, "");
      pushLine(newLines, "");
    }
  }

  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    filePath,
    isDiff,
  };
}

export function isDiffPreview(source: string, filePath: string): boolean {
  return source.startsWith("git-diff:") || /\.(diff|patch)$/i.test(filePath);
}
