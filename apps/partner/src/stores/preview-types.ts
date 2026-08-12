import type { PreviewLanguageId } from "@/preview/language";

export type PreviewTab = {
  id: string;
  title: string;
  kind: "html" | "pdf" | "image" | "media" | "code" | "markdown";
  source: string;
  filePath?: string;
  content?: string;
  savedContent?: string;
  isDirty?: boolean;
  readOnly?: boolean;
  languageId?: PreviewLanguageId;
  /** Source file size for image tabs; the data URL itself is ~33% larger. */
  byteSize?: number;
};

const CODE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "bat",
  "bazel",
  "bzl",
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonl",
  "json5",
  "jsonc",
  "map",
  "css",
  "scss",
  "less",
  "sass",
  "html",
  "htm",
  "xml",
  "svg",
  "md",
  "mdx",
  "txt",
  "log",
  "lock",
  "spec",
  "diff",
  "patch",
  "csv",
  "tsv",
  "env",
  "ini",
  "conf",
  "config",
  "cfg",
  "properties",
  "graphql",
  "gql",
  "py",
  "rs",
  "vue",
  "toml",
  "yaml",
  "yml",
  "sh",
  "zsh",
  "fish",
  "sql",
  "go",
  "java",
  "kt",
  "kts",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "rb",
  "php",
  "swift",
  "scala",
  "gradle",
  "proto",
  "prisma",
  "lua",
  "pl",
  "pm",
  "r",
  "dart",
  "ex",
  "exs",
  "erl",
  "hrl",
  "clj",
  "cljs",
  "edn",
  "fs",
  "fsx",
  "fsi",
  "cs",
  "csproj",
  "vb",
  "sln",
  "cmake",
  "ninja",
  "dockerignore",
  "gitignore",
  "gitattributes",
  "editorconfig",
]);

const BINARY_EXTENSIONS = new Set([
  "a",
  "app",
  "bin",
  "bmp",
  "class",
  "dylib",
  "exe",
  "gif",
  "icns",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "mov",
  "mp3",
  "mp4",
  "o",
  "pdf",
  "png",
  "so",
  "tar",
  "tiff",
  "wasm",
  "webp",
  "zip",
]);

const BINARY_FILENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

const CODE_FILENAMES = new Set([
  "license",
  "licence",
  "copying",
  "notice",
  "readme",
  "changelog",
  "makefile",
  "dockerfile",
  "procfile",
  "gemfile",
  "rakefile",
  "cargo.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "cmakelists.txt",
]);

const CODE_FILENAME_PREFIXES = [
  ".env",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  "dockerfile.",
  "makefile.",
];

/**
 * Raster formats the preview panel can render via a data URL.
 * `svg` is deliberately absent — it stays text so it opens in the editor.
 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "pjpeg",
  "pjp",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "tif",
  "tiff",
]);

export type FilePathKind = "code" | "image" | "binary" | "unknown";

function fileNameFromPath(path: string): string {
  return path.split("/").pop()?.toLowerCase() ?? "";
}

/** Classify a path for preview: text, renderable image, binary, or unknown. */
export function classifyFilePath(path: string): FilePathKind {
  const filename = fileNameFromPath(path);
  if (BINARY_FILENAMES.has(filename)) return "binary";
  if (CODE_FILENAMES.has(filename)) return "code";
  if (CODE_FILENAME_PREFIXES.some((prefix) => filename.startsWith(prefix))) {
    return "code";
  }
  if (!filename.includes(".")) return "code";
  // A leading-dot name with no further dot is a tool config, not an extension:
  // `.prettierignore`, `.npmrc`, `.babelrc`, `.nvmrc`. Splitting on "." would
  // yield "prettierignore" as the extension and land in `unknown`.
  if (filename.startsWith(".") && !filename.slice(1).includes("."))
    return "code";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return "unknown";
}

export function isCodeFilePath(path: string): boolean {
  return classifyFilePath(path) === "code";
}

export function isImageFilePath(path: string): boolean {
  return classifyFilePath(path) === "image";
}

/** True only for files with no preview at all (images are previewable). */
export function isBinaryFilePath(path: string): boolean {
  return classifyFilePath(path) === "binary";
}
