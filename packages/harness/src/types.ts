// Case 定义和结果类型
// ToolCallRecord 统一定义在 core/types/runtime.ts，此处 re-export 以避免重复。

import type { ToolCallRecord } from "@open-vera/core/types";
export type { ToolCallRecord };

export type EvalMethod = "exact" | "contains" | "llm_judge" | "tool_match";

export interface TestCase {
  id: string;
  input: string;
  expected_tools?: string[]; // 期望调用的工具名
  eval: EvalMethod;
  criteria?: string; // llm_judge 时的评判标准
  expected_output?: string; // exact / contains 时的期望输出
}

export interface RunResult {
  case_id: string;
  output: string;
  tool_calls: ToolCallRecord[];
  turns: number;
  usage: { input_tokens: number; output_tokens: number };
  duration_ms: number;
  error?: string;
}

export interface EvalResult {
  case_id: string;
  passed: boolean;
  score?: number; // 0-1，llm_judge 用
  reason?: string;
}

export interface ReportEntry {
  run: RunResult;
  eval: EvalResult;
}
