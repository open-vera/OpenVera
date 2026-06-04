# Shared 包文档

> Package: `@open-vera/shared` | Source: `packages/shared/src/index.ts`
> 最后更新: 2025-06-04

## 概述

`@open-vera/shared` 是 OpenVera monorepo 的共享类型包，提供跨包通用的 TypeScript 类型定义。它与 `@open-vera/logger` 同属基础设施层——不含任何运行时逻辑，仅导出接口（interface）和类型别名（type），供上层业务包（`harness`、`gateway`）引用。

设计原则：

- **零运行时依赖**：纯类型定义，编译后 `dist/` 仅含 `.d.ts` 声明文件
- **单向依赖**：shared 不依赖任何其他 `@open-vera/*` 包，是最底层的公共契约
- **稳定 API**：类型变更即 Breaking Change，需同步更新所有消费方

---

## API 总览

shared 包共导出 18 个类型，归类为三大领域：

| 领域 | 类型数量 | 主要使用者 |
|---|---|---|
| Capability（能力描述） | 6 个类型 | `@open-vera/harness`、`@open-vera/gateway` |
| Project（项目注册） | 3 个类型 | `@open-vera/gateway` |
| Doctor（系统诊断） | 3 个类型 | `@open-vera/gateway` |

---

## Capability 能力类型

Capability 是 OpenVera 中描述系统能力的基本单元。每个 Capability 代表一项可被启用、禁用、检测、测试的功能模块。

### CapabilityKind — 能力种类

```typescript
export type CapabilityKind =
  | "config"       // 配置管理
  | "provider"     // LLM 提供商
  | "model"        // 模型注册
  | "prompt"       // 提示词模板
  | "context"      // 上下文管理
  | "memory"       // 记忆/持久化
  | "rag"          // 检索增强生成
  | "skill"        // 自定义技能
  | "plugin"       // 插件系统
  | "mcp"          // Model Context Protocol
  | "channel"      // 消息通道（CLI/HTTP/Discord等）
  | "sandbox"      // 沙箱执行
  | "flow"         // Flow 工作流
  | "conversation" // 对话管理
  | "tool"         // 工具注册
  | "log"          // 日志系统
  | "cost";        // 成本追踪
```

这个联合类型覆盖了 OpenVera 所有功能模块，作为 Gateway 控制面板中能力管理的数据基础。每种 `kind` 对应系统中的一个功能域，Gateway 据此渲染对应的管理界面。

### CapabilityScope — 能力作用域

```typescript
export type CapabilityScope = "global" | "project" | "session" | "run";
```

| 值 | 含义 | 示例 |
|---|---|---|
| `global` | 全局生效，跨所有项目 | 日志配置、API Key |
| `project` | 项目级别，作用于单个项目 | 项目级 .vera 配置 |
| `session` | 会话级别，作用于单次会话 | 会话内的临时 skill |
| `run` | 单次运行级别 | 单次 Flow 执行中的工具 |

### CapabilityStatus — 能力状态

```typescript
export type CapabilityStatus = "available" | "disabled" | "error" | "unknown";
```

| 值 | 含义 |
|---|---|
| `available` | 可用，正常工作 |
| `disabled` | 已禁用（用户主动关闭或条件不满足） |
| `error` | 异常状态（配置错误、依赖缺失等） |
| `unknown` | 尚未检测，状态未知 |

### CapabilityAction — 可执行操作

```typescript
export type CapabilityAction =
  | "view"       // 查看详情
  | "edit"       // 编辑配置
  | "enable"     // 启用
  | "disable"    // 禁用
  | "test"       // 运行自检
  | "reload"     // 重新加载
  | "reindex"    // 重建索引（RAG 等）
  | "connect"    // 连接（通道等）
  | "disconnect";// 断开连接
```

每个 Capability 声明自己支持的操作集合，Gateway 根据此列表渲染可用的操作按钮。例如：
- `kind: "rag"` 可能支持 `["view", "enable", "disable", "reindex"]`
- `kind: "channel"` 可能支持 `["view", "connect", "disconnect"]`
- `kind: "model"` 可能支持 `["view", "test", "enable", "disable"]`

### CapabilityHealth — 健康检查结果

```typescript
export interface CapabilityHealth {
  ok: boolean;
  message?: string;
  checkedAt: string;  // ISO 8601 时间戳
}
```

描述单次健康检查的结果：
- `ok: true` — 检查通过，功能正常
- `ok: false` — 检查失败，`message` 提供失败原因
- `checkedAt` — 检查发生的时间

### CapabilityDescriptor — 能力完整描述

```typescript
export interface CapabilityDescriptor {
  id: string;                  // 唯一标识
  kind: CapabilityKind;        // 能力种类
  name: string;                // 显示名称
  status: CapabilityStatus;    // 当前状态
  scope: CapabilityScope;      // 作用域
  source: string;              // 来源（内置 builtin / 插件 plugin-xxx / 配置 .vera/xxx）
  projectId?: string;          // 所属项目（scope 为 project 时）
  configPath?: string;         // 配置文件路径
  health?: CapabilityHealth;   // 最近一次健康检查结果
  actions: CapabilityAction[]; // 支持的操作列表
  metadata: Record<string, unknown>; // 扩展元数据
}
```

这是 Capability 体系的完整数据模型。`CapabilityDescriptor` 是 Gateway 控制面板展示和管理能力的数据载体。每个字段的含义：

- **id**：系统内唯一标识符，用于查找和引用
- **kind**：归类到 17 种能力种类之一
- **name**：用户可读的显示名称
- **status**：当前运行状态，影响面板中的状态指示灯
- **scope**：决定该能力在哪个层级可见和可操作
- **source**：标识该能力的来源——内置（`builtin`）、插件（`plugin-{name}`）或项目配置（`.vera/settings.json`）
- **projectId**：项目级能力关联的项目标识
- **configPath**：关联的配置文件路径，用于编辑和重载操作
- **health**：最近一次健康检查的快照，用于展示系统状态概览
- **actions**：该能力支持的操作白名单，控制 UI 中可用的按钮
- **metadata**：任意扩展的键值对，插件可用此字段存储自定义数据

---

## Project 项目注册类型

提供 Gateway 发现和管理多个 Vera 项目所需的类型定义。

### GatewayProject — 项目信息

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
| `flowsDir` | Flow 定义文件存放目录 |
| `source` | 来源：`explicit`（用户手动添加）或 `discovered`（自动扫描发现） |

### ProjectRegistryOptions — 项目扫描选项

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

Gateway 使用 `ProjectRegistryOptions` 配置项目发现行为。`roots` 指定从哪里开始扫描 `.vera` 目录，`includeChildren` 控制是否深入子目录寻找嵌套项目。

---

## Doctor 系统诊断类型

Doctor 是 OpenVera 的系统自检工具，用于诊断运行环境、配置完整性和功能可用性。这三个类型定义了诊断流程的数据结构。

### DoctorStatus — 诊断状态

```typescript
export type DoctorStatus = "pass" | "warn" | "fail";
```

| 值 | 含义 | 示例 |
|---|---|---|
| `pass` | 检查通过 | Node.js 版本符合要求 |
| `warn` | 有警告但不阻塞 | 推荐配置项缺失，使用默认值 |
| `fail` | 检查失败，需修复 | API Key 未配置，无法连接 LLM |

### DoctorCheck — 单项诊断检查

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
| `id` | 检查项唯一标识，如 `node-version`、`provider-auth` |
| `label` | 用户可读的检查标题，如 "Node.js 版本检查" |
| `status` | 检查结果（pass/warn/fail） |
| `scope` | 检查范围：`gateway`（全局）、`project`（项目级）、`capability`（能力级） |
| `message` | 面向用户的描述信息 |
| `projectId` | scope 为 project 时关联的项目 ID |
| `capabilityId` | scope 为 capability 时关联的能力 ID |
| `details` | 检查的详细数据（版本号、错误堆栈、配置值等） |

### DoctorReport — 诊断报告

```typescript
export interface DoctorReport {
  generatedAt: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
}
```

| 字段 | 含义 |
|---|---|
| `generatedAt` | 报告生成时间（ISO 8601） |
| `status` | 整体诊断结论：所有通过为 `pass`，有警告为 `warn`，任一失败为 `fail` |
| `checks` | 所有诊断项的完整列表 |

整体 `status` 的判定规则采用最严格原则：`fail` > `warn` > `pass`。即只要有一项 `fail`，整体就是 `fail`；没有 `fail` 但有 `warn`，整体就是 `warn`。

---

## 消费方

### @open-vera/harness

Harness 通过 `workspace:*` 依赖 `@open-vera/shared`，在运行时使用 `CapabilityKind`、`CapabilityScope`、`CapabilityStatus` 等类型来描述 Flow 执行中的能力状态变化。当 Harness 执行一个需要特定能力的任务时（如调用 RAG、切换模型），使用这些类型记录能力的使用和状态。

### @open-vera/gateway

Gateway 包是 shared 类型的主要消费者，几乎使用了所有导出类型：

| 使用的类型 | 用途 |
|---|---|
| `CapabilityDescriptor` | 能力注册表中的条目数据模型 |
| `CapabilityKind` / `CapabilityStatus` / `CapabilityAction` | 能力管理 UI 的状态和操作枚举 |
| `GatewayProject` | 项目注册表中的项目数据模型 |
| `ProjectRegistryOptions` | 项目扫描器的配置参数 |
| `DoctorCheck` / `DoctorReport` | 系统诊断模块的诊断项和报告结构 |

Gateway 的 `capability-registry.ts`、`project-registry.ts`、`doctor.ts` 三个核心模块均直接依赖 shared 的类型定义。

---

## 与 monorepo 中其他类型包的区别

OpenVera 的 types 分布在三个层面，应注意区分：

| 类型来源 | 位置 | 内容 | 依赖方向 |
|---|---|---|---|
| `@open-vera/shared` | `packages/shared/` | 跨包公共契约（Capability、Project、Doctor） | 无依赖，最底层 |
| `@open-vera/core types` | `packages/core/src/` | Core 层运行时类型（Flow、Plan、Step、ToolDef 等） | 依赖 shared |
| `@open-vera/harness types` | `packages/harness/src/` | Harness 编排层类型（ExecutionPlan、FlowState 等） | 依赖 shared + core |

**规则**：如果一个类型需要被 `core` 和 `harness` 之外的包（如 `gateway`）引用，它应该定义在 `shared` 中。只被一个包内部使用的类型保留在各自包内。
