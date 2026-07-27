import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import {
  buildSessionSearchSources,
  filterSessionHits,
  recentSessionHits,
} from "@/utils/session-search";

function msg(id: string, content: string): Message {
  return {
    id,
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

describe("session-search", () => {
  const current = {
    windowId: "main",
    chat: {
      version: 1,
      activeTabId: "chat:1",
      tabs: [
        {
          id: "chat:1",
          kind: "chat" as const,
          title: "修复登录",
          messages: [msg("m1", "帮我看看登录失败")],
          isAgentRunning: false,
          currentTokenCount: 0,
          estimatedCost: 0,
          runUsage: null,
        },
      ],
    },
    preview: { version: 1, tabs: [], activeTabId: null },
  };

  it("builds sources from current window", () => {
    const sources = buildSessionSearchSources(null, current);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.title).toBe("修复登录");
  });

  it("returns recent hits when query empty", () => {
    const sources = buildSessionSearchSources(null, current);
    const hits = recentSessionHits(sources, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.excerpt).toContain("登录失败");
  });

  it("matches title and message content", () => {
    const sources = buildSessionSearchSources(null, current);
    expect(filterSessionHits(sources, "登录").length).toBeGreaterThan(0);
    expect(filterSessionHits(sources, "失败")[0]?.message?.id).toBe("m1");
    expect(filterSessionHits(sources, "不存在的词")).toHaveLength(0);
  });
});
