import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  scanPathCandidates,
  schedulePathCandidateRefresh,
} from "../src/repl/ui/controller/pathCompletion.js";

describe("pathCompletion", () => {
  it("scans bounded path candidates and ignores heavy directories", () => {
    const root = join(tmpdir(), `vera-path-completion-${Date.now()}`);
    mkdirSync(join(root, "src", "repl"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "repl", "App.tsx"), "");
    writeFileSync(join(root, "src", "index.ts"), "");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");

    const candidates = scanPathCandidates({ cwd: root, maxDepth: 3, maxEntries: 100 });

    expect(candidates).toContain("./src/");
    expect(candidates).toContain("./src/repl/");
    expect(candidates).toContain("./src/repl/App.tsx");
    expect(candidates).toContain("src/index.ts");
    expect(candidates.some((candidate) => candidate.includes("node_modules"))).toBe(false);
  });

  it("schedules path candidate refresh outside the immediate render path", () => {
    const scheduled: Array<() => void> = [];
    let cancelledHandle: number | null = null;
    const updates: string[][] = [];

    const refresh = schedulePathCandidateRefresh({
      cwd: "/tmp/project",
      scan: () => ["./src/"],
      setCandidates: (candidates) => updates.push(candidates),
      schedule: (fn) => {
        scheduled.push(fn);
        return 1 as ReturnType<typeof setTimeout>;
      },
      cancelSchedule: (handle) => { cancelledHandle = Number(handle); },
    });

    expect(updates).toEqual([]);
    scheduled[0]?.();
    expect(updates).toEqual([["./src/"]]);
    refresh.cancel();
    expect(cancelledHandle).toBe(1);
  });

  it("does not publish scheduled path candidates after cancellation", () => {
    const scheduled: Array<() => void> = [];
    const updates: string[][] = [];

    const refresh = schedulePathCandidateRefresh({
      cwd: "/tmp/project",
      scan: () => ["./src/"],
      setCandidates: (candidates) => updates.push(candidates),
      schedule: (fn) => {
        scheduled.push(fn);
        return 1 as ReturnType<typeof setTimeout>;
      },
      cancelSchedule: () => {},
    });

    refresh.cancel();
    scheduled[0]?.();
    expect(updates).toEqual([]);
  });
});
