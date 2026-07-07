import { describe, expect, it, vi } from "vitest";
import { PARTNER_SHORTCUTS } from "@/shortcuts/partner-shortcuts";

describe("PARTNER_SHORTCUTS", () => {
  it("closes the active preview tab in preview scope", () => {
    const preview = {
      activeTabId: "code:file.ts",
      tabs: [{ id: "code:file.ts", title: "file.ts", isDirty: false }],
      closeTab: vi.fn(),
    };

    const handled = PARTNER_SHORTCUTS["mod+w"].run({
      event: {} as KeyboardEvent,
      scope: "preview",
      chat: {} as never,
      preview: preview as never,
    });

    expect(handled).toBe(true);
    expect(preview.closeTab).toHaveBeenCalledWith("code:file.ts");
  });

  it("closes the active center tab in center scope", () => {
    const chat = {
      activeTab: { id: "chat:2", kind: "chat", isAgentRunning: false },
      tabs: [
        { id: "chat:1", kind: "chat" },
        { id: "chat:2", kind: "chat" },
      ],
      closeTab: vi.fn(),
    };

    const handled = PARTNER_SHORTCUTS["mod+w"].run({
      event: {} as KeyboardEvent,
      scope: "center",
      chat: chat as never,
      preview: {} as never,
    });

    expect(handled).toBe(true);
    expect(chat.closeTab).toHaveBeenCalledWith("chat:2");
  });
});
