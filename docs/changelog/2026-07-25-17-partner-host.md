# 2026-07-25 · 17:xx — Partner Workbench Host 推倒重来

## 变更

| 模块 | 内容 |
|---|---|
| `apps/partner/src-tauri/src/host/` | 新增 Workbench Host：protocol / state / dispatcher / workspace / orchestrator / persist |
| `apps/partner/src/shell/` | 新增薄壳 host-client / host-store / types |
| `apps/partner` UI | App boot `host_boot`；Explorer 去 JS 轮询，改订 `host.patch`；Chat 经 Host 发消息 |
| bridge | LSP / PTY 走 `host.*` 门面 |
| docs | 新增 `host-architecture.md`；README / tech-spec 对齐 |

## Roadmap 同步

- Partner 架构：VS Code 式 Host（Rust）+ Shell（Vue）+ Extension Host（sidecar）✅

## 硬切换（同日续）

- `lib.rs` invoke **仅** `host_boot` / `host_dispatch`
- 删除 `src/orchestrator/*`、`bridge/storage`、旧 agent_run 路径
- bridge / LLM / FS / PTY / LSP / keychain 全部经 `host.*`
- 菜单 / DnD 只发 `host.event`；AppState 只经 Host persist
- 无 partner-sessions 双写、无 legacy 迁移路径

## 遗留事项

- Pinia `chat` / `preview` 仍持有流式与编辑缓冲（Shell 渲染态，非业务真相）
- `commands/*` 实现仍在 Rust 内部被 Host 调用，但不再对外注册
