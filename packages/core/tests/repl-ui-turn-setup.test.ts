import { describe, expect, it } from "vitest";
import { PromptStore } from "../src/prompt/index.js";
import type { ReplContext } from "../src/repl/context.js";
import type { Tool } from "../src/types/index.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/ask-user-question.js";
import { SUBAGENT_TOOL_NAME } from "../src/agent/subagent.js";
import { mergeSystemPrompts, normalizePromptIntent, prepareTurnSetup } from "../src/repl/ui/controller/turnSetup.js";

function tool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  };
}

function ctx(overrides: Partial<ReplContext> = {}): ReplContext {
  return {
    cwd: "/tmp/project",
    config: { providers: {}, default_provider: "test" },
    adapter: {} as ReplContext["adapter"],
    model: "model",
    tools: [tool("read_file")],
    buildAdapter: () => ({} as ReplContext["adapter"]),
    sessionStore: {} as ReplContext["sessionStore"],
    promptStore: new PromptStore(),
    ...overrides,
  };
}

describe("turnSetup", () => {
  it("merges non-empty system prompts", () => {
    expect(mergeSystemPrompts(" base ", "", undefined, " project ")).toBe("base\n\nproject");
  });

  it("normalizes loose intent signals for prompt resolution", () => {
    expect(normalizePromptIntent({ domain: "code", level: 2, needs_tools: true })).toEqual({
      domain: "code",
      level: 2,
      needs_tools: true,
    });
    expect(normalizePromptIntent({ domain: "unknown", level: 99, needs_tools: false })).toEqual({
      domain: "chat",
      level: 0,
      needs_tools: false,
    });
    expect(normalizePromptIntent(null)).toEqual({
      domain: "chat",
      level: 0,
      needs_tools: false,
    });
  });

  it("adds subagent and ask-user-question tools when missing", () => {
    const setup = prepareTurnSetup({
      ctx: ctx(),
      intent: { domain: "chat", level: 0, needs_tools: false },
      agentDefinitions: [],
      projectSystem: "Project context",
    });

    expect(setup.activeTools.map((t) => t.name)).toContain("read_file");
    expect(setup.activeTools.map((t) => t.name)).toContain(SUBAGENT_TOOL_NAME);
    expect(setup.activeTools.map((t) => t.name)).toContain(ASK_USER_QUESTION_TOOL_NAME);
    expect(setup.activeSystem).toContain("Project context");
    expect(setup.resolvedPrompt).toBeTruthy();
  });

  it("deduplicates skill tools already present in registry tools", () => {
    const executors = new Map<string, (args: Record<string, unknown>) => string>();
    const setup = prepareTurnSetup({
      ctx: ctx({
        tools: [tool("read_file"), tool("skill_only")],
        resolveSkillBundle: () => ({
          system: "Skill system",
          tools: [tool("read_file"), tool("skill_only"), tool("extra")],
          executors,
        }),
      }),
      intent: { domain: "code", level: 2, needs_tools: true },
      agentDefinitions: [],
    });

    expect(setup.activeTools.filter((t) => t.name === "read_file")).toHaveLength(1);
    expect(setup.activeTools.filter((t) => t.name === "skill_only")).toHaveLength(1);
    expect(setup.activeTools.filter((t) => t.name === "extra")).toHaveLength(1);
    expect(setup.activeSystem).toBe("Skill system");
    expect(setup.activeExecutors).toBe(executors);
  });
});
