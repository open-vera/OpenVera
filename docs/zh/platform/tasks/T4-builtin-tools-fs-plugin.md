# T4：内置文件工具组通过 Plugin 链路端到端注册与执行

> 优先级：P0 · 预估：1~2 天 · 前置：无（骨架已就绪）

---

## 1. 目标

验证 OpenVera 插件系统端到端可用：将 `builtin-tools-fs`（read_file / write_file / edit_file / list_dir / glob / grep）从硬编码注册改为通过 **PluginHost → ToolHost** 链路注册并执行。

成功后，其他内置工具、第三方工具、Channel adapter 都可复制同一模式。

---

## 2. 背景

| 组件 | 状态 | 位置 |
|------|------|------|
| PluginHost / EventBus / CapabilityRegistry | ✅ 已实现 | `packages/plugin-runtime/src/` |
| ToolHost 桥接层 | ✅ 已存在 | `packages/core/src/tools/tool-host.ts` |
| 6 个文件工具实现 | ✅ 完整 | `packages/core/src/tools/read-file.ts` 等 |
| 当前注册方式 | ❌ 硬编码 | `packages/core/src/tools/index.ts` → `createToolRegistry()` |

当前问题：所有工具通过 `createToolRegistry()` 直接注册，未经过 Plugin 链路，EventBus hook 无法触发，插件系统形同虚设。

---

## 3. 需要阅读的文件

按顺序阅读，理解接口契约：

1. `packages/plugin-runtime/src/index.ts` — 公共 API 导出
2. `packages/plugin-runtime/src/context.ts` — PluginContext / CapabilityProvider 接口
3. `packages/plugin-runtime/src/plugin-host.ts` — PluginHost.activate() 流程
4. `packages/plugin-runtime/src/capability-registry.ts` — 注册 / 冲突规则
5. `packages/core/src/tools/tool-host.ts` — ToolHost 如何消费 capability
6. `packages/core/src/tools/types.ts` — ToolDef / ToolResult / ToolContext
7. `packages/core/src/tools/index.ts` — 当前 createToolRegistry() 逻辑
8. `packages/core/src/tools/builtin-tools.ts` — 当前内置工具分组方式

---

## 4. 实施步骤

### Step 1：创建 builtin-tools-fs 插件

**新建** `packages/core/src/plugins/builtin-tools-fs.ts`

```ts
import { definePlugin } from "@open-vera/plugin-runtime";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { editFileTool } from "../tools/edit-file.js";
import { listDirTool } from "../tools/list-dir.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";

export default definePlugin({
  async activate(ctx) {
    const tools = [readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool];
    for (const tool of tools) {
      ctx.disposables.add(ctx.provide.tool(tool));
    }
  },

  async deactivate(ctx) {
    await ctx.dispose();
  },
});
```

要求：
- 使用 `definePlugin` 标准 API
- 每个 `ctx.provide.tool(def)` 返回的 Disposable 注册到 `ctx.disposables`
- deactivate 中调用 `ctx.dispose()` 清理

### Step 2：接入 PluginHost 加载流程

修改工具注册启动流程，增加 Plugin 加载路径：

```
1. 创建 PluginHost 实例（如已有则复用）
2. 将 builtin-tools-fs 作为 builtin plugin source 注册
3. 调用 PluginHost.activate() 激活插件
4. 插件注册的 tool capability 通过 ToolHost 可用
5. ToolHost.execute() 作为工具执行入口
```

### Step 3：确保 EventBus 事件触发

执行链路必须经过 EventBus：

| 事件 | 时机 | 语义 |
|------|------|------|
| `tool:before:<name>` | 执行前 | 可被 intercept 短路 |
| `tool:after:<name>` | 执行后 | observe，fire-and-forget |
| `tool:error:<name>` | 执行失败 | observe，记录错误 |

### Step 4：保留旧路径兼容

- **不删除** `createToolRegistry()` 中对这 6 个工具的直接注册
- 通过 feature flag 或检测逻辑决定走新路径还是旧路径
- 默认走新路径，旧路径作为 fallback
- 确保现有测试全部通过

### Step 5：编写 Contract Test

**新建** `packages/core/src/plugins/tests/builtin-tools-fs.test.ts`

| 用例 | 验证点 |
|------|--------|
| 插件激活后工具可用 | `ToolHost.getSchemas()` 包含 6 个工具 |
| 工具执行成功 | `read_file` 返回 `ok: true` |
| hook 被触发 | observe `tool:after:read_file` 收到事件 |
| intercept 可短路 | hook 返回 handled 后 execute 不被调用 |
| 冲突拒绝 | 重复注册同名 tool 被拒绝 |
| deactivate 清理 | 插件停用后工具不再可用 |

---

## 5. 约束

| 规则 | 说明 |
|------|------|
| 依赖方向 | `core → plugin-runtime`，禁止反向 |
| 文件命名 | kebab-case（`builtin-tools-fs.ts`） |
| 测试框架 | Vitest，`describe` / `it` / `expect` |
| Mock 策略 | 不 mock 内部模块，仅 mock 外部 IO（文件系统用 tmp 目录） |
| 类型安全 | TypeScript strict，禁止 `any` |
| ESM | 所有 import 使用 `.js` 后缀 |
| Diff 限制 | 单次提交不超过 500 行（不含测试） |

---

## 6. 验收标准

- [ ] `pnpm --filter @open-vera/core run test` 全部通过（包括新旧测试）
- [ ] 新 contract test 6 个用例全绿
- [ ] 现有 `tools/tests/read-file.test.ts` 等不受影响
- [ ] 启动 REPL 后 `read_file` 工具正常工作
- [ ] EventBus 上能观测到 `tool:before:read_file` / `tool:after:read_file` 事件

---

## 7. 参考文件

| 文件 | 用途 |
|------|------|
| `docs/zh/platform/plugin.md` §14.3, §14.15 | 设计文档：工具分组 + 示例代码 |
| `packages/plugin-runtime/src/` | 插件运行时骨架 |
| `packages/core/src/tools/tool-host.ts` | ToolHost 桥接参考 |
| `packages/core/src/tools/index.ts` | 当前 createToolRegistry() |
| `packages/core/src/tools/builtin-tools.ts` | 当前分组方式 |
| `packages/core/src/tools/tests/` | 现有测试（不能 break） |

---

## 8. 后续任务（本次不做）

本任务完成后，以下任务可用同一模式复制：

- `builtin-tools-shell`（bash）
- `builtin-browser`（browser）
- `builtin-computer-use`（desktop-*）
- `builtin-provider-anthropic` / `openai` / `gemini`（LLM adapter 插件化，依赖 T1 LlmService）
