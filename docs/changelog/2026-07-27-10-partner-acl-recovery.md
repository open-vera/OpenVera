# 2026-07-27 · 10:xx — 修复 Workbench Host 重构后的大面积功能失效

## 背景

Workbench Host 硬切换把 invoke 面收敂为 `host_boot` / `host_dispatch` 两个命令，但 Tauri v2 的 ACL 清单没有同步，导致重构后设置、历史、Cmd+P、终端等功能全部失效。类型检查、283 个单测、`cargo check` 当时全部通过 —— 这个断裂只在运行时暴露。

## 变更

| 模块 | 内容 |
|---|---|
| `src-tauri/permissions/partner-commands.toml` | **根因修复**：清单仍声明重构前的 44 个旧命令（`read_file` / `agent_run` / `pty_spawn` …），`host_boot` / `host_dispatch` 从未授权，被 ACL 全量拦截（`host_dispatch not allowed. Command not found`）。重写为两个 host 入口 |
| `src/App.vue` | 新增 `bootStep()` 包装 host / settings / parallel 三个启动阶段。此前 `host.boot()` 是 `onMounted` 首个 await 且抛错不设防，一次 IPC 失败会连带跳过 `registerPartnerShortcuts()` / 菜单事件 / 主题 / 托盘注册 —— 快捷键代码完好却压根没绑上 |
| `src/components/chat/SessionHistoryMenu.vue` | 恢复时钟 SVG 图标按钮。重构将其替换为纯文字"历史"，并把类名 `history-button` 改为 `history-btn`，使 `LeftPanel.vue` 的 `:deep(.history-button)` 尺寸规则一并失效 |
| `tests/unit/tauri/acl-permissions.test.ts` | 新增 4 项断言，锁定 `invoke_handler` 注册命令 ↔ 权限清单 ↔ capability 三者一致 |
| `scripts/migrate-legacy-sessions.mjs` | 一次性迁移脚本：`<root>/.vera/partner-sessions.json` → `~/.vera/partner/app-state.json`（重构移除了 legacy 迁移路径，旧历史成为孤儿） |
| `src/stores/app-state.ts` · `src/App.vue` | `load()` 去掉被完全忽略的 `legacyRootPath` / `windowId` 参数；`bootLegacyRoot` 更名 `bootProjectRoot` |
| `src-tauri/src/commands/` | 死代码清理：删除 `storage.rs`（75 行，已由 `host/persist.rs` 取代）、`lsp.rs`（111 行，dispatcher 直连 `sidecar.call_rpc`）；`agent.rs` 移除 `agent_run` / `agent_abort` / `agent_tool_approval` / `sidecar_status` / `HistoryMessage` / `AgentRunResponse` / `refresh_llm_provider_models` / `test_llm_connection`；`fs.rs` 移除 `git_status` 包装（保留 `git_status_sync`）；`workspace_watch.rs` 移除 3 个命令包装与 `stop()`；`mod.rs` 移除 `get_app_version` |

## 历史数据迁移结果

| 项目 | 结果 |
|---|---|
| workspace (`proj_1424acb1`) | 4 个已最新 |
| open-vera (`proj_4448ee3`) | +3 新增，3 个补全 |
| proxy-x-fe (`proj_3e9cea51`) | +7 新增，1 个补全 |

会话 20 → 30，消息 136 → 389，项目 1 → 3。迁移前后与备份逐一比对：旧 id 全部保留，无会话消息数减少。脚本内的 `projectIdFromRoot` 复刻了 `host::state::project_id_from_root` 的 31 进制滚动 hash，已验证与线上数据一致（`proj_4448ee3`），否则迁入的会话会挂不到项目上。

## 验证

- `vue-tsc --noEmit` 无错
- 287 个前端单测通过（63 文件，新增 4）
- `cargo check` warning 25 → **0**；10 个 Rust 测试通过

## Roadmap 同步

无。`docs/roadmap.md` 目前不含任何 Partner 章节，Partner 进度仅由 changelog 跟踪。若要把 Partner 纳入 roadmap，需新建独立分区（本次未擅自新增）。

## 遗留事项

- **ACL 修复未经运行时验证**：仅做静态确认（报错字符串 ↔ 清单缺项 ↔ 重新生成后放行），需重新编译 Rust 后在 app 内实测
- **sidecar 退出回收有漏**：dev 会话崩溃后累积了 19 个孤儿 `partner-sidecar.mjs`。已清理 7 个，其余 12 个处于 `UE`（不可中断 + 正在退出，PPID 1）状态，`SIGKILL` 无效，需重启才能释放。回收逻辑本身应单独排查
- `scripts/migrate-legacy-sessions.mjs` 为一次性脚本，迁移完成后可删除；其 eslint `no-undef` 报错与同目录既有 `.mjs` 脚本一致（仓库 eslint 的 node globals 未覆盖 `.mjs`）
- 各项目下的 `<root>/.vera/partner-sessions.json` 迁移后已无人读取，可自行清理
- `app-state.json` 已 12 MB 且在 boot 时整体读入；迁移脚本提供 `--max-per-project`（默认 30，本次未触发）作为上限手段，但长期需要分片或裁剪策略
