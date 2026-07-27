import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/types";
import {
  compactToolProgress,
  foldRepeatedLines,
  formatStepDetail,
  formatToolParams,
  groupToolProgress,
  isVisibleToolProgressStep,
  oneLineText,
  summarizeResultOutput,
  summarizeToolCall,
  TOOL_DETAIL_FULL_MAX_CHARS,
  truncateDisplayText,
} from "@/utils/tool-progress";

function toolCall(id: string, name: string, input: Record<string, unknown>): ToolCall {
  return { id, name, input };
}

describe("tool progress summaries", () => {
  it("translates raw tool calls into localized user-facing steps", () => {
    const step = summarizeToolCall(
      toolCall("t1", "read_file", { path: "Cargo.toml" }),
      "zh-CN",
    );

    expect(step.title).toBe("查看项目文件");
    expect(step.detail).toBe("查看项目文件：Cargo.toml");
  });

  it("summarizes agent lifecycle steps without exposing raw thinking text", () => {
    const step = summarizeToolCall(toolCall("t1", "agent_start", {}), "zh-CN");

    expect(step.title).toBe("推进任务");
    expect(step.detail).toBe("开始处理");
    expect(summarizeToolCall(toolCall("t2", "agent_config", {}), "zh-CN").detail).toBe(
      "读取配置",
    );
    expect(summarizeToolCall(toolCall("t3", "agent_wait_model", {}), "zh-CN").detail).toBe(
      "连接模型",
    );
    expect(summarizeToolCall(toolCall("t4", "agent_model_ready", {}), "zh-CN").detail).toBe(
      "等待模型响应",
    );
    expect(summarizeToolCall(toolCall("t4", "agent_model_ready", {}), "zh-CN").title).toBe(
      "推进任务",
    );
  });

  it("hides only internal startup steps while keeping thinking visible", () => {
    const visibleNames = [
      "agent_start",
      "agent_config",
      "agent_wait_model",
      "agent_model_ready",
      "agent_intent",
      "agent_thinking",
      "agent_error",
    ]
      .map((name) => summarizeToolCall(toolCall(name, name, { message: "失败" }), "zh-CN"))
      .filter(isVisibleToolProgressStep)
      .map((step) => step.rawName);

    expect(visibleNames).toEqual(["agent_intent", "agent_thinking", "agent_error"]);
  });

  it("summarizes intent classification with domain and execution mode", () => {
    const direct = summarizeToolCall(
      toolCall("t1", "agent_intent", {
        level: 2,
        domain: "code",
        executionMode: "direct_stream",
        reason: "User wants a script",
      }),
      "zh-CN",
    );
    expect(direct.title).toBe("推进任务");
    expect(direct.detail).toBe("代码");

    const planned = summarizeToolCall(
      toolCall("t2", "agent_intent", { domain: "other", executionMode: "harness_plan" }),
      "zh-CN",
    );
    expect(planned.detail).toBe("通用 · 规划");

    const english = summarizeToolCall(
      toolCall("t3", "agent_intent", { domain: "code", executionMode: "direct_stream" }),
      "en-US",
    );
    expect(english.detail).toBe("code");

    const noDomain = summarizeToolCall(toolCall("t4", "agent_intent", {}), "zh-CN");
    expect(noDomain.detail).toBe("对话");
  });

  it("summarizes agent errors as failed progress", () => {
    const step = summarizeToolCall(
      toolCall("t1", "agent_error", { message: "模型服务拒绝了当前请求\n详情" }),
      "zh-CN",
    );

    expect(step.title).toBe("执行失败");
    expect(step.category).toBe("error");
    expect(step.detail).toBe("模型服务拒绝了当前请求");
  });

  it("summarizes tool approval requests", () => {
    const step = summarizeToolCall(
      toolCall("t1", "tool_approval_required", {
        cmd: "find",
        args: [".", "-name", "deploy pre.yml"],
        reason: "命令 `find` 不在白名单中，需要用户确认",
      }),
      "zh-CN",
    );

    expect(step.title).toBe("等待授权");
    expect(step.category).toBe("approval");
    expect(step.detail).toBe('需要授权执行命令：find . -name "deploy pre.yml"');
  });

  it("summarizes path approval requests", () => {
    const step = summarizeToolCall(
      toolCall("t2", "tool_approval_required", {
        allowDir: "/Users/me/.vera",
        reason: 'Agent wants to access a path outside the working directory:\n  /Users/me/.vera/settings.json',
      }),
      "zh-CN",
    );

    expect(step.category).toBe("approval");
    expect(step.detail).toBe("需要授权访问目录：/Users/me/.vera");
  });

  it("keeps error steps separate from normal progress groups", () => {
    const groups = groupToolProgress(
      [
        summarizeToolCall(toolCall("t1", "agent_start", {}), "zh-CN"),
        summarizeToolCall(toolCall("t2", "agent_error", { message: "失败" }), "zh-CN"),
      ].filter((step) => step.category !== "error"),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("推进任务");
    expect(groups[0]?.steps.map((step) => step.rawName)).toEqual(["agent_start"]);
  });

  it("groups consecutive steps by high-level action", () => {
    const steps = [
      summarizeToolCall(toolCall("t1", "list_dir", { path: "." }), "zh-CN"),
      summarizeToolCall(toolCall("t2", "read_file", { path: "Cargo.toml" }), "zh-CN"),
      summarizeToolCall(toolCall("t3", "execute_shell", { command: "pnpm test" }), "zh-CN"),
    ];

    const groups = groupToolProgress(steps);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.title).toBe("查看项目文件");
    expect(groups[0]?.steps).toHaveLength(2);
    expect(groups[1]?.title).toBe("执行命令");
  });

  it("shows full shell commands with args", () => {
    const step = summarizeToolCall(
      toolCall("t1", "execute_shell", {
        cmd: "git",
        args: ["status", "--short"],
        cwd: "/repo",
      }),
      "zh-CN",
    );

    expect(step.title).toBe("执行命令");
    expect(step.detail).toBe("git status --short");
    expect(step.category).toBe("shell");
  });

  it("shows bash and git tool calls as full commands too", () => {
    const bash = summarizeToolCall(
      toolCall("t0", "bash", {
        cmd: "ls",
        args: ["-la", "src"],
      }),
      "zh-CN",
    );
    expect(bash.category).toBe("shell");
    expect(bash.detail).toBe("ls -la src");

    const step = summarizeToolCall(
      toolCall("t1", "git_status", {
        cmd: "git",
        args: ["diff", "--", "src/App.vue"],
      }),
      "zh-CN",
    );

    expect(step.title).toBe("检查版本状态");
    expect(step.detail).toBe("git diff -- src/App.vue");
  });

  it("collapses multiline text to one line for compact preview", () => {
    expect(oneLineText("pnpm test\n  --coverage")).toBe("pnpm test --coverage");
  });

  it("formats all tool params in expanded view and one-line when compact", () => {
    const write = summarizeToolCall(
      toolCall("t1", "write_file", {
        path: "src/a.ts",
        content: "export const a = 1;\n",
      }),
      "zh-CN",
    );

    expect(formatStepDetail(write, "compact")).toBe("src/a.ts");
    expect(formatStepDetail(write, "full")).toBe(
      ["path: src/a.ts", "content:", "export const a = 1;", ""].join("\n"),
    );

    const shell = summarizeToolCall(
      toolCall("t2", "execute_shell", {
        cmd: "rg",
        args: ["-n", "TODO", "src"],
      }),
      "zh-CN",
    );
    expect(formatStepDetail(shell, "compact")).toBe("rg -n TODO src");
    expect(formatStepDetail(shell, "full")).toBe("rg -n TODO src");
    expect(formatToolParams(shell.rawInput)).toContain("cmd: rg");
  });

  it("truncates huge full-mode tool params so expand-all stays responsive", () => {
    const huge = "x".repeat(TOOL_DETAIL_FULL_MAX_CHARS + 2_000);
    const write = summarizeToolCall(
      toolCall("t1", "write_file", { path: "big.txt", content: huge }),
      "zh-CN",
    );
    const full = formatStepDetail(write, "full");
    expect(full.length).toBeLessThanOrEqual(TOOL_DETAIL_FULL_MAX_CHARS + 8);
    expect(full.endsWith("…")).toBe(true);
    expect(truncateDisplayText("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  it("keeps only the latest group and latest three steps when compacted", () => {
    const groups = groupToolProgress([
      summarizeToolCall(toolCall("t1", "read_file", { path: "a.ts" }), "zh-CN"),
      summarizeToolCall(toolCall("t2", "execute_shell", { command: "one" }), "zh-CN"),
      summarizeToolCall(toolCall("t3", "execute_shell", { command: "two" }), "zh-CN"),
      summarizeToolCall(toolCall("t4", "execute_shell", { command: "three" }), "zh-CN"),
      summarizeToolCall(toolCall("t5", "execute_shell", { command: "four" }), "zh-CN"),
    ]);

    const compacted = compactToolProgress(groups);

    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.title).toBe("执行命令");
    expect(compacted[0]?.steps.map((step) => step.id)).toEqual(["t3", "t4", "t5"]);
  });

  it("skips trailing agent lifecycle groups so compact preview keeps tool results", () => {
    const groups = groupToolProgress([
      summarizeToolCall(toolCall("t1", "read_file", { path: "a.ts" }), "zh-CN"),
      summarizeToolCall(toolCall("t2", "read_file", { path: "b.ts" }), "zh-CN"),
      summarizeToolCall(toolCall("t3", "agent_thinking", {}), "zh-CN"),
    ]);

    const compacted = compactToolProgress(groups);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.category).toBe("filesystem");
    expect(compacted[0]?.steps.map((step) => step.id)).toEqual(["t1", "t2"]);
  });
});

describe("output compaction", () => {
  it("folds runs of near-identical progress lines", () => {
    const text = [
      "Progress: resolved 66, reused 0",
      "Progress: resolved 84, reused 0",
      "Progress: resolved 86, reused 0",
      "Progress: resolved 832, reused 0",
      "Done in 12.2s",
    ].join("\n");

    const folded = foldRepeatedLines(text);
    expect(folded.split("\n")).toHaveLength(2);
    expect(folded).toContain("Progress: resolved 832, reused 0  … ×4 行相似");
    expect(folded).toContain("Done in 12.2s");
  });

  it("leaves distinct lines untouched", () => {
    const text = "first line\nsecond thing\nthird item";
    expect(foldRepeatedLines(text)).toBe(text);
  });

  it("summarizes an output into one line for the live view", () => {
    expect(summarizeResultOutput("only line", false, "zh-CN")).toBe("only line");
    expect(summarizeResultOutput("a\nb\nc", false, "zh-CN")).toBe("3 行 · a");
    expect(summarizeResultOutput("", false, "zh-CN")).toBe("完成 · 无输出");
    expect(summarizeResultOutput("", true, "zh-CN")).toBe("失败 · 无输出");
    expect(summarizeResultOutput("a\nb", false, "en-US")).toBe("2 lines · a");
  });
});
