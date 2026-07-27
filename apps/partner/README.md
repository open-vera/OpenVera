# Partner

OpenVera AI Agent 桌面端应用（Tauri 2 + Vue 3）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面宿主 / Workbench Host | Tauri 2.x + Rust（`src-tauri/src/host/`） |
| 前端壳 | Vue 3.5 + Vite 6 + Pinia 2（`src/shell/`） |
| Extension Host | Node sidecar（Agent / LLM / LSP） |
| 持久化 | `~/.vera/partner/app-state.json`（Host 读写） |

架构说明见 [docs/zh/partner/host-architecture.md](../../docs/zh/partner/host-architecture.md)。  
多项目 / 会话布局见 [docs/zh/partner/multi-project-layout.md](../../docs/zh/partner/multi-project-layout.md)。  
历史 tech-spec 中 WASM / WebView Orchestrator 描述已废止，以 Host 文档为准。

## 架构（现行）

```
Vue Shell (render + host-client)
  → invoke('host_boot' | 'host_dispatch')
  → Rust Workbench Host (state / workspace / session / orchestrator)
       ├─ FS watch + git worker (notify)
       ├─ PTY / shell / keychain / storage
       └─ JSONL → Node sidecar (Extension Host)
            ├─ LLM / Harness (@open-vera)
            └─ LSP proxy
  ← emit('host:patch' | 'host:event' | agent:stream:*)
```

Sidecar 位于 `apps/partner/sidecar/`，开发时 Tauri 启动会自动 spawn。

**Release 安装包**提供两种 Node 变体（按当前平台打包）：

| 变体 | 命令 | macOS 产物 | Windows 产物 | 说明 |
|---|---|---|---|---|
| 内置 Node（默认） | `pnpm partner:build:bundled` | `release/macos/Partner.app` | `release/windows/Partner-windows-bundled-setup.exe` | 自带 Node.js，开箱即用 |
| 系统 Node | `pnpm partner:build:system` | `release/macos/Partner-SystemNode.app` | `release/windows/Partner-windows-system-node-setup.exe` | 体积小，需本机 Node.js 20+ |
| 两个都打 | `pnpm partner:build:all` | 以上两个 | 以上两个 | |

Sidecar 资源含 `partner-sidecar.mjs` + `node_modules/ws` + 可选内置 `node`/`node.exe`。系统 Node 版会查找 PATH / 常见安装路径。若 sidecar 启动失败，应用仍可打开，但 Agent / LSP 不可用。

## 开发

```bash
# 安装依赖（在 monorepo 根目录）
pnpm install

# 编译 sidecar + Tauri 桌面开发
pnpm partner
# 或
pnpm --filter @vera/partner tauri:dev

# 仅前端 HMR
pnpm partner:web

# 单独编译 sidecar
pnpm --filter @vera/partner-sidecar build
```

## 目录结构

```
apps/partner/
├── sidecar/                # Node Extension Host
├── src/
│   ├── shell/              # Host IPC 客户端 + 状态投影
│   ├── components/         # UI
│   ├── stores/             # UI 投影 / 渲染缓冲（chat streaming、editor）
│   └── bridge/             # host_dispatch 薄封装（无旧 command）
├── src-tauri/
│   └── src/
│       ├── host/           # Workbench Host 内核
│       ├── commands/       # FS / shell / 遗留 invoke
│       └── sidecar/        # sidecar 进程管理
└── tests/
```

## 脚本

见根目录 `package.json` 的 `partner*` scripts。
