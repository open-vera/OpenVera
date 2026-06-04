# Sandbox — 代码执行隔离系统

## 定位

Sandbox 系统为 Vera 提供**安全的代码执行环境**。agent 需要在沙箱内运行脚本、安装依赖、编译代码、执行测试，但不能直接接触宿主机文件系统或网络。所有外部代码执行都必须通过 Sandbox 抽象层，禁止绕过分层直接使用 `child_process`。

Sandbox 不仅是安全边界，还是**环境抽象层**：同一个工具调用可以在本地 Docker、远程 CubeSandbox 微虚拟机、或未来的云沙箱服务上运行，调用方无需感知后端差异。

---

## 设计原则

### 安全边界

```
宿主机 (Host)
  │
  ├─ 项目文件 (可挂载，只读)
  │
  └─ Sandbox 隔离层 ─────────────────────────────
       │
       ├─ 文件系统：独立 overlay / volume
       ├─ 网络：bridge / host / none
       ├─ 进程：独立 PID namespace
       ├─ 资源：CPU / Memory / Disk 限额
       │
       └─ Tool 调用 ← Agent
```

### 核心原则

1. **隔离优先**：任何用户代码默认在隔离环境中执行，不暴露宿主机
2. **接口统一**：`SandboxProvider` 接口抽象所有后端，调用方不感知实现
3. **显式授权**：敏感操作（网络访问、文件挂载）需在创建时显式声明
4. **资源受限**：CPU、内存、磁盘、超时均有上限，防止失控消耗
5. **生命周期可控**：从创建到销毁全程可追踪，离开作用域自动清理

---

## 架构

```
packages/core/src/sandbox/
  types.ts          # SandboxProvider 接口 + 错误类型
  cubesandbox.ts    # CubeSandbox 远程微虚拟机适配器
  docker.ts         # Docker CLI 本地容器适配器
  index.ts          # Barrel export

packages/core/src/tools/
  sandbox.ts        # 沙箱工具：sandbox_exec / sandbox_upload / sandbox_download
```

---

## SandboxProvider 接口

### 接口定义

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

### SandboxInstance 接口

```ts
interface SandboxInstance {
  readonly id: string;
  readonly status: SandboxStatus;  // creating | ready | running | stopped | error | destroyed
  readonly provider: string;
  readonly createdAt: Date;

  // 命令执行
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;

  // 文件传输
  upload(localPath: string, remotePath: string): Promise<void>;
  uploadContent(content: string | Uint8Array, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  readFile(remotePath: string): Promise<string>;

  // 生命周期
  stop(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
}
```

### 状态机

```
  creating ──→ ready ──→ running
                  │          │
                  │       stopped
                  │          │
                  ▼          ▼
               error     destroyed
```

- `creating`：沙箱正在创建（镜像拉取、环境初始化）
- `ready`：沙箱已启动，等待命令
- `running`：正在执行命令
- `stopped`：已暂停（可恢复）
- `error`：异常状态（超时、资源耗尽等）
- `destroyed`：已销毁（终态，不可恢复）

### 创建选项

```ts
interface SandboxCreateOptions {
  image?: string;              // Docker 镜像（默认 "node:20-alpine"）
  workdir?: string;            // 容器内工作目录
  env?: Record<string, string>;  // 环境变量
  resources?: SandboxResources;  // CPU/内存/磁盘 限制
  timeoutSeconds?: number;       // 沙箱超时（0 = 无限制）
  tags?: Record<string, string>; // 组织标签
  networkMode?: string;          // "bridge" | "host" | "none"
  volumes?: Array<{
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }>;
}
```

---

## CubeSandbox 适配器

### 定位

`CubeSandboxProvider`（`packages/core/src/sandbox/cubesandbox.ts`）是腾讯开源的微虚拟机沙箱项目（Apache 2.0）的客户端适配器。CubeSandbox 通过 HTTP REST API 提供 E2B 兼容的沙箱管理接口。

### 连接配置

```ts
interface CubeSandboxOptions {
  baseUrl?: string;           // API 地址（环境变量 CUBESANDBOX_URL，默认 localhost:8080）
  apiKey?: string;            // 认证密钥（环境变量 CUBESANDBOX_API_KEY）
  defaultImage?: string;      // 默认镜像（默认 "ubuntu:22.04"）
  requestTimeoutMs?: number;  // HTTP 请求超时（默认 30000ms）
}
```

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/sandboxes` | 创建沙箱 |
| `GET` | `/sandboxes` | 列出所有沙箱 |
| `GET` | `/sandboxes/:id` | 获取沙箱信息 |
| `DELETE` | `/sandboxes/:id` | 销毁单个沙箱 |
| `DELETE` | `/sandboxes` | 销毁所有沙箱 |
| `POST` | `/sandboxes/:id/exec` | 执行命令 |
| `POST` | `/sandboxes/:id/files/:path` | 上传文件 |
| `GET` | `/sandboxes/:id/files/:path` | 读取/下载文件 |
| `POST` | `/sandboxes/:id/stop` | 暂停沙箱 |
| `POST` | `/sandboxes/:id/resume` | 恢复沙箱 |

### HTTP 客户端实现细节

所有 HTTP 请求通过统一的 `requestCubeSandbox` 函数发出：

- **认证**：`Authorization: Bearer <apiKey>` header
- **超时**：`AbortController` + `setTimeout` 实现请求超时
- **错误映射**：
  - HTTP 404 → `SandboxNotFoundError`
  - HTTP 429 → `SandboxQuotaError`
  - 其他错误 → `SandboxConnectionError`
  - AbortError → `SandboxTimeoutError`
  - fetch TypeError → `SandboxConnectionError`
- **文件传输**：使用 base64 编码传输二进制内容

### 使用示例

```ts
import { CubeSandboxProvider, createCubeSandboxProvider } from "@vera/core";

// 方式 1：使用工厂函数（推荐）
const provider = createCubeSandboxProvider({
  baseUrl: "https://sandbox.example.com/api",
  apiKey: process.env.CUBESANDBOX_API_KEY,
});

// 方式 2：直接实例化
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

## Docker 适配器

### 定位

`DockerSandboxProvider`（`packages/core/src/sandbox/docker.ts`）是本地 Docker 的适配器，通过 Docker CLI（`docker create`、`docker exec`、`docker cp` 等）管理沙箱容器，适合本地开发和测试。

### 关键技术决策

- **使用 Docker CLI而非 Docker SDK**：CLI 在各平台一致性更好，无额外 npm 依赖
- **`execFile` 而非 `exec`**：避免 shell 注入，所有参数以数组传递
- **标签管理**：通过 Docker label（`vera.sandbox=true`）标记 Vera 管理的容器，`destroyAll` 时清理孤儿容器
- **容器保活**：`tail -f /dev/null || sleep infinity` 保持容器运行

### 容器配置

```ts
const provider = new DockerSandboxProvider({
  defaultImage: "node:20-alpine",
});
```

创建时自动设置：
- 唯一容器名：`vera-sb-{randomHex(8)}`
- Docker labels：`vera.sandbox=true`、`vera.sandbox.id=<id>`、自定义 tags
- 可选：CPU 限制（`--cpus`）、内存限制（`--memory`）
- 可选：网络模式（`--network`）、卷挂载（`--volume`）
- 可选：环境变量（`--env`）、工作目录（`--workdir`）

### 状态映射

Docker 容器状态到 `SandboxStatus` 的映射：

| Docker State | SandboxStatus |
|-------------|---------------|
| `created` | `creating` |
| `running` | `ready` |
| `paused` / `restarting` / `exited` / `dead` | `stopped` |
| `removing` | `destroyed` |

### 命令执行安全

`exec` 方法通过 `docker exec` 执行命令，使用 `/bin/sh -c` 作为 shell。stdin 通过 `printf '%s' ... | command` 注入（使用 `JSON.stringify` 转义），不会直接拼接到 shell 命令中。

### 异常处理

- Docker daemon 不可用 → `SandboxConnectionError`
- 容器不存在 → `SandboxNotFoundError`
- 命令执行超时 → `SandboxTimeoutError`（检测 `killed`、`ETIMEDOUT`、`SIGTERM`）
- 非零退出码 → 返回结果而非抛异常（调用方可检查 `exitCode`）

---

## Tool 集成

### 三个沙箱工具

`packages/core/src/tools/sandbox.ts` 定义了三个标准 tool：

| 工具 | 用途 | 必填参数 | 可选参数 |
|------|------|---------|---------|
| `sandbox_exec` | 在沙箱内执行命令 | `sandboxId`, `command` | `workdir`, `env`, `timeoutSeconds` |
| `sandbox_upload` | 上传文件到沙箱 | `sandboxId`, `remotePath` | `localPath`, `content` |
| `sandbox_download` | 从沙箱下载文件 | `sandboxId`, `remotePath` | `localPath` |

### 工具执行流程

```
Agent → tool_call: sandbox_exec({sandboxId: "sb-123", command: "npm test"})
  │
  ▼
SandboxExecTool.execute(args, ctx)
  │
  ├─ 1. 获取 SandboxProvider (ctx.sandboxProvider)
  │     └─ 不可用 → 返回 errorResult
  │
  ├─ 2. 查找 SandboxInstance (provider.get(args.sandboxId))
  │     └─ 不存在 → 返回 NOT_FOUND
  │
  ├─ 3. 执行命令 (instance.exec(command, options))
  │     └─ 默认超时 120s
  │
  └─ 4. 格式化返回
       ├─ ok: exitCode === 0
       ├─ content: stdout + stderr + exit code + duration
       └─ error: 非零退出码时附带 EXEC_ERROR
```

### ToolContext 注入

SandboxProvider 通过 `ToolContext.sandboxProvider` 注入到所有工具的上下文中：

```ts
interface ToolContext {
  // ... 其他字段 ...
  sandboxProvider?: SandboxProvider;
}
```

工具实现不直接依赖具体 provider，而是通过 context 获取，保持可测试性和可替换性。

---

## 安全模型

### 已实现的安全控制

| 控制层 | 机制 | 说明 |
|--------|------|------|
| 进程隔离 | Docker / CubeSandbox 容器化 | 沙箱内进程无法访问宿主机进程 |
| 文件系统隔离 | overlay / volume | 默认不挂载宿主机路径 |
| 网络隔离 | `--network none` | 默认无网络访问，需显式开启 |
| 资源限制 | `--cpus` / `--memory` | 防止 CPU / 内存消耗失控 |
| 超时控制 | `timeoutSeconds` | 单命令和沙箱级别双重超时 |
| 工具层安全 | SecurityPlugin | 路径净化、工具白名单、预算控制 |

### SecurityPlugin 集成

Sandbox 工具的执行路径经过 `SecurityPlugin` 的 `onBeforeToolCall` hook：

1. **路径越界检查**：确保文件上传/下载路径不逃逸出沙箱边界
2. **工具白名单**：sandbox 工具需显式注册到白名单
3. **预算控制**：沙箱命令消耗计入 token/费用预算

### 推荐的安全配置

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

## 配置示例

### 完整 Sandbox 配置

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

### 环境变量

| 变量 | 用途 |
|------|------|
| `CUBESANDBOX_URL` | CubeSandbox API 地址 |
| `CUBESANDBOX_API_KEY` | CubeSandbox API 认证密钥 |
| `VERA_SANDBOX_PROVIDER` | 默认沙箱提供方（"docker" / "cubesandbox"） |

---

## 错误类型

| 错误类 | Code | 触发条件 |
|--------|------|---------|
| `SandboxError` | 自定义 | 基类 |
| `SandboxNotFoundError` | `SANDBOX_NOT_FOUND` | 沙箱 ID 不存在 |
| `SandboxTimeoutError` | `SANDBOX_TIMEOUT` | 命令执行超时 |
| `SandboxExecError` | `SANDBOX_EXEC_ERROR` | 命令执行失败（非零退出码） |
| `SandboxConnectionError` | `SANDBOX_CONNECTION` | 连接后端失败（Docker daemon 或 API 不可达） |
| `SandboxQuotaError` | `SANDBOX_QUOTA` | 配额超限（HTTP 429） |

---

## 当前状态与路线图

### 已实现 (P1)

- `SandboxProvider` 与 `SandboxInstance` 接口定义
- `CubeSandboxProvider`：HTTP REST 客户端，完整沙箱生命周期管理
- `DockerSandboxProvider`：Docker CLI 驱动，本地开发和测试
- 三个标准沙箱 tool（`sandbox_exec` / `sandbox_upload` / `sandbox_download`）
- `ToolContext.sandboxProvider` 注入机制
- 完整的错误类型体系
- Docker 标签隔离 + `destroyAll` 孤儿容器清理

### 计划实现 (P2-P3)

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 沙箱池（Sandbox Pool） | P2 | 预创建沙箱池，复用热容器减少冷启动延迟 |
| CLI 沙箱命令 | P2 | `/sandbox create/list/destroy` 交互式管理 |
| 沙箱内编辑器集成 | P2 | 支持在沙箱内直接使用 Edit Tool |
| Kubernetes Pod 适配器 | P3 | 接入 K8s，适合大规模并行执行 |
| Firecracker 适配器 | P3 | 更轻量级的 microVM 后端 |
| 沙箱性能监控 | P3 | CPU/内存/磁盘/网络的实时指标采集 |
| 沙箱网络策略 | P3 | 精细化的网络访问控制（域名/端口白名单） |
| 快照/恢复 | P3 | 沙箱状态快照，快速恢复到已知状态 |
