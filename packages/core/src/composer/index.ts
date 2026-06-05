import { EventBus, RuntimeCapabilityRegistry, type RuntimeCapability } from "@open-vera/plugin-runtime";
import type { MemorySearchResult, MemoryStore, MemoryTier } from "../memory/store.js";
import { loadProjectContext, type ProjectContext } from "../project-context/index.js";
import type { PromptIntent, PromptStore, RenderedPrompt } from "../prompt/index.js";
import type { EmbeddingAdapter, VectorQueryResult, VectorStore } from "../rag/types.js";

export interface PromptBlock {
  id: string;
  content: string;
  priority?: number;
  ownerPluginId?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextProviderOutput {
  id: string;
  content: string;
  priority?: number;
  tokenEstimate?: number;
  ownerPluginId?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextProviderRequest {
  cwd: string;
  query?: string;
  sessionId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export type ContextProviderResolveResult =
  | ContextProviderOutput
  | ContextProviderOutput[]
  | string
  | null
  | undefined;

export interface ContextProviderFactory {
  id: string;
  priority?: number;
  tokenEstimate?: number;
  ownerPluginId?: string;
  metadata?: Record<string, unknown>;
  resolve(request: ContextProviderRequest): ContextProviderResolveResult | Promise<ContextProviderResolveResult>;
}

export interface MemoryContextProviderOptions {
  id?: string;
  store: MemoryStore;
  priority?: number;
  ownerPluginId?: string;
  limit?: number;
  tiers?: MemoryTier[];
  maxChars?: number;
}

export interface RagContextProviderOptions {
  id?: string;
  vectorStore: VectorStore;
  embeddingAdapter: EmbeddingAdapter;
  priority?: number;
  ownerPluginId?: string;
  topK?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  maxChars?: number;
}

export interface ComposePromptInput {
  intent: PromptIntent;
  profileId?: string;
  variables?: Record<string, string>;
  baseSystem?: string;
  blocks?: PromptBlock[];
  sessionId?: string;
}

export interface ComposedPrompt {
  system: string;
  rendered: RenderedPrompt | null;
  blocks: PromptBlock[];
}

export interface ComposeContextInput {
  cwd: string;
  query?: string;
  includeProjectContext?: boolean;
  providers?: ContextProviderOutput[];
  maxChars?: number;
  sessionId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  memoryStore?: MemoryStore;
  memory?: Omit<MemoryContextProviderOptions, "store"> & { store?: MemoryStore };
  vectorStore?: VectorStore;
  embeddingAdapter?: EmbeddingAdapter;
  rag?: Omit<RagContextProviderOptions, "vectorStore" | "embeddingAdapter"> & {
    vectorStore?: VectorStore;
    embeddingAdapter?: EmbeddingAdapter;
  };
}

export interface ComposedContext {
  system: string;
  projectContext: ProjectContext | null;
  providers: ContextProviderOutput[];
  truncated: boolean;
}

export interface PromptComposerOptions {
  promptStore: PromptStore;
  eventBus?: EventBus;
  capabilities?: RuntimeCapabilityRegistry;
}

export interface ContextComposerOptions {
  eventBus?: EventBus;
  capabilities?: RuntimeCapabilityRegistry;
  loadProjectContextImpl?: typeof loadProjectContext;
  memoryStore?: MemoryStore;
  vectorStore?: VectorStore;
  embeddingAdapter?: EmbeddingAdapter;
}

export class PromptComposer {
  readonly eventBus: EventBus;
  readonly capabilities: RuntimeCapabilityRegistry;
  private readonly promptStore: PromptStore;

  constructor(options: PromptComposerOptions) {
    this.promptStore = options.promptStore;
    this.eventBus = options.eventBus ?? new EventBus();
    this.capabilities = options.capabilities ?? new RuntimeCapabilityRegistry();
  }

  registerPromptBlock(input: PromptBlock & { ownerPluginId?: string }): void {
    this.capabilities.register({
      id: input.id,
      kind: "prompt",
      name: input.id,
      ownerPluginId: input.ownerPluginId ?? "builtin-prompt",
      scope: "global",
      source: input.ownerPluginId ? `plugin:${input.ownerPluginId}` : "builtin:prompt",
      factory: input,
      metadata: {
        ...input.metadata,
        priority: input.priority ?? 0,
        contentLength: input.content.length,
      },
    });
  }

  async compose(input: ComposePromptInput): Promise<ComposedPrompt> {
    const rendered = this.promptStore.resolve(input.intent, {
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.variables ? { variables: input.variables } : {}),
    });
    const base = input.baseSystem ?? rendered?.system ?? "You are Vera, a helpful assistant.";
    const capabilityBlocks = this.capabilities
      .list("prompt")
      .map((capability) => promptBlockFromCapability(capability))
      .filter((block): block is PromptBlock => block !== null);
    const blocks = await this.eventBus.emitConfig<PromptBlock[]>(
      "prompt:blocks",
      [...capabilityBlocks, ...(input.blocks ?? [])],
      {
        pluginId: "prompt-composer",
        sessionId: input.sessionId,
        metadata: { intent: input.intent },
      },
    );
    const sortedBlocks = sortBlocks(blocks);
    return {
      rendered,
      blocks: sortedBlocks,
      system: joinPromptParts([base, ...sortedBlocks.map((block) => block.content)]),
    };
  }
}

export class ContextComposer {
  readonly eventBus: EventBus;
  readonly capabilities: RuntimeCapabilityRegistry;
  private readonly loadProjectContextImpl: typeof loadProjectContext;

  constructor(options: ContextComposerOptions = {}) {
    this.eventBus = options.eventBus ?? new EventBus();
    this.capabilities = options.capabilities ?? new RuntimeCapabilityRegistry();
    this.loadProjectContextImpl = options.loadProjectContextImpl ?? loadProjectContext;
    if (options.memoryStore) {
      this.registerMemoryProvider({ store: options.memoryStore });
    }
    if (options.vectorStore && options.embeddingAdapter) {
      this.registerRagProvider({
        vectorStore: options.vectorStore,
        embeddingAdapter: options.embeddingAdapter,
      });
    }
  }

  registerContextProvider(input: ContextProviderOutput | ContextProviderFactory): void {
    this.capabilities.register({
      id: input.id,
      kind: "context",
      name: input.id,
      ownerPluginId: input.ownerPluginId ?? "builtin-context",
      scope: "global",
      source: input.ownerPluginId ? `plugin:${input.ownerPluginId}` : "builtin:context",
      factory: input,
      metadata: {
        ...input.metadata,
        priority: input.priority ?? 0,
        tokenEstimate: input.tokenEstimate,
        ...(isContextProviderOutput(input) ? { contentLength: input.content.length } : {}),
        ...(isContextProviderFactory(input) ? { dynamic: true } : {}),
      },
    });
  }

  registerMemoryProvider(input: MemoryContextProviderOptions): void {
    const provider = createMemoryContextProvider(input);
    this.capabilities.register({
      id: provider.id,
      kind: "memory",
      name: provider.id,
      ownerPluginId: provider.ownerPluginId ?? "builtin-memory",
      scope: "global",
      source: provider.ownerPluginId ? `plugin:${provider.ownerPluginId}` : "builtin:memory",
      factory: provider,
      actions: ["view", "test"],
      metadata: {
        ...provider.metadata,
        priority: provider.priority ?? 30,
        dynamic: true,
      },
      healthCheck: () => {
        const stats = input.store.stats();
        return {
          ok: true,
          message: `Memory entries: ${stats.total}`,
        };
      },
    });
  }

  registerRagProvider(input: RagContextProviderOptions): void {
    const provider = createRagContextProvider(input);
    this.capabilities.register({
      id: provider.id,
      kind: "rag",
      name: provider.id,
      ownerPluginId: provider.ownerPluginId ?? "builtin-rag",
      scope: "global",
      source: provider.ownerPluginId ? `plugin:${provider.ownerPluginId}` : "builtin:rag",
      factory: provider,
      actions: ["view", "test", "reindex"],
      metadata: {
        ...provider.metadata,
        priority: provider.priority ?? 40,
        dynamic: true,
        vectorStore: input.vectorStore.name,
        embeddingAdapter: input.embeddingAdapter.name,
      },
      healthCheck: () => ({
        ok: input.vectorStore.isHealthy(),
        message: input.vectorStore.isHealthy() ? "RAG vector store is healthy" : "RAG vector store is unhealthy",
      }),
    });
  }

  async compose(input: ComposeContextInput): Promise<ComposedContext> {
    const projectContext = input.includeProjectContext === false
      ? null
      : this.loadProjectContextImpl({ cwd: input.cwd });

    const request: ContextProviderRequest = {
      cwd: input.cwd,
      query: input.query,
      sessionId: input.sessionId,
      signal: input.signal,
      metadata: input.metadata,
    };
    const registeredProviders = await this.resolveRegisteredProviders(request);
    const callsiteProviders = await this.resolveCallsiteProviders(input, request);
    const providers = await this.eventBus.emitConfig<ContextProviderOutput[]>(
      "context:providers",
      [...registeredProviders, ...callsiteProviders, ...(input.providers ?? [])],
      {
        pluginId: "context-composer",
        sessionId: input.sessionId,
        metadata: { cwd: input.cwd, query: input.query },
      },
    );
    const sortedProviders = sortProviders(providers);
    const joined = joinPromptParts([
      projectContext?.system ?? "",
      ...sortedProviders.map((provider) => provider.content),
    ]);
    const limited = limitChars(joined, input.maxChars);
    return {
      projectContext,
      providers: sortedProviders,
      system: limited.value,
      truncated: limited.truncated,
    };
  }

  private async resolveRegisteredProviders(request: ContextProviderRequest): Promise<ContextProviderOutput[]> {
    const capabilities = [
      ...this.capabilities.list("context"),
      ...this.capabilities.list("memory"),
      ...this.capabilities.list("rag"),
    ].filter((capability) => capability.status === "available");

    const outputs = await Promise.all(
      capabilities.map((capability) => resolveContextCapability(capability, request)),
    );
    return outputs.flat();
  }

  private async resolveCallsiteProviders(
    input: ComposeContextInput,
    request: ContextProviderRequest,
  ): Promise<ContextProviderOutput[]> {
    const providers: ContextProviderFactory[] = [];
    const memoryStore = input.memory?.store ?? input.memoryStore;
    if (memoryStore) {
      providers.push(createMemoryContextProvider({
        ...input.memory,
        store: memoryStore,
      }));
    }

    const vectorStore = input.rag?.vectorStore ?? input.vectorStore;
    const embeddingAdapter = input.rag?.embeddingAdapter ?? input.embeddingAdapter;
    if (vectorStore && embeddingAdapter) {
      providers.push(createRagContextProvider({
        ...input.rag,
        vectorStore,
        embeddingAdapter,
      }));
    }

    const outputs = await Promise.all(
      providers.map((provider) => resolveContextProvider(provider, request, provider.ownerPluginId)),
    );
    return outputs.flat();
  }
}

function promptBlockFromCapability(capability: RuntimeCapability): PromptBlock | null {
  const factory = capability.factory;
  if (isPromptBlock(factory)) return factory;
  const metadata = capability.metadata ?? {};
  const content = typeof metadata["content"] === "string" ? metadata["content"] : undefined;
  if (!content) return null;
  return {
    id: capability.id,
    content,
    priority: typeof metadata["priority"] === "number" ? metadata["priority"] : undefined,
    ownerPluginId: capability.ownerPluginId,
    metadata,
  };
}

async function resolveContextCapability(
  capability: ReturnType<RuntimeCapabilityRegistry["list"]>[number],
  request: ContextProviderRequest,
): Promise<ContextProviderOutput[]> {
  const factory = capability.factory;
  const provider = isContextProviderFactory(factory)
    ? factory
    : contextProviderFromCapability(capability);
  return resolveContextProvider(provider, request, capability.ownerPluginId);
}

async function resolveContextProvider(
  provider: ContextProviderOutput | ContextProviderFactory | null,
  request: ContextProviderRequest,
  ownerPluginId?: string,
): Promise<ContextProviderOutput[]> {
  if (!provider) return [];
  if (isContextProviderOutput(provider)) {
    return [provider];
  }

  const resolved = await provider.resolve(request);
  return normalizeContextProviderResult(resolved, provider, ownerPluginId);
}

function contextProviderFromCapability(capability: ReturnType<RuntimeCapabilityRegistry["list"]>[number]): ContextProviderOutput | null {
  const factory = capability.factory;
  if (isContextProviderOutput(factory)) return factory;
  const metadata = capability.metadata ?? {};
  const content = typeof metadata["content"] === "string" ? metadata["content"] : undefined;
  if (!content) return null;
  return {
    id: capability.id,
    content,
    priority: typeof metadata["priority"] === "number" ? metadata["priority"] : undefined,
    tokenEstimate: typeof metadata["tokenEstimate"] === "number" ? metadata["tokenEstimate"] : undefined,
    ownerPluginId: capability.ownerPluginId,
    metadata,
  };
}

function normalizeContextProviderResult(
  value: ContextProviderResolveResult,
  provider: ContextProviderFactory,
  ownerPluginId?: string,
): ContextProviderOutput[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    const content = value.trim();
    if (!content) return [];
    return [{
      id: provider.id,
      content,
      priority: provider.priority,
      tokenEstimate: provider.tokenEstimate,
      ownerPluginId: provider.ownerPluginId ?? ownerPluginId,
      metadata: provider.metadata,
    }];
  }
  const outputs = Array.isArray(value) ? value : [value];
  return outputs
    .filter(isContextProviderOutput)
    .map((output) => ({
      ...output,
      ownerPluginId: output.ownerPluginId ?? provider.ownerPluginId ?? ownerPluginId,
    }));
}

function sortBlocks(blocks: PromptBlock[]): PromptBlock[] {
  return [...blocks].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id));
}

function sortProviders(providers: ContextProviderOutput[]): ContextProviderOutput[] {
  return [...providers].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id));
}

function joinPromptParts(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function limitChars(value: string, maxChars: number | undefined): { value: string; truncated: boolean } {
  if (maxChars === undefined || value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: `${value.slice(0, Math.max(0, maxChars))}\n[truncated]`, truncated: true };
}

function createMemoryContextProvider(input: MemoryContextProviderOptions): ContextProviderFactory {
  const id = input.id ?? "builtin-memory-context";
  const limit = input.limit ?? 5;
  const maxChars = input.maxChars ?? 8_000;
  return {
    id,
    priority: input.priority ?? 30,
    ownerPluginId: input.ownerPluginId ?? "builtin-memory",
    metadata: {
      tiers: input.tiers ?? ["working", "episodic", "semantic"],
      limit,
      maxChars,
    },
    resolve: (request) => {
      const query = request.query?.trim();
      if (!query) return null;
      const results = input.store.search(query, {
        tiers: input.tiers,
        limit,
      });
      return memoryResultsToContext(id, results, maxChars, input.priority);
    },
  };
}

function memoryResultsToContext(
  id: string,
  results: MemorySearchResult[],
  maxChars: number,
  priority: number | undefined,
): ContextProviderOutput | null {
  if (results.length === 0) return null;
  const lines = ["Relevant memory:"];
  for (let idx = 0; idx < results.length; idx++) {
    const result = results[idx]!;
    const entry = result.entry;
    lines.push(
      [
        `### [${idx + 1}] ${entry.tier}:${entry.id} (score: ${result.score.toFixed(3)})`,
        entry.tags.length > 0 ? `tags: ${entry.tags.join(", ")}` : "",
        entry.content,
      ].filter(Boolean).join("\n"),
    );
  }
  const limited = limitChars(lines.join("\n\n"), maxChars);
  return {
    id,
    content: limited.value,
    priority,
    metadata: {
      resultCount: results.length,
      truncated: limited.truncated,
    },
  };
}

function createRagContextProvider(input: RagContextProviderOptions): ContextProviderFactory {
  const id = input.id ?? "builtin-rag-context";
  const topK = input.topK ?? 5;
  const minScore = input.minScore ?? 0;
  const maxChars = input.maxChars ?? 12_000;
  return {
    id,
    priority: input.priority ?? 40,
    ownerPluginId: input.ownerPluginId ?? "builtin-rag",
    metadata: {
      topK,
      minScore,
      maxChars,
      vectorStore: input.vectorStore.name,
      embeddingAdapter: input.embeddingAdapter.name,
    },
    resolve: async (request) => {
      const query = request.query?.trim();
      if (!query) return null;
      const embedding = await input.embeddingAdapter.embed(query);
      const result = await input.vectorStore.search({
        embedding,
        topK,
        minScore,
        filter: input.filter,
      });
      return ragResultsToContext(id, result, maxChars, input.priority);
    },
  };
}

function ragResultsToContext(
  id: string,
  result: VectorQueryResult,
  maxChars: number,
  priority: number | undefined,
): ContextProviderOutput | null {
  if (result.results.length === 0) return null;
  const lines = [`Relevant knowledge (${result.results.length} of ${result.total}):`];
  for (let idx = 0; idx < result.results.length; idx++) {
    const { document, score } = result.results[idx]!;
    const source = typeof document.metadata?.["source"] === "string"
      ? document.metadata["source"]
      : document.id;
    lines.push(
      [
        `### [${idx + 1}] ${source} (score: ${score.toFixed(3)})`,
        document.content,
      ].join("\n"),
    );
  }
  const limited = limitChars(lines.join("\n\n"), maxChars);
  return {
    id,
    content: limited.value,
    priority,
    metadata: {
      resultCount: result.results.length,
      total: result.total,
      durationMs: result.durationMs,
      truncated: limited.truncated,
    },
  };
}

function isPromptBlock(value: unknown): value is PromptBlock {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["content"] === "string";
}

function isContextProviderOutput(value: unknown): value is ContextProviderOutput {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["content"] === "string";
}

function isContextProviderFactory(value: unknown): value is ContextProviderFactory {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["resolve"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
