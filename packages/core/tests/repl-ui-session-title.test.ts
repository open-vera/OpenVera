import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "../src/adapters/base.js";
import {
  markCustomTitle,
  maybeGenerateAiTitle,
  shouldGenerateAiTitle,
  type AiTitleState,
} from "../src/repl/ui/controller/sessionTitle.js";

const adapter = {} as LLMAdapter;

describe("sessionTitle controller", () => {
  it("decides whether AI title generation is allowed", () => {
    expect(shouldGenerateAiTitle({ hasCustomTitle: false, generated: false, attempts: 0 }, undefined, 0)).toBe(true);
    expect(shouldGenerateAiTitle({ hasCustomTitle: false, generated: false, attempts: 0 }, { enabled: false }, 0)).toBe(false);
    expect(shouldGenerateAiTitle({ hasCustomTitle: true, generated: false, attempts: 0 }, undefined, 0)).toBe(false);
    expect(shouldGenerateAiTitle({ hasCustomTitle: false, generated: true, attempts: 1 }, undefined, 0)).toBe(false);
    expect(shouldGenerateAiTitle({ hasCustomTitle: false, generated: false, attempts: 2 }, undefined, 0)).toBe(false);
    expect(shouldGenerateAiTitle({ hasCustomTitle: false, generated: false, attempts: 0 }, undefined, 2)).toBe(false);
  });

  it("marks custom title state", () => {
    const state: AiTitleState = { hasCustomTitle: false, generated: false, attempts: 0 };
    expect(markCustomTitle(state)).toBe(state);
    expect(state.hasCustomTitle).toBe(true);
  });

  it("starts async title generation and writes returned title", async () => {
    const state: AiTitleState = { hasCustomTitle: false, generated: false, attempts: 0 };
    const writeAiTitle = vi.fn();
    const generateTitle = vi.fn().mockResolvedValue("Refactor TUI");

    const next = maybeGenerateAiTitle({
      state,
      turnCount: 1,
      userPrompt: "continue refactor",
      assistantText: "done",
      toolCalls: [],
      activeAdapter: adapter,
      activeModel: "active-model",
      buildAdapter: () => adapter,
      writeAiTitle,
      generateTitle,
    });

    expect(next).toBe(state);
    expect(state).toMatchObject({ generated: true, attempts: 1 });
    await Promise.resolve();
    expect(generateTitle).toHaveBeenCalledWith(expect.objectContaining({
      adapter,
      model: "active-model",
      userPrompt: "continue refactor",
      assistantText: "done",
    }));
    expect(writeAiTitle).toHaveBeenCalledWith("Refactor TUI");
  });

  it("uses configured title provider/model and tool summary fallback", async () => {
    const state: AiTitleState = { hasCustomTitle: false, generated: false, attempts: 0 };
    const titleAdapter = {} as LLMAdapter;
    const generateTitle = vi.fn().mockResolvedValue("Tool Work");

    maybeGenerateAiTitle({
      state,
      config: { provider: "title-provider", model: "title-model" },
      turnCount: 0,
      userPrompt: "run tools",
      assistantText: "   ",
      toolCalls: ["read_file", "read_file", "bash"],
      activeAdapter: adapter,
      activeModel: "active-model",
      buildAdapter: (provider) => provider === "title-provider" ? titleAdapter : adapter,
      writeAiTitle: () => {},
      generateTitle,
    });

    await Promise.resolve();
    expect(generateTitle).toHaveBeenCalledWith(expect.objectContaining({
      adapter: titleAdapter,
      model: "title-model",
      assistantText: "Tools used: read_file, bash",
    }));
  });

  it("does not write generated title after a custom title is set", async () => {
    const state: AiTitleState = { hasCustomTitle: false, generated: false, attempts: 0 };
    const writeAiTitle = vi.fn();
    let resolveTitle: (title: string) => void = () => {};
    const generateTitle = vi.fn(() => new Promise<string>((resolve) => {
      resolveTitle = resolve;
    }));

    maybeGenerateAiTitle({
      state,
      turnCount: 0,
      userPrompt: "task",
      assistantText: "answer",
      toolCalls: [],
      activeAdapter: adapter,
      activeModel: "model",
      buildAdapter: () => adapter,
      writeAiTitle,
      generateTitle,
    });

    markCustomTitle(state);
    resolveTitle("Late title");
    await Promise.resolve();

    expect(writeAiTitle).not.toHaveBeenCalled();
  });

  it("allows retry when generation returns no title or rejects", async () => {
    const state: AiTitleState = { hasCustomTitle: false, generated: false, attempts: 0 };
    maybeGenerateAiTitle({
      state,
      turnCount: 0,
      userPrompt: "task",
      assistantText: "",
      toolCalls: [],
      activeAdapter: adapter,
      activeModel: "model",
      buildAdapter: () => adapter,
      writeAiTitle: () => {},
      generateTitle: vi.fn().mockResolvedValue(null),
    });
    await Promise.resolve();

    expect(state.generated).toBe(false);
    expect(state.attempts).toBe(1);
  });
});
