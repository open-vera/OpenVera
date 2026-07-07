import type { ChildProcess } from "node:child_process";

export interface LspServerSpec {
  languageId: string;
  command: string;
  args: string[];
}

export const LSP_SERVERS: Record<string, LspServerSpec> = {
  typescript: {
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
  },
  javascript: {
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
  },
  json: {
    languageId: "json",
    command: "typescript-language-server",
    args: ["--stdio"],
  },
  vue: {
    languageId: "vue",
    command: "typescript-language-server",
    args: ["--stdio"],
  },
  python: {
    languageId: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
  },
  rust: {
    languageId: "rust",
    command: "rust-analyzer",
    args: [],
  },
};

export function resolveServer(languageId: string): LspServerSpec | null {
  return LSP_SERVERS[languageId] ?? null;
}

export type ActiveProxy = {
  id: string;
  languageId: string;
  wsUrl: string;
  port: number;
  child: ChildProcess;
  close: () => void;
};
