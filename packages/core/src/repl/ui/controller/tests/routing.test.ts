import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "../../../../adapters/base.js";
import type { ReplContext } from "../../../context.js";
import {
  clearClassifierFailureCircuit,
  resolveTurnRouting,
} from "../routing.js";

function createAdapter(): LLMAdapter {
  return {
    complete: vi.fn() as unknown as LLMAdapter["complete"],
    stream: vi.fn() as unknown as LLMAdapter["stream"],
  };
}

function createContext(): ReplContext {
  const adapter = createAdapter();
  return {
    cwd: "/tmp/project",
    config: {
      default_provider: "anthropic",
      routing: {
        enabled: true,
        classifier: { provider: "classifier", model: "classifier-model" },
        l0: { provider: "anthropic", model: "claude-haiku-4-5" },
        l1: { provider: "anthropic", model: "claude-haiku-4-5" },
        l2: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    },
    adapter,
    model: "claude-haiku-4-5",
    tools: [],
    buildAdapter: vi.fn(() => createAdapter()),
    sessionStore: {} as ReplContext["sessionStore"],
    promptStore: {} as ReplContext["promptStore"],
  };
}

describe("resolveTurnRouting", () => {
  beforeEach(() => {
    clearClassifierFailureCircuit();
    vi.clearAllMocks();
  });

  it("short-circuits repeated classifier failures for the same provider and model", async () => {
    const ctx = createContext();
    const resolveModelFn = vi.fn().mockRejectedValue(new Error("quota exhausted"));
    const onRoutingStart = vi.fn();

    const first = await resolveTurnRouting({
      line: "inspect workspace",
      ctx,
      onRoutingStart,
      resolveModelFn,
    });
    expect(first.model).toBe("claude-haiku-4-5");
    expect(first.error).toBeInstanceOf(Error);

    const second = await resolveTurnRouting({
      line: "inspect workspace again",
      ctx,
      onRoutingStart,
      resolveModelFn,
    });

    expect(second.failed).toBe(true);
    expect(second.model).toBe("claude-haiku-4-5");
    expect(resolveModelFn).toHaveBeenCalledTimes(1);
    expect(onRoutingStart).toHaveBeenCalledTimes(1);
  });
});
