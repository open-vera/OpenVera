# Partner — Workbench Host 架构（现行）

> 版本：v2 · 2026-07-25 · 状态：硬切换完成（无兼容层）  
> Vue Shell **只能** `host_boot` / `host_dispatch`；旧 Tauri command / Orchestrator / partner-sessions 双写已移除。

## 1. 进程角色（对齐 VS Code）

| VS Code | Partner |
|---|---|
| Renderer | Vue Shell（`apps/partner/src/shell/` + UI 组件） |
| Main / Workbench services | Rust Host（`apps/partner/src-tauri/src/host/`） |
| Extension Host | Node sidecar（`apps/partner/sidecar/`） |
| Language Server | sidecar 拉起的 LSP 进程 |

**硬性规则**

- Host 是 app / workspace / session / orchestrator / git / document 模型的唯一真相源
- Shell 只渲染投影、发 `host.*` command、订 `host.patch` / `host.event`
- Sidecar 只跑 Agent loop / LLM / LSP；由 Host 调度，前端不直连 sidecar 协议

## 2. IPC v1

- `invoke("host_boot")` → 全量状态
- `invoke("host_dispatch", { command })` → `HostCommand`（`op: "host.…"`）
- 事件：`host.patch`（状态补丁）、`host.event`（领域事件）

关键 command：`host.workspace.*` · `host.session.*` · `host.document.*` · `host.pty.*` · `host.lsp.*` · `host.app.*`

## 3. 目录

```
apps/partner/src-tauri/src/host/   # 唯一 IPC 入口（host_boot / host_dispatch）
apps/partner/src/shell/            # host-client / host-store / chat-runner
apps/partner/src/bridge/           # 仅 host_dispatch 薄封装（无旧 command 名）
apps/partner/sidecar/              # Extension Host
```

## 4. 成功标准

- `invoke_handler` 仅注册 `host_boot` + `host_dispatch`
- WebView 无 Orchestrator / TaskQueue / partner-sessions 双写
- 无 `workspace:open-folder` / `app:open-settings` 双事件；菜单只发 `host.event`
- 会话发送走 `host.session.send`；队列/abort 在 Rust
- 重启后 Host 从 `~/.vera/partner/app-state.json` 恢复
