import { normalizeFsPath } from "./file-uri.js";

/** Extract a quoted import/require specifier under the given document offset. */
export function extractImportSpecifierAt(doc: string, offset: number): string | null {
  if (offset < 0 || offset > doc.length) return null;

  const lineStart = doc.lastIndexOf("\n", offset - 1) + 1;
  const nextBreak = doc.indexOf("\n", offset);
  const lineEnd = nextBreak === -1 ? doc.length : nextBreak;
  const line = doc.slice(lineStart, lineEnd);
  const local = offset - lineStart;

  const pattern = /['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (local >= start && local <= end) {
      return match[1] ?? null;
    }
  }
  return null;
}

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  );
}

function resolveRelativePath(fromDir: string, specifier: string): string {
  const parts = [...fromDir.split("/").filter(Boolean)];
  for (const segment of specifier.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** Candidate filesystem paths for an import specifier (best-effort, no package exports). */
export function importSpecifierCandidates(
  workspaceRoot: string,
  fromFilePath: string,
  specifier: string,
): string[] {
  const root = normalizeFsPath(workspaceRoot).replace(/\/$/, "");
  const fromDir = normalizeFsPath(fromFilePath).replace(/\/[^/]*$/, "") || root;
  const candidates: string[] = [];

  if (isRelativeSpecifier(specifier)) {
    const base = specifier.startsWith("/")
      ? normalizeFsPath(`${root}${specifier}`)
      : resolveRelativePath(fromDir, specifier);
    pushModuleCandidates(candidates, base);
    return [...new Set(candidates)];
  }

  // bare package: prefer workspace node_modules
  const pkgRoot = `${root}/node_modules/${specifier}`;
  pushModuleCandidates(candidates, pkgRoot);
  candidates.push(`${pkgRoot}/package.json`);
  return [...new Set(candidates)];
}

function pushModuleCandidates(out: string[], base: string) {
  out.push(base);
  if (!/\.[a-zA-Z0-9]+$/.test(base)) {
    out.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}.json`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.mjs`,
      `${base}/package.json`,
    );
  }
}
