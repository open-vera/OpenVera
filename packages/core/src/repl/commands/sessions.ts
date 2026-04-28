// /sessions — 列出当前项目的历史 session

import { SessionStore } from "../../session/index.js";
import type { SessionSummary } from "../../session/index.js";
import type { ReplContext } from "../context.js";

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3))}...`;
}

function formatDetails(s: SessionSummary): string {
  const parts = [
    s.summary,
    s.gitBranch ? `branch:${s.gitBranch}` : undefined,
    s.tag ? `tag:${s.tag}` : undefined,
    s.pr ? `pr:${s.pr.number ?? s.pr.url}` : undefined,
    s.lastUserInput && s.lastUserInput !== s.summary ? `last: ${s.lastUserInput}` : undefined,
  ].filter(Boolean);
  return truncate(parts.join(" | "), 72);
}

export async function sessionsCommand(
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const all = args.includes("--all");
  const limit = parseNumberFlag(args, "--limit") ?? 30;
  const offset = parseNumberFlag(args, "--offset") ?? 0;
  const result = SessionStore.listSessionsPaged({
    cwd: ctx.cwd,
    all,
    limit,
    offset,
  });
  const sessions = result.sessions;

  if (sessions.length === 0) {
    console.log("No sessions found for this project.");
    console.log("Tip: use /sessions --all to search across all projects.");
    return;
  }

  const header = [
    padStart("#", 3),
    padEnd("SESSION ID", 12),
    padEnd("DATE", 12),
    padEnd("MODEL", 22),
    padStart("TURNS", 6),
    padStart("MSGS", 6),
    padStart("SIZE", 8),
    padStart("IN", 10),
    padStart("OUT", 10),
    padStart("CACHE W", 10),
    padStart("CACHE R", 10),
    padStart("COST", 10),
    padEnd("DETAILS", 72),
  ].join("  ");

  console.log(header);
  console.log("─".repeat(header.length));

  sessions.forEach((s, i) => {
    const row = [
      padStart(String(offset + i + 1), 3),
      padEnd(s.sessionId.slice(0, 8), 12),
      padEnd(formatDate(s.startedAt), 12),
      padEnd(s.model, 22),
      padStart(String(s.turnCount), 6),
      padStart(s.messageCount ? String(s.messageCount) : "-", 6),
      padStart(formatFileSize(s.fileSize), 8),
      padStart(formatTokens(s.totalUsage.input_tokens), 10),
      padStart(formatTokens(s.totalUsage.output_tokens), 10),
      padStart(formatTokens(s.totalUsage.cache_creation_input_tokens), 10),
      padStart(formatTokens(s.totalUsage.cache_read_input_tokens), 10),
      padStart(formatCost(s.totalCostUsd), 10),
      padEnd(formatDetails(s), 72),
    ].join("  ");
    console.log(row);
  });

  if (result.nextOffset !== undefined) {
    console.log(`\nNext page: /sessions${all ? " --all" : ""} --offset ${result.nextOffset} --limit ${limit}`);
  }
}

function parseNumberFlag(args: string[], flag: string): number | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
