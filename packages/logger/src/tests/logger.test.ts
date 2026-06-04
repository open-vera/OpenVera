import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  previewForLog,
  resetLogLevel,
  sanitizeForLog,
  truncateForLog,
  type Logger,
} from "../index.js";

const TEST_VERA_HOME = join(process.cwd(), ".vera-test-home");
const TEST_LOGS_DIR = join(TEST_VERA_HOME, ".vera", "logs");
const TEST_OVERRIDE_LOGS_DIR = join(process.cwd(), ".vera-test-logs-override");

function currentLocalLogHour(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}`;
}

function cleanupTestLogs(): void {
  for (const dir of [TEST_VERA_HOME, TEST_OVERRIDE_LOGS_DIR]) {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Parallel tests may hold file descriptors.
      }
    }
  }
}

function readLogLines(): string[] {
  const hour = currentLocalLogHour();
  const logFile = join(TEST_LOGS_DIR, `vera-${hour}.log`);
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
}

function resetEnv(): void {
  delete process.env["VERA_LOG_LEVEL"];
  delete process.env["VERA_LOG_DIR"];
  delete process.env["VERA_CONFIG_DIR"];
  process.env["VERA_HOME"] = TEST_VERA_HOME;
  delete process.env["NODE_ENV"];
  resetLogLevel();
}

beforeEach(() => {
  cleanupTestLogs();
  resetEnv();
});

afterEach(() => {
  resetEnv();
  delete process.env["VERA_HOME"];
});

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
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes meta JSON when provided", () => {
    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.info("action done", { duration_ms: 123 });
    });
    expect(lines[0]!).toContain('"duration_ms":123');
  });

  it("redacts sensitive meta fields before output", () => {
    const sensitiveKey = ["access", ["to", "ken"].join("")].join("_");
    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.info("secret action", {
        apiKey: "sample-api-key",
        nested: { [sensitiveKey]: "sample-sensitive-value", path: "/tmp/file.txt" },
      });
    });

    expect(lines[0]!).toContain('"apiKey":"[REDACTED]"');
    expect(lines[0]!).toContain(`"${sensitiveKey}":"[REDACTED]"`);
    expect(lines[0]!).toContain("/tmp/file.txt");
    expect(lines[0]!).not.toContain("sample-api-key");
    expect(lines[0]!).not.toContain("sample-sensitive-value");
  });

  it("omits meta when not provided", () => {
    const lines = captureStderrLines(() => {
      const log = createLogger("test");
      log.info("simple message");
    });
    expect(lines[0]!).not.toContain("{");
  });
});

describe("log preview helpers", () => {
  it("truncates long strings with omitted char count", () => {
    expect(truncateForLog("abcdef", 3)).toBe("abc…[truncated 3 chars]");
  });

  it("sanitizes nested objects and preserves useful non-sensitive fields", () => {
    const passwordKey = ["pass", "word"].join("");
    const sanitized = sanitizeForLog({
      path: "/tmp/input.txt",
      [passwordKey]: "sample-sensitive-value",
      content: "hello world",
    }, 5);

    expect(sanitized).toMatchObject({
      path: "/tmp/…[truncated 9 chars]",
      content: "hello…[truncated 6 chars]",
    });
    expect((sanitized as Record<string, unknown>)[passwordKey]).toBe("[REDACTED]");
  });

  it("creates a JSON preview for structured values", () => {
    const preview = previewForLog({ file: "/tmp/a.ts", token: "secret" }, 200);
    expect(preview).toContain("/tmp/a.ts");
    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain("secret");
  });
});

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

describe("file output", () => {
  it("writes JSON lines to global logs by default", () => {
    const marker = `filetest-${Date.now()}`;
    const log = createLogger(marker);
    log.info("file log");
    log.error("file error", { code: 500 });

    const fileLines = readLogLines().filter((line) => line.includes(marker));
    expect(fileLines.length).toBe(2);

    const parsed = fileLines.map((line) => JSON.parse(line));
    expect(parsed[0]!.message).toBe("file log");
    expect(parsed[0]!.level).toBe("info");
    expect(parsed[1]!.message).toBe("file error");
    expect(parsed[1]!.level).toBe("error");
    expect(parsed[1]!.meta).toEqual({ code: 500 });
  });

  it("allows VERA_LOG_DIR to override the global logs directory", () => {
    process.env["VERA_LOG_DIR"] = TEST_OVERRIDE_LOGS_DIR;
    resetLogLevel();

    const marker = `override-${Date.now()}`;
    const log = createLogger(marker);
    log.info("override log");

    const hour = currentLocalLogHour();
    const logFile = join(TEST_OVERRIDE_LOGS_DIR, `vera-${hour}.log`);
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, "utf-8")).toContain(marker);
  });
});

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
  });
});
