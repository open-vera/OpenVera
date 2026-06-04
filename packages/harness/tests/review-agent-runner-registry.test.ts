/**
 * Tests for review findings — Bug #4: AgentRunnerRegistry.findByCapabilities()
 * with empty filter returning too narrow results.
 *
 * Fix: empty filter (no required capabilities) now matches ALL runners,
 * including those with no caps declared. This makes findByCapabilities({})
 * behave as "return everything" rather than "return nothing".
 */
import { describe, it, expect } from "vitest";
import type { AgentRunner, AgentRunnerCapabilities } from "../src/agent/types.js";
import { AgentRunnerRegistry } from "../src/agent/types.js";
import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions } from "../src/runtime/internal.js";

function makeRunner(opts: {
  caps?: AgentRunnerCapabilities;
  name?: string;
} = {}): AgentRunner {
  return {
    name: opts.name,
    capabilities: opts.caps,
    run: async (_a: AgentAssignment, _o: RunAssignmentOptions): Promise<StepResult> => ({
      flowId: "f1",
      stepId: "s1",
      output: "done",
      toolCalls: [],
    }),
  };
}

describe("AgentRunnerRegistry — findByCapabilities fix", () => {
  it("empty filter should match ALL runners (including those with no caps)", () => {
    const registry = new AgentRunnerRegistry();
    const r1 = makeRunner({ name: "r1", caps: { supportsTools: true } });
    const r2 = makeRunner({ name: "r2", caps: {} });
    const r3 = makeRunner({ name: "r3" }); // no caps declared

    registry.register("r1", r1);
    registry.register("r2", r2);
    registry.register("r3", r3);

    // Empty filter → everything matches
    const results = registry.findByCapabilities({});
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name)).toEqual(["r1", "r2", "r3"]);
  });

  it("empty filter should match runners even when none have any capabilities", () => {
    const registry = new AgentRunnerRegistry();
    registry.register("plain-1", makeRunner({ name: "plain-1" }));
    registry.register("plain-2", makeRunner({ name: "plain-2" }));

    const results = registry.findByCapabilities({});
    expect(results).toHaveLength(2);
  });

  it("should NOT match runners missing a required capability", () => {
    const registry = new AgentRunnerRegistry();
    registry.register("capable", makeRunner({ name: "capable", caps: { supportsTools: true } }));
    registry.register("not-capable", makeRunner({ name: "not-capable", caps: {} }));
    registry.register("no-caps", makeRunner({ name: "no-caps" }));

    const results = registry.findByCapabilities({ supportsTools: true });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("capable");
  });

  it("should match by tags (all required tags must be present)", () => {
    const registry = new AgentRunnerRegistry();
    registry.register("coding", makeRunner({ name: "coding", caps: { tags: ["coding", "search"] } }));
    registry.register("general", makeRunner({ name: "general", caps: { tags: ["general"] } }));
    registry.register("no-tags", makeRunner({ name: "no-tags", caps: {} }));

    const results = registry.findByCapabilities({ tags: ["coding"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("coding");
  });

  it("should match by maxContextTokens threshold", () => {
    const registry = new AgentRunnerRegistry();
    registry.register("big", makeRunner({ name: "big", caps: { maxContextTokens: 100_000 } }));
    registry.register("small", makeRunner({ name: "small", caps: { maxContextTokens: 4_000 } }));

    const results = registry.findByCapabilities({ maxContextTokens: 50_000 });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("big");
  });

  it("should NOT match runner with insufficient maxContextTokens", () => {
    const registry = new AgentRunnerRegistry();
    registry.register("small", makeRunner({ name: "small", caps: { maxContextTokens: 4_000 } }));

    const results = registry.findByCapabilities({ maxContextTokens: 50_000 });
    expect(results).toHaveLength(0);
  });

  it("should combine multiple requirements (AND logic)", () => {
    const registry = new AgentRunnerRegistry();
    registry.register("a", makeRunner({ name: "a", caps: { supportsTools: true, longRunning: true } }));
    registry.register("b", makeRunner({ name: "b", caps: { supportsTools: true } })); // missing longRunning
    registry.register("c", makeRunner({ name: "c", caps: { longRunning: true } })); // missing supportsTools

    const results = registry.findByCapabilities({ supportsTools: true, longRunning: true });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("a");
  });

  it("should treat empty tags requirement as satisfied by any runner", () => {
    // This is actually already handled: if required.tags is empty array or undefined,
    // the tags check passes
    const registry = new AgentRunnerRegistry();
    registry.register("any", makeRunner({ name: "any", caps: { tags: [] } }));

    const results = registry.findByCapabilities({});
    expect(results).toHaveLength(1);
  });
});