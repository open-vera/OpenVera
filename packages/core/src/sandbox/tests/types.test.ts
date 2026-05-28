import { describe, expect, it } from "vitest";
import {
  SandboxError,
  SandboxNotFoundError,
  SandboxTimeoutError,
  SandboxExecError,
  SandboxConnectionError,
  SandboxQuotaError,
} from "../types.js";
import type {
  SandboxProvider,
  SandboxInstance,
  SandboxStatus,
  SandboxCreateOptions,
  SandboxResources,
  SandboxExecOptions,
  SandboxExecResult,
} from "../types.js";

// ── Error Classes ──────────────────────────────────────────────────────────

describe("SandboxError", () => {
  it("creates with code and message", () => {
    const err = new SandboxError("TEST_CODE", "test message");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.name).toBe("SandboxError");
  });

  it("supports ErrorOptions (cause)", () => {
    const cause = new Error("root cause");
    const err = new SandboxError("WRAP", "wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("SandboxNotFoundError", () => {
  it("creates with sandbox ID", () => {
    const err = new SandboxNotFoundError("sb-123");
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe("SANDBOX_NOT_FOUND");
    expect(err.message).toContain("sb-123");
    expect(err.name).toBe("SandboxNotFoundError");
  });
});

describe("SandboxTimeoutError", () => {
  it("creates with sandbox ID and timeout", () => {
    const err = new SandboxTimeoutError("sb-123", 30);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe("SANDBOX_TIMEOUT");
    expect(err.message).toContain("sb-123");
    expect(err.message).toContain("30s");
    expect(err.name).toBe("SandboxTimeoutError");
  });
});

describe("SandboxExecError", () => {
  it("creates with sandbox ID, exit code, and stderr", () => {
    const err = new SandboxExecError("sb-123", 1, "command not found");
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe("SANDBOX_EXEC_ERROR");
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe("command not found");
    expect(err.message).toContain("sb-123");
    expect(err.message).toContain("exit 1");
    expect(err.name).toBe("SandboxExecError");
  });
});

describe("SandboxConnectionError", () => {
  it("creates with provider and detail", () => {
    const err = new SandboxConnectionError("cubesandbox", "connection refused");
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe("SANDBOX_CONNECTION");
    expect(err.message).toContain("cubesandbox");
    expect(err.message).toContain("connection refused");
    expect(err.name).toBe("SandboxConnectionError");
  });
});

describe("SandboxQuotaError", () => {
  it("creates with provider and detail", () => {
    const err = new SandboxQuotaError("cubesandbox", "max 10 sandboxes reached");
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe("SANDBOX_QUOTA");
    expect(err.message).toContain("max 10 sandboxes reached");
    expect(err.name).toBe("SandboxQuotaError");
  });
});

// ── Type Compilation Checks ────────────────────────────────────────────────

describe("type compilation checks", () => {
  it("SandboxProvider interface is usable", () => {
    // Verify the interface compiles by creating a minimal implementation
    const provider: SandboxProvider = {
      name: "test",
      create: async () => ({}) as SandboxInstance,
      list: async () => [],
      get: async () => undefined,
      destroy: async () => {},
      destroyAll: async () => {},
    };
    expect(provider.name).toBe("test");
  });

  it("SandboxInstance interface is usable", () => {
    const instance: SandboxInstance = {
      id: "sb-1",
      status: "ready",
      provider: "test",
      createdAt: new Date(),
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 0,
      }),
      upload: async () => {},
      uploadContent: async () => {},
      download: async () => {},
      readFile: async () => "",
      stop: async () => {},
      resume: async () => {},
      destroy: async () => {},
    };
    expect(instance.id).toBe("sb-1");
    expect(instance.status).toBe("ready");
  });

  it("SandboxStatus covers all expected states", () => {
    const statuses: SandboxStatus[] = [
      "creating",
      "ready",
      "running",
      "stopped",
      "error",
      "destroyed",
    ];
    expect(statuses).toHaveLength(6);
  });

  it("SandboxCreateOptions accepts all fields", () => {
    const opts: SandboxCreateOptions = {
      image: "node:20",
      workdir: "/app",
      env: { NODE_ENV: "test" },
      resources: { cpuCores: 2, memoryMb: 512, diskMb: 1024, gpuCount: 0 },
      timeoutSeconds: 300,
      tags: { project: "test" },
      networkMode: "bridge",
      volumes: [{ hostPath: "/tmp/data", containerPath: "/data", readOnly: false }],
    };
    expect(opts.image).toBe("node:20");
  });

  it("SandboxExecOptions accepts all fields", () => {
    const opts: SandboxExecOptions = {
      workdir: "/app",
      env: { DEBUG: "1" },
      timeoutSeconds: 60,
      stdin: "input data",
      background: false,
    };
    expect(opts.timeoutSeconds).toBe(60);
  });

  it("SandboxExecResult has correct shape", () => {
    const result: SandboxExecResult = {
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      timedOut: false,
      durationMs: 150,
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("SandboxResources accepts optional fields", () => {
    const res: SandboxResources = {
      cpuCores: 1,
      memoryMb: 256,
    };
    expect(res.cpuCores).toBe(1);
    expect(res.diskMb).toBeUndefined();
    expect(res.gpuCount).toBeUndefined();
  });
});
