# UI 细化设计 Refinement Plan

> 续 harness-ui-plan.md Phase 1-8（全部完成 ✅）
> 目标：统一主题、修复交互 bug、提升视觉质量
> 由 loop 定时任务逐步执行

## 设计规范（对齐 harness-ui）

**主题变量**（来自 harness-ui/web/src/App.vue :root）：

| 变量 | 值 | 用途 |
|------|-----|------|
| `--bg` | `#0d1117` | 页面背景 |
| `--surface` | `#161b22` | 卡片/面板底色 |
| `--surface-2` | `#1c2128` | 次级面板/输入框 |
| `--surface-3` | `#22272e` | 悬浮/选中态 |
| `--border` | `#30363d` | 边框/分割线 |
| `--text` | `#e6edf3` | 主文字 |
| `--text-muted` | `#7d8590` | 次要文字 |
| `--accent` | `#58a6ff` | 主强调色（蓝） |
| `--accent-dim` | `#1f3d5c` | 强调色暗底 |
| `--success` | `#3fb950` | 成功/活跃 |
| `--success-dim` | `#1a3626` | 成功暗底 |
| `--danger` | `#f85149` | 错误/失败 |
| `--danger-dim` | `#3d1a1a` | 错误暗底 |
| `--warning` | `#d29922` | 警告/排队 |
| `--warning-dim` | `#3d2e0a` | 警告暗底 |
| `--font-mono` | JetBrains Mono... | 等宽字体 |

**禁用色**：`#999`、`#b0b0b0`、`#e0e0e0` 等灰色用 `--text-muted` 替代

---

## Phase 9：主题统一（admin-ui + core-ui 全局）

### 9.1 admin-ui web 全局主题注入 ✅
- **文件**: `apps/admin-ui/web/src/App.vue` + `apps/admin-ui/web/src/style.css`
- 在 `style.css` 中定义完整 `:root` 主题变量（harness-ui 规范）
- 全局 `body` 样式：`background: var(--bg); color: var(--text);`
- 侧边栏用 `var(--surface)` 底色，`var(--border)` 右边框
- Nav 链接 hover 用 `var(--surface-3)`，active 用 `var(--accent-dim)` + `var(--accent)`
- 移除 style.css 中旧的 `--harness-*` 间接变量引用
- 验证：style.css / App.vue 无硬编码色值，视图文件残留将在 9.3-9.5 清理

### 9.2 core-ui web 全局主题注入 ✅
- **文件**: `apps/core-ui/src/App.vue`
- 同 9.1，在 App.vue 中注入完整 `:root` 变量
- 验证：浏览器 DevTools 无 `#2d2d2d` / `#404040` 等硬编码值

### 9.3 DashboardView 主题替换 ✅
- **文件**: `apps/admin-ui/web/src/views/DashboardView.vue`
- `var(--card-bg, #2d2d2d)` → `var(--surface)`
- `var(--bg-secondary, #404040)` → `var(--surface-2)`
- `var(--border-color, #404040)` → `var(--border)`
- `var(--text-primary, #ffffff)` → `var(--text)`
- `var(--text-secondary, #b0b0b0)` → `var(--text-muted)`
- `var(--accent-primary, #3498db)` → `var(--accent)`
- 环形图颜色 `#3498db` → `var(--accent)`，`#e0e0e0` → `var(--text-muted)`
- 进度条 CPU 色 `#3498db` → `var(--accent)`，内存色 `#e74c3c` → `var(--danger)`
- 热度图 bar 色同步替换

### 9.4 SpacesView / SpaceDetailView / SettingsView 主题替换 ✅
- 同 9.3 的变量替换规则，逐文件清理所有硬编码色值
- 涉及文件：
  - `apps/admin-ui/web/src/views/SpacesView.vue`
  - `apps/admin-ui/web/src/views/SpaceDetailView.vue`
  - `apps/admin-ui/web/src/views/SettingsView.vue`

### 9.5 core-ui 全部视图主题替换 ✅
- 涉及文件：
  - `apps/core-ui/src/views/RunsView.vue`
  - `apps/core-ui/src/views/RunDetailView.vue`
  - `apps/core-ui/src/views/MemoryView.vue`
  - `apps/core-ui/src/views/CheckpointsView.vue`
  - `apps/core-ui/src/views/SubagentsView.vue`
  - `apps/core-ui/src/components/CheckpointDiff.vue`
  - `apps/core-ui/src/components/TreeNode.vue`
- 统一替换规则同上

**验证**: grep 确认无 `#2d2d2d` / `#404040` / `#b0b0b0` / `#3498db` / `#e74c3c` 残留

---

## Phase 10：Bug 修复与 Vue 3 生命周期

### 10.1 修复 MemoryView 异步时序 bug ✅
- **文件**: `apps/core-ui/src/views/MemoryView.vue`
- `setTierFilter()` 中先 `currentTierFilter.value = tier` 再调 `loadMemoryData()`
- 改为 `await nextTick()` 后再调用，或直接在 `loadMemoryData` 内读 ref

### 10.2 修复 onMounted cleanup 模式 ✅
- **文件**: `MemoryView.vue`、`SubagentsView.vue`
- `onMounted(() => { ... return () => clearInterval(...) })` 在 Vue 3 中无效
- 改为：
  ```ts
  const timer = ref<ReturnType<typeof setInterval>>();
  onMounted(() => { timer.value = setInterval(...) });
  onUnmounted(() => { clearInterval(timer.value) });
  ```
- MemoryView 在 10.1 已修复；SubagentsView 本轮修复

### 10.3 替换 alert() 为 toast 通知 ✅
- **文件**: `SubagentsView.vue`, `CheckpointsView.vue`, `CheckpointDiff.vue`
- 创建 `apps/core-ui/src/components/Toast.vue`：固定定位右下角，自动 2s 消失，支持 success/danger/info 类型
- 所有 `alert()` 调用替换为 Toast 组件，用 `ref<boolean>` 控制显隐

### 10.4 admin-ui 同步修复 ✅
- DashboardView.vue、SpacesView.vue：`onMounted` return cleanup 改为 `onUnmounted` 模式
- CheckpointsView.vue：同步修复 lifecycle bug
- admin-ui 无 `alert()` 调用，无需替换

**验证**: `vue-tsc --noEmit` 无类型错误；手动操作确认 toast 弹出

---

## Phase 11：数据驱动图表

### 11.1 DashboardView 环形图数据驱动 ✅
- **文件**: `apps/admin-ui/web/src/views/DashboardView.vue`
- 当前：`conic-gradient(#3498db 0% 70%, #e0e0e0 70% 100%)` 硬编码 70%
- 改为 computed 属性：
  ```ts
  const donutGradient = computed(() => {
    const pct = containerDistribution.value.activePercent;
    return `conic-gradient(var(--accent) 0% ${pct}%, var(--surface-2) ${pct}% 100%)`;
  });
  ```
- 绑定 `:style="{ background: donutGradient }"` 到 `.donut-chart::before`（改为直接 div）

### 11.2 DashboardView 热度图 tooltip ✅
- 当前：仅 `title` 属性（浏览器原生 tooltip，延迟大）
- 改为自定义 tooltip div：hover 时显示 "14:00 - 12 活跃, 3 空闲"
- 用 CSS `position: absolute` + `opacity` 过渡动画

### 11.3 MemoryView 重要度星级显示 ✅
- 当前：`🌟 {{ entry.importance }}` 只显示数字
- 改为 N 颗星图标（filled/empty），importance 1-5 映射为 ⭐/☆

**验证**: Dashboard 数据变化时环形图比例正确更新

---

## Phase 12：交互细节打磨

### 12.1 Loading skeleton 替代 spinner ✅
- 创建通用组件 `Skeleton.vue`（admin-ui 和 core-ui 各一份）
  - 脉冲动画背景色：`var(--surface-2)` → `var(--surface-3)` 循环
  - 接受 `width` / `height` / `border-radius` props
- DashboardView：指标卡片加载时显示 skeleton 块
- SpacesView：表格行加载时显示 skeleton 行
- MemoryView：卡片列表加载时显示 skeleton 卡片

### 12.2 空状态优化 ✅
- 各 view 的空状态增加图标和引导文案
- MemoryView：暂无数据 → "记忆系统尚未初始化，运行一次 agent 后将自动填充"
- SubagentsView：暂无调用 → "无子代理调用记录，复杂任务会自动拆分子代理"
- CheckpointsView：暂无检查点 → "检查点在每个关键步骤自动生成"

### 12.3 响应式布局 ✅
- DashboardView：`@media (max-width: 768px)` 时 metrics-grid 单列
- SpacesView：表格水平滚动（`overflow-x: auto`）
- 侧边栏：窄屏可折叠

### 12.4 状态徽章统一 ✅
- 统一 badge 颜色映射：
  - running → `var(--accent)` + `var(--accent-dim)` 底
  - done/success → `var(--success)` + `var(--success-dim)` 底
  - failed/error → `var(--danger)` + `var(--danger-dim)` 底
  - pending/queued → `var(--warning)` + `var(--warning-dim)` 底
- 所有 view 中的 `.badge` 样式统一到各自的全局 CSS 或共享 mixin

**验证**: 移动端宽度下 Dashboard 可正常浏览

---

## Phase 13：构建验证 & 文档

### 13.1 全量编译 ✅
- `pnpm --filter @vera/admin-ui-server run build`
- `pnpm --filter @vera/admin-ui-web run build`
- `pnpm --filter @vera/core-ui-web run build`
- `pnpm --filter @vera/harness-ui-server run build`

### 13.2 质量扫描 ✅
- `bash .claude/skills/quality-scan/scan.sh` 确认无 error

### 13.3 更新文档 ✅
- 更新 `docs/changelog.md` 追加 UI refinement 记录
- 更新 `docs/roadmap.md` 标记对应条目

---

## 执行日志

| 时间 | 内容 | 备注 |
|------|------|------|
| 2026-05-27 08:30 | 计划创建 | Phase 9-13 细化设计任务 |
| 2026-05-27 09:29 | 完成 9.1 admin-ui 全局主题注入 | style.css 注入完整 :root 变量，替换旧 harness-* 间接引用 |
| 2026-05-27 10:18 | 完成 9.3 DashboardView 主题替换 | 替换所有硬编码色值为 CSS 变量：card-bg→surface, text-primary→text, accent→accent, danger→danger 等 |
| 2026-05-27 10:21 | 完成 9.4 SpacesView/SpaceDetailView/SettingsView 主题替换 | 3 个文件全部替换为 CSS 变量，grep 确认无硬编码色值残留 |
| 2026-05-27 10:24 | 完成 9.5 core-ui 全部视图主题替换 | 7 个文件（RunsView/RunDetailView/MemoryView/CheckpointsView/SubagentsView/CheckpointDiff/TreeNode）全部替换为 CSS 变量，grep 确认无旧变量名和硬编码色值残留 |
| 2026-05-27 10:42 | 完成 10.1 MemoryView 异步时序修复 | setTierFilter 改为 async+await nextTick；onMounted cleanup 改为 onUnmounted 模式（10.2 的 MemoryView 部分也已修复） |
| 2026-05-27 10:44 | 完成 10.2 onMounted cleanup 模式修复 | SubagentsView: import onUnmounted, 用 refreshTimer ref + onUnmounted 替代 onMounted return cleanup |
| 2026-05-27 10:46 | 完成 10.3 alert→toast + 10.4 admin-ui lifecycle 修复 | 创建 Toast.vue 组件；替换 core-ui 3 处 alert()；修复 DashboardView/SpacesView/CheckpointsView 的 onMounted cleanup bug |
| 2026-05-27 10:54 | 完成 11.1 DashboardView 环形图数据驱动 | 硬编码 70% conic-gradient 改为 donutGradient computed 属性绑定，随容器分布数据动态更新 |
| 2026-05-27 10:58 | 完成 11.2 DashboardView 热度图 tooltip | 移除原生 title 属性，改为自定义 tooltip div + CSS opacity 过渡动画 |
| 2026-05-27 11:02 | 完成 11.3 MemoryView 重要度星级显示 | 数字改为 5 颗星图标（★/☆），filled 用 --warning 色，移除 getImportanceClass 和旧高亮样式 |
| 2026-05-27 11:04 | 完成 12.1 Loading skeleton 替代 spinner | 创建 admin-ui 和 core-ui 各一份 Skeleton.vue 组件；DashboardView 指标卡片加载显示 skeleton 块；SpacesView 表格行加载显示 skeleton 行；MemoryView 卡片列表加载显示 skeleton 卡片 |
| 2026-05-27 11:10 | 完成 12.2 空状态优化 | 三个 view 的空状态增加 emoji 图标 + 标题 + 引导文案，统一样式 |
| 2026-05-27 11:12 | 完成 12.3 响应式布局 | DashboardView 768px 单列；SpacesView 表格水平滚动；App.vue 侧边栏窄屏可折叠（hamburger+overlay+slide） |
| 2026-05-27 11:15 | 完成 12.4 状态徽章统一 | running→accent, done/completed→success, failed→danger, pending/paused→warning；统一 SubagentsView/RunDetailView/RunsView/CheckpointsView 4 个文件 |
| 2026-05-27 11:19 | 完成 13.1 全量编译 | 4 个包全部构建通过（修复 Toast.vue 未使用 ref 导入）；admin-ui-web/harness-ui 为二级目录需直接 cd 构建 |
| 2026-05-27 11:22 | 完成 13.2 质量扫描 | oxlint/sonarjs 扫描通过，0 个 error 级别问题 |
| 2026-05-27 11:24 | 完成 13.3 更新文档 | changelog.md 索引 + 2026-05-27-11.md 详细记录 + roadmap.md UI 展示条目追加 refinement 说明 |
