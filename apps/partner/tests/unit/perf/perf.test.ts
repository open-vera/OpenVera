import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPerfLogPath,
  classifyFrameGap,
  getRecentPerfEvents,
  measureAsync,
  measureSync,
  recordPerfEvent,
  resetPerfRecorderForTests,
  setPerfLogRoot,
} from "@/perf";

vi.mock("@/bridge", () => ({
  appendFile: vi.fn(async () => undefined),
}));

describe("partner perf instrumentation", () => {
  afterEach(() => {
    resetPerfRecorderForTests();
  });

  it("classifies frame gaps into dropped_frame / freeze", () => {
    expect(classifyFrameGap(16)).toBe("ok");
    expect(classifyFrameGap(40)).toBe("dropped_frame");
    expect(classifyFrameGap(600)).toBe("freeze");
  });

  it("records events into the ring buffer", () => {
    recordPerfEvent({
      kind: "freeze",
      severity: "error",
      durationMs: 900,
      name: "main_thread_freeze",
    });
    const recent = getRecentPerfEvents(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.kind).toBe("freeze");
  });

  it("measureSync records slow work", () => {
    measureSync("heavy", () => {
      const end = performance.now() + 5;
      while (performance.now() < end) {
        // spin a few ms
      }
    }, { warnMs: 1, errorMs: 1_000, recordOnlySlow: true });
    expect(getRecentPerfEvents().some((item) => item.name === "heavy")).toBe(true);
  });

  it("measureAsync records timeout", async () => {
    await expect(
      measureAsync(
        "stuck",
        () => new Promise(() => undefined),
        { timeoutMs: 20, warnMs: 1, errorMs: 10 },
      ),
    ).rejects.toThrow(/Timed out/);
    expect(getRecentPerfEvents().some((item) => item.kind === "timeout")).toBe(true);
  });

  it("builds perf log path under .vera/partner-perf", () => {
    setPerfLogRoot("/repo");
    expect(buildPerfLogPath("/repo", new Date("2026-07-25T00:00:00.000Z"))).toBe(
      "/repo/.vera/partner-perf/2026-07-25.jsonl",
    );
  });
});
