// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ContextUsageRing from "@/components/chat/ContextUsageRing.vue";
import type { TokenUsage } from "@/types";

const usage: TokenUsage = {
  input_tokens: 3900,
  output_tokens: 1100,
  total_tokens: 5000,
  cache_read_input_tokens: 20_000,
  duration_ms: 14_900,
  ttfb_ms: 1900,
  ttft_ms: 3300,
  turns: 5,
  tool_use_count: 7,
  context_used: 7800,
  context_max: 128_000,
};

function mountRing(mode: "turn" | "turn-ring" | "context") {
  return mount(ContextUsageRing, {
    props: { usage, mode, locale: "zh-CN" },
    attachTo: document.body,
  });
}

function popover(): Element | null {
  return document.querySelector("[data-context-usage-popover]");
}

describe("ContextUsageRing", () => {
  it("renders a 统计 text trigger in turn mode", () => {
    const wrapper = mountRing("turn");
    const button = wrapper.get("button.stats-button");
    expect(button.text()).toBe("统计");
    expect(popover()).toBeNull();
    wrapper.unmount();
  });

  it("opens on click and closes on a second click", async () => {
    const wrapper = mountRing("turn");
    await wrapper.get("button.stats-button").trigger("click");
    expect(popover()).not.toBeNull();
    expect(popover()?.textContent).toContain("本轮统计");
    expect(popover()?.textContent).toContain("TTFT");

    await wrapper.get("button.stats-button").trigger("click");
    expect(popover()).toBeNull();
    wrapper.unmount();
  });

  it("closes when pointerdown lands outside the popover", async () => {
    const wrapper = mountRing("turn");
    await wrapper.get("button.stats-button").trigger("click");
    expect(popover()).not.toBeNull();

    document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(popover()).toBeNull();
    wrapper.unmount();
  });

  it("keeps the popover open when the click is inside it", async () => {
    const wrapper = mountRing("turn");
    await wrapper.get("button.stats-button").trigger("click");
    const panel = popover();
    expect(panel).not.toBeNull();

    panel?.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(popover()).not.toBeNull();
    wrapper.unmount();
  });

  it("closes on Escape", async () => {
    const wrapper = mountRing("turn");
    await wrapper.get("button.stats-button").trigger("click");
    expect(popover()).not.toBeNull();

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(popover()).toBeNull();
    wrapper.unmount();
  });

  it("does not hover-open the text trigger", async () => {
    const wrapper = mountRing("turn");
    await wrapper.get(".context-usage").trigger("mouseenter");
    expect(popover()).toBeNull();
    wrapper.unmount();
  });

  it("still hover-opens the context ring", async () => {
    const wrapper = mountRing("context");
    expect(wrapper.find("button.ring-button").exists()).toBe(true);

    await wrapper.get(".context-usage").trigger("mouseenter");
    expect(popover()?.textContent).toContain("上下文窗口");
    // Window occupancy uses API terms and shows the remaining room.
    expect(popover()?.textContent).toContain("缓存读");
    expect(popover()?.textContent).toContain("剩余");
    wrapper.unmount();
  });

  it("hides the trigger until this turn has stats", () => {
    const wrapper = mount(ContextUsageRing, {
      props: { usage: null, mode: "turn", locale: "zh-CN" },
      attachTo: document.body,
    });
    expect(wrapper.find("button.stats-button").exists()).toBe(false);
    wrapper.unmount();
  });
});
