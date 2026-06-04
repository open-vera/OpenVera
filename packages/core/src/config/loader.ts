import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { VeraConfig } from "./types.js";
import { ConfigError } from "../errors.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("config");

const CONFIG_FILENAME = "settings.json";

/**
 * 加载配置文件。
 * - 指定路径：直接读取
 * - VERA_CONFIG_DIR 环境变量：从该目录找 settings.json（dev 场景）
 * - 未指定：从当前工作目录找 .vera/settings.json
 * - 找不到：返回空配置 {}
 */
export function loadConfig(configPath?: string): VeraConfig {
  const startMs = Date.now();
  const filePath = resolveConfigPath(configPath);

  if (!existsSync(filePath)) {
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

function resolveConfigPath(configPath?: string): string {
  return configPath
    ? resolve(configPath)
    : process.env.VERA_CONFIG_DIR
    ? resolve(process.env.VERA_CONFIG_DIR, CONFIG_FILENAME)
    : resolve(process.cwd(), ".vera", CONFIG_FILENAME);
}

export function writeConfig(config: VeraConfig, configPath?: string): void {
  const filePath = resolveConfigPath(configPath);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
