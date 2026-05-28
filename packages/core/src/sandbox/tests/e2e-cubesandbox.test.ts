/**
 * SB10 — CubeSandbox E2E: Full lifecycle test (create → upload → exec → download → destroy).
 *
 * Uses mocked HTTP fetch to simulate the CubeSandbox API without a real server.
 * Tests the complete flow that an agent would go through.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CubeSandboxProvider } from "../cubesandbox.js";
import {
  SandboxNotFoundError,
  SandboxConnectionError,
} from "../types.js";

// ── Mock Setup ──────────────────────────────────────────────────────────────

const BASE_URL = "http://sandbox.e2e.test:8080";
const API_KEY = "e2e-test-key";

interface MockCall {
  method: string;
  url: string;
  body?: unknown;
}

let callLog: MockCall[] = [];
let sandboxState: Map<string, { status: string; files: Map<string, string> }> = new Map();
let nextSandboxId = 1;

function resetState(): void {
  callLog = [];
  sandboxState = new Map();
  nextSandboxId = 1;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "text/plain"]]),
    text: () => Promise.resolve(body),
    json: () => Promise.reject(new Error("not json")),
  } as unknown as Response;
}

function setupMockFetch(): void {
  globalThis.fetch = vi.fn().mockImplementation(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const urlStr = typeof url === "string" ? url : url.toString();

      callLog.push({ method, url: urlStr, body });

      // ── POST /sandboxes — create ──
      if (method === "POST" && urlStr.endsWith("/sandboxes") && !urlStr.includes("/exec") && !urlStr.includes("/files/")) {
        const id = `sb-e2e-${nextSandboxId++}`;
        sandboxState.set(id, { status: "ready", files: new Map() });
        return jsonResponse({
          id,
          status: "ready",
          createdAt: new Date().toISOString(),
          image: body?.image ?? "ubuntu:22.04",
        });
      }

      // ── POST /sandboxes/:id/exec ──
      const execMatch = urlStr.match(/\/sandboxes\/([^/]+)\/exec$/);
      if (method === "POST" && execMatch) {
        const id = execMatch[1]!;
        const sb = sandboxState.get(id);
        if (!sb) return textResponse("not found", 404);

        const command = body?.command as string ?? "";
        let stdout = "";
        let exitCode = 0;

        if (command === "echo hello") {
          stdout = "hello\n";
        } else if (command.startsWith("cat ")) {
          const filePath = command.slice(4).trim();
          stdout = sb.files.get(filePath) ?? `cat: ${filePath}: No such file or directory`;
          if (!sb.files.has(filePath)) exitCode = 1;
        } else if (command.startsWith("wc -c ")) {
          const filePath = command.slice(6).trim();
          const content = sb.files.get(filePath) ?? "";
          stdout = `${content.length}`;
        } else {
          stdout = `executed: ${command}`;
        }

        return jsonResponse({
          exitCode,
          stdout,
          stderr: "",
          timedOut: false,
          durationMs: 42,
        });
      }

      // ── POST /sandboxes/:id/files/:path — upload ──
      // URL path may contain %2F for slashes, match on /sandboxes/ID/files/ with anything after
      const uploadMatch = urlStr.match(/\/sandboxes\/([^/]+)\/files\/(.*)/);
      if (method === "POST" && uploadMatch) {
        const id = uploadMatch[1]!;
        const filePath = decodeURIComponent(uploadMatch[2]!);
        const sb = sandboxState.get(id);
        if (!sb) return textResponse("not found", 404);

        const content = body?.encoding === "base64"
          ? Buffer.from(body.content, "base64").toString("utf-8")
          : body?.content ?? "";
        sb.files.set(filePath, content);
        return jsonResponse({ ok: true });
      }

      // ── GET /sandboxes/:id/files/:path — download/read ──
      const downloadMatch = urlStr.match(/\/sandboxes\/([^/]+)\/files\/(.*)/);
      if (method === "GET" && downloadMatch) {
        const id = downloadMatch[1]!;
        const filePath = decodeURIComponent(downloadMatch[2]!);
        const sb = sandboxState.get(id);
        if (!sb) return textResponse("not found", 404);

        const content = sb.files.get(filePath);
        if (content === undefined) return textResponse("not found", 404);

        return jsonResponse({
          content: Buffer.from(content).toString("base64"),
          encoding: "base64",
        });
      }

      // ── POST /sandboxes/:id/stop ──
      const stopMatch = urlStr.match(/\/sandboxes\/([^/]+)\/stop$/);
      if (method === "POST" && stopMatch) {
        const sb = sandboxState.get(stopMatch[1]!);
        if (sb) sb.status = "stopped";
        return jsonResponse({ ok: true });
      }

      // ── POST /sandboxes/:id/resume ──
      const resumeMatch = urlStr.match(/\/sandboxes\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch) {
        const sb = sandboxState.get(resumeMatch[1]!);
        if (sb) sb.status = "ready";
        return jsonResponse({ ok: true });
      }

      // ── DELETE /sandboxes/:id — destroy ──
      const deleteMatch = urlStr.match(/\/sandboxes\/([^/]+)$/);
      if (method === "DELETE" && deleteMatch) {
        const id = deleteMatch[1]!;
        if (!sandboxState.has(id)) return textResponse("not found", 404);
        sandboxState.delete(id);
        return jsonResponse({ ok: true });
      }

      // ── GET /sandboxes/:id — get by ID ──
      const getOneMatch = urlStr.match(/\/sandboxes\/([^/]+)$/);
      if (method === "GET" && getOneMatch) {
        const id = getOneMatch[1]!;
        const sb = sandboxState.get(id);
        if (!sb) return textResponse("not found", 404);
        return jsonResponse({
          id,
          status: sb.status,
          createdAt: new Date().toISOString(),
        });
      }

      // ── GET /sandboxes — list ──
      if (method === "GET" && urlStr.endsWith("/sandboxes")) {
        const sandboxes = Array.from(sandboxState.entries()).map(([id, sb]) => ({
          id,
          status: sb.status,
          createdAt: new Date().toISOString(),
        }));
        return jsonResponse({ sandboxes });
      }

      return textResponse("not found", 404);
    },
  );
}

// ── E2E Tests ───────────────────────────────────────────────────────────────

describe("SB10: CubeSandbox E2E — full lifecycle", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetState();
    setupMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("create → exec → destroy lifecycle", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    // Create
    const instance = await provider.create({ image: "ubuntu:22.04" });
    expect(instance.id).toMatch(/^sb-e2e-/);
    expect(instance.status).toBe("ready");

    // Exec
    const result = await instance.exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");

    // Destroy
    await instance.destroy();
    expect(instance.status).toBe("destroyed");
  });

  it("create → upload → exec (cat) → readFile → destroy", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    const instance = await provider.create();

    // Upload a file
    await instance.uploadContent("Hello, sandbox!", "/tmp/greeting.txt");

    // Execute cat to read it back
    const execResult = await instance.exec("cat /tmp/greeting.txt");
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toBe("Hello, sandbox!");

    // Read file via API
    const content = await instance.readFile("/tmp/greeting.txt");
    expect(content).toBe("Hello, sandbox!");

    await instance.destroy();
  });

  it("create → upload multiple files → exec pipeline → destroy", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    const instance = await provider.create({ image: "python:3.12" });

    // Upload script and data
    await instance.uploadContent("print('hello from script')", "/app/main.py");
    await instance.uploadContent("key=value", "/app/config.env");

    // Verify files are readable
    const script = await instance.readFile("/app/main.py");
    expect(script).toBe("print('hello from script')");

    const config = await instance.readFile("/app/config.env");
    expect(config).toBe("key=value");

    // Exec a command
    const result = await instance.exec("wc -c /app/main.py");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("26"); // len("print('hello from script')")

    await instance.destroy();
  });

  it("stop → resume → exec → destroy", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    const instance = await provider.create();
    expect(instance.status).toBe("ready");

    // Stop
    await instance.stop();
    expect(instance.status).toBe("stopped");

    // Resume
    await instance.resume();
    expect(instance.status).toBe("ready");

    // Exec after resume
    const result = await instance.exec("echo hello");
    expect(result.exitCode).toBe(0);

    await instance.destroy();
  });

  it("provider list → get → destroy lifecycle", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    // Create two sandboxes
    const sb1 = await provider.create({ image: "node:20" });
    const sb2 = await provider.create({ image: "python:3.12" });

    // List
    const list = await provider.list();
    expect(list.length).toBeGreaterThanOrEqual(2);

    // Get specific
    const retrieved = await provider.get(sb1.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(sb1.id);

    // Destroy one
    await provider.destroy(sb1.id);

    // Get destroyed → undefined
    const gone = await provider.get(sb1.id);
    expect(gone).toBeUndefined();

    // Cleanup
    await provider.destroy(sb2.id);
  });

  it("handles API errors gracefully", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });
    const instance = await provider.create();

    // Read non-existent file
    await expect(instance.readFile("/nonexistent")).rejects.toThrow();

    await instance.destroy();
  });

  it("multiple sandboxes can execute concurrently", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    // Create 3 sandboxes concurrently
    const instances = await Promise.all([
      provider.create(),
      provider.create(),
      provider.create(),
    ]);

    expect(instances).toHaveLength(3);

    // Execute on all concurrently
    const results = await Promise.all(
      instances.map((inst) => inst.exec("echo hello")),
    );

    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    }

    // Destroy all
    await Promise.all(instances.map((inst) => inst.destroy()));
  });

  it("tracks API call sequence correctly", async () => {
    const provider = new CubeSandboxProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    const instance = await provider.create({ image: "ubuntu:22.04" });
    await instance.uploadContent("data", "/tmp/test.txt");
    await instance.exec("cat /tmp/test.txt");
    await instance.destroy();

    // Verify call sequence
    const methods = callLog.map((c) => {
      const pathname = new URL(c.url).pathname;
      return `${c.method} ${decodeURIComponent(pathname)}`;
    });
    expect(methods).toEqual([
      "POST /sandboxes",                              // create
      "POST /sandboxes/sb-e2e-1/files//tmp/test.txt",  // upload (leading / from remotePath)
      "POST /sandboxes/sb-e2e-1/exec",                // exec
      "DELETE /sandboxes/sb-e2e-1",                    // destroy
    ]);
  });
});
