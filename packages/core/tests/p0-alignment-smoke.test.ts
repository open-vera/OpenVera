import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMAdapter } from "../src/adapters/base.js";
import { runSubagentTool, SUBAGENT_TOOL_NAME } from "../src/agent/subagent.js";
import { loadNestedProjectContext, loadProjectContext } from "../src/project-context/index.js";
import { SessionStore } from "../src/session/store.js";
import { createToolRegistry, SecurityPlugin } from "../src/tools/index.js";
import { readFileTool } from "../src/tools/read-file.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { mergeWorktreeChanges, removeBranchWorktree } from "../src/worktree/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeStreamingAdapterWithWriteFileCall(): LLMAdapter {
  let turn = 0;
  return {
    complete: async () => {
      throw new Error("not used in this smoke test");
    },
    stream: async function* () {
      turn++;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "tool-1",
          name: "write_file",
          arguments: JSON.stringify({ path: "SMOKE_SUBAGENT.txt", content: "written in isolated worktree\n" }),
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield { type: "text", text: "subagent done" };
      yield { type: "done", stop_reason: "end_turn" };
    },
  };
}

describe("P0 alignment smoke", () => {
  const tempDirs: string[] = [];
  const originalVeraHome = process.env.VERA_HOME;

  afterEach(() => {
    process.env.VERA_HOME = originalVeraHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("covers permission confirm + scoped context + subagent try + merge", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "vera-smoke-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vera-smoke-repo-"));
    tempDirs.push(tempHome, repo);
    process.env.VERA_HOME = tempHome;

    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    const workCwd = join(repo, "apps", "web");
    mkdirSync(workCwd, { recursive: true });
    mkdirSync(join(repo, ".vera", "rules"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, ".vera", "rules", "ts-rule.md"), [
      "---",
      "paths: src/**/*.ts",
      "---",
      "TypeScript scoped smoke rule",
    ].join("\n"));
    writeFileSync(join(repo, "src", "index.ts"), "export const smoke = true;\n");

    const externalFile = join(repo, "docs", "outside.md");
    mkdirSync(dirname(externalFile), { recursive: true });
    writeFileSync(externalFile, "outside\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "prepare smoke fixtures"]);

    const registry = new ToolRegistry();
    const security = new SecurityPlugin({ workdir: workCwd });
    registry.register(readFileTool);
    registry.use(security);

    const outsideArg = relative(workCwd, externalFile);
    const denied = await registry.execute("read_file", { path: outsideArg }, { cwd: workCwd, sessionId: "s1" });
    expect(denied.needsConfirm).toBeDefined();
    security.allowPath(denied.needsConfirm!.allowDir);
    const approved = await registry.execute("read_file", { path: outsideArg }, { cwd: workCwd, sessionId: "s1" });
    expect(approved.ok).toBe(true);
    expect(approved.content).toContain("outside");

    const initialContext = loadProjectContext({ cwd: repo, includeUser: false, includeGitStatus: false });
    expect(initialContext.system).not.toContain("TypeScript scoped smoke rule");
    const nestedContext = loadNestedProjectContext({
      cwd: repo,
      targetPath: "src/index.ts",
      loadedPaths: new Set(initialContext.files.map((f) => f.path)),
    });
    expect(nestedContext.system).toContain("TypeScript scoped smoke rule");

    const parentStore = new SessionStore({ cwd: repo });
    parentStore.writeStart("claude-sonnet-4-6", "anthropic");
    parentStore.writeUser("run smoke subagent");
    const adapter = makeStreamingAdapterWithWriteFileCall();
    const tools = createToolRegistry({ cwd: repo, sessionStore: parentStore }).toolHost.getSchemas();

    const subagentResult = await runSubagentTool({
      args: { prompt: "write isolated file", subagent_type: "general-purpose", isolation: "try" },
      adapter,
      model: "claude-sonnet-4-6",
      tools: [
        ...tools.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME),
        {
          name: "write_file",
          description: "write file",
          parameters: { type: "object", properties: {} },
        },
      ],
      cwd: repo,
      parentSessionId: parentStore.sessionId,
      onToolCall: async () => "(unused)",
      createToolHandlerForCwd: ({ cwd, sessionStore }) => {
        const bundle = createToolRegistry({ cwd, sessionStore });
        return async (name, args) => (await bundle.toolHost.execute(name, args, {
          cwd,
          sessionId: sessionStore?.sessionId ?? "child",
        })).content;
      },
    });

    expect(subagentResult.ok).toBe(true);
    const branchSummary = SessionStore.listSessions(repo).find((s) =>
      s.branch?.parentSessionId === parentStore.sessionId && s.branch?.worktreePath,
    );
    expect(branchSummary?.branch?.worktreePath).toBeTruthy();
    expect(branchSummary?.branch?.baseCommit).toBeTruthy();

    const worktreePath = branchSummary!.branch!.worktreePath!;
    const baseCommit = branchSummary!.branch!.baseCommit!;
    const worktreeBranch = branchSummary!.branch!.worktreeBranch!;
    const merged = mergeWorktreeChanges({
      worktreePath,
      baseCommit,
      targetCwd: repo,
      requireCleanTarget: true,
    });
    expect(merged.changed).toBe(true);
    expect(readFileSync(join(repo, "SMOKE_SUBAGENT.txt"), "utf8")).toContain("written in isolated worktree");

    expect(() => SessionStore.markBranchMerged(branchSummary!.sessionId, repo)).not.toThrow();

    removeBranchWorktree(repo, worktreePath, worktreeBranch);
  });
});
