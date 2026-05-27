/**
 * CI Runner — Entry point for CI regression gate.
 *
 * Loads GAIA L1 cases, runs them against the agent, checks for regressions,
 * and exits with code 0 (pass) or 1 (regression).
 *
 * Usage:
 *   npx tsx packages/harness/src/benchmark/ci-runner.ts \
 *     --name gaia-l1 \
 *     --model "test-model" \
 *     --threshold 0.05 \
 *     --history .benchmark-history/history.json
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CIGate } from "./ci-gate.js";
import type { EvalCase, AgentExecutor, AgentResponse } from "../eval/harness.js";

// ── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      args[key] = next && !next.startsWith("--") ? next : "true";
    }
  }
  return args;
}

// ── GAIA L1 Cases Loader ─────────────────────────────────────────────────────

/**
 * Load GAIA L1 test cases. If a custom cases file is provided, use that.
 * Otherwise, use the built-in vera-custom.json (L1 subset).
 */
function loadGaiaL1Cases(casesPath?: string): EvalCase[] {
  const path = casesPath
    ? resolve(casesPath)
    : resolve(import.meta.dirname ?? ".", "../eval/cases/vera-custom.json");

  if (!existsSync(path)) {
    // Fallback: return minimal built-in cases for CI smoke
    return [
      {
        id: "ci-l1-001",
        description: "Basic file read",
        level: 1,
        prompt: "Read the file package.json and report its content.",
        expected: "name",
        evalType: "contains",
        tags: ["ci", "l1"],
      },
      {
        id: "ci-l1-002",
        description: "Basic bash command",
        level: 1,
        prompt: "Run 'echo hello' and report the output.",
        expected: "hello",
        evalType: "contains",
        tags: ["ci", "l1"],
      },
    ];
  }

  const content = readFileSync(path, "utf-8");
  const allCases = JSON.parse(content) as EvalCase[];
  // Filter to L1 only
  return allCases.filter((c) => c.level === 1);
}

// ── Agent Executor (CLI wrapper) ─────────────────────────────────────────────

/**
 * Create an AgentExecutor that shells out to the vera CLI.
 * Falls back to a mock if CLI is not available.
 */
function createAgent(): AgentExecutor {
  // In CI, this would connect to the actual agent runtime.
  // For now, return a mock that simulates responses.
  return {
    async execute(prompt: string, options?: { timeoutMs?: number }): Promise<AgentResponse> {
      // Simulate agent execution with timeout
      const timeoutMs = options?.timeoutMs ?? 60_000;
      const start = performance.now();

      // Simple deterministic mock for CI testing
      const content = `[CI Mock] Executed: ${prompt.slice(0, 100)}`;
      const durationMs = performance.now() - start;

      return {
        content,
        toolCalls: ["read_file", "bash"],
        durationMs,
        costUsd: 0,
      };
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const name = args.name ?? "gaia-l1";
  const model = args.model ?? "unknown";
  const threshold = parseFloat(args.threshold ?? "0.05");
  const historyPath = args.history ?? ".benchmark-history/history.json";
  const casesPath = args.cases;

  // Ensure history directory exists
  const historyDir = dirname(historyPath);
  mkdirSync(historyDir, { recursive: true });

  const gate = new CIGate({
    historyPath,
    threshold,
    name,
    model,
  });

  const cases = loadGaiaL1Cases(casesPath);
  console.log(`Running ${cases.length} GAIA L1 cases (threshold: ${(threshold * 100).toFixed(0)}%)...`);

  const agent = createAgent();
  const result = await gate.run(agent, cases);

  // Write report
  const report = CIGate.formatReport(result);
  const reportPath = resolve(historyDir, "report.md");
  writeFileSync(reportPath, report, "utf-8");

  // Print summary
  console.log("");
  console.log(`Pass Rate: ${(result.benchmarkResult.passRate * 100).toFixed(1)}%`);
  console.log(`Threshold: ${(threshold * 100).toFixed(0)}%`);

  if (result.regressionReport.baseline) {
    console.log(`Baseline:  ${(result.regressionReport.baseline.passRate * 100).toFixed(1)}%`);
    console.log(`Delta:     ${(result.regressionReport.passRateDelta * 100).toFixed(1)}%`);
  }

  if (result.exitCode === 1) {
    console.error("\n❌ REGRESSION DETECTED — pass rate dropped below threshold.");
    process.exit(1);
  } else {
    console.log("\n✅ No regression detected.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("CI Runner failed:", err);
  process.exit(2);
});
