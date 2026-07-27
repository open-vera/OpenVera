import { pathInfo } from "@/bridge";
import {
  extractImportSpecifierAt,
  importSpecifierCandidates,
} from "./import-path.js";

export async function resolveImportPathAtOffset(options: {
  doc: string;
  offset: number;
  workspaceRoot: string;
  fromFilePath: string;
  pathExists?: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const specifier = extractImportSpecifierAt(options.doc, options.offset);
  if (!specifier) return null;

  const exists =
    options.pathExists ??
    (async (path: string) => {
      try {
        const info = await pathInfo(path);
        return info.isFile;
      } catch {
        return false;
      }
    });

  for (const candidate of importSpecifierCandidates(
    options.workspaceRoot,
    options.fromFilePath,
    specifier,
  )) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}
