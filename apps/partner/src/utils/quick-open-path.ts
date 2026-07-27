/** Display path relative to workspace root when possible. */
export function relativeWorkspacePath(root: string, absolutePath: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = absolutePath.replace(/\\/g, "/");
  if (!normalizedRoot) return normalizedPath;
  const prefix = `${normalizedRoot}/`;
  if (normalizedPath === normalizedRoot) return ".";
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }
  return normalizedPath;
}
