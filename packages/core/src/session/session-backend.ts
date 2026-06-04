/**
 * Session storage backend registry (JSONL default, optional SQLite).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { globalDataPath } from "../config/paths.js";
import type { SessionStoreBackend } from "./backend.js";

let sessionBackend: SessionStoreBackend | null = null;

export function getSessionBackend(): SessionStoreBackend | null {
  return sessionBackend;
}

export function setSessionBackend(backend: SessionStoreBackend | null): void {
  sessionBackend = backend;
}

export async function configureSqliteSessionBackend(options: {
  dbPath: string;
  enableFts?: boolean;
  autoMigrate?: boolean;
  sessionsDir?: string;
}): Promise<{ backend: import("./sqlite-backend.js").SQLiteSessionBackend; migrated: number }> {
  const { SQLiteSessionBackend } = await import("./sqlite-backend.js");
  const backend = new SQLiteSessionBackend(options.dbPath, options.enableFts);
  await backend.initialize();

  let migrated = 0;
  if (options.autoMigrate !== false) {
    const dir = options.sessionsDir ?? globalDataPath("projects");
    try {
      const projectDirs = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(dir, e.name));
      for (const projectDirPath of projectDirs) {
        migrated += await backend.migrateFromJsonl(projectDirPath);
      }
    } catch {
      // No projects dir yet
    }
  }

  setSessionBackend(backend);
  return { backend, migrated };
}
