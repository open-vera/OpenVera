import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, GatewayPluginAdmin } from "@open-vera/gateway";
import { EventBus } from "@open-vera/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { runManagementAction } from "../actions.js";

const basicFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/plugin-runtime/src/tests/fixtures/basic-plugin",
);

describe("runManagementAction channel actions", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-action-channel-"));
    roots.push(root);
    mkdirSync(join(root, ".vera", "plugins"), { recursive: true });
    cpSync(basicFixtureDir, join(root, ".vera", "plugins", "basic"), { recursive: true });
    return root;
  }

  it("executes channel management through GatewayPluginAdmin", async () => {
    const root = tempProject();
    const project = createProject(root);
    const eventBus = new EventBus();
    const pluginAdmin = new GatewayPluginAdmin({ roots: [root], eventBus });
    await pluginAdmin.enable({ pluginId: "com.example.basic" });

    const result = await runManagementAction("channel.connect", {
      projectId: project.id,
      target: "fixture-channel",
      payload: { instanceName: "fixture-main" },
    }, {
      projects: [project],
      pluginAdmin,
      eventBus,
    });

    expect(result.status).toBe("accepted");
    expect(result.message).toBe("Channel connect completed: fixture-main");
    expect(result.data).toMatchObject({
      action: "connect",
      projectId: project.id,
      capabilityId: "fixture-channel",
      instanceName: "fixture-main",
      details: {
        loaded: true,
        adapterName: "fixture-channel-adapter",
        channelType: "cli",
      },
    });
  });
});
