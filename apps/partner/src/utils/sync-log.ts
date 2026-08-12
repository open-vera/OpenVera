/**
 * Diagnostic log for project/session sync across Host, Shell stores and panels.
 *
 * Three views (session tree, chat tab strip, file tree) converge on Host state
 * through different code paths; when they disagree the only useful evidence is
 * the ordered list of who wrote what. Enabled in dev, or by setting
 * `localStorage["partner:debug-sync"] = "1"` in a packaged build.
 */

const STORAGE_KEY = "partner:debug-sync";

let cachedEnabled: boolean | null = null;

function enabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  let flag: string | null = null;
  try {
    flag = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    flag = null;
  }
  // "1" forces on in a packaged build, "0" silences a noisy dev session.
  cachedEnabled =
    flag === "1" ? true : flag === "0" ? false : Boolean(import.meta.env?.DEV);
  return cachedEnabled;
}

/** Re-read the flag (tests, or after toggling it at runtime). */
export function resetSyncLogFlag(): void {
  cachedEnabled = null;
}

/** Short caller hint so a writer can be traced without a full stack dump. */
export function syncCaller(depth = 3): string {
  // Callers pass this straight into syncLog, so skip building a stack when the
  // log is off.
  if (!enabled()) return "";
  const stack = new Error().stack?.split("\n") ?? [];
  // Pinia/Vue wrap every action and watcher, so the frame at a fixed depth is
  // usually their internals. Keep the first few frames that belong to app code.
  const frames = stack
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ""))
    .filter((line) => !/node_modules|\/deps\/|chunk-|syncCaller/.test(line));
  const picked = frames.length ? frames.slice(0, 3) : stack.slice(depth, depth + 3);
  return picked
    .map((line) => line.trim().replace(/^at\s+/, "").replace(/^.*\/src\//, "src/").slice(0, 90))
    .join(" < ");
}

export function syncLog(event: string, detail?: Record<string, unknown>): void {
  if (!enabled()) return;
  console.info(`[ProjectSync] ${event}`, detail ?? {});
  queueForFile(`${event} ${JSON.stringify(detail ?? {})}`);
}

// ── File sink ────────────────────────────────────────────────────────────────
// The webview console cannot be read from outside the app, so mirror the same
// lines to disk. Batched: one `host.fs.append` per flush window, not per line.

const FILE_SINK_PATH = "/tmp/partner-sync.log";
const FLUSH_MS = 400;

let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;

function queueForFile(line: string): void {
  if (typeof globalThis.setTimeout !== "function") return;
  sequence += 1;
  pending.push(`${new Date().toISOString()} #${sequence} ${line}`);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushToFile();
  }, FLUSH_MS);
}

async function flushToFile(): Promise<void> {
  if (!pending.length) return;
  const batch = pending.join("\n");
  pending = [];
  try {
    // Lazy: keeps the Tauri bridge out of this module's import graph.
    const { appendFile } = await import("@/bridge");
    await appendFile(FILE_SINK_PATH, `${batch}\n`);
  } catch {
    // Diagnostics must never break the app (no Host, or fs denied).
  }
}
