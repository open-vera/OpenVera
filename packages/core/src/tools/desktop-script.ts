// desktop-script — 脚本执行工具
//
// 支持：AppleScript (macOS)、Shell 脚本 (跨平台)
// 用于操作 Finder/Safari/Terminal 等系统应用

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

type ScriptType = "applescript" | "shell" | "javascript";

interface DesktopScriptArgs {
  /** Script type */
  type: ScriptType;
  /** Script content to execute */
  script: string;
  /** Timeout in ms (default 30000) */
  timeout?: number;
  /** Working directory for shell scripts */
  cwd?: string;
  /** Environment variables for shell scripts */
  env?: Record<string, string>;
}

async function detectPlatform(): Promise<"darwin" | "linux" | "unknown"> {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unknown";
}

async function executeAppleScript(script: string, timeout: number): Promise<string> {
  const platform = await detectPlatform();
  if (platform !== "darwin") {
    throw new Error("AppleScript is only supported on macOS");
  }
  const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
    timeout,
    maxBuffer: 1024 * 1024,
  });
  if (stderr) return `stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`;
  return stdout.trim() || "(no output)";
}

async function executeShell(
  script: string,
  timeout: number,
  cwd?: string,
  env?: Record<string, string>
): Promise<string> {
  const { stdout, stderr } = await execAsync(script, {
    timeout,
    maxBuffer: 1024 * 1024,
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
  });
  if (stderr) return `stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`;
  return stdout.trim() || "(no output)";
}

async function executeJavaScript(script: string, timeout: number): Promise<string> {
  const platform = await detectPlatform();
  if (platform !== "darwin") {
    throw new Error("osascript JavaScript is only supported on macOS");
  }
  const { stdout, stderr } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    timeout,
    maxBuffer: 1024 * 1024,
  });
  if (stderr) return `stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`;
  return stdout.trim() || "(no output)";
}

export const desktopScriptTool: ToolDef<DesktopScriptArgs> = {
  name: "desktop_script",
  description:
    "Execute scripts on the desktop. " +
    "Types: applescript (macOS only, control Finder/Safari/etc), " +
    "shell (cross-platform shell commands), " +
    "javascript (macOS osascript JavaScript, access UI elements). " +
    "Use for system automation, app control, and UI inspection.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["applescript", "shell", "javascript"],
        description: "Script type to execute",
      },
      script: {
        type: "string",
        description: "Script content to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in ms (default 30000)",
      },
      cwd: {
        type: "string",
        description: "Working directory for shell scripts",
      },
      env: {
        type: "object",
        description: "Environment variables for shell scripts",
      },
    },
    required: ["type", "script"],
  },
  options: { timeoutMs: 60_000, riskLevel: "high" },

  async execute(args: DesktopScriptArgs, ctx: ToolContext): Promise<ToolResult> {
    const timeout = args.timeout ?? 30_000;

    try {
      let output: string;

      switch (args.type) {
        case "applescript":
          output = await executeAppleScript(args.script, timeout);
          break;

        case "shell":
          output = await executeShell(args.script, timeout, args.cwd ?? ctx.cwd, args.env);
          break;

        case "javascript":
          output = await executeJavaScript(args.script, timeout);
          break;

        default:
          return errorResult("UNKNOWN", `Unknown script type: ${String(args.type)}`);
      }

      return {
        ok: true,
        content: output,
        metadata: {
          renderHint: { type: "code", lang: args.type === "shell" ? "bash" : args.type },
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult("EXEC_ERROR", `Script execution failed: ${msg}`);
    }
  },
};
