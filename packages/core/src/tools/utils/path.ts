// 路径工具 — cwd 边界检查、净化

import { resolve, normalize } from "node:path";

/**
 * 检查 target 是否在 baseDir 内（含相等）。
 * 解析符号链接之前的静态路径检查。
 */
export function isInsideCwd(target: string, baseDir: string): boolean {
  const resolved = resolve(baseDir, target);
  const base = normalize(baseDir).replace(/\/?$/, "/");
  return resolved === normalize(baseDir) || (normalize(resolved) + "/").startsWith(base);
}

/**
 * 解析路径，确保在 cwd 内，否则返回 null。
 */
export function safePath(
  target: string,
  cwd: string,
  allowedPaths: string[] = []
): { resolved: string } | { error: string } {
  const resolved = resolve(cwd, target);
  const base = normalize(cwd).replace(/\/?$/, "/");
  const normalResolved = normalize(resolved);
  const inCwd = normalResolved === normalize(cwd) || (normalResolved + "/").startsWith(base);
  const inAllowedPath = allowedPaths.some((allowedPath) => isInsideCwd(normalResolved, allowedPath));
  if (!inCwd && !inAllowedPath) {
    return {
      error: `Path is outside allowed workdir.\n  Allowed: ${cwd}\n  Got:     ${resolved}`,
    };
  }
  return { resolved };
}

/**
 * 净化 CWD 路径用于存储目录名（与 session/store.ts 对齐）。
 */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}
