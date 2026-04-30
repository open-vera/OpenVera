import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  applyExternalEditorResult,
  resolveExternalEditorCommand,
  type ExternalEditorRequest,
  type ExternalEditorResult,
} from "../state/externalEditor.js";

export interface ExternalEditorRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  createTempDir?: () => string;
  writeFile?: (path: string, content: string) => void;
  readFile?: (path: string) => string;
  cleanup?: (path: string) => void;
  spawnEditor?: (command: string, args: string[]) => Promise<number | null>;
}

export type ExternalEditorRuntimeResult =
  | { status: "ok"; result: ExternalEditorResult }
  | { status: "not-configured" }
  | { status: "failed"; exitCode: number | null };

export async function runExternalEditor(
  request: ExternalEditorRequest,
  options: ExternalEditorRuntimeOptions = {},
): Promise<ExternalEditorResult | null> {
  const result = await runExternalEditorRuntime(request, options);
  return result.status === "ok" ? result.result : null;
}

export async function runExternalEditorRuntime(
  request: ExternalEditorRequest,
  options: ExternalEditorRuntimeOptions = {},
): Promise<ExternalEditorRuntimeResult> {
  const editor = resolveExternalEditorCommand(options.env);
  if (!editor) return { status: "not-configured" };

  const tempDir = options.createTempDir?.() ?? mkdtempSync(join(tmpdir(), "vera-editor-"));
  const filePath = join(tempDir, "prompt.md");
  const writeFile = options.writeFile ?? ((path, content) => writeFileSync(path, content, "utf8"));
  const readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
  const cleanup = options.cleanup ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const spawnEditor = options.spawnEditor ?? spawnEditorProcess;

  try {
    writeFile(filePath, request.initialValue);
    const exitCode = await spawnEditor(editor.command, [...editor.args, filePath]);
    if (exitCode !== 0) return { status: "failed", exitCode };
    return { status: "ok", result: applyExternalEditorResult({ value: readFile(filePath) }) };
  } finally {
    cleanup(tempDir);
  }
}

function spawnEditorProcess(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}
