import { runSuite } from "@vera/harness";
import { evaluate } from "@vera/harness";
import { loadConfig, AnthropicAdapter } from "@vera/core/adapters";
import type { TestCase, ReportEntry } from "@vera/harness";

// 示例 case 集（后续从文件加载）
const cases: TestCase[] = [
  {
    id: "l1_weather",
    input: "What's the weather in Paris?",
    expected_tools: ["get_weather"],
    eval: "tool_match",
  },
  {
    id: "l1_greeting",
    input: "Say hello in exactly one word.",
    eval: "contains",
    expected_output: "Hello",
  },
];

const config = loadConfig();
const pc = config.providers?.anthropic;
const adapter = new AnthropicAdapter(pc?.api_key, pc?.base_url);

const runs = await runSuite(cases, {
  adapter,
  model: config.default_model ?? "claude-opus-4-6",
});

const report: ReportEntry[] = await Promise.all(
  runs.map(async (run) => {
    const testCase = cases.find((c) => c.id === run.case_id)!;
    return { run, eval: await evaluate(testCase, run) };
  })
);

// 打印报告
const passed = report.filter((r) => r.eval.passed).length;
console.log(`\nResults: ${passed}/${report.length} passed\n`);
for (const entry of report) {
  const icon = entry.eval.passed ? "✓" : "✗";
  console.log(
    `${icon} ${entry.run.case_id} (${entry.run.duration_ms}ms, ${entry.run.turns} turns)`
  );
  if (!entry.eval.passed && entry.eval.reason) {
    console.log(`  reason: ${entry.eval.reason}`);
  }
}
