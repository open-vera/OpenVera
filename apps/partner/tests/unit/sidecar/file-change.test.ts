import { describe, expect, it } from "vitest";
import { extractFileChange } from "../../../sidecar/src/file-change.js";

describe("extractFileChange", () => {
  it("builds unified diff and line counts from tool metadata", () => {
    const result = {
      ok: true,
      content: "Edited src/foo.ts",
      metadata: {
        renderHint: { type: "diff" as const },
        diff: {
          filePath: "src/foo.ts",
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 3,
              lines: [" context", "-old", "+new1", "+new2"],
            },
          ],
        },
      },
    };

    expect(extractFileChange(result)).toEqual({
      path: "src/foo.ts",
      added: 2,
      removed: 1,
      unifiedDiff: [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,2 +1,3 @@",
        " context",
        "-old",
        "+new1",
        "+new2",
      ].join("\n"),
    });
  });

  it("returns undefined when result has no diff metadata", () => {
    expect(
      extractFileChange({
        ok: true,
        content: "ok",
      }),
    ).toBeUndefined();
    expect(
      extractFileChange({
        ok: false,
        content: "fail",
        metadata: {
          diff: {
            filePath: "a.ts",
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] }],
          },
        },
      }),
    ).toBeUndefined();
  });
});
