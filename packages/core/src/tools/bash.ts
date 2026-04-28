// bash — 执行 shell 命令

import { spawnSync } from "node:child_process";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { truncateChars } from "./utils/truncate.js";

interface BashArgs {
  command: string;
  timeout?: number;  // ms, defaults to 30000
}

export const bashTool: ToolDef<BashArgs> = {
  name: "bash",
  description:
    "Execute a shell command in the current working directory. " +
    "Returns stdout, stderr, and exit code. " +
    "Avoid interactive commands, long-running processes, or commands that require user input.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 30000)" },
    },
    required: ["command"],
  },
  options: { timeoutMs: 35_000, riskLevel: "high" },

  async execute(args: BashArgs, ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = args.timeout ?? 30_000;
    const start = Date.now();

    let result;
    try {
      result = spawnSync("bash", ["-c", args.command], {
        cwd: ctx.cwd,
        env: { ...process.env, ...(ctx.env ?? {}) },
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: "utf8",
      });
    } catch (e: unknown) {
      return errorResult("UNKNOWN", `Failed to spawn process: ${e instanceof Error ? e.message : String(e)}`);
    }

    const elapsed = Date.now() - start;

    if (result.error) {
      const msg = result.error.message ?? String(result.error);
      if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
        return errorResult("TIMEOUT", `Command timed out after ${timeoutMs}ms: ${args.command}`);
      }
      return errorResult("UNKNOWN", msg);
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const combined = [stdout, stderr].filter(Boolean).join("\n");

    const { content, truncated } = truncateChars(combined, 80_000);
    const exitCode = result.status ?? 0;

    return {
      ok: true,
      content: content || "(no output)",
      metadata: {
        exitCode,
        truncated,
        renderHint: { type: "bash-output", exitCode },
      },
    };
  },
};
