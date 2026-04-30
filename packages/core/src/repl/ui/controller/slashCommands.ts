import { loadavg } from "node:os";
import { getModelContextLimit } from "../../../context/index.js";
import type { AccumulatedCost } from "../../../session/index.js";
import type { RoutingInfo, TokenUsage } from "../types.js";
import { findCommandMeta } from "../../commands/metadata.js";

export interface ParsedSlashCommand {
  cmd: string;
  args: string[];
}

export function parseSlashCommand(line: string): ParsedSlashCommand | null {
  const firstToken = line.startsWith("/") ? (line.slice(1).split(/\s+/)[0] ?? "") : "";
  const isSlashCommand = firstToken.length > 0 && !firstToken.includes("/");
  if (!isSlashCommand) return null;
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  if (!cmd) return null;
  return { cmd, args };
}

export function isProcessCommand(cmd: string): boolean {
  return findCommandMeta(cmd)?.surface === "process";
}

export function isUiCommand(cmd: string, name?: string): boolean {
  const command = findCommandMeta(cmd);
  if (command?.surface !== "ui") return false;
  return name ? command.name === name : true;
}

export type QueueCommandResult =
  | { type: "message"; content: string }
  | { type: "clear"; content: string }
  | { type: "remove"; index: number; content: string }
  | { type: "update"; index: number; input: string; content: string };

export function handleQueueCommand(args: string[], items: string[]): QueueCommandResult {
  const [action = "list", indexArg, ...rest] = args;
  if (action === "list") {
    return { type: "message", content: formatQueue(items) };
  }

  if (action === "clear") {
    if (items.length === 0) return { type: "message", content: "Queue is empty." };
    return { type: "clear", content: `Cleared ${items.length} queued input${items.length === 1 ? "" : "s"}.` };
  }

  const index = Number(indexArg) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    return { type: "message", content: `Invalid queue index. ${formatQueue(items)}` };
  }

  if (action === "drop" || action === "remove") {
    return { type: "remove", index, content: `Removed queued input #${index + 1}.` };
  }

  if (action === "edit" || action === "set") {
    const input = rest.join(" ").trim();
    if (!input) return { type: "message", content: "Usage: /queue edit <n> <new input>" };
    return { type: "update", index, input, content: `Updated queued input #${index + 1}.` };
  }

  return {
    type: "message",
    content: [
      "Usage:",
      "  /queue",
      "  /queue drop <n>",
      "  /queue edit <n> <new input>",
      "  /queue clear",
    ].join("\n"),
  };
}

function formatQueue(items: string[]): string {
  if (items.length === 0) return "Queue is empty.";
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function formatStatusMessage(
  routing: RoutingInfo,
  usage: TokenUsage,
  contextUsedTokens: number,
  turnCount: number,
  cost: AccumulatedCost,
): string {
  const ctxMax = getModelContextLimit(routing.model);
  const ctxPct = ctxMax > 0 ? ((contextUsedTokens / ctxMax) * 100).toFixed(1) : "0.0";
  const ctxBar = contextUsedTokens > 0
    ? `${contextUsedTokens.toLocaleString()} / ${ctxMax.toLocaleString()} (${ctxPct}%)`
    : `unknown / ${ctxMax.toLocaleString()}`;
  const byModelLines = Object.entries(cost.byModel).map(([m, rec]) => {
    const cacheW = rec.usage.cache_creation_input_tokens;
    const cacheR = rec.usage.cache_read_input_tokens;
    const cachePart = (cacheW || cacheR) ? ` | cache w:${(cacheW ?? 0).toLocaleString()} r:${(cacheR ?? 0).toLocaleString()}` : "";
    return `  ${m}: in ${rec.usage.input_tokens.toLocaleString()} / out ${rec.usage.output_tokens.toLocaleString()}${cachePart} = $${rec.costUsd.toFixed(4)}`;
  });
  const mem = process.memoryUsage();
  const load = loadavg();
  const parts = [
    `Provider: ${routing.provider}`,
    `Model:    ${routing.model}`,
    `Turns:    ${turnCount}`,
    `Context:  ${ctxBar}`,
    `Tokens:   in ${usage.inputTotal.toLocaleString()} / out ${usage.outputTotal.toLocaleString()}`,
    ...(usage.cacheWriteTotal || usage.cacheReadTotal ? [`Cache:    write ${usage.cacheWriteTotal.toLocaleString()} / read ${usage.cacheReadTotal.toLocaleString()}`] : []),
    `Cost:     $${usage.costUsd.toFixed(4)}`,
    ...(byModelLines.length ? ["\nBy model:", ...byModelLines] : []),
    `\nMemory:   RSS ${(mem.rss / 1024 / 1024).toFixed(0)} MB / heap ${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)} MB`,
    `CPU load: ${load.map((l) => l.toFixed(2)).join(" / ")} (1m/5m/15m)`,
  ];
  if (routing.intent) parts.push(`\nIntent:   L${routing.intent.level} · ${routing.intent.domain} → ${routing.provider}`);
  return parts.join("\n");
}
