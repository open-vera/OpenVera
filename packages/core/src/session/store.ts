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
  realpathSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import type { StopReason, Usage } from "../types/index.js";
import type { Message } from "../types/message.js";
import { calculateCost } from "./cost.js";
import {
  SessionNotFoundError,
  SessionNotBranchError,
} from "../errors.js";
import type {
  AssistantEntry,
  BranchEntry,
  ForkedSession,
  ForkSessionOptions,
  CustomTitleEntry,
  ListSessionsOptions,
  ListSessionsResult,
  LoadedSession,
  SessionCandidate,
  SessionEntry,
  SessionPreviewMessage,
  SessionPreviewToolUse,
  SessionTranscriptPreview,
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
  return join(projectsDir(), sanitizePath(canonicalizePath(cwd)));
}

function projectDirExact(cwd: string): string {
  return join(projectsDir(), sanitizePath(cwd));
}

function canonicalizePath(p: string): string {
  try {
    return normalize(realpathSync(p)).normalize("NFC");
  } catch {
    return normalize(p).normalize("NFC");
  }
}

function projectsDir(): string {
  const home = process.env.VERA_HOME || homedir();
  return join(home, ".vera", "projects");
}

function sessionFilePath(sessionId: string, cwd: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

function listProjectDirs(): string[] {
  try {
    return readdirSync(projectsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectsDir(), entry.name));
  } catch {
    return [];
  }
}

function gitWorktreePaths(cwd: string): string[] {
  try {
    const raw = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sessionDirsFor(cwd?: string, includeWorktrees = true): string[] {
  if (!cwd) return listProjectDirs();
  const candidates = includeWorktrees ? [cwd, ...gitWorktreePaths(cwd)] : [cwd];
  return [...new Set(candidates.flatMap((candidate) => [
    projectDir(candidate),
    projectDirExact(candidate),
  ]))];
}

function resolveSessionFilePath(sessionId: string, cwd?: string): string {
  const fileName = `${sessionId}.jsonl`;
  for (const dir of sessionDirsFor(cwd)) {
    const candidate = join(dir, fileName);
    try {
      if (statSync(candidate).size > 0) return candidate;
    } catch {
      // keep searching
    }
  }
  return cwd ? sessionFilePath(sessionId, cwd) : join(projectsDir(), fileName);
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

  get cwd(): string {
    return this._cwd;
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
      type: "custom-title",
      sessionId: this.sessionId,
      timestamp: this.now(),
      customTitle: title,
    };
    this.append(entry);
  }

  writeAiTitle(aiTitle: string): void {
    this.append({
      type: "ai-title",
      sessionId: this.sessionId,
      timestamp: this.now(),
      aiTitle,
    });
  }

  writeSummary(summary: string): void {
    this.append({
      type: "summary",
      sessionId: this.sessionId,
      timestamp: this.now(),
      summary,
    });
  }

  writeTag(tag: string): void {
    this.append({
      type: "tag",
      sessionId: this.sessionId,
      timestamp: this.now(),
      tag,
    });
  }

  writeGitBranch(gitBranch: string): void {
    this.append({
      type: "git-branch",
      sessionId: this.sessionId,
      timestamp: this.now(),
      gitBranch,
    });
  }

  writePrLink(p: {
    prUrl: string;
    prRepository?: string;
    prNumber?: number;
  }): void {
    this.append({
      type: "pr-link",
      sessionId: this.sessionId,
      timestamp: this.now(),
      prUrl: p.prUrl,
      ...(p.prRepository ? { prRepository: p.prRepository } : {}),
      ...(p.prNumber ? { prNumber: p.prNumber } : {}),
    });
  }

  writeBranch(p: {
    parentSessionId: string;
    forkedFromUuid?: string;
    title?: string;
    status?: BranchEntry["status"];
    worktreePath?: string;
    worktreeBranch?: string;
    baseCommit?: string;
  }): void {
    const entry: BranchEntry = {
      type: "branch",
      sessionId: this.sessionId,
      timestamp: this.now(),
      parentSessionId: p.parentSessionId,
      ...(p.forkedFromUuid ? { forkedFromUuid: p.forkedFromUuid } : {}),
      ...(p.title ? { title: p.title } : {}),
      status: p.status ?? "active",
      ...(p.worktreePath ? { worktreePath: p.worktreePath } : {}),
      ...(p.worktreeBranch ? { worktreeBranch: p.worktreeBranch } : {}),
      ...(p.baseCommit ? { baseCommit: p.baseCommit } : {}),
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

  writeEnd(totalUsage: Usage, totalCostUsd: number, turnCount: number, lastPrompt?: string): void {
    const normalizedLastPrompt = preview(lastPrompt);
    if (normalizedLastPrompt) {
      this.append({
        type: "last-prompt",
        sessionId: this.sessionId,
        timestamp: this.now(),
        lastPrompt: normalizedLastPrompt,
      });
    }
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
   * List sessions for a CWD and its git worktrees. When cwd is omitted,
   * list sessions across all known projects.
   * Uses progressive loading: first HEAD_BYTES + last TAIL_BYTES per file.
   */
  static listSessions(cwd?: string): SessionSummary[] {
    return SessionStore.listSessionsPaged({ cwd, limit: 0 }).sessions;
  }

  static listSessionCandidates(opts: ListSessionsOptions = {}): SessionCandidate[] {
    const dirs = opts.all ? sessionDirsFor(undefined) : sessionDirsFor(opts.cwd, opts.includeWorktrees ?? true);
    const candidates: SessionCandidate[] = [];

    for (const dir of dirs) {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }

      for (const file of files) {
        const sessionId = file.slice(0, -".jsonl".length);
        const filePath = join(dir, file);
        try {
          const stat = statSync(filePath);
          if (stat.size <= 0) continue;
          candidates.push({
            sessionId,
            filePath,
            mtimeMs: stat.mtimeMs,
            fileSize: stat.size,
          });
        } catch {
          // skip unreadable files
        }
      }
    }

    return candidates.sort((a, b) =>
      b.mtimeMs !== a.mtimeMs
        ? b.mtimeMs - a.mtimeMs
        : b.sessionId.localeCompare(a.sessionId)
    );
  }

  static listSessionsPaged(opts: ListSessionsOptions = {}): ListSessionsResult {
    const limit = opts.limit ?? 0;
    const offset = Math.max(0, opts.offset ?? 0);
    const candidates = SessionStore.listSessionCandidates(opts);
    const sessions: SessionSummary[] = [];
    const seen = new Set<string>();
    const want = limit > 0 ? limit : Number.POSITIVE_INFINITY;
    let skipped = 0;
    let nextOffset: number | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (seen.has(candidate.sessionId)) continue;
      seen.add(candidate.sessionId);
      if (skipped < offset) {
        skipped++;
        continue;
      }

      try {
        const summary = readSessionSummary(candidate.filePath);
        if (!summary) continue;
        sessions.push(summary);
        if (sessions.length >= want) {
          nextOffset = offset + sessions.length;
          break;
        }
      } catch {
        // skip unreadable files
      }
    }

    return {
      sessions,
      ...(nextOffset !== undefined && nextOffset < candidates.length ? { nextOffset } : {}),
      totalCandidates: candidates.length,
    };
  }

  static forkSession(options: ForkSessionOptions): ForkedSession {
    const cwd = options.cwd ?? process.cwd();
    const sourcePath = resolveSessionFilePath(options.fromSessionId, cwd);
    const raw = readFileSync(sourcePath, "utf8");
    const entries = parseJsonlLines(raw);
    const sourceMessages = entries.filter(isReplayableSessionEntry);

    if (sourceMessages.length === 0) {
      throw new SessionNotFoundError(options.fromSessionId);
    }

    const forkedFromUuid = options.atUuid ?? findLastMessageUuid(sourceMessages);
    const forkStore = new SessionStore({ cwd });
    const forkedEntries = sourceMessages.map((entry) => ({
      ...entry,
      sessionId: forkStore.sessionId,
    }));

    for (const entry of forkedEntries) {
      forkStore.append(entry);
    }
    forkStore.writeBranch({
      parentSessionId: options.fromSessionId,
      forkedFromUuid,
      title: options.title,
      status: "active",
      worktreePath: options.worktreePath,
      worktreeBranch: options.worktreeBranch,
      baseCommit: options.baseCommit,
    });
    if (options.title) {
      forkStore.writeTitle(`${options.title} (Branch)`);
    }

    return {
      sessionId: forkStore.sessionId,
      parentSessionId: options.fromSessionId,
      ...(forkedFromUuid ? { forkedFromUuid } : {}),
      filePath: forkStore.filePath,
      ...(options.title ? { title: options.title } : {}),
      ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
      ...(options.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {}),
      ...(options.baseCommit ? { baseCommit: options.baseCommit } : {}),
    };
  }

  static listBranches(parentSessionId: string, cwd?: string): SessionSummary[] {
    return SessionStore.listSessions(cwd).filter(
      (session) =>
        session.branch?.parentSessionId === parentSessionId &&
        session.branch.status !== "discarded"
    );
  }

  static discardBranch(sessionId: string, cwd?: string): void {
    const loaded = readBranchMetadata(resolveSessionFilePath(sessionId, cwd ?? process.cwd()));
    if (!loaded) {
      throw new SessionNotBranchError(sessionId);
    }
    const store = new SessionStore({ sessionId, cwd });
    store.writeBranch({
      parentSessionId: loaded.parentSessionId,
      forkedFromUuid: loaded.forkedFromUuid,
      title: loaded.title,
      status: "discarded",
      worktreePath: loaded.worktreePath,
      worktreeBranch: loaded.worktreeBranch,
      baseCommit: loaded.baseCommit,
    });
  }

  static adoptBranch(sessionId: string, cwd?: string): void {
    const loaded = readBranchMetadata(resolveSessionFilePath(sessionId, cwd ?? process.cwd()));
    if (!loaded) {
      throw new SessionNotBranchError(sessionId);
    }
    const store = new SessionStore({ sessionId, cwd });
    store.writeBranch({
      parentSessionId: loaded.parentSessionId,
      forkedFromUuid: loaded.forkedFromUuid,
      title: loaded.title,
      status: "adopted",
      worktreePath: loaded.worktreePath,
      worktreeBranch: loaded.worktreeBranch,
      baseCommit: loaded.baseCommit,
    });
  }

  static markBranchMerged(sessionId: string, cwd?: string): void {
    const loaded = readBranchMetadata(resolveSessionFilePath(sessionId, cwd ?? process.cwd()));
    if (!loaded) {
      throw new SessionNotBranchError(sessionId);
    }
    const store = new SessionStore({ sessionId, cwd });
    store.writeBranch({
      parentSessionId: loaded.parentSessionId,
      forkedFromUuid: loaded.forkedFromUuid,
      title: loaded.title,
      status: "merged",
      worktreePath: loaded.worktreePath,
      worktreeBranch: loaded.worktreeBranch,
      baseCommit: loaded.baseCommit,
    });
  }

  // ── Static: load session for resume ────────────────────────────────────────

  static loadSession(sessionId: string, cwd?: string): LoadedSession {
    const filePath = resolveSessionFilePath(sessionId, cwd ?? process.cwd());
    const raw = readFileSync(filePath, "utf8");
    const entries = parseJsonlLines(raw);

    const history: Message[] = [];
    let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    let totalCostUsd = 0;
    let turnCount = 0;
    let model = "";
    let provider = "";
    let loadedCwd = cwd ?? process.cwd();

    for (const entry of entries) {
      if (entry.type === "session_start") {
        if (!model) model = entry.model;
        if (!provider) provider = entry.provider;
        if (entry.cwd) loadedCwd = entry.cwd;
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

    return { sessionId, filePath, cwd: loadedCwd, history, totalUsage, totalCostUsd, turnCount, model, provider };
  }

  static loadTranscriptPreview(sessionId: string, cwd?: string): SessionTranscriptPreview {
    const filePath = resolveSessionFilePath(sessionId, cwd);
    const raw = readFileSync(filePath, "utf8");
    const entries = parseJsonlLines(raw);
    const messages: SessionPreviewMessage[] = [];
    const toolCallsByParent = new Map<string, ToolCallEntry[]>();
    const toolResultsByCallUuid = new Map<string, ToolResultEntry>();

    for (const entry of entries) {
      if (entry.type === "tool_call") {
        const existing = toolCallsByParent.get(entry.parentUuid) ?? [];
        existing.push(entry);
        toolCallsByParent.set(entry.parentUuid, existing);
      } else if (entry.type === "tool_result") {
        toolResultsByCallUuid.set(entry.parentUuid, entry);
      }
    }

    for (const entry of entries) {
      if (entry.type === "user") {
        messages.push({ role: "user", content: entry.content });
      } else if (entry.type === "assistant") {
        const toolUses = (toolCallsByParent.get(entry.parentUuid) ?? []).map((toolCall): SessionPreviewToolUse => {
          const result = toolResultsByCallUuid.get(toolCall.uuid);
          return {
            name: toolCall.toolName,
            args: toolCall.arguments,
            result: {
              ok: Boolean(result),
              content: result?.content ?? "(no tool result recorded)",
            },
          };
        });
        messages.push({
          role: "assistant",
          content: entry.content,
          ...(toolUses.length ? { toolUses } : {}),
        });
      }
    }

    const summary = readSessionSummary(filePath) ?? undefined;
    return {
      sessionId,
      messages,
      ...(summary ? { summary } : {}),
    };
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
function readSessionSummary(filePath: string): SessionSummary | null {
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

function isReplayableSessionEntry(
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

function findLastMessageUuid(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if ("uuid" in entry) {
      return entry.uuid;
    }
  }
  return undefined;
}

function readBranchMetadata(filePath: string): BranchEntry | null {
  const raw = readFileSync(filePath, "utf8");
  const entries = parseJsonlLines(raw);
  return entries.filter((entry): entry is BranchEntry => entry.type === "branch").at(-1) ?? null;
}

function preview(content: string | undefined): string | undefined {
  const normalized = content?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
