/**
 * JSONL parsing and progressive session file reads.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import type { StopReason, Usage } from "../types/index.js";
import { calculateCost } from "./cost.js";
import type {
  BranchEntry,
  SessionEntry,
  SessionSummary,
} from "./types.js";

/** Parse a single JSONL line; returns null on any parse error (corruption recovery). */
function parseJsonlLine(line: string): SessionEntry | null {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return null;
  }
}

/** Split raw text into non-empty lines and parse each with corruption recovery. */
export function parseJsonlLines(raw: string): SessionEntry[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map(parseJsonlLine)
    .filter((e): e is SessionEntry => e !== null);
}

function unescapeJsonString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function extractJsonStringField(text: string, key: string): string | undefined {
  return extractJsonStringFieldInternal(text, key, false);
}

function extractLastJsonStringField(text: string, key: string): string | undefined {
  return extractJsonStringFieldInternal(text, key, true);
}

function extractLastJsonNumberField(text: string, key: string): number | undefined {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "g");
  let value: number | undefined;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    value = Number(match[1]);
  }
  return Number.isFinite(value) ? value : undefined;
}

function extractJsonStringFieldInternal(text: string, key: string, last: boolean): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  let value: string | undefined;

  for (const pattern of patterns) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const idx = text.indexOf(pattern, searchFrom);
      if (idx < 0) break;
      const valueStart = idx + pattern.length;
      let i = valueStart;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "\"") {
          value = unescapeJsonString(text.slice(valueStart, i));
          if (!last) return value;
          break;
        }
        i++;
      }
      searchFrom = i + 1;
    }
  }

  return value;
}

function extractTagFromTail(tailRaw: string): string | undefined {
  const lines = tailRaw.split("\n");
  let line: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.startsWith("{\"type\":\"tag\"")) {
      line = lines[i];
      break;
    }
  }
  return line ? extractLastJsonStringField(line, "tag") : undefined;
}

function extractLastLineByType(raw: string, type: string): string | undefined {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.includes(`"type":"${type}"`) || line?.includes(`"type": "${type}"`)) {
      return line;
    }
  }
  return undefined;
}

function extractSessionEndFallback(tailRaw: string): {
  totalUsage?: Usage;
  totalCostUsd?: number;
  turnCount?: number;
} | undefined {
  const line = extractLastLineByType(tailRaw, "session_end");
  if (!line) return undefined;
  const input = extractLastJsonNumberField(line, "input_tokens");
  const output = extractLastJsonNumberField(line, "output_tokens");
  const cacheCreation = extractLastJsonNumberField(line, "cache_creation_input_tokens");
  const cacheRead = extractLastJsonNumberField(line, "cache_read_input_tokens");
  const totalCostUsd = extractLastJsonNumberField(line, "totalCostUsd");
  const turnCount = extractLastJsonNumberField(line, "turnCount");
  const totalUsage =
    input !== undefined || output !== undefined || cacheCreation !== undefined || cacheRead !== undefined
      ? {
          input_tokens: input ?? 0,
          output_tokens: output ?? 0,
          ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreation } : {}),
          ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
        }
      : undefined;
  if (!totalUsage && totalCostUsd === undefined && turnCount === undefined) return undefined;
  return {
    ...(totalUsage ? { totalUsage } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
  };
}

// ── File I/O helpers ──────────────────────────────────────────────────────────

const HEAD_BYTES = 65_536;    // matches tail size so first prompt/title metadata can be scanned
const TAIL_BYTES = 65_536;    // 64 KB — covers recent turns + session_end

/** Read first HEAD_BYTES bytes; returns raw string. */
function readFileHead(filePath: string): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.slice(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read last TAIL_BYTES bytes; aligns to the first newline so we never get a
 * partial line at the start of the returned string.
 */
function readFileTail(filePath: string): string {
  const fd = openSync(filePath, "r");
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    readSync(fd, buf, 0, length, start);
    const raw = buf.toString("utf8");
    // If we started mid-file, skip the potentially truncated first line
    if (start > 0) {
      const nl = raw.indexOf("\n");
      return nl === -1 ? "" : raw.slice(nl + 1);
    }
    return raw;
  } finally {
    closeSync(fd);
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

interface HeadMeta {
  firstPrompt: string | undefined;
  customTitle: string | undefined;
  aiTitle: string | undefined;
  tag: string | undefined;
  gitBranch: string | undefined;
  messageCount: number;
  seenUuids: Set<string>;
}

function parseHeadMeta(entries: SessionEntry[]): HeadMeta {
  let firstPrompt: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let tag: string | undefined;
  let gitBranch: string | undefined;
  let messageCount = 0;
  const seenUuids = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "user") {
      if (!firstPrompt) firstPrompt = entry.content;
      if ("uuid" in entry && entry.uuid && !seenUuids.has(entry.uuid)) {
        seenUuids.add(entry.uuid);
        messageCount++;
      }
    } else if (entry.type === "assistant") {
      if ("uuid" in entry && entry.uuid && !seenUuids.has(entry.uuid)) {
        seenUuids.add(entry.uuid);
        messageCount++;
      }
    } else if (entry.type === "custom_title" || entry.type === "custom-title") {
      customTitle = entry.customTitle ?? entry.title;
    } else if (entry.type === "ai-title") {
      aiTitle = entry.aiTitle;
    } else if (entry.type === "tag") {
      tag = entry.tag;
    } else if (entry.type === "git-branch") {
      gitBranch = entry.gitBranch;
    }
  }

  return { firstPrompt, customTitle, aiTitle, tag, gitBranch, messageCount, seenUuids };
}

interface TailMeta {
  turnCount: number;
  totalUsage: Usage;
  totalCostUsd: number;
  customTitle: string | undefined;
  aiTitle: string | undefined;
  lastPrompt: string | undefined;
  storedSummary: string | undefined;
  lastUserInput: string | undefined;
  tag: string | undefined;
  gitBranch: string | undefined;
  pr: SessionSummary["pr"] | undefined;
  branch: SessionSummary["branch"] | undefined;
  foundEnd: boolean;
  additionalMessageCount: number;
}

function parseTailMeta(entries: SessionEntry[], seenUuids: Set<string>): TailMeta {
  let turnCount = 0;
  let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let totalCostUsd = 0;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  let storedSummary: string | undefined;
  let lastUserInput: string | undefined;
  let tag: string | undefined;
  let gitBranch: string | undefined;
  let pr: SessionSummary["pr"] | undefined;
  let branch: SessionSummary["branch"] | undefined;
  let foundEnd = false;
  let additionalMessageCount = 0;

  for (const entry of entries) {
    if (entry.type === "session_end") {
      turnCount = entry.turnCount;
      totalUsage = entry.totalUsage;
      totalCostUsd = entry.totalCostUsd;
      foundEnd = true;
    } else if (entry.type === "custom_title" || entry.type === "custom-title") {
      customTitle = entry.customTitle ?? entry.title;
    } else if (entry.type === "ai-title") {
      aiTitle = entry.aiTitle;
    } else if (entry.type === "last_prompt" || entry.type === "last-prompt") {
      lastPrompt = entry.lastPrompt;
      lastUserInput = entry.lastPrompt;
    } else if (entry.type === "summary") {
      storedSummary = entry.summary;
    } else if (entry.type === "user") {
      lastUserInput = entry.content;
      if ("uuid" in entry && entry.uuid && !seenUuids.has(entry.uuid)) {
        seenUuids.add(entry.uuid);
        additionalMessageCount++;
      }
    } else if (entry.type === "assistant") {
      if ("uuid" in entry && entry.uuid && !seenUuids.has(entry.uuid)) {
        seenUuids.add(entry.uuid);
        additionalMessageCount++;
      }
    } else if (entry.type === "tag") {
      tag = entry.tag;
    } else if (entry.type === "git-branch") {
      gitBranch = entry.gitBranch;
    } else if (entry.type === "pr-link") {
      pr = {
        url: entry.prUrl,
        ...(entry.prRepository ? { repository: entry.prRepository } : {}),
        ...(entry.prNumber ? { number: entry.prNumber } : {}),
      };
    } else if (entry.type === "branch") {
      branch = {
        parentSessionId: entry.parentSessionId,
        ...(entry.forkedFromUuid ? { forkedFromUuid: entry.forkedFromUuid } : {}),
        ...(entry.title ? { title: entry.title } : {}),
        status: entry.status,
        ...(entry.worktreePath ? { worktreePath: entry.worktreePath } : {}),
        ...(entry.worktreeBranch ? { worktreeBranch: entry.worktreeBranch } : {}),
        ...(entry.baseCommit ? { baseCommit: entry.baseCommit } : {}),
      };
    }
  }

  return { turnCount, totalUsage, totalCostUsd, customTitle, aiTitle, lastPrompt, storedSummary, lastUserInput, tag, gitBranch, pr, branch, foundEnd, additionalMessageCount };
}

/**
 * Build a SessionSummary using progressive loading:
 * - First 64 KB  → parse session_start + first prompt/title metadata
 * - Last  64 KB  → scan for session_end + latest title/prompt/summary metadata
 * - Falls back to counting assistant entries in the tail when no session_end exists
 */
export function readSessionSummary(filePath: string): SessionSummary | null {
  const headRaw = readFileHead(filePath);
  const firstLine = headRaw.split("\n")[0];
  if (!firstLine) return null;
  const first = parseJsonlLine(firstLine);
  if (!first || first.type !== "session_start") return null;

  const stat = statSync(filePath);
  const tailRaw = readFileTail(filePath);
  const head = parseHeadMeta(parseJsonlLines(headRaw));
  const tail = parseTailMeta(parseJsonlLines(tailRaw), head.seenUuids);

  const messageCount = head.messageCount + tail.additionalMessageCount;
  let { turnCount, totalUsage, totalCostUsd, foundEnd } = tail;

  // Regex-based fallbacks override parsed values (handles partial writes)
  const customTitle =
    extractLastJsonStringField(tailRaw, "customTitle") ??
    extractLastJsonStringField(headRaw, "customTitle") ??
    tail.customTitle ?? head.customTitle;
  const aiTitle =
    extractLastJsonStringField(tailRaw, "aiTitle") ??
    extractLastJsonStringField(headRaw, "aiTitle") ??
    tail.aiTitle ?? head.aiTitle;
  const lastPrompt = extractLastJsonStringField(tailRaw, "lastPrompt") ?? tail.lastPrompt;
  const storedSummary = extractLastJsonStringField(tailRaw, "summary") ?? tail.storedSummary;
  const gitBranch =
    extractLastJsonStringField(tailRaw, "gitBranch") ??
    extractJsonStringField(headRaw, "gitBranch") ??
    tail.gitBranch ?? head.gitBranch;
  const tag = extractTagFromTail(tailRaw) ?? tail.tag ?? head.tag;

  if (!foundEnd) {
    const endFallback = extractSessionEndFallback(tailRaw);
    if (endFallback) {
      if (endFallback.totalUsage) totalUsage = endFallback.totalUsage;
      if (endFallback.totalCostUsd !== undefined) totalCostUsd = endFallback.totalCostUsd;
      if (endFallback.turnCount !== undefined) turnCount = endFallback.turnCount;
      foundEnd = true;
    }
  }

  // No session_end yet: estimate from assistant entries in tail
  if (!foundEnd) {
    for (const entry of parseJsonlLines(tailRaw)) {
      if (entry.type === "assistant") {
        turnCount++;
        totalUsage = addUsage(totalUsage, entry.usage);
        totalCostUsd += calculateCost(entry.usage, entry.model);
      }
    }
  }

  const displaySummary =
    preview(customTitle) ??
    preview(aiTitle) ??
    preview(lastPrompt) ??
    preview(storedSummary) ??
    preview(head.firstPrompt);
  if (!displaySummary) return null;

  return {
    sessionId: first.sessionId,
    filePath,
    startedAt: new Date(first.timestamp),
    lastActivityAt: stat.mtime,
    fileSize: stat.size,
    createdAt: new Date(first.timestamp),
    model: first.model,
    provider: first.provider,
    turnCount,
    messageCount: messageCount || undefined,
    totalUsage,
    totalCostUsd,
    cwd: first.cwd,
    ...(customTitle ? { title: preview(customTitle) } : {}),
    summary: displaySummary,
    ...(head.firstPrompt ? { firstPrompt: preview(head.firstPrompt) } : {}),
    lastUserInput: preview(tail.lastUserInput),
    ...(tag ? { tag } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(tail.pr ? { pr: tail.pr } : {}),
    ...(tail.branch ? { branch: tail.branch } : {}),
  };
}

export function isReplayableSessionEntry(
  entry: SessionEntry
): entry is Exclude<SessionEntry, BranchEntry> {
  return (
    entry.type !== "session_end" &&
    entry.type !== "last_prompt" &&
    entry.type !== "last-prompt" &&
    entry.type !== "summary" &&
    entry.type !== "ai-title" &&
    entry.type !== "tag" &&
    entry.type !== "git-branch" &&
    entry.type !== "pr-link" &&
    entry.type !== "branch"
  );
}

export function findLastMessageUuid(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if ("uuid" in entry) {
      return entry.uuid;
    }
  }
  return undefined;
}

export function readBranchMetadata(filePath: string): BranchEntry | null {
  const raw = readFileSync(filePath, "utf8");
  const entries = parseJsonlLines(raw);
  return entries.filter((entry): entry is BranchEntry => entry.type === "branch").at(-1) ?? null;
}

export function preview(content: string | undefined): string | undefined {
  const normalized = content?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
