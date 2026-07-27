import { fileUriToPath, normalizeFsPath } from "./file-uri.js";

export type LspNavLocation = {
  uri: string;
  path: string;
  line: number;
  character: number;
};

export type PendingLspNavigation = {
  path: string;
  line: number;
  character: number;
};

let pendingNavigation: PendingLspNavigation | null = null;

export function setPendingLspNavigation(nav: PendingLspNavigation | null): void {
  pendingNavigation = nav;
}

export function takePendingLspNavigation(filePath: string): PendingLspNavigation | null {
  if (!pendingNavigation) return null;
  if (normalizeFsPath(pendingNavigation.path) !== normalizeFsPath(filePath)) {
    return null;
  }
  const next = pendingNavigation;
  pendingNavigation = null;
  return next;
}

/** Parse Location / LocationLink / arrays from textDocument/definition. */
export function parseLspDefinitionLocation(response: unknown): LspNavLocation | null {
  const first = Array.isArray(response) ? response[0] : response;
  if (!first || typeof first !== "object") return null;

  const record = first as Record<string, unknown>;

  if (typeof record.uri === "string" && isRange(record.range)) {
    const path = fileUriToPath(record.uri);
    if (!path) return null;
    return {
      uri: record.uri,
      path,
      line: record.range.start.line,
      character: record.range.start.character,
    };
  }

  if (typeof record.targetUri === "string") {
    const range = isRange(record.targetSelectionRange)
      ? record.targetSelectionRange
      : isRange(record.targetRange)
        ? record.targetRange
        : null;
    if (!range) return null;
    const path = fileUriToPath(record.targetUri);
    if (!path) return null;
    return {
      uri: record.targetUri,
      path,
      line: range.start.line,
      character: range.start.character,
    };
  }

  return null;
}

function isRange(
  value: unknown,
): value is { start: { line: number; character: number } } {
  if (!value || typeof value !== "object") return false;
  const start = (value as { start?: unknown }).start;
  if (!start || typeof start !== "object") return false;
  const line = (start as { line?: unknown }).line;
  const character = (start as { character?: unknown }).character;
  return typeof line === "number" && typeof character === "number";
}

/** Map 0-based LSP position to a CodeMirror document offset. */
export function offsetFromLspPosition(
  doc: { lines: number; line: (n: number) => { from: number; to: number } },
  line: number,
  character: number,
): number {
  const lineNumber = Math.min(Math.max(line + 1, 1), doc.lines);
  const lineObj = doc.line(lineNumber);
  return Math.min(lineObj.from + Math.max(character, 0), lineObj.to);
}
