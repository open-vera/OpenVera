import { describe, expect, it } from "vitest";
import { collapseRunningDisplayItems } from "@/utils/running-display";

describe("collapseRunningDisplayItems", () => {
  const base = Date.parse("2026-07-07T20:01:00+08:00");

  it("keeps the time separator before the visible window", () => {
    const items = [
      { type: "time" as const, key: "time:1", label: "19:50" },
      { type: "message" as const, key: "m1", message: { timestamp: base - 11 * 60_000 } },
      { type: "message" as const, key: "m2", message: { timestamp: base - 10 * 60_000 } },
      { type: "time" as const, key: "time:2", label: "20:01" },
      { type: "message" as const, key: "m3", message: { timestamp: base } },
      { type: "message" as const, key: "m4", message: { timestamp: base + 1_000 } },
      { type: "message" as const, key: "m5", message: { timestamp: base + 2_000 } },
      { type: "message" as const, key: "m6", message: { timestamp: base + 3_000 } },
      { type: "message" as const, key: "m7", message: { timestamp: base + 4_000 } },
    ];

    const collapsed = collapseRunningDisplayItems(items, 5);

    expect(collapsed[0]).toMatchObject({ type: "time", label: "20:01" });
    expect(collapsed.some((item) => item.type === "ellipsis")).toBe(false);
    expect(collapsed.at(-1)).toMatchObject({ key: "m7" });
  });

  it("injects time when the visible window has no separator", () => {
    const items = [
      { type: "message" as const, key: "m1", message: { timestamp: base } },
      { type: "message" as const, key: "m2", message: { timestamp: base + 1_000 } },
      { type: "message" as const, key: "m3", message: { timestamp: base + 2_000 } },
      { type: "message" as const, key: "m4", message: { timestamp: base + 3_000 } },
      { type: "message" as const, key: "m5", message: { timestamp: base + 4_000 } },
      { type: "message" as const, key: "m6", message: { timestamp: base + 5_000 } },
    ];

    const collapsed = collapseRunningDisplayItems(items, 3);

    expect(collapsed[0]?.type).toBe("time");
    expect(collapsed[1]).toMatchObject({ key: "m4" });
    expect(collapsed.some((item) => item.type === "ellipsis")).toBe(false);
  });
});
