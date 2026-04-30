import { describe, expect, it } from "vitest";
import { formatActivityText, formatActivityTools } from "../src/repl/ui/ActivityLane.js";
import type { ActiveTurnState } from "../src/repl/ui/state/turnStore.js";

function turnWithTools(names: string[]): ActiveTurnState {
  return {
    active: true,
    text: "",
    status: "streaming",
    tools: names.map((name) => ({
      name,
      args: {},
      result: { ok: true, content: "" },
    })),
  };
}

describe("ActivityLane formatting", () => {
  it("compacts whitespace in live text", () => {
    expect(formatActivityText("  hello\n\nworld\tagain  ")).toBe("hello world again");
  });

  it("truncates long live text", () => {
    expect(formatActivityText("abcdef", 4)).toBe("abc…");
  });

  it("formats recent tool names", () => {
    expect(formatActivityTools(turnWithTools(["read_file", "grep"]))).toBe("read_file · grep");
  });

  it("summarizes hidden older tools", () => {
    expect(formatActivityTools(turnWithTools(["a", "b", "c", "d", "e", "f"]))).toBe("+2 c · d · e · f");
  });

  it("returns empty text for no tools", () => {
    expect(formatActivityTools(turnWithTools([]))).toBe("");
  });
});

