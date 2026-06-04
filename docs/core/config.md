# Config & Paths（配置与路径体系）

> Vera 的配置加载、路径解析、初始化向导、资源同步与 Claude Code 迁移机制。

---

## 概述

Vera 的配置体系由以下模块组成：

| 模块 | 文件 | 职责 |
|---|---|---|
| `types.ts` | 类型定义 | `VeraConfig` 完整 schema，含 providers / models / routing / session / mcp_servers |
| `paths.ts` | 路径解析 | 全局路径、项目路径、配置定位逻辑 |
| `loader.ts` | 配置加载 | 读取、写入、自动迁移协调 |
| `setup.ts` | 初始化向导 | 交互式选择 provider / API key / model，首次启动时触发 |
| `providers.ts` | 提供商预设 | Anthropic / OpenAI / Gemini / DeepSeek / Groq 的默认模型列表和适配器 |
| `model-tiers.ts` | 模型分层解析 | 默认 target / classifier / L0-L2 的解析和 fallback 逻辑 |
| `resource-sync.ts` | 外部资源同步 | 将 Claude Code、Codex、OpenClaw、Hermes 的 rules/skills/memories 符号链接到 Vera |
| `claude-code-migration.ts` | Claude Code → Vera 迁移 | 从 `~/.claude/settings.json` 读取 API key 和模型配置，自动创建 Vera 配置 |

---

## 配置文件层级

### 查找顺序（`resolveConfigLocation`）

Vera 按以下优先级查找配置文件 `settings.json`：

| 优先级 | 来源 | 路径 | Scope |
|---|---|---|---|
| 1（最高） | 显式指定 | `--config <path>` 传入的路径 | `explicit` |
| 2 | 环境变量 | `$VERA_CONFIG_DIR/settings.json` | `env` |
| 3 | 项目配置 | `<cwd>/.vera/settings.json` | `project` |
| 4（最低） | 全局配置 | `$VERA_HOME/.vera/settings.json`（默认 `~/.vera/settings.json`） | `global` |

如果所有位置都找不到配置文件，`loadConfig` 返回空对象 `{}`，然后触发资源同步和 Claude Code 迁移。

### 环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `VERA_HOME` | Vera 全局目录的父目录 | `$HOME`（`homedir()`） |
| `VERA_CONFIG_DIR` | 指定配置目录（优先级高于 project 和 global） | 无 |

路径解析规则（`paths.ts`）：

```typescript
veraHome()         → $VERA_HOME ?? ~
globalVeraDir()    → $VERA_HOME/.vera
projectVeraDir()   → <cwd>/.vera
globalConfigPath() → $VERA_HOME/.vera/settings.json
projectConfigPath()→ <cwd>/.vera/settings.json
globalDataPath(name)→ $VERA_HOME/.vera/<name>
projectResourcePath(cwd, name) → <cwd>/.vera/<name>
```

### 路径分组

Vera 下的路径按用途分为三类：

| 类别 | 路径 | 内容 |
|---|---|---|
| **配置** | `$VERA_HOME/.vera/settings.json` | 全局配置（providers、models、routing） |
| **配置** | `<cwd>/.vera/settings.json` | 项目配置（覆盖全局） |
| **运行时数据** | `$VERA_HOME/.vera/sessions/` | 会话持久化（SQLite / JSONL） |
| **运行时数据** | `$VERA_HOME/.vera/memory/` | 记忆存储（向量 / 全文索引） |
| **运行时数据** | `<cwd>/.vera/worktrees/` | 实验分支的 Git worktree |
| **上下文资源** | `$VERA_HOME/.vera/rules/` | 上下文规则文件（含符号链接的外部来源） |
| **上下文资源** | `$VERA_HOME/.vera/skills/` | 技能文件（含符号链接的外部来源） |
| **上下文资源** | `$VERA_HOME/.vera/imports/` | 原始导入的外部资源（commands、rules、skills、memories、CLAUDE.md 等） |

---

## settings.json Schema 概述

完整的配置结构定义在 `types.ts` 中的 `VeraConfig` 接口：

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
| `api_key` | `string`（可选） | API 密钥，也可通过环境变量提供 |
| `base_url` | `string`（可选） | 自定义 API 端点 |
| `headers` | `Record<string, string>`（可选） | 附加 HTTP 请求头 |

### models（模型实例）

支持两种声明形式：

**数组形式（简洁）**：按默认 provider 推断：

```json
{
  "models": ["claude-sonnet-4-6", "claude-opus-4-6"]
}
// 等价于 { "claude-sonnet-4-6": { "provider": "<default_provider>" }, ... }
```

**对象形式（完整）**：按 alias 灵活组合 provider / model / adapter：

```json
{
  "models": {
    "cheap": { "provider": "groq", "model": "llama-3.3-70b-versatile" },
    "smart": { "provider": "anthropic", "model": "claude-opus-4-6" },
    "openai-gpt": { "provider": "openai", "model": "gpt-4.1", "adapter": "openai" }
  }
}
```

每个 model config 支持：

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | `string` | 继承此 provider 的 adapter / api_key / base_url |
| `model` | `string`（可选） | 发送给 provider 的具体 model ID，默认使用 alias 本身 |
| `adapter` | `AdapterType`（可选） | 覆盖 provider 默认的 adapter 协议 |
| `api_key` | `string`（可选） | 覆盖 provider 的 API key |
| `base_url` | `string`（可选） | 覆盖 provider 的 base_url |
| `headers` | `Record<string, string>`（可选） | 覆盖或补充 provider 的 headers |

### default_provider 和 default_model

```json
{
  "default_provider": "anthropic",
  "default_model": "claude-sonnet-4-6"
}
```

- `default_provider`：未通过 routing 或 default_model 解析时，使用此 provider
- `default_model`：alias（指向 models 中的一条）或具体的 model ID（需要 `default_provider` 存在）

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
| `classifier` | 执行意图分类的模型（通常用轻量模型） |
| `l0` | 极简单任务（如 hello、echo）使用的模型 |
| `l1` | 普通任务使用的模型（默认层级） |
| `l2` | 复杂任务（多步推理、大量代码生成）使用的模型 |

每个层级的值可以是 model alias（字符串）或 `{ provider, model }` 对象。

### session（会话配置）

```json
{
  "session": {
    "ai_title": { "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5" },
    "compact": { "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5" }
  }
}
```

- `ai_title`：用 AI 自动生成会话标题（低成本模型）
- `compact`：启用上下文压缩（超出 token 限制时自动压缩历史消息）

### mcp_servers（MCP 服务）

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

## 初始化向导（`runSetupWizard`）

当 `loadConfig` 返回空配置且无 Claude Code 配置可迁移时，Vera 自动启动交互式 setup wizard。向导分三步：

### Step 1 — 选择 Provider

列出所有支持的提供商（可输入序号或名称）：

```
1 (default). Anthropic (Claude)
2. OpenAI (GPT)
3. Google Gemini
4. DeepSeek
5. Groq
```

### Step 2 — 输入 API Key

- 优先检测环境变量（如 `ANTHROPIC_API_KEY`），询问是否直接使用
- 否则进入 secret 输入模式（终端 raw mode，输入显示为 `*`）
- 支持 Backspace 编辑、Enter 确认、Ctrl+C 取消

### Step 3 — 选择默认模型

列出所选 provider 的可用模型，展示默认选项。

向导完成后自动写入配置并提示路径。用户可随时手动编辑 `.vera/settings.json` 修改设置。

---

## 资源同步（External Resource Sync）

Vera 启动时（找不到配置文件且无可迁移的 Claude Code 配置时）自动执行 `syncExternalResources()`，将其他 AI 编码工具的资源符号链接到 Vera：

| 外部来源 | 默认路径 | 环境变量覆盖 |
|---|---|---|
| Claude Code | `~/.claude/` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/` | `CODEX_HOME` |
| OpenClaw | `~/.openclaw/` | `OPENCLAW_HOME` |
| Hermes | `~/.hermes/` | `HERMES_HOME` |

同步的内容：

| 类别 | 来源 | 目标 |
|---|---|---|
| **context（规则）** | `CLAUDE.md`、`AGENTS.md`、`SOUL.md`、`memory.md`、`rules/*.md` | `~/.vera/rules/<source>-<name>` |
| **skill（技能）** | `skills/*/SKILL.md`、`skills/*.md` | `~/.vera/skills/<source>-<name>.md` |
| **memory（记忆）** | `memories/` 或 `memory/` 目录 | `~/.vera/memory/<source>`（目录符号链接） |
| **raw（原始导入）** | `commands/`、`rules/`、`skills/`、`memories/`、`CLAUDE.md`、`AGENTS.md`、`SOUL.md` | `~/.vera/imports/<source>/<name>` |

所有资源以**符号链接**方式导入。重复执行时，已存在的正确链接跳过（`skipped`），冲突时保留现有（`conflict`），可通过 `force: true` 选项覆盖。

---

## Claude Code 配置迁移

当 Vera 找不到 `settings.json` 时，自动检测 `~/.claude/settings.json`（或 `$CLAUDE_CONFIG_DIR/settings.json`）并迁移：

**迁移的数据：**

- API key：从 `env.ANTHROPIC_API_KEY`、`env.ANTHROPIC_AUTH_TOKEN`、`settings.anthropic.api_key` 等处提取
- Base URL：从 `env.ANTHROPIC_BASE_URL`、`settings.anthropic.base_url` 等处提取
- 自定义 headers：从 `env.ANTHROPIC_CUSTOM_HEADERS` 解析 `Key: Value` 格式

**生成的模型 alias：**

| 角色 | Alias | Upstream Model | 环境变量控制 |
|---|---|---|---|
| haiku | `claude-haiku` | `claude-haiku-4-5-20251001` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| sonnet | `claude-sonnet` | `claude-sonnet-4-6` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| opus | `claude-opus` | `claude-opus-4-6` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |

迁移后的 provider 名称为 `"claude-code"`（與原始的 `"anthropic"` 区分），避免与用户后续手动配置的 provider 冲突。

---

## 支持的适配器与提供商

Vera 支持三种 adapter 协议：

| Adapter | 协议 | 适配的提供商 |
|---|---|---|
| `anthropic` | Anthropic Messages API | Anthropic（原生） |
| `openai` | OpenAI Chat Completions API | OpenAI、DeepSeek、Groq 等兼容 API |
| `gemini` | Google Gemini API | Google Gemini（原生） |

初始化向导中内置的 provider presets：

| Provider | Adapter | API Key 环境变量 | 默认模型 |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1` |
| Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| DeepSeek | `openai` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Groq | `openai` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |

---

## 模型分层解析（model-tiers）

`model-tiers.ts` 负责从配置中解析实际的 target / classifier / L0-L2 模型和 provider。核心函数：

| 函数 | 作用 |
|---|---|
| `resolveDefaultProviderName` | 解析默认 provider 名称 |
| `resolveDefaultTarget` | 解析默认的 `{ provider, model }` target（优先 routing.l1，其次 default_model，最后回退到 `anthropic + claude-opus-4-6`） |
| `resolveRoutingConfig` | 补全 routing 配置中的缺失层级（使用 `FALLBACK_ROUTING` fallback） |
| `resolveProviderModelConfig` | 为目标 target 生成完整的 `ProviderConfig`（合并 provider 层和 model 层的 api_key、base_url、headers） |
| `normalizeModels` | 将数组形式的 `models` 转为对象形式 |

---

## 当前状态

- 配置加载（含四层优先级）：已完成
- 交互式 setup wizard（三步向导）：已完成
- Provider presets（5 个）：已完成
- Claude Code 自动迁移：已完成
- 外部资源同步（4 个来源）：已完成
- 模型分层解析（含 fallback）：已完成
- 尚未实现的功能：
  - Web UI 形式的配置编辑器
  - 配置热重载（不重启即可生效）
  - 配置验证器（schema 校验 + 友好错误提示）
  - 配置 profile（多套配置切换）
