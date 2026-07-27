/** Convert an absolute filesystem path to an LSP file URI. */
export function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${withLeadingSlash}`;
}

/** Convert a file:// URI to an absolute filesystem path, or null if unsupported. */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;

  let rest = uri.slice("file:".length);
  // file:///path or file://localhost/path or file:/path
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    if (rest.toLowerCase().startsWith("localhost/")) {
      rest = rest.slice("localhost".length);
    } else if (/^[A-Za-z]:/.test(rest)) {
      // file://C:/... (unusual) — keep as-is
    } else if (!rest.startsWith("/")) {
      // file://host/path — unsupported for local open
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      rest = rest.slice(slash);
    }
  }

  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }

  // file:///C:/Users/... → C:/Users/...
  if (/^\/[A-Za-z]:\//.test(rest)) {
    return rest.slice(1).replace(/\//g, "\\");
  }

  return rest;
}

export function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, "/");
}
