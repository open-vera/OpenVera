import { describe, expect, it } from "vitest";
import {
  applyExternalEditorResult,
  createExternalEditorRequest,
  resolveExternalEditorCommand,
} from "../src/repl/ui/state/externalEditor.js";
import {
  runExternalEditor,
  runExternalEditorRuntime,
} from "../src/repl/ui/controller/externalEditorRuntime.js";

describe("externalEditor", () => {
  it("creates editor requests from composer state", () => {
    expect(createExternalEditorRequest("hello", 2)).toEqual({
      initialValue: "hello",
      cursor: 2,
    });
  });

  it("normalizes editor result cursor", () => {
    expect(applyExternalEditorResult({ value: "hello" })).toEqual({ value: "hello", cursor: 5 });
    expect(applyExternalEditorResult({ value: "hello", cursor: 99 })).toEqual({ value: "hello", cursor: 5 });
    expect(applyExternalEditorResult({ value: "hello", cursor: -1 })).toEqual({ value: "hello", cursor: 0 });
  });

  it("resolves editor commands from VISUAL or EDITOR", () => {
    expect(resolveExternalEditorCommand({ VISUAL: "code --wait", EDITOR: "vim" })).toEqual({
      command: "code",
      args: ["--wait"],
    });
    expect(resolveExternalEditorCommand({ EDITOR: "vim" })).toEqual({ command: "vim", args: [] });
    expect(resolveExternalEditorCommand({})).toBeNull();
  });

  it("runs editor roundtrip through injected filesystem and spawn dependencies", async () => {
    const writes: Record<string, string> = {};
    const result = await runExternalEditor(
      { initialValue: "draft", cursor: 2 },
      {
        env: { EDITOR: "test-editor --wait" },
        createTempDir: () => "/tmp/vera-editor-test",
        writeFile: (path, content) => { writes[path] = content; },
        readFile: (path) => `${writes[path]}\nupdated`,
        cleanup: (path) => { expect(path).toBe("/tmp/vera-editor-test"); },
        spawnEditor: async (command, args) => {
          expect(command).toBe("test-editor");
          expect(args).toEqual(["--wait", "/tmp/vera-editor-test/prompt.md"]);
          return 0;
        },
      },
    );

    expect(result).toEqual({ value: "draft\nupdated", cursor: "draft\nupdated".length });
  });

  it("returns null when no editor is configured or editor exits non-zero", async () => {
    await expect(runExternalEditor({ initialValue: "draft", cursor: 0 }, { env: {} })).resolves.toBeNull();
    await expect(runExternalEditor(
      { initialValue: "draft", cursor: 0 },
      {
        env: { EDITOR: "false" },
        createTempDir: () => "/tmp/vera-editor-test",
        writeFile: () => {},
        readFile: () => "unused",
        cleanup: () => {},
        spawnEditor: async () => 1,
      },
    )).resolves.toBeNull();
  });

  it("returns structured runtime failure reasons", async () => {
    await expect(runExternalEditorRuntime({ initialValue: "draft", cursor: 0 }, { env: {} })).resolves.toEqual({
      status: "not-configured",
    });
    await expect(runExternalEditorRuntime(
      { initialValue: "draft", cursor: 0 },
      {
        env: { EDITOR: "false" },
        createTempDir: () => "/tmp/vera-editor-test",
        writeFile: () => {},
        readFile: () => "unused",
        cleanup: () => {},
        spawnEditor: async () => 2,
      },
    )).resolves.toEqual({
      status: "failed",
      exitCode: 2,
    });
  });
});
