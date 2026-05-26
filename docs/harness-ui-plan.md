# OpenVera 管理端 UI + Core UI 开发计划

> 分支：feat | 每 30 分钟一个步骤 | 参考 feature/p1-checkpoint-resume
> 现有 harness-ui：Vue 3 + Vite + 纯 node:http（保持不变）
> **新包可以自由选框架**：Server 用 Express，Web 用 Vue 3 + Vue Router + 组件库

## Phase 1：项目基建 — 包注册 & 框架搭建

- [x] **1.1** 安装依赖：`pnpm install`，确认所有现有 workspace 包依赖解析成功，`pnpm run build` 全量通过
- [ ] **1.2** 创建 `apps/admin-ui/server/`：`package.json`（name: `@vera/admin-ui-server`，bin: vera-admin-serve → dist/index.js，deps: express, cors，devDeps: @types/express, @types/cors, @types/node, tsx, typescript）、`tsconfig.json`（module: NodeNext, outDir: dist）、`src/index.ts`（Express app，端口 7710，cors + json middleware）、`src/routes/cluster.ts`（router 骨架）
- [ ] **1.3** 创建 `apps/admin-ui/web/`：`package.json`（name: `@vera/admin-ui-web`，deps: vue@^3.5, vue-router@^4, pinia@^2，devDeps: vite@^6, @vitejs/plugin-vue, vue-tsc@^2）、`tsconfig.json`、`vite.config.ts`（port 7702, proxy /api → localhost:7710）、`index.html`（title: "Vera Admin"）、`env.d.ts`、`src/main.ts`（createApp + router + pinia）、`src/router.ts`（/dashboard, /spaces, /spaces/:id, /settings）、`src/App.vue`（router-view + 侧边导航）
- [ ] **1.4** 创建 `apps/core-ui/`：`package.json`（name: `@vera/core-ui-web`，deps: vue@^3.5, vue-router@^4，devDeps: vite@^6, @vitejs/plugin-vue, vue-tsc@^2）、`tsconfig.json`、`vite.config.ts`（port 7703, proxy /api → localhost:7700 即 harness-ui server）、`index.html`（title: "Vera Core"）、`src/main.ts`、`src/router.ts`（/runs, /runs/:id/memory, /runs/:id/checkpoints, /runs/:id/subagents）、`src/App.vue`
- [ ] **1.5** 根 `package.json` 新增脚本：`"admin": "pnpm --filter @vera/admin-ui-web dev"`、`"admin-serve": "pnpm --filter @vera/admin-ui-server exec vera-admin-serve"`、`"core": "pnpm --filter @vera/core-ui-web dev"`。安装依赖后验证 `pnpm admin` 和 `pnpm core` 能启动空白页面

## Phase 2：管理端 Server — Express API 层

- [ ] **2.1** 实现 `apps/admin-ui/server/src/routes/cluster.ts`：GET /api/admin/overview → 调用 `vera_api_call` `/agent-admin-api/status?type=overview`，返回集群概览；GET /api/admin/containers → 调用 `type=containers` 返回空间列表；GET /api/admin/resources → 调用 `type=system_resources` 返回 CPU/内存/磁盘
- [ ] **2.2** 实现 `apps/admin-ui/server/src/routes/spaces.ts`：GET /api/admin/spaces → 聚合 containers + overview 数据，返回 `{ scope_id, type, busy, running_task_id }[]`；GET /api/admin/spaces/:scopeId → 返回该空间详情
- [ ] **2.3** 实现 `apps/admin-ui/server/src/index.ts`：Express app 主入口，加载 cluster 和 spaces router，cors + json body parser，端口 7710。启动时打印所有已注册路由
- [ ] **2.4** 实现 `apps/admin-ui/server/src/routes/heatmap.ts`：GET /api/admin/heatmap → 调用 `type=heat_distribution`，返回 24h 热容器/冷容器分布数据，用于前端图表

## Phase 3：管理端 UI — 集群 Dashboard

- [ ] **3.1** 实现 `apps/admin-ui/web/src/api.ts`：封装 fetch 调用，方法 `fetchOverview()`, `fetchContainers()`, `fetchResources()`, `fetchSpaces()`, `fetchSpaceDetail(scopeId)`, `fetchHeatmap()`，返回 typed 数据
- [ ] **3.2** 实现 `apps/admin-ui/web/src/App.vue`：左侧导航（📊 Dashboard / 📦 Spaces / ⚙️ Settings 三个入口，vue-router link）+ 右侧 `<router-view>`。暗色主题 CSS 变量（复用 harness-ui 的 `:root` 变量）
- [ ] **3.3** 实现 `apps/admin-ui/web/src/views/DashboardView.vue`：顶部 4 个指标卡片行（总空间数、Worker 节点、今日任务数、今日花费）+ 容器分布饼图（用 CSS conic-gradient 实现简易 donut）+ CPU/内存进度条 + 24h 热度分布柱状图
- [ ] **3.4** 实现 `apps/admin-ui/web/src/stores/dashboard.ts`：Pinia store，`useDashboardStore` — 管理 overview/resources/containers 数据，提供 `fetchAll()` action + `autoRefresh(intervalMs)` 定时刷新

## Phase 4：管理端 UI — 空间列表 & 详情

- [ ] **4.1** 实现 `apps/admin-ui/web/src/views/SpacesView.vue`：表格展示所有空间（scope_id 列、类型 badge 列 — group/user、状态列 busy/idle、运行任务列）。顶部搜索框实时过滤 scope_id。点击行跳转到 `/spaces/:scopeId`
- [ ] **4.2** 实现 `apps/admin-ui/web/src/views/SpaceDetailView.vue`：面包屑导航 + 空间基本信息卡片（scope_id、类型、busy 状态）+ 该空间定时任务列表（如果有数据）。加载/空/错误三种状态覆盖
- [ ] **4.3** 实现 `apps/admin-ui/web/src/views/SettingsView.vue`：展示当前 LLM 配置（API Key 脱敏、Model、Base URL）+ 系统信息（运行时间、磁盘用量）

## Phase 5：Core Server 扩展 — 给 harness-ui server 加 Express 路由

- [ ] **5.1** 在 `apps/harness-ui/server/src/types.ts` 新增类型：`MemorySnapshot`（episodicCount/semanticCount/workingCount）、`MemoryEntryItem`（id/tier/content/tags/createdAt/importance/source）、`CheckpointIndex`（checkpointId/flowId/state/createdAt/activeStepId）、`SubagentPoolStatus`（totalSlots/activeAgents/queuedTasks）、`SubagentCallTreeNode`（taskId/agentType/status/dependsOn/children）
- [ ] **5.2** 新增 `apps/harness-ui/server/src/handlers/memory.ts`：GET /api/runs/:runId/memory → 扫描 `.flow/iterations/<runId>/memory/` 目录，读取 episodic.jsonl 和 semantic.jsonl，返回 snapshot + 最近 50 条 entries。支持 `?tier=` 和 `?search=` 参数
- [ ] **5.3** 新增 `apps/harness-ui/server/src/handlers/checkpoints.ts`：GET /api/runs/:runId/checkpoints → 读取 `.flow/iterations/<runId>/checkpoints.ndjson`，逐行解析返回 checkpoint 列表；GET /api/runs/:runId/checkpoints/:id → 返回单条 checkpoint JSON
- [ ] **5.4** 新增 `apps/harness-ui/server/src/handlers/subagents.ts`：GET /api/runs/:runId/subagents → 读取 `.flow/iterations/<runId>/subagents.json`，返回 pool status + orchestrator call tree
- [ ] **5.5** 在 `apps/harness-ui/server/src/router.ts` 注册 4 条新路由，编译验证 `pnpm --filter @vera/harness-ui-server run build`

## Phase 6：Core UI — Agent 运行监控

- [ ] **6.1** 实现 `apps/core-ui/src/api.ts`：封装 fetch，方法 `fetchRuns()`, `fetchRun(runId)`, `fetchMemory(runId, tier?, search?)`, `fetchCheckpoints(runId)`, `fetchSubagents(runId)`
- [ ] **6.2** 实现 `apps/core-ui/src/App.vue`：顶部 Run 选择器（下拉列表，从 `/api/runs` 加载）+ 下方 tab 导航（Memory / Checkpoints / Subagents）+ `<router-view>`
- [ ] **6.3** 实现 `apps/core-ui/src/views/RunsView.vue`：运行列表页，表格展示（runId/状态/开始时间/耗时/步骤数），点击进入详情。每 5s 自动刷新（有 running 状态时）
- [ ] **6.4** 实现 `apps/core-ui/src/views/RunDetailView.vue`：运行详情页，步骤卡片列表（复用 harness-ui 的 StepCard 风格），顶部统计栏（总步数/完成/失败/耗时）

## Phase 7：Core UI — Memory & Checkpoint & Subagent 可视化

- [ ] **7.1** 实现 `apps/core-ui/src/views/MemoryView.vue`：顶部统计栏（episodic/semantic/working 各多少条）+ tier 筛选 tabs + 搜索框 + 条目卡片列表（content 摘要、tags 标签、importance 星级、时间）。点击卡片展开完整 JSON
- [ ] **7.2** 实现 `apps/core-ui/src/views/CheckpointsView.vue`：垂直时间轴（每个 checkpoint 一个节点，圆点+连线，颜色按 state），hover 显示 checkpointId/state/stepId/时间。点击节点展开详情 JSON。底部两个按钮"选择 A / 选择 B"用于 diff 模式
- [ ] **7.3** 实现 `apps/core-ui/src/components/CheckpointDiff.vue`：并排双栏 diff，左侧 checkpoint A JSON、右侧 checkpoint B JSON，变化的字段高亮（黄色背景）
- [ ] **7.4** 实现 `apps/core-ui/src/views/SubagentsView.vue`：顶部 Pool 状态卡片（4 个指标数字：活跃/总槽位/排队/利用率%）。下方递归树形组件展示 orchestrator 调用链（缩进 + 连线，每个节点显示 taskId → agentType → status badge → durationMs）。点击节点展开 prompt/output/error 面板

## Phase 8：整合 & 联调验证

- [ ] **8.1** admin-ui server 编译通过：`pnpm --filter @vera/admin-ui-server run build`
- [ ] **8.2** admin-ui web 编译通过：`pnpm --filter @vera/admin-ui-web run build`
- [ ] **8.3** core-ui web 编译通过：`pnpm --filter @vera/core-ui-web run build`
- [ ] **8.4** harness-ui server 编译通过：`pnpm --filter @vera/harness-ui-server run build`
- [ ] **8.5** 全量测试通过：`pnpm run test` 无 failure
- [ ] **8.6** 更新 `docs/changelog.md` 记录本批次开发内容，更新 `docs/roadmap.md`

---

## 执行日志

| 时间 | 内容 | 备注 |
|------|------|------|
| 2026-05-27 04:07 | Phase 1.1 完成 | pnpm install + pnpm build 全量通过，332 deps resolved |