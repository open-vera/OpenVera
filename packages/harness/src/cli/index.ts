#!/usr/bin/env node
// Ensure clean exit on Ctrl+C / SIGTERM — prevents pnpm from reporting exit code 143/130 as error
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

import { runFlowCommand } from "./flow-run.js";
import { runReplCommand } from "./repl-run.js";

interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      command.push(arg);
    }
  }

  return { command, flags };
}

function printHelp() {
  console.log("Usage: vera-harness <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  repl                  Start REPL with full skill support");
  console.log("  flow run              Run the flow defined in .flow/");
  console.log("");
  console.log("Options (repl):");
  console.log("  --dir <path>            Working directory  (default: .)");
  console.log("  --model <id>            LLM model override");
  console.log("  --provider <name>       LLM provider override");
  console.log("  --api-key <key>         API key override");
  console.log("  --resume <sessionId>    Resume a previous session");
  console.log("");
  console.log("Options (flow run):");
  console.log("  --dir <path>            Project directory with .flow/  (default: .)");
  console.log("  --model <id>            LLM model override");
  console.log("  --provider <name>       LLM provider override");
  console.log("  --api-key <key>         API key override");
  console.log("  --artifacts-dir <path>  Artifact output directory");
  console.log("  --max-steps <n>         Iteration cap across all steps");
  console.log("  --skip-plan-critique    Skip plan-level critique");
  console.log("");
  console.log("Examples:");
  console.log("  vera-harness flow run");
  console.log("  vera-harness flow run --dir flow-examples/software-dev");
  console.log("  vera-harness flow run --dir flow-examples/travel-planning");
  console.log("  vera-harness flow run --dir flow-examples/financial-research");
  console.log("  vera-harness flow run --dir flow-examples/annotation-qa");
  console.log("");
}

const { command, flags } = parseArgs(process.argv.slice(2));

if (command[0] === "repl") {
  await runReplCommand({
    dir: flags["dir"] as string | undefined,
    model: flags["model"] as string | undefined,
    provider: flags["provider"] as string | undefined,
    apiKey: flags["api-key"] as string | undefined,
    resume: flags["resume"] as string | undefined,
  });
} else if (command[0] === "flow" && command[1] === "run") {
  await runFlowCommand({
    dir: flags["dir"] as string | undefined,
    model: flags["model"] as string | undefined,
    provider: flags["provider"] as string | undefined,
    apiKey: flags["api-key"] as string | undefined,
    artifactsDir: flags["artifacts-dir"] as string | undefined,
    maxSteps: flags["max-steps"] !== undefined ? Number(flags["max-steps"]) : undefined,
    skipPlanCritique: Boolean(flags["skip-plan-critique"]),
  });
} else {
  printHelp();
  process.exit(command.length > 0 ? 1 : 0);
}
