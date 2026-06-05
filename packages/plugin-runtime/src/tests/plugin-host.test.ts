import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../event-bus.js";
import { PluginHost } from "../plugin-host.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "basic-plugin");

describe("PluginHost", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    delete (globalThis as { __veraFixtureDisposed?: number }).__veraFixtureDisposed;
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-runtime-"));
    roots.push(root);
    return root;
  }

  it("discovers, enables, activates and deactivates a fixture plugin", async () => {
    const rootDir = tempRoot();
    const host = new PluginHost({ rootDir });

    const discovered = host.discover({ type: "local", path: fixtureDir });
    expect(discovered.status).toBe("discovered");
    expect(discovered.disclosure).toMatchObject({
      pluginId: "com.example.basic",
      sameProcessRisk: true,
      permissions: {
        tools: ["read_file"],
      },
    });

    const lockRecord = host.enable("com.example.basic");
    expect(lockRecord.enabled).toBe(true);
    expect(lockRecord.checksum).toMatch(/^sha256:/);

    const activated = await host.activate("com.example.basic");
    expect(activated.status).toBe("activated");
    expect(host.capabilities.get("fixture_echo")?.ownerPluginId).toBe("com.example.basic");
    const descriptors = host.capabilities.listDescriptors();
    expect(descriptors.find((descriptor) => descriptor.id === "fixture_echo")).toMatchObject({
      id: "fixture_echo",
      kind: "tool",
      metadata: {
        ownerPluginId: "com.example.basic",
        description: "Fixture Echo",
        parameters: {
          type: "object",
        },
        fixture: true,
      },
    });
    expect(descriptors.find((descriptor) => descriptor.id === "fixture-llm")).toMatchObject({
      id: "fixture-llm",
      kind: "provider",
      metadata: {
        ownerPluginId: "com.example.basic",
        runtimeKind: "llm-adapter",
        supportedPurposes: ["chat", "tool"],
        supportedModalities: ["text"],
      },
    });
    expect(descriptors.find((descriptor) => descriptor.id === "fixture-provider")).toMatchObject({
      id: "fixture-provider",
      kind: "provider",
      metadata: {
        ownerPluginId: "com.example.basic",
        runtimeKind: "model-provider",
        models: ["fixture-small"],
        defaultModel: "fixture-small",
      },
    });
    expect(descriptors.find((descriptor) => descriptor.id === "fixture-channel")).toMatchObject({
      id: "fixture-channel",
      kind: "channel",
      metadata: {
        ownerPluginId: "com.example.basic",
        runtimeKind: "channel-adapter",
        channelType: "cli",
        description: "Fixture channel adapter",
        version: "1.0.0",
      },
    });
    expect(descriptors.find((descriptor) => descriptor.id === "fixture-prompt-block")).toMatchObject({
      id: "fixture-prompt-block",
      kind: "prompt",
      metadata: {
        ownerPluginId: "com.example.basic",
        contentLength: "Fixture prompt contribution".length,
      },
    });
    expect(descriptors.find((descriptor) => descriptor.id === "fixture-context-provider")).toMatchObject({
      id: "fixture-context-provider",
      kind: "context",
      metadata: {
        ownerPluginId: "com.example.basic",
        tokenEstimate: 4,
      },
    });
    expect(JSON.stringify(descriptors)).not.toContain("complete");
    expect(JSON.stringify(descriptors)).not.toContain("execute");

    const transformed = await host.eventBus.emitTransform(
      "tool:after:fixture_echo",
      { ok: true },
      { pluginId: "host" },
    );
    expect(transformed).toEqual({ ok: true, transformedBy: "com.example.basic" });

    const deactivated = await host.deactivate("com.example.basic");
    expect(deactivated.status).toBe("deactivated");
    expect(host.capabilities.get("fixture_echo")).toBeUndefined();
    expect(host.eventBus.list()).toHaveLength(0);
    expect((globalThis as { __veraFixtureDisposed?: number }).__veraFixtureDisposed).toBe(1);
  });

  it("replays enabled plugin state from lockfile", async () => {
    const rootDir = tempRoot();
    const firstHost = new PluginHost({ rootDir });
    firstHost.discover({ type: "local", path: fixtureDir });
    firstHost.enable("com.example.basic");

    const secondHost = new PluginHost({ rootDir });
    const activated = await secondHost.activateEnabledFromLockfile();

    expect(activated.map((state) => state.status)).toEqual(["activated"]);
    expect(secondHost.capabilities.get("fixture_echo")?.status).toBe("available");
  });

  it("marks activation failures as plugin error without crashing the host", async () => {
    const rootDir = tempRoot();
    const eventBus = new EventBus();
    const host = new PluginHost({
      rootDir,
      eventBus,
      loader: {
        discover: () => ({
          manifest: {
            id: "com.example.bad",
            name: "Bad",
            version: "1.0.0",
            apiVersion: "1",
            entry: "./bad.js",
            scope: "project",
            activationEvents: ["onStartup"],
          },
          manifestPath: "/bad/vera-plugin.json",
          rootDir: "/bad",
          source: { type: "local", path: "/bad" },
          checksum: "sha256:bad",
        }),
        load: async () => ({
          activate: async () => {
            throw new Error("boom");
          },
        }),
      },
    });

    host.discover({ type: "local", path: "/bad" });
    host.enable("com.example.bad");
    const state = await host.activate("com.example.bad");

    expect(state.status).toBe("error");
    expect(state.lastError).toBe("boom");
    expect(host.list()).toHaveLength(1);
    expect(eventBus.list()).toHaveLength(0);
  });
});
