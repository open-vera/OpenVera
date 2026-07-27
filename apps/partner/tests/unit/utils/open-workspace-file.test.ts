import { describe, expect, it, vi } from "vitest";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

describe("openWorkspaceFile", () => {
  it("opens known text files without prompting", async () => {
    const readFile = vi.fn(async () => "const x = 1;\n");
    const openCodeFile = vi.fn();
    const focusExisting = vi.fn(() => false);
    const confirm = vi.fn(() => false);
    const alert = vi.fn();

    const opened = await openWorkspaceFile("/workspace/app.ts", {
      readFile,
      openCodeFile,
      focusExisting,
      confirm,
      alert,
    });

    expect(opened).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith("/workspace/app.ts");
    expect(openCodeFile).toHaveBeenCalledWith("/workspace/app.ts", "const x = 1;\n");
  });

  it("rejects known binary files with an alert", async () => {
    const readFile = vi.fn(async () => "bin");
    const openCodeFile = vi.fn();
    const focusExisting = vi.fn(() => false);
    const confirm = vi.fn(() => true);
    const alert = vi.fn();

    const opened = await openWorkspaceFile("/workspace/icon.png", {
      readFile,
      openCodeFile,
      focusExisting,
      confirm,
      alert,
    });

    expect(opened).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(String(alert.mock.calls[0]?.[0])).toContain("二进制");
    expect(confirm).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(openCodeFile).not.toHaveBeenCalled();
  });

  it("rejects .DS_Store as binary with an alert", async () => {
    const readFile = vi.fn(async () => "bin");
    const openCodeFile = vi.fn();
    const focusExisting = vi.fn(() => false);
    const confirm = vi.fn(() => true);
    const alert = vi.fn();

    const opened = await openWorkspaceFile("/workspace/.DS_Store", {
      readFile,
      openCodeFile,
      focusExisting,
      confirm,
      alert,
    });

    expect(opened).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(String(alert.mock.calls[0]?.[0])).toContain("二进制");
    expect(confirm).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(openCodeFile).not.toHaveBeenCalled();
  });

  it("focuses an already-open unknown file without prompting again", async () => {
    const readFile = vi.fn(async () => "plist");
    const openCodeFile = vi.fn();
    const focusExisting = vi.fn(() => true);
    const confirm = vi.fn(() => true);
    const alert = vi.fn();

    const opened = await openWorkspaceFile("/workspace/Info.plist", {
      readFile,
      openCodeFile,
      focusExisting,
      confirm,
      alert,
    });

    expect(opened).toBe(true);
    expect(focusExisting).toHaveBeenCalledWith("/workspace/Info.plist");
    expect(confirm).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(openCodeFile).not.toHaveBeenCalled();
  });

  it("asks before opening unknown extensions", async () => {
    const readFile = vi.fn(async () => "not really text");
    const openCodeFile = vi.fn();
    const focusExisting = vi.fn(() => false);
    const confirm = vi.fn(() => true);
    const alert = vi.fn();

    const opened = await openWorkspaceFile("/workspace/weird.foo", {
      readFile,
      openCodeFile,
      focusExisting,
      confirm,
      alert,
    });

    expect(opened).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("是否尝试以文本方式打开"),
    );
    expect(openCodeFile).toHaveBeenCalledWith("/workspace/weird.foo", "not really text");
  });

  it("cancels when user declines unknown-type prompt", async () => {
    const readFile = vi.fn(async () => "x");
    const openCodeFile = vi.fn();
    const focusExisting = vi.fn(() => false);
    const confirm = vi.fn(() => false);
    const alert = vi.fn();

    const opened = await openWorkspaceFile("/workspace/weird.foo", {
      readFile,
      openCodeFile,
      focusExisting,
      confirm,
      alert,
    });

    expect(opened).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    expect(openCodeFile).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("alerts when text decode fails after confirmation", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("stream did not contain valid UTF-8");
    });
    const openCodeFile = vi.fn();
    const focusExisting = vi.fn(() => false);
    const confirm = vi.fn(() => true);
    const alert = vi.fn();

    const opened = await openWorkspaceFile("/workspace/weird.foo", {
      readFile,
      openCodeFile,
      focusExisting,
      confirm,
      alert,
    });

    expect(opened).toBe(false);
    expect(openCodeFile).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledOnce();
    expect(String(alert.mock.calls[0]?.[0])).toContain("无法以文本打开");
    expect(String(alert.mock.calls[0]?.[0])).toContain("UTF-8");
  });
});
