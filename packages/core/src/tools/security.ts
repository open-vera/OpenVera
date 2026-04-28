// SecurityPlugin — 工具执行前的安全与权限检查

import { resolve } from "node:path";
import type { ToolLifecycleHook, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { isInsideCwd } from "./utils/path.js";

export interface SecurityConfig {
  allowedTools?: string[];          // 白名单，空表示全部允许
  workdir?: string;                 // 限制文件操作路径
  allowedDomains?: string[];        // web 工具域名白名单
  readonlyMode?: boolean;           // 禁止所有写操作
  budgetUsd?: number;               // 费用上限
  usdUsed?: number;                 // 已使用费用（外部更新）
}

// Tools that write files/run commands — blocked in readonly mode
const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "bash",
]);

// Tools that take a file path argument
const FILE_PATH_TOOLS = new Set([
  "read_file", "write_file", "edit_file",
]);

// Tools that take a URL/domain argument
const NETWORK_TOOLS = new Set(["web_search", "fetch_url"]);

// Simple prompt injection heuristics
const INJECTION_PATTERNS = [
  /ignore previous instructions/i,
  /disregard (all|your) (previous|prior|earlier)/i,
  /you are now/i,
  /new system prompt/i,
  /\bSYSTEM:\s/,
  /\bINSTRUCTION:\s/,
];

export class SecurityPlugin implements ToolLifecycleHook {
  private config: SecurityConfig;
  private allowedPaths: Set<string> = new Set();

  constructor(config: SecurityConfig = {}) {
    this.config = config;
  }

  updateBudgetUsed(usdUsed: number): void {
    this.config.usdUsed = usdUsed;
  }

  /** Dynamically whitelist a directory for this session (called after user confirms). */
  allowPath(dir: string): void {
    this.allowedPaths.add(resolve(dir));
  }

  async onBeforeToolCall(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult | null> {
    // 1. Tool whitelist
    if (
      this.config.allowedTools &&
      this.config.allowedTools.length > 0 &&
      !this.config.allowedTools.includes(name)
    ) {
      return errorResult("PERMISSION_DENIED", `Tool "${name}" is not in the allowed tools list.`);
    }

    // 2. Readonly mode
    if (this.config.readonlyMode && WRITE_TOOLS.has(name)) {
      return errorResult("PERMISSION_DENIED", `Tool "${name}" is not allowed in readonly mode.`);
    }

    // 3. Budget check
    if (
      this.config.budgetUsd !== undefined &&
      this.config.usdUsed !== undefined &&
      this.config.usdUsed >= this.config.budgetUsd
    ) {
      return errorResult(
        "BUDGET_EXCEEDED",
        `Budget exceeded: used $${this.config.usdUsed.toFixed(4)} of $${this.config.budgetUsd.toFixed(4)}.`
      );
    }

    // 4. Path boundary check
    const workdir = this.config.workdir ?? ctx.cwd;
    if (FILE_PATH_TOOLS.has(name)) {
      const pathArg = args.path ?? args.file_path ?? args.filepath;
      if (typeof pathArg === "string") {
        const resolved = resolve(ctx.cwd, pathArg);
        const inWorkdir = isInsideCwd(resolved, workdir);
        const inAllowedPath = [...this.allowedPaths].some((p) => isInsideCwd(resolved, p));
        if (!inWorkdir && !inAllowedPath) {
          const allowDir = resolve(resolved, "..");
          return {
            ok: false,
            content: `Path is outside allowed workdir.\n  Allowed: ${workdir}\n  Got:     ${resolved}`,
            error: { code: "PATH_OUTSIDE_CWD", message: `Path is outside allowed workdir: ${resolved}`, retryable: true },
            needsConfirm: {
              message: `Agent wants to access a path outside the working directory:\n  ${resolved}\n\nAllow access to "${allowDir}"?`,
              allowDir,
              retry: { name, args },
            },
          };
        }
      }
    }

    // 5. Domain whitelist
    if (NETWORK_TOOLS.has(name) && this.config.allowedDomains?.length) {
      const urlArg = args.url ?? args.query;
      if (typeof urlArg === "string") {
        try {
          const domain = new URL(urlArg).hostname;
          const allowed = this.config.allowedDomains.some(
            (d) => domain === d || domain.endsWith("." + d)
          );
          if (!allowed) {
            return errorResult(
              "PERMISSION_DENIED",
              `Domain "${domain}" is not in the allowed domains list.`
            );
          }
        } catch {
          // Not a full URL (e.g. search query) — allow through
        }
      }
    }

    // 6. Prompt injection check on string args
    for (const val of Object.values(args)) {
      if (typeof val === "string" && INJECTION_PATTERNS.some((p) => p.test(val))) {
        return errorResult(
          "PERMISSION_DENIED",
          "Potential prompt injection detected in tool arguments."
        );
      }
    }

    return null; // allow
  }
}
