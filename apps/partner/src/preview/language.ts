import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { vue } from "@codemirror/lang-vue";
import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

export type PreviewLanguageId =
  | "typescript"
  | "javascript"
  | "json"
  | "jsonl"
  | "css"
  | "html"
  | "markdown"
  | "python"
  | "rust"
  | "vue"
  | "shell"
  | "yaml"
  | "toml"
  | "ini"
  | "plaintext";

const EXTENSION_MAP: Record<string, PreviewLanguageId> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "jsonl",
  css: "css",
  scss: "css",
  less: "css",
  sass: "css",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  md: "markdown",
  mdx: "markdown",
  txt: "plaintext",
  text: "plaintext",
  log: "plaintext",
  csv: "plaintext",
  tsv: "plaintext",
  conf: "ini",
  cfg: "ini",
  ini: "ini",
  properties: "ini",
  env: "ini",
  py: "python",
  rs: "rust",
  vue: "vue",
  jsonc: "json",
  json5: "json",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  spec: "plaintext",
};

/** Extensionless / dotted names that should highlight as shell (git hooks, etc.). */
const SHELL_FILENAMES = new Set([
  "pre-commit",
  "post-commit",
  "pre-push",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "post-rewrite",
  "commit-msg",
  "prepare-commit-msg",
  "applypatch-msg",
  "pre-applypatch",
  "pre-receive",
  "update",
  "post-receive",
  "post-update",
]);

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? filePath;
}

function extensionFromFileName(fileName: string): string {
  // Dotfiles like `.gitignore` have no language extension.
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

export function detectLanguageFromShebang(content: string): PreviewLanguageId | null {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith("#!")) return null;
  const lower = firstLine.toLowerCase();
  if (
    /\b(bash|zsh|sh|fish|dash|ksh)\b/.test(lower) ||
    lower.includes("/bin/sh") ||
    lower.includes("/bin/bash")
  ) {
    return "shell";
  }
  if (/\bpython[0-9.]*\b/.test(lower)) return "python";
  if (/\bnode\b/.test(lower)) return "javascript";
  return null;
}

export function detectLanguageFromPath(filePath: string): PreviewLanguageId {
  const fileName = fileNameFromPath(filePath);
  const lowerName = fileName.toLowerCase();
  if (SHELL_FILENAMES.has(lowerName)) return "shell";

  const ext = extensionFromFileName(fileName);
  if (ext) return EXTENSION_MAP[ext] ?? "plaintext";
  return "plaintext";
}

/** Prefer path/filename, then shebang when the path alone is plaintext. */
export function detectLanguage(
  filePath: string,
  content?: string,
): PreviewLanguageId {
  const fromPath = detectLanguageFromPath(filePath);
  if (fromPath !== "plaintext") return fromPath;
  if (content) {
    return detectLanguageFromShebang(content) ?? "plaintext";
  }
  return "plaintext";
}

export function languageSupportFor(id: PreviewLanguageId): LanguageSupport | null {
  switch (id) {
    case "typescript":
      return javascript({ typescript: true });
    case "javascript":
      return javascript();
    case "json":
      return json();
    case "jsonl":
      return json();
    case "css":
      return css();
    case "html":
      return html();
    case "markdown":
      return markdown();
    case "python":
      return python();
    case "rust":
      return rust();
    case "vue":
      return vue();
    case "shell":
      return new LanguageSupport(StreamLanguage.define(shell));
    case "yaml":
      return new LanguageSupport(StreamLanguage.define(yaml));
    case "toml":
      return new LanguageSupport(StreamLanguage.define(toml));
    case "ini":
      return new LanguageSupport(StreamLanguage.define(properties));
    default:
      return null;
  }
}

export function lspLanguageId(id: PreviewLanguageId): string | null {
  switch (id) {
    case "typescript":
      return "typescript";
    case "javascript":
      return "javascript";
    case "json":
      return "json";
    case "jsonl":
      return null;
    case "css":
      return "css";
    case "html":
      return "html";
    case "markdown":
      return "markdown";
    case "python":
      return "python";
    case "rust":
      return "rust";
    case "vue":
      return "vue";
    case "shell":
      return null;
    default:
      return null;
  }
}

export function isLspSupported(id: PreviewLanguageId): boolean {
  return lspLanguageId(id) !== null;
}
