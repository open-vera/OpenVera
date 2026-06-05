import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, PluginHost, RuntimeCapabilityRegistry } from "@open-vera/plugin-runtime";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { createToolRegistry, ToolHost, ToolRegistry, type ToolContext, type ToolResult } from "../src/tools/index.js";
import type { StorageProvider, StorageQuery, StorageQueryResult, StorageTransaction, StorageValue } from "../src/storage/types.js";
import { UserDataStore } from "../src/storage/user-data.js";
import { SessionStore } from "../src/session/index.js";

function context(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "tool-host-test",
  };
}

function ok(content: string, metadata?: ToolResult["metadata"]): ToolResult {
  return {
    ok: true,
    content,
    ...(metadata ? { metadata } : {}),
  };
}

describe("ToolHost", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-tool-host-"));
    tempRoots.push(root);
    return root;
  }

  function withTempVeraHome<T>(fn: () => T): T {
    const previous = process.env.VERA_HOME;
    const root = tempProject();
    process.env.VERA_HOME = root;
    try {
      return fn();
    } finally {
      if (previous === undefined) {
        delete process.env.VERA_HOME;
      } else {
        process.env.VERA_HOME = previous;
      }
    }
  }

  it("adopts existing ToolRegistry tools as runtime capabilities", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "legacy_echo",
      description: "Echo input",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (args) => ok(String(args["text"] ?? "")),
    });

    const host = new ToolHost({ registry });

    expect(host.getSchemas().map((schema) => schema.name)).toEqual(["legacy_echo"]);
    expect(host.capabilities.get("legacy_echo")).toMatchObject({
      id: "legacy_echo",
      kind: "tool",
      ownerPluginId: "builtin-tools",
    });
    expect(JSON.stringify(host.capabilities.listDescriptors()[0])).not.toContain("factory");
  });

  it("executes through EventBus before hooks, legacy middleware, and EventBus after transforms in order", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registry.register({
      name: "ordered_tool",
      description: "Order test",
      parameters: { type: "object", properties: {} },
      execute: async (args) => {
        events.push(`execute:${String(args["value"])}`);
        return ok(String(args["value"]));
      },
    });
    registry.addMiddleware({
      name: "legacy-before-after",
      before: async (_name, args) => {
        events.push(`legacy-before:${String(args["value"])}`);
        return { args: { ...args, value: `${String(args["value"])}:legacy` } };
      },
      after: async (_name, _args, result) => {
        events.push(`legacy-after:${result.content}`);
        return { ...result, content: `${result.content}:after` };
      },
    });

    const eventBus = new EventBus();
    eventBus.intercept("tool:before:ordered_tool", (event) => {
      events.push(`event-before:${String(event.value.args["value"])}`);
      return {
        handled: false,
        value: {
          ...event.value,
          args: { ...event.value.args, value: `${String(event.value.args["value"])}:event` },
        },
      };
    });
    eventBus.transform<ToolResult>("tool:after:ordered_tool", (event) => {
      events.push(`event-after:${event.value.content}`);
      return { ...event.value, content: `${event.value.content}:event-after` };
    });

    const host = new ToolHost({ registry, eventBus });
    const result = await host.execute("ordered_tool", { value: "start" }, context());

    expect(result.content).toBe("start:event:legacy:after:event-after");
    expect(events).toEqual([
      "event-before:start",
      "legacy-before:start:event",
      "execute:start:event:legacy",
      "legacy-after:start:event:legacy",
      "event-after:start:event:legacy:after",
    ]);
  });

  it("registers and executes third-party runtime tool capabilities", async () => {
    const host = new ToolHost({ adoptRegistryTools: false });
    host.registerCapability({
      name: "plugin_echo",
      description: "Plugin echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      ownerPluginId: "com.example.plugin",
      scope: "project",
      metadata: { contributed: true },
      execute: async (args) => ok(`plugin:${String(args["text"] ?? "")}`),
    });

    const result = await host.execute("plugin_echo", { text: "hello" }, context());

    expect(result.content).toBe("plugin:hello");
    expect(host.capabilities.get("plugin_echo")).toMatchObject({
      ownerPluginId: "com.example.plugin",
      scope: "project",
    });
  });

  it("rejects same-name third-party tools unless override is explicit", async () => {
    const host = new ToolHost({ adoptRegistryTools: false });
    host.registerCapability({
      name: "same_name",
      description: "Builtin-like tool",
      parameters: { type: "object", properties: {} },
      ownerPluginId: "builtin-tools-test",
      source: "builtin:tool-plugin/builtin-tools-test",
      execute: async () => ok("builtin"),
    });

    expect(() => host.registerCapability({
      name: "same_name",
      description: "Rejected plugin tool",
      parameters: { type: "object", properties: {} },
      ownerPluginId: "com.example.plugin",
      scope: "project",
      source: "plugin:com.example.plugin",
      execute: async () => ok("plugin"),
    })).toThrow("Capability conflict");

    await expect(host.execute("same_name", {}, context()))
      .resolves.toMatchObject({ ok: true, content: "builtin" });
    expect(host.capabilities.getConflicts()).toHaveLength(1);
    expect(host.capabilities.getConflicts()[0]).toMatchObject({
      resolution: "rejected",
      existing: { ownerPluginId: "builtin-tools-test" },
      requested: { ownerPluginId: "com.example.plugin" },
    });
  });

  it("allows explicit same-name tool override and keeps the conflict auditable", async () => {
    const host = new ToolHost({ adoptRegistryTools: false });
    host.registerCapability({
      name: "same_name",
      description: "Builtin-like tool",
      parameters: { type: "object", properties: {} },
      ownerPluginId: "builtin-tools-test",
      source: "builtin:tool-plugin/builtin-tools-test",
      execute: async () => ok("builtin"),
    });
    host.registerCapability({
      name: "same_name",
      description: "Override plugin tool",
      parameters: { type: "object", properties: {} },
      ownerPluginId: "com.example.override",
      scope: "project",
      source: "plugin:com.example.override",
      override: true,
      metadata: { reason: "project-specific behavior" },
      execute: async () => ok("override"),
    });

    await expect(host.execute("same_name", {}, context()))
      .resolves.toMatchObject({ ok: true, content: "override" });
    expect(host.getSchemas().filter((schema) => schema.name === "same_name")).toHaveLength(1);
    expect(host.capabilities.get("same_name")).toMatchObject({
      ownerPluginId: "com.example.override",
      metadata: {
        override: true,
        reason: "project-specific behavior",
        overridesCapability: {
          ownerPluginId: "builtin-tools-test",
          source: "builtin:tool-plugin/builtin-tools-test",
        },
      },
    });
    expect(host.capabilities.list("tool").filter((capability) => capability.id === "same_name"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          ownerPluginId: "builtin-tools-test",
          status: "shadow",
          metadata: expect.objectContaining({ shadowReason: "explicit-override" }),
        }),
        expect.objectContaining({
          ownerPluginId: "com.example.override",
          status: "available",
        }),
      ]));
    expect(host.capabilities.getConflicts()[0]).toMatchObject({
      resolution: "replaced",
    });
  });

  it("hides disabled or shadowed tool capabilities from schemas and blocks execution", async () => {
    const host = new ToolHost({ adoptRegistryTools: false });
    host.registerCapability({
      name: "available_tool",
      description: "Available",
      parameters: { type: "object", properties: {} },
      execute: async () => ok("available"),
    });
    host.registerCapability({
      name: "disabled_tool",
      description: "Disabled",
      parameters: { type: "object", properties: {} },
      status: "disabled",
      execute: async () => ok("should not run"),
    });
    host.registerCapability({
      name: "shadow_tool",
      description: "Shadow",
      parameters: { type: "object", properties: {} },
      status: "shadow",
      execute: async () => ok("should not run"),
    });

    expect(host.getSchemas().map((schema) => schema.name).sort()).toEqual(["available_tool"]);
    await expect(host.execute("available_tool", {}, context()))
      .resolves.toMatchObject({ ok: true, content: "available" });
    await expect(host.execute("disabled_tool", {}, context()))
      .resolves.toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED", retryable: false },
      });
    await expect(host.execute("shadow_tool", {}, context()))
      .resolves.toMatchObject({
        ok: false,
        error: { code: "UNKNOWN", retryable: false },
      });
  });

  it("preserves needsConfirm and render metadata from the legacy registry", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "confirming_tool",
      description: "Confirm",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        ok: false,
        content: "needs confirmation",
        metadata: {
          renderHint: { type: "diff" },
        },
        needsConfirm: {
          message: "Allow?",
          allowDir: "/tmp",
          retry: { name: "confirming_tool", args: {} },
        },
      }),
    });

    const host = new ToolHost({ registry });
    const result = await host.execute("confirming_tool", {}, context());

    expect(result.metadata?.renderHint).toEqual({ type: "diff" });
    expect(result.needsConfirm).toMatchObject({
      message: "Allow?",
      allowDir: "/tmp",
    });
  });

  it("can adapt an existing runtime capability registry", async () => {
    const capabilities = new RuntimeCapabilityRegistry();
    capabilities.register({
      id: "runtime_echo",
      kind: "tool",
      name: "Runtime Echo",
      ownerPluginId: "com.example.runtime",
      scope: "project",
      factory: async (args: Record<string, unknown>) => ok(`runtime:${String(args["text"] ?? "")}`),
      metadata: {
        description: "Runtime echo",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    });

    const host = new ToolHost({ adoptRegistryTools: false });
    const capability = capabilities.get("runtime_echo");
    if (!capability) throw new Error("missing runtime_echo");
    host.registerRuntimeCapability(capability);

    await expect(host.execute("runtime_echo", { text: "hello" }, context()))
      .resolves.toMatchObject({ ok: true, content: "runtime:hello" });
  });

  it("is exposed by createToolRegistry without changing legacy registry access", () => {
    const bundle = createToolRegistry({ cwd: process.cwd() });
    const registrySchemas = bundle.registry.getSchemas().map((schema) => schema.name).sort();
    const hostSchemas = bundle.toolHost.getSchemas().map((schema) => schema.name).sort();

    expect(hostSchemas).toEqual(registrySchemas);
    expect(bundle.toolHost.capabilities.get("read_file")).toMatchObject({
      id: "read_file",
      kind: "tool",
      ownerPluginId: "builtin-tools-fs",
      source: "builtin:tool-plugin/builtin-tools-fs",
    });
  });

  it("registers built-in tools through auditable builtin tool contributions", () => {
    const bundle = createToolRegistry({ cwd: process.cwd() });

    expect(bundle.builtinContributions.map((contribution) => contribution.ownerPluginId)).toEqual([
      "builtin-tools-fs",
      "builtin-tools-shell",
      "builtin-browser",
      "builtin-computer-use",
    ]);
    expect(bundle.registry.has("read_file")).toBe(true);
    expect(bundle.registry.has("bash")).toBe(true);
    expect(bundle.toolHost.capabilities.get("bash")).toMatchObject({
      ownerPluginId: "builtin-tools-shell",
      source: "builtin:tool-plugin/builtin-tools-shell",
      metadata: {
        builtin: true,
        builtinPluginId: "builtin-tools-shell",
        category: "shell",
      },
    });
    expect(JSON.stringify(bundle.toolHost.capabilities.listDescriptors("tool"))).not.toContain("factory");
  });

  it("exposes optional built-in tools only when their host dependencies are available", async () => {
    const storageProvider = new MemoryStorageProvider();
    const userDataStore = new UserDataStore(storageProvider);
    const bundle = createToolRegistry({
      cwd: process.cwd(),
      userDataStore,
    });
    const toolNames = bundle.toolHost.getSchemas().map((schema) => schema.name);

    expect(toolNames).toContain("data_save");
    expect(bundle.toolHost.capabilities.get("data_save")).toMatchObject({
      ownerPluginId: "builtin-user-data",
      source: "builtin:tool-plugin/builtin-user-data",
      metadata: {
        dependencies: ["user-data-store"],
      },
    });

    await expect(bundle.toolHost.execute("data_save", { key: "answer", value: 42 }, context()))
      .resolves.toMatchObject({ ok: true });
    await expect(bundle.toolHost.execute("data_load", { key: "answer" }, context()))
      .resolves.toMatchObject({ ok: true, content: expect.stringContaining("42") });
  });

  it("applies SecurityPlugin as a Host guardrail before legacy registry execution", async () => {
    const bundle = createToolRegistry({
      cwd: process.cwd(),
      security: { deniedTools: ["read_file"] },
    });

    const result = await bundle.toolHost.execute("read_file", { path: "package.json" }, context());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: 'Tool "read_file" is denied by permission rules.',
      },
    });
    expect(bundle.toolHost.registry.stats.getStats("read_file")?.totalCalls ?? 0).toBe(0);
  });

  it("emits Host audit sink records without relying on legacy lifecycle hooks", async () => {
    const records: Array<{ name: string; source: string; content: string }> = [];
    const host = new ToolHost({ adoptRegistryTools: false });
    host.registerCapability({
      name: "audited_tool",
      description: "Audited",
      parameters: { type: "object", properties: {} },
      execute: async () => ok("audited"),
    });
    host.addAuditSink({
      name: "test-audit-sink",
      onToolResult: async (event) => {
        records.push({
          name: event.name,
          source: event.source,
          content: event.result.content,
        });
      },
    });

    await expect(host.execute("audited_tool", {}, context()))
      .resolves.toMatchObject({ ok: true, content: "audited" });

    expect(records).toEqual([
      { name: "audited_tool", source: "registry", content: "audited" },
    ]);
  });

  it("keeps analytics compatible for ToolHost and direct legacy registry execution", async () => {
    const root = tempProject();
    const { sessionStore, bundle } = withTempVeraHome(() => {
      const sessionStore = new SessionStore({ cwd: root });
      const bundle = createToolRegistry({ cwd: root, sessionStore });
      return { sessionStore, bundle };
    });

    await expect(bundle.toolHost.execute("read_file", { path: "missing.txt" }, {
      cwd: root,
      sessionId: sessionStore.sessionId,
    })).resolves.toMatchObject({ ok: false });

    await expect(bundle.registry.execute("list_dir", { path: "." }, {
      cwd: root,
      sessionId: sessionStore.sessionId,
    })).resolves.toMatchObject({ ok: true });

    const entries = readSessionEntries(sessionStore.filePath);
    expect(entries.filter((entry) => entry.type === "tool_call" && entry.toolName === "read_file")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "tool_result" && entry.toolCallId === "read_file")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "tool_call" && entry.toolName === "list_dir")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "tool_result" && entry.toolCallId === "list_dir")).toHaveLength(1);
  });

  it("records analytics for Host guardrail results that never enter the legacy registry", async () => {
    const root = tempProject();
    const { sessionStore, bundle } = withTempVeraHome(() => {
      const sessionStore = new SessionStore({ cwd: root });
      const bundle = createToolRegistry({
        cwd: root,
        sessionStore,
        security: { deniedTools: ["read_file"] },
      });
      return { sessionStore, bundle };
    });

    await expect(bundle.toolHost.execute("read_file", { path: "package.json" }, {
      cwd: root,
      sessionId: sessionStore.sessionId,
    })).resolves.toMatchObject({ ok: false });

    const entries = readSessionEntries(sessionStore.filePath);
    expect(entries.filter((entry) => entry.type === "tool_call" && entry.toolName === "read_file")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "tool_result" && entry.toolCallId === "read_file")).toHaveLength(1);
    expect(bundle.toolHost.registry.stats.getStats("read_file").totalCalls).toBe(0);
  });

  it("registers visual_analyze with a purpose-aware LlmService", async () => {
    const calls: unknown[] = [];
    const bundle = createToolRegistry({
      cwd: process.cwd(),
      defaultModel: "vision-default",
      llmService: {
        complete: async (request: unknown, options: unknown) => {
          calls.push({ request, options });
          return {
            message: { role: "assistant", content: "vision ok" },
            stop_reason: "end_turn",
          };
        },
      } as never,
    });

    expect(bundle.toolHost.getSchemas().map((schema) => schema.name)).toContain("visual_analyze");
    await expect(bundle.toolHost.execute("visual_analyze", { imageData: "abc" }, context()))
      .resolves.toMatchObject({ ok: true, content: "vision ok" });
    expect(calls).toEqual([
      {
        request: expect.objectContaining({ model: "vision-default" }),
        options: { model: "vision-default", purpose: "vision" },
      },
    ]);
  });

  it("loads enabled project plugin tools into createToolRegistry ToolHost", async () => {
    const root = tempProject();
    const pluginDir = join(root, ".vera", "plugins", "echo-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "vera-plugin.json"),
      JSON.stringify({
        id: "com.example.toolhost",
        name: "ToolHost Plugin",
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
            name: "plugin_echo",
            description: "Echo from an enabled plugin",
            parameters: { type: "object", properties: { text: { type: "string" } } },
            execute: async (args) => ({ ok: true, content: "plugin:" + String(args.text ?? "") })
          });
        }
      };`,
    );

    const pluginHost = new PluginHost({ rootDir: root });
    pluginHost.discover({ type: "local", path: pluginDir });
    pluginHost.enable("com.example.toolhost");

    const bundle = createToolRegistry({ cwd: root });
    const loaded = await bundle.loadPlugins();

    expect(loaded.registeredToolIds).toEqual(["plugin_echo"]);
    expect(bundle.toolHost.getSchemas().map((schema) => schema.name)).toContain("plugin_echo");
    await expect(bundle.toolHost.execute("plugin_echo", { text: "hello" }, { cwd: root, sessionId: "s1" }))
      .resolves.toMatchObject({ ok: true, content: "plugin:hello" });
  });
});

function readSessionEntries(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class MemoryStorageProvider implements StorageProvider {
  readonly name = "memory-test";
  private readonly values = new Map<string, StorageValue>();

  async initialize(): Promise<void> {}

  async close(): Promise<void> {}

  isHealthy(): boolean {
    return true;
  }

  async set(namespace: string, key: string, value: StorageValue): Promise<void> {
    this.values.set(this.entryKey(namespace, key), value);
  }

  async get(namespace: string, key: string): Promise<StorageValue | undefined> {
    return this.values.get(this.entryKey(namespace, key));
  }

  async has(namespace: string, key: string): Promise<boolean> {
    return this.values.has(this.entryKey(namespace, key));
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    return this.values.delete(this.entryKey(namespace, key));
  }

  async listKeys(namespace: string): Promise<string[]> {
    const prefix = `${namespace}:`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  async clear(namespace: string): Promise<void> {
    const prefix = `${namespace}:`;
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) {
        this.values.delete(key);
      }
    }
  }

  async setMany(namespace: string, entries: Array<{ key: string; value: StorageValue }>): Promise<void> {
    for (const entry of entries) {
      await this.set(namespace, entry.key, entry.value);
    }
  }

  async getMany(namespace: string, keys: string[]): Promise<Array<{ key: string; value: StorageValue | undefined }>> {
    return Promise.all(keys.map(async (key) => ({ key, value: await this.get(namespace, key) })));
  }

  async query(_namespace: string, _filter: StorageQuery): Promise<StorageQueryResult> {
    return { entries: [], total: 0, hasMore: false };
  }

  async count(namespace: string, _filter?: StorageQuery): Promise<number> {
    return (await this.listKeys(namespace)).length;
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const tx: StorageTransaction = {
      set: (namespace, key, value) => {
        this.values.set(this.entryKey(namespace, key), value);
      },
      get: (namespace, key) => Promise.resolve(this.values.get(this.entryKey(namespace, key))),
      delete: (namespace, key) => {
        this.values.delete(this.entryKey(namespace, key));
      },
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    };
    return fn(tx);
  }

  private entryKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }
}
