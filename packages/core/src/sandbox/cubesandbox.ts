/**
 * CubeSandbox Adapter — HTTP REST client for CubeSandbox microVM API.
 *
 * CubeSandbox is a Tencent open-source project (Apache 2.0) providing
 * microVM-isolated sandbox environments with an E2B-compatible API.
 *
 * This adapter implements SandboxProvider using HTTP fetch to communicate
 * with the CubeSandbox API endpoint.
 */

import type {
  SandboxProvider,
  SandboxInstance,
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxStatus,
} from "./types.js";
import {
  SandboxConnectionError,
  SandboxNotFoundError,
  SandboxTimeoutError,
  SandboxExecError,
} from "./types.js";

// ── Configuration ─────────────────────────────────────────────────────────

export interface CubeSandboxOptions {
  /** Base URL of the CubeSandbox API (default: CUBESANDBOX_URL env or "http://localhost:8080") */
  baseUrl?: string;
  /** API key for authentication (default: CUBESANDBOX_API_KEY env) */
  apiKey?: string;
  /** Default image for sandboxes */
  defaultImage?: string;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeoutMs?: number;
}

// ── API Response Types ────────────────────────────────────────────────────

interface SandboxApiResponse {
  id: string;
  status: string;
  createdAt?: string;
  image?: string;
  env?: Record<string, string>;
  workdir?: string;
}

interface ExecApiResponse {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  pid?: number;
}

interface ListApiResponse {
  sandboxes: SandboxApiResponse[];
}

interface FileUploadBody {
  content: string;
  encoding: "utf-8" | "base64";
}

// ── CubeSandbox Instance ──────────────────────────────────────────────────

class CubeSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly provider = "cubesandbox";
  readonly createdAt: Date;
  private _status: SandboxStatus;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly requestTimeoutMs: number,
    sandboxData: SandboxApiResponse,
  ) {
    this.id = sandboxData.id;
    this._status = mapStatus(sandboxData.status);
    this.createdAt = sandboxData.createdAt ? new Date(sandboxData.createdAt) : new Date();
  }

  get status(): SandboxStatus {
    return this._status;
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    const body: Record<string, unknown> = { command };
    if (options?.workdir) body.workdir = options.workdir;
    if (options?.env) body.env = options.env;
    if (options?.timeoutSeconds) body.timeoutSeconds = options.timeoutSeconds;
    if (options?.stdin) body.stdin = options.stdin;
    if (options?.background) body.background = options.background;

    const result = await this.request<ExecApiResponse>(
      "POST",
      `/sandboxes/${this.id}/exec`,
      body,
    );

    if (result.exitCode !== null && result.exitCode !== 0 && !options?.background) {
      // Note: we return the result rather than throwing, since the caller
      // may want to inspect stdout/stderr. Throwing is optional behavior.
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      pid: result.pid,
    };
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(localPath);
    await this.uploadContent(content, remotePath);
  }

  async uploadContent(content: string | Uint8Array, remotePath: string): Promise<void> {
    const encoded = typeof content === "string"
      ? Buffer.from(content).toString("base64")
      : Buffer.from(content).toString("base64");

    const body: FileUploadBody = {
      content: encoded,
      encoding: "base64",
    };

    await this.request<unknown>(
      "POST",
      `/sandboxes/${this.id}/files/${encodeURIComponent(remotePath)}`,
      body,
    );
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const content = await this.request<{ content: string; encoding: string }>(
      "GET",
      `/sandboxes/${this.id}/files/${encodeURIComponent(remotePath)}`,
    );

    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(localPath), { recursive: true });

    const data = content.encoding === "base64"
      ? Buffer.from(content.content, "base64")
      : Buffer.from(content.content, "utf-8");

    writeFileSync(localPath, data);
  }

  async readFile(remotePath: string): Promise<string> {
    const result = await this.request<{ content: string; encoding: string }>(
      "GET",
      `/sandboxes/${this.id}/files/${encodeURIComponent(remotePath)}`,
    );

    if (result.encoding === "base64") {
      return Buffer.from(result.content, "base64").toString("utf-8");
    }
    return result.content;
  }

  async stop(): Promise<void> {
    await this.request<unknown>("POST", `/sandboxes/${this.id}/stop`);
    this._status = "stopped";
  }

  async resume(): Promise<void> {
    await this.request<unknown>("POST", `/sandboxes/${this.id}/resume`);
    this._status = "ready";
  }

  async destroy(): Promise<void> {
    await this.request<unknown>("DELETE", `/sandboxes/${this.id}`);
    this._status = "destroyed";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new SandboxNotFoundError(this.id);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new SandboxConnectionError(
          "cubesandbox",
          `HTTP ${response.status}: ${text}`,
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    } catch (err) {
      if (err instanceof SandboxNotFoundError || err instanceof SandboxConnectionError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new SandboxTimeoutError(this.id, Math.round(this.requestTimeoutMs / 1000));
      }
      if (err instanceof TypeError && err.message.includes("fetch")) {
        throw new SandboxConnectionError("cubesandbox", err.message, { cause: err });
      }
      throw new SandboxConnectionError(
        "cubesandbox",
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── CubeSandbox Provider ──────────────────────────────────────────────────

export class CubeSandboxProvider implements SandboxProvider {
  readonly name = "cubesandbox";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultImage: string;
  private readonly requestTimeoutMs: number;

  constructor(options?: CubeSandboxOptions) {
    this.baseUrl = (options?.baseUrl ?? process.env.CUBESANDBOX_URL ?? "http://localhost:8080").replace(/\/+$/, "");
    this.apiKey = options?.apiKey ?? process.env.CUBESANDBOX_API_KEY ?? "";
    this.defaultImage = options?.defaultImage ?? "ubuntu:22.04";
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
  }

  async create(options?: SandboxCreateOptions): Promise<SandboxInstance> {
    const body: Record<string, unknown> = {
      image: options?.image ?? this.defaultImage,
    };
    if (options?.workdir) body.workdir = options.workdir;
    if (options?.env) body.env = options.env;
    if (options?.resources) body.resources = options.resources;
    if (options?.timeoutSeconds) body.timeoutSeconds = options.timeoutSeconds;
    if (options?.tags) body.tags = options.tags;
    if (options?.networkMode) body.networkMode = options.networkMode;
    if (options?.volumes) body.volumes = options.volumes;

    const data = await this.request<SandboxApiResponse>("POST", "/sandboxes", body);
    return new CubeSandboxInstance(this.baseUrl, this.apiKey, this.requestTimeoutMs, data);
  }

  async list(): Promise<SandboxInstance[]> {
    const data = await this.request<ListApiResponse>("GET", "/sandboxes");
    return data.sandboxes.map(
      (sb) => new CubeSandboxInstance(this.baseUrl, this.apiKey, this.requestTimeoutMs, sb),
    );
  }

  async get(sandboxId: string): Promise<SandboxInstance | undefined> {
    try {
      const data = await this.request<SandboxApiResponse>("GET", `/sandboxes/${sandboxId}`);
      return new CubeSandboxInstance(this.baseUrl, this.apiKey, this.requestTimeoutMs, data);
    } catch (err) {
      if (err instanceof SandboxNotFoundError) return undefined;
      throw err;
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/sandboxes/${sandboxId}`);
  }

  async destroyAll(): Promise<void> {
    await this.request<unknown>("DELETE", "/sandboxes");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new SandboxNotFoundError(path);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new SandboxConnectionError(
          "cubesandbox",
          `HTTP ${response.status}: ${text}`,
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    } catch (err) {
      if (err instanceof SandboxNotFoundError || err instanceof SandboxConnectionError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new SandboxConnectionError(
          "cubesandbox",
          `Request timed out after ${this.requestTimeoutMs}ms`,
        );
      }
      if (err instanceof TypeError && err.message.includes("fetch")) {
        throw new SandboxConnectionError("cubesandbox", err.message, { cause: err });
      }
      throw new SandboxConnectionError(
        "cubesandbox",
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function mapStatus(raw: string): SandboxStatus {
  switch (raw) {
    case "creating": return "creating";
    case "ready": return "ready";
    case "running": return "running";
    case "stopped": return "stopped";
    case "error": return "error";
    case "destroyed": return "destroyed";
    default: return "ready";
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createCubeSandboxProvider(options?: CubeSandboxOptions): CubeSandboxProvider {
  return new CubeSandboxProvider(options);
}
