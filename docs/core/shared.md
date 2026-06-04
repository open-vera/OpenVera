# Shared 包文档

> Package: `@open-vera/shared` | Source: `packages/shared/src/index.ts`
> 最后更新: 2025-06-04

## 概述

`@open-vera/shared` 是 OpenVera monorepo 的共享类型包，提供跨包通用的 TypeScript 类型定义。零运行时依赖——编译后仅含 `.d.ts` 声明文件，是最底层的公共契约层。不依赖任何其他 `@open-vera/*` 包。

---

## API 总览

共导出 18 个类型，归为三大领域：

| 领域 | 类型数 | 主要消费方 |
|---|---|---|
| Capability（能力描述） | 6 | `@open-vera/harness`、`@open-vera/gateway` |
| Project（项目注册） | 3 | `@open-vera/gateway` |
| Doctor（系统诊断） | 3 | `@open-vera/gateway` |

---

## Capability 能力类型

Capability 是描述系统功能模块的基本单元。每个 Capability 代表一项可启用、禁用、检测的操作。

### CapabilityKind — 能力种类

```typescript
export type CapabilityKind =
  | "config" | "provider" | "model" | "prompt"
  | "context" | "memory" | "rag" | "skill" | "plugin"
  | "mcp" | "channel" | "sandbox" | "flow"
  | "conversation" | "tool" | "log" | "cost";
```

共 17 种，覆盖 OpenVera 全部功能域。Gateway 控制面板据此渲染对应的管理界面。

### CapabilityScope — 作用域

```typescript
export type CapabilityScope = "global" | "project" | "session" | "run";
```

| 值 | 范围 | 示例 |
|---|---|---|
| `global` | 全局跨项目 | 日志配置、API Key |
| `project` | 单个项目 | 项目级 .vera 配置 |
| `session` | 单次会话 | 会话内临时 skill |
| `run` | 单次运行 | 单次 Flow 执行中的工具 |

### CapabilityStatus — 状态

```typescript
export type CapabilityStatus = "available" | "disabled" | "error" | "unknown";
```

`available`（正常）、`disabled`（已禁用）、`error`（异常）、`unknown`（未检测）。

### CapabilityAction — 可执行操作

```typescript
export type CapabilityAction =
  | "view" | "edit" | "enable" | "disable"
  | "test" | "reload" | "reindex" | "connect" | "disconnect";
```

每个 Capability 声明支持的操作白名单，Gateway 据此渲染操作按钮。例如 `kind:"rag"` 支持 `["view","enable","disable","reindex"]`。

### CapabilityHealth — 健康检查

```typescript
export interface CapabilityHealth {
  ok: boolean;
  message?: string;
  checkedAt: string;  // ISO 8601
}
```

### CapabilityDescriptor — 完整描述

```typescript
export interface CapabilityDescriptor {
  id: string;                   // 唯一标识
  kind: CapabilityKind;         // 能力种类
  name: string;                 // 显示名称
  status: CapabilityStatus;     // 当前状态
  scope: CapabilityScope;       // 作用域
  source: string;               // 来源（builtin / plugin-xxx / .vera/xxx）
  projectId?: string;           // 所属项目
  configPath?: string;          // 配置文件路径
  health?: CapabilityHealth;    // 最近健康检查
  actions: CapabilityAction[];  // 支持的操作
  metadata: Record<string, unknown>; // 扩展元数据
}
```

这是 Capability 体系的完整数据模型，Gateway 能力注册表以此为基础数据结构。

---

## Project 项目注册类型

### GatewayProject

```typescript
export interface GatewayProject {
  id: string;
  name: string;
  rootDir: string;
  veraDir: string;
  flowsDir: string;
  source: "explicit" | "discovered";
}
```

| 字段 | 含义 |
|---|---|
| `id` | 项目唯一标识 |
| `name` | 项目名称 |
| `rootDir` | 项目根目录（绝对路径） |
| `veraDir` | `.vera` 配置目录路径 |
| `flowsDir` | Flow 定义文件目录 |
| `source` | `explicit`（手动添加）或 `discovered`（自动扫描） |

### ProjectRegistryOptions

```typescript
export interface ProjectRegistryOptions {
  roots: string[];
  includeChildren?: boolean;
}
```

| 字段 | 含义 | 默认值 |
|---|---|---|
| `roots` | 扫描根目录列表 | 必填 |
| `includeChildren` | 是否递归扫描子目录 | `false` |

Gateway 的 `project-registry.ts` 使用此配置控制项目发现行为。

---

## Doctor 系统诊断类型

Doctor 是 OpenVera 的自检工具，诊断运行环境、配置完整性和功能可用性。

### DoctorStatus

```typescript
export type DoctorStatus = "pass" | "warn" | "fail";
```

| 值 | 含义 | 示例 |
|---|---|---|
| `pass` | 通过 | Node.js 版本符合要求 |
| `warn` | 警告不阻塞 | 推荐配置缺失，使用默认值 |
| `fail` | 失败需修复 | API Key 未配置 |

### DoctorCheck

```typescript
export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  scope: "gateway" | "project" | "capability";
  message: string;
  projectId?: string;
  capabilityId?: string;
  details: Record<string, unknown>;
}
```

| 字段 | 含义 |
|---|---|
| `id` | 检查项 ID，如 `node-version`、`provider-auth` |
| `label` | 用户可读标题，如 "Node.js 版本检查" |
| `status` | 结果（pass/warn/fail） |
| `scope` | 范围：gateway（全局）/ project（项目）/ capability（能力） |
| `message` | 面向用户的描述 |
| `projectId` | scope 为 project 时关联的项目 ID |
| `capabilityId` | scope 为 capability 时关联的能力 ID |
| `details` | 详细数据（版本号、错误堆栈、配置值等） |

### DoctorReport

```typescript
export interface DoctorReport {
  generatedAt: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
}
```

整体 `status` 采用最严格原则：任一 `fail` 则整体 `fail`；无 `fail` 但有 `warn` 则整体 `warn`。

---

## 消费方

### @open-vera/harness

Harness 在运行时使用 `CapabilityKind`、`CapabilityScope`、`CapabilityStatus` 描述 Flow 执行中的能力状态变化。

### @open-vera/gateway

Gateway 是主要消费者，三个核心模块均直接依赖 shared：

| 模块 | 使用的类型 |
|---|---|
| `capability-registry.ts` | `CapabilityDescriptor`, `CapabilityKind`, `CapabilityStatus`, `CapabilityAction` |
| `project-registry.ts` | `GatewayProject`, `ProjectRegistryOptions` |
| `doctor.ts` | `DoctorCheck`, `DoctorReport`, `DoctorStatus` |

---

## 与其他类型层的关系

| 类型来源 | 内容 | 依赖方向 |
|---|---|---|
| `@open-vera/shared` | 跨包公共契约（Capability、Project、Doctor） | 无依赖，最底层 |
| `@open-vera/core` | Core 运行时类型（Flow、Plan、ToolDef 等） | 依赖 shared |
| `@open-vera/harness` | Harness 编排层类型（ExecutionPlan、FlowState 等） | 依赖 shared + core |

**规则**：需被 core 和 harness 之外的包（如 gateway）引用的类型，定义在 shared 中。仅包内使用的类型保留在各自包内。
