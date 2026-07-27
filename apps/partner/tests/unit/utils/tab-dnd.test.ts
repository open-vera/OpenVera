// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeTabDrag,
  beginTabDrag,
  clearTabDrag,
  resolveTabReorderAt,
  tabBoundsIn,
  tabDropIndexAt,
  TAB_REORDER_MIME,
} from "@/utils/tab-dnd";

/**
 * happy-dom reports every rect as zero, so stub the geometry the hit-test
 * reads: a 3-tab strip at y 0-36, each tab 100px wide starting at x 0.
 */
function mountStrip(group: string, tabIds: string[]) {
  document.body.innerHTML = `
    <div data-tab-group="${group}">
      ${tabIds.map((id) => `<button data-tab-id="${id}"></button>`).join("")}
    </div>
  `;
  const container = document.querySelector<HTMLElement>(`[data-tab-group="${group}"]`);
  if (!container) throw new Error("strip not mounted");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: tabIds.length * 100,
    top: 0,
    bottom: 36,
    width: tabIds.length * 100,
    height: 36,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  container.querySelectorAll<HTMLElement>("[data-tab-id]").forEach((element, index) => {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      left: index * 100,
      right: index * 100 + 100,
      top: 0,
      bottom: 36,
      width: 100,
      height: 36,
      x: index * 100,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });
  return container;
}

afterEach(() => {
  clearTabDrag();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("beginTabDrag", () => {
  it("records the dragged tab and attaches a payload", () => {
    const setData = vi.fn();
    beginTabDrag("center", "tab-1", { setData } as unknown as DataTransfer);

    expect(activeTabDrag()).toEqual({ group: "center", tabId: "tab-1" });
    expect(setData).toHaveBeenCalledWith(TAB_REORDER_MIME, "tab-1");
  });

  it("works without a dataTransfer", () => {
    beginTabDrag("preview", "tab-2", null);
    expect(activeTabDrag()?.tabId).toBe("tab-2");
  });

  it("hands out a copy so callers cannot mutate the state", () => {
    beginTabDrag("center", "tab-1");
    const snapshot = activeTabDrag();
    if (snapshot) snapshot.tabId = "hacked";

    expect(activeTabDrag()?.tabId).toBe("tab-1");
  });

  it("clears back to null", () => {
    beginTabDrag("center", "tab-1");
    clearTabDrag();
    expect(activeTabDrag()).toBeNull();
  });
});

describe("tabBoundsIn", () => {
  it("reads bounds in DOM order", () => {
    mountStrip("center", ["a", "b"]);

    expect(tabBoundsIn("center")).toEqual([
      { id: "a", left: 0, width: 100 },
      { id: "b", left: 100, width: 100 },
    ]);
  });

  it("returns nothing for an absent group", () => {
    expect(tabBoundsIn("preview")).toEqual([]);
  });
});

describe("tabDropIndexAt", () => {
  beforeEach(() => {
    mountStrip("center", ["a", "b", "c"]);
  });

  it("maps a point inside the strip to an insertion index", () => {
    expect(tabDropIndexAt("center", 10, 18)).toBe(0);
    expect(tabDropIndexAt("center", 160, 18)).toBe(2);
    expect(tabDropIndexAt("center", 290, 18)).toBe(3);
  });

  it("rejects points outside the strip", () => {
    expect(tabDropIndexAt("center", 10, 200)).toBeNull();
    expect(tabDropIndexAt("center", 500, 18)).toBeNull();
    expect(tabDropIndexAt("center", -5, 18)).toBeNull();
  });

  it("rejects an unmounted group", () => {
    expect(tabDropIndexAt("preview", 10, 18)).toBeNull();
  });
});

describe("resolveTabReorderAt", () => {
  beforeEach(() => {
    mountStrip("center", ["a", "b", "c"]);
  });

  it("resolves the dragged tab and its landing index", () => {
    beginTabDrag("center", "c");

    expect(resolveTabReorderAt("center", 10, 18)).toEqual({
      tabId: "c",
      insertionIndex: 0,
    });
  });

  it("refuses a drag from another group", () => {
    beginTabDrag("preview", "file-1");

    expect(resolveTabReorderAt("center", 10, 18)).toBeNull();
  });

  it("refuses when no drag is in flight", () => {
    expect(resolveTabReorderAt("center", 10, 18)).toBeNull();
  });

  it("refuses a release outside the strip so other drop targets can act", () => {
    beginTabDrag("center", "c");

    expect(resolveTabReorderAt("center", 10, 400)).toBeNull();
  });
});
