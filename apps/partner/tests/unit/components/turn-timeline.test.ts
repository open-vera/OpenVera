// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import MessageBubble from "@/components/chat/MessageBubble.vue";
import ToolProgressPanel from "@/components/chat/ToolProgressPanel.vue";
import TurnTimeline from "@/components/chat/TurnTimeline.vue";
import type { Message } from "@/types";
import {
  buildChatDisplayItems,
  buildChatTimelineEntries,
  type ChatTurnEntry,
} from "@/utils/chat-timeline";

const BASE = 1_700_000_000_000;

function buildTurn(
  options: { streaming?: boolean; endedAt?: number } = {}
): ChatTurnEntry {
  const messages: Message[] = [
    { id: "u1", role: "user", content: "装一下 playwright", timestamp: BASE },
    {
      id: "t1",
      role: "tool",
      content: "bash",
      timestamp: BASE + 1,
      turnId: "turn-1",
      toolCalls: [
        { id: "c1", name: "bash", input: { cmd: "pnpm add -D playwright" } },
      ],
      toolResults: [{ id: "c1", output: "added 1 package" }],
    },
    {
      id: "a1",
      role: "assistant",
      content: "先装依赖。",
      timestamp: BASE + 2,
      turnId: "turn-1",
    },
    {
      id: "t2",
      role: "tool",
      content: "bash",
      timestamp: BASE + 3,
      turnId: "turn-1",
      toolCalls: [
        { id: "c2", name: "bash", input: { cmd: "npx playwright install" } },
      ],
    },
    {
      id: "a2",
      role: "assistant",
      content: "浏览器装好了。",
      timestamp: BASE + 4,
      turnId: "turn-1",
      isStreaming: options.streaming,
      endedAt: options.endedAt,
    },
  ];
  const entries = buildChatTimelineEntries(buildChatDisplayItems(messages));
  const turn = entries.find((entry) => entry.type === "turn");
  if (!turn || turn.type !== "turn") throw new Error("no turn entry");
  return turn;
}

function mountTurn(
  turn: ChatTurnEntry,
  running: boolean,
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  }
) {
  return mount(TurnTimeline, {
    props: { turn, running, usage, locale: "zh-CN" },
    global: { stubs: { MarkdownRenderer: true } },
  });
}

/** Assistant text renders through the async markdown worker, so read the props. */
function bubbleTexts(wrapper: ReturnType<typeof mountTurn>): string[] {
  return wrapper
    .findAllComponents(MessageBubble)
    .map((bubble) => bubble.props().message.content);
}

describe("TurnTimeline", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("shows only the newest process segment while running", () => {
    const turn = buildTurn({ streaming: true });
    const wrapper = mountTurn(turn, true);

    expect(turn.processItems).toHaveLength(3);
    expect(wrapper.text()).toContain("处理中…");
    // Latest segment only: the second command, not the first one or its output.
    expect(wrapper.text()).toContain("npx playwright install");
    expect(wrapper.text()).not.toContain("pnpm add -D playwright");
    expect(wrapper.text()).toContain("展开前 2 段过程");
    wrapper.unmount();
  });

  it("collapses the whole process once finished and keeps the answer", () => {
    const wrapper = mountTurn(buildTurn({ endedAt: BASE + 113_000 }), false);

    expect(wrapper.text()).toContain("已处理 1m 53s");
    // Only the answer survives outside the collapse — no process at all.
    expect(bubbleTexts(wrapper)).toEqual(["浏览器装好了。"]);
    expect(wrapper.findAllComponents(ToolProgressPanel)).toHaveLength(0);
    expect(wrapper.text()).not.toContain("pnpm add -D playwright");
    wrapper.unmount();
  });

  it("keeps logs and usage actions visible after the process is collapsed", () => {
    const wrapper = mountTurn(buildTurn({ endedAt: BASE + 4_000 }), false, {
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
    });

    expect(wrapper.text()).toContain("日志");
    expect(wrapper.text()).toContain("统计");
    expect(wrapper.findAllComponents(ToolProgressPanel)).toHaveLength(0);
    wrapper.unmount();
  });

  it("reveals the full process when the header is clicked", async () => {
    const wrapper = mountTurn(buildTurn({ endedAt: BASE + 4_000 }), false);

    await wrapper.get("button.turn-header").trigger("click");

    expect(wrapper.text()).toContain("pnpm add -D playwright");
    expect(wrapper.findAllComponents(ToolProgressPanel)).toHaveLength(2);
    expect(bubbleTexts(wrapper)).toEqual(["先装依赖。", "浏览器装好了。"]);
    wrapper.unmount();
  });

  it("renders nothing but the answer when a turn has no process items", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "hi", timestamp: BASE },
      {
        id: "a1",
        role: "assistant",
        content: "你好",
        timestamp: BASE + 1,
        turnId: "turn-9",
      },
    ];
    const entries = buildChatTimelineEntries(buildChatDisplayItems(messages));
    const turn = entries.find((entry) => entry.type === "turn");
    if (!turn || turn.type !== "turn") throw new Error("no turn entry");

    const wrapper = mountTurn(turn, false);
    expect(wrapper.find("button.turn-header").exists()).toBe(false);
    expect(bubbleTexts(wrapper)).toEqual(["你好"]);
    wrapper.unmount();
  });
});
