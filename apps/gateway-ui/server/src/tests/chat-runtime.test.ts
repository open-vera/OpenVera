import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@open-vera/plugin-runtime";
import { GatewayPluginAdmin } from "@open-vera/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { runChatCompletion } from "../chat-runtime.js";

describe("runChatCompletion", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-chat-"));
    roots.push(root);
    mkdirSync(join(root, ".vera"), { recursive: true });
    return root;
  }

  function writePlugin(projectRoot: string): void {
    const pluginDir = join(projectRoot, ".vera", "plugins", "chat-llm");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(projectRoot, ".vera", "settings.json"),
      JSON.stringify({
        default_provider: "gateway-plugin-llm",
        default_model: "fixture-chat",
        providers: {
          "gateway-plugin-llm": {
            adapter: "gateway-plugin-llm",
          },
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "vera-plugin.json"),
      JSON.stringify({
        id: "com.example.gateway-chat",
        name: "Gateway Chat LLM",
        version: "1.0.0",
        apiVersion: "1",
        entry: "./index.mjs",
        scope: "project",
        activationEvents: ["onStartup"],
      }),
    );
    writeFileSync(
      join(pluginDir, "index.mjs"),
      `export default {
        activate(ctx) {
          ctx.hooks.transform("llm:request", (event) => ({
            ...event.value,
            system: String(event.value.system ?? "") + "\\nplugin-hook"
          }));
          ctx.provide.llmAdapter("gateway-plugin-llm", () => ({
            complete: async (request) => ({
              message: { role: "assistant", content: String(request.system ?? "missing") },
              stop_reason: "end_turn"
            }),
            stream: async function* (request) {
              yield { type: "text", text: String(request.system ?? "missing") };
              yield { type: "done", stop_reason: "end_turn" };
            }
          }), { supportedPurposes: ["chat"], supportedModalities: ["text"] });
        }
      };`,
    );
  }

  it("uses project plugin capabilities and hooks from the same Gateway admin lifecycle", async () => {
    const root = tempProject();
    writePlugin(root);
    const eventBus = new EventBus();
    const admin = new GatewayPluginAdmin({ roots: [root], eventBus });
    await admin.enable({ pluginId: "com.example.gateway-chat" });
    await admin.activateEnabledPlugins();

    const result = await runChatCompletion(root, "hello", [], {
      capabilities: admin.getProjectCapabilities(root),
      eventBus,
      sessionId: "conversation-1",
      traceId: "message-1",
    });

    expect(result.mode).toBe("llm");
    expect(result.text).toContain("You are the Vera Gateway assistant");
    expect(result.text).toContain("plugin-hook");
  });
});
