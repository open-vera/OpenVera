/** True when `dirPath` is a strict ancestor directory of `filePath`. */
export function isAncestorDir(dirPath: string, filePath: string): boolean {
  const dir = normalizePath(dirPath);
  const file = normalizePath(filePath);
  if (!dir || !file || dir === file) return false;
  return file.startsWith(`${dir}/`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
