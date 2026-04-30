import { describe, expect, it } from "vitest";
import {
  compactGroupedToolUses,
  compactLowSignalToolUses,
  compactToolSummary,
  groupToolDisplays,
  projectToolUse,
  toolArgsLabel,
} from "../src/repl/ui/controller/toolProjection.js";

describe("toolProjection", () => {
  it("builds concise labels from common args", () => {
    expect(toolArgsLabel("read_file", { path: "a.ts" })).toBe("a.ts");
    expect(toolArgsLabel("bash", { command: "pnpm test" })).toBe("pnpm test");
    expect(toolArgsLabel("grep", { pattern: "needle" })).toBe("needle");
    expect(toolArgsLabel("search", { query: "docs" })).toBe("docs");
  });

  it("compacts read_file and file-list results", () => {
    expect(compactToolSummary("read_file", { ok: true, content: "(12 lines)\ncontent" })).toBe("Read 12 lines");
    expect(compactToolSummary("read_file", { ok: true, content: "(1 line)\ncontent" })).toBe("Read 1 line");
    expect(compactToolSummary("list_dir", {
      ok: true,
      content: "a\nb\n",
      metadata: { renderHint: { type: "file-list" } },
    })).toBe("2 entries");
  });

  it("projects tool uses to renderer-neutral display models", () => {
    const tool = {
      name: "read_file",
      args: { path: "a.ts" },
      result: { ok: true as const, content: "(2 lines)\nhi" },
      preface: "Reading file",
    };

    expect(projectToolUse(tool)).toEqual({
      name: "read_file",
      label: "a.ts",
      ok: true,
      compactSummary: "Read 2 lines",
      renderHintType: undefined,
      preface: "Reading file",
    });
    expect(groupToolDisplays([tool])).toHaveLength(1);
  });

  it("uses error messages as compact summaries", () => {
    expect(compactToolSummary("read_file", {
      ok: false,
      content: "failed",
      error: { code: "ENOENT", message: "missing", retryable: false },
    })).toBe("missing");
  });

  it("compacts low-signal tool calls while preserving the last pending one", () => {
    const tools = [
      { name: "bash", args: {}, result: { ok: true, content: "(no output)" } },
      { name: "bash", args: {}, result: { ok: true, content: "real output" } },
      { name: "bash", args: {}, result: { ok: true, content: "" } },
    ];

    expect(compactLowSignalToolUses(tools).map((tool) => tool.result.content)).toEqual([
      "real output",
      "",
    ]);
  });

  it("groups repeated read/search/list tools", () => {
    const grouped = compactGroupedToolUses([
      { name: "read_file", args: {}, result: { ok: true, content: "a" } },
      { name: "grep", args: {}, result: { ok: true, content: "b" } },
      { name: "bash", args: {}, result: { ok: true, content: "c" } },
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      name: "tool_group",
      result: { content: "Grouped 2 read/search/list tool calls: 1 read_file, 1 grep" },
    });
  });
});
