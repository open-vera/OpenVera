import { describe, expect, it } from "vitest";
import { relativeWorkspacePath } from "@/utils/quick-open-path";

describe("relativeWorkspacePath", () => {
  it("strips the workspace root prefix", () => {
    expect(relativeWorkspacePath("/Users/me/proj", "/Users/me/proj/src/app.ts")).toBe(
      "src/app.ts",
    );
  });

  it("returns the path when outside the root", () => {
    expect(relativeWorkspacePath("/Users/me/proj", "/tmp/other.ts")).toBe("/tmp/other.ts");
  });
});
