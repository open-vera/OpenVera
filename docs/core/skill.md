# Skill 系统

Skill 是 Vera 的可插拔能力扩展机制——通过 Markdown 文件声明 agent 的行为指令、工具权限和触发条件，运行时按意图自动激活，无需修改核心代码。

---

## 1. Skill 定义格式

一个 skill 就是一个 `.md` 文件，由 **frontmatter（YAML 元数据）** 和 **body（Markdown 指令）** 组成。body 的内容直接注入 system prompt。

```
.vera/skills/            ← 项目级 skill
~/.vera/skills/          ← 用户级 skill（全局）
packages/harness/skills/ ← 内置 skill
```

### 1.1 Frontmatter 字段

```yaml
---
id: github                        # 唯一标识
name: GitHub 操作                  # 展示名
description: 管理 PR、issues      # 一句话描述
triggers:                         # 触发条件
  - always                        #   每次对话都加载
  - domain: code                  #   intent.domain 匹配时
  - domain: [code, analysis]      #   多 domain
  - level: 2                      #   intent.level >= 2 时
  - needs_tools: true             #   需要工具时
  # 不写 triggers → 仅可通过 /skill <id> 显式激活
tools:                            # 引用内置工具 id
  - read_file
  - bash
rules:                            # 约束规则（与 body 一起注入）
  - 高风险操作必须获得用户确认
---
```

`triggers` 支持五种类型：`always`（无条件）、`domain`（领域匹配）、`level`（复杂度阈值）、`needs_tools`（需要工具）、`explicit`（仅显式激活）。

### 1.2 完整示例

```markdown
---
id: coding-rules
name: 编码约束
description: 写代码时的基础规范
triggers:
  - domain: code
tools:
  - read_file
  - bash
rules:
  - 修改前先 read 文件，确认上下文
  - 函数不超过 40 行
---

## 编码规范

- 优先复用已有函数，不重复造轮子
- 不添加未被要求的错误处理和注释
- 每个修改完成后运行测试确认无回归
```

---

## 2. 意图驱动激活

系统通过 **意图分类 → 触发匹配 → 按需组装** 决定激活哪些 skill。

### 2.1 IntentSignal

上游意图分类器产出 `IntentSignal`，这是 SkillResolver 的唯一输入：

```typescript
type IntentDomain = "chat" | "code" | "search" | "writing" | "analysis" | "other";

interface IntentSignal {
  domain: IntentDomain;
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
  explicitIds?: string[];  // 来自 /skill <id> 命令
}
```

### 2.2 SkillResolver 匹配

`SkillResolver.resolve(intent, baseSystem)` 遍历所有已注册 skill，逐条匹配 trigger。一个 skill 可以有多个 trigger，满足任一即激活。

| trigger 类型 | 匹配条件 |
|-------------|---------|
| `always` | 始终匹配 |
| `domain` | `intent.domain` 在 domains 列表中 |
| `level` | `intent.level >= minLevel` |
| `needs_tools` | `intent.needs_tools === true` |
| `explicit` | `intent.explicitIds` 包含当前 skill.id |

### 2.3 SkillBundle 组装

匹配完成后，Resolver 组装 `SkillBundle` 直接传给 `streamAgent`：

```typescript
interface SkillBundle {
  system: string;                          // base system + 各 skill 的 systemFragment
  tools: Tool[];                           // 合并的工具定义列表
  executors: Map<string, ToolExecutor>;    // toolName → executor 映射
}
```

- `systemFragment` 以 `## Skill: <name> (<id>)` 标题注入 system prompt
- 工具按名字去重，后注册的 skill 不覆盖同名工具
- 懒加载 skill 在此阶段通过 `skill.load()` 完成 hydration

### 2.4 渐进式披露

- `auto: true`（有非 explicit trigger）的 skill 自动激活，用户无感知
- `auto: false`（仅有 explicit trigger）的 skill 只展示描述
- 用户通过 `/skill <id>` 显式激活，当次对话生效

---

## 3. 加载与热更新

### 3.1 加载管线

```
.md 文件
  ↓ parseFrontmatter()    — 极简 YAML 解析器（无外部依赖）
  ↓ parseTriggers()       — 解析 triggers 列表
  ↓ resolveTools()        — 通过 BuiltinToolProvider 将 id 解析为 Tool + executor
  ↓ buildSystemFragment() — rules + body 拼接
  ↓
Skill 对象 → 注册到 SkillResolver
```

### 3.2 元数据优先 + 懒加载

目录扫描时只解析 frontmatter，不加载 body，减少启动开销：

- `loadSkillMetadataFile()` 返回 Skill 对象，`systemFragment` 为空，但携带 `load()` 闭包
- 只有被匹配激活的 skill 才在 `hydrate()` 阶段调用 `load()` 获取完整内容

```typescript
interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: SkillTrigger[];
  sourcePath?: string;
  load?: () => Skill;           // 懒加载：返回完整 Skill
  systemFragment?: string;      // 注入 system prompt 的文本
  tools?: SkillTool[];          // { definition: Tool, executor: ToolExecutor }[]
}
```

### 3.3 热更新

Skill 文件变化时，重新调用 `loadSkillDir()` 并 `registerAll()` 即可。Resolver 内部 `Map<string, Skill>` 被完全替换，下一次 `resolve()` 即生效，无需重启进程。

---

## 4. 内置 Skill 与自定义 Skill

### 4.1 来源分类

```typescript
type SkillOrigin = "system" | "brand" | "user" | "marketplace";
```

| 来源 | 位置 | 说明 |
|------|------|------|
| `system` | `packages/harness/skills/` | 框架内置，随 Vera 发布 |
| `brand` | 组织级目录 | 团队共享的品牌规范 skill |
| `user` | `.vera/skills/` / `~/.vera/skills/` | 用户自行编写 |
| `marketplace` | 外部注册源 | 社区或第三方发布 |

### 4.2 进化权限控制

`SkillFilter` 按来源控制自动进化权限：

```typescript
interface FilterOptions {
  evolvableOrigins?: SkillOrigin[];  // 默认 ["user", "marketplace"]
}
```

默认只允许 `user` 和 `marketplace` skill 自动进化。`system` 和 `brand` skill 受保护，防止框架核心能力被意外修改。

### 4.3 内置工具引用

内置工具 id 由 harness 维护，skill 作者通过 `tools` 字段直接引用：

```typescript
interface BuiltinToolProvider {
  resolve(name: string): { definition: Tool; executor: ToolExecutor } | null;
}
```

loader 在编译时调用 `toolProvider.resolve(id)`，将字符串 id 解析为可执行的 `SkillTool`。

---

## 5. Skill 编写指南

### 5.1 声明，不是实现

Skill 作者写的是 **声明文件**，负责定义"什么时候激活、给 agent 什么指令、暴露哪些工具"；Harness 负责编译和运行时执行。

| 作者关心 | 作者不关心 |
|---------|-----------|
| 这个 skill 什么时候激活 | MCP 协议怎么连接 |
| 给 agent 什么指令 | tool executor 怎么实现 |
| 暴露哪些工具（引用 id） | system prompt 怎么拼接 |
| rules 是什么 | intent 分类怎么做 |

### 5.2 文件组织

一个 skill 一个 `.md` 文件。按功能领域分组到不同目录，按来源分级（项目/用户/内置）。

### 5.3 编写原则

- **id 用 kebab-case**：`github-pr`、`coding-rules`
- **description 一句话说清楚**：用于能力列表展示，影响渐进式披露体验
- **triggers 精准匹配**：避免滥用 `always`，防止无关 skill 污染 system prompt
- **body 写清楚边界**：不要只写 happy path，也要写什么不能做
- **迭代优化**：利用 SkillReflector 的执行后反思持续改进

---

## 6. 版本管理

### 6.1 语义化版本

Skill 采用 semver，通过 `VersionManager` 追踪：

```typescript
interface SkillVersion {
  version: string;           // 当前版本
  history: VersionEntry[];   // 变更历史
}

interface VersionEntry {
  version: string;
  changes: string[];         // 变更描述
  timestamp: string;
  source: "reflection" | "manual" | "auto-create";
}
```

版本升级规则：
- **major**：破坏性变更（移除步骤、改变输出格式）
- **minor**：向后兼容的功能增强（新增覆盖场景）
- **patch**：修复性变更（措辞优化、边界情况修复）

### 6.2 SkillReflector — 驱动版本升级

`SkillReflector` 在 skill 执行后调用 LLM 分析质量，产出 `SkillReflection`：

**四维度评估：**
- **Clarity**（清晰度）：指令是否无歧义
- **Coverage**（覆盖面）：边界和错误场景是否覆盖
- **Correctness**（正确性）：步骤是否产生预期结果
- **Efficiency**（效率）：是否有冗余步骤

**输出：**
```typescript
interface SkillReflection {
  skillName: string;
  qualityScore: number;    // 0-1
  issues: ReflectionIssue[];
  needsUpdate: boolean;    // qualityScore < 0.8 时自动为 true
  bumpType?: "major" | "minor" | "patch";
}
```

bumpType 推断逻辑：有 high 级 issue → major，有 medium → minor，仅 low → patch。

### 6.3 SkillAutoCreator

从 agent 执行历史中自动提取可复用 skill 模板。执行轮次 >= `minRounds`（默认 3）且置信度 >= `minConfidence`（默认 0.6）时产出 `SkillTemplate`。

---

## 7. 相关文档

| 文档 | 内容 |
|------|------|
| [skill-evo.md](./skill-evo.md) | Skill 进化详解（SkillReflector、SkillOptAdapter 训练框架） |
| [tool-runtime.md](./tool-runtime.md) | 工具运行时模型、生命周期 |
| [runtime.md](./runtime.md) | Agent 运行时整体架构 |

---

## 8. 当前状态

| 能力 | 状态 |
|------|------|
| Markdown 格式定义 + frontmatter 解析 | 已实现 |
| IntentSignal 驱动激活 + SkillResolver | 已实现 |
| 元数据优先 + 懒加载 | 已实现 |
| 热更新（目录重扫） | 已实现 |
| 内置工具引用（BuiltinToolProvider） | 已实现 |
| 进化权限控制（SkillFilter） | 类型已定义 |
| SkillReflector 四维度反思 | 已实现 |
| SkillAutoCreator 模板提取 | 类型已定义 |
| VersionManager 语义化版本 | 类型已定义 |
