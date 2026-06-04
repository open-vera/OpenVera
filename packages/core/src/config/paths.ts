import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

export const VERA_DIRNAME = ".vera";
export const CONFIG_FILENAME = "settings.json";

export type ConfigScope = "explicit" | "env" | "project" | "global";

export interface ConfigLocation {
  path: string;
  scope: ConfigScope;
  exists: boolean;
}

export function veraHome(): string {
  return process.env.VERA_HOME ?? homedir();
}

export function globalVeraDir(): string {
  return join(veraHome(), VERA_DIRNAME);
}

export function projectVeraDir(cwd = process.cwd()): string {
  return resolve(cwd, VERA_DIRNAME);
}

export function globalConfigPath(): string {
  return join(globalVeraDir(), CONFIG_FILENAME);
}

export function projectConfigPath(cwd = process.cwd()): string {
  return join(projectVeraDir(cwd), CONFIG_FILENAME);
}

export function globalDataPath(name: string): string {
  return join(globalVeraDir(), name);
}

export function projectResourcePath(cwd: string, name: string): string {
  return join(projectVeraDir(cwd), name);
}

export function resolveConfigLocation(configPath?: string, cwd = process.cwd()): ConfigLocation {
  if (configPath) {
    const path = resolve(configPath);
    return { path, scope: "explicit", exists: existsSync(path) };
  }

  if (process.env.VERA_CONFIG_DIR) {
    const path = resolve(process.env.VERA_CONFIG_DIR, CONFIG_FILENAME);
    return { path, scope: "env", exists: existsSync(path) };
  }

  const projectPath = projectConfigPath(cwd);
  if (existsSync(projectPath)) return { path: projectPath, scope: "project", exists: true };

  const globalPath = globalConfigPath();
  if (existsSync(globalPath)) return { path: globalPath, scope: "global", exists: true };

  return { path: globalPath, scope: "global", exists: false };
}
