import { describe, expect, it, vi } from "vitest";
import { PromptStore } from "../src/prompt/index.js";
import type { ReplContext } from "../src/repl/context.js";
import type { resolveModel } from "../src/intent/classifier.js";
import { resolveTurnRouting } from "../src/repl/ui/controller/routing.js";

function ctx(overrides: Partial<ReplContext> = {}): ReplContext {
  const defaultAdapter = { name: "default" };
  return {
    cwd: "/tmp/project",
    config: { providers: {}, default_provider: "test" },
    adapter: defaultAdapter as ReplContext["adapter"],
    model: "default-model",
    tools: [],
    buildAdapter: (provider) => ({ name: provider }) as ReplContext["adapter"],
    sessionStore: {} as ReplContext["sessionStore"],
    promptStore: new PromptStore(),
    ...overrides,
  };
}

describe("routing controller", () => {
  it("returns default routing when classifier routing is disabled", async () => {
    const result = await resolveTurnRouting({ line: "hello", ctx: ctx() });

    expect(result).toMatchObject({
      model: "default-model",
      provider: "test",
      intent: null,
      failed: false,
    });
  });

  it("resolves routed provider/model and reports classifier usage", async () => {
    const resolveModelFn = vi.fn<typeof resolveModel>().mockResolvedValue({
      model: "routed-model",
      provider: "routed-provider",
      intent: {
        level: 2,
        domain: "code",
        needs_tools: true,
        needs_planning: false,
        reason: "code task",
      },
    });
    const usage: unknown[] = [];

    const result = await resolveTurnRouting({
      line: "change code",
      ctx: ctx({
        config: {
          providers: {},
          default_provider: "default-provider",
          routing: {
            enabled: true,
            classifier: { provider: "classifier-provider", model: "classifier-model" },
          },
        },
      }),
      onClassifierUsage: (event) => usage.push(event),
      resolveModelFn,
    });

    expect(resolveModelFn).toHaveBeenCalledWith(
      "change code",
      { name: "classifier-provider" },
      "classifier-model",
      expect.objectContaining({ enabled: true }),
      "default-provider",
      "default-model",
      expect.any(Function),
    );
    const onUsage = resolveModelFn.mock.calls[0]?.[6];
    onUsage?.({ input_tokens: 1, output_tokens: 2 });
    expect(usage).toEqual([{ usage: { input_tokens: 1, output_tokens: 2 }, model: "classifier-model", provider: "classifier-provider" }]);
    expect(result).toMatchObject({
      model: "routed-model",
      provider: "routed-provider",
      failed: false,
      uiRouting: { provider: "routed-provider", model: "routed-model" },
    });
  });

  it("skips classifier when every route points to the default target", async () => {
    const resolveModelFn = vi.fn<typeof resolveModel>();

    const result = await resolveTurnRouting({
      line: "change code",
      ctx: ctx({
        config: {
          providers: {},
          default_provider: "mimo",
          routing: {
            enabled: true,
            classifier: { provider: "mimo", model: "mimo-v2.5-pro" },
            l0: { provider: "mimo", model: "mimo-v2.5-pro" },
            l1: { provider: "mimo", model: "mimo-v2.5-pro" },
            l2: { provider: "mimo", model: "mimo-v2.5-pro" },
            l3: { provider: "mimo", model: "mimo-v2.5-pro" },
          },
        },
        model: "mimo-v2.5-pro",
      }),
      resolveModelFn,
    });

    expect(resolveModelFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      model: "mimo-v2.5-pro",
      provider: "mimo",
      intent: null,
      failed: false,
      uiRouting: { provider: "mimo", model: "mimo-v2.5-pro", intent: null },
    });
  });

  it("falls back to default route when classifier fails", async () => {
    const result = await resolveTurnRouting({
      line: "change code",
      ctx: ctx({
        config: { providers: {}, default_provider: "default-provider", routing: { enabled: true } },
      }),
      resolveModelFn: vi.fn<typeof resolveModel>().mockRejectedValue(new Error("classifier failed")),
    });

    expect(result).toMatchObject({
      model: "default-model",
      provider: "default-provider",
      intent: null,
      failed: false,
      uiRouting: { provider: "default-provider", model: "default-model", intent: null },
    });
    expect(result.error).toBeInstanceOf(Error);
  });
});
