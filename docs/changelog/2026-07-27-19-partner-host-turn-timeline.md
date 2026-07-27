# 2026-07-27 · 19:xx — Host 化落地 + turn 时序转录

本批次把长期未提交的 Host 化重构按主题切分落库，并修掉阻塞它的三个协议级缺陷、
重做了对话区的进程展示。

## 变更

| Hash | 模块 | 内容 |
|---|---|---|
| `41134c4` | deps | `@codemirror/legacy-modes`（yaml/toml/ini 高亮）、xterm addons（内嵌终端）、`@tauri-apps/plugin-dialog`、`@vue/test-utils` + `happy-dom`（组件测试） |
| `fa3cd7c` | core | 新增 `context/occupancy`，Anthropic / OpenAI adapter 透传 `cache_read` / `cache_write` / `cache_included_in_input`（两家对"缓存是否计入 input"口径不同） |
| `61e9c5e` | partner-sidecar | `run-metrics`（TTFB/TTFT/duration/turns）、`run-log`（落盘）、`file-change`（结构化 diff）；LSP 配置与 gateway 错误头 |
| `f70dece` | partner-host | Rust Workbench Host（state/dispatcher/orchestrator/persist/workspace/io）+ pty / watch / run_log / storage_usage 原生命令；含三个协议修复（见下） |
| `a3a4a49` | partner-shell | `src/shell`（host-client / host-store / chat-runner / 协议类型）；chat-runner 补齐 usage / tool_result / thinking / ready / tool_approval_required 五个流通道，`tool_call` 改读 `callId` |
| `73c201f` | partner | 删除被 Host 取代的 JS orchestrator（AgentInstance / TaskQueue / gateway） |
| `cac789b` | partner-chat | turn 时序转录：`Message.turnId` / `endedAt` 分段 + `chat-timeline` 分组 + `TurnTimeline` 折叠；ToolProgressPanel live 变体与刷屏折行；用量环双口径 + API 术语；`统计` 入口；弹层改实心 |
| `c108d84` | partner | 模型列表过滤空 id / 重复 id 条目（网关 `/v1/models` 返回过空条目，渲染成一行空白） |
| `9a3a7ed` | partner | 多项目工作区、内嵌终端、文件操作、quick open、LSP 跳转、Markdown 预览、diff/merge 编辑器、托盘、perf 层；无项目时右侧列整体收起；向上展开的弹层改 bottom 锚定 |
| `a69c325` | ci | partner-release workflow、build-release 包装、CI 增加 partner 测试、旧会话迁移脚本 |
| `dd63f7a` | partner | 对话 tab 拖拽重排 / 跨条移动 |
| `27858ed` | harness | benchmark / eval / skill / swarm 的测试迁移到已拆分出的对应包（原路径 `../src/benchmark/*` 等已不存在，全部收集失败） |
| `cc806d8` | harness | 9 个包补 `vitest.config.ts` 排除 `**/dist/**`，不再同时收集编译产物里的同名测试 |

### 三个协议级修复（含在 `f70dece`）

1. **事件名非法**：`host.patch` / `host.event` 带 `.`，Tauri v2 只允许 `字母数字 - / : _`，导致所有 `listen` 调用抛错 → `host.boot()` 第一步就失败，会话历史报错、发消息无反应。改为 `host:patch` / `host:event`。
2. **camelCase 字段丢失**：`HostCommand` / `HostDomainEvent` 是 internally tagged enum，`rename_all` 只重命名 variant 不管字段，`sessionId` / `projectRoot` 等多词字段全部反序列化失败（`missing field session_id`）。补 `rename_all_fields = "camelCase"`。
3. **Host 自死锁**：15 个 dispatch arm 在持有 `MutexGuard` 时调用 `emit_patch`（内部再次 `lock`），`std::sync::Mutex` 不可重入 → 首次切 tab / 打开文件即永久卡死，之后所有 `host_dispatch` 无限挂起（表现为展开目录一直空白）。改为 `emit_state_patch(app, &state, ..)`，并加 source-scan 测试钉住该不变量。

## 测试

- `apps/partner`：73 文件 / 398 用例通过；新增 `chat-timeline`（9）、`chat-runner` 分段（4）、`turn-timeline` 组件（4）、`context-usage-ring` 组件（8）、`tool-progress` 折行（3）、`model-catalog` 空条目（1）
- `packages/core`：199 文件 / 4748 用例通过（修正了两处 openai adapter 的过期期望，`cache_included_in_input` 是有意新增字段）
- `src-tauri`：`cargo test` 41 用例通过（协议 camelCase、domain event、事件名合法性、dispatch 不变量）
- **全 workspace `pnpm -r test` 首次全绿**：修掉 harness 系列 37 个失败（见 `27858ed` / `cc806d8`），`packages/harness` 22 文件、`harness-benchmark` 6、`harness-eval` 7、`harness-swarm` 4、`harness-skill` 1、`harness-strategy` 3 全通过

## 遗留事项

- 旧会话历史消息没有 `turnId`，按 legacy 分支平铺、不折叠；只有重启后新产生的轮次有新展示
- `FileTreeNode.reloadChildren` 列目录失败仍只 `console.warn`，界面上分不清"空目录"和"读取失败"
- `harness-benchmark` / `harness-eval` 现在存在同一被测类的两套测试（迁移过来的旧套件更全，新套件有独有用例，均未删），后续可合并去重
- 覆盖率未单独统计（本批次以 partner 应用为主，`packages/core` 侧改动小）
