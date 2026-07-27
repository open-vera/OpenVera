import { describe, expect, it } from "vitest";
import {
  alignOrder,
  insertionIndexAt,
  moveTabById,
  moveToInsertionIndex,
  type TabBounds,
} from "@/utils/tab-reorder";

const BOUNDS: TabBounds[] = [
  { id: "a", left: 0, width: 100 },
  { id: "b", left: 100, width: 100 },
  { id: "c", left: 200, width: 100 },
];

describe("insertionIndexAt", () => {
  it("inserts before a tab when over its left half", () => {
    expect(insertionIndexAt(BOUNDS, 10)).toBe(0);
    expect(insertionIndexAt(BOUNDS, 120)).toBe(1);
  });

  it("inserts after a tab when past its midpoint", () => {
    expect(insertionIndexAt(BOUNDS, 51)).toBe(1);
    expect(insertionIndexAt(BOUNDS, 151)).toBe(2);
  });

  it("appends when dropped past the last tab", () => {
    expect(insertionIndexAt(BOUNDS, 400)).toBe(3);
  });

  it("appends into an empty bar", () => {
    expect(insertionIndexAt([], 40)).toBe(0);
  });

  it("accounts for a scrolled bar via viewport-relative bounds", () => {
    const scrolled: TabBounds[] = [
      { id: "a", left: -80, width: 100 },
      { id: "b", left: 20, width: 100 },
    ];

    expect(insertionIndexAt(scrolled, 10)).toBe(1);
  });
});

describe("moveToInsertionIndex", () => {
  it("moves an item forward", () => {
    expect(moveToInsertionIndex(["a", "b", "c"], 0, 2)).toEqual(["b", "a", "c"]);
    expect(moveToInsertionIndex(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
  });

  it("moves an item backward", () => {
    expect(moveToInsertionIndex(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveToInsertionIndex(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
  });

  it("returns the same array for a no-op drop", () => {
    const items = ["a", "b", "c"];
    expect(moveToInsertionIndex(items, 1, 1)).toBe(items);
    expect(moveToInsertionIndex(items, 1, 2)).toBe(items);
  });

  it("returns the same array when the source is out of range", () => {
    const items = ["a", "b"];
    expect(moveToInsertionIndex(items, -1, 0)).toBe(items);
    expect(moveToInsertionIndex(items, 5, 0)).toBe(items);
  });

  it("does not mutate the input", () => {
    const items = ["a", "b", "c"];
    moveToInsertionIndex(items, 0, 3);
    expect(items).toEqual(["a", "b", "c"]);
  });
});

describe("moveTabById", () => {
  it("moves the identified tab", () => {
    const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(moveTabById(tabs, "c", 0).map((tab) => tab.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores an unknown id", () => {
    const tabs = [{ id: "a" }, { id: "b" }];
    expect(moveTabById(tabs, "zzz", 0)).toBe(tabs);
  });
});

describe("alignOrder", () => {
  it("reorders to match the desired sequence", () => {
    expect(alignOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("keeps ids the desired sequence does not mention, in order, at the end", () => {
    expect(alignOrder(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores desired ids that are not present", () => {
    expect(alignOrder(["a", "b"], ["b", "ghost", "a"])).toEqual(["b", "a"]);
  });
});
