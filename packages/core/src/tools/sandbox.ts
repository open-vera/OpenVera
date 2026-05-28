/**
 * Sandbox tools — Execute commands, upload/download files in a sandbox.
 *
 * Three tools: sandbox_exec, sandbox_upload, sandbox_download.
 * Requires a SandboxProvider in the tool context.
 */

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { readFile } from "node:fs/promises";

// ── sandbox_exec ───────────────────────────────────────────────────────────

export interface SandboxExecArgs {
  /** Sandbox ID to execute the command in */
  sandboxId: string;
  /** Command to execute */
  command: string;
  /** Working directory inside the sandbox */
  workdir?: string;
  /** Environment variables for this command */
  env?: Record<string, string>;
  /** Timeout in seconds (default: 120) */
  timeoutSeconds?: number;
}

export function createSandboxExecTool(): ToolDef<SandboxExecArgs> {
  return {
    name: "sandbox_exec",
    description:
      "Execute a command inside a running sandbox. " +
      "Use this to run scripts, install dependencies, compile code, or any shell operation inside the sandbox.",
    parameters: {
      type: "object" as const,
      required: ["sandboxId", "command"],
      properties: {
        sandboxId: {
          type: "string" as const,
          description: "Sandbox ID to execute the command in",
        },
        command: {
          type: "string" as const,
          description: "Command to execute (shell syntax supported)",
        },
        workdir: {
          type: "string" as const,
          description: "Working directory inside the sandbox",
        },
        env: {
          type: "object" as const,
          description: "Environment variables for this command (e.g. {NODE_ENV: 'test'})",
        },
        timeoutSeconds: {
          type: "number" as const,
          description: "Timeout in seconds (default: 120)",
        },
      },
    },
    execute: async (args: SandboxExecArgs, ctx: ToolContext): Promise<ToolResult> => {
      const provider = ctx.sandboxProvider;
      if (!provider) {
        return errorResult("UNKNOWN", "SandboxProvider not available in context", false);
      }

      try {
        const instance = await provider.get(args.sandboxId);
        if (!instance) {
          return errorResult("NOT_FOUND", `Sandbox not found: ${args.sandboxId}`, false);
        }

        const result = await instance.exec(args.command, {
          workdir: args.workdir,
          env: args.env,
          timeoutSeconds: args.timeoutSeconds ?? 120,
        });

        const parts: string[] = [];
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
        parts.push(`exit code: ${result.exitCode ?? "running"}`);
        parts.push(`duration: ${result.durationMs}ms`);
        if (result.timedOut) parts.push("TIMED OUT");

        return {
          ok: result.exitCode === 0,
          content: parts.join("\n"),
          metadata: {
            exitCode: result.exitCode ?? undefined,
          },
          error: result.exitCode !== 0 && result.exitCode !== null
            ? {
                code: "EXEC_ERROR",
                message: `Command exited with code ${result.exitCode}`,
                retryable: false,
              }
            : undefined,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult("EXEC_ERROR", `sandbox_exec failed: ${msg}`, false);
      }
    },
  };
}

// ── sandbox_upload ─────────────────────────────────────────────────────────

export interface SandboxUploadArgs {
  /** Sandbox ID to upload to */
  sandboxId: string;
  /** Local file path to upload from */
  localPath?: string;
  /** Inline content to upload (mutually exclusive with localPath) */
  content?: string;
  /** Remote path inside the sandbox */
  remotePath: string;
}

export function createSandboxUploadTool(): ToolDef<SandboxUploadArgs> {
  return {
    name: "sandbox_upload",
    description:
      "Upload a file into a sandbox. " +
      "Use either a local file path or inline content. " +
      "This is how you get code, data, or configuration files into the sandbox.",
    parameters: {
      type: "object" as const,
      required: ["sandboxId", "remotePath"],
      properties: {
        sandboxId: {
          type: "string" as const,
          description: "Sandbox ID to upload to",
        },
        localPath: {
          type: "string" as const,
          description: "Local file path to upload from",
        },
        content: {
          type: "string" as const,
          description: "Inline content to upload (mutually exclusive with localPath)",
        },
        remotePath: {
          type: "string" as const,
          description: "Remote path inside the sandbox (e.g. /app/index.js)",
        },
      },
    },
    execute: async (args: SandboxUploadArgs, ctx: ToolContext): Promise<ToolResult> => {
      const provider = ctx.sandboxProvider;
      if (!provider) {
        return errorResult("UNKNOWN", "SandboxProvider not available in context", false);
      }

      if (!args.localPath && args.content === undefined) {
        return errorResult("UNKNOWN", "Provide either localPath or content", false);
      }

      try {
        const instance = await provider.get(args.sandboxId);
        if (!instance) {
          return errorResult("NOT_FOUND", `Sandbox not found: ${args.sandboxId}`, false);
        }

        if (args.localPath) {
          await instance.upload(args.localPath, args.remotePath);
        } else {
          await instance.uploadContent(args.content!, args.remotePath);
        }

        return {
          ok: true,
          content: `Uploaded to ${args.remotePath} in sandbox ${args.sandboxId}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult("EXEC_ERROR", `sandbox_upload failed: ${msg}`, false);
      }
    },
  };
}

// ── sandbox_download ───────────────────────────────────────────────────────

export interface SandboxDownloadArgs {
  /** Sandbox ID to download from */
  sandboxId: string;
  /** Remote path inside the sandbox */
  remotePath: string;
  /** Local path to save the file to (optional, returns content if omitted) */
  localPath?: string;
}

export function createSandboxDownloadTool(): ToolDef<SandboxDownloadArgs> {
  return {
    name: "sandbox_download",
    description:
      "Download a file from a sandbox. " +
      "If localPath is provided, saves to disk; otherwise returns the content directly.",
    parameters: {
      type: "object" as const,
      required: ["sandboxId", "remotePath"],
      properties: {
        sandboxId: {
          type: "string" as const,
          description: "Sandbox ID to download from",
        },
        remotePath: {
          type: "string" as const,
          description: "Remote path inside the sandbox (e.g. /app/output.json)",
        },
        localPath: {
          type: "string" as const,
          description: "Local path to save the file to (optional, returns content if omitted)",
        },
      },
    },
    execute: async (args: SandboxDownloadArgs, ctx: ToolContext): Promise<ToolResult> => {
      const provider = ctx.sandboxProvider;
      if (!provider) {
        return errorResult("UNKNOWN", "SandboxProvider not available in context", false);
      }

      try {
        const instance = await provider.get(args.sandboxId);
        if (!instance) {
          return errorResult("NOT_FOUND", `Sandbox not found: ${args.sandboxId}`, false);
        }

        if (args.localPath) {
          await instance.download(args.remotePath, args.localPath);
          return {
            ok: true,
            content: `Downloaded ${args.remotePath} to ${args.localPath}`,
          };
        }

        const content = await instance.readFile(args.remotePath);
        return {
          ok: true,
          content,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult("EXEC_ERROR", `sandbox_download failed: ${msg}`, false);
      }
    },
  };
}

// ── Bundle ─────────────────────────────────────────────────────────────────

export interface SandboxToolSet {
  sandboxExec: ToolDef<SandboxExecArgs>;
  sandboxUpload: ToolDef<SandboxUploadArgs>;
  sandboxDownload: ToolDef<SandboxDownloadArgs>;
}

export function createSandboxTools(): SandboxToolSet {
  return {
    sandboxExec: createSandboxExecTool(),
    sandboxUpload: createSandboxUploadTool(),
    sandboxDownload: createSandboxDownloadTool(),
  };
}
