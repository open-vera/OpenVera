import { describe, expect, it } from "vitest";
import { isAncestorDir } from "@/utils/file-tree-reveal";

describe("isAncestorDir", () => {
  it("matches nested file paths", () => {
    expect(isAncestorDir("/proj/src", "/proj/src/app.ts")).toBe(true);
    expect(isAncestorDir("/proj/src/", "/proj/src/utils/a.ts")).toBe(true);
  });

  it("rejects sibling prefix collisions", () => {
    expect(isAncestorDir("/proj/src", "/proj/src2/app.ts")).toBe(false);
    expect(isAncestorDir("/proj/src", "/proj/src")).toBe(false);
    expect(isAncestorDir("/proj/src/app.ts", "/proj/src")).toBe(false);
  });
});
