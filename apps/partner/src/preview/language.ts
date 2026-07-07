import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { vue } from "@codemirror/lang-vue";
import type { LanguageSupport } from "@codemirror/language";

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
  py: "python",
  rs: "rust",
  vue: "vue",
  jsonc: "json",
  json5: "json",
  toml: "plaintext",
  yaml: "plaintext",
  yml: "plaintext",
  spec: "plaintext",
};

export function detectLanguageFromPath(filePath: string): PreviewLanguageId {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MAP[ext] ?? "plaintext";
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
    default:
      return null;
  }
}

export function isLspSupported(id: PreviewLanguageId): boolean {
  return lspLanguageId(id) !== null;
}
