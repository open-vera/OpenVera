# 配置与路径

> Vera 的配置加载、路径解析、安装向导、资源同步与 Claude Code 迁移。

---

## 概述

Vera 的配置系统由以下模块组成：

| 模块 | 文件 | 职责 |
|---|---|---|
| `types.ts` | 类型定义 | 完整的 `VeraConfig` schema，包括 providers / models / routing / session / mcp_servers |
| `paths.ts` | 路径解析 | 全局路径、项目路径、配置位置逻辑 |
| `loader.ts` | 配置加载 | 读取、写入和自动迁移协调 |
| `setup.ts` | 安装向导 | 交互式选择 provider / API key / model，首次启动时触发 |
| `providers.ts` | Provider 预设 | Anthropic / OpenAI / Gemini / DeepSeek / Groq 的默认模型列表与适配器 |
| `model-tiers.ts` | 模型层级解析 | default target / classifier / L0-L2 的解析与回退逻辑 |
| `resource-sync.ts` | 外部资源同步 | 从 Claude Code、Codex、OpenClaw、Hermes 符号链接 rules/skills/memories 到 Vera |
| `claude-code-migration.ts` | Claude Code -> Vera 迁移 | 读取 `~/.claude/settings.json` 中的 API Key 与模型配置，自动创建 Vera 配置 |

---

## 配置文件层级

### 查找顺序 (`resolveConfigLocation`)

Vera 按以下优先级顺序搜索 `settings.json`：

| 优先级 | 来源 | 路径 | 作用域 |
|---|---|---|---|
| 1（最高） | 显式指定 | 通过 `--config <path>` 传入 | `explicit` |
| 2 | 环境变量 | `$VERA_CONFIG_DIR/settings.json` | `env` |
| 3 | 项目配置 | `<cwd>/.vera/settings.json` | `project` |
| 4（最低） | 全局配置 | `$VERA_HOME/.vera/settings.json`（默认：`~/.vera/settings.json`） | `global` |

若所有位置都未找到配置文件，`loadConfig` 返回空对象 `{}`，然后触发资源同步和 Claude Code 迁移。

### 环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `VERA_HOME` | Vera 全局目录的父目录 | `$HOME` (`homedir()`) |
| `VERA_CONFIG_DIR` | 指定配置目录（优先级高于项目和全局） | 无 |

路径解析规则 (`paths.ts`)：

```typescript
veraHome()         → $VERA_HOME ?? ~
globalVeraDir()    → $VERA_HOME/.vera
projectVeraDir()   → <cwd>/.vera
globalConfigPath() → $VERA_HOME/.vera/settings.json
projectConfigPath()→ <cwd>/.vera/settings.json
globalDataPath(name)→ $VERA_HOME/.vera/<name>
projectResourcePath(cwd, name) → <cwd>/.vera/<name>
```

### 路径分类

Vera 下的路径分为三类：

| 类别 | 路径 | 内容 |
|---|---|---|
| **配置** | `$VERA_HOME/.vera/settings.json` | 全局配置（providers、models、routing） |
| **配置** | `<cwd>/.vera/settings.json` | 项目配置（覆盖全局配置） |
| **运行时数据** | `$VERA_HOME/.vera/sessions/` | Session 持久化（SQLite / JSONL） |
| **运行时数据** | `$VERA_HOME/.vera/memory/` | Memory 存储（向量 / 全文索引） |
| **运行时数据** | `<cwd>/.vera/worktrees/` | 实验分支的 Git worktree |
| **上下文资源** | `$VERA_HOME/.vera/rules/` | 上下文规则文件（含外部来源的符号链接） |
| **上下文资源** | `$VERA_HOME/.vera/skills/` | Skill 文件（含外部来源的符号链接） |
| **上下文资源** | `$VERA_HOME/.vera/imports/` | 原始导入的外部资源（commands、rules、skills、memories、CLAUDE.md 等） |

---

## settings.json Schema 概述

完整配置结构由 `types.ts` 中的 `VeraConfig` 接口定义：

### providers（LLM 提供商）

```json
{
  "providers": {
    "anthropic": {
      "adapter": "anthropic",
      "api_key": "<your-api-key>",
      "base_url": "https://api.anthropic.com",
      "headers": {}
    }
  }
}
```

每个 provider 配置包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `adapter` | `"anthropic" \| "openai" \| "gemini"` | 使用的适配器协议 |
| `api_key` | `string`（可选） | API Key，也可通过环境变量提供 |
| `base_url` | `string`（可选） | 自定义 API 端点 |
| `headers` | `Record<string, string>`（可选） | 额外的 HTTP 请求头 |

### models（模型实例）

支持两种声明形式：

**数组形式（简洁）**：从默认 provider 推断：

```json
{
  "models": ["claude-sonnet-4-6", "claude-opus-4-6"]
}
// 等价于 { "claude-sonnet-4-6": { "provider": "<default_provider>" }, ... }
```

**对象形式（完整）**：通过别名灵活组合 provider / model / adapter：

```json
{
  "models": {
    "cheap": { "provider": "groq", "model": "llama-3.3-70b-versatile" },
    "smart": { "provider": "anthropic", "model": "claude-opus-4-6" },
    "openai-gpt": { "provider": "openai", "model": "gpt-4.1", "adapter": "openai" }
  }
}
```

每个 model 配置支持：

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | `string` | 从此 provider 继承 adapter / api_key / base_url |
| `model` | `string`（可选） | 发送给 provider 的具体模型 ID；默认为别名本身 |
| `adapter` | `AdapterType`（可选） | 覆盖 provider 的默认适配器协议 |
| `api_key` | `string`（可选） | 覆盖 provider 的 API Key |
| `base_url` | `string`（可选） | 覆盖 provider 的 base_url |
| `headers` | `Record<string, string>`（可选） | 覆盖或补充 provider 的 headers |

### default_provider 和 default_model

```json
{
  "default_provider": "anthropic",
  "default_model": "claude-sonnet-4-6"
}
```

- `default_provider`：当路由和 default_model 都无法解析时使用的 provider
- `default_model`：别名（指向 models 中的条目）或具体的模型 ID（需要 `default_provider` 存在）

### routing（意图路由）

```json
{
  "routing": {
    "enabled": true,
    "classifier": "anthropic-haiku",
    "l0": "anthropic-haiku",
    "l1": "anthropic-sonnet",
    "l2": "anthropic-opus"
  }
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 是否启用意图路由 |
| `classifier` | 用于意图分类的模型（通常为轻量模型） |
| `l0` | 处理简单任务（如打招呼、回显）的模型 |
| `l1` | 处理常规任务的模型（默认层级） |
| `l2` | 处理复杂任务的模型（多步推理、大规模代码生成） |

每个层级值可以是模型别名（字符串）或 `{ provider, model }` 对象。

### session

```json
{
  "session": {
    "ai_title": { "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5" },
    "compact": { "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5" }
  }
}
```

- `ai_title`：使用 AI 自动生成 Session 标题（低成本模型）
- `compact`：启用上下文压缩（当 token 超限时自动压缩对话历史）

### mcp_servers

```json
{
  "mcp_servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/files"],
      "env": {}
    }
  }
}
```

---

## 安装向导 (`runSetupWizard`)

当 `loadConfig` 返回空配置且无可迁移的 Claude Code 配置时，Vera 自动启动交互式安装向导。向导包含三个步骤：

### 步骤一 — 选择 Provider

列出所有支持的 provider（输入数字或名称）：

```
1（默认）. Anthropic (Claude)
2. OpenAI (GPT)
3. Google Gemini
4. DeepSeek
5. Groq
```

### 步骤二 — 输入 API Key

- 首先检查环境变量（如 `ANTHROPIC_API_KEY`）并询问是否直接使用
- 否则进入密码输入模式（终端 raw 模式，输入显示为 `*`）
- 支持 Backspace 编辑、Enter 确认、Ctrl+C 取消

### 步骤三 — 选择默认模型

列出所选 provider 的可用模型，默认选项已预选。

完成后，向导写入配置文件并显示文件路径。用户可随时手动编辑 `.vera/settings.json` 修改设置。

---

## 资源同步（外部资源同步）

启动时（未找到配置文件且无可迁移的 Claude Code 配置），Vera 自动执行 `syncExternalResources()`，将其他 AI 编码工具的资源符号链接到 Vera：

| 外部来源 | 默认路径 | 环境变量覆盖 |
|---|---|---|
| Claude Code | `~/.claude/` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/` | `CODEX_HOME` |
| OpenClaw | `~/.openclaw/` | `OPENCLAW_HOME` |
| Hermes | `~/.hermes/` | `HERMES_HOME` |

同步内容：

| 类别 | 来源 | 目标 |
|---|---|---|
| **context（规则）** | `CLAUDE.md`、`AGENTS.md`、`SOUL.md`、`memory.md`、`rules/*.md` | `~/.vera/rules/<source>-<name>` |
| **skill** | `skills/*/SKILL.md`、`skills/*.md` | `~/.vera/skills/<source>-<name>.md` |
| **memory** | `memories/` 或 `memory/` 目录 | `~/.vera/memory/<source>`（目录符号链接） |
| **raw（导入）** | `commands/`、`rules/`、`skills/`、`memories/`、`CLAUDE.md`、`AGENTS.md`、`SOUL.md` | `~/.vera/imports/<source>/<name>` |

所有资源通过**符号链接**导入。重复运行时，已有的正确链接被跳过（`skipped`），冲突则保留现有链接（`conflict`），可使用 `force: true` 选项强制覆盖。

---

## Claude Code 配置迁移

当 Vera 找不到 `settings.json` 时，自动检测 `~/.claude/settings.json`（或 `$CLAUDE_CONFIG_DIR/settings.json`）并进行迁移：

**迁移的数据：**

- API Key：从 `env.ANTHROPIC_API_KEY`、`env.ANTHROPIC_AUTH_TOKEN`、`settings.anthropic.api_key` 等中提取
- Base URL：从 `env.ANTHROPIC_BASE_URL`、`settings.anthropic.base_url` 等中提取
- 自定义 Headers：从 `env.ANTHROPIC_CUSTOM_HEADERS` 按 `Key: Value` 格式解析

**生成的模型别名：**

| 角色 | 别名 | 上游模型 | 环境变量控制 |
|---|---|---|---|
| haiku | `claude-haiku` | `claude-haiku-4-5-20251001` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| sonnet | `claude-sonnet` | `claude-sonnet-4-6` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| opus | `claude-opus` | `claude-opus-4-6` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |

迁移后的 provider 名称为 `"claude-code"`（与原生 `"anthropic"` 区分），避免与用户后续手动配置的 provider 冲突。

---

## 支持的适配器与 Provider

Vera 支持三种适配器协议：

| 适配器 | 协议 | 兼容的 Provider |
|---|---|---|
| `anthropic` | Anthropic Messages API | Anthropic（原生） |
| `openai` | OpenAI Chat Completions API | OpenAI、DeepSeek、Groq 及兼容 API |
| `gemini` | Google Gemini API | Google Gemini（原生） |

安装向导中内置的 provider 预设：

| Provider | 适配器 | API Key 环境变量 | 默认模型 |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1` |
| Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| DeepSeek | `openai` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Groq | `openai` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |

---

## 模型层级解析 (model-tiers)

`model-tiers.ts` 负责从配置中解析实际的 target / classifier / L0-L2 模型和 provider。核心函数：

| 函数 | 用途 |
|---|---|
| `resolveDefaultProviderName` | 解析默认 provider 名称 |
| `resolveDefaultTarget` | 解析默认的 `{ provider, model }` target（优先 routing.l1，其次 default_model，最后回退到 `anthropic + claude-opus-4-6`） |
| `resolveRoutingConfig` | 填补 routing 配置中缺失的层级（使用 `FALLBACK_ROUTING` 回退） |
| `resolveProviderModelConfig` | 为 target 生成完整的 `ProviderConfig`（合并 provider 级别和 model 级别的 api_key、base_url、headers） |
| `normalizeModels` | 将数组形式的 `models` 转换为对象形式 |

---

## 当前状态

- 配置加载（四层优先级）：已完成
- 交互式安装向导（三步）：已完成
- Provider 预设（5 个 provider）：已完成
- Claude Code 自动迁移：已完成
- 外部资源同步（4 个来源）：已完成
- 模型层级解析（含回退）：已完成
- 尚未实现的功能：
  - Web UI 配置编辑器
  - 配置热重载（无需重启即可应用更改）
  - 配置校验器（schema 校验 + 友好的错误提示）
  - 配置方案（多套配置之间切换）
