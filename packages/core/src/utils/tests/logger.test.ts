import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger, resetLogLevel, type Logger } from "../logger.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────

const TEST_LOGS_DIR = join(process.cwd(), ".vera", "logs");

function cleanupTestLogs(): void {
  if (existsSync(TEST_LOGS_DIR)) {
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(TEST_LOGS_DIR, `vera-${date}.log`);
    if (existsSync(logFile)) {
      try { unlinkSync(logFile); } catch { /* parallel test may hold fd */ }
    }
    try { rmdirSync(TEST_LOGS_DIR); } catch { /* ok */ }
  }
}

function readLogLines(): string[] {
  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(TEST_LOGS_DIR, `vera-${date}.log`);
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

function resetEnv(): void {
  delete process.env["VERA_LOG_LEVEL"];
  delete process.env["NODE_ENV"];
  resetLogLevel();
}

beforeEach(() => {
  cleanupTestLogs();
  resetEnv();
});

afterEach(() => {
  resetEnv();
});

// ── Stderr spy helper ───────────────────────────────────────────────────────

/** Spy on stderr and return captured log lines as strings. */
function captureStderrLines(fn: () => void): string[] {
  const spy = vi.spyOn(process.stderr, "write");
  const lines: string[] = [];
  spy.mockImplementation((chunk) => {
    lines.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createLogger", () => {
  it("creates a logger with the given name", () => {
    const log = createLogger("test");
    expect(log).toBeDefined();
    expect(log.debug).toBeInstanceOf(Function);
    expect(log.info).toBeInstanceOf(Function);
    expect(log.warn).toBeInstanceOf(Function);
    expect(log.error).toBeInstanceOf(Function);
  });
});

// ── Level filtering (via stderr spy — isolated per test) ──────────────────────

describe("log level filtering", () => {
  it("defaults to debug when NODE_ENV is not production", () => {
    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.debug("debug message");
      log.info("info message");
    });
    expect(lines.length).toBe(2);
    expect(lines[0]!).toContain("DEBUG");
    expect(lines[1]!).toContain("INFO");
  });

  it("defaults to info when NODE_ENV is production", () => {
    process.env["NODE_ENV"] = "production";
    resetLogLevel();

    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.debug("debug message");
      log.info("info message");
    });
    expect(lines.length).toBe(1);
    expect(lines[0]!).toContain("INFO");
  });

  it("VERA_LOG_LEVEL overrides NODE_ENV", () => {
    process.env["NODE_ENV"] = "production";
    process.env["VERA_LOG_LEVEL"] = "debug";
    resetLogLevel();

    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.debug("debug message");
    });
    expect(lines.length).toBe(1);
    expect(lines[0]!).toContain("DEBUG");
  });

  it("VERA_LOG_LEVEL=error only outputs error level", () => {
    process.env["VERA_LOG_LEVEL"] = "error";
    resetLogLevel();

    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    expect(lines.length).toBe(1);
    expect(lines[0]!).toContain("ERROR");
  });

  it("VERA_LOG_LEVEL=warn outputs warn and error", () => {
    process.env["VERA_LOG_LEVEL"] = "warn";
    resetLogLevel();

    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    expect(lines.length).toBe(2);
    expect(lines[0]!).toContain("WARN");
    expect(lines[1]!).toContain("ERROR");
  });

  it("ignores unknown VERA_LOG_LEVEL value and uses default", () => {
    process.env["VERA_LOG_LEVEL"] = "verbose";
    resetLogLevel();

    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.debug("d");
      log.info("i");
    });
    expect(lines.length).toBe(2);
  });
});

// ── Entry structure (stderr) ──────────────────────────────────────────────────

describe("log entry structure", () => {
  it("includes timestamp, level, name, and message", () => {
    const lines = captureStderrLines(() => {
      const log = createLogger("mymodule");
      log.info("hello world");
    });
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line).toContain("INFO");
    expect(line).toContain("[mymodule]");
    expect(line).toContain("hello world");
    // Verify ISO timestamp prefix
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes meta JSON when provided", () => {
    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.info("action done", { duration_ms: 123 });
    });
    expect(lines[0]!).toContain('"duration_ms":123');
  });

  it("omits meta when not provided", () => {
    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.info("simple message");
    });
    // Should not have trailing JSON
    expect(lines[0]!).not.toContain("{");
  });
});

// ── child() ──────────────────────────────────────────────────────────────────

describe("child logger", () => {
  it("inherits parent name as prefix", () => {
    const lines = captureStderrLines(() => {
      const parent = createLogger("parent");
      const child = parent.child("child");
      child.info("from child");
    });
    expect(lines[0]!).toContain("[parent:child]");
  });

  it("supports nested children", () => {
    const lines = captureStderrLines(() => {
      const parent = createLogger("a");
      const child = parent.child("b").child("c");
      child.debug("deep");
    });
    expect(lines[0]!).toContain("[a:b:c]");
  });
});

// ── Stderr output format ─────────────────────────────────────────────────────

describe("stderr output", () => {
  it("writes formatted log to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write");

    const log = createLogger("test");
    log.info("hello");

    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0]?.[0] as string;
    expect(call).toContain("INFO");
    expect(call).toContain("[test]");
    expect(call).toContain("hello");

    spy.mockRestore();
  });
});

// ── File output (sequential test — reads actual log file) ────────────────────

describe("file output", () => {
  it("writes JSON lines to .vera/logs/vera-YYYY-MM-DD.log", () => {
    const marker = `filetest-${Date.now()}`;
    const log = createLogger(marker);
    log.info("file log");
    log.error("file error", { code: 500 });

    const fileLines = readLogLines().filter((l) => l.includes(marker));
    expect(fileLines.length).toBe(2);

    const parsed = fileLines.map((l) => JSON.parse(l));
    expect(parsed[0]!.message).toBe("file log");
    expect(parsed[0]!.level).toBe("info");
    expect(parsed[1]!.message).toBe("file error");
    expect(parsed[1]!.level).toBe("error");
    expect(parsed[1]!.meta).toEqual({ code: 500 });
  });
});

// ── Logger interface ─────────────────────────────────────────────────────────

describe("Logger interface returned by createLogger", () => {
  it("returns object matching Logger interface", () => {
    const log: Logger = createLogger("iface");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.child).toBe("function");
  });

  it("child() creates independent loggers", () => {
    const lines = captureStderrLines(() => {
      const parent = createLogger("root");
      const a = parent.child("a");
      const b = parent.child("b");
      a.info("from a");
      b.info("from b");
    });
    expect(lines[0]!).toContain("[root:a]");
    expect(lines[1]!).toContain("[root:b]");
  });
});

// ── Reset ────────────────────────────────────────────────────────────────────

describe("resetLogLevel", () => {
  it("re-evaluates env vars on next log call", () => {
    process.env["VERA_LOG_LEVEL"] = "error";
    resetLogLevel();
    const log = createLogger("r");

    const lines1 = captureStderrLines(() => {
      log.debug("before");
    });
    expect(lines1.length).toBe(0);

    process.env["VERA_LOG_LEVEL"] = "debug";
    resetLogLevel();

    const lines2 = captureStderrLines(() => {
      log.debug("after");
    });
    expect(lines2.length).toBe(1);
    expect(lines2[0]!).toContain("after");
  });
});
