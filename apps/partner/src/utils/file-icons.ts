export interface FileIconInfo {
  label: string;
  color: string;
  isDir: boolean;
}

const FILE_TYPE_META: Record<string, { label: string; color: string }> = {
  cjs: { label: "JS", color: "#f7df1e" },
  conf: { label: "*", color: "#e5c07b" },
  css: { label: "#", color: "#61afef" },
  csv: { label: "CSV", color: "#98c379" },
  html: { label: "<>", color: "#e06c75" },
  ini: { label: "*", color: "#e5c07b" },
  js: { label: "JS", color: "#f7df1e" },
  json: { label: "{}", color: "#e5c07b" },
  jsonc: { label: "{}", color: "#e5c07b" },
  jsonl: { label: "JL", color: "#e5c07b" },
  jsx: { label: "JSX", color: "#61afef" },
  lock: { label: "L", color: "#e5c07b" },
  md: { label: "M", color: "#56b6c2" },
  mjs: { label: "JS", color: "#f7df1e" },
  mts: { label: "TS", color: "#61afef" },
  py: { label: "Py", color: "#61afef" },
  rs: { label: "Rs", color: "#d19a66" },
  sh: { label: "$", color: "#c678dd" },
  spec: { label: "SP", color: "#56b6c2" },
  svg: { label: "SVG", color: "#56b6c2" },
  ts: { label: "TS", color: "#61afef" },
  toml: { label: "T", color: "#e5c07b" },
  txt: { label: "TXT", color: "#9aa0a6" },
  tsx: { label: "TSX", color: "#61afef" },
  vue: { label: "V", color: "#98c379" },
  xml: { label: "<>", color: "#e06c75" },
  yaml: { label: "Y", color: "#e5c07b" },
  yml: { label: "Y", color: "#e5c07b" },
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function extension(name: string): string {
  if (!name.includes(".")) return "";
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function fileIconForPath(path: string, isDir = false): FileIconInfo {
  const name = basename(path);
  if (isDir) {
    return {
      label: "",
      color: "#c8a86a",
      isDir: true,
    };
  }

  const ext = extension(name);
  const meta = FILE_TYPE_META[ext] ?? {
    label: ext ? ext.slice(0, 3).toUpperCase() : name.slice(0, 2).toUpperCase(),
    color: "#56b6c2",
  };
  return {
    label: meta.label.slice(0, 3),
    color: meta.color,
    isDir: false,
  };
}
