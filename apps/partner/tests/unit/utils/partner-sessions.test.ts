import { describe, expect, it } from "vitest";
import type { ChatSnapshot } from "@/stores/chat";
import type { PartnerWindowSnapshot } from "@/utils/partner-sessions";
import {
  normalizePartnerSessions,
  selectPartnerWindowSnapshot,
  upsertPartnerTaskSnapshot,
  upsertPartnerWindowSnapshot,
} from "@/utils/partner-sessions";

function chatSnapshot(activeTabId: string): ChatSnapshot {
  return {
    version: 1,
    activeTabId,
    tabs: [
      {
        id: activeTabId,
        title: "对话",
        kind: "chat",
        messages: [],
        isAgentRunning: false,
        currentTokenCount: 0,
        estimatedCost: 0,
      },
    ],
  };
}

function windowSnapshot(windowId: string): PartnerWindowSnapshot {
  return {
    windowId,
    chat: chatSnapshot(`chat:${windowId}`),
    preview: { version: 1, activeTabId: null, tabs: [] },
    layout: { leftWidth: 240, previewWidth: 640 },
    updatedAt: 1,
  };
}

describe("partner session snapshots", () => {
  it("upserts one window without dropping another window", () => {
    const existing = normalizePartnerSessions(null, windowSnapshot("main"));
    const next = upsertPartnerWindowSnapshot(existing, windowSnapshot("review"));

    expect(Object.keys(next.windows).sort()).toEqual(["main", "review"]);
    expect(next.activeWindowId).toBe("review");
  });

  it("selects the snapshot for the current window", () => {
    const raw = normalizePartnerSessions(null, windowSnapshot("main"));

    const selected = selectPartnerWindowSnapshot(raw, "main");

    expect(selected?.windowId).toBe("main");
    expect(selected?.chat.activeTabId).toBe("chat:main");
  });

  it("migrates a legacy chat snapshot into the current window", () => {
    const legacy = chatSnapshot("legacy");

    const normalized = normalizePartnerSessions(legacy, windowSnapshot("main"));

    expect(normalized.windows.main?.chat.activeTabId).toBe("legacy");
    expect(normalized.activeWindowId).toBe("main");
  });

  it("upserts task history without dropping window snapshots", () => {
    const existing = normalizePartnerSessions(null, windowSnapshot("main"));
    const next = upsertPartnerTaskSnapshot(existing, {
      taskId: "task-1",
      windowId: "main",
      chatTabId: "chat:main",
      title: "检查 CI",
      previewText: "已经检查完成",
      chat: chatSnapshot("chat:main"),
      preview: { version: 1, activeTabId: null, tabs: [] },
      createdAt: 1,
      updatedAt: 2,
    });

    expect(next.windows.main?.windowId).toBe("main");
    expect(next.tasks["task-1"]?.title).toBe("检查 CI");
  });
});
