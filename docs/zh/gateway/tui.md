# TUI 总览

> Vera 的终端用户界面基于 React + Ink 构建，运行于交互式 TTY，提供对话面板、Diff 展示、Slash 命令系统等完整的终端交互体验。

## 架构总览

```
packages/core/src/repl/
  index.ts          ← startRepl() → Ink render(<App />) → waitUntilExit()
  context.ts        ← ReplContext（cwd、config、adapter、sessionStore...）
  commands/         ← 17 个 /slash 命令，统一 handleCommand 路由
  ui/
    App.tsx             ← 根组件，全局状态 + Turn 生命周期
    ConversationPanel   ← 视口裁剪对话列表 + 滚动锚定
    InputBar            ← 行编辑器（光标/历史/补全/搜索/外部编辑器）
    StatusBar           ← Breathing spinner + Token 计数
    OverlayHost         ← 弹出层容器（6 种 Overlay）
    DiffView / DiffDialog ← 语法级 Diff（word-level 高亮 + 文件列表）
    SessionPicker       ← 交互式会话恢复（搜索/分页/预览/分支对比）
    WelcomeScreen       ← 空会话欢迎页
    ToolResultView      ← 工具调用结果内联展示
    SelectPrompt        ← 单选/多选提示（复用为 Provider/Model 选择器）
    renderers/          ← Bash/Code/Error/FileList/Text
    AskUserQuestion/    ← 多选问答组件
    controller/         ← 事件投影、Turn 生命周期、路由、持久化
    hooks/              ← 流式处理、会话生命周期、工具调用
    state/              ← Composer 状态机、Overlay Reducer、队列、Turn Store
```

## REPL 循环流程

### 启动路径

```text
startRepl(ctx)
  → assertInteractiveInput()           // 检查 TTY
  → render(<App ctx={ctx} />)          // Ink 挂载到终端
  → waitUntilExit()                    // block 直到用户 exit()
```

### 主循环：一次 Turn 的完整生命周期

```text
用户输入 → handleSubmit(line)
  │
  ├─ Slash Command → handleSlashCommandSubmission()
  │   └─ 直接操作 UI 状态（setMessages / dispatchOverlay / exit）
  │
  └─ 普通消息 → Turn Pipeline
      ├─ 1. resolveTurnRouting()       → Intent 分类 + 选择 Provider/Model
      ├─ 2. prepareTurnContext()       → 加载历史、Memory、ProjectContext
      ├─ 3. prepareTurnSetup()         → 组装 Prompt + Tools + toolCallHandler
      └─ 4. runPreparedTurn()
          ├─ Plan Mode                 → 多步计划 + 步骤可视化
          └─ Stream Mode               → streamAgent() LLM 流式调用
```

### 任务队列

当 `streamStatus !== "idle"` 时输入自动入队（enqueue），StatusBar 显示排队数。流式结束后 useEffect 自动出队执行：

```typescript
useEffect(() => {
  if (streamStatus !== "idle" || queue.items.length === 0) return;
  const next = dequeue();
  if (next) handleSubmit(next);
}, [streamStatus, queue.items.length]);
```

## 核心组件

### App（根组件）

`packages/core/src/repl/ui/App.tsx`

全局状态管理控制中心，通过 `useRef` 持有可变状态避免不必要的重渲染：

| Ref | 用途 |
|---|---|
| `ctxRef` | ReplContext（config、adapter、sessionStore） |
| `streamingBufferRef` / `thinkingBufferRef` | 流式文本/Thinking 增量缓冲区 |
| `historyRef` | LLM 对话历史（Message[]） |
| `compressionStateRef` / `memoryTrackerRef` | 上下文压缩 + Memory 提取 |
| `costRef` | 累计成本（按 Provider/Model 分账） |
| `abortRef` | AbortController，用于取消当前 Turn |
| `planStepsRef` | Plan Mode 步骤列表 |

终端尺寸监听 `stdout.on("resize")` → `columns × rows` → 驱动 ConversationPanel 视口计算。

### ConversationPanel（对话面板）

`packages/core/src/repl/ui/ConversationPanel.tsx`

基于线估计的视口裁剪消息列表：

1. **Line Estimation**：`getEstimatedMessageLines()` 根据文本长度、wrapWidth、Thinking/工具行数估算每条消息行数，结果缓存到 `heightCacheRef`（Map）中。
2. **视口裁剪**：根据 `scrollOffset` 和 `availableHeight` 确定 `[viewStart, viewEnd)`，仅渲染可见消息。被剪消息数通过 "↑ N 条消息已隐藏" 提示。
3. **滚动锚定**：新内容到达时自动增加 `scrollOffset` 补偿，保持用户视觉位置不变。
4. **上下文保留**：视口顶部是助手消息时，回溯加入前一个用户消息，确保对话不丢失。

**消息渲染顺序**：Thinking 块 → Tool Uses → 文本内容。用户消息绿色 `>` 前缀，助手消息橙色 `●` 前缀。Plan Mode 消息渲染步骤列表（pending ○ / running ▶ / done ✓ / failed ✗）。

### InputBar（输入行）

`packages/core/src/repl/ui/InputBar.tsx`

基于 `composerState` 纯函数状态机：

```
(input, key) → reduceComposerInput(composer, input, key, history)
  → { state: ComposerState, effect?: Effect }
    → onChange(value)                  // 回写 React state
    → Effect 触发（submit/exit/cancel/scroll）
```

**功能**：光标控制（字素感知、Ctrl+A/E、Meta+Arrow）、编辑（Ctrl+W 删词、Ctrl+U 清行、Ctrl+K 删至行尾）、历史导航（↑↓ 浏览、Ctrl+R 反向搜索）、补全（`/` 命令补全 + Tab 文件路径补全）、外部编辑器（Ctrl+X → `$VISUAL`/`$EDITOR` → 回填）、IME/CJK 兼容。

**双路径输入**：Ink `useInput()` 处理稳态输入 + 同步 `internal_eventEmitter.on("input")` 覆盖 mount 窗口首个按键。`inkInputReadyRef` 标志位确保不双重解析。

### StatusBar（状态栏）

`packages/core/src/repl/ui/StatusBar.tsx`

- **idle**：`⌥O` 工具输出折叠/展开提示
- **滚动中**：黄色 ↑ + 滚动导航
- **活跃**：8 帧品牌橙色呼吸动画（120ms/帧）+ 经过时间 + input/output token + `esc to cancel` + 排队计数

### OverlayHost（弹出层容器）

`packages/core/src/repl/ui/OverlayHost.tsx`

通过 `useReducer(reduceOverlay)` 驱动 6 种状态：

| Overlay | 组件 | 说明 |
|---|---|---|
| `diff` | DiffDialog | 全屏 Git Diff 查看器 |
| `sessionPicker` | SessionPicker | 会话恢复（搜索/预览/分支对比） |
| `providerPicker` | SelectPrompt | Provider 列表选择 |
| `modelPicker` | SelectPrompt | Model 选择（按 Provider 分组） |
| `prompt: question` | AskUserQuestion | 多选问答 |
| `prompt: approval` | SelectPrompt | 高风险操作确认 |

切换后通过 `writeConfig()` 持久化并回调 App 更新路由。

### DiffView（差异视图）

`packages/core/src/repl/ui/DiffView.tsx`

利用 `diffWordsWithSpace` 实现 word-level 语法高亮：

- 相邻删除+新增行，变化比例 ≤ 40% 时启用 word-level 着色
- 删除行红色背景 + 红色字，新增行绿色背景 + 绿色字
- dim 模式用于历史 Diff（降低亮度）
- DiffDialog：文件列表视图（↑↓ 导航、Enter 展开详情、esc/q 返回）

### SessionPicker（会话选择器）

`packages/core/src/repl/ui/SessionPicker.tsx`

交互式会话恢复面板：

- **分页加载**：`listSessionsPaged()` 分页，接近底部自动加载更多
- **全文搜索**：`/` 进入搜索模式，支持 `branch:` `tag:` `cost>` `cost<` `after:` `before:` 过滤器，搜索时全量扫描
- **会话预览**：复用 ConversationPanel 渲染对话预览（12 行视口 + 滚动）
- **分支对比**：`listBranches()` 展示同一 parent 的分支树
- **键盘导航**：↑↓ 选择、PgUp/PgDn 翻页、u/d 滚动预览、o 展开工具、b 分支对比、Enter 恢复、esc 关闭

## 主题系统

`packages/core/src/repl/ui/theme.ts`

暗色主题调色板，所有颜色定义为语义命名 CSS RGB 字符串：

### 语义色彩令牌

| 令牌 | RGB | 用途 |
|---|---|---|
| `brand` | `(215,119,87)` | 品牌橙 — 助手消息前缀、输入提示符 |
| `brandShimmer` | `(235,159,127)` | 品牌亮橙 — 队列消息 |
| `success` | `(78,186,101)` | 成功绿 — 用户消息前缀、工具 OK |
| `error` | `(255,107,128)` | 错误红 — 失败标记 |
| `warning` | `(255,193,7)` | 警告黄 — 队列标记、滚动提示 |
| `suggestion` | `(177,185,249)` | 蓝紫 — 补全建议、Plan 头部 |
| `text` | `(255,255,255)` | 主文本（白） |
| `textDim` | `(153,153,153)` | 次级文本（灰） |
| `textSubtle` | `(80,80,80)` | 低调文本（深灰）— 分隔线 |

### 功能域色彩

**Diff**：`diffAddedBg (34,92,43)` / `diffAddedWord (56,166,96)` 绿系，`diffRemovedBg (122,41,54)` / `diffRemovedWord (179,89,107)` 红系，`diffHunk (100,149,237)` 矢车菊蓝。

**Plan Step**：pending `textDim`、running `suggestion`、done `success`、failed `error`。

**Spinner**：`spinnerFrames` 8 帧品牌橙从暗→亮→暗，模拟呼吸脉冲。

**Tool**：`toolName`（橙）、`toolLabel`（灰）、`toolOk`（绿）、`toolError`（红）。

**Thinking**：`thinkingText (120,120,120)` / `thinkingLabel (100,100,100)` 低对比度灰色。

## 状态管理

### UiEvent 协议

所有 UI 变更通过统一事件协议驱动，不直接 setState：

```typescript
type UiEvent =
  | { type: "user.submitted"; text: string }
  | { type: "assistant.started" | "assistant.delta" | "assistant.completed" | "assistant.failed" }
  | { type: "assistant.thinking.delta" | "assistant.thinking.updated" }
  | { type: "tool.started" | "tool.output" | "tool.completed" }
  | { type: "status.changed"; status: StreamStatus }
  | { type: "usage.updated"; usage: Partial<TokenUsage> }
```

`dispatchUiEvent(event)` → `projectUiEvent(viewModel, event)` → 新 `ReplViewModel`：

```
ReplViewModel { messages, status, usage, activeTurn }
```

- **activeTurn** 由 `reduceActiveTurn()` 纯函数维护（流式文本 + Thinking + 工具列表 + Token）
- **messages** 在 `assistant.completed` 时 archive（合并 thinking + toolUses + content）
- **usage** 累加（inputTotal / outputTotal / cacheWriteTotal / cacheReadTotal / costUsd）

### 状态模块

| 模块 | 职责 |
|---|---|
| `composerState` | InputBar 编辑器状态机，纯函数 reduce |
| `turnStore` | ActiveTurn reducer，响应 UiEvent |
| `overlayStore` | Overlay Action/Reducer |
| `queueState` | 输入队列（FIFO + prepend） |
| `reverseSearch` | Ctrl+R 反向搜索状态 |
| `blockingPrompt` | 阻塞式 Prompt 类型定义 |

## 输入解析

`packages/core/src/repl/ui/inputKeys.ts`

自研 ANSI 解析器 `parseInputChunk(rawChunk) → { input, key }`，兼容 Ink 协议：

- **过滤**：Focus Event、SGR Mouse、X10 Mouse 控制序列
- **特殊键**：ANSI Arrow / Page / Return / Escape / Tab / Backspace / Delete → key flags
- **组合键**：Ctrl+字母（`\x01`~`\x1a`）、Meta+字符（`\x1b`+char）、Shift（大写）
- **去噪**：`parseInputKey()` 仅返回 key flags

## 渲染管线

`packages/core/src/repl/ui/renderers/` 提供 5 种内容渲染器：

| 渲染器 | 说明 |
|---|---|
| `BashOutputView` | ANSI 颜色解析的 Shell 输出 |
| `CodeView` | 语法高亮代码块 |
| `ErrorView` | 结构化错误展示 |
| `FileListView` | 文件变更/搜索结果列表 |
| `TextView` | 纯文本（含截断） |

`ToolResultView` 内联嵌入 ConversationPanel，通过 `toolUsesForDisplay()` 控制策略：默认折叠显示工具名+首行结果，`⌥O` 全局展开显示完整参数和输出。

## 命令系统

17 个 Slash 命令，统一 `handleSlashCommandSubmission()` 调度，签名 `(args[], ctx) => Promise<void>`：

| 命令 | 说明 | Overlay |
|---|---|---|
| `/help` | 所有命令及说明 | — |
| `/model` | 查看/切换模型 | modelPicker |
| `/provider` | 查看/切换 Provider | providerPicker |
| `/sessions` | 历史会话摘要 | — |
| `/resume` | 打开会话选择器 | sessionPicker |
| `/branch` / `/branches` | 创建/列出分支 | — |
| `/switch` / `/adopt` / `/drop` / `/merge` | 分支操作 | — |
| `/title` / `/metadata` | 会话元信息 | — |
| `/transcript` / `/sub` / `/subjobs` | 导出/子代理 | — |
| `/try <text>` | 非流式快速执行 | — |
