import { describe, expect, it } from "vitest";
import { fileIconForPath } from "@/utils/file-icons";

describe("fileIconForPath", () => {
  it("returns compact metadata for common files", () => {
    expect(fileIconForPath("/workspace/package.json")).toMatchObject({
      label: "{}",
      color: "#e5c07b",
      isDir: false,
    });
    expect(fileIconForPath("/workspace/events.jsonl")).toMatchObject({
      label: "JL",
      color: "#e5c07b",
      isDir: false,
    });
    expect(fileIconForPath("/workspace/App.vue")).toMatchObject({
      label: "V",
      color: "#98c379",
      isDir: false,
    });
  });

  it("handles common module variants", () => {
    expect(fileIconForPath("/workspace/index.cjs")).toMatchObject({
      label: "JS",
      color: "#f7df1e",
      isDir: false,
    });
  });

  it("returns folder metadata for directories", () => {
    expect(fileIconForPath("/workspace/node_modules", true)).toEqual({
      label: "",
      color: "#c8a86a",
      isDir: true,
    });
  });
});
