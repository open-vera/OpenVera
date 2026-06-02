/**
 * Tests for sandbox tools (sandbox.ts)
 *
 * Covers: sandbox_exec, sandbox_upload, sandbox_download, createSandboxTools bundle.
 * Exercises all branches: success paths, missing provider, missing sandbox,
 * exec errors, timeouts, upload by localPath / content, download to file / readFile,
 * and exception handling in every tool.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createSandboxExecTool,
  createSandboxUploadTool,
  createSandboxDownloadTool,
  createSandboxTools,
} from "../sandbox.js";
import type { ToolContext } from "../types.js";
import type {
  SandboxProvider,
  SandboxInstance,
} from "../../sandbox/types.js";

// ── Mock helpers ───────────────────────────────────────────────────────────────

function mockInstance(overrides: Partial<SandboxInstance> = {}): SandboxInstance {
  return {
    id: "sb-test",
    status: "ready",
    provider: "test",
    createdAt: new Date(),
    exec: vi.fn(async () => ({
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      timedOut: false,
      durationMs: 100,
    })),
    upload: vi.fn(async () => {}),
    uploadContent: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    readFile: vi.fn(async () => "file content"),
    stop: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    ...overrides,
  };
}

function mockProvider(instance?: SandboxInstance): SandboxProvider {
  return {
    name: "test",
    create: vi.fn(async () => instance ?? mockInstance()),
    list: vi.fn(async () => (instance ? [instance] : [])),
    get: vi.fn(async (id: string) => {
      if (instance && id === instance.id) return instance;
      return undefined;
    }),
    destroy: vi.fn(async () => {}),
    destroyAll: vi.fn(async () => {}),
  };
}

function makeCtx(provider?: SandboxProvider): ToolContext {
  return {
    cwd: "/tmp",
    sessionId: "test-session",
    sandboxProvider: provider,
  };
}

// ── sandbox_exec ───────────────────────────────────────────────────────────────

describe("sandbox_exec", () => {
  // ── success paths ──

  it("executes a command successfully", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "echo hello" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
    expect(result.metadata?.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(instance.exec).toHaveBeenCalledWith("echo hello", {
      workdir: undefined,
      env: undefined,
      timeoutSeconds: 120,
    });
  });

  it("passes workdir, env and custom timeoutSeconds to exec", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    await tool.execute(
      {
        sandboxId: "sb-test",
        command: "npm test",
        workdir: "/app",
        env: { NODE_ENV: "test" },
        timeoutSeconds: 60,
      },
      ctx,
    );

    expect(instance.exec).toHaveBeenCalledWith("npm test", {
      workdir: "/app",
      env: { NODE_ENV: "test" },
      timeoutSeconds: 60,
    });
  });

  it("includes stderr and stdout in output", async () => {
    const instance = mockInstance({
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: "out",
        stderr: "err",
        timedOut: false,
        durationMs: 42,
      })),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "cmd" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("stdout:\nout");
    expect(result.content).toContain("stderr:\nerr");
    expect(result.content).toContain("exit code: 0");
    expect(result.content).toContain("duration: 42ms");
  });

  it("omits stdout section when stdout is empty", async () => {
    const instance = mockInstance({
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 10,
      })),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "cmd" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("stdout:");
    expect(result.content).not.toContain("stderr:");
    expect(result.content).toContain("exit code: 0");
  });

  // ── failure: provider missing ──

  it("returns error when provider not available", async () => {
    const tool = createSandboxExecTool();
    const ctx = makeCtx(undefined);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "echo hi" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("SandboxProvider not available");
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.retryable).toBe(false);
  });

  // ── failure: sandbox not found ──

  it("returns error when sandbox not found", async () => {
    const provider = mockProvider();
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-missing", command: "echo hi" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("Sandbox not found: sb-missing");
  });

  // ── failure: non-zero exit code ──

  it("reports non-zero exit code as failure with EXEC_ERROR", async () => {
    const instance = mockInstance({
      exec: vi.fn(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "not found",
        timedOut: false,
        durationMs: 50,
      })),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "bad-cmd" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Command exited with code 1");
    expect(result.metadata?.exitCode).toBe(1);
  });

  // ── failure: timed out (exitCode = null) ──

  it("handles timed out commands with null exitCode", async () => {
    const instance = mockInstance({
      exec: vi.fn(async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: true,
        durationMs: 30000,
      })),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "sleep 999" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("TIMED OUT");
    expect(result.content).toContain("exit code: running");
    expect(result.error).toBeUndefined();
    expect(result.metadata?.exitCode).toBeUndefined();
  });

  it("handles timed out commands that also have non-zero exit", async () => {
    const instance = mockInstance({
      exec: vi.fn(async () => ({
        exitCode: 124,
        stdout: "partial output",
        stderr: "",
        timedOut: true,
        durationMs: 30000,
      })),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "timeout-cmd" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("TIMED OUT");
    expect(result.content).toContain("exit code: 124");
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.metadata?.exitCode).toBe(124);
  });

  // ── failure: exec throws Error ──

  it("handles exec throwing an Error", async () => {
    const instance = mockInstance({
      exec: vi.fn(async () => {
        throw new Error("Connection refused");
      }),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "ls" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("sandbox_exec failed: Connection refused");
    expect(result.error?.retryable).toBe(false);
  });

  it("handles exec throwing a non-Error value", async () => {
    const instance = mockInstance({
      exec: vi.fn(async () => {
        throw "raw string error";
      }),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "ls" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("sandbox_exec failed: raw string error");
  });

  // ── defaults: timeoutSeconds ──

  it("defaults timeoutSeconds to 120 when not provided", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxExecTool();
    const ctx = makeCtx(provider);

    await tool.execute(
      { sandboxId: "sb-test", command: "echo hi" },
      ctx,
    );

    expect(instance.exec).toHaveBeenCalledWith("echo hi", {
      workdir: undefined,
      env: undefined,
      timeoutSeconds: 120,
    });
  });
});

// ── sandbox_upload ─────────────────────────────────────────────────────────────

describe("sandbox_upload", () => {
  // ── success: inline content ──

  it("uploads inline content", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", content: "console.log(1)", remotePath: "/app/index.js" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("/app/index.js");
    expect(result.content).toContain("sb-test");
    expect(instance.uploadContent).toHaveBeenCalledWith("console.log(1)", "/app/index.js");
    expect(instance.upload).not.toHaveBeenCalled();
  });

  it("uploads empty string content", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", content: "", remotePath: "/app/empty.txt" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(instance.uploadContent).toHaveBeenCalledWith("", "/app/empty.txt");
  });

  // ── success: localPath ──

  it("uploads from localPath", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", localPath: "/tmp/source.js", remotePath: "/app/dest.js" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Uploaded to /app/dest.js");
    expect(instance.upload).toHaveBeenCalledWith("/tmp/source.js", "/app/dest.js");
    expect(instance.uploadContent).not.toHaveBeenCalled();
  });

  // ── failure: missing source ──

  it("returns error when neither localPath nor content provided", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", remotePath: "/app/file.txt" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("localPath or content");
    expect(result.error?.code).toBe("UNKNOWN");
  });

  // ── failure: provider missing ──

  it("returns error when provider not available", async () => {
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(undefined);

    const result = await tool.execute(
      { sandboxId: "sb-test", content: "data", remotePath: "/app/file.txt" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("SandboxProvider not available");
    expect(result.error?.code).toBe("UNKNOWN");
  });

  // ── failure: sandbox not found ──

  it("returns error when sandbox not found", async () => {
    const provider = mockProvider();
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-missing", content: "data", remotePath: "/app/file.txt" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("Sandbox not found: sb-missing");
  });

  // ── failure: upload throws ──

  it("handles upload throwing an Error", async () => {
    const instance = mockInstance({
      upload: vi.fn(async () => {
        throw new Error("Disk full");
      }),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", localPath: "/tmp/big.zip", remotePath: "/app/big.zip" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("sandbox_upload failed: Disk full");
  });

  it("handles uploadContent throwing a non-Error", async () => {
    const instance = mockInstance({
      uploadContent: vi.fn(async () => {
        throw 42;
      }),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxUploadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", content: "x", remotePath: "/app/x.txt" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("sandbox_upload failed: 42");
  });
});

// ── sandbox_download ───────────────────────────────────────────────────────────

describe("sandbox_download", () => {
  // ── success: readFile (no localPath) ──

  it("reads file content when no localPath", async () => {
    const instance = mockInstance({
      readFile: vi.fn(async () => '{"result": 42}'),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxDownloadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", remotePath: "/app/output.json" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe('{"result": 42}');
    expect(instance.readFile).toHaveBeenCalledWith("/app/output.json");
    expect(instance.download).not.toHaveBeenCalled();
  });

  // ── success: download (with localPath) ──

  it("downloads to local file when localPath provided", async () => {
    const instance = mockInstance();
    const provider = mockProvider(instance);
    const tool = createSandboxDownloadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", remotePath: "/app/output.json", localPath: "/tmp/output.json" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Downloaded /app/output.json to /tmp/output.json");
    expect(instance.download).toHaveBeenCalledWith("/app/output.json", "/tmp/output.json");
    expect(instance.readFile).not.toHaveBeenCalled();
  });

  // ── failure: provider missing ──

  it("returns error when provider not available", async () => {
    const tool = createSandboxDownloadTool();
    const ctx = makeCtx(undefined);

    const result = await tool.execute(
      { sandboxId: "sb-test", remotePath: "/app/file.txt" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("SandboxProvider not available");
    expect(result.error?.code).toBe("UNKNOWN");
  });

  // ── failure: sandbox not found ──

  it("returns error when sandbox not found", async () => {
    const provider = mockProvider();
    const tool = createSandboxDownloadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-missing", remotePath: "/app/file.txt" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("Sandbox not found: sb-missing");
  });

  // ── failure: download throws ──

  it("handles download (with localPath) throwing an Error", async () => {
    const instance = mockInstance({
      download: vi.fn(async () => {
        throw new Error("Permission denied");
      }),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxDownloadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", remotePath: "/app/secret", localPath: "/tmp/out" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("sandbox_download failed: Permission denied");
  });

  it("handles readFile (no localPath) throwing a non-Error", async () => {
    const instance = mockInstance({
      readFile: vi.fn(async () => {
        throw "ENOENT";
      }),
    });
    const provider = mockProvider(instance);
    const tool = createSandboxDownloadTool();
    const ctx = makeCtx(provider);

    const result = await tool.execute(
      { sandboxId: "sb-test", remotePath: "/app/missing" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.content).toContain("sandbox_download failed: ENOENT");
  });
});

// ── createSandboxTools bundle ──────────────────────────────────────────────────

describe("createSandboxTools", () => {
  it("returns all three tools with correct names", () => {
    const tools = createSandboxTools();
    expect(tools.sandboxExec.name).toBe("sandbox_exec");
    expect(tools.sandboxUpload.name).toBe("sandbox_upload");
    expect(tools.sandboxDownload.name).toBe("sandbox_download");
  });

  it("returns independent tool instances (not shared)", () => {
    const tools1 = createSandboxTools();
    const tools2 = createSandboxTools();
    expect(tools1.sandboxExec).not.toBe(tools2.sandboxExec);
    expect(tools1.sandboxUpload).not.toBe(tools2.sandboxUpload);
    expect(tools1.sandboxDownload).not.toBe(tools2.sandboxDownload);
  });

  it("each tool has a valid description and parameter schema", () => {
    const tools = createSandboxTools();

    // exec
    expect(tools.sandboxExec.description).toBeTruthy();
    expect(tools.sandboxExec.parameters.type).toBe("object");
    expect(tools.sandboxExec.parameters.properties).toBeDefined();

    // upload
    expect(tools.sandboxUpload.description).toBeTruthy();
    expect(tools.sandboxUpload.parameters.type).toBe("object");
    expect(tools.sandboxUpload.parameters.properties).toBeDefined();

    // download
    expect(tools.sandboxDownload.description).toBeTruthy();
    expect(tools.sandboxDownload.parameters.type).toBe("object");
    expect(tools.sandboxDownload.parameters.properties).toBeDefined();
  });
});
