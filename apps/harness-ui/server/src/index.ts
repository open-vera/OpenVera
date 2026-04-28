#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { handleRequest } from "./router.js";
import type { ServerContext } from "./types.js";

// ── CLI arg parsing ───────────────────────────────────────────────────────────

interface Args {
  port: number;
  flowDir: string;
  examplesDir?: string;
}

function parseArgs(argv: string[]): Args {
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
    }
  }
  return {
    port: flags.port ? Number(flags.port) : 7700,
    flowDir: resolve((flags["flow-dir"] as string | undefined) ?? "."),
    examplesDir: flags["examples-dir"]
      ? resolve(flags["examples-dir"] as string)
      : undefined,
  };
}

function printHelp() {
  console.log("Usage: vera-serve [options]");
  console.log("");
  console.log("Options:");
  console.log("  --port <n>            Port to listen on  (default: 7700)");
  console.log("  --flow-dir <path>     Project dir containing .flow/  (default: .)");
  console.log("  --examples-dir <path> Dir with flow template subdirs  (optional)");
  console.log("");
  console.log("Examples:");
  console.log("  vera-serve");
  console.log("  vera-serve --flow-dir ./my-project --port 7700");
  console.log(
    "  vera-serve --flow-dir . --examples-dir packages/harness/flow-examples"
  );
  console.log("");
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

const args = parseArgs(rawArgs);
const iterationsDir = join(args.flowDir, ".flow", "iterations");

if (!existsSync(args.flowDir)) {
  console.error(`Error: --flow-dir not found: ${args.flowDir}`);
  process.exit(1);
}

const ctx: ServerContext = {
  flowDir: args.flowDir,
  iterationsDir,
  examplesDir: args.examplesDir,
  port: args.port,
};

const server = createServer((req, res) => {
  void handleRequest(ctx, req, res);
});

server.listen(args.port, () => {
  console.log(`vera-serve  http://localhost:${args.port}`);
  console.log(`  flow-dir:     ${args.flowDir}`);
  console.log(`  iterations:   ${iterationsDir}`);
  if (args.examplesDir) {
    console.log(`  examples-dir: ${args.examplesDir}`);
  }
  console.log("");
  console.log("API:");
  console.log(`  GET  /api/runs`);
  console.log(`  GET  /api/runs/:runId`);
  console.log(`  GET  /api/runs/:runId/timeline`);
  console.log(`  GET  /api/runs/:runId/steps/:stepId`);
  console.log(`  GET  /api/runs/:runId/artifacts/:artifactId`);
  console.log(`  GET  /api/runs/:runId/stream  (SSE)`);
  console.log(`  GET  /api/flows`);
  console.log(`  POST /api/runs`);
  console.log("");
});
