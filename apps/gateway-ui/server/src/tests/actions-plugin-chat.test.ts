import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, GatewayPluginAdmin } from "@open-vera/gateway";
import { EventBus } from "@open-vera/plugin-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConversations } from "../conversation-store.js";
import { runExecutionAction } from "../actions.js";

describe("runExecutionAction chat.send plugin runtime", () => {
  const roots: string[] = [];

  beforeEach(() => {
    resetConversations();
  });

  afterEach(() => {
    resetConversations();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-action-chat-"));
    roots.push(root);
    mkdirSync(join(root, ".vera"), { recursive: true });
    return root;
  }

  function writePlugin(projectRoot: string): void {
    const pluginDir = join(projectRoot, ".vera", "plugins", "chat-action-llm");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(projectRoot, ".vera", "settings.json"),
      JSON.stringify({
        default_provider: "gateway-action-llm",
        default_model: "fixture-chat",
        providers: {
          "gateway-action-llm": {
            adapter: "gateway-action-llm",
          },
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "vera-plugin.json"),
      JSON.stringify({
        id: "com.example.gateway-action-chat",
        name: "Gateway Action Chat LLM",
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
            system: String(event.value.system ?? "") + "\\naction-plugin-hook"
          }));
          ctx.provide.llmAdapter("gateway-action-llm", () => ({
            complete: async (request) => ({
              message: { role: "assistant", content: String(request.system ?? "missing") },
              stop_reason: "end_turn"
            }),
            stream: async function* (request) {
              yield { type: "text", text: String(request.system ?? "missing") };
              yield { type: "done", stop_reason: "end_turn" };
            }
          }));
        }
      };`,
    );
  }

  it("shares GatewayPluginAdmin capabilities and EventBus with chat.send", async () => {
    const root = tempProject();
    writePlugin(root);
    const project = createProject(root);
    const eventBus = new EventBus();
    const pluginAdmin = new GatewayPluginAdmin({ roots: [root], eventBus });
    await pluginAdmin.enable({ pluginId: "com.example.gateway-action-chat" });

    const result = await runExecutionAction("chat.send", {
      projectId: project.id,
      payload: { message: "hello" },
    }, {
      projects: [project],
      pluginAdmin,
      eventBus,
    });

    expect(result.status).toBe("accepted");
    expect(result.data?.["mode"]).toBe("llm");
    expect(result.data?.["text"]).toContain("action-plugin-hook");
  });
});
