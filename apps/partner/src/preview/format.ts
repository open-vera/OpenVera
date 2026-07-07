import * as prettier from "prettier/standalone";
import * as prettierPluginBabel from "prettier/plugins/babel";
import * as prettierPluginEstree from "prettier/plugins/estree";
import * as prettierPluginHtml from "prettier/plugins/html";
import * as prettierPluginMarkdown from "prettier/plugins/markdown";
import * as prettierPluginPostcss from "prettier/plugins/postcss";
import * as prettierPluginTypescript from "prettier/plugins/typescript";
import type { Plugin } from "prettier";
import type { PreviewLanguageId } from "./language.js";

const PRETTIER_PLUGINS: Plugin[] = [
  prettierPluginBabel,
  prettierPluginEstree,
  prettierPluginHtml,
  prettierPluginMarkdown,
  prettierPluginPostcss,
  prettierPluginTypescript,
];

const PARSER_BY_LANGUAGE: Partial<Record<PreviewLanguageId, string>> = {
  typescript: "typescript",
  javascript: "babel",
  json: "json",
  css: "css",
  html: "html",
  markdown: "markdown",
  vue: "vue",
};

export class PreviewFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewFormatError";
  }
}

export function canFormatLanguage(languageId: PreviewLanguageId): boolean {
  return languageId === "jsonl" || PARSER_BY_LANGUAGE[languageId] !== undefined;
}

function extensionForPath(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() ?? "";
}

function prettierParserFor(filePath: string, languageId: PreviewLanguageId): string | null {
  const extension = extensionForPath(filePath);
  if (extension === "json5") return "json5";
  if (extension === "jsonc") return "jsonc";
  return PARSER_BY_LANGUAGE[languageId] ?? null;
}

async function formatWithPrettier(
  content: string,
  parser: string,
  printWidth?: number,
): Promise<string> {
  return prettier.format(content, {
    parser,
    plugins: PRETTIER_PLUGINS,
    printWidth,
  });
}

async function formatJsonLine(line: string, lineNumber: number): Promise<string> {
  try {
    const formatted = await formatWithPrettier(line, "json", 100_000);
    return formatted.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PreviewFormatError(`第 ${lineNumber} 行不是有效 JSON：${message}`);
  }
}

async function formatJsonLines(content: string): Promise<string> {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (hasTrailingNewline) {
    lines.pop();
  }

  const formattedLines = await Promise.all(
    lines.map((line, index) => {
      if (line.trim() === "") return Promise.resolve(line);
      return formatJsonLine(line, index + 1);
    }),
  );

  return `${formattedLines.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
}

export async function formatPreviewDocument(
  filePath: string,
  languageId: PreviewLanguageId,
  content: string,
): Promise<string> {
  if (languageId === "jsonl") {
    return formatJsonLines(content);
  }

  const parser = prettierParserFor(filePath, languageId);
  if (!parser) {
    throw new PreviewFormatError("当前文件类型暂不支持格式化");
  }

  try {
    return await formatWithPrettier(content, parser);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PreviewFormatError(message);
  }
}
