import { describe, expect, it } from "vitest";
import { buildBranchCompareSessions, matchesSession, parseSearchFilter } from "../src/repl/ui/SessionPicker.js";
import type { SessionSummary } from "../src/session/index.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "abc123",
    filePath: "/tmp/abc123.jsonl",
    startedAt: new Date("2026-04-01T00:00:00Z"),
    lastActivityAt: new Date("2026-04-20T00:00:00Z"),
    model: "gpt-4",
    provider: "openai",
    turnCount: 3,
    totalUsage: { input_tokens: 10, output_tokens: 20 },
    totalCostUsd: 0.42,
    cwd: "/tmp/project",
    summary: "Fix flaky session picker",
    gitBranch: "feature/session-ux",
    tag: "p0",
    ...overrides,
  };
}

describe("SessionPicker search helpers", () => {
  it("parses text and structured filters", () => {
    const filter = parseSearchFilter("flaky branch:session tag:p0 cost>0.1 cost<1 after:2026-04-01 before:2026-05-01");

    expect(filter.text).toEqual(["flaky"]);
    expect(filter.branch).toBe("session");
    expect(filter.tag).toBe("p0");
    expect(filter.costGt).toBe(0.1);
    expect(filter.costLt).toBe(1);
    expect(filter.after?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(filter.before?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("matches sessions by text, branch, tag, cost, and date", () => {
    const filter = parseSearchFilter("picker branch:session tag:p0 cost>0.1 cost<1 after:2026-04-01 before:2026-05-01");

    expect(matchesSession(summary(), filter)).toBe(true);
    expect(matchesSession(summary({ gitBranch: "main" }), filter)).toBe(false);
    expect(matchesSession(summary({ totalCostUsd: 1.5 }), filter)).toBe(false);
    expect(matchesSession(summary({ lastActivityAt: new Date("2026-06-01T00:00:00Z") }), filter)).toBe(false);
  });

  it("builds branch-compare sessions and includes selected root session when missing", () => {
    const selected = summary({
      sessionId: "root001",
      lastActivityAt: new Date("2026-04-20T00:00:00Z"),
      branch: undefined,
    });
    const branchA = summary({
      sessionId: "brA111",
      lastActivityAt: new Date("2026-04-21T00:00:00Z"),
      branch: { parentSessionId: "root001", status: "active" },
    });
    const branchB = summary({
      sessionId: "brB222",
      lastActivityAt: new Date("2026-04-19T00:00:00Z"),
      branch: { parentSessionId: "root001", status: "merged" },
    });

    const result = buildBranchCompareSessions(selected, [branchB, branchA]);
    expect(result.map((s) => s.sessionId)).toEqual(["brA111", "root001", "brB222"]);
  });

  it("builds branch-compare sessions for selected branch without duplicating selected", () => {
    const selectedBranch = summary({
      sessionId: "brA111",
      lastActivityAt: new Date("2026-04-21T00:00:00Z"),
      branch: { parentSessionId: "root001", status: "active" },
    });
    const branchB = summary({
      sessionId: "brB222",
      lastActivityAt: new Date("2026-04-19T00:00:00Z"),
      branch: { parentSessionId: "root001", status: "merged" },
    });

    const result = buildBranchCompareSessions(selectedBranch, [selectedBranch, branchB]);
    expect(result.map((s) => s.sessionId)).toEqual(["brA111", "brB222"]);
  });
});
