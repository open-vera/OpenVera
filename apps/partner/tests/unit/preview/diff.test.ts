import { describe, expect, it } from "vitest";
import { isDiffPreview, parseUnifiedDiff } from "@/preview/diff";

describe("preview/diff", () => {
  it("parses modified hunks into old and new documents", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 111..222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,4 @@",
        " const keep = true;",
        "-const oldValue = 1;",
        "+const newValue = 2;",
        "+const added = true;",
        " export {};",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      filePath: "src/app.ts",
      isDiff: true,
      oldText: "const keep = true;\nconst oldValue = 1;\nexport {};",
      newText: "const keep = true;\nconst newValue = 2;\nconst added = true;\nexport {};",
    });
  });

  it("detects diff preview tabs", () => {
    expect(isDiffPreview("git-diff:src/app.ts", "src/app.ts.diff")).toBe(true);
    expect(isDiffPreview("/workspace/app.ts", "/workspace/app.ts")).toBe(false);
  });
});
