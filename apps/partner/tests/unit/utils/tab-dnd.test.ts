// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeTabDrag,
  clearTabDrag,
  startPointerTabDrag,
  tabBoundsIn,
  tabDropIndexNear,
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
  const container = document.querySelector<HTMLElement>(
    `[data-tab-group="${group}"]`
  );
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

  container
    .querySelectorAll<HTMLElement>("[data-tab-id]")
    .forEach((element, index) => {
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

describe("tabDropIndexNear", () => {
  beforeEach(() => {
    mountStrip("center", ["a", "b", "c"]);
  });

  it("tolerates vertical drift below and above the strip", () => {
    expect(tabDropIndexNear("center", 10, 70)).toBe(0);
    expect(tabDropIndexNear("center", 10, -30)).toBe(0);
  });

  it("gives up once the pointer leaves the slack band", () => {
    expect(tabDropIndexNear("center", 10, 200)).toBeNull();
    expect(tabDropIndexNear("center", 10, -200)).toBeNull();
  });

  it("clamps horizontally instead of bailing out", () => {
    expect(tabDropIndexNear("center", -500, 18)).toBe(0);
    expect(tabDropIndexNear("center", 5000, 18)).toBe(3);
  });

  it("honours a custom slack", () => {
    expect(tabDropIndexNear("center", 10, 60, 10)).toBeNull();
    expect(tabDropIndexNear("center", 10, 40, 10)).toBe(0);
});
});

describe("startPointerTabDrag", () => {
  function press(element: HTMLElement, x: number, y: number, button = 0) {
    return {
      button,
      clientX: x,
      clientY: y,
      pointerId: 1,
      currentTarget: element,
      target: element,
    } as unknown as PointerEvent;
  }

  function move(x: number, y: number) {
    window.dispatchEvent(
      new window.PointerEvent("pointermove", { clientX: x, clientY: y })
    );
  }

  let strip: HTMLElement;
  let tab: HTMLElement;
  let preview: number[] | null[];
  let committed: number[];
  let handlers: {
    onPreview: (i: number | null) => void;
    onCommit: (i: number) => void;
  };

  beforeEach(() => {
    strip = mountStrip("center", ["a", "b", "c"]);
    tab = strip.querySelector<HTMLElement>('[data-tab-id="a"]')!;
    preview = [];
    committed = [];
    handlers = {
      onPreview: (index) => {
        (preview as (number | null)[]).push(index);
      },
      onCommit: (index) => committed.push(index),
    };
  });

  afterEach(() => {
    // Tests that never release the pointer would otherwise leave live
    // listeners behind and double-commit in the next test.
    window.dispatchEvent(new window.PointerEvent("pointercancel"));
  });

  it("ignores a press that never moves, so clicks still select", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18), handlers);
    window.dispatchEvent(new window.PointerEvent("pointerup"));

    expect(committed).toEqual([]);
    expect(activeTabDrag()).toBeNull();
    });

  it("ignores movement below the threshold", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18), handlers);
    move(12, 18);

    expect(activeTabDrag()).toBeNull();
  });

  it("commits the landing index once past the threshold", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18), handlers);
    move(260, 18);
    expect(activeTabDrag()).toEqual({ group: "center", tabId: "a" });
    window.dispatchEvent(new window.PointerEvent("pointerup"));

    expect(committed).toEqual([3]);
    expect(activeTabDrag()).toBeNull();
  });

  it("reports a live insertion marker while dragging", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18), handlers);
    move(120, 18);
    move(260, 18);

    expect(preview.slice(0, 2)).toEqual([1, 3]);
  });

  it("cancels on Escape without committing", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18), handlers);
    move(260, 18);
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape" })
    );
    window.dispatchEvent(new window.PointerEvent("pointerup"));

    expect(committed).toEqual([]);
    expect(activeTabDrag()).toBeNull();
  });

  it("cancels when the platform takes over with a native drag", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18), handlers);
    move(260, 18);
    window.dispatchEvent(new window.PointerEvent("pointercancel"));

    expect(committed).toEqual([]);
});

  it("ignores non-primary buttons", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18, 2), handlers);
    move(260, 18);
    window.dispatchEvent(new window.PointerEvent("pointerup"));

    expect(committed).toEqual([]);
  });

  it("does not commit when released outside the slack band", () => {
    startPointerTabDrag("center", "a", press(tab, 10, 18), handlers);
    move(260, 400);
    window.dispatchEvent(new window.PointerEvent("pointerup"));

    expect(committed).toEqual([]);
  });

  it("hands an off-strip release to onDropOutside with the release point", () => {
    const outside: Array<[number, number]> = [];
    startPointerTabDrag("center", "a", press(tab, 10, 18), {
      ...handlers,
      onDropOutside: (x, y) => outside.push([x, y]),
    });
    move(260, 400);
    window.dispatchEvent(
      new window.PointerEvent("pointerup", { clientX: 260, clientY: 400 })
    );

    expect(committed).toEqual([]);
    expect(outside).toEqual([[260, 400]]);
  });

  it("does not call onDropOutside when the drop lands on the strip", () => {
    const outside: Array<[number, number]> = [];
    startPointerTabDrag("center", "a", press(tab, 10, 18), {
      ...handlers,
      onDropOutside: (x, y) => outside.push([x, y]),
    });
    move(260, 18);
    window.dispatchEvent(new window.PointerEvent("pointerup"));

    expect(committed).toEqual([3]);
    expect(outside).toEqual([]);
  });

  it("does not call onDropOutside for a press that never dragged", () => {
    const outside: Array<[number, number]> = [];
    startPointerTabDrag("center", "a", press(tab, 10, 18), {
      ...handlers,
      onDropOutside: (x, y) => outside.push([x, y]),
    });
    window.dispatchEvent(new window.PointerEvent("pointerup"));

    expect(outside).toEqual([]);
  });
});
