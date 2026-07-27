import { describe, expect, it, vi } from "vitest";
import { scrollTabIntoView } from "@/utils/scroll-tab-into-view";

function mockRect(left: number, right: number): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: 20,
    width: right - left,
    height: 20,
    x: left,
    y: 0,
    toJSON: () => ({}),
  };
}

function createTabContainer(tabId: string): {
  container: HTMLElement;
  tab: HTMLElement;
  scrollBy: ReturnType<typeof vi.fn>;
} {
  const tab = {
    dataset: { tabId },
    getBoundingClientRect: vi.fn(),
  } as unknown as HTMLElement;

  const scrollBy = vi.fn();
  const container = {
    querySelectorAll: vi.fn(() => [tab]),
    getBoundingClientRect: vi.fn(),
    scrollBy,
  } as unknown as HTMLElement;

  return { container, tab, scrollBy };
}

describe("scrollTabIntoView", () => {
  it("returns false when container or tab id is missing", () => {
    expect(scrollTabIntoView(null, "t1")).toBe(false);
    expect(scrollTabIntoView({} as HTMLElement, null)).toBe(false);
  });

  it("returns false when the tab element is not found", () => {
    const container = {
      querySelectorAll: vi.fn(() => []),
    } as unknown as HTMLElement;
    expect(scrollTabIntoView(container, "missing")).toBe(false);
  });

  it("scrolls left when the active tab is clipped on the left", () => {
    const { container, tab, scrollBy } = createTabContainer("t1");
    vi.mocked(container.getBoundingClientRect).mockReturnValue(mockRect(100, 300));
    vi.mocked(tab.getBoundingClientRect).mockReturnValue(mockRect(40, 120));

    expect(scrollTabIntoView(container, "t1", { edgePad: 8 })).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith({
      left: 40 - 100 - 8,
      behavior: "smooth",
    });
  });

  it("scrolls right when the active tab is clipped on the right", () => {
    const { container, tab, scrollBy } = createTabContainer("t1");
    vi.mocked(container.getBoundingClientRect).mockReturnValue(mockRect(100, 300));
    vi.mocked(tab.getBoundingClientRect).mockReturnValue(mockRect(260, 340));

    expect(scrollTabIntoView(container, "t1", { edgePad: 8 })).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith({
      left: 340 - 300 + 8,
      behavior: "smooth",
    });
  });

  it("does not scroll when the tab is already fully visible", () => {
    const { container, tab, scrollBy } = createTabContainer("t1");
    vi.mocked(container.getBoundingClientRect).mockReturnValue(mockRect(100, 300));
    vi.mocked(tab.getBoundingClientRect).mockReturnValue(mockRect(140, 220));

    expect(scrollTabIntoView(container, "t1")).toBe(true);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
