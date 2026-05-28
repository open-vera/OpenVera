/**
 * Docker Sandbox Adapter — local Docker-based sandbox backend.
 *
 * Uses the Docker CLI (`docker create`, `docker exec`, `docker cp`, etc.)
 * to manage sandbox containers for local development and testing.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInstance,
  SandboxProvider,
  SandboxStatus,
} from "./types.js";
import {
  SandboxConnectionError,
  SandboxNotFoundError,
  SandboxTimeoutError,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const LABEL_KEY = "vera.sandbox";
const LABEL_VALUE = "true";
const DEFAULT_IMAGE = "node:20-alpine";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(8).toString("hex");
}

interface DockerContainerInfo {
  Id: string;
  State: { Status: string };
  Name: string;
  Created: string;
  Config?: { Image?: string };
}

/** Run `docker` CLI via execFile (avoids shell injection). */
function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}

/** Map Docker container state to SandboxStatus. */
function mapContainerState(
  dockerState: string,
): SandboxStatus {
  switch (dockerState) {
    case "created":
      return "creating";
    case "running":
      return "ready";
    case "paused":
    case "restarting":
      return "stopped";
    case "exited":
    case "dead":
      return "stopped";
    case "removing":
      return "destroyed";
    default:
      return "error";
  }
}

// ── DockerSandboxInstance ────────────────────────────────────────────────────

interface DockerInstanceOptions {
  containerId: string;
  status: SandboxStatus;
  createdAt: Date;
  image: string;
}

class DockerSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly provider = "docker";
  readonly createdAt: Date;
  readonly image: string;

  private _status: SandboxStatus;

  constructor(opts: DockerInstanceOptions) {
    this.id = opts.containerId;
    this._status = opts.status;
    this.createdAt = opts.createdAt;
    this.image = opts.image;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  /** Update status (used internally by DockerSandboxProvider). */
  setStatus(s: SandboxStatus): void {
    this._status = s;
  }

  // ── exec ──────────────────────────────────────────────────────────────────

  async exec(
    command: string,
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    this.requireRunning();

    const args = ["exec", "--detach=false"];

    // Working directory
    if (options?.workdir) {
      args.push("--workdir", options.workdir);
    }

    // Environment variables
    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }

    // Timeout via Docker's --timeout flag (seconds, integer)
    const timeoutSec = options?.timeoutSeconds ?? 0;
    if (timeoutSec > 0) {
      args.push("--timeout", String(Math.ceil(timeoutSec)));
    }

    // stdin
    if (options?.stdin) {
      args.push("--interactive");
    }

    args.push(this.id);

    // Build shell command; inject stdin via echo pipe
    const shellCmd = options?.stdin
      ? `printf '%s' ${JSON.stringify(options.stdin)} | ${command}`
      : command;
    args.push("sh", "-c", shellCmd);

    const start = Date.now();

    try {
      const { stdout, stderr } = await docker(args);
      return {
        exitCode: 0,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        timedOut: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const execErr = err as NodeJS.ErrnoException & {
        code?: string;
        killed?: boolean;
        status?: number;
        stdout?: string;
        stderr?: string;
        signal?: string;
      };

      const durationMs = Date.now() - start;
      const isTimeout =
        execErr.killed === true ||
        execErr.code === "ETIMEDOUT" ||
        (typeof execErr.signal === "string" &&
          execErr.signal === "SIGTERM");

      if (isTimeout) {
        this._status = "error";
        throw new SandboxTimeoutError(this.id, timeoutSec);
      }

      return {
        exitCode: typeof execErr.status === "number" ? execErr.status : 1,
        stdout: (execErr.stdout ?? "").toString().trimEnd(),
        stderr: (execErr.stderr ?? "").toString().trimEnd(),
        timedOut: false,
        durationMs,
      };
    }
  }

  // ── upload / download ─────────────────────────────────────────────────────

  async upload(localPath: string, remotePath: string): Promise<void> {
    this.requireNotDestroyed();
    if (!existsSync(localPath)) {
      throw new SandboxConnectionError(
        "docker",
        `Local path does not exist: ${localPath}`,
      );
    }
    await docker(["cp", localPath, `${this.id}:${remotePath}`]);
  }

  async uploadContent(
    content: string | Uint8Array,
    remotePath: string,
  ): Promise<void> {
    this.requireNotDestroyed();
    const tmpFile = join(tmpdir(), `vera-upload-${uid()}`);
    const { writeFileSync } = await import("node:fs");
    const data =
      typeof content === "string"
        ? Buffer.from(content, "utf-8")
        : Buffer.from(content);
    writeFileSync(tmpFile, data);
    try {
      await docker(["cp", tmpFile, `${this.id}:${remotePath}`]);
    } finally {
      const { unlinkSync } = await import("node:fs");
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore cleanup error
      }
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    this.requireNotDestroyed();
    await docker(["cp", `${this.id}:${remotePath}`, localPath]);
  }

  async readFile(remotePath: string): Promise<string> {
    this.requireRunning();
    const { stdout } = await docker([
      "exec",
      this.id,
      "cat",
      remotePath,
    ]);
    return stdout;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this._status === "stopped" || this._status === "destroyed") return;
    try {
      await docker(["stop", this.id]);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (
        typeof nodeErr.message === "string" &&
        nodeErr.message.includes("No such container")
      ) {
        this._status = "destroyed";
        throw new SandboxNotFoundError(this.id);
      }
      throw new SandboxConnectionError(
        "docker",
        `Failed to stop container ${this.id}: ${nodeErr.message}`,
      );
    }
    this._status = "stopped";
  }

  async resume(): Promise<void> {
    if (this._status === "ready" || this._status === "running") return;
    this.requireNotDestroyed();
    try {
      await docker(["start", this.id]);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (
        typeof nodeErr.message === "string" &&
        nodeErr.message.includes("No such container")
      ) {
        this._status = "destroyed";
        throw new SandboxNotFoundError(this.id);
      }
      throw new SandboxConnectionError(
        "docker",
        `Failed to resume container ${this.id}: ${nodeErr.message}`,
      );
    }
    this._status = "ready";
  }

  async destroy(): Promise<void> {
    if (this._status === "destroyed") return;
    try {
      await docker(["rm", "-f", this.id]);
    } catch {
      // Container may already be gone — not an error.
    }
    this._status = "destroyed";
  }

  // ── guards ────────────────────────────────────────────────────────────────

  private requireRunning(): void {
    if (this._status === "destroyed") {
      throw new SandboxNotFoundError(this.id);
    }
    if (this._status === "stopped") {
      throw new SandboxConnectionError(
        "docker",
        `Sandbox ${this.id} is stopped; call resume() first`,
      );
    }
  }

  private requireNotDestroyed(): void {
    if (this._status === "destroyed") {
      throw new SandboxNotFoundError(this.id);
    }
  }
}

// ── DockerSandboxProvider ────────────────────────────────────────────────────

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";

  private instances = new Map<string, DockerSandboxInstance>();
  private defaultImage: string;

  constructor(opts?: { defaultImage?: string }) {
    this.defaultImage = opts?.defaultImage ?? DEFAULT_IMAGE;
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(options?: SandboxCreateOptions): Promise<SandboxInstance> {
    // Verify Docker is available.
    try {
      await docker(["version", "--format", "{{.Server.Version}}"]);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : undefined;
      throw new SandboxConnectionError(
        "docker",
        "Docker daemon is not running or docker CLI is not installed",
        cause ? { cause } : undefined,
      );
    }

    const sandboxId = `vera-sb-${uid()}`;
    const image = options?.image ?? this.defaultImage;

    const args = ["create"];

    // Hostname and name
    args.push("--hostname", sandboxId);
    args.push("--name", sandboxId);

    // Labels for discovery
    args.push("--label", `${LABEL_KEY}=${LABEL_VALUE}`);
    args.push("--label", `vera.sandbox.id=${sandboxId}`);

    // Extra user labels
    if (options?.tags) {
      for (const [k, v] of Object.entries(options.tags)) {
        args.push("--label", `${k}=${v}`);
      }
    }

    // Environment variables
    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }

    // Working directory
    if (options?.workdir) {
      args.push("--workdir", options.workdir);
    }

    // Resource limits
    if (options?.resources) {
      const r = options.resources;
      if (r.cpuCores !== undefined) {
        args.push("--cpus", String(r.cpuCores));
      }
      if (r.memoryMb !== undefined) {
        args.push("--memory", `${r.memoryMb}m`);
      }
    }

    // Network mode
    if (options?.networkMode) {
      args.push("--network", options.networkMode);
    }

    // Volumes
    if (options?.volumes) {
      for (const vol of options.volumes) {
        const mode = vol.readOnly ? "ro" : "rw";
        args.push("--volume", `${vol.hostPath}:${vol.containerPath}:${mode}`);
      }
    }

    args.push(image);

    // Keep the container alive: `sleep infinity` works on alpine/busybox;
    // on Debian-based images use `tail -f /dev/null`.
    args.push("sh", "-c", "tail -f /dev/null || sleep infinity");

    const { stdout } = await docker(args);
    const containerId = stdout.trim();

    const instance = new DockerSandboxInstance({
      containerId,
      status: "ready",
      createdAt: new Date(),
      image,
    });

    this.instances.set(containerId, instance);
    return instance;
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(): Promise<SandboxInstance[]> {
    const { stdout } = await docker([
      "ps",
      "--all",
      "--filter",
      `label=${LABEL_KEY}=${LABEL_VALUE}`,
      "--format",
      "{{.ID}}",
    ]);

    const ids = stdout.trim().split("\n").filter(Boolean);
    const instances: DockerSandboxInstance[] = [];

    for (const id of ids) {
      let inst = this.instances.get(id);
      if (!inst) {
        inst = await this.inspectContainer(id);
        if (inst) this.instances.set(id, inst);
      }
      if (inst) instances.push(inst);
    }

    return instances;
  }

  // ── get ───────────────────────────────────────────────────────────────────

  async get(sandboxId: string): Promise<SandboxInstance | undefined> {
    let inst = this.instances.get(sandboxId);
    if (inst) return inst;

    // Not tracked locally — try to find it in Docker.
    inst = await this.inspectContainer(sandboxId);
    if (inst) this.instances.set(sandboxId, inst);
    return inst;
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  async destroy(sandboxId: string): Promise<void> {
    const inst = this.instances.get(sandboxId);
    if (!inst) {
      // Try Docker directly in case it was created outside this process.
      try {
        await docker(["rm", "-f", sandboxId]);
      } catch {
        throw new SandboxNotFoundError(sandboxId);
      }
      return;
    }

    await inst.destroy();
    this.instances.delete(sandboxId);
  }

  // ── destroyAll ────────────────────────────────────────────────────────────

  async destroyAll(): Promise<void> {
    const errors: Error[] = [];

    for (const [id, inst] of this.instances) {
      try {
        await inst.destroy();
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
      this.instances.delete(id);
    }

    // Also clean up any orphaned containers from Docker.
    try {
      const { stdout } = await docker([
        "ps",
        "--all",
        "--filter",
        `label=${LABEL_KEY}=${LABEL_VALUE}`,
        "--quiet",
      ]);
      const orphans = stdout.trim().split("\n").filter(Boolean);
      if (orphans.length > 0) {
        await docker(["rm", "-f", ...orphans]);
      }
    } catch {
      // Docker may be unavailable — not fatal.
    }

    if (errors.length > 0) {
      throw new SandboxConnectionError(
        "docker",
        `Failed to destroy some sandboxes: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  // ── inspectContainer (private helper) ─────────────────────────────────────

  private async inspectContainer(
    containerId: string,
  ): Promise<DockerSandboxInstance | undefined> {
    try {
      const { stdout } = await docker([
        "inspect",
        "--format",
        "{{json .}}",
        containerId,
      ]);
      const info = JSON.parse(stdout.trim()) as DockerContainerInfo;

      return new DockerSandboxInstance({
        containerId: info.Id,
        status: mapContainerState(info.State.Status),
        createdAt: new Date(info.Created),
        image: info.Config?.Image ?? "unknown",
      });
    } catch {
      return undefined;
    }
  }
}
