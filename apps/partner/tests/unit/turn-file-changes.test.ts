import { describe, expect, it } from "vitest";
import {
  aggregateTurnFileChanges,
  formatChangeCounts,
} from "../../src/utils/turn-file-changes";

describe("aggregateTurnFileChanges", () => {
  it("merges repeated edits to the same path", () => {
    const changes = aggregateTurnFileChanges([
      {
        id: "1",
        output: "ok",
        fileChange: {
          path: "a.ts",
          added: 2,
          removed: 1,
          unifiedDiff: "diff a1",
        },
      },
      {
        id: "2",
        output: "ok",
        fileChange: {
          path: "b.ts",
          added: 5,
          removed: 0,
          unifiedDiff: "diff b",
        },
      },
      {
        id: "3",
        output: "ok",
        fileChange: {
          path: "a.ts",
          added: 1,
          removed: 2,
          unifiedDiff: "diff a2",
        },
      },
    ]);

    expect(changes).toEqual([
      {
        path: "a.ts",
        added: 3,
        removed: 3,
        unifiedDiff: "diff a1\ndiff a2",
      },
      {
        path: "b.ts",
        added: 5,
        removed: 0,
        unifiedDiff: "diff b",
      },
    ]);
  });

  it("ignores results without fileChange", () => {
    expect(
      aggregateTurnFileChanges([
        { id: "1", output: "read ok" },
        { id: "2", output: "fail", isError: true },
      ]),
    ).toEqual([]);
  });
});

describe("formatChangeCounts", () => {
  it("formats +N -M", () => {
    expect(formatChangeCounts({ added: 26, removed: 2 })).toBe("+26 -2");
  });
});
