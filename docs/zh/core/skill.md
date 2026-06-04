# Skill 系统

Skill 系统是 Vera 的可插拔能力扩展机制——通过 Markdown 文件声明 agent 的行为指令、工具权限和触发条件，运行时按意图自动激活，无需修改核心代码。

---

## 1. 核心概念

Skill 的本质是 **声明式能力单元**，包含三要素：

| 要素 | 载体 | 作用 |
|------|------|------|
| **指令** | Markdown body + frontmatter `rules` | 注入 system prompt，定义 agent 行为约束 |
| **工具** | frontmatter `tools` + `mcp` | 声明 skill 可用的内置工具和 MCP 服务 |
| **触发** | frontmatter `triggers` | 决定 skill 何时被自动或显式激活 |

skill 作者不需要写 TypeScript executor、不关心 MCP 协议细节、不手动拼接 system prompt——这些都是 Harness 运行时负责的事。

---

## 2. Skill 定义格式

一个 skill 就是一个 `.md` 文件，放在约定目录下：

```
.vera/skills/            ← 项目级 skill（跟随仓库）
~/.vera/skills/          ← 用户级 skill（全局生效）
packages/harness/skills/ ← 内置 skill（框架自带）
```

### 2.1 文件结构

```markdown
---
id: github
name: GitHub 操作
description: 管理 PR、issues、分支
triggers:
  - domain: code
  - needs_tools: true
tools:
  - read_file
  - bash
rules:
  - 高风险操作（删除、force push）必须获得用户确认
---

## 操作指南

你可以操作 GitHub 仓库。常见操作：
- 查看 PR 列表和详情
- 创建、合并、关闭 PR
- 管理 issues

**注意**：合并 PR 前确认 CI 通过。
```

文件由 frontmatter（YAML 元数据）和 body（Markdown 指令文本）两部分组成。body 内容直接注入 system prompt。

### 2.2 Frontmatter 字段

**基础字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识，用于显式引用和 `/skill <id>` 激活 |
| `name` | string | 展示名称 |
| `description` | string | 一句话描述，用于渐进式披露和能力列表 |

**触发条件（triggers）：**

```yaml
triggers:
  - always                   # 每次对话都激活
  - domain: code             # intent.domain 匹配时
  - domain: [code, analysis] # 多 domain 匹配
  - level: 2                 # intent.level >= 2 时
  - needs_tools: true        # 任务需要工具时
  # 不写 triggers：仅可通过 /skill <id> 显式激活（type: explicit）
```

**工具声明（tools）：**

```yaml
tools:
  - read_file                # 引用内置工具组的 id
  - bash
  - web_search
```

内置工具 id 由 harness 维护，skill 作者直接引用。loader 通过 `BuiltinToolProvider` 将 id 解析为 `{ definition: Tool, executor: ToolExecutor }`。

**规则声明（rules）：**

```yaml
rules:
  - 操作前先确认目标资源存在
  - 修改文件前先读取现有内容
```

`rules` 和 body 都会拼接为 `systemFragment`，注入到最终的 system prompt 中。

---

## 3. 意图驱动激活

Skill 不总是全部加载。系统通过 **意图分类 -> 触发匹配 -> 按需组装** 的三段式流程决定激活哪些 skill。

### 3.1 意图信号（IntentSignal）

```typescript
interface IntentSignal {
  domain: IntentDomain;   // "chat" | "code" | "search" | "writing" | "analysis" | "other"
  level: 0 | 1 | 2 | 3;   // 任务复杂度级别
  needs_tools: boolean;    // 是否需要工具支持
  explicitIds?: string[];  // 显式激活的 skill id 列表
}
```

`IntentSignal` 由上游的 intent 分类器产出，是 SkillResolver 的唯一输入。

### 3.2 触发匹配规则

`SkillResolver.resolve(intent, baseSystem)` 遍历所有已注册 skill，逐条匹配 trigger：

| trigger 类型 | 匹配逻辑 |
|-------------|---------|
| `always` | 无条件匹配，每次对话都激活 |
| `domain` | `intent.domain` 属于 trigger 声明的 domains |
| `level` | `intent.level >= trigger.minLevel` |
| `needs_tools` | `intent.needs_tools === true` |
| `explicit` | `intent.explicitIds` 包含当前 skill.id |

一个 skill 可以有多个 trigger，满足任一即激活。

### 3.3 SkillBundle 组装

匹配完成后，Resolver 将所有激活 skill 组装为 `SkillBundle`：

```typescript
interface SkillBundle {
  system: string;                          // base system + 各 skill 的 systemFragment
  tools: Tool[];                           // 合并后的工具定义列表
  executors: Map<string, ToolExecutor>;    // toolName → executor 映射
}
```

- `systemFragment` 以 `## Skill: <name> (<id>)` 标题注入 system prompt
- 工具按名字去重，后注册的 skill 不覆盖同名工具
- lazy-load 的 skill 在此阶段通过 `skill.load()` 完成 hydration

### 3.4 渐进式披露

Resolver 还为 `/skill` 命令提供索引功能：

```typescript
// 用户问"你能做什么"时展示
list(): Array<{
  id: string; name: string; description: string; auto: boolean
}>
```

- `auto: true` 的 skill 会自动激活，用户无感知
- `auto: false` 的 skill 只展示描述，用户可通过 `/skill <id>` 显式激活
- 激活后本次对话追加该 skill 的工具和指令

---

## 4. Skill 加载与热更新

### 4.1 加载流程

```
.md 文件
  ↓ parseFrontmatter()
  frontmatter (meta) + body
  ↓ parseTriggers()           ← 解析 trigger 条件
  ↓ resolveTools()            ← 内置工具 id → Tool + executor
  ↓ buildSystemFragment()     ← rules + body → string
  ↓
Skill { id, name, description, triggers, sourcePath, systemFragment, tools }
  ↓ register() → SkillResolver
```

### 4.2 元数据优先 + 懒加载

为减少启动开销，目录扫描采用元数据优先策略：

- `loadSkillDir()` 扫描目录下所有 `.md` 文件
- 每个文件调用 `loadSkillMetadataFile()`——只解析 frontmatter，不加载 body
- 返回的 Skill 对象携带 `load()` 闭包，指向完整的文件加载函数
- 只有被匹配激活的 skill 才在 `hydrate()` 阶段调用 `load()` 获取完整内容

```typescript
// Skill 接口
interface Skill {
  load?: () => Skill;  // 按需加载完整 body/tools
  // ...
}
```

### 4.3 热更新

Skill 文件变化时，重新调用 `loadSkillDir()` 并 `registerAll()` 即可刷新。Resolver 内部的 `Map<string, Skill>` 会被完全替换，下次 `resolve()` 调用即生效。无需重启 agent 进程。

### 4.4 Frontmatter 解析器

loader 内置了一个极简 YAML 解析器 `parseSimpleYaml()`，支持 skill 文件所需的子集语法：
- `key: scalar`（字符串、数字、布尔）
- `key:` 后跟缩进的 `- item` 列表
- `- key: value` 映射项

不依赖外部 YAML 库，避免增加启动成本。

---

## 5. 内置 Skill 与自定义 Skill

### 5.1 来源分类

```typescript
type SkillOrigin = "system" | "brand" | "user" | "marketplace";
```

| 来源 | 位置 | 说明 |
|------|------|------|
| `system` | `packages/harness/skills/` | 框架内置，随 Vera 发布 |
| `brand` | 组织级目录 | 团队共享的品牌规范 skill |
| `user` | `.vera/skills/` 或 `~/.vera/skills/` | 用户自行编写 |
| `marketplace` | 外部注册源 | 社区或第三方发布 |

### 5.2 进化权限控制

通过 `SkillFilter` 控制哪些 skill 可以参与自动进化：

```typescript
interface FilterOptions {
  evolvableOrigins?: SkillOrigin[];  // 默认 ["user", "marketplace"]
}
```

默认只允许 `user` 和 `marketplace` 来源的 skill 自动进化。`system` 和 `brand` skill 受保护，防止框架核心能力被意外修改。

---

## 6. 版本管理

### 6.1 Skill 版本结构

```typescript
interface SkillVersion {
  version: string;           // 当前版本（semver）
  history: VersionEntry[];   // 变更历史
}

interface VersionEntry {
  version: string;
  changes: string[];         // 变更描述
  timestamp: string;         // ISO 时间戳
  source: "reflection" | "manual" | "auto-create";
}
```

版本号遵循语义化版本：
- **major**：破坏性变更（移除步骤、改变输出格式）
- **minor**：向后兼容的功能增强（新增覆盖场景）
- **patch**：修复性变更（措辞优化、边界情况修复）

### 6.2 版本升级来源

升级由三种来源触发：

| 来源 | 触发方式 | 说明 |
|------|----------|------|
| `reflection` | SkillReflector 分析后建议 | LLM 四维度评估，产出 bumpType |
| `manual` | 开发者手动编辑 | 直接修改 .md 文件 |
| `auto-create` | SkillAutoCreator 生成 | 从执行历史提取新模板 |

---

## 7. Skill 进化

### 7.1 SkillReflector — 执行后反思

`SkillReflector` 是进化的核心组件，在 skill 执行后调用 LLM 分析质量：

**流程：**
1. 读取 skill 内容（截断至 3000 字符）
2. 构建执行转录（每条消息截断至 300 字符）
3. LLM 四维度评估
4. 返回结构化 `SkillReflection`

**四维度评估：**

| 维度 | 评估内容 |
|------|---------|
| Clarity（清晰度） | 指令是否无歧义？agent 能否不猜测就执行？ |
| Coverage（覆盖面） | 边界情况是否处理？是否缺少错误场景？ |
| Correctness（正确性） | 步骤是否产生预期结果？ |
| Efficiency（效率） | 是否有冗余步骤或重复检查？ |

**输出自动判断：**
- `needsUpdate`：LLM 显式返回 或 `qualityScore < minQuality`（默认 0.8）
- `bumpType`：LLM 显式返回，或根据 issue 最高严重级别推断（high→major, medium→minor, low→patch）

### 7.2 SkillAutoCreator — 自动创建

从 agent 执行历史中提取可复用 skill 模板：

```typescript
interface SkillTemplate {
  name: string;            // skill 名称（kebab-case）
  description: string;     // 一句话描述
  triggers: string[];      // 触发条件
  steps: string[];         // 执行步骤
  allowedTools: string[];  // 所需工具
  argumentHint?: string;   // 参数提示
  sourceTask: string;      // 来源任务 ID
  confidence: number;      // 可复用置信度（0-1）
}
```

- 执行轮次 >= `minRounds`（默认 3）才触发提取
- 置信度 >= `minConfidence`（默认 0.6）才输出模板

---

## 8. 关键类型速查

```typescript
// ── Skill 定义 ──
interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: SkillTrigger[];
  sourcePath?: string;
  load?: () => Skill;           // 懒加载函数
  systemFragment?: string;      // 注入 system prompt 的文本
  tools?: SkillTool[];          // { definition: Tool, executor: ToolExecutor }[]
}

// ── 触发条件 ──
type SkillTrigger =
  | { type: "always" }
  | { type: "domain"; domains: IntentDomain[] }
  | { type: "level"; minLevel: 0 | 1 | 2 | 3 }
  | { type: "needs_tools" }
  | { type: "explicit" };

// ── 意图信号 ──
interface IntentSignal {
  domain: IntentDomain;
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
  explicitIds?: string[];
}

// ── 分辨率输出 ──
interface SkillBundle {
  system: string;
  tools: Tool[];
  executors: Map<string, ToolExecutor>;
}
```

---

## 9. 相关文档

| 文档 | 内容 |
|------|------|
| [skill-evo.md](./skill-evo.md) | Skill 进化系统详解（SkillReflector、SkillOptAdapter 训练框架） |
| [tool-runtime.md](./tool-runtime.md) | 工具运行时模型、生命周期、Harness 集成 |
| [runtime.md](./runtime.md) | agent 运行时整体架构 |
| [session.md](./session.md) | 会话管理与持久化 |

---

## 10. 当前状态

Skill 系统核心能力已就绪：

| 能力 | 状态 |
|------|------|
| Markdown 格式定义 + frontmatter 解析 | 已实现 |
| IntentSignal 驱动激活 + SkillResolver | 已实现 |
| 元数据优先 + 懒加载 | 已实现 |
| 热更新（目录重扫） | 已实现 |
| 内置工具引用 + BuiltinToolProvider | 已实现 |
| SkillReflector 四维度反思 | 已实现 |
| SkillAutoCreator 模板提取 | 类型已定义，提取逻辑待实现 |
| VersionManager 语义化版本 | 类型已定义 |
| SkillFilter 进化权限控制 | 类型已定义 |
| SkillOptAdapter 训练框架集成 | 已实现 |
