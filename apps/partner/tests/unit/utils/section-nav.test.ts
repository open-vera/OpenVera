import { describe, expect, it } from "vitest";
import { isScrolledToBottom, pickActiveSection } from "@/utils/section-nav";

const OFFSETS = [
  { id: "appearance", top: 0 },
  { id: "llm", top: 400 },
  { id: "storage", top: 1200 },
];

describe("pickActiveSection", () => {
  it("returns an empty id when there are no sections", () => {
    expect(pickActiveSection([], 0)).toBe("");
  });

  it("starts on the first section", () => {
    expect(pickActiveSection(OFFSETS, 0)).toBe("appearance");
  });

  it("keeps the first section while scrolling within it", () => {
    expect(pickActiveSection(OFFSETS, 300)).toBe("appearance");
  });

  it("switches once a section crosses the anchor line", () => {
    expect(pickActiveSection(OFFSETS, 376)).toBe("llm");
    expect(pickActiveSection(OFFSETS, 1176)).toBe("storage");
  });

  it("honours a custom anchor offset", () => {
    expect(pickActiveSection(OFFSETS, 390, { anchorOffset: 0 })).toBe("appearance");
    expect(pickActiveSection(OFFSETS, 390, { anchorOffset: 100 })).toBe("llm");
  });

  it("selects the last section at the bottom even if it never reaches the anchor", () => {
    expect(pickActiveSection(OFFSETS, 500, { atBottom: true })).toBe("storage");
  });

  it("stops at the first section past the anchor rather than scanning on", () => {
    const unsorted = [
      { id: "a", top: 0 },
      { id: "b", top: 900 },
      { id: "c", top: 300 },
    ];

    expect(pickActiveSection(unsorted, 400)).toBe("a");
  });
});

describe("isScrolledToBottom", () => {
  it("detects the end of the scroll range", () => {
    expect(isScrolledToBottom(600, 400, 1000)).toBe(true);
  });

  it("tolerates sub-pixel rounding", () => {
    expect(isScrolledToBottom(598.5, 400, 1000)).toBe(true);
  });

  it("is false in the middle of the range", () => {
    expect(isScrolledToBottom(100, 400, 1000)).toBe(false);
  });
});
