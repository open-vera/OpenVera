import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockBrowserExecute } = vi.hoisted(() => ({
  mockBrowserExecute: vi.fn(),
}));

vi.mock("../browser.js", () => ({
  browserTool: { execute: mockBrowserExecute },
  closeAllBrowserSessions: vi.fn(),
}));
vi.mock("../desktop-screenshot.js", () => ({ desktopScreenshotTool: { execute: vi.fn() } }));
vi.mock("../desktop-input.js", () => ({ desktopInputTool: { execute: vi.fn() } }));
vi.mock("../desktop-script.js", () => ({ desktopScriptTool: { execute: vi.fn() } }));
vi.mock("../desktop-accessibility.js", () => ({ desktopAccessibilityTool: { execute: vi.fn() } }));
vi.mock("../bash.js", () => ({ bashTool: { execute: vi.fn() } }));
vi.mock("../visual-analyze.js", () => ({
  createVisualAnalyzeTool: vi.fn(() => ({ name: "va", description: "", parameters: { type: "object", properties: {} }, execute: vi.fn() })),
}));

import { computerUseTool } from "../computer-use.js";

describe("debug mock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowserExecute.mockResolvedValue({ ok: true, content: "default" });
  });

  it("mockImplementation works", async () => {
    mockBrowserExecute.mockImplementation(async (args: Record<string, unknown>) => {
      if (args.action === "evaluate") return { ok: true, content: "Page Title: Example" };
      return { ok: true, content: "other" };
    });

    const result = await computerUseTool.execute(
      { task: "get title", environment: "browser", action: "evaluate", expression: "document.title" },
      { cwd: "/tmp", sessionId: "test" },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Page Title");
  });

  it("mockResolvedValueOnce works", async () => {
    mockBrowserExecute
      .mockResolvedValueOnce({ ok: true, content: "first" })
      .mockResolvedValueOnce({ ok: false, content: "fail", error: { code: "EXEC_ERROR", message: "fail", retryable: false } });

    const r1 = await computerUseTool.execute(
      { task: "go to https://example.com and click #btn" },
      { cwd: "/tmp", sessionId: "test" },
    );
    expect(r1.ok).toBe(false);
  });
});
