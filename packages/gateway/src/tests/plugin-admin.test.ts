import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "@open-vera/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayPluginAdmin, discoverProjectPluginSources } from "../plugin-admin.js";
import { createProject } from "../project-registry.js";

const basicFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../plugin-runtime/src/tests/fixtures/basic-plugin",
);

describe("GatewayPluginAdmin", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-gateway-plugin-"));
    roots.push(root);
    return root;
  }

  function writePlugin(projectRoot: string): void {
    const pluginDir = join(projectRoot, ".vera", "plugins", "basic");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "vera-plugin.json"),
      JSON.stringify({
        id: "com.example.gateway",
        name: "Gateway Fixture",
        version: "1.0.0",
        apiVersion: "1",
        entry: "./index.mjs",
        scope: "project",
        activationEvents: ["onStartup"],
        permissions: {
          tools: ["read_file"],
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "index.mjs"),
      `export default {
        activate(ctx) {
          ctx.provide.tool({
            name: "gateway_fixture",
            description: "Gateway Fixture",
            parameters: { type: "object", properties: {} },
            metadata: { fromGatewayTest: true },
            execute: async () => ({ ok: true, content: "gateway" })
          });
        }
      };`,
    );
  }

  function writeBasicFixturePlugin(projectRoot: string): void {
    const pluginDir = join(projectRoot, ".vera", "plugins", "basic");
    mkdirSync(dirname(pluginDir), { recursive: true });
    cpSync(basicFixtureDir, pluginDir, { recursive: true });
  }

  it("discovers project plugin sources", () => {
    const root = tempProject();
    writePlugin(root);

    expect(discoverProjectPluginSources(createProject(root))).toHaveLength(1);
  });

  it("lists, enables and disables project plugins", async () => {
    const root = tempProject();
    writePlugin(root);
    const admin = new GatewayPluginAdmin({ roots: [root] });

    const [listed] = admin.list();
    expect(listed).toMatchObject({
      pluginId: "com.example.gateway",
      status: "discovered",
      disclosure: {
        sameProcessRisk: true,
        permissions: {
          tools: ["read_file"],
        },
      },
    });

    const enabled = await admin.enable({ pluginId: "com.example.gateway" });
    expect(enabled.status).toBe("activated");
    expect(enabled.capabilities[0]).toMatchObject({
      id: "gateway_fixture",
      kind: "tool",
      status: "available",
      metadata: {
        ownerPluginId: "com.example.gateway",
        fromGatewayTest: true,
      },
    });

    const disabled = await admin.disable({ pluginId: "com.example.gateway" });
    expect(disabled.status).toBe("disabled");
  });

  it("activates enabled lockfile plugins and exposes runtime capabilities", async () => {
    const root = tempProject();
    writePlugin(root);
    const firstAdmin = new GatewayPluginAdmin({ roots: [root] });
    await firstAdmin.enable({ pluginId: "com.example.gateway" });

    const freshAdmin = new GatewayPluginAdmin({ roots: [root] });
    const activated = await freshAdmin.activateEnabledPlugins();

    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({
      pluginId: "com.example.gateway",
      status: "activated",
    });
    expect(freshAdmin.listCapabilityDescriptors()).toEqual([
      expect.objectContaining({
        id: "gateway_fixture",
        kind: "tool",
        status: "available",
        metadata: expect.objectContaining({
          ownerPluginId: "com.example.gateway",
          fromGatewayTest: true,
        }),
      }),
    ]);
  });

  it("runs channel connect, test, reload, and disconnect against plugin channel capabilities", async () => {
    const root = tempProject();
    mkdirSync(join(root, ".vera"), { recursive: true });
    writeBasicFixturePlugin(root);
    const project = createProject(root);
    const eventBus = new EventBus();
    const seen: string[] = [];
    for (const eventName of [
      "channel:adapter:load",
      "channel:connect",
      "channel:disconnect",
      "channel:adapter:unload",
    ]) {
      eventBus.observe(eventName, (event) => {
        seen.push(`${event.name}:${String(event.ctx.metadata?.["instanceName"])}`);
      });
    }

    const admin = new GatewayPluginAdmin({ roots: [root], eventBus });
    await admin.enable({ pluginId: "com.example.basic" });

    const connect = await admin.runChannelAction("connect", {
      projectId: project.id,
      capabilityId: "fixture-channel",
      instanceName: "fixture-main",
    });
    const test = await admin.runChannelAction("test", {
      projectId: project.id,
      capabilityId: "fixture-channel",
      instanceName: "fixture-main",
    });
    const reload = await admin.runChannelAction("reload", {
      projectId: project.id,
      capabilityId: "fixture-channel",
      instanceName: "fixture-main",
    });
    const disconnect = await admin.runChannelAction("disconnect", {
      projectId: project.id,
      capabilityId: "fixture-channel",
      instanceName: "fixture-main",
    });

    expect(connect).toMatchObject({
      action: "connect",
      status: "ok",
      projectId: project.id,
      capabilityId: "fixture-channel",
      instanceName: "fixture-main",
      descriptor: {
        id: "fixture-channel",
        kind: "channel",
        metadata: {
          ownerPluginId: "com.example.basic",
          runtimeKind: "channel-adapter",
        },
      },
      details: {
        loaded: true,
        adapterName: "fixture-channel-adapter",
        channelType: "cli",
      },
    });
    expect(test.details).toMatchObject({ loaded: true, adapterName: "fixture-channel-adapter" });
    expect(reload.details).toMatchObject({ loaded: true, adapterName: "fixture-channel-adapter" });
    expect(disconnect.details).toMatchObject({ loaded: true, state: "disconnected" });
    expect(seen).toEqual([
      "channel:adapter:load:fixture-main",
      "channel:connect:fixture-main",
      "channel:disconnect:fixture-main",
      "channel:adapter:unload:fixture-main",
      "channel:adapter:load:fixture-main",
      "channel:disconnect:fixture-main",
    ]);
  });
});
