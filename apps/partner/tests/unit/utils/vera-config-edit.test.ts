import { describe, expect, it } from "vitest";
import {
  applyModelsRouting,
  renameProviderInConfig,
  readModelsRouting,
  removeModelAlias,
  upsertModelAlias,
} from "@/utils/vera-config-edit";

describe("vera-config-edit", () => {
  it("renames provider and rewrites model / default / object routing refs", () => {
    const next = renameProviderInConfig(
      {
        providers: {
          old: { adapter: "anthropic", api_key: "sk" },
          other: { adapter: "openai" },
        },
        models: {
          flash: { provider: "old", model: "deepseek-v4-flash" },
          keep: { provider: "other", model: "gpt-4.1" },
        },
        default_provider: "old",
        default_model: "flash",
        routing: {
          enabled: true,
          classifier: "flash",
          l1: { provider: "old", model: "deepseek-v4-flash" },
        },
        session: {
          compact: { enabled: true, provider: "old", model: "deepseek-v4-flash" },
        },
      },
      "old",
      "company",
    );

    expect(next.providers).toEqual({
      company: { adapter: "anthropic", api_key: "sk" },
      other: { adapter: "openai" },
    });
    expect(next.models).toEqual({
      flash: { provider: "company", model: "deepseek-v4-flash" },
      keep: { provider: "other", model: "gpt-4.1" },
    });
    expect(next.default_provider).toBe("company");
    expect(next.routing).toMatchObject({
      enabled: true,
      classifier: "flash",
      l1: { provider: "company", model: "deepseek-v4-flash" },
    });
    expect(next.session).toMatchObject({
      compact: { provider: "company", model: "deepseek-v4-flash" },
    });
  });

  it("rejects invalid or conflicting rename", () => {
    expect(() =>
      renameProviderInConfig({ providers: { a: {} } }, "a", "bad/id"),
    ).toThrow(/Invalid provider id/);
    expect(() =>
      renameProviderInConfig({ providers: { a: {}, b: {} } }, "a", "b"),
    ).toThrow(/already exists/);
  });

  it("applies models + routing snapshot", () => {
    const next = applyModelsRouting(
      { providers: { anthropic: { adapter: "anthropic" } } },
      {
        models: [
          { alias: "haiku", provider: "anthropic", model: "claude-haiku-4-5" },
          { alias: "sonnet", provider: "anthropic" },
        ],
        defaultProvider: "anthropic",
        defaultModel: "sonnet",
        routing: {
          enabled: true,
          classifier: "haiku",
          l0: "haiku",
          l1: "sonnet",
          l2: "sonnet",
        },
      },
    );

    expect(next.models).toEqual({
      haiku: { provider: "anthropic", model: "claude-haiku-4-5" },
      sonnet: { provider: "anthropic" },
    });
    expect(next.default_model).toBe("sonnet");
    expect(next.routing).toEqual({
      enabled: true,
      classifier: "haiku",
      l0: "haiku",
      l1: "sonnet",
      l2: "sonnet",
    });
  });

  it("upserts and removes aliases while clearing routing refs", () => {
    let config: Record<string, unknown> = {
      models: { a: { provider: "p" } },
      default_model: "a",
      routing: { enabled: true, l1: "a" },
    };
    config = upsertModelAlias(config, "b", "p", "upstream-b");
    expect(readModelsRouting(config).models).toEqual([
      { alias: "a", provider: "p", model: undefined },
      { alias: "b", provider: "p", model: "upstream-b" },
    ]);
    config = removeModelAlias(config, "a");
    const snapshot = readModelsRouting(config);
    expect(snapshot.models).toEqual([{ alias: "b", provider: "p", model: "upstream-b" }]);
    expect(snapshot.defaultModel).toBeUndefined();
    expect(snapshot.routing.l1).toBeUndefined();
  });
});
