// 路径工具 — cwd 边界检查、净化

import { resolve, normalize, sep } from "node:path";

/**
 * 将平台原生路径统一为正斜杠形式再做前缀比较，
 * 避免 Windows 反斜杠导致的边界判断失败。
 */
function toPosix(p: string): string {
  return sep === "\\" ? p.replace(/\\/g, "/") : p;
}

/**
 * 检查 target 是否在 baseDir 内（含相等）。
 * 解析符号链接之前的静态路径检查。
 */
export function isInsideCwd(target: string, baseDir: string): boolean {
  const resolved = toPosix(normalize(resolve(baseDir, target)));
  const base = toPosix(normalize(baseDir)).replace(/\/?$/, "/");
  return resolved === toPosix(normalize(baseDir)) || (resolved + "/").startsWith(base);
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
  const posixResolved = toPosix(normalize(resolved));
  const posixCwd = toPosix(normalize(cwd));
  const base = posixCwd.replace(/\/?$/, "/");
  const inCwd = posixResolved === posixCwd || (posixResolved + "/").startsWith(base);
  const inAllowedPath = allowedPaths.some((allowedPath) => isInsideCwd(normalize(resolved), allowedPath));
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
