import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActivePartnerDrag,
  clearPartnerSelection,
  consumePartnerSelection,
  finishPartnerPathsDragAt,
  isPointOverChatDropZone,
  isPointOverComposerDrop,
  physicalToCssPoint,
  rememberPartnerSelection,
  resolveDropClientPoint,
  setPartnerPathsDrag,
  readPartnerPathsDrag,
  writePartnerSelectionClipboard,
  readPartnerSelectionClipboard,
} from "@/utils/partner-dnd";

function fakeDataTransfer(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    effectAllowed: "none",
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  } as unknown as DataTransfer;
}

function stubDropZones(zones: Array<{ selector: string; rect: DOMRect }>) {
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      const matched = zones.filter((zone) => zone.selector === selector);
      return matched.map((zone) => ({
        getBoundingClientRect: () => zone.rect,
      }));
    },
    elementFromPoint: () => null,
  });
}

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

describe("partner-dnd", () => {
  beforeEach(() => {
    clearPartnerSelection();
    clearActivePartnerDrag();
    vi.unstubAllGlobals();
  });

  it("round-trips path drag payloads", () => {
    const transfer = fakeDataTransfer();
    setPartnerPathsDrag(transfer, [
      { path: "/workspace/apps/partner", isDir: true },
      { path: "/workspace/README.md", isDir: false },
    ]);
    expect(readPartnerPathsDrag(transfer)).toEqual([
      { path: "/workspace/apps/partner", isDir: true },
      { path: "/workspace/README.md", isDir: false },
    ]);
  });

  it("consumes remembered editor selections on paste", () => {
    rememberPartnerSelection({
      path: "/workspace/CLAUDE.md",
      name: "CLAUDE.md",
      content: "| `.gemini/` | Gemini |",
      startLine: 12,
      endLine: 13,
    });

    const hit = consumePartnerSelection("| `.gemini/` | Gemini |");
    expect(hit?.name).toBe("CLAUDE.md");
    expect(hit?.startLine).toBe(12);
    expect(consumePartnerSelection("| `.gemini/` | Gemini |")).toBeNull();
  });

  it("writes selection clipboard and reads it back", () => {
    const transfer = fakeDataTransfer();
    writePartnerSelectionClipboard(transfer, {
      path: "/workspace/a.ts",
      name: "a.ts",
      content: "const x = 1;",
      startLine: 3,
      endLine: 3,
    });
    expect(readPartnerSelectionClipboard(transfer)?.path).toBe("/workspace/a.ts");
  });

  it("converts physical drop points using devicePixelRatio", () => {
    expect(physicalToCssPoint({ x: 200, y: 400 }, 2)).toEqual({ x: 100, y: 200 });
  });

  it("detects chat / composer drop targets via bounding rects", () => {
    stubDropZones([
      { selector: "[data-chat-drop]", rect: rect(100, 0, 400, 800) },
      { selector: "[data-composer-drop]", rect: rect(100, 600, 400, 760) },
    ]);
    expect(isPointOverChatDropZone(200, 100)).toBe(true);
    expect(isPointOverComposerDrop(200, 650)).toBe(true);
    expect(isPointOverChatDropZone(10, 10)).toBe(false);
  });

  it("finishes partner drag into the chat zone on dragend", () => {
    stubDropZones([{ selector: "[data-chat-drop]", rect: rect(0, 0, 500, 500) }]);
    const transfer = fakeDataTransfer();
    setPartnerPathsDrag(transfer, [{ path: "/tmp/a.md", isDir: false }]);
    expect(finishPartnerPathsDragAt(120, 80)).toEqual([
      { path: "/tmp/a.md", isDir: false },
    ]);
    expect(finishPartnerPathsDragAt(120, 80)).toBeNull();
  });

  it("resolves drop points with DPR fallback when scaled miss", () => {
    stubDropZones([{ selector: "[data-chat-drop]", rect: rect(100, 100, 300, 300) }]);
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    // Scaled (50,50) misses; raw (150,150) hits chat zone.
    expect(resolveDropClientPoint({ x: 150, y: 150 })).toEqual({ x: 150, y: 150 });
  });
});
