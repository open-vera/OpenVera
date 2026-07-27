import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listLspServers,
  resolveServer,
  resolveTypescriptLanguageServerCli,
} from "../../../sidecar/src/lsp/config.js";

describe("sidecar lsp config", () => {
  it("resolves bundled typescript-language-server CLI from package install", () => {
    const cli = resolveTypescriptLanguageServerCli();
    expect(cli).toBeTruthy();
    expect(cli?.endsWith("lib/cli.mjs")).toBe(true);
    expect(existsSync(cli!)).toBe(true);
  });

  it("materializes typescript server via process.execPath + bundled CLI", () => {
    const spec = resolveServer("typescript");
    expect(spec).not.toBeNull();
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args[0]?.endsWith("lib/cli.mjs")).toBe(true);
    expect(spec?.args).toContain("--stdio");
  });

  it("maps javascript/vue/json onto typescript-language-server", () => {
    for (const languageId of ["javascript", "vue", "json"] as const) {
      const spec = resolveServer(languageId);
      expect(spec?.command).toBe(process.execPath);
      expect(spec?.args[0]?.endsWith("lib/cli.mjs")).toBe(true);
    }
  });

  it("keeps python/rust on PATH-based commands", () => {
    expect(resolveServer("python")).toEqual({
      languageId: "python",
      command: "pyright-langserver",
      args: ["--stdio"],
    });
    expect(resolveServer("rust")).toEqual({
      languageId: "rust",
      command: "rust-analyzer",
      args: [],
    });
  });

  it("lists deduped servers for symbol search", () => {
    const servers = listLspServers();
    const languageIds = servers.map((server) => server.languageId);
    expect(languageIds).toContain("typescript");
    expect(languageIds).toContain("json");
    expect(languageIds).toContain("vue");
    expect(languageIds).toContain("python");
    expect(languageIds).toContain("rust");
    expect(new Set(languageIds).size).toBe(languageIds.length);
  });

  it("returns null for unsupported languages", () => {
    expect(resolveServer("go")).toBeNull();
  });
});
