import { describe, expect, it } from "vitest";
import {
  detectLanguageFromPath,
  isLspSupported,
  lspLanguageId,
} from "@/preview/language";
import { isCodeFilePath } from "@/stores/preview";

describe("preview/language", () => {
  it("detects typescript from extension", () => {
    expect(detectLanguageFromPath("/src/App.vue")).toBe("vue");
    expect(detectLanguageFromPath("/src/main.ts")).toBe("typescript");
    expect(detectLanguageFromPath("README.md")).toBe("markdown");
    expect(detectLanguageFromPath("/logs/2026-07-07.jsonl")).toBe("jsonl");
  });

  it("marks supported LSP languages", () => {
    expect(isLspSupported("typescript")).toBe(true);
    expect(isLspSupported("jsonl")).toBe(false);
    expect(isLspSupported("plaintext")).toBe(false);
    expect(lspLanguageId("typescript")).toBe("typescript");
  });

  it("allows common extensionless text files", () => {
    expect(isCodeFilePath("/workspace/LICENSE")).toBe(true);
    expect(isCodeFilePath("/workspace/Makefile")).toBe(true);
    expect(isCodeFilePath("/workspace/node_modules/.bin/tsc")).toBe(true);
    expect(isCodeFilePath("/workspace/node_modules/cross-env/src/bin/cross-env")).toBe(true);
  });

  it("allows previewable module and markup variants", () => {
    expect(isCodeFilePath("/workspace/index.cjs")).toBe(true);
    expect(isCodeFilePath("/workspace/index.mjs")).toBe(true);
    expect(isCodeFilePath("/workspace/index.cts")).toBe(true);
    expect(isCodeFilePath("/workspace/index.mts")).toBe(true);
    expect(isCodeFilePath("/workspace/page.mdx")).toBe(true);
    expect(isCodeFilePath("/workspace/styles.less")).toBe(true);
    expect(isCodeFilePath("/workspace/index.htm")).toBe(true);
  });

  it("allows common text, config, lock and data files", () => {
    expect(isCodeFilePath("/workspace/Cargo.lock")).toBe(true);
    expect(isCodeFilePath("/workspace/partner-runs/2026-07-07.jsonl")).toBe(true);
    expect(isCodeFilePath("/workspace/app.log")).toBe(true);
    expect(isCodeFilePath("/workspace/notes.txt")).toBe(true);
    expect(isCodeFilePath("/workspace/schema.graphql")).toBe(true);
    expect(isCodeFilePath("/workspace/query.gql")).toBe(true);
    expect(isCodeFilePath("/workspace/config.ini")).toBe(true);
    expect(isCodeFilePath("/workspace/app.conf")).toBe(true);
    expect(isCodeFilePath("/workspace/app.properties")).toBe(true);
    expect(isCodeFilePath("/workspace/data.csv")).toBe(true);
    expect(isCodeFilePath("/workspace/data.tsv")).toBe(true);
    expect(isCodeFilePath("/workspace/change.patch")).toBe(true);
    expect(isCodeFilePath("/workspace/change.diff")).toBe(true);
    expect(isCodeFilePath("/workspace/icon.svg")).toBe(true);
    expect(isCodeFilePath("/workspace/layout.xml")).toBe(true);
    expect(isCodeFilePath("/workspace/verlabel.spec")).toBe(true);
  });

  it("allows common script and native source variants", () => {
    expect(isCodeFilePath("/workspace/script.bash")).toBe(true);
    expect(isCodeFilePath("/workspace/script.zsh")).toBe(true);
    expect(isCodeFilePath("/workspace/script.fish")).toBe(true);
    expect(isCodeFilePath("/workspace/main.cc")).toBe(true);
    expect(isCodeFilePath("/workspace/main.cxx")).toBe(true);
    expect(isCodeFilePath("/workspace/lib.hpp")).toBe(true);
    expect(isCodeFilePath("/workspace/discoverable.rs")).toBe(true);
    expect(isCodeFilePath("/workspace/Dialog.tsx")).toBe(true);
    expect(isCodeFilePath("/workspace/app.rb")).toBe(true);
    expect(isCodeFilePath("/workspace/index.php")).toBe(true);
  });

  it("allows common extensionless or suffixed project files", () => {
    expect(isCodeFilePath("/workspace/Dockerfile")).toBe(true);
    expect(isCodeFilePath("/workspace/Dockerfile.dev")).toBe(true);
    expect(isCodeFilePath("/workspace/Makefile")).toBe(true);
    expect(isCodeFilePath("/workspace/Makefile.local")).toBe(true);
    expect(isCodeFilePath("/workspace/Procfile")).toBe(true);
    expect(isCodeFilePath("/workspace/Gemfile")).toBe(true);
  });

  it("rejects obvious binary assets", () => {
    expect(isCodeFilePath("/workspace/app-icon.png")).toBe(false);
    expect(isCodeFilePath("/workspace/archive.zip")).toBe(false);
    expect(isCodeFilePath("/workspace/video.mp4")).toBe(false);
  });
});
