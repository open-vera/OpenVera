import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStorageProvider } from "../sqlite.js";
import { SessionStorageAdapter } from "../session-adapter.js";

export function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-adapter-test-"));
  return join(dir, "test.db");
}

export function makeJsonlContent(sessionId: string): string {
  const lines = [
    JSON.stringify({
      type: "session_start",
      sessionId,
      timestamp: new Date().toISOString(),
      cwd: "/tmp/test",
      model: "claude-3",
      provider: "anthropic",
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid: crypto.randomUUID(),
      content: "hello world",
    }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid: crypto.randomUUID(),
      parentUuid: "p1",
      content: "hi there",
      model: "claude-3",
      provider: "anthropic",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
      turn: 1,
      latencyMs: 100,
      toolCalls: [],
      status: "ok",
    }),
  ];
  return lines.join("\n") + "\n";
}

export async function createSessionAdapterEnv(enableFts = true): Promise<{
  adapter: SessionStorageAdapter;
  storage: SqliteStorageProvider;
  tmpDir: string;
}> {
  const dbPath = makeDbPath();
  const tmpDir = join(dbPath, "..");
  const storage = new SqliteStorageProvider({ backend: "sqlite", dbPath, enableFts });
  const adapter = new SessionStorageAdapter(storage);
  await adapter.initialize();
  return { adapter, storage, tmpDir };
}

export async function clearAllSessions(adapter: SessionStorageAdapter): Promise<void> {
  const { sessions } = await adapter.listSessions();
  for (const s of sessions) {
    await adapter.deleteSession(s.sessionId);
  }
}

export async function destroySessionAdapterEnv(
  adapter: SessionStorageAdapter,
  tmpDir: string
): Promise<void> {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
