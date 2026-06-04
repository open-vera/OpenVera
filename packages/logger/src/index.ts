import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  name: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(name: string): Logger;
}

// ── Structured log safety helpers ─────────────────────────────────────────────

const DEFAULT_PREVIEW_CHARS = 1_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 5;

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(api[_-]?key|token|secret|password|passwd|authorization|credential|private[_-]?key)($|[_-])/i;

function getPreviewChars(): number {
  const raw = process.env["VERA_LOG_PREVIEW_CHARS"];
  if (!raw) return DEFAULT_PREVIEW_CHARS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PREVIEW_CHARS;
  return parsed;
}

export function truncateForLog(text: string, maxChars = getPreviewChars()): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

export function sanitizeForLog(value: unknown, maxStringLength = getPreviewChars()): unknown {
  const seen = new WeakSet<object>();

  function visit(current: unknown, depth: number, key?: string): unknown {
    if (key && SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
    if (typeof current === "string") return truncateForLog(current, maxStringLength);
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "undefined"
    ) {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "symbol") return String(current);
    if (typeof current === "function") return "[Function]";
    if (depth >= MAX_DEPTH) return "[MaxDepth]";
    if (current instanceof Error) {
      return {
        name: current.name,
        message: truncateForLog(current.message, maxStringLength),
        stack: current.stack ? truncateForLog(current.stack, maxStringLength) : undefined,
      };
    }
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Uint8Array) return `[Uint8Array ${current.byteLength} bytes]`;
    if (typeof current !== "object") return String(current);

    if (seen.has(current)) return "[Circular]";
    seen.add(current);

    if (Array.isArray(current)) {
      const items = current.slice(0, MAX_ARRAY_ITEMS).map((item) => visit(item, depth + 1));
      if (current.length > MAX_ARRAY_ITEMS) {
        items.push(`[... ${current.length - MAX_ARRAY_ITEMS} more items]`);
      }
      return items;
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(current as Record<string, unknown>);
    for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
      out[entryKey] = visit(entryValue, depth + 1, entryKey);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      out.__truncated_keys = entries.length - MAX_OBJECT_KEYS;
    }
    return out;
  }

  return visit(value, 0);
}

export function previewForLog(value: unknown, maxStringLength = getPreviewChars()): string {
  if (typeof value === "string") return truncateForLog(value, maxStringLength);
  try {
    return truncateForLog(JSON.stringify(sanitizeForLog(value, maxStringLength)), maxStringLength);
  } catch {
    return truncateForLog(String(value), maxStringLength);
  }
}

// ── Level resolution ────────────────────────────────────────────────────────────

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): LogLevel {
  const explicit = process.env["VERA_LOG_LEVEL"];
  if (explicit && explicit in LEVEL_WEIGHT) return explicit as LogLevel;
  if (process.env["NODE_ENV"] === "production") return "info";
  return "debug";
}

// ── File transport ──────────────────────────────────────────────────────────────

let logDir: string | null = null;
let logFilePath: string | null = null;

function veraHome(): string {
  return process.env["VERA_HOME"] ?? homedir();
}

function globalDataPath(name: string): string {
  return join(veraHome(), ".vera", name);
}

function ensureLogDir(): string | null {
  if (logDir !== null) return logDir;
  const baseDir = process.env["VERA_LOG_DIR"]
    ?? (process.env["VERA_CONFIG_DIR"] ? join(process.env["VERA_CONFIG_DIR"], "logs") : undefined)
    ?? globalDataPath("logs");
  try {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
    logDir = baseDir;
    return logDir;
  } catch {
    return null;
  }
}

function getLogFilePath(): string | null {
  if (logFilePath) return logFilePath;
  const dir = ensureLogDir();
  if (!dir) return null;
  const hour = getCurrentLogHour();
  logFilePath = join(dir, `vera-${hour}.log`);
  return logFilePath;
}

function getCurrentLogHour(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}`;
}

function writeToFile(entry: LogEntry): void {
  const hour = getCurrentLogHour();
  if (logFilePath && !logFilePath.endsWith(`vera-${hour}.log`)) {
    logFilePath = null;
  }
  const fp = getLogFilePath();
  if (!fp) return;
  try {
    appendFileSync(fp, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // File write failure must not crash the app
  }
}

// ── Stderr transport ────────────────────────────────────────────────────────────

function formatEntry(entry: LogEntry): string {
  const metaStr = entry.meta ? " " + JSON.stringify(entry.meta) : "";
  return `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} [${entry.name}] ${entry.message}${metaStr}\n`;
}

function writeToStderr(entry: LogEntry): void {
  process.stderr.write(formatEntry(entry));
}

// ── Logger implementation ───────────────────────────────────────────────────────

let currentLevel: LogLevel | undefined;

function getLevel(): LogLevel {
  if (currentLevel === undefined) {
    currentLevel = getConfiguredLevel();
  }
  return currentLevel;
}

/** Reset cached level and paths. Useful for tests. */
export function resetLogLevel(): void {
  currentLevel = undefined;
  logDir = null;
  logFilePath = null;
}

class LoggerImpl implements Logger {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log("error", message, meta);
  }

  child(name: string): Logger {
    return new LoggerImpl(`${this.name}:${name}`);
  }

  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[getLevel()]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      name: this.name,
      message,
      ...(meta ? { meta: sanitizeForLog(meta) as Record<string, unknown> } : {}),
    };

    writeToStderr(entry);
    writeToFile(entry);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────────

export function createLogger(name: string): Logger {
  return new LoggerImpl(name);
}
