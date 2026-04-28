import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter, CompletionResponse } from "../src/adapters/base.js";
import type { ToolResult } from "../src/tools/types.js";
import {
  classifyIntent,
  resolveModel,
  routeTarget,
  shouldPlan,
} from "../src/intent/classifier.js";
import { retryWithPolicy } from "../src/tools/executor.js";
import { listDirTool } from "../src/tools/list-dir.js";
import { readFileTool } from "../src/tools/read-file.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { SecurityPlugin } from "../src/tools/security.js";
import { errorResult } from "../src/tools/types.js";

function adapterWithText(text: string, usage?: CompletionResponse["usage"]): LLMAdapter {
  const response: CompletionResponse = {
    message: { role: "assistant", content: text },
    stop_reason: "end_turn",
    ...(usage ? { usage } : {}),
  };
  return {
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
  };
}

const SIMPLE_INTENT_JSON = `{"level":1,"needs_tools":false,"needs_planning":false,"domain":"chat","reason":"simple"}`;

describe("intent routing", () => {
  it("parses fenced classifier JSON", async () => {
    const adapter = adapterWithText(`Here is the result:
\`\`\`json
{
  "level": 3,
  "needs_tools": true,
  "needs_planning": true,
  "domain": "code",
  "reason": "multi-file change"
}
\`\`\``);

    const intent = await classifyIntent("refactor auth", adapter, "classifier-model");

    expect(intent).toMatchObject({
      level: 3,
      needs_tools: true,
      needs_planning: true,
      domain: "code",
    });
    expect(adapter.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "classifier-model",
        messages: [{ role: "user", content: "refactor auth" }],
      }),
    );
  });

  it("routes by configured level and falls back to defaults", async () => {
    const l2 = {
      level: 2,
      needs_tools: true,
      needs_planning: false,
      domain: "code",
      reason: "uses tools",
    } as const;
    const l0 = {
      level: 0,
      needs_tools: false,
      needs_planning: false,
      domain: "chat",
      reason: "chat",
    } as const;

    expect(routeTarget(l2, { l2: { provider: "openai", model: "gpt-4o" } })).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(routeTarget(l0, {})).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("surfaces classifier failures from resolveModel", async () => {
    const adapter: LLMAdapter = {
      complete: vi.fn().mockRejectedValue(new Error("classifier down")),
      stream: vi.fn(),
    };

    await expect(
      resolveModel("hello", adapter, "classifier", {}, "anthropic", "fallback"),
    ).rejects.toThrow("classifier down");
  });

  it("plans for explicit planning signals or L3 tasks", () => {
    expect(shouldPlan({
      level: 2,
      needs_tools: true,
      needs_planning: true,
      domain: "analysis",
      reason: "needs a plan",
    })).toBe(true);
    expect(shouldPlan({
      level: 3,
      needs_tools: true,
      needs_planning: false,
      domain: "code",
      reason: "complex",
    })).toBe(true);
    expect(shouldPlan({
      level: 1,
      needs_tools: true,
      needs_planning: false,
      domain: "code",
      reason: "simple",
    })).toBe(false);
  });

  it("classifyIntent calls onUsage with usage when adapter returns it", async () => {
    const usageFromApi = { input_tokens: 42, output_tokens: 8 };
    const adapter = adapterWithText(SIMPLE_INTENT_JSON, usageFromApi);
    const collected: typeof usageFromApi[] = [];

    await classifyIntent("hello", adapter, "haiku", (u) => collected.push(u as typeof usageFromApi));

    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(usageFromApi);
  });

  it("classifyIntent does not throw when no onUsage is provided and adapter returns usage", async () => {
    const adapter = adapterWithText(SIMPLE_INTENT_JSON, { input_tokens: 10, output_tokens: 5 });
    await expect(classifyIntent("hello", adapter, "haiku")).resolves.not.toThrow();
  });

  it("classifyIntent skips onUsage when adapter response has no usage", async () => {
    const adapter = adapterWithText(SIMPLE_INTENT_JSON);
    const collected: unknown[] = [];

    await classifyIntent("hello", adapter, "haiku", (u) => collected.push(u));

    expect(collected).toHaveLength(0);
  });

  it("resolveModel forwards usage to onUsage callback", async () => {
    const usageFromApi = { input_tokens: 55, output_tokens: 12 };
    const adapter = adapterWithText(SIMPLE_INTENT_JSON, usageFromApi);
    const collected: typeof usageFromApi[] = [];

    await resolveModel("hi", adapter, "haiku", {}, "anthropic", "fallback", (u) =>
      collected.push(u as typeof usageFromApi),
    );

    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(usageFromApi);
  });

  it("resolveModel works without onUsage callback", async () => {
    const adapter = adapterWithText(SIMPLE_INTENT_JSON, { input_tokens: 10, output_tokens: 5 });
    const result = await resolveModel("hi", adapter, "haiku", {}, "anthropic", "fallback");
    expect(result.intent).not.toBeNull();
  });
});

describe("tool runtime", () => {
  it("runs hooks around successful tool execution", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];

    registry.register({
      name: "echo",
      description: "Echo input",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return { ok: true, content: String(args.value), metadata: { renderHint: { type: "text" } } };
      },
    });
    registry.use({
      async onBeforeToolCall(name) {
        events.push(`before:${name}`);
        return null;
      },
      async onAfterToolCall(name, _args, result) {
        events.push(`after:${name}:${result.content}`);
      },
    });

    const result = await registry.execute("echo", { value: "ok" }, {
      cwd: "/tmp",
      sessionId: "s1",
    });

    expect(result).toMatchObject({ ok: true, content: "ok" });
    expect(result.metadata?.renderHint).toEqual({ type: "text" });
    expect(events).toEqual(["before:echo", "after:echo:ok"]);
  });

  it("lets a before hook short-circuit execution and skip after hooks", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn();
    const after = vi.fn();

    registry.register({
      name: "danger",
      description: "Dangerous tool",
      parameters: { type: "object", properties: {} },
      execute,
    });
    registry.use({
      async onBeforeToolCall() {
        return errorResult("PERMISSION_DENIED", "blocked");
      },
      onAfterToolCall: after,
    });

    const result = await registry.execute("danger", {}, { cwd: "/tmp", sessionId: "s1" });

    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(execute).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("retries only retryable tool failures", async () => {
    const retryable = vi
      .fn<() => Promise<ToolResult>>()
      .mockResolvedValueOnce(errorResult("EXEC_ERROR", "temporary", true))
      .mockResolvedValueOnce({ ok: true, content: "recovered" });

    await expect(retryWithPolicy(retryable, 2)).resolves.toMatchObject({
      ok: true,
      content: "recovered",
    });
    expect(retryable).toHaveBeenCalledTimes(2);

    const permanent = vi
      .fn<() => Promise<ToolResult>>()
      .mockResolvedValue(errorResult("PERMISSION_DENIED", "no", false));

    await expect(retryWithPolicy(permanent, 3)).resolves.toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it("allows file tools to use user-approved paths outside cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-tool-auth-"));
    const cwd = join(root, "packages", "harness");
    const externalFile = join(root, "packages", "core", "README.md");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dirname(externalFile), { recursive: true });
    writeFileSync(externalFile, "core docs\n", "utf8");

    const registry = new ToolRegistry();
    const security = new SecurityPlugin({ workdir: cwd });
    registry.register(readFileTool);
    registry.use(security);

    const pathArg = relative(cwd, externalFile);
    const denied = await registry.execute("read_file", { path: pathArg }, {
      cwd,
      sessionId: "s1",
    });

    expect(denied.error?.code).toBe("PATH_OUTSIDE_CWD");
    expect(denied.needsConfirm).toBeDefined();

    security.allowPath(denied.needsConfirm!.allowDir);
    const approved = await registry.execute("read_file", { path: pathArg }, {
      cwd,
      sessionId: "s1",
    });

    expect(approved.ok).toBe(true);
    expect(approved.content).toContain("core docs");
  });

  it("allows paths inside configured workdir even when outside cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-tool-workdir-"));
    const cwd = join(root, "packages", "harness");
    const siblingFile = join(root, "packages", "core", "README.md");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dirname(siblingFile), { recursive: true });
    writeFileSync(siblingFile, "workspace docs\n", "utf8");

    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.use(new SecurityPlugin({ workdir: root }));

    const result = await registry.execute("read_file", {
      path: relative(cwd, siblingFile),
    }, {
      cwd,
      sessionId: "s1",
    });

    expect(result.ok).toBe(true);
    expect(result.needsConfirm).toBeUndefined();
    expect(result.content).toContain("workspace docs");
  });

  it("allows list_dir to inspect configured workdir outside cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-listdir-workdir-"));
    const cwd = join(root, "packages", "harness");
    const siblingDir = join(root, "packages", "core", "tests");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, "example.test.ts"), "test\n", "utf8");

    const registry = new ToolRegistry();
    registry.register(listDirTool);
    registry.use(new SecurityPlugin({ workdir: root }));

    const result = await registry.execute("list_dir", {
      path: relative(cwd, siblingDir),
    }, {
      cwd,
      sessionId: "s1",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("example.test.ts");
  });

  it("tells the model to use list_dir when read_file receives a directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-read-dir-"));
    const cwd = join(root, "packages", "harness");
    const dir = join(root, "packages", "core");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dir, { recursive: true });

    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.use(new SecurityPlugin({ workdir: root }));

    const result = await registry.execute("read_file", {
      path: relative(cwd, dir),
    }, {
      cwd,
      sessionId: "s1",
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("is a directory");
    expect(result.content).toContain("Use list_dir");
  });

  it("applies denied tool rules before execution", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn();
    registry.register({
      name: "bash",
      description: "bash",
      parameters: { type: "object", properties: {} },
      execute,
    });
    registry.use(new SecurityPlugin({ deniedTools: ["bash"] }));

    const result = await registry.execute("bash", { command: "echo ok" }, {
      cwd: "/tmp",
      sessionId: "s1",
    });

    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires confirmation for risky bash commands", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({ ok: true, content: "done" });
    registry.register({
      name: "bash",
      description: "bash",
      parameters: { type: "object", properties: {} },
      execute,
    });
    registry.use(new SecurityPlugin());

    const denied = await registry.execute("bash", { command: "rm -rf dist" }, {
      cwd: "/tmp",
      sessionId: "s1",
    });

    expect(denied.needsConfirm?.retry.args.__confirmedRisk).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const approved = await registry.execute("bash", denied.needsConfirm!.retry.args, {
      cwd: "/tmp",
      sessionId: "s1",
    });

    expect(approved.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
