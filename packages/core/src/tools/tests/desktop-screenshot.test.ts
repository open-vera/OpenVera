/**
 * Comprehensive unit tests for desktop-screenshot tool.
 *
 * Verifies: tool metadata, parameter schema, macOS (screencapture) capture,
 * Linux (scrot/import) capture with fallback, unsupported platform errors,
 * custom paths, format handling, delay, display, window/region modes,
 * and all error paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../types.js";

// ── Mock state ─────────────────────────────────────────────────────────────────

type ExecOutcome =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stderr: string };

// null = use the shared nextResult; otherwise, use per-call list
let sequentialOutcomes: ExecOutcome[] | null = null;
let callIndex = 0;
let nextOk = true;
let nextStdout = "";
let nextStderr = "";

/** Track which commands were attempted (for Linux fallback verification) */
const attemptedCommands: string[] = [];

function setSequentialOutcomes(outcomes: ExecOutcome[]) {
  sequentialOutcomes = outcomes;
  callIndex = 0;
}

function setSimpleSuccess(stdout = "", stderr = "") {
  sequentialOutcomes = null;
  nextOk = true;
  nextStdout = stdout;
  nextStderr = stderr;
}

function setSimpleFailure(stderrMsg = "mock error") {
  sequentialOutcomes = null;
  nextOk = false;
  nextStderr = stderrMsg;
}

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockMkdir = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: mockMkdir,
  readFile: vi.fn().mockResolvedValue("{}"),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");
  return {
    ...actual,
    promisify: vi.fn((_fn: Function) => {
      return (...args: unknown[]) => {
        const cmdName = typeof args[0] === "string" ? args[0] : "unknown";
        attemptedCommands.push(cmdName);

        return new Promise((resolve, reject) => {
          let outcome: ExecOutcome;

          if (sequentialOutcomes && callIndex < sequentialOutcomes.length) {
            outcome = sequentialOutcomes[callIndex++];
          } else if (sequentialOutcomes && callIndex >= sequentialOutcomes.length) {
            // Fall through to default if no more sequential outcomes
            outcome = { ok: nextOk, stderr: nextStderr };
          } else {
            outcome = { ok: nextOk, stderr: nextStderr };
          }

          if (outcome.ok) {
            resolve({
              stdout: "stdout" in outcome ? outcome.stdout : "",
              stderr: "stderr" in outcome ? outcome.stderr : "",
            });
          } else {
            const err = new Error(outcome.stderr || "mock error");
            (err as Record<string, unknown>).stderr = outcome.stderr;
            reject(err);
          }
        });
      };
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  attemptedCommands.length = 0;
  sequentialOutcomes = null;
  callIndex = 0;
  setSimpleSuccess();
  // Default platform to darwin for macOS tests, override per-test as needed
  Object.defineProperty(process, "platform", { value: "darwin", writable: true });
});

// ── Import helper ──────────────────────────────────────────────────────────────

async function importTool() {
  return (await import("../desktop-screenshot.js")).desktopScreenshotTool;
}

// ===============================================================================
// Tool Metadata
// ===============================================================================

describe("desktop_screenshot tool metadata", () => {
  it("should have correct name", async () => {
    const tool = await importTool();
    expect(tool.name).toBe("desktop_screenshot");
  });

  it("should have a description mentioning screenshot and modes", async () => {
    const tool = await importTool();
    expect(tool.description).toContain("screenshot");
    expect(tool.description).toContain("fullscreen");
    expect(tool.description).toContain("window");
    expect(tool.description).toContain("region");
  });

  it("should define parameter schema with all expected properties", async () => {
    const tool = await importTool();
    const params = tool.parameters;
    expect(params).toHaveProperty("type", "object");

    const props = params.properties as Record<string, unknown>;
    expect(props).toHaveProperty("mode");
    expect(props).toHaveProperty("path");
    expect(props).toHaveProperty("delay");
    expect(props).toHaveProperty("format");
    expect(props).toHaveProperty("windowTitle");
    expect(props).toHaveProperty("display");
  });

  it("should have mode enum with fullscreen, window, region", async () => {
    const tool = await importTool();
    const modeProp = (tool.parameters.properties as Record<string, unknown>).mode as Record<string, unknown>;
    expect(modeProp.enum).toEqual(["fullscreen", "window", "region"]);
  });

  it("should have format enum with png and jpg", async () => {
    const tool = await importTool();
    const formatProp = (tool.parameters.properties as Record<string, unknown>).format as Record<string, unknown>;
    expect(formatProp.enum).toEqual(["png", "jpg"]);
  });

  it("should have no required parameters", async () => {
    const tool = await importTool();
    expect(tool.parameters.required).toEqual([]);
  });

  it("should have options with timeoutMs and low riskLevel", async () => {
    const tool = await importTool();
    expect(tool.options).toBeDefined();
    expect(tool.options!.timeoutMs).toBe(30_000);
    expect(tool.options!.riskLevel).toBe("low");
  });
});

// ===============================================================================
// macOS (darwin) Screenshot Tests
// ===============================================================================

describe("macOS capture", () => {
  it("should capture fullscreen screenshot by default", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Screenshot saved to");
    expect(result.content).toContain("fullscreen");
  });

  it("should capture fullscreen screenshot explicitly", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ mode: "fullscreen" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("fullscreen");
    expect(result.content).toMatch(/Screenshot saved to \/tmp\/test\/screenshot-/);
  });

  it("should capture window screenshot with -w flag", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ mode: "window" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("window");
    expect(result.content).not.toContain("fullscreen");
  });

  it("should capture region screenshot with -s flag", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ mode: "region" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("region");
  });

  it("should pass delay to screencapture", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ delay: 3 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Screenshot saved to");
  });

  it("should ignore delay of 0 (no -T flag)", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ delay: 0 }, mockCtx);

    expect(result.ok).toBe(true);
  });

  it("should ignore negative delay", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ delay: -1 }, mockCtx);

    expect(result.ok).toBe(true);
  });

  it("should output jpg format", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ format: "jpg" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.metadata?.renderHint).toEqual({
      type: "image",
      mimeType: "image/jpeg",
    });
  });

  it("should output png format by default", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.metadata?.renderHint).toEqual({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("should pass display index to screencapture", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ display: 2 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Screenshot saved to");
  });

  it("should use custom output path", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { path: "/tmp/my-screenshot.png" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("/tmp/my-screenshot.png");
  });

  it("should create directory for output path", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    await tool.execute({ path: "/tmp/sub/deep/shot.png" }, mockCtx);

    expect(mockMkdir).toHaveBeenCalledWith("/tmp/sub/deep", { recursive: true });
  });

  it("should use default path when no path provided", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({}, mockCtx);

    expect(result.content).toMatch(/\/tmp\/test\/screenshot-.*\.png/);
  });

  it("should use default .jpg extension when format is jpg and no path", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ format: "jpg" }, mockCtx);

    expect(result.content).toMatch(/screenshot-.*\.jpg/);
  });

  it("should return error when screencapture fails", async () => {
    const tool = await importTool();
    setSimpleFailure("screencapture: could not capture display");

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("Screenshot failed");
    expect(result.content).toContain("screencapture: could not capture display");
  });

  it("should handle non-Error throws in catch block (string-like)", async () => {
    const tool = await importTool();
    setSimpleFailure("non-error-message");

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("Screenshot failed");
    expect(result.content).toContain("non-error-message");
  });

  it("should handle non-Error rejection (String(e) branch)", async () => {
    const tool = await importTool();
    // mkdir rejects with a non-Error to trigger the String(e) path in catch
    mockMkdir.mockRejectedValueOnce("permission denied");

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("Screenshot failed");
    expect(result.content).toContain("permission denied");
  });
});

// ===============================================================================
// macOS specific parameter combinations
// ===============================================================================

describe("macOS parameter combinations", () => {
  it("should handle window mode with delay and custom path", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { mode: "window", delay: 2, path: "/tmp/win-delay.png" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("window");
    expect(result.content).toContain("/tmp/win-delay.png");
    expect(result.metadata?.renderHint).toEqual({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("should handle region mode with display index", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { mode: "region", display: 1 },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("region");
  });

  it("should handle jpg format with window mode", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { mode: "window", format: "jpg", path: "/tmp/win.jpg" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("window");
    expect(result.metadata?.renderHint).toEqual({
      type: "image",
      mimeType: "image/jpeg",
    });
  });

  it("should handle fullscreen with max delay and display", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { mode: "fullscreen", delay: 10, display: 0, path: "/tmp/big.png" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("fullscreen");
    expect(result.content).toContain("/tmp/big.png");
  });

  it("should handle all parameters at once", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      {
        mode: "window",
        format: "png",
        delay: 1,
        display: 3,
        path: "/tmp/all-params.png",
        windowTitle: "Terminal",
      },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("window");
    expect(result.content).toContain("/tmp/all-params.png");
  });

  it("should handle empty args object (all defaults)", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("fullscreen");
    expect(result.metadata?.renderHint?.type).toBe("image");
  });
});

// ===============================================================================
// Linux Screenshot Tests
// ===============================================================================

describe("Linux capture", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
  });

  it("should capture fullscreen with scrot (first tool)", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ mode: "fullscreen" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
    expect(result.content).toContain("fullscreen");
    // Only scrot should have been attempted
    expect(attemptedCommands).toContain("scrot");
    expect(attemptedCommands).not.toContain("import");
  });

  it("should capture window with scrot (-u flag)", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ mode: "window" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
    expect(result.content).toContain("window");
  });

  it("should capture region with scrot (-s flag)", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ mode: "region" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
    expect(result.content).toContain("region");
  });

  it("should fall back to import when scrot fails", async () => {
    const tool = await importTool();
    setSequentialOutcomes([
      { ok: false, stderr: "scrot: not found" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via import");
    expect(attemptedCommands).toEqual(["scrot", "import"]);
  });

  it("should return error when both scrot and import fail", async () => {
    const tool = await importTool();
    setSequentialOutcomes([
      { ok: false, stderr: "scrot: not found" },
      { ok: false, stderr: "import: not found" },
    ]);

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("No screenshot tool available");
    expect(attemptedCommands).toEqual(["scrot", "import"]);
  });

  it("should pass delay to scrot on Linux", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ delay: 5 }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
  });

  it("should use custom path on Linux", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { path: "/tmp/linux-shot.png" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("/tmp/linux-shot.png");
  });

  it("should return jpg render hint on Linux", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ format: "jpg" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.metadata?.renderHint).toEqual({
      type: "image",
      mimeType: "image/jpeg",
    });
  });
});

// ===============================================================================
// Linux parameter combinations
// ===============================================================================

describe("Linux parameter combinations", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
  });

  it("should handle window mode with custom path on Linux", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { mode: "window", path: "/tmp/linux-win.png" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
    expect(result.content).toContain("window");
    expect(result.content).toContain("/tmp/linux-win.png");
  });

  it("should handle region mode with delay on Linux", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { mode: "region", delay: 3 },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
    expect(result.content).toContain("region");
  });

  it("should handle jpg format on Linux", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ format: "jpg" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.metadata?.renderHint).toEqual({
      type: "image",
      mimeType: "image/jpeg",
    });
  });

  it("should handle all parameters on Linux with scrot", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      {
        mode: "fullscreen",
        format: "png",
        delay: 2,
        path: "/tmp/linux-all.png",
        windowTitle: "ignored-on-linux",
      },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
    expect(result.content).toContain("fullscreen");
    expect(result.content).toContain("/tmp/linux-all.png");
  });
});

// ===============================================================================
// Unsupported Platform Tests
// ===============================================================================

describe("unsupported platform", () => {
  it("should return error for win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("Unsupported platform");
    expect(result.content).toContain("win32");
  });

  it("should return error for aix", async () => {
    Object.defineProperty(process, "platform", { value: "aix", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unsupported platform");
  });

  it("should return error for android", async () => {
    Object.defineProperty(process, "platform", { value: "android", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
  });

  it("should return error for freebsd", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unsupported platform");
  });
});

// ===============================================================================
// Path and format edge cases
// ===============================================================================

describe("path and format edge cases", () => {
  it("should generate default path in cwd with png extension", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({}, { cwd: "/home/user", sessionId: "s1" });

    expect(result.content).toMatch(/\/home\/user\/screenshot-.*\.png/);
  });

  it("should generate default path with jpg extension when format=jpg", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute(
      { format: "jpg" },
      { cwd: "/home/user", sessionId: "s1" }
    );

    expect(result.content).toMatch(/\/home\/user\/screenshot-.*\.jpg/);
  });

  it("should use provided path regardless of format extension", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    // User provides .jpg path but format defaults to png — path is honored
    const result = await tool.execute(
      { path: "/tmp/shot.jpg" },
      mockCtx
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("/tmp/shot.jpg");
  });

  it("should create directory structure with mkdir recursive", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    await tool.execute(
      { path: "/a/very/deep/nested/path/screenshot.png" },
      mockCtx
    );

    expect(mockMkdir).toHaveBeenCalledWith("/a/very/deep/nested/path", {
      recursive: true,
    });
  });
});

// ===============================================================================
// Error result structure
// ===============================================================================

describe("error result structure", () => {
  it("should return ok:false with error code for unknown platform", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("EXEC_ERROR");
    expect(result.error!.message).toContain("Unsupported platform");
    expect(result.error!.retryable).toBe(false);
  });

  it("should return ok:false with error code for exec failure", async () => {
    const tool = await importTool();
    setSimpleFailure("command not found: screencapture");

    const result = await tool.execute({}, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("EXEC_ERROR");
    expect(result.error!.message).toContain("Screenshot failed");
  });
});

// ===============================================================================
// Platform detection (via execute path)
// ===============================================================================

describe("platform detection", () => {
  it("should detect darwin and succeed", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({}, mockCtx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Screenshot saved to");
    expect(result.content).toContain("fullscreen");
    // darwin path does not use scrot/import
    expect(result.content).not.toContain("via scrot");
  });

  it("should detect linux and succeed with scrot", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({}, mockCtx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("via scrot");
  });

  it("should reject win32 (unknown)", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
  });

  it("should reject sunos (unknown)", async () => {
    Object.defineProperty(process, "platform", { value: "sunos", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unsupported platform");
    expect(result.content).toContain("sunos");
  });

  it("should reject openbsd (unknown)", async () => {
    Object.defineProperty(process, "platform", { value: "openbsd", writable: true });
    const tool = await importTool();

    const result = await tool.execute({}, mockCtx);
    expect(result.ok).toBe(false);
  });
});

// ===============================================================================
// Display edge case: display=0 is passed (not ignored like null/undefined)
// ===============================================================================

describe("display parameter edge cases", () => {
  it("should pass display=0 to screencapture on macOS", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    const result = await tool.execute({ display: 0 }, mockCtx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("fullscreen");
  });

  it("should not pass display when undefined on macOS", async () => {
    const tool = await importTool();
    setSimpleSuccess();

    // display is undefined — no -D flag should be passed
    const result = await tool.execute({}, mockCtx);
    expect(result.ok).toBe(true);
  });
});

// ===============================================================================
// Linux fallback: window mode does not pass -window root for region
// ===============================================================================

describe("Linux fallback edge cases", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
  });

  it("should use import with -window root for window mode", async () => {
    const tool = await importTool();
    setSequentialOutcomes([
      { ok: false, stderr: "scrot: not found" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await tool.execute({ mode: "window" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via import");
    expect(result.content).toContain("window");
  });

  it("should use import for region mode (no special flag)", async () => {
    const tool = await importTool();
    setSequentialOutcomes([
      { ok: false, stderr: "scrot: not found" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await tool.execute({ mode: "region" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via import");
    expect(result.content).toContain("region");
  });

  it("should use import for fullscreen mode", async () => {
    const tool = await importTool();
    setSequentialOutcomes([
      { ok: false, stderr: "scrot: not found" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await tool.execute({ mode: "fullscreen" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("via import");
    expect(result.content).toContain("fullscreen");
  });
});
