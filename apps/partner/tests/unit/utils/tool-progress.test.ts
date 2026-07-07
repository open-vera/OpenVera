import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/types";
import {
  compactToolProgress,
  groupToolProgress,
  isVisibleToolProgressStep,
  summarizeToolCall,
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
    expect(step.detail).toBe("开始处理请求");
    expect(summarizeToolCall(toolCall("t2", "agent_config", {}), "zh-CN").detail).toBe(
      "读取 Vera 运行配置",
    );
    expect(summarizeToolCall(toolCall("t3", "agent_wait_model", {}), "zh-CN").detail).toBe(
      "等待模型响应",
    );
    expect(summarizeToolCall(toolCall("t4", "agent_model_ready", {}), "zh-CN").detail).toBe(
      "模型连接已建立，等待首个响应",
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
      "agent_thinking",
      "agent_error",
    ]
      .map((name) => summarizeToolCall(toolCall(name, name, { message: "失败" }), "zh-CN"))
      .filter(isVisibleToolProgressStep)
      .map((step) => step.rawName);

    expect(visibleNames).toEqual(["agent_thinking", "agent_error"]);
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

  it("shows full shell commands with args and cwd", () => {
    const step = summarizeToolCall(
      toolCall("t1", "execute_shell", {
        cmd: "git",
        args: ["status", "--short"],
        cwd: "/repo",
      }),
      "zh-CN",
    );

    expect(step.title).toBe("执行命令");
    expect(step.detail).toBe("运行命令：git status --short（目录：/repo）");
  });

  it("shows git tool calls as full commands too", () => {
    const step = summarizeToolCall(
      toolCall("t1", "git_status", {
        cmd: "git",
        args: ["diff", "--", "src/App.vue"],
      }),
      "zh-CN",
    );

    expect(step.title).toBe("检查版本状态");
    expect(step.detail).toBe("运行命令：git diff -- src/App.vue");
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
});
