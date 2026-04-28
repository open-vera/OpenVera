import type { LLMAdapter } from "@open-vera/core/adapters";
import type { TestCase, RunResult, EvalResult } from "./types.js";

const LLM_JUDGE_SYSTEM = `You are an output quality evaluator. Given a task criteria and an actual output, decide if the output satisfies the criteria.
Respond with JSON only, no extra text:
{"passed": true|false, "score": 0.0-1.0, "reason": "one sentence"}`;

/** Extract the content under ## 准出标准 (or ## Exit Criteria) from a step README. */
export function parseExitCriteria(readme: string): string | undefined {
  const match = readme.match(/^##\s*(?:准出标准|Exit Criteria)[^\n]*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  return match?.[1].trim() || undefined;
}

async function runLlmJudge(
  adapter: LLMAdapter,
  model: string,
  criteria: string,
  output: string,
): Promise<{ passed: boolean; score: number; reason: string }> {
  const prompt = `Criteria:\n${criteria}\n\nActual output:\n${output}`;
  const response = await adapter.complete({
    model,
    system: LLM_JUDGE_SYSTEM,
    max_tokens: 128,
    messages: [{ role: "user", content: prompt }],
  });

  const text = typeof response.message.content === "string"
    ? response.message.content
    : response.message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");

  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

/**
 * 评估单个 case 的运行结果。
 * - exact：完全匹配
 * - contains：包含子串
 * - tool_match：检查调用的工具是否符合预期
 * - llm_judge：从 stepReadme 的 ## 准出标准 解析 criteria（或 testCase.criteria 显式覆盖），
 *              用轻量模型打分，score >= 0.7 视为通过
 */
export async function evaluate(
  testCase: TestCase,
  run: RunResult,
  adapter?: LLMAdapter,
  model?: string,
  stepReadme?: string,
): Promise<EvalResult> {
  if (run.error) {
    return {
      case_id: testCase.id,
      passed: false,
      reason: `Runtime error: ${run.error}`,
    };
  }

  switch (testCase.eval) {
    case "exact":
      return {
        case_id: testCase.id,
        passed: run.output.trim() === (testCase.expected_output ?? "").trim(),
      };

    case "contains":
      return {
        case_id: testCase.id,
        passed: run.output.includes(testCase.expected_output ?? ""),
      };

    case "tool_match": {
      const calledTools = run.tool_calls.map((t) => t.name);
      const expected = testCase.expected_tools ?? [];
      const missing = expected.filter((t) => !calledTools.includes(t));
      return {
        case_id: testCase.id,
        passed: missing.length === 0,
        reason: missing.length > 0 ? `Missing tools: ${missing.join(", ")}` : undefined,
      };
    }

    case "llm_judge": {
      if (!adapter || !model) {
        return {
          case_id: testCase.id,
          passed: false,
          reason: "llm_judge requires an adapter — pass adapter+model to evaluate()",
        };
      }
      // Explicit testCase.criteria overrides README; README is the default source
      const criteria =
        testCase.criteria ??
        (stepReadme ? parseExitCriteria(stepReadme) : undefined);

      if (!criteria) {
        return {
          case_id: testCase.id,
          passed: false,
          reason: "llm_judge: no criteria found — add ## 准出标准 to the step README",
        };
      }
      try {
        const { passed, score, reason } = await runLlmJudge(adapter, model, criteria, run.output);
        return { case_id: testCase.id, passed: passed && score >= 0.7, score, reason };
      } catch (err) {
        return {
          case_id: testCase.id,
          passed: false,
          reason: `llm_judge error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    default:
      return {
        case_id: testCase.id,
        passed: false,
        reason: "Unknown eval method",
      };
  }
}
