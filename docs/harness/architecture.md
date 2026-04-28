# Vera 桌面端架构设计

## 整体架构

Vera 是一个多智能体协作编排系统，以 Tauri 桌面应用的形式分发。

```
┌──────────────────────────────────────────────────────┐
│                Tauri Desktop App                      │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Layer 3: Vue 3 Frontend (Webview)              │ │
│  │  Element Plus UI + Chart.js 统计                 │ │
│  │  ├── FlowRunner: 选择 flow + 输入 task + 执行   │ │
│  │  ├── SessionList: 会话列表 + 详情查看            │ │
│  │  ├── FlowVisualizer: FSM 流程可视化             │ │
│  │  └── StatsPanel: 成本/Token/耗时统计            │ │
│  └────────────────────┬────────────────────────────┘ │
│                       │ Tauri IPC (invoke)            │
│  ┌────────────────────▼────────────────────────────┐ │
│  │  Layer 2: Rust Backend (Tauri Commands)         │ │
│  │  ├── list_sessions()  读取 sessions 目录        │ │
│  │  ├── get_session(id)  读取 result.json          │ │
│  │  ├── get_blackboard() 读取 blackboard.json      │ │
│  │  ├── list_flows()     列出可用 flow 配置        │ │
│  │  └── run_flow()       启动编排 sidecar 进程     │ │
│  └────────────────────┬────────────────────────────┘ │
│                       │ spawn + stdout/stderr         │
│  ┌────────────────────▼────────────────────────────┐ │
│  │  Layer 1: Sidecar — vera-core (Node.js SEA)    │ │
│  │  ├── FSM Orchestrator (PROPOSE→CRITIQUE→DECIDE) │ │
│  │  ├── Agent Adapters (Claude, Gemini, OpenCode)  │ │
│  │  ├── Blackboard (角色写入约束 + 乐观锁)         │ │
│  │  ├── Config Loader (YAML + 凭证注入)            │ │
│  │  └── Observability (Trace + Cost Tracking)      │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  📁 数据目录                                         │
│  ├── configs/   流程配置、Agent 注册、凭证           │
│  └── sessions/  编排结果 (result.json, blackboard)   │
└──────────────────────────────────────────────────────┘
```

## Monorepo 结构

```
vera-desktop/multi-agent-mvp/
├── pnpm-workspace.yaml         # Workspace 定义
├── package.json                # Root: workspace scripts
├── tsconfig.base.json          # 共享 TS 配置
├── configs/                    # 运行时配置（不打包到代码中）
│   ├── adapters.yaml           # Agent 启动命令
│   ├── agents.yaml             # Agent 注册表（能力、成本）
│   ├── credentials.json        # 凭证（gitignore）
│   └── flows/                  # 流程编排定义
│       ├── minimal.yaml
│       ├── cc-only.yaml
│       ├── cc-mixed.yaml
│       ├── heterogeneous.yaml
│       └── code-review-debate.yaml
├── sessions/                   # 运行结果
├── demo/                       # 演示脚本
│   ├── start.sh                # 一键启动 Server + Web UI
│   └── run-flow.sh             # 运行一次编排
├── packages/
│   ├── types/                  # @vera/types — 共享类型 + Zod Schemas
│   │   └── src/
│   │       ├── protocol.ts     # 消息协议（proposal/critique/decision）
│   │       ├── agent.ts        # Agent 配置 + 状态
│   │       ├── blackboard.ts   # Blackboard 状态 + 写入约束
│   │       ├── flow.ts         # FSM 状态 + Flow 配置
│   │       └── session.ts      # Session 配置 + 结果
│   ├── core/                   # @vera/core — 编排引擎 + CLI
│   │   └── src/
│   │       ├── index.ts        # CLI 入口 (vera run)
│   │       ├── cli/run.ts      # 参数解析 + 编排启动
│   │       ├── orchestrator/   # FSM 编排器
│   │       ├── adapters/       # Agent 适配器 (5个)
│   │       ├── blackboard/     # Blackboard 内存实现
│   │       ├── config/         # YAML 配置加载 + 凭证注入
│   │       ├── transport/      # NDJSON 解析
│   │       └── observability/  # Trace + Cost 追踪
│   ├── server/                 # @vera/server — HTTP API（浏览器模式）
│   │   └── src/index.ts        # GET /api/sessions, POST /api/run
│   └── web-ui/                 # @vera/web-ui — Vue 3 前端 + Tauri
│       ├── src/
│       │   ├── App.vue         # 主界面 (4 个 tab)
│       │   ├── components/
│       │   │   ├── FlowRunner.vue    # 运行编排
│       │   │   ├── SessionList.vue   # 会话列表
│       │   │   ├── SessionDetail.vue # 会话详情
│       │   │   ├── FlowVisualizer.vue# 流程可视化
│       │   │   └── StatsPanel.vue    # 统计面板
│       │   └── composables/
│       │       ├── useSessions.ts    # 双模式: Tauri IPC / HTTP fetch
│       │       └── useOrchestrator.ts# 编排控制
│       └── src-tauri/
│           ├── tauri.conf.json # Tauri 配置
│           ├── Cargo.toml      # Rust 依赖
│           └── src/lib.rs      # Rust Backend (Tauri Commands)
```

## 双模式运行

### 浏览器模式（开发 / 远程访问）

```
Terminal 1:  node packages/server/dist/index.js --port 3000
Terminal 2:  cd packages/web-ui && pnpm dev
Browser:     http://localhost:5173
```

前端通过 HTTP API 与 server 通信：
- `GET /api/sessions` → 会话列表
- `GET /api/sessions/:id` → 会话详情
- `GET /api/sessions/:id/blackboard` → Blackboard
- `GET /api/flows` → Flow 配置列表
- `POST /api/run` → 启动编排

### Tauri 桌面模式（最终分发）

```
pnpm dev:tauri   # 开发模式
pnpm build:tauri # 打包 .dmg / .exe / .AppImage
```

前端通过 Tauri IPC 与 Rust 后端通信：
- `invoke('list_sessions')` → 直接读文件系统
- `invoke('run_flow', { flowPath, task })` → spawn sidecar 进程

## Sidecar 打包方案

### Node.js SEA (Single Executable Application)

Node.js 20+ 原生支持将应用打包为单文件可执行二进制：

```bash
# 1. Bundle
esbuild packages/core/src/index.ts --bundle --platform=node --outfile=vera-core.cjs

# 2. 创建 SEA blob
echo '{"main":"vera-core.cjs","output":"vera-core.blob"}' > sea-config.json
node --experimental-sea-config sea-config.json

# 3. 注入到 node 二进制
cp $(which node) vera-core
npx postject vera-core NODE_SEA_BLOB vera-core.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 4. 签名 (macOS)
codesign --sign - vera-core
```

产出的 `vera-core` 二进制文件约 80-100MB，包含 Node.js runtime + 全部业务代码。

### Tauri Sidecar 配置

在 `tauri.conf.json` 中声明 sidecar：
```json
{
  "bundle": {
    "externalBin": ["binaries/vera-core"]
  }
}
```

Tauri 会自动按平台查找 `binaries/vera-core-{arch}` 并打包到 app bundle。

## 数据目录策略

| 环境 | configs/ | sessions/ |
|------|----------|-----------|
| 开发 | 项目根 `configs/` | 项目根 `sessions/` |
| Tauri Dev | 同上 | 同上 |
| Tauri Prod (macOS) | `~/Library/Application Support/com.vera.multi-agent/configs/` | `~/Library/Application Support/com.vera.multi-agent/sessions/` |
| Tauri Prod (Windows) | `%APPDATA%\com.vera.multi-agent\configs\` | `%APPDATA%\com.vera.multi-agent\sessions\` |

首次启动时，从 app bundle 的 resources/ 复制默认 configs 到用户数据目录。

## 依赖关系

```
@vera/types  ←── 零外部依赖（仅 zod）
     ↑
@vera/core   ←── yaml, execa, zod, pino, expr-eval, deepmerge-ts
     ↑
@vera/server ←── 零外部依赖（纯 Node.js http）
     
@vera/web-ui ←── vue, element-plus, chart.js, @vera/types
                  Tauri: tauri-apps/api, plugin-dialog, plugin-fs
```

## 构建命令

```bash
pnpm build            # 构建所有包
pnpm test             # 运行测试 (28 个)
pnpm dev              # 并行开发模式

# 单包操作
pnpm --filter @vera/core build
pnpm --filter @vera/core test
pnpm --filter @vera/web-ui dev
pnpm --filter @vera/web-ui dev:tauri

# Markdown Harness Flow
vera flow run --dir ./demo
```

## Harness Flow 系统

### 设计理念

**目录结构即配置，Markdown 即定义。** 用户不需要写 YAML 脚本，只需要在项目中创建 `.flow/` 目录，用 Markdown 描述角色、步骤和标准。

### 工作目录结构

```
my-project/                           # 用户项目根目录
├── src/                              # 用户项目代码
└── .flow/                            # Vera harness 配置
    ├── flow.md                       # 主编排：步骤顺序 + 衔接关系
    ├── task/
    │   └── goal.md                   # 本次目标描述
    ├── agents/                       # 角色定义（完全开放）
    │   ├── developer/
    │   │   ├── main.md               # 角色名片 + 模型配置
    │   │   ├── code-standards.md     # 知识库：代码规范
    │   │   └── tech-stack.md         # 知识库：技术栈
    │   ├── pm/
    │   │   ├── main.md
    │   │   └── prd-template.md
    │   ├── tester/
    │   │   ├── main.md
    │   │   └── test-strategy.md
    │   ├── designer/
    │   │   ├── main.md
    │   │   └── design-system.md
    │   └── user/
    │       └── main.md
    └── flows/                        # 步骤定义
        ├── requirement/
        │   ├── README.md             # 准出标准 + 产物定义
        │   └── output/               # 步骤产出
        ├── design/
        │   ├── README.md
        │   └── output/
        ├── implement/
        │   ├── README.md
        │   └── output/
        ├── testing/
        │   ├── README.md
        │   └── output/
        └── review/
            ├── README.md
            └── output/
```

### 核心概念

| 概念 | 载体 | 说明 |
|------|------|------|
| **目标** | `task/goal.md` | 本次 harness 要达成什么 |
| **角色** | `agents/xxx/main.md` | 角色名片 + 使用的模型 |
| **知识库** | `agents/xxx/*.md` | 角色的专业资料，按需读取 |
| **步骤** | `flows/xxx/README.md` | 定义产物、准出标准、参与角色 |
| **产物** | `flows/xxx/output/` | 步骤的输出文件 |
| **编排** | `flow.md` | 步骤顺序 + 输入输出衔接 |

### 执行流程

```
解析 flow.md → 按步骤顺序遍历
    ↓
每步骤:
  1. 读取 task/goal.md (任务目标)
  2. 读取参与角色的 main.md + 知识库文件
  3. 读取步骤 README.md (准出标准)
  4. 读取上一步骤的 output/ (输入链)
  5. 组装 prompt → 调用 Agent
  6. 解析输出 → 写入 output/
    ↓
所有步骤完成 → 最终产物在各 flows/*/output/ 中
```

### 角色设计原则

Agent 角色完全开放，不限于固定的三种。以开发流程为例：

- **pm** — 产品经理：需求分析、优先级、验收
- **developer** — 开发工程师：技术方案、代码实现
- **designer** — 设计师：交互设计、视觉规范
- **tester** — 测试工程师：测试策略、用例编写
- **user** — 用户代表：从使用者角度评估

每个角色有自己的**知识库文件夹**（`agents/xxx/`），存放该角色的专业资料。只有当 agent 进入对应环节时，才按需读取这些资料作为上下文。
