import { describe, expect, it } from "vitest";
import {
  offsetFromLspPosition,
  parseLspDefinitionLocation,
  setPendingLspNavigation,
  takePendingLspNavigation,
} from "@/preview/lsp-navigation";

describe("lsp-navigation", () => {
  it("parses Location responses", () => {
    const location = parseLspDefinitionLocation({
      uri: "file:///workspace/src/app.ts",
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
    });
    expect(location).toEqual({
      uri: "file:///workspace/src/app.ts",
      path: "/workspace/src/app.ts",
      line: 2,
      character: 4,
    });
  });

  it("parses LocationLink and arrays", () => {
    const location = parseLspDefinitionLocation([
      {
        targetUri: "file:///workspace/node_modules/globals/index.js",
        targetRange: {
          start: { line: 0, character: 0 },
          end: { line: 10, character: 0 },
        },
        targetSelectionRange: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 6 },
        },
      },
    ]);
    expect(location?.path).toBe("/workspace/node_modules/globals/index.js");
    expect(location?.line).toBe(1);
    expect(location?.character).toBe(2);
  });

  it("stores pending navigation for the matching file only", () => {
    setPendingLspNavigation({ path: "/workspace/a.ts", line: 3, character: 1 });
    expect(takePendingLspNavigation("/workspace/b.ts")).toBeNull();
    expect(takePendingLspNavigation("/workspace/a.ts")).toEqual({
      path: "/workspace/a.ts",
      line: 3,
      character: 1,
    });
    expect(takePendingLspNavigation("/workspace/a.ts")).toBeNull();
  });

  it("maps lsp positions into document offsets", () => {
    const doc = {
      lines: 3,
      line(n: number) {
        if (n === 1) return { from: 0, to: 5 };
        if (n === 2) return { from: 6, to: 11 };
        return { from: 12, to: 15 };
      },
    };
    expect(offsetFromLspPosition(doc, 1, 2)).toBe(8);
    expect(offsetFromLspPosition(doc, 99, 0)).toBe(12);
  });
});
