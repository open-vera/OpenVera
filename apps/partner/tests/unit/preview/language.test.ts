import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  detectLanguageFromPath,
  detectLanguageFromShebang,
  isLspSupported,
  languageSupportFor,
  lspLanguageId,
} from "@/preview/language";
import { classifyFilePath, isCodeFilePath } from "@/stores/preview";

describe("preview/language", () => {
  it("detects typescript from extension", () => {
    expect(detectLanguageFromPath("/src/App.vue")).toBe("vue");
    expect(detectLanguageFromPath("/src/main.ts")).toBe("typescript");
    expect(detectLanguageFromPath("README.md")).toBe("markdown");
    expect(detectLanguageFromPath("/app/index.html")).toBe("html");
    expect(detectLanguageFromPath("/assets/logo.svg")).toBe("svg");
    expect(detectLanguageFromPath("/notes/readme.txt")).toBe("plaintext");
    expect(detectLanguageFromPath("/logs/2026-07-07.jsonl")).toBe("jsonl");
  });

  it("detects shell from extension and git-hook filenames", () => {
    expect(detectLanguageFromPath("/scripts/setup.sh")).toBe("shell");
    expect(detectLanguageFromPath("/scripts/run.bash")).toBe("shell");
    expect(
      detectLanguageFromPath(
        "/Users/yang.zhou/workspace/open-vera/.hooks/pre-commit"
      )
    ).toBe("shell");
    expect(detectLanguageFromPath("/repo/.git/hooks/pre-push")).toBe("shell");
  });

  it("uses basename extension when path directories contain dots", () => {
    expect(
      detectLanguageFromPath("/Users/yang.zhou/workspace/app/main.ts")
    ).toBe("typescript");
    expect(detectLanguageFromPath("/Users/yang.zhou/workspace/Makefile")).toBe(
      "plaintext"
    );
  });

  it("falls back to shebang when filename is ambiguous", () => {
    expect(detectLanguageFromShebang("#!/usr/bin/env bash\nset -e\n")).toBe(
      "shell"
    );
    expect(detectLanguageFromShebang("#!/bin/sh\necho hi\n")).toBe("shell");
    expect(
      detectLanguage("bin/custom-tool", "#!/usr/bin/env python3\nprint(1)\n")
    ).toBe("python");
    expect(detectLanguage("bin/custom-tool", "plain text\n")).toBe("plaintext");
  });

  it("provides shell LanguageSupport", () => {
    expect(languageSupportFor("shell")).not.toBeNull();
    expect(isLspSupported("shell")).toBe(false);
  });

  it("detects and highlights config markup languages", () => {
    expect(detectLanguageFromPath("/repo/node_modules/.modules.yaml")).toBe(
      "yaml"
    );
    expect(detectLanguageFromPath("/.github/workflows/ci.yml")).toBe("yaml");
    expect(detectLanguageFromPath("/src-tauri/Cargo.toml")).toBe("toml");
    expect(detectLanguageFromPath("/etc/app.ini")).toBe("ini");
    expect(detectLanguageFromPath("/etc/app.conf")).toBe("ini");
    expect(languageSupportFor("yaml")).not.toBeNull();
    expect(languageSupportFor("toml")).not.toBeNull();
    expect(languageSupportFor("ini")).not.toBeNull();
    expect(languageSupportFor("svg")).not.toBeNull();
    expect(isLspSupported("yaml")).toBe(false);
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
    expect(
      isCodeFilePath("/workspace/node_modules/cross-env/src/bin/cross-env")
    ).toBe(true);
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
    expect(isCodeFilePath("/workspace/partner-runs/2026-07-07.jsonl")).toBe(
      true
    );
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

  it("classifies .DS_Store as binary and unknown extensions as unknown", () => {
    expect(classifyFilePath("/workspace/.DS_Store")).toBe("binary");
    expect(classifyFilePath("/workspace/Thumbs.db")).toBe("binary");
    expect(classifyFilePath("/workspace/weird.foo")).toBe("unknown");
    expect(classifyFilePath("/workspace/archive.zip")).toBe("binary");
    expect(classifyFilePath("/workspace/app.ts")).toBe("code");
  });

  it("classifies renderable rasters as image, and svg as code", () => {
    expect(classifyFilePath("/workspace/icon.png")).toBe("image");
    expect(classifyFilePath("/workspace/Hero.JPG")).toBe("image");
    expect(classifyFilePath("/workspace/anim.gif")).toBe("image");
    expect(classifyFilePath("/workspace/shot.webp")).toBe("image");
    expect(classifyFilePath("/workspace/photo.jfif")).toBe("image");
    expect(classifyFilePath("/workspace/icon.svg")).toBe("code");
  });

  it("treats leading-dot tool configs as text, not unknown extensions", () => {
    // The name after the dot is not an extension; these used to prompt
    // "not a known text type" on every open.
    expect(classifyFilePath("/workspace/.prettierignore")).toBe("code");
    expect(classifyFilePath("/workspace/.prettierrc")).toBe("code");
    expect(classifyFilePath("/workspace/.npmrc")).toBe("code");
    expect(classifyFilePath("/workspace/.nvmrc")).toBe("code");
    expect(classifyFilePath("/workspace/.babelrc")).toBe("code");
    expect(classifyFilePath("/workspace/.eslintignore")).toBe("code");
  });

  it("still resolves dotfiles that do carry an extension by that extension", () => {
    expect(classifyFilePath("/workspace/.prettierrc.json")).toBe("code");
    expect(classifyFilePath("/workspace/.eslintrc.yml")).toBe("code");
    expect(classifyFilePath("/workspace/.hidden.png")).toBe("image");
  });

  it("keeps known binary dotfiles binary", () => {
    expect(classifyFilePath("/workspace/.ds_store")).toBe("binary");
  });
});
