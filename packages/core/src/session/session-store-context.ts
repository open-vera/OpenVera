/**
 * Per-session identity for JSONL write helpers.
 */
export interface SessionStoreContext {
  sessionId: string;
  filePath: string;
  cwd: string;
}
