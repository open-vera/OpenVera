/**
 * CubeSandbox Adapter Tests — HTTP API client for CubeSandbox microVM.
 *
 * Tests cover:
 * - Provider methods: create, list, get, destroy, destroyAll
 * - Instance methods: exec, uploadContent, readFile, stop, resume, destroy
 * - Error scenarios: connection error, not found, timeout
 * - Configuration: baseUrl, apiKey, defaultImage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CubeSandboxProvider } from "../cubesandbox.js";
import {
  SandboxNotFoundError,
  SandboxConnectionError,
  SandboxTimeoutError,
} from "../types.js";

// ── Mock Helpers ──────────────────────────────────────────────────────────

const BASE_URL = "http://sandbox.test:9090";
const API_KEY = "test-api-key-123";

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}) {
  const {
    ok = true,
    status = 200,
    body = {},
    contentType = "application/json",
    headers = {},
  } = response;

  const responseBody = typeof body === "string" ? body : JSON.stringify(body);

  return vi.fn().mockResolvedValue({
    ok,
    status,
    headers: new Map<string, string>([
      ["content-type", contentType],
      ...Object.entries(headers),
    ]),
    text: () => Promise.resolve(responseBody),
    json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
  });
}

function makeSandboxResponse(overrides?: Partial<{
  id: string;
  status: string;
  createdAt: string;
  image: string;
}>) {
  return {
    id: overrides?.id ?? "sb-test-001",
    status: overrides?.status ?? "ready",
    createdAt: overrides?.createdAt ?? "2026-05-28T00:00:00Z",
    image: overrides?.image ?? "ubuntu:22.04",
  };
}

// ── Provider Tests ────────────────────────────────────────────────────────

describe("CubeSandboxProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("configuration", () => {
    it("uses default baseUrl when none provided", () => {
      const provider = new CubeSandboxProvider({ apiKey: "key" });
      expect(provider.name).toBe("cubesandbox");
    });

    it("strips trailing slashes from baseUrl", async () => {
      const fetchMock = mockFetch({ body: { sandboxes: [] } });
      globalThis.fetch = fetchMock;

      const provider = new CubeSandboxProvider({
        baseUrl: "http://example.com///",
        apiKey: "key",
      });
      await provider.list();

      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      expect(calledUrl).toBe("http://example.com/sandboxes");
    });

    it("uses provided apiKey in Authorization header", async () => {
      const fetchMock = mockFetch({ body: { sandboxes: [] } });
      globalThis.fetch = fetchMock;

      const provider = new CubeSandboxProvider({
        baseUrl: BASE_URL,
        apiKey: "my-secret",
      });
      await provider.list();

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer my-secret");
    });
  });

  describe("create()", () => {
    it("creates a sandbox with default image", async () => {
      const sbData = makeSandboxResponse();
      globalThis.fetch = mockFetch({ body: sbData });

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      const instance = await provider.create();

      expect(instance.id).toBe("sb-test-001");
      expect(instance.status).toBe("ready");
      expect(instance.provider).toBe("cubesandbox");
      expect(instance.createdAt).toEqual(new Date("2026-05-28T00:00:00Z"));
    });

    it("creates a sandbox with custom image and options", async () => {
      const fetchMock = mockFetch({ body: makeSandboxResponse({ id: "sb-custom" }) });
      globalThis.fetch = fetchMock;

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      await provider.create({
        image: "node:20",
        workdir: "/app",
        env: { NODE_ENV: "test" },
        timeoutSeconds: 300,
        resources: { cpuCores: 2, memoryMb: 512 },
      });

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.image).toBe("node:20");
      expect(body.workdir).toBe("/app");
      expect(body.env).toEqual({ NODE_ENV: "test" });
      expect(body.timeoutSeconds).toBe(300);
      expect(body.resources).toEqual({ cpuCores: 2, memoryMb: 512 });
    });

    it("throws SandboxConnectionError on HTTP error", async () => {
      globalThis.fetch = mockFetch({ ok: false, status: 500, body: "internal error" });

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      await expect(provider.create()).rejects.toThrow(SandboxConnectionError);
    });
  });

  describe("list()", () => {
    it("returns list of sandbox instances", async () => {
      globalThis.fetch = mockFetch({
        body: {
          sandboxes: [
            makeSandboxResponse({ id: "sb-1" }),
            makeSandboxResponse({ id: "sb-2", status: "running" }),
          ],
        },
      });

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      const instances = await provider.list();

      expect(instances).toHaveLength(2);
      expect(instances[0]!.id).toBe("sb-1");
      expect(instances[0]!.status).toBe("ready");
      expect(instances[1]!.id).toBe("sb-2");
      expect(instances[1]!.status).toBe("running");
    });

    it("returns empty list when no sandboxes exist", async () => {
      globalThis.fetch = mockFetch({ body: { sandboxes: [] } });

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      const instances = await provider.list();

      expect(instances).toHaveLength(0);
    });
  });

  describe("get()", () => {
    it("returns sandbox instance by ID", async () => {
      globalThis.fetch = mockFetch({ body: makeSandboxResponse({ id: "sb-42" }) });

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      const instance = await provider.get("sb-42");

      expect(instance).toBeDefined();
      expect(instance!.id).toBe("sb-42");
    });

    it("returns undefined for 404", async () => {
      globalThis.fetch = mockFetch({ ok: false, status: 404, body: "not found" });

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      const instance = await provider.get("nonexistent");

      expect(instance).toBeUndefined();
    });
  });

  describe("destroy()", () => {
    it("sends DELETE request for sandbox", async () => {
      const fetchMock = mockFetch({ body: {} });
      globalThis.fetch = fetchMock;

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      await provider.destroy("sb-to-destroy");

      expect(fetchMock).toHaveBeenCalledOnce();
      const url = fetchMock.mock.calls[0]![0] as string;
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(url).toBe(`${BASE_URL}/sandboxes/sb-to-destroy`);
      expect(init.method).toBe("DELETE");
    });

    it("throws SandboxNotFoundError on 404", async () => {
      globalThis.fetch = mockFetch({ ok: false, status: 404, body: "not found" });

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      await expect(provider.destroy("nonexistent")).rejects.toThrow(SandboxNotFoundError);
    });
  });

  describe("destroyAll()", () => {
    it("sends DELETE request to sandboxes endpoint", async () => {
      const fetchMock = mockFetch({ body: {} });
      globalThis.fetch = fetchMock;

      const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
      await provider.destroyAll();

      const url = fetchMock.mock.calls[0]![0] as string;
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(url).toBe(`${BASE_URL}/sandboxes`);
      expect(init.method).toBe("DELETE");
    });
  });
});

// ── Instance Tests ────────────────────────────────────────────────────────

describe("CubeSandboxInstance", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function createInstance() {
    globalThis.fetch = mockFetch({ body: makeSandboxResponse() });
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    return provider.create();
  }

  describe("exec()", () => {
    it("executes a command and returns result", async () => {
      globalThis.fetch = mockFetch({
        body: {
          exitCode: 0,
          stdout: "hello world",
          stderr: "",
          timedOut: false,
          durationMs: 120,
        },
      });

      const instance = await createInstance();
      globalThis.fetch = mockFetch({
        body: {
          exitCode: 0,
          stdout: "hello world",
          stderr: "",
          timedOut: false,
          durationMs: 120,
        },
      });

      const result = await instance.exec("echo hello world");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBe(120);
    });

    it("sends exec options in request body", async () => {
      globalThis.fetch = mockFetch({
        body: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 10 },
      });

      const instance = await createInstance();
      const fetchMock = mockFetch({
        body: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 10 },
      });
      globalThis.fetch = fetchMock;

      await instance.exec("ls -la", {
        workdir: "/tmp",
        env: { DEBUG: "1" },
        timeoutSeconds: 30,
        stdin: "input",
      });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.command).toBe("ls -la");
      expect(body.workdir).toBe("/tmp");
      expect(body.env).toEqual({ DEBUG: "1" });
      expect(body.timeoutSeconds).toBe(30);
      expect(body.stdin).toBe("input");
    });

    it("handles non-zero exit codes", async () => {
      globalThis.fetch = mockFetch({
        body: {
          exitCode: 1,
          stdout: "",
          stderr: "command not found",
          timedOut: false,
          durationMs: 50,
        },
      });

      const instance = await createInstance();
      globalThis.fetch = mockFetch({
        body: {
          exitCode: 1,
          stdout: "",
          stderr: "command not found",
          timedOut: false,
          durationMs: 50,
        },
      });

      const result = await instance.exec("bad-command");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("command not found");
    });
  });

  describe("uploadContent()", () => {
    it("uploads string content as base64", async () => {
      const fetchMock = mockFetch({ body: {} });
      globalThis.fetch = fetchMock;

      const instance = await createInstance();
      const uploadMock = mockFetch({ body: {} });
      globalThis.fetch = uploadMock;

      await instance.uploadContent("hello world", "/tmp/test.txt");

      const body = JSON.parse((uploadMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.encoding).toBe("base64");
      expect(Buffer.from(body.content, "base64").toString("utf-8")).toBe("hello world");
    });

    it("uploads Uint8Array content as base64", async () => {
      const fetchMock = mockFetch({ body: {} });
      globalThis.fetch = fetchMock;

      const instance = await createInstance();
      const uploadMock = mockFetch({ body: {} });
      globalThis.fetch = uploadMock;

      const data = new Uint8Array([72, 101, 108, 108, 111]);
      await instance.uploadContent(data, "/tmp/bin.dat");

      const body = JSON.parse((uploadMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.encoding).toBe("base64");
      expect(Buffer.from(body.content, "base64").toString("utf-8")).toBe("Hello");
    });
  });

  describe("readFile()", () => {
    it("reads file content and decodes base64", async () => {
      globalThis.fetch = mockFetch({
        body: {
          content: Buffer.from("file content here").toString("base64"),
          encoding: "base64",
        },
      });

      const instance = await createInstance();
      globalThis.fetch = mockFetch({
        body: {
          content: Buffer.from("file content here").toString("base64"),
          encoding: "base64",
        },
      });

      const content = await instance.readFile("/tmp/test.txt");
      expect(content).toBe("file content here");
    });

    it("reads file content with utf-8 encoding", async () => {
      globalThis.fetch = mockFetch({
        body: { content: "plain text content", encoding: "utf-8" },
      });

      const instance = await createInstance();
      globalThis.fetch = mockFetch({
        body: { content: "plain text content", encoding: "utf-8" },
      });

      const content = await instance.readFile("/tmp/test.txt");
      expect(content).toBe("plain text content");
    });
  });

  describe("stop()", () => {
    it("stops the sandbox and updates status", async () => {
      globalThis.fetch = mockFetch({ body: makeSandboxResponse() });
      const instance = await createInstance();

      const stopMock = mockFetch({ body: {} });
      globalThis.fetch = stopMock;

      await instance.stop();

      expect(instance.status).toBe("stopped");
      const url = stopMock.mock.calls[0]![0] as string;
      expect(url).toContain("/stop");
    });
  });

  describe("resume()", () => {
    it("resumes the sandbox and updates status", async () => {
      globalThis.fetch = mockFetch({ body: makeSandboxResponse() });
      const instance = await createInstance();

      // Stop first
      globalThis.fetch = mockFetch({ body: {} });
      await instance.stop();
      expect(instance.status).toBe("stopped");

      // Resume
      const resumeMock = mockFetch({ body: {} });
      globalThis.fetch = resumeMock;
      await instance.resume();

      expect(instance.status).toBe("ready");
      const url = resumeMock.mock.calls[0]![0] as string;
      expect(url).toContain("/resume");
    });
  });

  describe("destroy()", () => {
    it("destroys the sandbox and updates status", async () => {
      globalThis.fetch = mockFetch({ body: makeSandboxResponse() });
      const instance = await createInstance();

      const destroyMock = mockFetch({ body: {} });
      globalThis.fetch = destroyMock;

      await instance.destroy();

      expect(instance.status).toBe("destroyed");
      const url = destroyMock.mock.calls[0]![0] as string;
      const method = (destroyMock.mock.calls[0]![1] as RequestInit).method;
      expect(url).toContain(`/sandboxes/${instance.id}`);
      expect(method).toBe("DELETE");
    });
  });
});

// ── Error Scenario Tests ──────────────────────────────────────────────────

describe("CubeSandbox error scenarios", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws SandboxConnectionError when fetch fails (network error)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    await expect(provider.list()).rejects.toThrow(SandboxConnectionError);
  });

  it("throws SandboxConnectionError on non-2xx HTTP status", async () => {
    globalThis.fetch = mockFetch({ ok: false, status: 503, body: "service unavailable" });

    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    await expect(provider.list()).rejects.toThrow(SandboxConnectionError);
  });

  it("throws SandboxNotFoundError on 404 for provider-level operations", async () => {
    globalThis.fetch = mockFetch({ ok: false, status: 404, body: "not found" });

    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    await expect(provider.destroy("nonexistent")).rejects.toThrow(SandboxNotFoundError);
  });

  it("throws SandboxConnectionError on timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      () => new Promise((_, reject) => {
        setTimeout(() => {
          const err = new DOMException("The operation was aborted", "AbortError");
          reject(err);
        }, 50);
      }),
    );

    const provider = new CubeSandboxProvider({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      requestTimeoutMs: 10,
    });
    await expect(provider.list()).rejects.toThrow(SandboxConnectionError);
  });

  it("wraps unknown errors in SandboxConnectionError", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("unexpected failure"));

    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    await expect(provider.create()).rejects.toThrow(SandboxConnectionError);
  });

  it("handles instance-level 404 with SandboxNotFoundError", async () => {
    globalThis.fetch = mockFetch({ body: makeSandboxResponse() });
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    const instance = await provider.create();

    globalThis.fetch = mockFetch({ ok: false, status: 404, body: "not found" });
    await expect(instance.exec("ls")).rejects.toThrow(SandboxNotFoundError);
  });

  it("handles instance-level connection error", async () => {
    globalThis.fetch = mockFetch({ body: makeSandboxResponse() });
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    const instance = await provider.create();

    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(instance.readFile("/tmp/x")).rejects.toThrow(SandboxConnectionError);
  });
});

// ── Status Mapping Tests ──────────────────────────────────────────────────

describe("CubeSandbox status mapping", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ["creating", "creating"],
    ["ready", "ready"],
    ["running", "running"],
    ["stopped", "stopped"],
    ["error", "error"],
    ["destroyed", "destroyed"],
    ["unknown", "ready"],
  ] as const)("maps API status '%s' to SandboxStatus '%s'", async (apiStatus, expected) => {
    globalThis.fetch = mockFetch({
      body: makeSandboxResponse({ status: apiStatus }),
    });
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    const instance = await provider.create();
    expect(instance.status).toBe(expected);
  });
});

// ── Authorization Header Tests ────────────────────────────────────────────

describe("CubeSandbox authorization", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Bearer token in Authorization header for all requests", async () => {
    const fetchMock = mockFetch({ body: makeSandboxResponse() });
    globalThis.fetch = fetchMock;

    const provider = new CubeSandboxProvider({
      baseUrl: BASE_URL,
      apiKey: "sk-test-key",
    });
    await provider.create();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-key");
  });

  it("includes Content-Type for requests with body", async () => {
    const fetchMock = mockFetch({ body: makeSandboxResponse() });
    globalThis.fetch = fetchMock;

    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    await provider.create({ image: "node:20" });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
