# 安装与配置

## 安装

```bash
npm i @open-vera/openvera@latest -g
```

启动：

```bash
ai
```

`ai`、`vera`、`openvera` 三个命令等价。首次运行自动进入交互式配置向导。

```bash
ai init          # 重新运行配置向导
ai init --force  # 强制重新初始化
```

## 最简配置

```jsonc
// ~/.vera/settings.json
{
  "providers": {
    "my-provider": {
      "adapter": "anthropic",
      "api_key": "sk-ant-...",
      "base_url": "https://your-gateway.example.com"
    }
  },
  "default_model": "claude-sonnet-4-6"
}
```

`base_url` 指向公司 API 网关或自定义端点，不填则使用各 adapter 默认地址。

## 模型路由（可选）

开启后按任务复杂度自动选择最优模型，通常可降低 60%+ 成本：

```jsonc
{
  "providers": { ... },
  "routing": {
    "enabled": true,
    "classifier": "claude-haiku-4-5",
    "l0": "claude-haiku-4-5",
    "l1": "claude-sonnet-4-6",
    "l2": "claude-opus-4-7"
  }
}
```

| 级别 | 场景 | 示例 |
|---|---|---|
| L0 | 闲聊、简单问答 | "TypeScript 是什么？" |
| L1 | 单步任务 | "写一个解析 CSV 的函数" |
| L2 | 多步、深度推理 | "设计一个分布式锁系统" |

---

### Lookup Order (`resolveConfigLocation`)

Vera searches for `settings.json` in the following priority order:

| Priority | Source | Path | Scope |
|---|---|---|---|
| 1 (highest) | Explicit | Path passed via `--config <path>` | `explicit` |
| 2 | Environment variable | `$VERA_CONFIG_DIR/settings.json` | `env` |
| 3 | Project config | `<cwd>/.vera/settings.json` | `project` |
| 4 (lowest) | Global config | `$VERA_HOME/.vera/settings.json` (default: `~/.vera/settings.json`) | `global` |

If no config file is found at any location, `loadConfig` returns an empty object `{}`, then triggers resource sync and Claude Code migration.

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `VERA_HOME` | Parent directory of Vera's global directory | `$HOME` (`homedir()`) |
| `VERA_CONFIG_DIR` | Specify config directory (takes priority over project and global) | none |

Path resolution rules (`paths.ts`):

```typescript
veraHome()         → $VERA_HOME ?? ~
globalVeraDir()    → $VERA_HOME/.vera
projectVeraDir()   → <cwd>/.vera
globalConfigPath() → $VERA_HOME/.vera/settings.json
projectConfigPath()→ <cwd>/.vera/settings.json
globalDataPath(name)→ $VERA_HOME/.vera/<name>
projectResourcePath(cwd, name) → <cwd>/.vera/<name>
```

### Path Categories

Paths under Vera are divided into three categories:

| Category | Path | Content |
|---|---|---|
| **Config** | `$VERA_HOME/.vera/settings.json` | Global config (providers, models, routing) |
| **Config** | `<cwd>/.vera/settings.json` | Project config (overrides global) |
| **Runtime data** | `$VERA_HOME/.vera/sessions/` | Session persistence (SQLite / JSONL) |
| **Runtime data** | `$VERA_HOME/.vera/memory/` | Memory storage (vector / full-text index) |
| **Runtime data** | `<cwd>/.vera/worktrees/` | Git worktrees for experiment branches |
| **Context resources** | `$VERA_HOME/.vera/rules/` | Context rule files (including symlinks from external sources) |
| **Context resources** | `$VERA_HOME/.vera/skills/` | Skill files (including symlinks from external sources) |
| **Context resources** | `$VERA_HOME/.vera/imports/` | Raw imported external resources (commands, rules, skills, memories, CLAUDE.md, etc.) |

---

## settings.json Schema Overview

The complete configuration structure is defined by the `VeraConfig` interface in `types.ts`:

### providers (LLM Providers)

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

Each provider config contains:

| Field | Type | Description |
|---|---|---|
| `adapter` | `"anthropic" \| "openai" \| "gemini"` | Adapter protocol to use |
| `api_key` | `string` (optional) | API key, can also be provided via environment variable |
| `base_url` | `string` (optional) | Custom API endpoint |
| `headers` | `Record<string, string>` (optional) | Additional HTTP request headers |

### models (Model Instances)

Two declaration forms are supported:

**Array form (concise)**: inferred from the default provider:

```json
{
  "models": ["claude-sonnet-4-6", "claude-opus-4-6"]
}
// Equivalent to { "claude-sonnet-4-6": { "provider": "<default_provider>" }, ... }
```

**Object form (full)**: flexibly combine provider / model / adapter by alias:

```json
{
  "models": {
    "cheap": { "provider": "groq", "model": "llama-3.3-70b-versatile" },
    "smart": { "provider": "anthropic", "model": "claude-opus-4-6" },
    "openai-gpt": { "provider": "openai", "model": "gpt-4.1", "adapter": "openai" }
  }
}
```

Each model config supports:

| Field | Type | Description |
|---|---|---|
| `provider` | `string` | Inherit adapter / api_key / base_url from this provider |
| `model` | `string` (optional) | Specific model ID sent to the provider; defaults to the alias itself |
| `adapter` | `AdapterType` (optional) | Override the provider's default adapter protocol |
| `api_key` | `string` (optional) | Override the provider's API key |
| `base_url` | `string` (optional) | Override the provider's base_url |
| `headers` | `Record<string, string>` (optional) | Override or supplement the provider's headers |

### default_provider and default_model

```json
{
  "default_provider": "anthropic",
  "default_model": "claude-sonnet-4-6"
}
```

- `default_provider`: Provider used when neither routing nor default_model resolves
- `default_model`: Alias (points to an entry in models) or a concrete model ID (requires `default_provider` to exist)

### routing (Intent Routing)

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

| Field | Description |
|---|---|
| `enabled` | Whether intent routing is enabled |
| `classifier` | Model used for intent classification (typically a lightweight model) |
| `l0` | Model used for trivial tasks (e.g., hello, echo) |
| `l1` | Model used for normal tasks (the default tier) |
| `l2` | Model used for complex tasks (multi-step reasoning, large code generation) |

Each tier value can be a model alias (string) or a `{ provider, model }` object.

### session

```json
{
  "session": {
    "ai_title": { "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5" },
    "compact": { "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5" }
  }
}
```

- `ai_title`: Auto-generate session titles using AI (low-cost model)
- `compact`: Enable context compression (auto-compress conversation history when token limits are exceeded)

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

## Setup Wizard (`runSetupWizard`)

When `loadConfig` returns an empty config and no Claude Code config is available to migrate, Vera automatically launches the interactive setup wizard. The wizard has three steps:

### Step 1 — Select Provider

Lists all supported providers (enter the number or name):

```
1 (default). Anthropic (Claude)
2. OpenAI (GPT)
3. Google Gemini
4. DeepSeek
5. Groq
```

### Step 2 — Enter API Key

- First checks environment variables (e.g., `ANTHROPIC_API_KEY`) and asks whether to use them directly
- Otherwise enters secret input mode (terminal raw mode, input shown as `*`)
- Supports Backspace editing, Enter to confirm, Ctrl+C to cancel

### Step 3 — Select Default Model

Lists available models for the chosen provider, with the default pre-selected.

After completion, the wizard writes the config and shows the file path. Users can manually edit `.vera/settings.json` at any time to modify settings.

---

## Resource Sync (External Resource Sync)

On startup (when no config file is found and no Claude Code config is migratable), Vera automatically executes `syncExternalResources()`, which symlinks resources from other AI coding tools into Vera:

| External Source | Default Path | Environment Variable Override |
|---|---|---|
| Claude Code | `~/.claude/` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/` | `CODEX_HOME` |
| OpenClaw | `~/.openclaw/` | `OPENCLAW_HOME` |
| Hermes | `~/.hermes/` | `HERMES_HOME` |

Synced content:

| Category | Source | Target |
|---|---|---|
| **context (rules)** | `CLAUDE.md`, `AGENTS.md`, `SOUL.md`, `memory.md`, `rules/*.md` | `~/.vera/rules/<source>-<name>` |
| **skill** | `skills/*/SKILL.md`, `skills/*.md` | `~/.vera/skills/<source>-<name>.md` |
| **memory** | `memories/` or `memory/` directory | `~/.vera/memory/<source>` (directory symlink) |
| **raw (imports)** | `commands/`, `rules/`, `skills/`, `memories/`, `CLAUDE.md`, `AGENTS.md`, `SOUL.md` | `~/.vera/imports/<source>/<name>` |

All resources are imported via **symbolic links**. On repeated runs, existing correct links are skipped (`skipped`), conflicts keep the existing link (`conflict`), and the `force: true` option can be used to overwrite.

---

## Claude Code Configuration Migration

When Vera cannot find `settings.json`, it automatically detects `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) and migrates it:

**Migrated data:**

- API key: extracted from `env.ANTHROPIC_API_KEY`, `env.ANTHROPIC_AUTH_TOKEN`, `settings.anthropic.api_key`, etc.
- Base URL: extracted from `env.ANTHROPIC_BASE_URL`, `settings.anthropic.base_url`, etc.
- Custom headers: parsed from `env.ANTHROPIC_CUSTOM_HEADERS` in `Key: Value` format

**Generated model aliases:**

| Role | Alias | Upstream Model | Environment Variable Control |
|---|---|---|---|
| haiku | `claude-haiku` | `claude-haiku-4-5-20251001` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| sonnet | `claude-sonnet` | `claude-sonnet-4-6` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| opus | `claude-opus` | `claude-opus-4-6` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |

The migrated provider name is `"claude-code"` (distinct from the native `"anthropic"`) to avoid conflicts with any provider the user might manually configure later.

---

## Supported Adapters and Providers

Vera supports three adapter protocols:

| Adapter | Protocol | Compatible Providers |
|---|---|---|
| `anthropic` | Anthropic Messages API | Anthropic (native) |
| `openai` | OpenAI Chat Completions API | OpenAI, DeepSeek, Groq, and compatible APIs |
| `gemini` | Google Gemini API | Google Gemini (native) |

Built-in provider presets in the setup wizard:

| Provider | Adapter | API Key Env Var | Default Model |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1` |
| Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| DeepSeek | `openai` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Groq | `openai` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |

---

## Model Tier Resolution (model-tiers)

`model-tiers.ts` handles resolving actual target / classifier / L0-L2 models and providers from the config. Core functions:

| Function | Purpose |
|---|---|
| `resolveDefaultProviderName` | Resolve the default provider name |
| `resolveDefaultTarget` | Resolve the default `{ provider, model }` target (prefers routing.l1, then default_model, falls back to `anthropic + claude-opus-4-6`) |
| `resolveRoutingConfig` | Fill in missing tiers in routing config (using `FALLBACK_ROUTING` fallbacks) |
| `resolveProviderModelConfig` | Generate a complete `ProviderConfig` for a target (merges provider-level and model-level api_key, base_url, headers) |
| `normalizeModels` | Convert array-form `models` to object form |

---

## Current Status

- Config loading (four-layer priority): complete
- Interactive setup wizard (three-step): complete
- Provider presets (5 providers): complete
- Claude Code auto-migration: complete
- External resource sync (4 sources): complete
- Model tier resolution (with fallbacks): complete
- Features not yet implemented:
  - Web UI config editor
  - Config hot-reload (apply changes without restart)
  - Config validator (schema validation + user-friendly error messages)
  - Config profiles (switching between multiple config sets)
