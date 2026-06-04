import { appendFileSync, existsSync, mkdirSync } from "node:fs";
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

function ensureLogDir(): string | null {
  if (logDir !== null) return logDir;
  // Determine log directory from VERA_CONFIG_DIR or default to .vera/logs
  const configDir = process.env["VERA_CONFIG_DIR"];
  const baseDir = configDir
    ? join(configDir, "logs")
    : join(process.cwd(), ".vera", "logs");
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
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  logFilePath = join(dir, `vera-${date}.log`);
  return logFilePath;
}

function writeToFile(entry: LogEntry): void {
  // Check date rollover
  const date = new Date().toISOString().slice(0, 10);
  if (logFilePath && !logFilePath.endsWith(`vera-${date}.log`)) {
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

/** Reset cached level (useful for testing). */
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
      ...(meta ? { meta } : {}),
    };

    writeToStderr(entry);
    writeToFile(entry);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────────

export function createLogger(name: string): Logger {
  return new LoggerImpl(name);
}
