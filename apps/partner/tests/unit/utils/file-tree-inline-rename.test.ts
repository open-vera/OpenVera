import { describe, expect, it } from "vitest";

/** Mirror FileTreeNode basename selection (exclude extension). */
function renameSelectionEnd(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

describe("inline rename selection", () => {
  it("selects basename without extension", () => {
    expect(renameSelectionEnd("CLAUDE.md")).toBe(6);
    expect(renameSelectionEnd("foo.bar.ts")).toBe(7);
  });

  it("selects whole name when there is no extension", () => {
    expect(renameSelectionEnd("Makefile")).toBe(8);
    expect(renameSelectionEnd(".gitignore")).toBe(10);
  });
});
