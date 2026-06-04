import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { VeraConfig } from "./types.js";
import { ConfigError } from "../errors.js";
import { createLogger } from "@open-vera/logger";
import { resolveConfigLocation } from "./paths.js";
import { migrateClaudeCodeConfigIfAvailable } from "./claude-code-migration.js";
import { syncExternalResources } from "./resource-sync.js";
export type { ConfigLocation, ConfigScope } from "./paths.js";
export { globalConfigPath, projectConfigPath, resolveConfigLocation } from "./paths.js";

const log = createLogger("config");

/**
 * 加载配置文件。
 * - 指定路径：直接读取
 * - VERA_CONFIG_DIR 环境变量：从该目录找 settings.json（dev 场景）
 * - 未指定：先找当前工作目录 .vera/settings.json，再找全局 ~/.vera/settings.json
 * - 都找不到：返回空配置 {}
 */
export function loadConfig(configPath?: string, cwd = process.cwd()): VeraConfig {
  const startMs = Date.now();
  const { path: filePath } = resolveConfigLocation(configPath, cwd);

  if (!existsSync(filePath)) {
    if (!configPath && !process.env.VERA_CONFIG_DIR) {
      syncExternalResources();
      const migrated = migrateClaudeCodeConfigIfAvailable(filePath);
      if (migrated) {
        log.info("migrated Claude Code settings to Vera config", {
          source: migrated.sourcePath,
          target: migrated.targetPath,
        });
        return migrated.config;
      }
    }
    log.debug("no config file found, returning empty config", { path: filePath });
    return {};
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const config = JSON.parse(raw) as VeraConfig;
    log.debug("config loaded", { path: filePath, duration_ms: Date.now() - startMs });
    return config;
  } catch (err) {
    log.error("failed to parse config", { path: filePath, error: String(err) });
    throw new ConfigError(`Failed to parse config at ${filePath}: ${String(err)}`, { cause: err });
  }
}

export function writeConfig(config: VeraConfig, configPath?: string, cwd = process.cwd()): void {
  const { path: filePath } = resolveConfigLocation(configPath, cwd);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
