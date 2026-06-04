# Sandbox —— 代码执行隔离

## 概述

Sandbox 系统为 Vera 提供**安全的代码执行环境**。Agent 需要在沙箱内运行脚本、安装依赖、编译代码、执行测试，而不能直接访问宿主机文件系统或网络。所有外部代码执行都必须通过 Sandbox 抽象层；禁止绕过它使用原始的 `child_process`。

Sandbox 不仅是安全边界，还是一个**环境抽象层**：同一个工具调用可以运行在本地 Docker、远程 CubeSandbox 微虚拟机或未来的云沙箱服务上，调用方无需感知后端差异。

---

## 设计原则

### 安全边界

```
宿主机
  |
  +-- 项目文件（可挂载，只读）
  |
  +-- Sandbox 隔离层 -------------------------
       |
       +-- 文件系统：隔离的 overlay / volume
       +-- 网络：bridge / host / none
       +-- 进程：隔离的 PID namespace
       +-- 资源：CPU / 内存 / 磁盘限制
       |
       +-- 工具调用 <-- Agent
```

### 核心原则

1. **隔离优先**：所有用户代码默认在隔离环境中执行，不暴露宿主机。
2. **统一接口**：`SandboxProvider` 接口抽象所有后端；调用方不感知实现。
3. **显式授权**：敏感操作（网络访问、文件挂载）必须在创建时显式声明。
4. **资源限制**：CPU、内存、磁盘和超时都有上限，防止无限制消耗。
5. **受控生命周期**：从创建到销毁全程可追踪；超出作用域自动清理。

---

## 架构

```
packages/core/src/sandbox/
  types.ts          # SandboxProvider 接口 + 错误类型
  cubesandbox.ts    # CubeSandbox 远程微虚拟机适配器
  docker.ts         # Docker CLI 本地容器适配器
  index.ts          # Barrel 导出

packages/core/src/tools/
  sandbox.ts        # Sandbox 工具：sandbox_exec / sandbox_upload / sandbox_download
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
  creating ---> ready ---> running
                  |           |
                  |        stopped
                  |           |
                  v           v
               error      destroyed
```

- `creating`：沙箱正在创建（拉取镜像、环境初始化）
- `ready`：沙箱已启动，等待命令
- `running`：命令正在执行
- `stopped`：已暂停（可恢复）
- `error`：异常状态（超时、资源耗尽等）
- `destroyed`：已销毁（终态，不可恢复）

### 创建选项

```ts
interface SandboxCreateOptions {
  image?: string;                // Docker 镜像（默认 "node:20-alpine"）
  workdir?: string;              // 容器内工作目录
  env?: Record<string, string>;  // 环境变量
  resources?: SandboxResources;  // CPU/内存/磁盘限制
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

### 概述

`CubeSandboxProvider`（`packages/core/src/sandbox/cubesandbox.ts`）是腾讯开源微虚拟机沙箱项目（Apache 2.0）的客户端适配器。CubeSandbox 通过 HTTP REST API 提供与 E2B 兼容的沙箱管理。

### 连接配置

```ts
interface CubeSandboxOptions {
  baseUrl?: string;             // API URL（环境变量 CUBESANDBOX_URL，默认 localhost:8080）
  apiKey?: string;              // 认证密钥（环境变量 CUBESANDBOX_API_KEY）
  defaultImage?: string;        // 默认镜像（默认 "ubuntu:22.04"）
  requestTimeoutMs?: number;    // HTTP 请求超时（默认 30000ms）
}
```

### API 端点

| 方法 | 路径 | 描述 |
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

### HTTP 客户端细节

所有 HTTP 请求通过统一的 `requestCubeSandbox` 函数进行：

- **认证**：`Authorization: Bearer <apiKey>` 头
- **超时**：`AbortController` + `setTimeout`
- **错误映射**：
  - HTTP 404 -> `SandboxNotFoundError`
  - HTTP 429 -> `SandboxQuotaError`
  - 其他错误 -> `SandboxConnectionError`
  - AbortError -> `SandboxTimeoutError`
  - fetch TypeError -> `SandboxConnectionError`
- **文件传输**：使用 base64 编码传输二进制内容

### 使用

```ts
import { CubeSandboxProvider, createCubeSandboxProvider } from "@vera/core";

// 方式 1：工厂函数（推荐）
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

### 概述

`DockerSandboxProvider`（`packages/core/src/sandbox/docker.ts`）是本地 Docker 适配器，通过 Docker CLI（`docker create`、`docker exec`、`docker cp` 等）管理沙箱容器，适用于本地开发和测试。

### 关键技术决策

- **使用 Docker CLI 而非 Docker SDK**：更好的跨平台一致性，无需额外的 npm 依赖。
- **使用 `execFile` 而非 `exec`**：避免 shell 注入；所有参数以数组形式传递。
- **标签管理**：Docker 标签（`vera.sandbox=true`）标记 Vera 管理的容器；`destroyAll` 清理孤儿容器。
- **容器保活**：`tail -f /dev/null || sleep infinity` 保持容器运行。

### 容器配置

```ts
const provider = new DockerSandboxProvider({
  defaultImage: "node:20-alpine",
});
```

创建时自动设置：
- 唯一容器名称：`vera-sb-{randomHex(8)}`
- Docker 标签：`vera.sandbox=true`、`vera.sandbox.id=<id>`、自定义标签
- 可选：CPU 限制（`--cpus`）、内存限制（`--memory`）
- 可选：网络模式（`--network`）、卷挂载（`--volume`）
- 可选：环境变量（`--env`）、工作目录（`--workdir`）

### 状态映射

| Docker 状态 | SandboxStatus |
|------------|---------------|
| `created` | `creating` |
| `running` | `ready` |
| `paused` / `restarting` / `exited` / `dead` | `stopped` |
| `removing` | `destroyed` |

### 命令执行安全

`exec` 通过 `docker exec` 使用 `/bin/sh -c` 作为 shell 运行命令。stdin 通过 `printf '%s' ... | command`（使用 `JSON.stringify` 转义）注入，绝不直接拼接到 shell 命令中。

### 错误处理

- Docker 守护进程不可用 -> `SandboxConnectionError`
- 容器不存在 -> `SandboxNotFoundError`
- 命令超时 -> `SandboxTimeoutError`（检测 `killed`、`ETIMEDOUT`、`SIGTERM`）
- 非零退出码 -> 返回结果而非抛出异常（调用方检查 `exitCode`）

---

## 工具集成

### 三个 Sandbox 工具

`packages/core/src/tools/sandbox.ts` 定义了三个标准工具：

| 工具 | 用途 | 必需参数 | 可选参数 |
|------|------|---------|---------|
| `sandbox_exec` | 在沙箱中执行命令 | `sandboxId`、`command` | `workdir`、`env`、`timeoutSeconds` |
| `sandbox_upload` | 上传文件到沙箱 | `sandboxId`、`remotePath` | `localPath`、`content` |
| `sandbox_download` | 从沙箱下载文件 | `sandboxId`、`remotePath` | `localPath` |

### 执行流程

```
Agent -> tool_call: sandbox_exec({sandboxId: "sb-123", command: "npm test"})
  |
  v
SandboxExecTool.execute(args, ctx)
  |
  +-- 1. 获取 SandboxProvider（ctx.sandboxProvider）
  |     +-- 不可用 -> 返回 errorResult
  |
  +-- 2. 查找 SandboxInstance（provider.get(args.sandboxId)）
  |     +-- 未找到 -> 返回 NOT_FOUND
  |
  +-- 3. 执行命令（instance.exec(command, options)）
  |     +-- 默认超时 120 秒
  |
  +-- 4. 格式化结果
       +-- ok: exitCode === 0
       +-- content: stdout + stderr + 退出码 + 耗时
       +-- error: 非零退出码时返回 EXEC_ERROR
```

### ToolContext 注入

SandboxProvider 通过 `ToolContext.sandboxProvider` 注入到所有工具上下文中：

```ts
interface ToolContext {
  // ... 其他字段 ...
  sandboxProvider?: SandboxProvider;
}
```

工具实现不直接依赖特定提供者；它们通过上下文获取，保持可测试性和可替换性。

---

## 安全模型

### 已实现的安全控制

| 控制层 | 机制 | 描述 |
|--------|------|------|
| 进程隔离 | Docker / CubeSandbox 容器化 | 沙箱进程无法访问宿主机进程 |
| 文件系统隔离 | overlay / volume | 宿主机路径默认不挂载 |
| 网络隔离 | `--network none` | 默认无网络访问，需显式启用 |
| 资源限制 | `--cpus` / `--memory` | 防止 CPU/内存无限制消耗 |
| 超时控制 | `timeoutSeconds` | 命令和沙箱级别的双重超时 |
| 工具层安全 | SecurityPlugin | 路径清理、工具允许列表、预算控制 |

### SecurityPlugin 集成

Sandbox 工具执行路径经过 `SecurityPlugin` 的 `onBeforeToolCall` hook：

1. **路径逃逸检查**：确保文件上传/下载路径不逃逸沙箱边界。
2. **工具允许列表**：Sandbox 工具必须在允许列表中显式注册。
3. **预算控制**：Sandbox 命令消耗 token/费用预算。

### 推荐安全配置

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

## 配置

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
| `CUBESANDBOX_URL` | CubeSandbox API URL |
| `CUBESANDBOX_API_KEY` | CubeSandbox API 认证密钥 |
| `VERA_SANDBOX_PROVIDER` | 默认沙箱提供者（"docker" / "cubesandbox"） |

---

## 错误类型

| 错误类 | 错误码 | 触发条件 |
|--------|--------|---------|
| `SandboxError` | Custom | 基类 |
| `SandboxNotFoundError` | `SANDBOX_NOT_FOUND` | 沙箱 ID 不存在 |
| `SandboxTimeoutError` | `SANDBOX_TIMEOUT` | 命令执行超时 |
| `SandboxExecError` | `SANDBOX_EXEC_ERROR` | 命令执行失败（非零退出码） |
| `SandboxConnectionError` | `SANDBOX_CONNECTION` | 后端连接失败（Docker 守护进程或 API 不可达） |
| `SandboxQuotaError` | `SANDBOX_QUOTA` | 配额超限（HTTP 429） |

---

## 当前状态与路线图

### 已实现（P1）

- `SandboxProvider` 和 `SandboxInstance` 接口定义
- `CubeSandboxProvider`：HTTP REST 客户端，完整的沙箱生命周期管理
- `DockerSandboxProvider`：Docker CLI 驱动，本地开发和测试
- 三个标准沙箱工具（`sandbox_exec` / `sandbox_upload` / `sandbox_download`）
- `ToolContext.sandboxProvider` 注入机制
- 完整的错误类型系统
- Docker 标签隔离 + `destroyAll` 孤儿容器清理

### 计划中（P2-P3）

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 沙箱池 | P2 | 预创建沙箱池；复用热容器减少冷启动延迟 |
| CLI 沙箱命令 | P2 | `/sandbox create/list/destroy` 交互管理 |
| 沙箱内编辑器集成 | P2 | 在沙箱内直接使用 Edit Tool |
| Kubernetes Pod 适配器 | P3 | K8s 集成，支持大规模并行执行 |
| Firecracker 适配器 | P3 | 更轻量的微虚拟机后端 |
| 沙箱性能监控 | P3 | 实时 CPU/内存/磁盘/网络指标 |
| 沙箱网络策略 | P3 | 细粒度网络访问控制（域名/端口允许列表） |
| 快照/恢复 | P3 | 沙箱状态快照，快速恢复到已知状态 |
