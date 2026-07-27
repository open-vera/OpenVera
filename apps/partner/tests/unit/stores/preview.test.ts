import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { usePreviewStore } from "@/stores/preview";

describe("usePreviewStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("tracks dirty code file content", () => {
    const preview = usePreviewStore();
    preview.openCodeFile("/workspace/app.ts", "const value = 1;\n");

    preview.updateCodeFileContent("/workspace/app.ts", "const value = 2;\n");

    expect(preview.tabs[0]?.content).toBe("const value = 2;\n");
    expect(preview.tabs[0]?.isDirty).toBe(true);
  });

  it("keeps dirty content when reopening the same file", () => {
    const preview = usePreviewStore();
    preview.openCodeFile("/workspace/app.ts", "const value = 1;\n");
    preview.updateCodeFileContent("/workspace/app.ts", "const value = 2;\n");

    preview.openCodeFile("/workspace/app.ts", "const value = 1;\n");

    expect(preview.tabs[0]?.content).toBe("const value = 2;\n");
    expect(preview.tabs[0]?.isDirty).toBe(true);
  });

  it("clears dirty state after save", () => {
    const preview = usePreviewStore();
    preview.openCodeFile("/workspace/app.ts", "const value = 1;\n");
    preview.updateCodeFileContent("/workspace/app.ts", "const value = 2;\n");

    preview.markCodeFileSaved("/workspace/app.ts", "const value = 2;\n");

    expect(preview.tabs[0]?.savedContent).toBe("const value = 2;\n");
    expect(preview.tabs[0]?.isDirty).toBe(false);
  });

  it("refreshes clean files from disk without marking them dirty", () => {
    const preview = usePreviewStore();
    preview.openCodeFile("/workspace/run.jsonl", "old\n");

    preview.refreshCleanCodeFile("/workspace/run.jsonl", "new\n");

    expect(preview.tabs[0]?.content).toBe("new\n");
    expect(preview.tabs[0]?.savedContent).toBe("new\n");
    expect(preview.tabs[0]?.isDirty).toBe(false);
  });

  it("opens git diffs as read-only code tabs", () => {
    const preview = usePreviewStore();

    preview.openDiffFile("src/App.vue", "diff --git a/src/App.vue b/src/App.vue\n");

    expect(preview.activeTabId).toBe("diff:src/App.vue");
    expect(preview.tabs[0]).toMatchObject({
      title: "App.vue.diff",
      kind: "code",
      source: "git-diff:src/App.vue",
      filePath: "src/App.vue.diff",
      readOnly: true,
      isDirty: false,
    });
  });

  it("does not overwrite dirty files during disk refresh", () => {
    const preview = usePreviewStore();
    preview.openCodeFile("/workspace/app.ts", "old\n");
    preview.updateCodeFileContent("/workspace/app.ts", "local edit\n");

    preview.refreshCleanCodeFile("/workspace/app.ts", "disk edit\n");

    expect(preview.tabs[0]?.content).toBe("local edit\n");
    expect(preview.tabs[0]?.savedContent).toBe("old\n");
    expect(preview.tabs[0]?.isDirty).toBe(true);
  });

  it("exports and restores preview snapshots", () => {
    const preview = usePreviewStore();
    preview.openCodeFile("/workspace/app.ts", "const value = 1;\n");

    const snapshot = preview.exportSnapshot();
    preview.reset();
    const restored = preview.restoreSnapshot(snapshot);

    expect(restored).toBe(true);
    expect(preview.activeTabId).toBe("code:/workspace/app.ts");
    expect(preview.tabs[0]?.content).toBe("const value = 1;\n");
  });

  describe("moveTab", () => {
    function openThree() {
      const preview = usePreviewStore();
      preview.openCodeFile("/a.ts", "a");
      preview.openCodeFile("/b.ts", "b");
      preview.openCodeFile("/c.ts", "c");
      return preview;
    }

    it("reorders tabs to the drop position", () => {
      const preview = openThree();

      expect(preview.moveTab("code:/c.ts", 0)).toBe(true);
      expect(preview.tabs.map((tab) => tab.id)).toEqual([
        "code:/c.ts",
        "code:/a.ts",
        "code:/b.ts",
      ]);
    });

    it("keeps the active tab selected across a reorder", () => {
      const preview = openThree();
      preview.activeTabId = "code:/a.ts";

      preview.moveTab("code:/a.ts", 3);

      expect(preview.activeTabId).toBe("code:/a.ts");
      expect(preview.tabs.at(-1)?.id).toBe("code:/a.ts");
    });

    it("reports a no-op drop", () => {
      const preview = openThree();

      expect(preview.moveTab("code:/b.ts", 1)).toBe(false);
      expect(preview.moveTab("code:/missing.ts", 0)).toBe(false);
      expect(preview.tabs.map((tab) => tab.id)).toEqual([
        "code:/a.ts",
        "code:/b.ts",
        "code:/c.ts",
      ]);
    });
  });
});
