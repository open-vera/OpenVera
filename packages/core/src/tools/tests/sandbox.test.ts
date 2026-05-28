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

// ── sandbox_exec ───────────────────────────────────────────────────────────

describe("sandbox_exec", () => {
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
    expect(instance.exec).toHaveBeenCalledWith("echo hello", {
      workdir: undefined,
      env: undefined,
      timeoutSeconds: 120,
    });
  });

  it("passes workdir and env to exec", async () => {
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
  });

  it("returns error when provider not available", async () => {
    const tool = createSandboxExecTool();
    const ctx = makeCtx(undefined);

    const result = await tool.execute(
      { sandboxId: "sb-test", command: "echo hi" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("SandboxProvider not available");
  });

  it("reports non-zero exit code as failure", async () => {
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
    expect(result.metadata?.exitCode).toBe(1);
  });

  it("handles timed out commands", async () => {
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
  });
});

// ── sandbox_upload ─────────────────────────────────────────────────────────

describe("sandbox_upload", () => {
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
    expect(instance.uploadContent).toHaveBeenCalledWith("console.log(1)", "/app/index.js");
  });

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
  });

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
  });
});

// ── sandbox_download ───────────────────────────────────────────────────────

describe("sandbox_download", () => {
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
  });

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
    expect(result.content).toContain("Downloaded");
    expect(instance.download).toHaveBeenCalledWith("/app/output.json", "/tmp/output.json");
  });

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
  });
});

// ── createSandboxTools bundle ──────────────────────────────────────────────

describe("createSandboxTools", () => {
  it("returns all three tools", () => {
    const tools = createSandboxTools();
    expect(tools.sandboxExec.name).toBe("sandbox_exec");
    expect(tools.sandboxUpload.name).toBe("sandbox_upload");
    expect(tools.sandboxDownload.name).toBe("sandbox_download");
  });
});
