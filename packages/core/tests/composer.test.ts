import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, RuntimeCapabilityRegistry } from "@open-vera/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { ContextComposer, PromptComposer } from "../src/composer/index.js";
import { MemoryStore } from "../src/memory/store.js";
import { PromptStore } from "../src/prompt/index.js";
import type { EmbeddingAdapter, VectorDocument, VectorQuery, VectorQueryResult, VectorStore } from "../src/rag/types.js";

describe("PromptComposer", () => {
  it("preserves PromptStore resolution and appends sorted prompt blocks", async () => {
    const eventBus = new EventBus();
    eventBus.config("prompt:blocks", (event) => [
      ...(event.value as Array<{ id: string; content: string; priority?: number }>),
      { id: "plugin-block", content: "Plugin prompt block", priority: 5 },
    ]);
    const capabilities = new RuntimeCapabilityRegistry();
    const composer = new PromptComposer({
      promptStore: new PromptStore(),
      eventBus,
      capabilities,
    });
    composer.registerPromptBlock({
      id: "registered-block",
      content: "Registered prompt block",
      priority: 10,
      ownerPluginId: "com.example.prompt",
    });

    const composed = await composer.compose({
      intent: { domain: "chat", level: 0, needs_tools: true },
      blocks: [{ id: "callsite-block", content: "Callsite prompt block", priority: 20 }],
    });

    expect(composed.rendered?.profileId).toBeTruthy();
    expect(composed.blocks.map((block) => block.id)).toEqual([
      "plugin-block",
      "registered-block",
      "callsite-block",
    ]);
    expect(composed.system).toContain("Plugin prompt block");
    expect(composed.system).toContain("Registered prompt block");
    expect(JSON.stringify(composer.capabilities.listDescriptors())).not.toContain("Registered prompt block");
  });
});

describe("ContextComposer", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-context-composer-"));
    roots.push(root);
    mkdirSync(join(root, ".vera"), { recursive: true });
    writeFileSync(join(root, ".vera", "VERA.md"), "Project context body");
    return root;
  }

  it("combines project context with provider output in priority order", async () => {
    const cwd = tempProject();
    const eventBus = new EventBus();
    eventBus.config("context:providers", (event) => [
      ...(event.value as Array<{ id: string; content: string; priority?: number }>),
      { id: "event-provider", content: "Event context", priority: 5 },
    ]);
    const composer = new ContextComposer({ eventBus });
    composer.registerContextProvider({
      id: "registered-provider",
      content: "Registered context",
      priority: 10,
      ownerPluginId: "com.example.context",
    });

    const composed = await composer.compose({
      cwd,
      providers: [{ id: "callsite-provider", content: "Callsite context", priority: 20 }],
    });

    expect(composed.projectContext?.system).toContain("Project context body");
    expect(composed.providers.map((provider) => provider.id)).toEqual([
      "event-provider",
      "registered-provider",
      "callsite-provider",
    ]);
    expect(composed.system).toContain("Project context body");
    expect(composed.system.indexOf("Event context")).toBeLessThan(composed.system.indexOf("Registered context"));
  });

  it("clips context provider output to a host-controlled character budget", async () => {
    const cwd = tempProject();
    const composer = new ContextComposer();

    const composed = await composer.compose({
      cwd,
      includeProjectContext: false,
      providers: [{ id: "large-provider", content: "abcdef", priority: 0 }],
      maxChars: 3,
    });

    expect(composed.truncated).toBe(true);
    expect(composed.system).toBe("abc\n[truncated]");
  });

  it("injects MemoryStore search results as host-owned context provider output", async () => {
    const cwd = tempProject();
    const memoryStore = new MemoryStore();
    memoryStore.addSemantic("plugin runtime", "Use PluginHost for runtime capability lifecycle", ["plugin"]);
    const composer = new ContextComposer({ memoryStore });

    const composed = await composer.compose({
      cwd,
      query: "plugin runtime lifecycle",
      includeProjectContext: false,
    });

    expect(composed.providers.map((provider) => provider.id)).toEqual(["builtin-memory-context"]);
    expect(composed.system).toContain("Relevant memory:");
    expect(composed.system).toContain("Use PluginHost for runtime capability lifecycle");
    expect(JSON.stringify(composer.capabilities.listDescriptors("memory"))).not.toContain("Use PluginHost");
  });

  it("injects RAG search results from vector and embedding capabilities", async () => {
    const cwd = tempProject();
    const embeddingAdapter = new FakeEmbeddingAdapter();
    const vectorStore = new FakeVectorStore([
      {
        id: "doc-1",
        content: "Gateway Chat should share the plugin EventBus lifecycle.",
        embedding: [1, 0],
        metadata: { source: "plugin-plan.md" },
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-05T00:00:00.000Z",
      },
    ]);
    const composer = new ContextComposer({ vectorStore, embeddingAdapter });

    const composed = await composer.compose({
      cwd,
      query: "gateway plugin eventbus",
      includeProjectContext: false,
    });

    expect(composed.providers.map((provider) => provider.id)).toEqual(["builtin-rag-context"]);
    expect(composed.system).toContain("Relevant knowledge");
    expect(composed.system).toContain("plugin-plan.md");
    expect(composed.system).toContain("Gateway Chat should share the plugin EventBus lifecycle.");
  });

  it("resolves dynamic context providers before config hooks and sorting", async () => {
    const cwd = tempProject();
    const eventBus = new EventBus();
    eventBus.config("context:providers", (event) => [
      ...(event.value as Array<{ id: string; content: string; priority?: number }>),
      { id: "event-provider", content: "event", priority: 15 },
    ]);
    const composer = new ContextComposer({ eventBus });
    composer.registerContextProvider({
      id: "dynamic-provider",
      priority: 5,
      resolve: (request) => request.query ? `dynamic:${request.query}` : null,
    });

    const composed = await composer.compose({
      cwd,
      query: "scope",
      includeProjectContext: false,
      providers: [{ id: "callsite", content: "callsite", priority: 20 }],
    });

    expect(composed.providers.map((provider) => provider.id)).toEqual([
      "dynamic-provider",
      "event-provider",
      "callsite",
    ]);
    expect(composed.system).toContain("dynamic:scope");
  });
});

class FakeEmbeddingAdapter implements EmbeddingAdapter {
  readonly name = "fake-embedding";
  readonly dimensions = 2;

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async embed(): Promise<number[]> {
    return [1, 0];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
}

class FakeVectorStore implements VectorStore {
  readonly name = "fake-vector";
  private readonly docs: VectorDocument[];

  constructor(docs: VectorDocument[]) {
    this.docs = docs;
  }

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  isHealthy(): boolean {
    return true;
  }
  async upsert(doc: VectorDocument): Promise<void> {
    this.docs.push(doc);
  }
  async upsertMany(docs: VectorDocument[]): Promise<void> {
    this.docs.push(...docs);
  }
  async get(id: string): Promise<VectorDocument | undefined> {
    return this.docs.find((doc) => doc.id === id);
  }
  async getMany(ids: string[]): Promise<VectorDocument[]> {
    const idSet = new Set(ids);
    return this.docs.filter((doc) => idSet.has(doc.id));
  }
  async delete(id: string): Promise<boolean> {
    const idx = this.docs.findIndex((doc) => doc.id === id);
    if (idx < 0) return false;
    this.docs.splice(idx, 1);
    return true;
  }
  async deleteMany(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (await this.delete(id)) count++;
    }
    return count;
  }
  async has(id: string): Promise<boolean> {
    return this.docs.some((doc) => doc.id === id);
  }
  async listIds(): Promise<string[]> {
    return this.docs.map((doc) => doc.id);
  }
  async count(): Promise<number> {
    return this.docs.length;
  }
  async clear(): Promise<void> {
    this.docs.splice(0);
  }
  async search(query: VectorQuery): Promise<VectorQueryResult> {
    const topK = query.topK ?? this.docs.length;
    return {
      results: this.docs.slice(0, topK).map((document, idx) => ({
        document,
        score: 0.9 - idx * 0.1,
      })),
      total: this.docs.length,
      durationMs: 1,
    };
  }
  async getStats(): Promise<{ documentCount: number; dimensions: number }> {
    return { documentCount: this.docs.length, dimensions: 2 };
  }
}
