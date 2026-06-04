import { describe, expect, it } from "vitest";
import {
  createLogger,
  previewForLog,
  sanitizeForLog,
  truncateForLog,
  type Logger,
} from "../logger.js";

describe("core logger compatibility export", () => {
  it("re-exports the shared logger API", () => {
    const log: Logger = createLogger("compat");

    expect(typeof log.info).toBe("function");
    expect(truncateForLog("abcdef", 3)).toBe("abc…[truncated 3 chars]");
    expect(previewForLog({ token: "secret" })).toContain("[REDACTED]");
    expect(sanitizeForLog({ apiKey: "secret" })).toEqual({ apiKey: "[REDACTED]" });
  });
});
