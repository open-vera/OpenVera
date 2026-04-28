import type { LLMAdapter } from "@open-vera/core/adapters";
import type { AgentOptions } from "@open-vera/core/agent";
import type { Tool } from "@open-vera/core/types";
import type { TestCase, RunResult, ToolCallRecord } from "./types.js";
import type { SkillResolver, IntentSignal } from "./skill/index.js";

export interface RunnerOptions {
  adapter: LLMAdapter;
  model: string;
  tools?: Tool[];
  system?: string;
  maxTurns?: number;
  /** Optional: resolve tools + system via skill system instead of static tools */
  skillResolver?: SkillResolver;
  /** Intent signal used by skillResolver; defaults to code/L1/needs_tools */
  intent?: IntentSignal;
}

/**
 * 执行单个 test case，记录工具调用、token 消耗、耗时。
 */
export async function runCase(
  testCase: TestCase,
  options: RunnerOptions
): Promise<RunResult> {
  const { streamAgent } = await import("@open-vera/core/agent");

  // Resolve tools + system via skill resolver if provided
  let tools: Tool[] | undefined = options.tools;
  let system: string | undefined = options.system;
  let executors: Map<string, (args: Record<string, unknown>) => Promise<string> | string> | undefined;

  if (options.skillResolver) {
    const intent: IntentSignal = options.intent ?? {
      domain: "code",
      level: 1,
      needs_tools: true,
    };
    const bundle = options.skillResolver.resolve(intent, system ?? "You are Vera, a helpful assistant.");
    tools = bundle.tools;
    system = bundle.system;
    executors = bundle.executors;
  }

  const toolCalls: ToolCallRecord[] = [];
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  const start = Date.now();

  const agentOptions: AgentOptions = {
    adapter: options.adapter,
    model: options.model,
    tools,
    system,
    maxTurns: options.maxTurns,
    onToolCall: async (name: string, args: Record<string, unknown>) => {
      let result: string;
      if (executors?.has(name)) {
        result = await executors.get(name)!(args);
      } else {
        result = `[harness] tool "${name}" called (no executor registered)`;
      }
      toolCalls.push({ name, arguments: args, result });
      return result;
    },
  };

  let output = "";
  let turns = 0;
  let error: string | undefined;

  try {
    output = await streamAgent(testCase.input, agentOptions, () => {
      turns++;
    });
  } catch (err) {
    error = String(err);
  }

  return {
    case_id: testCase.id,
    output,
    tool_calls: toolCalls,
    turns,
    usage: totalUsage,
    duration_ms: Date.now() - start,
    error,
  };
}

/**
 * 批量运行，并发度可控。
 */
export async function runSuite(
  cases: TestCase[],
  options: RunnerOptions,
  concurrency = 3
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < cases.length; i += concurrency) {
    const batch = cases.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((c) => runCase(c, options))
    );
    results.push(...batchResults);
  }
  return results;
}
