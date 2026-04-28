# Skill-First Tool 集成方案

> 解决问题：core 需不需要感知 MCP / ACP / rules？tool 和上下文指令如何按需加载？

---

## 0. 设计原则

- **core 不感知 MCP、ACP、rules、skill** —— core 只接收 `Tool[]` 和 `system: string`，不知道来源
- **skill 是 harness 层的统一抽象** —— MCP、rules、能力描述，都能表达为 skill
- **渐进式披露** —— skill 按 intent 按需加载，不是全量注入

---

## 1. 分层职责

```
┌──────────────────────────────────────────────────────┐
│  harness / repl caller                               │
│                                                      │
│  SkillResolver                                       │
│    ├─ 读 intent（domain / needs_tools / level）       │
│    ├─ 选择要激活的 skills                             │
│    └─ 产出 additionalSystem + additionalTools        │
│                          ↓ 组装完传给 core            │
├──────────────────────────────────────────────────────┤
│  core（loop.ts）                                     │
│  AgentOptions { tools: Tool[], system: string }      │
│  不知道 MCP / skill / rules 的存在                    │
└──────────────────────────────────────────────────────┘
```

core 的 `AgentOptions` 已具备两个稳定接入点，**不需要改动**：

| 接入点 | 来源 | 含义 |
|--------|------|------|
| `tools: Tool[]` | harness 组装 | agent 在本次对话可调用的工具 |
| `system: string` | harness 组装 | agent 的行为指令、能力描述、约束 |

---

## 2. Skill 的定义

一个 skill 是一个纯数据对象，产出两样东西：

```ts
interface Skill {
  id: string;
  /** 触发条件，用于 SkillResolver 决策 */
  trigger: SkillTrigger;
  /** 注入到 system prompt 的片段（能力描述 / 约束 / rules） */
  systemFragment?: string;
  /** 本 skill 携带的工具声明 + executor */
  tools?: Array<{
    definition: Tool;         // 传给 LLM 的 schema
    executor: ToolExecutor;   // harness 执行时调用
  }>;
}

type SkillTrigger =
  | { type: "always" }                          // 基础 skill，每次都加载
  | { type: "domain"; domains: IntentDomain[] } // 按 intent.domain
  | { type: "level"; minLevel: 0 | 1 | 2 | 3 } // 按复杂度
  | { type: "needs_tools" }                     // 需要工具时
  | { type: "explicit"; id: string };           // 显式触发（用户 /skill 命令）

type IntentDomain = "chat" | "code" | "search" | "writing" | "analysis" | "other";
type ToolExecutor = (args: Record<string, unknown>) => Promise<string> | string;
```

---

## 3. Skill 的三种形态

### 3.1 纯指令型（rules / 能力描述）

```ts
const codingRulesSkill: Skill = {
  id: "coding-rules",
  trigger: { type: "domain", domains: ["code"] },
  systemFragment: `
## 编码约束
- 优先复用已有函数，不重复造轮子
- 修改前先 read，确认上下文
- 不添加未被要求的错误处理
  `,
};
```

### 3.2 纯工具型（内置工具）

```ts
const fileSystemSkill: Skill = {
  id: "filesystem",
  trigger: { type: "domain", domains: ["code"] },
  tools: [
    { definition: readFileTool, executor: readFileExecutor },
    { definition: writeFileTool, executor: writeFileExecutor },
  ],
};
```

### 3.3 MCP 包装型

MCP server 在 harness 初始化时 connect，把 tool definitions 和 executor 包装成 skill：

```ts
async function mcpToSkill(serverName: string, client: MCPClient): Promise<Skill> {
  const toolDefs = await client.listTools();   // 拿 MCP tool schemas
  return {
    id: `mcp:${serverName}`,
    trigger: { type: "explicit", id: serverName },
    systemFragment: `你可以使用 ${serverName} 提供的工具，包括：${toolDefs.map(t => t.name).join("、")}`,
    tools: toolDefs.map(def => ({
      definition: adaptMcpTool(def),           // schema 转成 core Tool
      executor: (args) => client.callTool(def.name, args),
    })),
  };
}
```

调用方只看到 `Tool[]`，不感知背后是 MCP。

---

## 4. SkillResolver

在 harness 层实现，按 intent 决定激活哪些 skills，组装出 core 需要的参数：

```ts
interface SkillBundle {
  system: string;           // base system + 各 skill systemFragment 拼接
  tools: Tool[];            // 各 skill tools 合并
  executors: Map<string, ToolExecutor>; // name → executor，供 onToolCall 分发
}

class SkillResolver {
  constructor(private skills: Skill[]) {}

  resolve(intent: IntentResult, baseSystem: string): SkillBundle {
    const active = this.skills.filter(s => this.matches(s.trigger, intent));
    
    const fragments = active.flatMap(s => s.systemFragment ? [s.systemFragment] : []);
    const tools: Tool[] = [];
    const executors = new Map<string, ToolExecutor>();

    for (const skill of active) {
      for (const t of skill.tools ?? []) {
        tools.push(t.definition);
        executors.set(t.definition.name, t.executor);
      }
    }

    return {
      system: [baseSystem, ...fragments].join("\n\n"),
      tools,
      executors,
    };
  }

  private matches(trigger: SkillTrigger, intent: IntentResult): boolean {
    switch (trigger.type) {
      case "always":       return true;
      case "domain":       return trigger.domains.includes(intent.domain);
      case "level":        return intent.level >= trigger.minLevel;
      case "needs_tools":  return intent.needs_tools;
      case "explicit":     return false; // 需显式激活
    }
  }
}
```

---

## 5. Harness 调用流程

```
用户输入
  ↓
classifyIntent()          ← core/intent/classifier.ts（已有）
  ↓
skillResolver.resolve()   ← harness 层（新增）
  ↓
streamAgent({
  system: bundle.system,
  tools:  bundle.tools,
  onToolCall: (name, args) => bundle.executors.get(name)?.(args),
})                        ← core/agent/loop.ts（不改）
```

---

## 6. ACP 的位置

ACP（Agent Communication Protocol，跨 agent 委托）只在 harness 内部处理，core 不感知：

- harness 收到 `delegate` 类型的 PlanStep，通过 ACP 派发给子 agent
- 子 agent 的结果作为 tool result 返回给主 agent
- 对 core 来说，这只是一次普通的 tool call

```
PlanStep { type: "delegate" }
  ↓ harness runtime
  ACP dispatch → sub-agent
  ↓ 结果
  tool_result 注入主 agent 消息流
```

---

## 7. 不支持的范围

| 能力 | 位置 | 说明 |
|------|------|------|
| MCP（直接协议层） | harness 包装后对 core 透明 | core 只看 Tool[] |
| ACP | harness 内部 | core 不感知跨 agent 委托 |
| Rules | skill systemFragment | 随 domain 按需注入 system |
| 全局 skill 列表 | harness 初始化时注册 | core 不存储 |

---

## 8. 扩展点

- **显式 skill 激活**：用户输入 `/skill mcp:github` → harness 把该 skill 加入本次 active 列表
- **skill 组合**：skill 可声明 `dependsOn`，resolver 自动拉取依赖 skill
- **skill 热更新**：harness 可在对话中途追加 skill（例如 critique 判断需要额外工具）

---

## 9. 与现有代码的关系

| 现有文件 | 变化 |
|----------|------|
| `core/src/agent/loop.ts` | 不改，`tools` + `system` 接入点已够用 |
| `core/src/intent/classifier.ts` | 不改，`domain` 字段作为 skill 触发条件 |
| `core/src/types/tool.ts` | 不改 |
| `harness/src/runtime/` | 新增 `skill.ts`（Skill 接口）、`skill-resolver.ts` |
| `harness/src/runtime/flow.ts` | 接入 SkillResolver，替换当前硬编码 tools 传入 |
