import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ask = vi.fn();
const message = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => ask(...args),
  message: (...args: unknown[]) => message(...args),
}));

describe("native-dialog", () => {
  beforeEach(() => {
    ask.mockReset();
    message.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to window.confirm / window.alert outside Tauri", async () => {
    const confirm = vi.fn(() => true);
    const alert = vi.fn();
    vi.stubGlobal("window", { confirm, alert });
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("alert", alert);

    const { alertDialog, confirmDialog } = await import("@/utils/native-dialog");

    await expect(confirmDialog("ok?")).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith("ok?");
    expect(ask).not.toHaveBeenCalled();

    await alertDialog("hi");
    expect(alert).toHaveBeenCalledWith("hi");
    expect(message).not.toHaveBeenCalled();
  });

  it("uses Tauri dialog plugin inside Tauri runtime", async () => {
    const confirm = vi.fn(() => true);
    const alert = vi.fn();
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      confirm,
      alert,
    });
    ask.mockResolvedValue(false);
    message.mockResolvedValue(undefined);

    const { alertDialog, confirmDialog } = await import("@/utils/native-dialog");

    await expect(confirmDialog("discard?")).resolves.toBe(false);
    expect(ask).toHaveBeenCalledWith("discard?", {
      title: "Partner",
      kind: "warning",
    });

    await alertDialog("binary", { kind: "warning" });
    expect(message).toHaveBeenCalledWith("binary", {
      title: "Partner",
      kind: "warning",
    });
  });
});
