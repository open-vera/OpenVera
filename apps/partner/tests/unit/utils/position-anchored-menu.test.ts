import { describe, expect, it } from "vitest";
import { positionAnchoredMenu } from "@/utils/position-anchored-menu";

describe("positionAnchoredMenu", () => {
  const viewport = { innerWidth: 1200, innerHeight: 800 };

  it("opens above the anchor and clamps maxHeight to available space", () => {
    const style = positionAnchoredMenu(
      { left: 40, right: 140, top: 700, bottom: 728, width: 100, height: 28 },
      viewport,
      { preferredMaxHeight: 420, width: 260 },
    );

    expect(style).toMatchObject({
      position: "fixed",
      left: "40px",
      width: "260px",
      zIndex: "200",
    });
    // spaceAbove = 700 - 12 - 8 = 680 → capped by preferred 420
    expect(style.maxHeight).toBe("420px");
    // Anchored by its bottom edge so short content still hugs the trigger.
    expect(style.bottom).toBe(`${800 - 700 + 8}px`);
    expect(style.top).toBeUndefined();
  });

  it("shrinks when there is little room above", () => {
    const style = positionAnchoredMenu(
      { left: 40, right: 140, top: 180, bottom: 208, width: 100, height: 28 },
      viewport,
      { preferredMaxHeight: 420, width: 260 },
    );

    // spaceAbove = 180 - 12 - 8 = 160
    expect(style.maxHeight).toBe("160px");
    expect(style.bottom).toBe(`${800 - 180 + 8}px`);
  });

  it("never lets an above-anchored menu overflow the top edge", () => {
    const style = positionAnchoredMenu(
      { left: 40, right: 140, top: 90, bottom: 118, width: 100, height: 28 },
      { innerWidth: 1200, innerHeight: 200 },
      { preferredMaxHeight: 420, minHeight: 160, width: 260 },
    );

    // spaceAbove = 90 - 12 - 8 = 70, and there is even less room below.
    expect(style.bottom).toBe(`${200 - 90 + 8}px`);
    expect(style.maxHeight).toBe("70px");
  });

  it("opens below when there is more room underneath", () => {
    const style = positionAnchoredMenu(
      { left: 40, right: 140, top: 40, bottom: 68, width: 100, height: 28 },
      viewport,
      { preferredMaxHeight: 420, width: 260, preferAbove: true },
    );

    expect(style.top).toBe("76px");
    expect(Number.parseInt(style.maxHeight ?? "0", 10)).toBeGreaterThan(300);
  });

  it("prefers below when preferAbove is false", () => {
    const style = positionAnchoredMenu(
      { left: 40, right: 140, top: 500, bottom: 528, width: 100, height: 28 },
      viewport,
      { preferredMaxHeight: 280, width: 260, preferAbove: false },
    );

    // Opens below even when more room exists above.
    expect(style.top).toBe("536px");
    expect(Number.parseInt(style.maxHeight ?? "0", 10)).toBeGreaterThan(200);
  });

  it("keeps the menu inside the viewport horizontally", () => {
    const style = positionAnchoredMenu(
      { left: 1100, right: 1180, top: 700, bottom: 728, width: 80, height: 28 },
      viewport,
      { width: 260 },
    );
    expect(style.left).toBe(`${1200 - 260 - 12}px`);
  });
});
