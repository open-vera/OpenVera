# Partner

OpenVera AI Agent 桌面端应用（Tauri 2 + Vue 3）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面宿主 | Tauri 2.x |
| 前端 | Vue 3.5 + Vite 6 + Pinia 2 |
| 后端 | Rust (stable) |
| 持久化 | SQLite（Phase 2，`tauri-plugin-sql`） |

详细架构见 [docs/zh/partner/tech-spec.md](../../docs/zh/partner/tech-spec.md)。

## 架构（Phase 2）

```
Vue Orchestrator
  → invoke('agent_run')
  → Rust SidecarManager (stdin/stdout JSON Lines)
  → Node sidecar (@open-vera/openvera Harness plan executor)
       ├─ LLM 调用（adapters）
       └─ onToolCall → Core ToolHost / builtin tools / plugins → tool_result
  → emit('agent:stream:*') → ChatStore 流式更新
```

Sidecar 位于 `apps/partner/sidecar/`，开发时 Tauri 启动会自动 spawn。

**Release 安装包**：`pnpm tauri build` 会将 ESM sidecar bundle 与 **Node.js 运行时**一并打包进 `.app` 的 `Resources/sidecar/`（`partner-sidecar.mjs` + `node` + `node_modules/ws`）。从 Finder 启动时不再依赖系统 PATH 中的 `node`。若 sidecar 启动失败，应用仍可正常打开，但 Agent / LSP 功能不可用。

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
├── sidecar/                # Node.js OpenVera Core sidecar
│   └── src/
├── src/                 # Vue 3 前端
│   ├── components/      # chat / left / preview / kanban
│   ├── stores/          # Pinia stores
│   ├── orchestrator/    # Agent 编排层
│   ├── bridge/          # Tauri IPC 封装
│   └── types/
├── src-tauri/           # Rust 核心层
│   ├── src/commands/    # fs / shell / keychain / storage
│   └── capabilities/
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | Vite 开发服务器 |
| `pnpm tauri dev` | Tauri 桌面开发 |
| `pnpm build` | 前端生产构建 |
| `pnpm tauri build` | 打包桌面安装包（含 sidecar bundle） |
| `pnpm test` | Vitest 单元测试 |
| `pnpm typecheck` | TypeScript 类型检查 |

## Phase 1 交付范围

- [x] Tauri + Vue 3 项目骨架
- [x] 三栏布局（左：文件/Git · 中：对话 · 右：预览）
- [x] Pinia stores + Orchestrator 骨架
- [x] Tauri IPC bridge（fs / shell / keychain）

## Phase 3 — 代码预览 + LSP

- [x] CodeMirror 6 只读代码预览（语法高亮、行号、Partner 主题）
- [x] 左侧文件树点击打开代码预览
- [x] `@codemirror/lsp-client` + Sidecar WebSocket 代理
- [x] LSP 诊断 / Hover / Go to Definition（需本机安装 language server）
- [ ] 预览面板 Markdown / HTML / PDF 渲染

### LSP 依赖（本机 PATH）

| 语言 | Language Server |
|------|----------------|
| TypeScript / JS / JSON / Vue | `typescript-language-server` |
| Python | `pyright-langserver` |
| Rust | `rust-analyzer` |

安装示例：

```bash
npm i -g typescript-language-server typescript
# 或 rust-analyzer / pyright-langserver 按语言安装
```

预览面板右上角 **LSP** 开关可关闭语言服务（仅语法高亮）。
