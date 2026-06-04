# Sandbox -- Code Execution Isolation

## Overview

The Sandbox system provides Vera with a **secure code execution environment**. Agents need to run scripts, install dependencies, compile code, and execute tests inside a sandbox, without direct access to the host filesystem or network. All external code execution must go through the Sandbox abstraction layer; bypassing it with raw `child_process` is forbidden.

The Sandbox is not only a security boundary but also an **environment abstraction layer**: the same tool invocation can run on local Docker, a remote CubeSandbox microVM, or future cloud sandbox services, with the caller unaware of the backend differences.

---

## Design Principles

### Security Boundary

```
Host
  |
  +-- Project files (mountable, read-only)
  |
  +-- Sandbox Isolation Layer -------------------------
       |
       +-- Filesystem: isolated overlay / volume
       +-- Network: bridge / host / none
       +-- Processes: isolated PID namespace
       +-- Resources: CPU / Memory / Disk limits
       |
       +-- Tool Calls <-- Agent
```

### Core Principles

1. **Isolation first**: All user code executes in an isolated environment by default, never exposing the host.
2. **Unified interface**: The `SandboxProvider` interface abstracts all backends; callers are unaware of implementations.
3. **Explicit authorization**: Sensitive operations (network access, file mounts) must be explicitly declared at creation time.
4. **Resource limits**: CPU, memory, disk, and timeout all have caps to prevent runaway consumption.
5. **Controlled lifecycle**: Fully traceable from creation to destruction; automatic cleanup when out of scope.

---

## Architecture

```
packages/core/src/sandbox/
  types.ts          # SandboxProvider interface + error types
  cubesandbox.ts    # CubeSandbox remote microVM adapter
  docker.ts         # Docker CLI local container adapter
  index.ts          # Barrel export

packages/core/src/tools/
  sandbox.ts        # Sandbox tools: sandbox_exec / sandbox_upload / sandbox_download
```

---

## SandboxProvider Interface

### Interface Definition

```ts
interface SandboxProvider {
  readonly name: string;  // "cubesandbox" | "docker"

  create(options?: SandboxCreateOptions): Promise<SandboxInstance>;
  list(): Promise<SandboxInstance[]>;
  get(sandboxId: string): Promise<SandboxInstance | undefined>;
  destroy(sandboxId: string): Promise<void>;
  destroyAll(): Promise<void>;
}
```

### SandboxInstance Interface

```ts
interface SandboxInstance {
  readonly id: string;
  readonly status: SandboxStatus;  // creating | ready | running | stopped | error | destroyed
  readonly provider: string;
  readonly createdAt: Date;

  // Command execution
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;

  // File transfer
  upload(localPath: string, remotePath: string): Promise<void>;
  uploadContent(content: string | Uint8Array, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  readFile(remotePath: string): Promise<string>;

  // Lifecycle
  stop(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
}
```

### State Machine

```
  creating ---> ready ---> running
                  |           |
                  |        stopped
                  |           |
                  v           v
               error      destroyed
```

- `creating`: Sandbox being created (image pull, environment init)
- `ready`: Sandbox started, waiting for commands
- `running`: Command executing
- `stopped`: Paused (resumable)
- `error`: Abnormal state (timeout, resource exhaustion, etc.)
- `destroyed`: Destroyed (terminal, not recoverable)

### Creation Options

```ts
interface SandboxCreateOptions {
  image?: string;                // Docker image (default "node:20-alpine")
  workdir?: string;              // Working directory inside container
  env?: Record<string, string>;  // Environment variables
  resources?: SandboxResources;  // CPU/Memory/Disk limits
  timeoutSeconds?: number;       // Sandbox timeout (0 = unlimited)
  tags?: Record<string, string>; // Organization tags
  networkMode?: string;          // "bridge" | "host" | "none"
  volumes?: Array<{
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }>;
}
```

---

## CubeSandbox Adapter

### Overview

`CubeSandboxProvider` (`packages/core/src/sandbox/cubesandbox.ts`) is a client adapter for Tencent's open-source microVM sandbox project (Apache 2.0). CubeSandbox provides E2B-compatible sandbox management via an HTTP REST API.

### Connection Configuration

```ts
interface CubeSandboxOptions {
  baseUrl?: string;             // API URL (env CUBESANDBOX_URL, default localhost:8080)
  apiKey?: string;              // Auth key (env CUBESANDBOX_API_KEY)
  defaultImage?: string;        // Default image (default "ubuntu:22.04")
  requestTimeoutMs?: number;    // HTTP request timeout (default 30000ms)
}
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sandboxes` | Create sandbox |
| `GET` | `/sandboxes` | List all sandboxes |
| `GET` | `/sandboxes/:id` | Get sandbox info |
| `DELETE` | `/sandboxes/:id` | Destroy single sandbox |
| `DELETE` | `/sandboxes` | Destroy all sandboxes |
| `POST` | `/sandboxes/:id/exec` | Execute command |
| `POST` | `/sandboxes/:id/files/:path` | Upload file |
| `GET` | `/sandboxes/:id/files/:path` | Read/download file |
| `POST` | `/sandboxes/:id/stop` | Pause sandbox |
| `POST` | `/sandboxes/:id/resume` | Resume sandbox |

### HTTP Client Details

All HTTP requests go through a unified `requestCubeSandbox` function:

- **Authentication**: `Authorization: Bearer <apiKey>` header
- **Timeout**: `AbortController` + `setTimeout`
- **Error mapping**:
  - HTTP 404 -> `SandboxNotFoundError`
  - HTTP 429 -> `SandboxQuotaError`
  - Other errors -> `SandboxConnectionError`
  - AbortError -> `SandboxTimeoutError`
  - fetch TypeError -> `SandboxConnectionError`
- **File transfer**: Uses base64 encoding for binary content

### Usage

```ts
import { CubeSandboxProvider, createCubeSandboxProvider } from "@vera/core";

// Method 1: Factory function (recommended)
const provider = createCubeSandboxProvider({
  baseUrl: "https://sandbox.example.com/api",
  apiKey: process.env.CUBESANDBOX_API_KEY,
});

// Method 2: Direct instantiation
const provider = new CubeSandboxProvider({
  baseUrl: process.env.CUBESANDBOX_URL,
  apiKey: process.env.CUBESANDBOX_API_KEY,
});

const instance = await provider.create({
  image: "node:20",
  workdir: "/workspace",
  timeoutSeconds: 300,
  resources: { cpuCores: 1, memoryMb: 512 },
});

const result = await instance.exec("npm test");
console.log(result.stdout);

await instance.destroy();
```

---

## Docker Adapter

### Overview

`DockerSandboxProvider` (`packages/core/src/sandbox/docker.ts`) is a local Docker adapter that manages sandbox containers via the Docker CLI (`docker create`, `docker exec`, `docker cp`, etc.), suitable for local development and testing.

### Key Technical Decisions

- **Uses Docker CLI, not Docker SDK**: Better cross-platform consistency, no extra npm dependency.
- **`execFile` not `exec`**: Avoids shell injection; all parameters passed as arrays.
- **Label management**: Docker labels (`vera.sandbox=true`) mark Vera-managed containers; `destroyAll` cleans up orphan containers.
- **Container keep-alive**: `tail -f /dev/null || sleep infinity` keeps the container running.

### Container Configuration

```ts
const provider = new DockerSandboxProvider({
  defaultImage: "node:20-alpine",
});
```

Automatically set on creation:
- Unique container name: `vera-sb-{randomHex(8)}`
- Docker labels: `vera.sandbox=true`, `vera.sandbox.id=<id>`, custom tags
- Optional: CPU limit (`--cpus`), memory limit (`--memory`)
- Optional: Network mode (`--network`), volume mounts (`--volume`)
- Optional: Environment variables (`--env`), working directory (`--workdir`)

### Status Mapping

| Docker State | SandboxStatus |
|-------------|---------------|
| `created` | `creating` |
| `running` | `ready` |
| `paused` / `restarting` / `exited` / `dead` | `stopped` |
| `removing` | `destroyed` |

### Command Execution Safety

`exec` runs commands via `docker exec` using `/bin/sh -c` as the shell. stdin is injected via `printf '%s' ... | command` (using `JSON.stringify` for escaping), never directly concatenated into shell commands.

### Error Handling

- Docker daemon unavailable -> `SandboxConnectionError`
- Container not found -> `SandboxNotFoundError`
- Command timeout -> `SandboxTimeoutError` (detects `killed`, `ETIMEDOUT`, `SIGTERM`)
- Non-zero exit code -> returns result rather than throwing (caller checks `exitCode`)

---

## Tool Integration

### Three Sandbox Tools

`packages/core/src/tools/sandbox.ts` defines three standard tools:

| Tool | Purpose | Required Args | Optional Args |
|------|---------|---------------|---------------|
| `sandbox_exec` | Execute command in sandbox | `sandboxId`, `command` | `workdir`, `env`, `timeoutSeconds` |
| `sandbox_upload` | Upload file to sandbox | `sandboxId`, `remotePath` | `localPath`, `content` |
| `sandbox_download` | Download file from sandbox | `sandboxId`, `remotePath` | `localPath` |

### Execution Flow

```
Agent -> tool_call: sandbox_exec({sandboxId: "sb-123", command: "npm test"})
  |
  v
SandboxExecTool.execute(args, ctx)
  |
  +-- 1. Get SandboxProvider (ctx.sandboxProvider)
  |     +-- unavailable -> return errorResult
  |
  +-- 2. Find SandboxInstance (provider.get(args.sandboxId))
  |     +-- not found -> return NOT_FOUND
  |
  +-- 3. Execute command (instance.exec(command, options))
  |     +-- default timeout 120s
  |
  +-- 4. Format result
       +-- ok: exitCode === 0
       +-- content: stdout + stderr + exit code + duration
       +-- error: EXEC_ERROR on non-zero exit code
```

### ToolContext Injection

The SandboxProvider is injected into all tool contexts via `ToolContext.sandboxProvider`:

```ts
interface ToolContext {
  // ... other fields ...
  sandboxProvider?: SandboxProvider;
}
```

Tool implementations do not directly depend on specific providers; they obtain them through context, preserving testability and substitutability.

---

## Security Model

### Implemented Security Controls

| Control Layer | Mechanism | Description |
|---------------|-----------|-------------|
| Process isolation | Docker / CubeSandbox containerization | Sandbox processes cannot access host processes |
| Filesystem isolation | overlay / volume | Host paths not mounted by default |
| Network isolation | `--network none` | No network access by default, must be explicitly enabled |
| Resource limits | `--cpus` / `--memory` | Prevents runaway CPU/memory consumption |
| Timeout control | `timeoutSeconds` | Dual timeout at command and sandbox level |
| Tool-layer security | SecurityPlugin | Path sanitization, tool allowlist, budget control |

### SecurityPlugin Integration

Sandbox tool execution paths go through `SecurityPlugin`'s `onBeforeToolCall` hook:

1. **Path escape check**: Ensures file upload/download paths do not escape the sandbox boundary.
2. **Tool allowlist**: Sandbox tools must be explicitly registered in the allowlist.
3. **Budget control**: Sandbox commands consume token/cost budget.

### Recommended Security Config

```json
{
  "sandbox": {
    "defaultProvider": "docker",
    "docker": {
      "defaultImage": "node:20-alpine",
      "networkMode": "none",
      "resources": {
        "cpuCores": 1,
        "memoryMb": 512
      },
      "timeoutSeconds": 300,
      "allowedVolumes": [
        "./workspace:/workspace:ro"
      ]
    }
  }
}
```

---

## Configuration

### Full Sandbox Config

```json
{
  "sandbox": {
    "enabled": true,
    "defaultProvider": "docker",
    "providers": {
      "docker": {
        "defaultImage": "node:20-alpine",
        "networkMode": "bridge",
        "resources": {
          "cpuCores": 2,
          "memoryMb": 1024,
          "diskMb": 2048
        }
      },
      "cubesandbox": {
        "baseUrl": "http://localhost:8080",
        "apiKey": "$CUBESANDBOX_API_KEY",
        "defaultImage": "ubuntu:22.04"
      }
    },
    "security": {
      "allowedCommands": ["npm", "node", "python", "bash", "ls", "cat"],
      "blockedCommands": ["rm -rf /", "fork bomb"],
      "mountReadOnly": true,
      "networkIsolation": true
    }
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CUBESANDBOX_URL` | CubeSandbox API URL |
| `CUBESANDBOX_API_KEY` | CubeSandbox API auth key |
| `VERA_SANDBOX_PROVIDER` | Default sandbox provider ("docker" / "cubesandbox") |

---

## Error Types

| Error Class | Code | Trigger |
|-------------|------|---------|
| `SandboxError` | Custom | Base class |
| `SandboxNotFoundError` | `SANDBOX_NOT_FOUND` | Sandbox ID does not exist |
| `SandboxTimeoutError` | `SANDBOX_TIMEOUT` | Command execution timed out |
| `SandboxExecError` | `SANDBOX_EXEC_ERROR` | Command execution failed (non-zero exit) |
| `SandboxConnectionError` | `SANDBOX_CONNECTION` | Backend connection failed (Docker daemon or API unreachable) |
| `SandboxQuotaError` | `SANDBOX_QUOTA` | Quota exceeded (HTTP 429) |

---

## Current Status and Roadmap

### Implemented (P1)

- `SandboxProvider` and `SandboxInstance` interface definitions
- `CubeSandboxProvider`: HTTP REST client, complete sandbox lifecycle management
- `DockerSandboxProvider`: Docker CLI driver, local dev and testing
- Three standard sandbox tools (`sandbox_exec` / `sandbox_upload` / `sandbox_download`)
- `ToolContext.sandboxProvider` injection mechanism
- Complete error type system
- Docker label isolation + `destroyAll` orphan container cleanup

### Planned (P2-P3)

| Feature | Priority | Notes |
|---------|----------|-------|
| Sandbox pool | P2 | Pre-create sandbox pools; reuse warm containers to reduce cold-start latency |
| CLI sandbox commands | P2 | `/sandbox create/list/destroy` interactive management |
| In-sandbox editor integration | P2 | Use Edit Tool directly inside sandboxes |
| Kubernetes Pod adapter | P3 | K8s integration for large-scale parallel execution |
| Firecracker adapter | P3 | Lighter-weight microVM backend |
| Sandbox performance monitoring | P3 | Real-time CPU/memory/disk/network metrics |
| Sandbox network policies | P3 | Fine-grained network access control (domain/port allowlists) |
| Snapshot/restore | P3 | Sandbox state snapshots for fast recovery to known states |
