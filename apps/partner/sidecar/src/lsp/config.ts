import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

export interface LspServerSpec {
  languageId: string;
  command: string;
  args: string[];
}

type LspServerKind =
  | "typescript-language-server"
  | "pyright-langserver"
  | "rust-analyzer";

interface LspServerTemplate {
  languageId: string;
  kind: LspServerKind;
}

const LSP_TEMPLATES: Record<string, LspServerTemplate> = {
  typescript: {
    languageId: "typescript",
    kind: "typescript-language-server",
  },
  javascript: {
    languageId: "typescript",
    kind: "typescript-language-server",
  },
  json: {
    languageId: "json",
    kind: "typescript-language-server",
  },
  vue: {
    languageId: "vue",
    kind: "typescript-language-server",
  },
  python: {
    languageId: "python",
    kind: "pyright-langserver",
  },
  rust: {
    languageId: "rust",
    kind: "rust-analyzer",
  },
};

/** Candidate roots that may contain node_modules/typescript-language-server. */
export function lspPackageRoots(moduleUrl = import.meta.url): string[] {
  const here = dirname(fileURLToPath(moduleUrl));
  const roots = [
    process.env.PARTNER_SIDECAR_ROOT,
    here,
    join(here, ".."),
    join(here, "../.."),
    join(here, "../../.."),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(roots)];
}

/**
 * Resolve the bundled typescript-language-server CLI.
 * Prefers Partner-staged node_modules (next to partner-sidecar.mjs), then
 * package resolution from the sidecar install, then null (caller may fall back to PATH).
 */
export function resolveTypescriptLanguageServerCli(
  moduleUrl = import.meta.url
): string | null {
  const candidates: string[] = [];

  for (const root of lspPackageRoots(moduleUrl)) {
    candidates.push(
      join(root, "node_modules", "typescript-language-server", "lib", "cli.mjs")
    );
  }

  try {
    const require = createRequire(moduleUrl);
    const pkgJson = require.resolve("typescript-language-server/package.json");
    candidates.push(join(dirname(pkgJson), "lib", "cli.mjs"));
  } catch {
    // Package may be absent in stripped environments; PATH fallback remains.
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function materializeTypescriptServer(languageId: string): LspServerSpec {
  const cli = resolveTypescriptLanguageServerCli();
  if (cli) {
    return {
      languageId,
      command: process.execPath,
      args: [cli, "--stdio"],
    };
  }
  return {
    languageId,
    command: "typescript-language-server",
    args: ["--stdio"],
  };
}

function materialize(template: LspServerTemplate): LspServerSpec {
  switch (template.kind) {
    case "typescript-language-server":
      return materializeTypescriptServer(template.languageId);
    case "pyright-langserver":
      return {
        languageId: template.languageId,
        command: "pyright-langserver",
        args: ["--stdio"],
      };
    case "rust-analyzer":
      return {
        languageId: template.languageId,
        command: "rust-analyzer",
        args: [],
      };
  }
}

export function resolveServer(languageId: string): LspServerSpec | null {
  const template = LSP_TEMPLATES[languageId];
  if (!template) return null;
  return materialize(template);
}

/** Deduped server specs for workspace symbol search. */
export function listLspServers(): LspServerSpec[] {
  const byLanguage = new Map<string, LspServerSpec>();
  for (const template of Object.values(LSP_TEMPLATES)) {
    byLanguage.set(template.languageId, materialize(template));
  }
  return [...byLanguage.values()];
}

export type ActiveProxy = {
  id: string;
  languageId: string;
  wsUrl: string;
  port: number;
  child: ChildProcess;
  close: () => void;
  startedAt: number;
};
