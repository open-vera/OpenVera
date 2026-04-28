import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions } from "../runtime/internal.js";

/**
 * AgentRunner — pluggable agent execution backend.
 *
 * Implement this interface to integrate any agent:
 *   - Local LLM loop (StreamAgentRunner, the default)
 *   - External CLI subprocess (ExternalCliRunner)
 *   - Remote HTTP agent API
 *   - Specialized coding agents (opencode, codex, etc.)
 */
export interface AgentRunner {
  /**
   * Execute one agent assignment and return the result.
   * The runner is responsible for all tool dispatch and producing
   * a final text output.
   */
  run(
    assignment: AgentAssignment,
    options: RunAssignmentOptions
  ): Promise<StepResult>;
}

/**
 * Registry of named AgentRunners.
 * "default" is used when a step has no assignedAgent.
 */
export type AgentRunnerMap = Map<string, AgentRunner>;
