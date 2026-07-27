# Partner — 多项目 / 会话布局方案

> 版本：v1 · 2026-07-25 · 状态：已定稿，按 P1→P4 落地  
> 相关：[tech-spec](./tech-spec.md) · [prd](./prd.md)

---

## 1. 目标

把「单根 workspace + 左栏文件树」调整为：

- **左栏**：已加载项目 + 会话树（会话归属项目；无项目会话平铺最外层）
- **中栏**：当前会话对话；顶栏 tabs 与左栏双轨同步（含设置）
- **右栏**：文件树 / 搜索 / Git + 按项目恢复的打开文件列表

全局状态集中到 `~/.vera/partner/`。

---

## 2. 布局示意

```text
┌─────────────────┬──────────────────┬─────────────────────────┐
│ 项目 / 会话      │ 对话（当前 tab）   │ 预览 + 文件 / Git / 搜索 │
│                 │                  │                         │
│ 会话·孤儿 A     │ 顶栏 tabs：       │ [文件][搜索][Git]         │
│ 会话·孤儿 B     │  多项目会话… 设置  │ 树 / 结果 / 变更         │
│ ▼ 项目 PROXY    │                  │ + 该项目打开的文件页签    │
│   · 会话 1 ●    │                  │                         │
│   · 会话 2      │                  │                         │
│ ▸ 项目 Other    │                  │                         │
│ [搜索][历史]    │                  │                         │
└─────────────────┴──────────────────┴─────────────────────────┘
```

---

## 3. 已拍板行为

| 点 | 结论 |
|---|---|
| 无项目会话 | **不要「无项目」分组目录**，与项目同级**平铺**在左栏最外层 |
| 点项目标题 | **只展开/收起**子会话，**不切中栏** |
| 顶栏 tabs | 与左栏**双轨同步**；**设置 tab 留在顶栏**；**多项目多会话可同时出现在 tab 组** |
| 全局状态 | **`~/.vera/partner/`** 集中管理 |
| 无项目 Agent | **不限制**；由 Agent 自行决定是否建项目等 |
| Git / 文件搜索 | **迁到右栏**（作用域 = 当前预览项目） |
| 会话搜索 / 历史 | **迁到左栏** |

### 3.1 补充细则

- **点会话**：激活该会话（中栏 + 顶栏 tab）；若有所属项目，右栏切到该项目的文件树与打开文件。
- **点项目标题**：仅 expand/collapse，不改中栏、不改右栏预览项目。
- **「+ 新对话」**：若存在「当前预览项目」则挂其下，否则建孤儿会话。
- **关顶栏 tab**：取消激活，会话仍留在左栏树上。
- **无预览项目且当前为孤儿会话**：右栏空态提示「打开文件夹以浏览文件」。

---

## 4. 数据模型（P1）

路径：`~/.vera/partner/app-state.json`（version **4**）。

```ts
PartnerAppState {
  version: 4
  projects: PartnerProjectRecord[]
  sessions: Record<sessionId, PartnerSessionRecord>
  openTabIds: string[]            // sessionId… + "settings"
  activeTabId: string | null      // 当前顶栏 / 中栏
  previewProjectId: string | null // 右栏当前项目
  layout: { leftWidth, previewWidth }
  updatedAt: number
}

PartnerProjectRecord {
  id: string                      // 稳定 id（见下）
  rootPath: string
  name: string
  expanded: boolean
  preview: PreviewSnapshot        // 该项目打开过的文件
  updatedAt: number
}

PartnerSessionRecord {
  id: string
  projectId: string | null        // null = 孤儿，平铺左栏
  title: string
  messages: Message[]
  lastError?: ChatErrorNotice | null
  createdAt: number
  updatedAt: number
}
```

**项目 id**：对 `rootPath` 规范化后做稳定哈希（或 uuid 首次创建后写入映射），保证同一路径多次打开为同一项目。

**会话正文**：P1 全部落在 `app-state.json`；若体积过大，P2+ 可拆到 `~/.vera/partner/sessions/{id}.json`，索引仍留在 app-state。

---

## 5. 与旧数据的关系

| 旧 | 新 |
|---|---|
| `{projectRoot}/.vera/partner-sessions.json`（window/chat/preview/tasks） | 迁移进全局 app-state：项目 + 会话 + preview |
| `localStorage partner:workspace-root:{windowId}` | 变为 `previewProjectId` / projects 列表一项 |
| 单根 `workspace.rootPath` | 多项目 registry；右栏「当前项目」= `previewProjectId` |

**迁移策略（一次性，可重复幂等）：**

1. 若已存在 `~/.vera/partner/app-state.json` 且 version≥4 → 直接用。
2. 否则读取当前 workspace root 的 `partner-sessions.json`（及可选 localStorage root）。
3. 为该 root 创建 `PartnerProjectRecord`，window 内每个 `kind==="chat"` 的 tab → `PartnerSessionRecord`（`projectId` 指向该项目）。
4. `preview` → 项目 `preview`；`openTabIds` / `activeTabId` 从当时 window 推导。
5. `tasks` → 作为额外会话写入同一项目（保留 title/previewText 时间戳），避免历史丢失。
6. 旧文件**不删除**（只读迁移），便于回滚。

---

## 6. 落地阶段

| Phase | 内容 | 状态 |
|---|---|---|
| **P1** | 文档；`PartnerAppState` 类型 / normalize / migrate；Tauri 读写 `~/.vera/partner/`；store + 单测 | ✅ |
| **P2** | 左栏改为项目/会话树；会话搜索/历史搬家；顶栏 tabs 双轨同步（含设置） | ✅ |
| **P3** | 文件树 / Git / 搜索迁右栏；按项目恢复打开文件 | ✅（初版：右栏 ProjectExplorer + 按项目 preview） |
| **P4** | 去掉单根假设扫尾；文档与 README 同步 | 进行中 |

---

## 7. 非目标（本方案不做）

- 多窗口多 root 完整产品化（数据已有 windowId 字段，但不作为本迭代重点）
- macOS 公证 / 签名（与布局无关）
- 强制无项目会话绑定项目

---

## 8. 实现入口（代码）

| 模块 | 路径 |
|---|---|
| 状态模型 / 迁移 | `apps/partner/src/utils/partner-app-state.ts` |
| Bridge | `apps/partner/src/bridge/storage.ts` |
| Rust IO | `apps/partner/src-tauri/src/commands/storage.rs` |
| Store（P1） | `apps/partner/src/stores/app-state.ts` |
| 旧会话格式（保留） | `apps/partner/src/utils/partner-sessions.ts` |
