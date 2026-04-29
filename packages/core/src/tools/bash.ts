// bash — 执行 shell 命令（流式输出收集 + 超限提前终止）

import { spawn } from "node:child_process";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { truncateChars } from "./utils/truncate.js";

/** 流式收集阈值：超过此大小立即 kill 进程，避免等待命令结束 */
const STREAMING_OUTPUT_LIMIT = 512 * 1024; // 512KB

/** Kill 整个进程组（包括 shell 的子进程如 `yes`、`cat` 等） */
function killProcessGroup(child: { pid?: number }): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // 进程已退出或 pid 无效，忽略
  }
}

interface BashArgs {
  command: string;
  timeout?: number; // ms, defaults to 30000
  __confirmedRisk?: boolean;
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
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)",
      },
    },
    required: ["command"],
  },
  options: { timeoutMs: 35_000, riskLevel: "high" },

  async execute(args: BashArgs, ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = args.timeout ?? 30_000;

    return new Promise<ToolResult>((resolve) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let killed = false;
      let killReason: "size" | "timeout" | "abort" | null = null;

      let child;
      try {
        child = spawn("bash", ["-c", args.command], {
          cwd: ctx.cwd,
          env: { ...process.env, ...(ctx.env ?? {}) },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true, // 创建独立进程组，便于 kill 整个子树
        });
      } catch (e: unknown) {
        resolve(
          errorResult(
            "UNKNOWN",
            `Failed to spawn process: ${e instanceof Error ? e.message : String(e)}`
          )
        );
        return;
      }

      // 超时 kill
      const timer = setTimeout(() => {
        if (!killed) {
          killed = true;
          killReason = "timeout";
          killProcessGroup(child);
        }
      }, timeoutMs);

      // AbortSignal 取消
      const onAbort = (): void => {
        if (!killed) {
          killed = true;
          killReason = "abort";
          killProcessGroup(child);
        }
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      // 流式收集 stdout
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (killed) return;
        stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (stdoutBuf.length > STREAMING_OUTPUT_LIMIT) {
          killed = true;
          killReason = "size";
          killProcessGroup(child);
        }
      });

      // 流式收集 stderr
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (killed) return;
        stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (stderrBuf.length > STREAMING_OUTPUT_LIMIT) {
          killed = true;
          killReason = "size";
          killProcessGroup(child);
        }
      });

      // close 事件：所有 stdio 流已关闭，安全拼接结果
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);

        // 超时错误
        if (killReason === "timeout") {
          resolve(
            errorResult(
              "TIMEOUT",
              `Command timed out after ${timeoutMs}ms: ${args.command}`
            )
          );
          return;
        }

        // 外部取消
        if (killReason === "abort") {
          resolve(errorResult("UNKNOWN", "Command was aborted"));
          return;
        }

        const stdout = stdoutBuf;
        const stderr = stderrBuf;
        const combined = [stdout, stderr].filter(Boolean).join("\n");

        // 流式截断标记：进程因输出过大被 kill
        const streamTruncated = killReason === "size";

        // 最终安全网截断（80K）
        const { content, truncated: charsTruncated } = truncateChars(
          combined,
          80_000
        );

        const truncated = streamTruncated || charsTruncated;

        // exitCode：被 SIGTERM kill 时 exitCode 可能为 null
        const code = exitCode ?? (signal === "SIGTERM" ? 137 : 1);

        // 截断原因提示
        let finalContent = content || "(no output)";
        if (streamTruncated && !charsTruncated) {
          finalContent += `\n[... output exceeded ${Math.round(STREAMING_OUTPUT_LIMIT / 1024)}KB limit — process terminated early]`;
        }

        resolve({
          ok: true,
          content: finalContent,
          metadata: {
            exitCode: code,
            truncated,
            renderHint: { type: "bash-output", exitCode: code },
          },
        });
      });

      // spawn 错误（如命令不存在）
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(errorResult("UNKNOWN", `Process error: ${err.message}`));
      });
    });
  },
};
