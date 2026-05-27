/**
 * Sandbox Abstraction Layer — Unified sandbox interface for OpenVera.
 *
 * Provides a SandboxProvider interface that abstracts over different sandbox
 * backends (CubeSandbox, Docker, etc.) so that code execution, file transfer,
 * and lifecycle management can be performed uniformly.
 *
 * Sandbox lifecycle: create → upload files → execute commands → download artifacts → destroy
 */

// ── Sandbox Provider Interface ─────────────────────────────────────────────

/**
 * Core sandbox provider interface. All backends (CubeSandbox, Docker, etc.)
 * implement this interface.
 */
export interface SandboxProvider {
  /** Unique name of this provider (e.g., "cubesandbox", "docker") */
  readonly name: string;

  /** Create a new sandbox instance. Returns a sandbox ID. */
  create(options?: SandboxCreateOptions): Promise<SandboxInstance>;

  /** List active sandbox instances managed by this provider. */
  list(): Promise<SandboxInstance[]>;

  /** Get a sandbox instance by ID. Returns undefined if not found. */
  get(sandboxId: string): Promise<SandboxInstance | undefined>;

  /** Destroy a sandbox instance and release all resources. */
  destroy(sandboxId: string): Promise<void>;

  /** Destroy all sandbox instances managed by this provider. */
  destroyAll(): Promise<void>;
}

// ── Sandbox Instance ───────────────────────────────────────────────────────

/** Status of a sandbox instance */
export type SandboxStatus =
  | "creating"
  | "ready"
  | "running"
  | "stopped"
  | "error"
  | "destroyed";

/** A running sandbox instance handle */
export interface SandboxInstance {
  /** Unique identifier for this sandbox */
  readonly id: string;

  /** Current status */
  readonly status: SandboxStatus;

  /** Provider that created this instance */
  readonly provider: string;

  /** When the sandbox was created */
  readonly createdAt: Date;

  /** Execute a command inside the sandbox */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;

  /** Upload a file or directory into the sandbox */
  upload(localPath: string, remotePath: string): Promise<void>;

  /** Upload content directly (without a local file) */
  uploadContent(content: string | Uint8Array, remotePath: string): Promise<void>;

  /** Download a file or directory from the sandbox */
  download(remotePath: string, localPath: string): Promise<void>;

  /** Read a file from the sandbox and return its content */
  readFile(remotePath: string): Promise<string>;

  /** Stop the sandbox (pause execution, preserve state) */
  stop(): Promise<void>;

  /** Resume a stopped sandbox */
  resume(): Promise<void>;

  /** Destroy this sandbox instance */
  destroy(): Promise<void>;
}

// ── Create Options ─────────────────────────────────────────────────────────

/** Options for creating a sandbox instance */
export interface SandboxCreateOptions {
  /** Docker image to use (default: provider-specific default) */
  image?: string;

  /** Working directory inside the sandbox */
  workdir?: string;

  /** Environment variables */
  env?: Record<string, string>;

  /** Resource limits */
  resources?: SandboxResources;

  /** Timeout in seconds (0 = no timeout) */
  timeoutSeconds?: number;

  /** Metadata tags for organization */
  tags?: Record<string, string>;

  /** Network mode ("bridge", "host", "none") */
  networkMode?: string;

  /** Volumes to mount (hostPath → containerPath) */
  volumes?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
}

/** Resource limits for a sandbox */
export interface SandboxResources {
  /** CPU cores (e.g., 1, 2, 0.5) */
  cpuCores?: number;

  /** Memory in MB */
  memoryMb?: number;

  /** Disk in MB */
  diskMb?: number;

  /** GPU count */
  gpuCount?: number;
}

// ── Exec Options & Result ──────────────────────────────────────────────────

/** Options for executing a command in a sandbox */
export interface SandboxExecOptions {
  /** Working directory for this command */
  workdir?: string;

  /** Environment variables for this command */
  env?: Record<string, string>;

  /** Timeout in seconds (0 = no timeout) */
  timeoutSeconds?: number;

  /** stdin content to pipe into the command */
  stdin?: string;

  /** Run in background (don't wait for completion) */
  background?: boolean;
}

/** Result of executing a command in a sandbox */
export interface SandboxExecResult {
  /** Exit code of the command (null if still running in background) */
  exitCode: number | null;

  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Whether the command timed out */
  timedOut: boolean;

  /** Duration in milliseconds */
  durationMs: number;

  /** Background process ID (if background=true) */
  pid?: number;
}

// ── Error Types ────────────────────────────────────────────────────────────

export class SandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxError";
    this.code = code;
  }
}

export class SandboxNotFoundError extends SandboxError {
  constructor(sandboxId: string) {
    super("SANDBOX_NOT_FOUND", `Sandbox not found: ${sandboxId}`);
    this.name = "SandboxNotFoundError";
  }
}

export class SandboxTimeoutError extends SandboxError {
  constructor(sandboxId: string, timeoutSeconds: number) {
    super("SANDBOX_TIMEOUT", `Sandbox ${sandboxId} timed out after ${timeoutSeconds}s`);
    this.name = "SandboxTimeoutError";
  }
}

export class SandboxExecError extends SandboxError {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(sandboxId: string, exitCode: number, stderr: string) {
    super(
      "SANDBOX_EXEC_ERROR",
      `Command failed in sandbox ${sandboxId} (exit ${exitCode}): ${stderr}`,
    );
    this.name = "SandboxExecError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class SandboxConnectionError extends SandboxError {
  constructor(provider: string, detail: string, options?: ErrorOptions) {
    super("SANDBOX_CONNECTION", `${provider} connection error: ${detail}`, options);
    this.name = "SandboxConnectionError";
  }
}

export class SandboxQuotaError extends SandboxError {
  constructor(provider: string, detail: string) {
    super("SANDBOX_QUOTA", `${provider} quota exceeded: ${detail}`);
    this.name = "SandboxQuotaError";
  }
}
