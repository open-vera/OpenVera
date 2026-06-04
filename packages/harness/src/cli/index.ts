#!/usr/bin/env node
// Ensure clean exit on Ctrl+C / SIGTERM — prevents pnpm from reporting exit code 143/130 as error
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

import { readFileSync } from "node:fs";
import { createLogger } from "@open-vera/logger";

const log = createLogger("cli");

// Crash prevention: log unhandled errors instead of crashing silently
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { error: err.message, stack: err.stack, name: err.name });
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { reason: String(reason) });
  process.stderr.write(`FATAL: Unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});

interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
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
  console.log("Usage: openvera|vera|ai <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  init                  Configure providers and models interactively");
  console.log("  sync                  Sync settings and resources from other agents");
  console.log("  repl                  Start REPL with full skill support");
  console.log("  run <flow>            Run .vera/flows/flow/<flow>/main.md");
  console.log("");
  console.log("Options (global):");
  console.log("  -v, --version           Show version number");
  console.log("  -h, --help              Show help");
  console.log("");
  console.log("Options (repl):");
  console.log("  --dir <path>            Working directory  (default: .)");
  console.log("  --model <id>            LLM model override");
  console.log("  --provider <name>       LLM provider override");
  console.log("  --api-key <key>         API key override");
  console.log("  --resume <sessionId>    Resume a previous session");
  console.log("");
  console.log("Options (init):");
  console.log("  --dir <path>            Project directory  (default: .)");
  console.log("  --force                 Run setup even when config already exists");
  console.log("");
  console.log("Options (sync):");
  console.log("  --force                 Replace conflicting symlinks");
  console.log("");
  console.log("Options (run):");
  console.log("  --dir <path>            Project directory with .vera/flows/  (default: .)");
  console.log("  --model <id>            LLM model override");
  console.log("  --provider <name>       LLM provider override");
  console.log("  --api-key <key>         API key override");
  console.log("  --artifacts-dir <path>  Artifact output directory");
  console.log("  --max-steps <n>         Iteration cap across all steps");
  console.log("  --skip-plan-critique    Skip plan-level critique");
  console.log("");
  console.log("Examples:");
  console.log("  openvera init");
  console.log("  vera sync");
  console.log("  vera");
  console.log("  ai repl");
  console.log("  openvera init --force");
  console.log("  openvera run auto-dev");
  console.log("  openvera run test --dir /path/to/project");
  console.log("");
}

const { command, flags } = parseArgs(process.argv.slice(2));

if (flags["version"] || flags["v"]) {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
  );
  console.log(pkg.version);
  process.exit(0);
}

if (flags["help"] || flags["h"]) {
  printHelp();
  process.exit(0);
}

try {
  if (command[0] === "init") {
    const { runInitCommand } = await import("./init-run.js");
    await runInitCommand({
      dir: flags["dir"] as string | undefined,
      force: Boolean(flags["force"]),
    });
  } else if (command[0] === "sync") {
    const { runSyncCommand } = await import("./sync-run.js");
    runSyncCommand({
      force: Boolean(flags["force"]),
    });
  } else if (command[0] === "run") {
    const { runFlowCommand } = await import("./flow-run.js");
    await runFlowCommand({
      dir: flags["dir"] as string | undefined,
      flow: command[1],
      model: flags["model"] as string | undefined,
      provider: flags["provider"] as string | undefined,
      apiKey: flags["api-key"] as string | undefined,
      artifactsDir: flags["artifacts-dir"] as string | undefined,
      maxSteps: flags["max-steps"] !== undefined ? Number(flags["max-steps"]) : undefined,
      skipPlanCritique: Boolean(flags["skip-plan-critique"]),
    });
  } else if (command[0] === undefined || command[0] === "repl") {
    const { runReplCommand } = await import("./repl-run.js");
    await runReplCommand({
      dir: flags["dir"] as string | undefined,
      model: flags["model"] as string | undefined,
      provider: flags["provider"] as string | undefined,
      apiKey: flags["api-key"] as string | undefined,
      resume: flags["resume"] as string | undefined,
    });
  } else {
    printHelp();
    process.exit(1);
  }
} catch (err) {
  log.error("cli command failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
