import { existsSync } from "node:fs";
import { SessionStore, type LoadedSession } from "../session/index.js";

export interface ResumeWorkspace {
  cwd: string;
  warning?: string;
}

export function resolveResumeWorkspace(loaded: LoadedSession, currentCwd: string): ResumeWorkspace {
  const summary = SessionStore.listSessions(currentCwd).find(
    (session) => session.sessionId === loaded.sessionId
  );
  const worktreePath = summary?.branch?.worktreePath;
  if (!worktreePath) {
    return { cwd: loaded.cwd || currentCwd };
  }
  if (existsSync(worktreePath)) {
    return { cwd: worktreePath };
  }
  return {
    cwd: loaded.cwd || currentCwd,
    warning:
      `Try branch worktree is missing: ${worktreePath}\n` +
      `Resumed conversation in original workspace: ${loaded.cwd || currentCwd}`,
  };
}
