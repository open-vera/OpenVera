/**
 * Tests for EmbeddingAdapter implementations —
 * LocalEmbeddingAdapter (hash-based), OpenAI/Voyage (mocked API), and factory.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingAdapter } from "../types.js";
import { EmbeddingError } from "../types.js";
import {
  LocalEmbeddingAdapter,
  OpenAIEmbeddingAdapter,
  VoyageEmbeddingAdapter,
  createEmbeddingAdapter,
} from "../embedding-adapter.js";

// ── LocalEmbeddingAdapter ────────────────────────────────────────────────────

describe("LocalEmbeddingAdapter", () => {
  let adapter: LocalEmbeddingAdapter;

  beforeEach(() => {
    adapter = new LocalEmbeddingAdapter();
  });

  it("should have name 'local-hash'", () => {
    expect(adapter.name).toBe("local-hash");
  });

  it("should default to 384 dimensions", () => {
    expect(adapter.dimensions).toBe(384);
  });

  it("should accept custom dimensions", () => {
    const custom = new LocalEmbeddingAdapter({ dimensions: 768 });
    expect(custom.dimensions).toBe(768);
  });

  it("should produce deterministic embeddings", async () => {
    const vec1 = await adapter.embed("hello world");
    const vec2 = await adapter.embed("hello world");
    expect(vec1).toEqual(vec2);
  });

  it("should produce different embeddings for different text", async () => {
    const vec1 = await adapter.embed("hello");
    const vec2 = await adapter.embed("goodbye");
    expect(vec1).not.toEqual(vec2);
  });

  it("should return correct dimensionality", async () => {
    const vec = await adapter.embed("test");
    expect(vec).toHaveLength(384);
  });

  it("should produce unit vectors", async () => {
    const vec = await adapter.embed("test text");
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 5);
  });

  it("should embed batch of texts", async () => {
    const vecs = await adapter.embedBatch(["a", "b", "c"]);
    expect(vecs).toHaveLength(3);
    for (const vec of vecs) {
      expect(vec).toHaveLength(384);
    }
  });

  it("should return empty array for empty batch", async () => {
    const vecs = await adapter.embedBatch([]);
    expect(vecs).toEqual([]);
  });

  it("should initialize and close without error", async () => {
    await adapter.initialize();
    await adapter.close();
  });
});

// ── OpenAI Adapter (mocked fetch) ────────────────────────────────────────────

describe("OpenAIEmbeddingAdapter", () => {
  const mockEmbedding = [0.1, 0.2, 0.3];

  function mockFetch(embedding: number[] = mockEmbedding) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ embedding, index: 0 }],
        }),
      text: () => Promise.resolve(""),
    });
  }

  it("should throw if apiKey is empty", () => {
    expect(() => new OpenAIEmbeddingAdapter({ apiKey: "" })).toThrow(EmbeddingError);
  });

  it("should have name 'openai'", () => {
    const a = new OpenAIEmbeddingAdapter({ apiKey: "test-key" });
    expect(a.name).toBe("openai");
  });

  it("should default to text-embedding-3-small dimensions", () => {
    const a = new OpenAIEmbeddingAdapter({ apiKey: "test-key" });
    expect(a.dimensions).toBe(1536);
  });

  it("should accept custom dimensions", () => {
    const a = new OpenAIEmbeddingAdapter({ apiKey: "test-key", dimensions: 512 });
    expect(a.dimensions).toBe(512);
  });

  it("should call OpenAI API with correct parameters", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test", model: "text-embedding-3-small" });
    await adapter.initialize();
    const vec = await adapter.embed("hello");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/embeddings");
    expect(opts.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(opts.body).input).toEqual(["hello"]);

    expect(vec).toEqual(mockEmbedding);
    vi.restoreAllMocks();
  });

  it("should handle API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      }),
    );

    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    await adapter.initialize();
    await expect(adapter.embed("hello")).rejects.toThrow(EmbeddingError);
    vi.restoreAllMocks();
  });

  it("should throw when not initialized", async () => {
    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    await expect(adapter.embed("hello")).rejects.toThrow("not initialized");
  });

  it("should batch large requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { embedding: [0.1], index: 0 },
            { embedding: [0.2], index: 1 },
          ],
        }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test", maxBatchSize: 2 });
    await adapter.initialize();
    const vecs = await adapter.embedBatch(["a", "b"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vecs).toEqual([[0.1], [0.2]]);
    vi.restoreAllMocks();
  });
});

// ── Voyage Adapter (mocked fetch) ────────────────────────────────────────────

describe("VoyageEmbeddingAdapter", () => {
  it("should throw if apiKey is empty", () => {
    expect(() => new VoyageEmbeddingAdapter({ apiKey: "" })).toThrow(EmbeddingError);
  });

  it("should have name 'voyage'", () => {
    const a = new VoyageEmbeddingAdapter({ apiKey: "test-key" });
    expect(a.name).toBe("voyage");
  });

  it("should default to voyage-3 dimensions (1024)", () => {
    const a = new VoyageEmbeddingAdapter({ apiKey: "test-key" });
    expect(a.dimensions).toBe(1024);
  });

  it("should call Voyage API with correct URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ embedding: [0.1, 0.2], index: 0 }],
        }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new VoyageEmbeddingAdapter({ apiKey: "vk-test" });
    await adapter.initialize();
    await adapter.embed("hello");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("voyageai.com");
    vi.restoreAllMocks();
  });
});

// ── Factory ──────────────────────────────────────────────────────────────────

describe("createEmbeddingAdapter", () => {
  it("should create OpenAI adapter", () => {
    const adapter = createEmbeddingAdapter({ provider: "openai", apiKey: "sk-test" });
    expect(adapter.name).toBe("openai");
  });

  it("should create Voyage adapter", () => {
    const adapter = createEmbeddingAdapter({ provider: "voyage", apiKey: "vk-test" });
    expect(adapter.name).toBe("voyage");
  });

  it("should create Local adapter", () => {
    const adapter = createEmbeddingAdapter({ provider: "local" });
    expect(adapter.name).toBe("local-hash");
  });

  it("should throw for unknown provider", () => {
    expect(() =>
      createEmbeddingAdapter({ provider: "unknown" as unknown as "local" }),
    ).toThrow(EmbeddingError);
  });

  it("should pass dimensions to local adapter", () => {
    const adapter = createEmbeddingAdapter({ provider: "local", dimensions: 768 });
    expect(adapter.dimensions).toBe(768);
  });
});

// ── Interface Compliance ─────────────────────────────────────────────────────

describe("EmbeddingAdapter interface compliance", () => {
  it("LocalEmbeddingAdapter satisfies EmbeddingAdapter interface", async () => {
    const adapter: EmbeddingAdapter = new LocalEmbeddingAdapter();
    expect(adapter.name).toBeDefined();
    expect(adapter.dimensions).toBeDefined();
    await adapter.initialize();
    const vec = await adapter.embed("test");
    expect(vec.length).toBe(adapter.dimensions);
    await adapter.close();
  });
});
