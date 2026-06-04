/**
 * Session listing and pagination (JSONL progressive summary).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ListSessionsOptions,
  ListSessionsResult,
  SessionCandidate,
  SessionSummary,
} from "./types.js";
import { getSessionBackend } from "./session-backend.js";
import { sessionDirsFor } from "./store-paths.js";
import { readSessionSummary } from "./jsonl-session-io.js";

export function listSessionCandidates(opts: ListSessionsOptions = {}): SessionCandidate[] {
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

export function listSessionsPaged(opts: ListSessionsOptions = {}): ListSessionsResult {
  const backend = getSessionBackend();
  if (backend) {
    return backend.listSessions(opts);
  }
  const limit = opts.limit ?? 0;
  const offset = Math.max(0, opts.offset ?? 0);
  const candidates = listSessionCandidates(opts);
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

export function listSessions(cwd?: string): SessionSummary[] {
  const backend = getSessionBackend();
  if (backend) {
    return backend.listSessions({ cwd }).sessions;
  }
  return listSessionsPaged({ cwd, limit: 0 }).sessions;
}
