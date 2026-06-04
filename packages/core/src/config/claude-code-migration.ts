import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelConfig, ProviderConfig, VeraConfig } from "./types.js";
import { globalConfigPath } from "./paths.js";

type ClaudeRole = "haiku" | "sonnet" | "opus";

interface ClaudeCodeSettings {
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeCodeMigrationResult {
  config: VeraConfig;
  sourcePath: string;
  targetPath: string;
}

const ROLE_DEFAULTS: Record<ClaudeRole, { alias: string; model: string }> = {
  haiku: { alias: "claude-haiku", model: "claude-haiku-4-5-20251001" },
  sonnet: { alias: "claude-sonnet", model: "claude-sonnet-4-6" },
  opus: { alias: "claude-opus", model: "claude-opus-4-6" },
};

const ROLE_ENV_PREFIX: Record<ClaudeRole, string> = {
  haiku: "ANTHROPIC_DEFAULT_HAIKU",
  sonnet: "ANTHROPIC_DEFAULT_SONNET",
  opus: "ANTHROPIC_DEFAULT_OPUS",
};

export function claudeCodeSettingsPath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, "settings.json")
    : join(homedir(), ".claude", "settings.json");
}

export function migrateClaudeCodeConfigIfAvailable(targetPath = globalConfigPath()): ClaudeCodeMigrationResult | undefined {
  const sourcePath = claudeCodeSettingsPath();
  if (!existsSync(sourcePath)) return undefined;

  const settings = readClaudeCodeSettings(sourcePath);
  if (!settings) return undefined;

  const config = buildVeraConfigFromClaudeCodeSettings(settings);
  if (!config) return undefined;

  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  return { config, sourcePath, targetPath };
}

export function buildVeraConfigFromClaudeCodeSettings(settings: ClaudeCodeSettings): VeraConfig | undefined {
  const env = readStringRecord(settings.env);
  const apiKey = firstString(
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    readNestedString(settings, ["anthropic", "api_key"]),
    readNestedString(settings, ["anthropic", "apiKey"]),
    readNestedString(settings, ["anthropic", "authToken"]),
  );
  if (!apiKey) return undefined;

  const providerName = "claude-code";
  const provider: ProviderConfig = {
    adapter: "anthropic",
    api_key: apiKey,
    ...optionalStringField("base_url", firstString(
      env.ANTHROPIC_BASE_URL,
      env.ANTHROPIC_API_URL,
      readNestedString(settings, ["anthropic", "base_url"]),
      readNestedString(settings, ["anthropic", "baseUrl"]),
    )),
    ...optionalHeaders(parseHeaders(env.ANTHROPIC_CUSTOM_HEADERS)),
  };

  const aliases = buildModelAliases(env, providerName);
  const models = Object.fromEntries(
    Object.values(aliases).map(({ alias, model }) => [alias, { provider: providerName, model } satisfies ModelConfig]),
  );

  return {
    providers: { [providerName]: provider },
    default_provider: providerName,
    models,
    session: {
      ai_title: { enabled: true, provider: providerName, model: aliases.haiku.model },
      compact: { enabled: true, provider: providerName, model: aliases.haiku.model },
    },
    routing: {
      enabled: true,
      classifier: aliases.haiku.alias,
      l0: aliases.haiku.alias,
      l1: aliases.sonnet.alias,
      l2: aliases.opus.alias,
    },
  };
}

function readClaudeCodeSettings(sourcePath: string): ClaudeCodeSettings | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed as ClaudeCodeSettings : undefined;
  } catch {
    return undefined;
  }
}

function buildModelAliases(
  env: Record<string, string>,
  provider: string,
): Record<ClaudeRole, { alias: string; model: string; config: ModelConfig }> {
  const used = new Set<string>();
  const result = {} as Record<ClaudeRole, { alias: string; model: string; config: ModelConfig }>;

  for (const role of ["haiku", "sonnet", "opus"] as const) {
    const prefix = ROLE_ENV_PREFIX[role];
    const model = firstString(env[`${prefix}_MODEL`], ROLE_DEFAULTS[role].model)!;
    const requestedAlias = firstString(env[`${prefix}_MODEL_NAME`], ROLE_DEFAULTS[role].alias)!;
    const alias = uniqueAlias(requestedAlias, role, used);
    result[role] = {
      alias,
      model,
      config: { provider, model },
    };
  }

  return result;
}

function uniqueAlias(alias: string, role: ClaudeRole, used: Set<string>): string {
  if (!used.has(alias)) {
    used.add(alias);
    return alias;
  }
  const roleAlias = `${alias}-${role}`;
  if (!used.has(roleAlias)) {
    used.add(roleAlias);
    return roleAlias;
  }
  let index = 2;
  while (used.has(`${roleAlias}-${index}`)) index += 1;
  const next = `${roleAlias}-${index}`;
  used.add(next);
  return next;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function optionalStringField(key: "base_url", value: string | undefined): Partial<ProviderConfig> {
  return value ? { [key]: value } : {};
}

function optionalHeaders(headers: Record<string, string> | undefined): Partial<ProviderConfig> {
  return headers && Object.keys(headers).length > 0 ? { headers } : {};
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
