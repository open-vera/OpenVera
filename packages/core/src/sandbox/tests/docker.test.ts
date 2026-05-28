import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SandboxConnectionError,
  SandboxNotFoundError,
  SandboxTimeoutError,
} from "../types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks are installed.
const { DockerSandboxProvider } = await import("../docker.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecError = NodeJS.ErrnoException & {
  status?: number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
};

type ExecCallback = (
  err: ExecError | null,
  stdout: string,
  stderr: string,
) => void;

const CONTAINER_ID = "abc123def456";
const CONTAINER_ID_2 = "789xyz000111";

// ── Persistent mock state ────────────────────────────────────────────────────

let persistResult: { err: ExecError | null; stdout: string; stderr: string } = {
  err: null,
  stdout: "",
  stderr: "",
};
let persistHandler:
  | ((cmd: string, args: string[]) => { err: ExecError | null; stdout: string; stderr: string } | undefined)
  | undefined;

function setupMock(): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _optsOrCb: unknown,
      maybeCb?: ExecCallback,
    ) => {
      const cb =
        typeof _optsOrCb === "function"
          ? (_optsOrCb as ExecCallback)
          : maybeCb!;

      // Per-call handler takes priority.
      if (persistHandler) {
        const result = persistHandler(_cmd, args);
        if (result) {
          cb(result.err, result.stdout, result.stderr);
          return;
        }
      }

      // Default persistent result.
      cb(persistResult.err, persistResult.stdout, persistResult.stderr);
    },
  );
}

/** Set the default result for all subsequent docker calls. */
function setPersistResult(
  err: ExecError | null,
  stdout = "",
  stderr = "",
): void {
  persistResult = { err, stdout, stderr };
  persistHandler = undefined;
}

/** Set a per-command handler. Return undefined to fall through to persistent result. */
function setPersistHandler(
  handler: (
    cmd: string,
    args: string[],
  ) => { err: ExecError | null; stdout: string; stderr: string } | undefined,
): void {
  persistHandler = handler;
}

/** Get the last docker call's args array. */
function lastArgs(): string[] {
  return mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1][1] as string[];
}

/** Get the args of a specific call by index. */
function callArgs(index: number): string[] {
  return mockExecFile.mock.calls[index][1] as string[];
}

/**
 * Create a sandbox with a stable mock.
 * After this, mockExecFile has exactly 2 calls: [0]=version, [1]=create.
 * The persistent result is set to success (stdout="", stderr="").
 */
async function createSandbox(
  provider: InstanceType<typeof DockerSandboxProvider>,
  createId = CONTAINER_ID,
): Promise<Awaited<ReturnType<typeof provider.create>>> {
  let callCount = 0;
  setPersistHandler((_cmd, args) => {
    callCount++;
    if (args[0] === "version") return { err: null, stdout: "24.0.0", stderr: "" };
    if (args[0] === "create") return { err: null, stdout: createId, stderr: "" };
    return { err: null, stdout: "", stderr: "" };
  });

  const inst = await provider.create();

  // Reset to default success for subsequent calls.
  setPersistResult(null, "", "");
  return inst;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DockerSandboxProvider", () => {
  let provider: InstanceType<typeof DockerSandboxProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupMock();
    setPersistResult(null, "", "");
    provider = new DockerSandboxProvider();
  });

  // ── Provider properties ───────────────────────────────────────────────────

  describe("name", () => {
    it("returns 'docker'", () => {
      expect(provider.name).toBe("docker");
    });
  });

  // ── create() ──────────────────────────────────────────────────────────────

  describe("create()", () => {
    it("creates a container with default image", async () => {
      setPersistHandler((_cmd, args) => {
        if (args[0] === "version") return { err: null, stdout: "24.0.0", stderr: "" };
        return { err: null, stdout: CONTAINER_ID, stderr: "" };
      });

      const inst = await provider.create();
      expect(inst.id).toBe(CONTAINER_ID);
      expect(inst.status).toBe("ready");
      expect(inst.provider).toBe("docker");
      expect(inst.createdAt).toBeInstanceOf(Date);

      // Second call should be docker create
      expect(callArgs(1)[0]).toBe("create");
      expect(callArgs(1)).toContain("node:20-alpine");
    });

    it("creates a container with custom image and options", async () => {
      setPersistHandler((_cmd, args) => {
        if (args[0] === "version") return { err: null, stdout: "24.0.0", stderr: "" };
        return { err: null, stdout: CONTAINER_ID, stderr: "" };
      });

      const inst = await provider.create({
        image: "python:3.12",
        workdir: "/app",
        env: { FOO: "bar", BAZ: "1" },
        resources: { cpuCores: 2, memoryMb: 512 },
        networkMode: "host",
        volumes: [{ hostPath: "/tmp/data", containerPath: "/data" }],
        tags: { project: "test" },
      });

      expect(inst.id).toBe(CONTAINER_ID);

      const createArgs = callArgs(1);
      expect(createArgs).toContain("python:3.12");
      expect(createArgs).toContain("--workdir");
      expect(createArgs).toContain("/app");
      expect(createArgs).toContain("--env");
      expect(createArgs).toContain("FOO=bar");
      expect(createArgs).toContain("BAZ=1");
      expect(createArgs).toContain("--cpus");
      expect(createArgs).toContain("2");
      expect(createArgs).toContain("--memory");
      expect(createArgs).toContain("512m");
      expect(createArgs).toContain("--network");
      expect(createArgs).toContain("host");
      expect(createArgs).toContain("--volume");
      expect(createArgs).toContain("/tmp/data:/data:rw");
    });

    it("throws SandboxConnectionError when Docker is unavailable", async () => {
      const err = new Error("Cannot connect to the Docker daemon") as ExecError;
      err.status = 1;
      setPersistResult(err, "", "");

      await expect(provider.create()).rejects.toThrow(SandboxConnectionError);
    });
  });

  // ── list() ────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns empty list when no containers exist", async () => {
      setPersistResult(null, "", "");
      const list = await provider.list();
      expect(list).toEqual([]);
    });

    it("returns containers found by docker ps", async () => {
      setPersistHandler((_cmd, args) => {
        if (args[0] === "ps") {
          return { err: null, stdout: `${CONTAINER_ID}\n${CONTAINER_ID_2}`, stderr: "" };
        }
        if (args[0] === "inspect") {
          const id = args[args.length - 1];
          const info = {
            Id: id,
            State: { Status: "running" },
            Name: `/${id}`,
            Created: "2026-01-01T00:00:00Z",
            Config: { Image: "node:20-alpine" },
          };
          return { err: null, stdout: JSON.stringify(info), stderr: "" };
        }
        return { err: null, stdout: "", stderr: "" };
      });

      const list = await provider.list();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(CONTAINER_ID);
      expect(list[1].id).toBe(CONTAINER_ID_2);
    });
  });

  // ── get() ─────────────────────────────────────────────────────────────────

  describe("get()", () => {
    it("returns undefined for unknown container", async () => {
      const err = new Error("No such container") as ExecError;
      err.status = 1;
      setPersistResult(err, "", "");

      const inst = await provider.get("nonexistent");
      expect(inst).toBeUndefined();
    });

    it("returns instance for known container via inspect", async () => {
      setPersistHandler((_cmd, args) => {
        if (args[0] === "inspect") {
          const info = {
            Id: CONTAINER_ID,
            State: { Status: "running" },
            Name: "/test",
            Created: "2026-01-01T00:00:00Z",
            Config: { Image: "node:20-alpine" },
          };
          return { err: null, stdout: JSON.stringify(info), stderr: "" };
        }
        return { err: null, stdout: "", stderr: "" };
      });

      const inst = await provider.get(CONTAINER_ID);
      expect(inst).toBeDefined();
      expect(inst!.id).toBe(CONTAINER_ID);
      expect(inst!.status).toBe("ready"); // "running" maps to "ready"
    });
  });

  // ── destroy() ─────────────────────────────────────────────────────────────

  describe("destroy()", () => {
    it("removes a tracked container", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await provider.destroy(CONTAINER_ID);

      expect(lastArgs()[0]).toBe("rm");
      expect(lastArgs()).toContain("-f");
      expect(lastArgs()).toContain(CONTAINER_ID);
    });

    it("removes an untracked container via docker rm", async () => {
      setPersistResult(null, "", "");
      await provider.destroy("unknown-id");

      expect(lastArgs()[0]).toBe("rm");
      expect(lastArgs()).toContain("-f");
      expect(lastArgs()).toContain("unknown-id");
    });

    it("throws SandboxNotFoundError when container does not exist", async () => {
      const err = new Error("No such container") as ExecError;
      err.status = 1;
      setPersistResult(err, "", "");

      await expect(provider.destroy("nonexistent")).rejects.toThrow(
        SandboxNotFoundError,
      );
    });
  });

  // ── destroyAll() ──────────────────────────────────────────────────────────

  describe("destroyAll()", () => {
    it("destroys all tracked instances and cleans up orphans", async () => {
      // Create two containers.
      let createCount = 0;
      setPersistHandler((_cmd, args) => {
        if (args[0] === "version") return { err: null, stdout: "24.0.0", stderr: "" };
        if (args[0] === "create") {
          createCount++;
          return { err: null, stdout: createCount === 1 ? CONTAINER_ID : CONTAINER_ID_2, stderr: "" };
        }
        return { err: null, stdout: "", stderr: "" };
      });

      await provider.create();
      await provider.create();

      // destroyAll — all calls succeed
      setPersistResult(null, "", "");
      await provider.destroyAll();
    });
  });
});

// ── DockerSandboxInstance ────────────────────────────────────────────────────

describe("DockerSandboxInstance", () => {
  let provider: InstanceType<typeof DockerSandboxProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupMock();
    setPersistResult(null, "", "");
    provider = new DockerSandboxProvider();
  });

  // ── exec() ────────────────────────────────────────────────────────────────

  describe("exec()", () => {
    it("executes a command successfully", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "hello world\n", "");
      const result = await inst.exec("echo hello world");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify docker exec was called correctly.
      expect(lastArgs()[0]).toBe("exec");
      expect(lastArgs()).toContain(CONTAINER_ID);
      expect(lastArgs()).toContain("sh");
      expect(lastArgs()).toContain("-c");
    });

    it("executes with workdir and env options", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "output", "");
      await inst.exec("ls", { workdir: "/app", env: { KEY: "val" } });

      expect(lastArgs()).toContain("--workdir");
      expect(lastArgs()).toContain("/app");
      expect(lastArgs()).toContain("--env");
      expect(lastArgs()).toContain("KEY=val");
    });

    it("executes with timeout option", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "done", "");
      await inst.exec("sleep 1", { timeoutSeconds: 30 });

      expect(lastArgs()).toContain("--timeout");
      expect(lastArgs()).toContain("30");
    });

    it("handles non-zero exit codes gracefully", async () => {
      const inst = await createSandbox(provider);

      const err = new Error("command failed") as ExecError;
      err.status = 2;
      err.stdout = "";
      err.stderr = "not found";
      setPersistResult(err, "", "not found");

      const result = await inst.exec("bad-cmd");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("not found");
    });

    it("throws SandboxTimeoutError on timeout", async () => {
      const inst = await createSandbox(provider);

      const err = new Error("killed") as ExecError;
      err.killed = true;
      err.stdout = "";
      err.stderr = "";
      setPersistResult(err, "", "");

      await expect(
        inst.exec("sleep 999", { timeoutSeconds: 5 }),
      ).rejects.toThrow(SandboxTimeoutError);
    });

    it("passes stdin via interactive flag", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "piped", "");
      await inst.exec("cat", { stdin: "hello input" });

      expect(lastArgs()).toContain("--interactive");
    });

    it("throws SandboxNotFoundError when container is destroyed", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.destroy();

      await expect(inst.exec("ls")).rejects.toThrow(SandboxNotFoundError);
    });

    it("throws SandboxConnectionError when container is stopped", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.stop();

      await expect(inst.exec("ls")).rejects.toThrow(SandboxConnectionError);
    });
  });

  // ── upload() ──────────────────────────────────────────────────────────────

  describe("upload()", () => {
    it("uploads a file via docker cp", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.upload("/local/file.txt", "/remote/file.txt");

      expect(lastArgs()[0]).toBe("cp");
      expect(lastArgs()).toContain("/local/file.txt");
      expect(lastArgs()).toContain(`${CONTAINER_ID}:/remote/file.txt`);
    });

    it("throws SandboxConnectionError when local path does not exist", async () => {
      const inst = await createSandbox(provider);

      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValueOnce(false);

      await expect(
        inst.upload("/missing/file.txt", "/remote/file.txt"),
      ).rejects.toThrow(SandboxConnectionError);
    });

    it("throws SandboxNotFoundError when container is destroyed", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.destroy();

      await expect(inst.upload("/a", "/b")).rejects.toThrow(
        SandboxNotFoundError,
      );
    });
  });

  // ── uploadContent() ───────────────────────────────────────────────────────

  describe("uploadContent()", () => {
    it("uploads string content via temp file and docker cp", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.uploadContent("file contents", "/remote/file.txt");

      expect(lastArgs()[0]).toBe("cp");
      expect(lastArgs()[2]).toBe(`${CONTAINER_ID}:/remote/file.txt`);
    });

    it("uploads Uint8Array content", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.uploadContent(
        new Uint8Array([1, 2, 3]),
        "/remote/binary.bin",
      );

      expect(lastArgs()[0]).toBe("cp");
    });

    it("cleans up temp file even when docker cp fails", async () => {
      const inst = await createSandbox(provider);

      const err = new Error("cp failed") as ExecError;
      err.status = 1;
      setPersistResult(err, "", "");
      const { unlinkSync } = await import("node:fs");

      await expect(
        inst.uploadContent("data", "/remote/file"),
      ).rejects.toThrow();
      // unlinkSync should have been called for cleanup.
      expect(vi.mocked(unlinkSync)).toHaveBeenCalled();
    });
  });

  // ── download() ────────────────────────────────────────────────────────────

  describe("download()", () => {
    it("downloads a file via docker cp", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.download("/remote/file.txt", "/local/file.txt");

      expect(lastArgs()[0]).toBe("cp");
      expect(lastArgs()).toContain(`${CONTAINER_ID}:/remote/file.txt`);
      expect(lastArgs()).toContain("/local/file.txt");
    });

    it("throws SandboxNotFoundError when container is destroyed", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.destroy();

      await expect(inst.download("/a", "/b")).rejects.toThrow(
        SandboxNotFoundError,
      );
    });
  });

  // ── readFile() ────────────────────────────────────────────────────────────

  describe("readFile()", () => {
    it("reads file content via docker exec cat", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "file content here\n", "");
      const content = await inst.readFile("/etc/hostname");

      expect(content).toBe("file content here\n");

      expect(lastArgs()[0]).toBe("exec");
      expect(lastArgs()).toContain("cat");
      expect(lastArgs()).toContain("/etc/hostname");
    });

    it("throws SandboxNotFoundError when container is destroyed", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.destroy();

      await expect(inst.readFile("/file")).rejects.toThrow(
        SandboxNotFoundError,
      );
    });
  });

  // ── stop() ────────────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("stops a running container", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.stop();

      expect(inst.status).toBe("stopped");

      expect(lastArgs()[0]).toBe("stop");
      expect(lastArgs()).toContain(CONTAINER_ID);
    });

    it("is a no-op when already stopped", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.stop();

      // Second stop should be a no-op.
      const callsBefore = mockExecFile.mock.calls.length;
      await inst.stop();
      expect(mockExecFile.mock.calls.length).toBe(callsBefore);
    });

    it("throws SandboxNotFoundError when container is missing", async () => {
      const inst = await createSandbox(provider);

      const err = new Error("No such container: abc123def456") as ExecError;
      err.status = 1;
      setPersistResult(err, "", "");
      await expect(inst.stop()).rejects.toThrow(SandboxNotFoundError);
    });
  });

  // ── resume() ──────────────────────────────────────────────────────────────

  describe("resume()", () => {
    it("resumes a stopped container", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.stop();
      await inst.resume();

      expect(inst.status).toBe("ready");

      // Last call should be docker start.
      expect(lastArgs()[0]).toBe("start");
      expect(lastArgs()).toContain(CONTAINER_ID);
    });

    it("is a no-op when already running", async () => {
      const inst = await createSandbox(provider);

      const callsBefore = mockExecFile.mock.calls.length;
      await inst.resume();
      expect(mockExecFile.mock.calls.length).toBe(callsBefore);
    });

    it("throws SandboxNotFoundError when container is missing", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.stop();

      const err = new Error("No such container: abc123def456") as ExecError;
      err.status = 1;
      setPersistResult(err, "", "");
      await expect(inst.resume()).rejects.toThrow(SandboxNotFoundError);
    });
  });

  // ── destroy() (instance) ──────────────────────────────────────────────────

  describe("destroy() (instance)", () => {
    it("removes the container", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.destroy();

      expect(inst.status).toBe("destroyed");

      expect(lastArgs()[0]).toBe("rm");
      expect(lastArgs()).toContain("-f");
      expect(lastArgs()).toContain(CONTAINER_ID);
    });

    it("is a no-op when already destroyed", async () => {
      const inst = await createSandbox(provider);

      setPersistResult(null, "", "");
      await inst.destroy();

      const callsBefore = mockExecFile.mock.calls.length;
      await inst.destroy();
      expect(mockExecFile.mock.calls.length).toBe(callsBefore);
    });
  });

  // ── Instance properties ───────────────────────────────────────────────────

  describe("instance properties", () => {
    it("exposes id, status, provider, and createdAt", async () => {
      const inst = await createSandbox(provider);

      expect(inst.id).toBe(CONTAINER_ID);
      expect(inst.status).toBe("ready");
      expect(inst.provider).toBe("docker");
      expect(inst.createdAt).toBeInstanceOf(Date);
    });
  });
});
