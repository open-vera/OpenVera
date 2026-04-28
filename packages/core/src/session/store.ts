// Session 存储 — JSONL 读写 + 列表 + 恢复

import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StopReason, Usage } from "../types/index.js";
import type { Message } from "../types/message.js";
import { calculateCost } from "./cost.js";
import type {
  AssistantEntry,
  CustomTitleEntry,
  LoadedSession,
  SessionEntry,
  SessionSummary,
  ToolCallEntry,
  ToolResultEntry,
  UserEntry,
} from "./types.js";

// ── Path helpers ──────────────────────────────────────────────────────────────

// djb2 hash — fast, no native dependency
function hashPath(p: string): string {
  let h = 5381;
  for (let i = 0; i < p.length; i++) {
    h = ((h << 5) + h + p.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

const MAX_DIR_LEN = 80;

/**
 * Sanitize a filesystem path component for the session directory name.
 * Strategy: replace non-alnum with `-`, do NOT collapse runs (to avoid
 * collisions like /a__b and /a_b mapping to the same name).  For paths
 * that exceed MAX_DIR_LEN, append a hash suffix so uniqueness is guaranteed.
 */
function sanitizePath(p: string): string {
  const sanitized = p.replace(/[^A-Za-z0-9]/g, "-");
  if (sanitized.length <= MAX_DIR_LEN) {
    return sanitized;
  }
  // Truncate + hash suffix for long paths
  return `${sanitized.slice(0, MAX_DIR_LEN)}-${hashPath(p)}`;
}

function projectDir(cwd: string): string {
  const home = process.env.VERA_HOME || homedir();
  return join(home, ".vera", "projects", sanitizePath(cwd));
}

function sessionFilePath(sessionId: string, cwd: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────

/** Parse a single JSONL line; returns null on any parse error (corruption recovery). */
function parseJsonlLine(line: string): SessionEntry | null {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return null;
  }
}

/** Split raw text into non-empty lines and parse each with corruption recovery. */
function parseJsonlLines(raw: string): SessionEntry[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map(parseJsonlLine)
    .filter((e): e is SessionEntry => e !== null);
}

// ── File I/O helpers ──────────────────────────────────────────────────────────

const HEAD_BYTES = 512;       // enough for one session_start line
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

// ── SessionStore ──────────────────────────────────────────────────────────────

export class SessionStore {
  readonly sessionId: string;
  readonly filePath: string;
  private readonly _cwd: string;

  constructor(opts: { sessionId?: string; cwd?: string } = {}) {
    this._cwd = opts.cwd ?? process.cwd();
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    const dir = projectDir(this._cwd);
    mkdirSync(dir, { recursive: true });
    this.filePath = sessionFilePath(this.sessionId, this._cwd);
  }

  // ── Append helpers ──────────────────────────────────────────────────────────

  private append(entry: SessionEntry): void {
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ── Write API ───────────────────────────────────────────────────────────────

  writeStart(model: string, provider: string): void {
    this.append({
      type: "session_start",
      sessionId: this.sessionId,
      timestamp: this.now(),
      cwd: this._cwd,
      model,
      provider,
    });
  }

  writeTitle(title: string): void {
    const entry: CustomTitleEntry = {
      type: "custom_title",
      sessionId: this.sessionId,
      timestamp: this.now(),
      title,
    };
    this.append(entry);
  }

  writeUser(content: string): string {
    const uuid = crypto.randomUUID();
    const entry: UserEntry = {
      type: "user",
      sessionId: this.sessionId,
      timestamp: this.now(),
      uuid,
      content,
    };
    this.append(entry);
    return uuid;
  }

  writeAssistant(p: {
    parentUuid: string;
    content: string;
    model: string;
    provider: string;
    stopReason: StopReason;
    usage: Usage;
    turn: number;
    latencyMs: number;
    toolCalls: string[];
    status: "ok" | "error";
  }): string {
    const uuid = crypto.randomUUID();
    const entry: AssistantEntry = {
      type: "assistant",
      sessionId: this.sessionId,
      timestamp: this.now(),
      uuid,
      parentUuid: p.parentUuid,
      content: p.content,
      model: p.model,
      provider: p.provider,
      stopReason: p.stopReason,
      usage: p.usage,
      turn: p.turn,
      latencyMs: p.latencyMs,
      toolCalls: p.toolCalls,
      status: p.status,
    };
    this.append(entry);
    return uuid;
  }

  writeToolCall(p: {
    parentUuid: string;
    toolName: string;
    toolCallId: string;
    arguments: Record<string, unknown>;
  }): string {
    const uuid = crypto.randomUUID();
    const entry: ToolCallEntry = {
      type: "tool_call",
      sessionId: this.sessionId,
      timestamp: this.now(),
      uuid,
      parentUuid: p.parentUuid,
      toolName: p.toolName,
      toolCallId: p.toolCallId,
      arguments: p.arguments,
    };
    this.append(entry);
    return uuid;
  }

  writeToolResult(p: {
    parentUuid: string;
    toolCallId: string;
    content: string;
  }): void {
    const entry: ToolResultEntry = {
      type: "tool_result",
      sessionId: this.sessionId,
      timestamp: this.now(),
      uuid: crypto.randomUUID(),
      parentUuid: p.parentUuid,
      toolCallId: p.toolCallId,
      content: p.content,
    };
    this.append(entry);
  }

  writeEnd(totalUsage: Usage, totalCostUsd: number, turnCount: number): void {
    this.append({
      type: "session_end",
      sessionId: this.sessionId,
      timestamp: this.now(),
      totalUsage,
      totalCostUsd,
      turnCount,
    });
  }

  // ── Static: list sessions ───────────────────────────────────────────────────

  /**
   * List sessions for the given CWD (defaults to process.cwd()).
   * Uses progressive loading: first HEAD_BYTES + last TAIL_BYTES per file.
   */
  static listSessions(cwd?: string): SessionSummary[] {
    const dir = projectDir(cwd ?? process.cwd());
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const summary = readSessionSummary(filePath);
        if (summary) summaries.push(summary);
      } catch {
        // skip unreadable files
      }
    }

    return summaries.sort(
      (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
    );
  }

  // ── Static: load session for resume ────────────────────────────────────────

  static loadSession(sessionId: string, cwd?: string): LoadedSession {
    const filePath = sessionFilePath(sessionId, cwd ?? process.cwd());
    const raw = readFileSync(filePath, "utf8");
    const entries = parseJsonlLines(raw);

    const history: Message[] = [];
    let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    let totalCostUsd = 0;
    let turnCount = 0;
    let model = "";
    let provider = "";

    for (const entry of entries) {
      if (entry.type === "session_start") {
        if (!model) model = entry.model;
        if (!provider) provider = entry.provider;
      } else if (entry.type === "user") {
        history.push({ role: "user", content: entry.content });
      } else if (entry.type === "assistant") {
        history.push({ role: "assistant", content: entry.content });
        totalUsage = addUsage(totalUsage, entry.usage);
        totalCostUsd += calculateCost(entry.usage, entry.model);
        turnCount++;
        model = entry.model;
        provider = entry.provider;
      } else if (entry.type === "session_end") {
        // session_end has the authoritative cost
        totalCostUsd = entry.totalCostUsd;
      }
      // tool_call / tool_result / custom_title not replayed into LLM history
    }

    return { sessionId, history, totalUsage, totalCostUsd, turnCount, model, provider };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

/**
 * Build a SessionSummary using progressive loading:
 * - First 512 B  → parse session_start (model, provider, cwd, startedAt)
 * - Last  64 KB  → scan for session_end (authoritative cost/turns) + custom_title
 * - Falls back to counting assistant entries in the tail when no session_end exists
 */
function readSessionSummary(filePath: string): SessionSummary | null {
  // ── Head: parse session_start ───────────────────────────────────────────────
  const headRaw = readFileHead(filePath);
  const firstLine = headRaw.split("\n")[0];
  if (!firstLine) return null;
  const first = parseJsonlLine(firstLine);
  if (!first || first.type !== "session_start") return null;

  // ── Tail: scan for session_end + custom_title ───────────────────────────────
  const stat = statSync(filePath);
  const tailEntries = parseJsonlLines(readFileTail(filePath));

  let turnCount = 0;
  let totalCostUsd = 0;
  let title: string | undefined;
  let foundEnd = false;

  for (const entry of tailEntries) {
    if (entry.type === "session_end") {
      turnCount = entry.turnCount;
      totalCostUsd = entry.totalCostUsd;
      foundEnd = true;
    } else if (entry.type === "custom_title") {
      title = entry.title; // last title wins
    }
  }

  // No session_end yet (session still active): compute from assistant entries in tail
  if (!foundEnd) {
    for (const entry of tailEntries) {
      if (entry.type === "assistant") {
        turnCount++;
        totalCostUsd += calculateCost(entry.usage, entry.model);
      }
    }
  }

  return {
    sessionId: first.sessionId,
    filePath,
    startedAt: new Date(first.timestamp),
    lastActivityAt: stat.mtime,
    model: first.model,
    provider: first.provider,
    turnCount,
    totalCostUsd,
    cwd: first.cwd,
    title,
  };
}
