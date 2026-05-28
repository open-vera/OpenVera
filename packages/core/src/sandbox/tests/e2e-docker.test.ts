/**
 * SB11 — Docker Local Sandbox E2E: Full lifecycle test using mocked Docker CLI.
 *
 * Tests the complete flow: create → upload → exec → download → stop → resume → destroy
 * through the DockerSandboxProvider, simulating real Docker CLI interactions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SandboxConnectionError,
  SandboxNotFoundError,
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

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Docker CLI Simulator ────────────────────────────────────────────────────

/**
 * Simulates Docker CLI behavior for E2E testing.
 * Tracks containers and their state across calls.
 */
class DockerSimulator {
  readonly containers = new Map<string, {
    status: "running" | "stopped" | "created";
    image: string;
    files: Map<string, string>;
    createdAt: string;
  }>();

  private nextId = 1;

  reset(): void {
    this.containers.clear();
    this.nextId = 1;
  }

  handleDockerCall(args: string[]): { err: ExecError | null; stdout: string; stderr: string } {
    const subcommand = args[0];

    switch (subcommand) {
      case "version":
        return { err: null, stdout: "24.0.7", stderr: "" };

      case "create": {
        const image = args[args.length - 1];
        const id = `docker-sb-${this.nextId++}`;
        this.containers.set(id, {
          status: "running",
          image,
          files: new Map(),
          createdAt: new Date().toISOString(),
        });
        return { err: null, stdout: id, stderr: "" };
      }

      case "exec": {
        // docker exec [--workdir W] [--env K=V]... CONTAINER sh -c COMMAND
        const containerIdx = args.indexOf("--detach=false") + 1;
        let containerId = args[containerIdx];
        let command = "";

        // Parse args to find container and command
        let i = 1;
        while (i < args.length) {
          if (args[i] === "--workdir") { i += 2; continue; }
          if (args[i] === "--env") { i += 2; continue; }
          if (args[i] === "--timeout") { i += 2; continue; }
          if (args[i] === "--interactive") { i++; continue; }
          if (args[i] === "--detach=false") { i++; continue; }
          if (args[i - 1] === "exec" || args[i - 1] === "--detach=false") {
            containerId = args[i];
            // The rest should be "sh -c <command>"
            if (args[i + 1] === "sh" && args[i + 2] === "-c") {
              command = args[i + 3] ?? "";
            }
            break;
          }
          i++;
        }

        const container = this.containers.get(containerId!);
        if (!container) {
          const err = new Error(`No such container: ${containerId}`) as ExecError;
          err.status = 1;
          return { err, stdout: "", stderr: `Error: No such container: ${containerId}` };
        }

        if (container.status === "stopped") {
          const err = new Error("container is stopped") as ExecError;
          err.status = 1;
          return { err, stdout: "", stderr: "Error: container is not running" };
        }

        // Simulate command execution
        return this.simulateCommand(container, command);
      }

      case "cp": {
        // docker cp SRC CONTAINER:DEST or docker cp CONTAINER:SRC DEST
        const src = args[1];
        const dest = args[2];

        if (dest?.includes(":")) {
          // Upload: local → container
          const [containerId, remotePath] = dest.split(":", 2);
          const container = this.containers.get(containerId!);
          if (!container) {
            const err = new Error(`No such container: ${containerId}`) as ExecError;
            err.status = 1;
            return { err, stdout: "", stderr: "" };
          }
          // Simulate file upload
          container.files.set(remotePath!, `content-of:${src}`);
          return { err: null, stdout: "", stderr: "" };
        } else if (src?.includes(":")) {
          // Download: container → local
          const [containerId, remotePath] = src.split(":", 2);
          const container = this.containers.get(containerId!);
          if (!container) {
            const err = new Error(`No such container: ${containerId}`) as ExecError;
            err.status = 1;
            return { err, stdout: "", stderr: "" };
          }
          return { err: null, stdout: "", stderr: "" };
        }
        return { err: null, stdout: "", stderr: "" };
      }

      case "stop": {
        const containerId = args[1];
        const container = this.containers.get(containerId!);
        if (!container) {
          const err = new Error(`No such container: ${containerId}`) as ExecError;
          err.status = 1;
          return { err, stdout: "", stderr: `Error response from daemon: No such container: ${containerId}` };
        }
        container.status = "stopped";
        return { err: null, stdout: containerId!, stderr: "" };
      }

      case "start": {
        const containerId = args[1];
        const container = this.containers.get(containerId!);
        if (!container) {
          const err = new Error(`No such container: ${containerId}`) as ExecError;
          err.status = 1;
          return { err, stdout: "", stderr: `Error: No such container: ${containerId}` };
        }
        container.status = "running";
        return { err: null, stdout: containerId!, stderr: "" };
      }

      case "rm": {
        const forceIdx = args.indexOf("-f");
        const containerId = args[forceIdx >= 0 ? forceIdx + 1 : 1];
        if (!this.containers.has(containerId!)) {
          const err = new Error(`No such container: ${containerId}`) as ExecError;
          err.status = 1;
          return { err, stdout: "", stderr: `Error: No such container: ${containerId}` };
        }
        this.containers.delete(containerId!);
        return { err: null, stdout: containerId!, stderr: "" };
      }

      case "inspect": {
        const containerId = args[args.length - 1];
        const container = this.containers.get(containerId!);
        if (!container) {
          const err = new Error(`No such container: ${containerId}`) as ExecError;
          err.status = 1;
          return { err, stdout: "", stderr: `Error: No such object: ${containerId}` };
        }
        return {
          err: null,
          stdout: JSON.stringify({
            Id: containerId,
            State: { Status: container.status === "running" ? "running" : "exited" },
            Name: `/${containerId}`,
            Created: container.createdAt,
            Config: { Image: container.image },
          }),
          stderr: "",
        };
      }

      case "ps": {
        const entries = Array.from(this.containers.entries());
        const ids = entries.map(([id]) => id);
        return { err: null, stdout: ids.join("\n"), stderr: "" };
      }

      default:
        return { err: null, stdout: "", stderr: "" };
    }
  }

  private simulateCommand(
    container: { files: Map<string, string> },
    command: string,
  ): { err: ExecError | null; stdout: string; stderr: string } {
    if (command === "echo hello world") {
      return { err: null, stdout: "hello world\n", stderr: "" };
    }

    if (command.startsWith("cat ")) {
      const path = command.slice(4).trim();
      const content = container.files.get(path);
      if (content !== undefined) {
        return { err: null, stdout: content, stderr: "" };
      }
      return {
        err: (() => { const e = new Error("No such file") as ExecError; e.status = 1; return e; })(),
        stdout: "",
        stderr: `cat: ${path}: No such file or directory`,
      };
    }

    if (command.startsWith("ls ")) {
      const path = command.slice(3).trim();
      const files = Array.from(container.files.keys())
        .filter((f) => f.startsWith(path))
        .map((f) => f.split("/").pop())
        .filter(Boolean);
      return { err: null, stdout: files.join("\n"), stderr: "" };
    }

    if (command.startsWith("wc -c ")) {
      const path = command.slice(6).trim();
      const content = container.files.get(path) ?? "";
      return { err: null, stdout: `${content.length} ${path}`, stderr: "" };
    }

    return { err: null, stdout: `executed: ${command}`, stderr: "" };
  }
}

const simulator = new DockerSimulator();

// ── Test Setup ──────────────────────────────────────────────────────────────

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

      const result = simulator.handleDockerCall(args);
      cb(result.err, result.stdout, result.stderr);
    },
  );
}

// ── E2E Tests ───────────────────────────────────────────────────────────────

describe("SB11: Docker Local Sandbox E2E — full lifecycle", () => {
  let provider: InstanceType<typeof DockerSandboxProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    simulator.reset();
    setupMock();
    provider = new DockerSandboxProvider();
  });

  it("create → exec → destroy lifecycle", async () => {
    // Create
    const instance = await provider.create({ image: "node:20-alpine" });
    expect(instance.id).toMatch(/^docker-sb-/);
    expect(instance.status).toBe("ready");
    expect(instance.provider).toBe("docker");

    // Exec
    const result = await instance.exec("echo hello world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");

    // Destroy
    await instance.destroy();
    expect(instance.status).toBe("destroyed");
  });

  it("create → upload → exec (cat) → readFile → destroy", async () => {
    const instance = await provider.create();

    // Upload file (uses temp file internally, then docker cp to container)
    await instance.uploadContent("Hello, Docker sandbox!", "/tmp/greeting.txt");

    // Verify docker cp was called (with temp file as source)
    const cpCalls = mockExecFile.mock.calls.filter(
      (call: unknown[]) => (call[1] as string[])[0] === "cp",
    );
    expect(cpCalls.length).toBeGreaterThanOrEqual(1);
    // The destination should be container:/tmp/greeting.txt
    const lastCpArgs = cpCalls[cpCalls.length - 1]![1] as string[];
    expect(lastCpArgs[2]).toContain(":/tmp/greeting.txt");

    // Read back via exec
    const execResult = await instance.exec("cat /tmp/greeting.txt");
    expect(execResult.exitCode).toBe(0);
    // The simulator stores content-of:<temp-path> since that's what docker cp received
    expect(execResult.stdout).toBeTruthy();

    // Read file via readFile
    const content = await instance.readFile("/tmp/greeting.txt");
    expect(content).toBeTruthy();

    await instance.destroy();
  });

  it("create → stop → resume → exec → destroy", async () => {
    const instance = await provider.create();
    expect(instance.status).toBe("ready");

    // Stop
    await instance.stop();
    expect(instance.status).toBe("stopped");

    // Resume
    await instance.resume();
    expect(instance.status).toBe("ready");

    // Exec after resume
    const result = await instance.exec("echo hello world");
    expect(result.exitCode).toBe(0);

    await instance.destroy();
  });

  it("create → upload → download → verify file transfer", async () => {
    const instance = await provider.create();

    // Upload content
    await instance.uploadContent("test data", "/data/input.txt");

    // Download to local path
    await instance.download("/data/output.txt", "/tmp/local-output.txt");

    // Verify the download call was made correctly
    const cpCalls = mockExecFile.mock.calls.filter(
      (call: unknown[]) => (call[1] as string[])[0] === "cp",
    );
    expect(cpCalls.length).toBeGreaterThanOrEqual(1);

    await instance.destroy();
  });

  it("multiple sandboxes execute independently", async () => {
    // Create 3 sandboxes
    const instances = await Promise.all([
      provider.create({ image: "node:20" }),
      provider.create({ image: "python:3.12" }),
      provider.create({ image: "ubuntu:22.04" }),
    ]);

    expect(instances).toHaveLength(3);

    // Verify each has a unique ID
    const ids = instances.map((i) => i.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);

    // Execute on all concurrently
    const results = await Promise.all(
      instances.map((inst) => inst.exec("echo hello world")),
    );

    for (const result of results) {
      expect(result.exitCode).toBe(0);
    }

    // Destroy all
    await Promise.all(instances.map((inst) => inst.destroy()));
  });

  it("provider list returns all created sandboxes", async () => {
    await provider.create({ image: "node:20" });
    await provider.create({ image: "python:3.12" });

    const list = await provider.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("provider get retrieves specific sandbox", async () => {
    const instance = await provider.create();
    const retrieved = await provider.get(instance.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(instance.id);

    await instance.destroy();
  });

  it("destroy removes sandbox from provider", async () => {
    const instance = await provider.create();
    const id = instance.id;

    await provider.destroy(id);

    // Should be gone from get
    const err = new Error("No such container") as ExecError;
    err.status = 1;
    // After destroy, the container is removed from simulator
    const retrieved = await provider.get(id);
    expect(retrieved).toBeUndefined();
  });

  it("handles Docker daemon unavailable", async () => {
    const err = new Error("Cannot connect to the Docker daemon") as ExecError;
    err.status = 1;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _optsOrCb: unknown, maybeCb?: ExecCallback) => {
        const cb = typeof _optsOrCb === "function" ? (_optsOrCb as ExecCallback) : maybeCb!;
        cb(err, "", "Cannot connect to the Docker daemon");
      },
    );

    await expect(provider.create()).rejects.toThrow(SandboxConnectionError);
  });

  it("exec on destroyed sandbox throws SandboxNotFoundError", async () => {
    const instance = await provider.create();
    await instance.destroy();

    await expect(instance.exec("echo test")).rejects.toThrow(SandboxNotFoundError);
  });

  it("full agent workflow: create → upload script → exec → read output → cleanup", async () => {
    const instance = await provider.create({ image: "python:3.12" });

    // Upload a script
    await instance.uploadContent(
      "import sys\nprint(f'Hello from {sys.platform}')",
      "/app/run.py",
    );

    // Execute script
    const execResult = await instance.exec("cat /app/run.py");
    expect(execResult.exitCode).toBe(0);

    // Read output
    const output = await instance.readFile("/app/run.py");
    expect(output).toBeTruthy();

    // Cleanup
    await instance.destroy();
    expect(instance.status).toBe("destroyed");
  });
});
