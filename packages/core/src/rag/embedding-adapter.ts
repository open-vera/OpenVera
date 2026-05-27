/**
 * Embedding adapter implementations.
 *
 * Provides concrete adapters for generating text embeddings via:
 * - OpenAI API (text-embedding-3-small, text-embedding-3-large, etc.)
 * - Anthropic-compatible API (voyage, etc.)
 * - Local/placeholder (for testing)
 *
 * All adapters implement the EmbeddingAdapter interface from types.ts.
 */

import type { EmbeddingAdapter } from "./types.js";
import { EmbeddingError } from "./types.js";

// ── Configuration ────────────────────────────────────────────────────────────

export interface OpenAIEmbeddingOptions {
  /** API key */
  apiKey: string;
  /** Model name (default: "text-embedding-3-small") */
  model?: string;
  /** Base URL (default: "https://api.openai.com/v1") */
  baseUrl?: string;
  /** Embedding dimensions (overrides model default) */
  dimensions?: number;
  /** Max texts per batch request (default: 100) */
  maxBatchSize?: number;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
}

export interface VoyageEmbeddingOptions {
  /** API key */
  apiKey: string;
  /** Model name (default: "voyage-3") */
  model?: string;
  /** Embedding dimensions */
  dimensions?: number;
  /** Max texts per batch request (default: 128) */
  maxBatchSize?: number;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
}

export interface LocalEmbeddingOptions {
  /** Fixed dimensionality for the local adapter */
  dimensions?: number;
}

// ── Model Defaults ───────────────────────────────────────────────────────────

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-code-3": 1024,
};

// ── OpenAI Adapter ───────────────────────────────────────────────────────────

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly name = "openai";
  readonly dimensions: number;

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxBatchSize: number;
  private timeoutMs: number;
  private initialized = false;

  constructor(options: OpenAIEmbeddingOptions) {
    if (!options.apiKey) throw new EmbeddingError("OpenAI API key is required");
    this.apiKey = options.apiKey;
    this.model = options.model ?? "text-embedding-3-small";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.dimensions = options.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 1536;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.initialized) throw new EmbeddingError("Adapter not initialized");
    if (texts.length === 0) return [];

    const allEmbeddings: number[][] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const embeddings = await this.callAPI(batch);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  private async callAPI(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    const body = JSON.stringify({
      model: this.model,
      input: texts,
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new EmbeddingError(`OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(`OpenAI API request failed: ${String(err)}`, { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Voyage Adapter ───────────────────────────────────────────────────────────

export class VoyageEmbeddingAdapter implements EmbeddingAdapter {
  readonly name = "voyage";
  readonly dimensions: number;

  private apiKey: string;
  private model: string;
  private maxBatchSize: number;
  private timeoutMs: number;
  private initialized = false;

  private static readonly BASE_URL = "https://api.voyageai.com/v1";

  constructor(options: VoyageEmbeddingOptions) {
    if (!options.apiKey) throw new EmbeddingError("Voyage API key is required");
    this.apiKey = options.apiKey;
    this.model = options.model ?? "voyage-3";
    this.dimensions = options.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 1024;
    this.maxBatchSize = options.maxBatchSize ?? 128;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.initialized) throw new EmbeddingError("Adapter not initialized");
    if (texts.length === 0) return [];

    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const embeddings = await this.callAPI(batch);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  private async callAPI(texts: string[]): Promise<number[][]> {
    const url = `${VoyageEmbeddingAdapter.BASE_URL}/embeddings`;
    const body = JSON.stringify({
      model: this.model,
      input: texts,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        throw new EmbeddingError(`Voyage API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(`Voyage API request failed: ${String(err)}`, { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Local (Placeholder) Adapter ──────────────────────────────────────────────

/**
 * Deterministic local embedding adapter for testing.
 * Generates embeddings from text using a simple hash-based approach.
 * NOT suitable for production — use only for testing and development.
 */
export class LocalEmbeddingAdapter implements EmbeddingAdapter {
  readonly name = "local-hash";
  readonly dimensions: number;

  constructor(options: LocalEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 384;
  }

  async initialize(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    // No-op
  }

  async embed(text: string): Promise<number[]> {
    return this.hashEmbed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.hashEmbed(t));
  }

  private hashEmbed(text: string): number[] {
    const vec: number[] = new Array(this.dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    // Generate deterministic values from the hash
    for (let i = 0; i < this.dimensions; i++) {
      hash = ((hash << 13) ^ hash) | 0;
      vec[i] = (Math.abs(hash) % 10000) / 10000;
    }
    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) vec[i] /= norm;
    }
    return vec;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export type EmbeddingProvider = "openai" | "voyage" | "local";

export interface CreateEmbeddingAdapterOptions {
  provider: EmbeddingProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

export function createEmbeddingAdapter(options: CreateEmbeddingAdapterOptions): EmbeddingAdapter {
  switch (options.provider) {
    case "openai":
      return new OpenAIEmbeddingAdapter({
        apiKey: options.apiKey ?? "",
        model: options.model,
        baseUrl: options.baseUrl,
        dimensions: options.dimensions,
      });
    case "voyage":
      return new VoyageEmbeddingAdapter({
        apiKey: options.apiKey ?? "",
        model: options.model,
        dimensions: options.dimensions,
      });
    case "local":
      return new LocalEmbeddingAdapter({ dimensions: options.dimensions });
    default:
      throw new EmbeddingError(`Unknown embedding provider: ${String(options.provider)}`);
  }
}
