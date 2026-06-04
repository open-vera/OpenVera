import { describe, expect, it } from "vitest";
import { formatActivityTools, formatToolLabel } from "../ActivityLane.js";
import { toolArgsLabel } from "../controller/toolProjection.js";
import { emptyActiveTurn, reduceActiveTurn } from "../state/turnStore.js";

describe("activity tool labels", () => {
  it("includes useful tool arguments in compact labels", () => {
    expect(formatToolLabel({ name: "read_file", args: { path: "packages/core/src/repl/ui/App.tsx" } })).toBe(
      "read_file packages/core/src/repl/ui/App.tsx",
    );
    expect(formatToolLabel({ name: "bash", args: { command: "pnpm test" } })).toBe("bash pnpm test");
  });

  it("recognizes glob-style argument names", () => {
    expect(toolArgsLabel("glob", { glob_pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolArgsLabel("glob", { target_directory: "packages/core/src" })).toBe("packages/core/src");
  });

  it("shows recent completed tools with arguments", () => {
    const state = {
      ...emptyActiveTurn(),
      active: true,
      tools: [
        { name: "list_dir", args: { path: "packages/core" }, result: { ok: true, content: "ok" } },
        { name: "read_file", args: { path: "README.md" }, result: { ok: true, content: "ok" } },
      ],
    };

    expect(formatActivityTools(state)).toBe("list_dir packages/core · read_file README.md");
  });
});

describe("active turn token counters", () => {
  it("tracks input and output token deltas for the live status bar", () => {
    const started = reduceActiveTurn(emptyActiveTurn(), { type: "assistant.started" });
    const updated = reduceActiveTurn(started, {
      type: "usage.updated",
      usage: { inputTotal: 120, outputTotal: 30 },
      inputTokensDelta: 120,
      outputTokensDelta: 30,
    });

    expect(updated.inputTokens).toBe(120);
    expect(updated.outputTokens).toBe(30);
  });

  it("stores active tool args while a tool is running", () => {
    const started = reduceActiveTurn(emptyActiveTurn(), { type: "assistant.started" });
    const withTool = reduceActiveTurn(started, {
      type: "tool.started",
      name: "read_file",
      args: { path: "packages/core/src/repl/ui/InputBar.tsx" },
    });

    expect(withTool.activeTool).toEqual({
      name: "read_file",
      args: { path: "packages/core/src/repl/ui/InputBar.tsx" },
      liveOutput: "",
    });
  });
});
