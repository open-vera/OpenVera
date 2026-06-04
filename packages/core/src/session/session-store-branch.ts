/**
 * Session branch fork and lifecycle (JSONL).
 */
import { readFileSync } from "node:fs";
import { SessionNotFoundError, SessionNotBranchError } from "../errors.js";
import type { ForkedSession, ForkSessionOptions, SessionSummary } from "./types.js";
import { getSessionBackend } from "./session-backend.js";
import { appendSessionEntry } from "./session-store-append.js";
import {
  findLastMessageUuid,
  isReplayableSessionEntry,
  parseJsonlLines,
  readBranchMetadata,
} from "./jsonl-session-io.js";
import { resolveSessionFilePath } from "./store-paths.js";
import { listSessions } from "./session-store-list.js";
import {
  writeSessionBranch,
  writeSessionTitle,
} from "./session-store-writes.js";
import type { SessionStoreContext } from "./session-store-context.js";

export interface SessionStoreHandle extends SessionStoreContext {}

export function forkSession(
  options: ForkSessionOptions,
  createStore: (opts: { cwd?: string }) => SessionStoreHandle
): ForkedSession {
  const backend = getSessionBackend();
  if (backend) {
    return backend.forkSession(options);
  }
  const cwd = options.cwd ?? process.cwd();
  const sourcePath = resolveSessionFilePath(options.fromSessionId, cwd);
  const raw = readFileSync(sourcePath, "utf8");
  const entries = parseJsonlLines(raw);
  const sourceMessages = entries.filter(isReplayableSessionEntry);

  if (sourceMessages.length === 0) {
    throw new SessionNotFoundError(options.fromSessionId);
  }

  const forkedFromUuid = options.atUuid ?? findLastMessageUuid(sourceMessages);
  const forkStore = createStore({ cwd });
  const forkedEntries = sourceMessages.map((entry) => ({
    ...entry,
    sessionId: forkStore.sessionId,
  }));

  for (const entry of forkedEntries) {
    appendSessionEntry(forkStore.filePath, entry);
  }
  writeSessionBranch(forkStore, {
    parentSessionId: options.fromSessionId,
    forkedFromUuid,
    title: options.title,
    status: "active",
    worktreePath: options.worktreePath,
    worktreeBranch: options.worktreeBranch,
    baseCommit: options.baseCommit,
  });
  if (options.title) {
    writeSessionTitle(forkStore, `${options.title} (Branch)`);
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

export function listBranches(parentSessionId: string, cwd?: string): SessionSummary[] {
  const backend = getSessionBackend();
  if (backend) {
    return backend.listBranches(parentSessionId, cwd);
  }
  return listSessions(cwd).filter(
    (session) =>
      session.branch?.parentSessionId === parentSessionId &&
      session.branch.status !== "discarded"
  );
}

function updateBranchStatus(
  sessionId: string,
  cwd: string | undefined,
  status: "discarded" | "adopted" | "merged",
  createStore: (opts: { sessionId?: string; cwd?: string }) => SessionStoreHandle
): void {
  const backend = getSessionBackend();
  if (backend) {
    if (status === "discarded") backend.discardBranch(sessionId, cwd);
    else if (status === "adopted") backend.adoptBranch(sessionId, cwd);
    else backend.markBranchMerged(sessionId, cwd);
    return;
  }
  const loaded = readBranchMetadata(resolveSessionFilePath(sessionId, cwd ?? process.cwd()));
  if (!loaded) {
    throw new SessionNotBranchError(sessionId);
  }
  const store = createStore({ sessionId, cwd });
  writeSessionBranch(store, {
    parentSessionId: loaded.parentSessionId,
    forkedFromUuid: loaded.forkedFromUuid,
    title: loaded.title,
    status,
    worktreePath: loaded.worktreePath,
    worktreeBranch: loaded.worktreeBranch,
    baseCommit: loaded.baseCommit,
  });
}

export function discardBranch(
  sessionId: string,
  cwd: string | undefined,
  createStore: (opts: { sessionId?: string; cwd?: string }) => SessionStoreHandle
): void {
  updateBranchStatus(sessionId, cwd, "discarded", createStore);
}

export function adoptBranch(
  sessionId: string,
  cwd: string | undefined,
  createStore: (opts: { sessionId?: string; cwd?: string }) => SessionStoreHandle
): void {
  updateBranchStatus(sessionId, cwd, "adopted", createStore);
}

export function markBranchMerged(
  sessionId: string,
  cwd: string | undefined,
  createStore: (opts: { sessionId?: string; cwd?: string }) => SessionStoreHandle
): void {
  updateBranchStatus(sessionId, cwd, "merged", createStore);
}
