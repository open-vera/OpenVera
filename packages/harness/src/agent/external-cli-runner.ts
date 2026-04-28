import { spawnSync } from "node:child_process";
import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions } from "../runtime/internal.js";
import type { AgentRunner } from "./types.js";

export interface ExternalCliRunnerOptions {
  /**
   * The CLI command to run (e.g. "opencode", "codex", "aider").
   */
  command: string;
  /**
   * Static args always prepended (e.g. ["--json", "--no-color"]).
   */
  baseArgs?: string[];
  /**
   * How to pass the prompt to the CLI:
   *   "arg"   — appended as the last positional argument (default)
   *   "stdin" — written to the process's stdin
   */
  promptMode?: "arg" | "stdin";
  /**
   * Working directory override. If omitted, uses assignment.scope.workdir.
   */
  cwd?: string;
  /**
   * Extra env vars merged into the child process environment.
   */
  env?: Record<string, string>;
  /**
   * Timeout in milliseconds (default: 5 minutes).
   */
  timeoutMs?: number;
  /**
   * Extract the agent output from stdout. Default: return raw stdout.
   * Useful when the CLI wraps output in JSON.
   */
  parseOutput?: (stdout: string, stderr: string) => string;
}

/**
 * ExternalCliRunner — runs an external CLI agent as a subprocess.
 *
 * Suitable for: opencode, codex CLI, aider, or any agent that accepts
 * a prompt as a CLI argument or stdin and writes its result to stdout.
 *
 * Tool calls are NOT supported in this runner — the external agent manages
 * its own tool execution internally.
 */
export class ExternalCliRunner implements AgentRunner {
  constructor(private readonly opts: ExternalCliRunnerOptions) {}

  async run(
    assignment: AgentAssignment,
    _options: RunAssignmentOptions
  ): Promise<StepResult> {
    const prompt = this.buildPrompt(assignment);
    const cwd =
      this.opts.cwd ?? assignment.scope.workdir ?? process.cwd();
    const timeoutMs = this.opts.timeoutMs ?? 5 * 60 * 1000;

    const args = [...(this.opts.baseArgs ?? [])];
    const promptMode = this.opts.promptMode ?? "arg";

    if (promptMode === "arg") {
      args.push(prompt);
    }

    const result = spawnSync(this.opts.command, args, {
      cwd,
      input: promptMode === "stdin" ? prompt : undefined,
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, ...this.opts.env },
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });

    if (result.error) {
      throw new Error(
        `ExternalCliRunner: failed to spawn "${this.opts.command}": ${result.error.message}`
      );
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";

    if (result.status !== 0) {
      throw new Error(
        `ExternalCliRunner: "${this.opts.command}" exited with code ${result.status}.\n${stderr}`
      );
    }

    const output = this.opts.parseOutput
      ? this.opts.parseOutput(stdout, stderr)
      : stdout.trim();

    return {
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output,
      toolCalls: [],
    };
  }

  private buildPrompt(assignment: AgentAssignment): string {
    const context = assignment.contextSlices.length > 0
      ? `\nContext:\n${assignment.contextSlices.join("\n\n")}`
      : "";

    return [
      `Goal: ${assignment.goal}`,
      ``,
      `Task: ${assignment.instruction}`,
      `Workdir: ${assignment.scope.workdir ?? process.cwd()}`,
      context,
    ].join("\n");
  }
}
