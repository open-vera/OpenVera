import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectEffectiveLlmConfig } from "../../../sidecar/src/agent-run.js";

describe("inspectEffectiveLlmConfig models/routing", () => {
  it("returns models aliases and routing from project settings", () => {
    const root = mkdtempSync(join(tmpdir(), "partner-vera-"));
    mkdirSync(join(root, ".vera"), { recursive: true });
    writeFileSync(
      join(root, ".vera/settings.json"),
      JSON.stringify({
        providers: {
          anthropic: { adapter: "anthropic", api_key: "k" },
        },
        models: {
          haiku: { provider: "anthropic", model: "claude-haiku-4-5" },
          sonnet: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
        default_provider: "anthropic",
        default_model: "sonnet",
        routing: {
          enabled: true,
          classifier: "haiku",
          l0: "haiku",
          l1: "sonnet",
          l2: "sonnet",
        },
      }),
      "utf-8",
    );

    const result = inspectEffectiveLlmConfig(root);
    expect(result.defaultModel).toBe("sonnet");
    expect(result.routing).toMatchObject({
      enabled: true,
      classifier: "haiku",
      l1: "sonnet",
    });
    expect(result.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: "haiku", provider: "anthropic" }),
        expect.objectContaining({ alias: "sonnet", provider: "anthropic" }),
      ]),
    );
  });
});
