import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { VeraConfig } from "./types.js";
import { ConfigError } from "../errors.js";

const CONFIG_FILENAME = "settings.json";

/**
 * 加载配置文件。
 * - 指定路径：直接读取
 * - VERA_CONFIG_DIR 环境变量：从该目录找 settings.json（dev 场景）
 * - 未指定：从当前工作目录找 .vera/settings.json
 * - 找不到：返回空配置 {}
 */
export function loadConfig(configPath?: string): VeraConfig {
  const filePath = configPath
    ? resolve(configPath)
    : process.env.VERA_CONFIG_DIR
    ? resolve(process.env.VERA_CONFIG_DIR, CONFIG_FILENAME)
    : resolve(process.cwd(), ".vera", CONFIG_FILENAME);

  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as VeraConfig;
  } catch (err) {
    throw new ConfigError(`Failed to parse config at ${filePath}: ${String(err)}`, { cause: err });
  }
}
