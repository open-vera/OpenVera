import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "../src/adapters/base.js";
import {
  buildSubagentToolSchema,
  getBackgroundSubagentJob,
  listBackgroundSubagentJobs,
  loadAgentDefinitions,
  runSubagentTool,
  subagentToolSchema,
  SUBAGENT_TOOL_NAME,
} from "../src/agent/subagent.js";
import { SessionStore } from "../src/session/store.js";
import type { Message, StreamEvent } from "../src/types/index.js";
import { events, withTempDir, writeAgent, git } from "./agent-context-test-helpers.js";

describe("subagent tool and definitions", () => {
  it("runs a focused subagent with inherited non-agent tools", async () => {
    const seenToolCalls: string[] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => {
        call++;
        if (call === 1) {
          return events([
            {
              type: "tool_call",
              id: "tool-1",
              name: "lookup",
              arguments: JSON.stringify({ q: "status" }),
            },
            { type: "done", stop_reason: "tool_use" },
          ]);
        }
        return events([
          { type: "text", text: "子任务完成。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const result = await runSubagentTool({
      args: { task: "检查状态" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "lookup",
          description: "lookup",
          parameters: { type: "object", properties: {} },
        },
        {
          name: SUBAGENT_TOOL_NAME,
          description: "agent",
          parameters: { type: "object", properties: {} },
        },
      ],
      onToolCall: (name) => {
        seenToolCalls.push(name);
        return "status ok";
      },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Subagent (general-purpose) result");
    expect(result.content).toContain("子任务完成");
    expect(result.content).toContain("Tools used: lookup");
    expect(seenToolCalls).toEqual(["lookup"]);
  });

  it("exposes Claude Code style agent tool parameters while keeping aliases", () => {
    const properties = subagentToolSchema.parameters.properties ?? {};

    expect(subagentToolSchema.name).toBe("agent");
    expect(subagentToolSchema.parameters.required).toEqual(["prompt"]);
    expect(Object.keys(properties)).toEqual(expect.arrayContaining([
      "description",
      "prompt",
      "subagent_type",
      "task",
      "subagentType",
      "allowedTools",
      "maxTurns",
      "isolation",
      "run_mode",
      "resume_session_id",
      "resumeSessionId",
    ]));
    expect(properties.subagent_type).toMatchObject({
      enum: expect.arrayContaining(["general-purpose", "explore", "plan"]),
    });
    expect(properties.isolation).toMatchObject({ enum: ["none", "try", "remote"] });
    expect(properties.run_mode).toMatchObject({ enum: ["sync", "background"] });
  });

  it("uses remote isolation when a remote executor is provided", async () => {
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => events([
        { type: "text", text: "unused" },
        { type: "done", stop_reason: "end_turn" },
      ]),
    };

    const result = await runSubagentTool({
      args: { prompt: "远程执行任务", isolation: "remote" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [],
      onToolCall: () => "unused",
      remoteExecutor: async () => ({
        content: "Remote execution finished.",
        transcriptId: "remote-session-1",
        toolCalls: ["read_file"],
        location: "runner://remote-1",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Remote execution finished.");
    expect(result.content).toContain("Isolation: remote:runner://remote-1");
    expect(result.content).toContain("Transcript: remote-session-1");
    expect(result.content).toContain("Tools used: read_file");
  });

  it("uses built-in default remote executor when no remote executor is provided", async () => {
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => events([
        { type: "text", text: "Default remote path done." },
        { type: "done", stop_reason: "end_turn" },
      ]),
    };

    const result = await runSubagentTool({
      args: { prompt: "走默认 remote backend", isolation: "remote" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [],
      onToolCall: () => "unused",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Default remote path done.");
    expect(result.content).toContain("Isolation: remote:local-default");
  });

  it("prefers configured external remote runner when environment is set", async () => {
    const runnerDir = mkdtempSync(join(tmpdir(), "vera-remote-runner-"));
    const runnerScript = join(runnerDir, "remote-runner.js");
    writeFileSync(
      runnerScript,
      [
        "process.stdin.setEncoding('utf8');",
        "let data='';",
        "process.stdin.on('data', (c) => data += c);",
        "process.stdin.on('end', () => {",
        "  const input = JSON.parse(data || '{}');",
        "  process.stdout.write(JSON.stringify({",
        "    content: `external:${input.task || ''}`.trim(),",
        "    transcriptId: 'ext-session-1',",
        "    toolCalls: ['grep'],",
        "    location: 'external-runner-test'",
        "  }));",
        "});",
      ].join("\n"),
      "utf8",
    );

    const prevRunner = process.env.VERA_SUBAGENT_REMOTE_RUNNER;
    const prevRunnerArgs = process.env.VERA_SUBAGENT_REMOTE_RUNNER_ARGS;
    process.env.VERA_SUBAGENT_REMOTE_RUNNER = process.execPath;
    process.env.VERA_SUBAGENT_REMOTE_RUNNER_ARGS = JSON.stringify([runnerScript]);
    try {
      const adapter: LLMAdapter = {
        complete: vi.fn(),
        stream: () => events([
          { type: "text", text: "unused local fallback" },
          { type: "done", stop_reason: "end_turn" },
        ]),
      };

      const result = await runSubagentTool({
        args: { prompt: "通过外部 runner", isolation: "remote" },
        adapter,
        model: "claude-sonnet-4-6",
        tools: [],
        onToolCall: () => "unused",
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("external:通过外部 runner");
      expect(result.content).toContain("Isolation: remote:external-runner-test");
      expect(result.content).toContain("Transcript: ext-session-1");
      expect(result.content).toContain("Tools used: grep");
    } finally {
      if (prevRunner === undefined) delete process.env.VERA_SUBAGENT_REMOTE_RUNNER;
      else process.env.VERA_SUBAGENT_REMOTE_RUNNER = prevRunner;
      if (prevRunnerArgs === undefined) delete process.env.VERA_SUBAGENT_REMOTE_RUNNER_ARGS;
      else process.env.VERA_SUBAGENT_REMOTE_RUNNER_ARGS = prevRunnerArgs;
      rmSync(runnerDir, { recursive: true, force: true });
    }
  });

  it("resumes a previous subagent transcript when resume_session_id is provided", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "vera-subagent-resume-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vera-subagent-resume-repo-"));
    const originalVeraHome = process.env.VERA_HOME;
    process.env.VERA_HOME = tempHome;
    try {
      const previous = new SessionStore({ cwd: repo });
      previous.writeStart("claude-sonnet-4-6", "anthropic");
      const userUuid = previous.writeUser("First task");
      previous.writeAssistant({
        parentUuid: userUuid,
        content: "First result",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
        turn: 1,
        latencyMs: 10,
        toolCalls: [],
        status: "ok",
      });

      const prompts: string[] = [];
      const adapter: LLMAdapter = {
        complete: vi.fn(),
        stream: (request) => {
          prompts.push(String(request.messages.at(-1)?.content ?? ""));
          return events([
            { type: "text", text: "Resumed done." },
            { type: "done", stop_reason: "end_turn" },
          ]);
        },
      };

      const result = await runSubagentTool({
        args: { prompt: "继续处理", resume_session_id: previous.sessionId },
        adapter,
        model: "claude-sonnet-4-6",
        tools: [],
        cwd: repo,
        onToolCall: () => "unused",
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain(`Transcript: ${previous.sessionId}`);
      expect(prompts[0]).toContain("Resume context:");
      expect(prompts[0]).toContain("user: First task");
      expect(prompts[0]).toContain("assistant: First result");
    } finally {
      process.env.VERA_HOME = originalVeraHome;
      rmSync(repo, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("can launch background subagent jobs and expose status", async () => {
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => events([
        { type: "text", text: "后台完成" },
        { type: "done", stop_reason: "end_turn" },
      ]),
    };

    const started = await runSubagentTool({
      args: { prompt: "后台执行", run_mode: "background" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [],
      onToolCall: () => "unused",
    });

    expect(started.ok).toBe(true);
    expect(started.content).toContain("started in background");
    const jobId = started.content.match(/Job:\s+([a-z0-9-]+)/i)?.[1];
    expect(jobId).toBeTruthy();

    let job = getBackgroundSubagentJob(jobId!);
    for (let i = 0; i < 20 && job?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      job = getBackgroundSubagentJob(jobId!);
    }

    expect(job?.status).toBe("succeeded");
    expect(job?.result).toContain("后台完成");
    expect(listBackgroundSubagentJobs().some((entry) => entry.jobId === jobId)).toBe(true);
  });

  it("accepts Claude Code style subagent arguments and builds scoped child context", async () => {
    const captured: Array<{ system?: string; prompt: string; toolNames: string[] }> = [];
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        captured.push({
          system: request.system,
          prompt: String(request.messages.at(-1)?.content ?? ""),
          toolNames: request.tools?.map((tool) => tool.name) ?? [],
        });
        return events([
          { type: "text", text: "探索完成。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const result = await runSubagentTool({
      args: {
        description: "scan auth",
        prompt: "检查认证相关文件",
        context: "只看 packages/core",
        subagent_type: "Explore",
        allowedTools: ["read_file", "bash"],
      },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "bash",
          description: "bash",
          parameters: { type: "object", properties: {} },
        },
      ],
      onToolCall: () => "should not run",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Subagent (explore) result");
    expect(captured[0]!.toolNames).toEqual(["read_file"]);
    expect(captured[0]!.prompt).toContain("Description:\nscan auth");
    expect(captured[0]!.prompt).toContain("Task:\n检查认证相关文件");
    expect(captured[0]!.prompt).toContain("Context:\n只看 packages/core");
    expect(captured[0]!.system).toContain("read-only exploration subagent");
    expect(captured[0]!.system).toContain("Vera subagent running inside a parent agent turn");
  });

  it("runs a subagent in a try worktree when requested", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "vera-subagent-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vera-subagent-repo-"));
    const originalVeraHome = process.env.VERA_HOME;
    process.env.VERA_HOME = tempHome;
    try {
      git(repo, ["init"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "Test User"]);
      writeFileSync(join(repo, "README.md"), "hello\n");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "initial"]);

      let call = 0;
      const adapter: LLMAdapter = {
        complete: vi.fn(),
        stream: () => {
          call++;
          if (call === 1) {
            return events([
              {
                type: "tool_call",
                id: "tool-1",
                name: "write_marker",
                arguments: JSON.stringify({ file: "MARKER.txt" }),
              },
              { type: "done", stop_reason: "tool_use" },
            ]);
          }
          return events([
            { type: "text", text: "isolated work done" },
            { type: "done", stop_reason: "end_turn" },
          ]);
        },
      };
      const parent = new SessionStore({ cwd: repo });
      parent.writeStart("claude-sonnet-4-6", "anthropic");
      let isolatedCwd = "";
      let isolatedSessionId = "";

      const result = await runSubagentTool({
        args: { prompt: "修改文件", isolation: "try" },
        adapter,
        model: "claude-sonnet-4-6",
        tools: [
          {
            name: "write_marker",
            description: "write marker",
            parameters: { type: "object", properties: {} },
          },
        ],
        cwd: repo,
        provider: "anthropic",
        parentSessionId: parent.sessionId,
        onToolCall: () => "should not use parent cwd",
        createToolHandlerForCwd: ({ cwd, sessionStore }) => {
          isolatedCwd = cwd;
          isolatedSessionId = sessionStore?.sessionId ?? "";
          return (_name, args) => {
            writeFileSync(join(cwd, String(args.file)), "from isolated subagent\n");
            return "written";
          };
        },
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("Isolation: try worktree");
      expect(result.content).toContain(`Transcript: ${isolatedSessionId}`);
      expect(isolatedCwd).toContain(join(repo, ".vera", "worktrees"));
      expect(existsSync(join(isolatedCwd, "MARKER.txt"))).toBe(true);
      expect(existsSync(join(repo, "MARKER.txt"))).toBe(false);

      const summary = SessionStore.listSessions(repo).find((session) => session.sessionId === isolatedSessionId);
      expect(summary?.branch?.parentSessionId).toBe(parent.sessionId);
      expect(summary?.branch?.worktreePath).toBe(isolatedCwd);
      expect(summary?.branch?.baseCommit).toBeTruthy();
    } finally {
      process.env.VERA_HOME = originalVeraHome;
      rmSync(repo, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps legacy subagent argument aliases compatible", async () => {
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => events([
        { type: "text", text: "旧参数仍可用。" },
        { type: "done", stop_reason: "end_turn" },
      ]),
    };

    const result = await runSubagentTool({
      args: { task: "检查状态", subagentType: "general" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [],
      onToolCall: () => "should not run",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Subagent (general-purpose) result");
    expect(result.content).toContain("旧参数仍可用");
  });

  it("returns clear validation errors for missing prompt and unknown agent type", async () => {
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => events([
        { type: "text", text: "should not run" },
        { type: "done", stop_reason: "end_turn" },
      ]),
    };
    const baseOptions = {
      adapter,
      model: "claude-sonnet-4-6",
      tools: [],
      onToolCall: () => "should not run",
    };

    await expect(runSubagentTool({ ...baseOptions, args: {} })).resolves.toEqual({
      ok: false,
      content: "agent requires a non-empty prompt string.",
    });
    await expect(runSubagentTool({
      ...baseOptions,
      args: { prompt: "检查", subagent_type: "missing-agent" },
    })).resolves.toEqual({
      ok: false,
      content: 'Unknown subagent_type "missing-agent".',
    });
    await expect(runSubagentTool({
      ...baseOptions,
      args: { prompt: "检查", isolation: "remote" },
    })).resolves.toEqual({
      ok: true,
      content: expect.stringContaining("Subagent (general-purpose) result:"),
    });
    await expect(runSubagentTool({
      ...baseOptions,
      args: { prompt: "检查", run_mode: "async" },
    })).resolves.toEqual({
      ok: false,
      content: 'Unknown agent run_mode "async".',
    });
    await expect(runSubagentTool({
      ...baseOptions,
      args: { prompt: "检查", isolation: "try" },
    })).resolves.toEqual({
      ok: false,
      content: "agent isolation 'try' requires a cwd.",
    });
    await expect(runSubagentTool({
      ...baseOptions,
      args: { prompt: "检查", isolation: "try", resume_session_id: "abc" },
    })).resolves.toEqual({
      ok: false,
      content: "resume_session_id cannot be used with isolation.",
    });
  });

  it("honors subagent maxTurns override before continuing a tool loop", async () => {
    const seenToolCalls: string[] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => {
        call++;
        return events([
          {
            type: "tool_call",
            id: `tool-${call}`,
            name: "lookup",
            arguments: JSON.stringify({ call }),
          },
          { type: "done", stop_reason: "tool_use" },
        ]);
      },
    };

    const result = await runSubagentTool({
      args: { prompt: "只允许一轮", maxTurns: 1 },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "lookup",
          description: "lookup",
          parameters: { type: "object", properties: {} },
        },
      ],
      onToolCall: (name) => {
        seenToolCalls.push(name);
        return "ok";
      },
    });

    expect(result.ok).toBe(true);
    expect(call).toBe(1);
    expect(seenToolCalls).toEqual(["lookup"]);
    expect(result.content).toContain("(no final text)");
    expect(result.content).toContain("Tools used: lookup");
  });

  it("loads custom subagents from user and project agent directories with project override", () => {
    withTempDir((root) => {
      const home = join(root, "home");
      const cwd = join(root, "repo");
      writeAgent(home, ".vera/agents/reviewer.md", [
        "---",
        "description: User reviewer",
        "tools: read_file, grep",
        "maxTurns: 7",
        "---",
        "Use the user reviewer prompt.",
      ].join("\n"));
      writeAgent(cwd, ".vera/agents/reviewer.md", [
        "---",
        "description: Project reviewer",
        "tools: read_file",
        "disallowedTools: grep",
        "permissionMode: readonly",
        "maxTurns: 3",
        "---",
        "Use the project reviewer prompt.",
      ].join("\n"));
      writeAgent(cwd, ".vera/agents/debugger.md", [
        "---",
        "name: custom_debugger",
        "description: Project debugger",
        "tools: '*'",
        "---",
        "Debug project failures.",
      ].join("\n"));

      const definitions = loadAgentDefinitions({ cwd, homeDir: home });
      const reviewer = definitions.find((agent) => agent.agentType === "reviewer");
      const debuggerAgent = definitions.find((agent) => agent.agentType === "custom_debugger");

      expect(reviewer).toMatchObject({
        source: "project",
        description: "Project reviewer",
        tools: ["read_file"],
        disallowedTools: ["grep"],
        permissionMode: "readonly",
        maxTurns: 3,
        systemPrompt: "Use the project reviewer prompt.",
      });
      expect(debuggerAgent).toMatchObject({
        source: "project",
        agentType: "custom_debugger",
        tools: "*",
      });
      expect(definitions.some((agent) => agent.agentType === "general-purpose")).toBe(true);
    });
  });

  it("parses custom agent frontmatter aliases and can skip user agents", () => {
    withTempDir((root) => {
      const home = join(root, "home");
      const cwd = join(root, "repo");
      writeAgent(home, ".vera/agents/user-only.md", "User scoped agent");
      writeAgent(cwd, ".vera/agents/ignored-empty.md", [
        "---",
        "description: ignored",
        "---",
        "   ",
      ].join("\n"));
      writeAgent(cwd, ".vera/agents/security.md", [
        "---",
        "agent_type: security-review",
        "whenToUse: Review security-sensitive changes",
        "tools: [read_file, grep, bash]",
        "disallowed_tools: [bash]",
        "permission_mode: readonly",
        "max_turns: 6",
        "---",
        "Review for auth and secret handling issues.",
      ].join("\n"));

      const definitions = loadAgentDefinitions({ cwd, homeDir: home, includeUser: false });
      const security = definitions.find((agent) => agent.agentType === "security-review");

      expect(definitions.some((agent) => agent.agentType === "user-only")).toBe(false);
      expect(definitions.some((agent) => agent.agentType === "ignored-empty")).toBe(false);
      expect(security).toMatchObject({
        description: "Review security-sensitive changes",
        tools: ["read_file", "grep", "bash"],
        disallowedTools: ["bash"],
        permissionMode: "readonly",
        maxTurns: 6,
        source: "project",
      });
    });
  });

  it("builds the agent tool schema with custom subagent types", () => {
    const schema = buildSubagentToolSchema([
      {
        agentType: "reviewer",
        description: "Review code",
        systemPrompt: "review",
        tools: ["read_file"],
        permissionMode: "readonly",
      },
    ]);

    expect(schema.parameters.properties.subagent_type).toMatchObject({
      enum: ["reviewer"],
    });
    expect(schema.parameters.properties.subagentType).toMatchObject({
      enum: ["reviewer"],
    });
    expect(subagentToolSchema.parameters.properties.subagent_type).toMatchObject({
      enum: expect.arrayContaining(["general-purpose", "explore", "plan"]),
    });
  });

  it("runs a custom subagent definition and enforces readonly permission mode", async () => {
    const captured: Array<{ system?: string; toolNames: string[] }> = [];
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        captured.push({
          system: request.system,
          toolNames: request.tools?.map((tool) => tool.name) ?? [],
        });
        return events([
          { type: "text", text: "自定义 agent 完成。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const result = await runSubagentTool({
      args: { prompt: "审查代码", subagent_type: "reviewer" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "bash",
          description: "bash",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "write_file",
          description: "write",
          parameters: { type: "object", properties: {} },
        },
      ],
      definitions: [
        {
          agentType: "reviewer",
          description: "Review code",
          systemPrompt: "You are the project reviewer.",
          tools: "*",
          permissionMode: "readonly",
        },
      ],
      onToolCall: () => "should not run",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Subagent (reviewer) result");
    expect(captured[0]!.toolNames).toEqual(["read_file"]);
    expect(captured[0]!.system).toContain("You are the project reviewer.");
  });

  it("does not let allowedTools re-enable disallowed custom-agent tools", async () => {
    const capturedToolNames: string[][] = [];
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: (request) => {
        capturedToolNames.push(request.tools?.map((tool) => tool.name) ?? []);
        return events([
          { type: "text", text: "done" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const result = await runSubagentTool({
      args: {
        prompt: "检查",
        subagent_type: "custom",
        allowedTools: ["read_file", "bash"],
      },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "bash",
          description: "bash",
          parameters: { type: "object", properties: {} },
        },
      ],
      definitions: [
        {
          agentType: "custom",
          description: "custom",
          systemPrompt: "custom prompt",
          tools: "*",
          disallowedTools: ["bash"],
          permissionMode: "default",
        },
      ],
      onToolCall: () => "should not run",
    });

    expect(result.ok).toBe(true);
    expect(capturedToolNames[0]).toEqual(["read_file"]);
  });

  it("applies built-in subagent tool policies", async () => {
    const requestedTools: string[] = [];
    let call = 0;
    const adapter: LLMAdapter = {
      complete: vi.fn(),
      stream: () => {
        call++;
        if (call === 1) {
          return events([
            {
              type: "tool_call",
              id: "tool-1",
              name: "bash",
              arguments: JSON.stringify({ command: "git status" }),
            },
            { type: "done", stop_reason: "tool_use" },
          ]);
        }
        return events([
          { type: "text", text: "探索结束。" },
          { type: "done", stop_reason: "end_turn" },
        ]);
      },
    };

    const result = await runSubagentTool({
      args: { task: "只读探索", subagentType: "explore" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "bash",
          description: "bash",
          parameters: { type: "object", properties: {} },
        },
      ],
      onToolCall: (name) => {
        requestedTools.push(name);
        return "should not run";
      },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Subagent (explore) result");
    expect(requestedTools).toEqual([]);
  });
});
