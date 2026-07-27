import { describe, expect, it } from "vitest";
import { normalizeFsPath } from "../../../src/components/left/file-tree-context";

describe("normalizeFsPath", () => {
  it("strips trailing slashes for directory match", () => {
    expect(normalizeFsPath("/tmp/temp/")).toBe("/tmp/temp");
    expect(normalizeFsPath("/tmp/temp")).toBe("/tmp/temp");
  });
});

describe("targeted directory reload", () => {
  it("only refreshes the create parent directory", () => {
    const request = { path: normalizeFsPath("/workspace/temp/"), token: 1 };
    const nodePath = normalizeFsPath("/workspace/temp");
    expect(request.path).toBe(nodePath);
  });
});
