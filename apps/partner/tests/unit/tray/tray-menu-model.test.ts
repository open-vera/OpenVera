import { describe, expect, it } from "vitest";
import {
  buildTrayMenuModel,
  truncateTrayTitle,
  TRAY_MENU_LABELS_EN,
} from "@/tray/tray-menu-model";

describe("tray-menu-model", () => {
  it("truncates long titles", () => {
    expect(truncateTrayTitle("short")).toBe("short");
    expect(
      truncateTrayTitle("这是一个非常非常非常非常非常非常非常长的会话标题内容用来截断"),
    ).toContain("…");
  });

  it("builds ChatGPT-style sections with running and recent", () => {
    const model = buildTrayMenuModel(
      [
        { id: "r1", title: "正在跑任务", updatedAt: 30, isRunning: true },
        { id: "a", title: "最近 A", updatedAt: 20, isRunning: false },
        { id: "b", title: "最近 B", updatedAt: 10, isRunning: false },
      ],
      { labels: TRAY_MENU_LABELS_EN, recentLimit: 5 },
    );

    expect(model.map((item) => item.type)).toEqual([
      "header",
      "session",
      "separator",
      "header",
      "session",
      "session",
      "separator",
      "action",
      "separator",
      "action",
      "action",
    ]);
    expect(model[0]).toMatchObject({ type: "header", text: "Running" });
    expect(model[1]).toMatchObject({ type: "session", sessionId: "r1" });
    expect(model[3]).toMatchObject({ type: "header", text: "Recent" });
    expect(model.at(-4)).toMatchObject({ type: "action", id: "new-chat" });
    expect(model.at(-2)).toMatchObject({ type: "action", id: "open-partner" });
    expect(model.at(-1)).toMatchObject({ type: "action", id: "quit" });
  });

  it("puts overflow recent sessions into More submenu", () => {
    const sessions = Array.from({ length: 7 }, (_, index) => ({
      id: `s${index}`,
      title: `会话 ${index}`,
      updatedAt: 100 - index,
      isRunning: false,
    }));

    const model = buildTrayMenuModel(sessions, {
      labels: TRAY_MENU_LABELS_EN,
      recentLimit: 5,
    });
    const more = model.find((item) => item.type === "submenu");
    expect(more).toMatchObject({ type: "submenu", text: "More" });
    if (more?.type === "submenu") {
      expect(more.items).toHaveLength(2);
      expect(more.items[0]?.sessionId).toBe("s5");
    }
  });

  it("omits running/recent headers when empty but keeps app actions", () => {
    const model = buildTrayMenuModel([], { labels: TRAY_MENU_LABELS_EN });
    expect(model).toEqual([
      { type: "action", id: "new-chat", text: "New Chat" },
      { type: "separator", id: "sep-before-app" },
      { type: "action", id: "open-partner", text: "Open Partner" },
      { type: "action", id: "quit", text: "Quit Partner" },
    ]);
  });
});
